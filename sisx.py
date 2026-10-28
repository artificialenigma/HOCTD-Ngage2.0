#!/usr/bin/env python3
"""SIS v9.x (SISX) extractor for N-Gage 2.0 packages.

Layout (binarybacktrace.com N-Gage/SISX spec, empirically confirmed):
  SISHeader(16B, uid1=0x10201A7A) -> SISContents(12) -> [CRC34, CRC35]
  SISCompressed(3) controller (raw text sections) + SISData(30)
  SISController(13) -> SISInfo(14: uid, vendor, names, version)
                     -> SISInstallBlock(28) -> array(24) file descriptions
  SISData(30) -> array(31 DataUnits, possibly N-Gage nested arrays)
              -> array(32 FileData) -> SISCompressed per file (deflate)
FileDescription: TLVs (target, mime?, hash?, caps?) then RAW
u32 op, u32 opopts, u64 lens, u64 lunc, u32 file_index.
Strings UTF-16LE; ints LE; TLV length excludes 4-byte padding;
array elements carry length+data only (their body is itself a TLV).
"""
import json, os, struct, sys, zlib

TYPE_NAMES = {
    1: "SISString", 2: "SISArray", 3: "SISCompressed", 4: "SISVersion", 6: "SISDate",
    7: "SISTime", 8: "SISDateTime", 9: "SISUid", 12: "SISContents", 13: "SISController",
    14: "SISInfo", 15: "SISSupportedLanguages", 16: "SISSupportedOptions",
    17: "SISPrerequisites", 18: "SISDependency", 19: "SISProperties", 20: "SISProperty",
    21: "SISSignatures", 22: "SISCertificateChain", 23: "SISLogo", 24: "SISFileDescription",
    25: "SISHash", 26: "SISIf", 28: "SISInstallBlock", 29: "SISExpression", 30: "SISData",
    31: "SISDataUnit", 32: "SISFileData", 34: "SISControllerChecksum", 35: "SISDataChecksum",
    36: "SISSignature", 37: "SISBlob", 39: "SISSignatureCertificateChain", 40: "SISDataIndex",
    41: "SISCapabilities",
}
CONTAINERS = {8, 12, 13, 14, 17, 19, 21, 22, 26, 27, 28, 30, 31, 32, 39}


def pad(n):
    return (-(n)) % 4


class Field:
    def __init__(self, ftype, off, body_off, body_len, blob):
        self.type = ftype
        self.name = TYPE_NAMES.get(ftype, f"f{ftype}")
        self.off, self.body_off, self.body_len, self.blob = off, body_off, body_len, blob
        self.children, self.elements = [], []
        self.next_off = self.body_off + self.body_len + pad(self.body_len)
        if self.body_len == 0:
            self.next_off = self.body_off + pad(4)  # keep progress on empty bodies

    def ints(self, fmt="<I"):
        return struct.unpack_from(fmt, self.blob, self.body_off)

    @property
    def body(self):
        return self.blob[self.body_off:self.body_off + self.body_len]


def u32(blob, p):
    return struct.unpack_from("<I", blob, p)[0]


def parse_tlv(blob, pos):
    t, ln = struct.unpack_from("<II", blob, pos)
    f = Field(t, pos, pos + 8, ln, blob)
    if f.type == 1:
        f.text = f.body.decode("utf-16-le", errors="replace").rstrip("\x00")
        return f
    if f.type == 2:
        f.element_type = u32(blob, f.body_off)
        p = f.body_off + 4
        end = f.body_off + f.body_len
        while p < end:
            elen = u32(blob, p)
            f.elements.append((elen, p + 4))
            p += 4 + elen + pad(elen)
        return f
    if f.type not in CONTAINERS or f.body_len == 0:
        return f
    p = f.body_off
    end = f.body_off + f.body_len
    while p < end:
        ch = parse_tlv(blob, p)
        f.children.append(ch)
        if ch.next_off <= p:
            break
        p = ch.next_off
    return f


def resolve_element(blob, body_off):
    """An array element's body usually starts with a type word (it's a TLV).
    Returns the parsed TLV (or the raw-body Field if not a type word)."""
    t = u32(blob, body_off)
    f = parse_tlv(blob, body_off)
    return f


def units_of(data_field):
    """Yield every SISCompressed Field under a SISData TLV.

    Observed N-Gage layout: SISData(30) -> array(2, et=31) -> element body
    = TLV type-2 array (et=32) -> element body = SISCompressed(3) TLV.
    Falls back to the standard variant (unit TLV 31 containing array et=32).
    """
    out = []
    for ch in data_field.children:
        if ch.type != 2:
            continue
        for elen, boff in ch.elements:
            fe = parse_tlv(ch.blob, boff)  # unit element body is itself a TLV
            if fe.type == 2 and getattr(fe, "element_type", None) == 32:
                units = [(elen, boff) for elen, boff in fe.elements]
            elif fe.type == 31:
                units = [bo for c in fe.children if c.type == 2 for bo in c.elements]
            elif fe.type == 3:  # degenerate: unit body is one compressed file
                out.append(fe)
                continue
            else:
                continue
            for flen, foff in units:
                fd = parse_tlv(fe.blob, foff)
                if fd.type == 32:  # FileData TLV: child[0] should be compressed
                    comp = next((c for c in fd.children if c.type == 3), None)
                elif fd.type == 3:
                    comp = fd
                else:
                    comp = None
                if comp is not None:
                    out.append(comp)
    return out


def inflate_comp(f):
    algo = f.ints("<I")[0]
    usize = struct.unpack_from("<Q", f.blob, f.body_off + 4)[0]
    stream = f.blob[f.body_off + 12: f.body_off + f.body_len]
    if algo == 0:
        return algo, stream
    try:
        out = zlib.decompress(stream)
    except zlib.error:
        out = zlib.decompress(stream, -15)
    assert len(out) == usize, (len(out), usize)
    return algo, out


def parse_file_desc(blob, off, elen):
    end = off + elen
    fd = {"target": None, "mime": None}
    strings = 0
    p = off
    while p < end:
        t, ln = struct.unpack_from("<II", blob, p)
        if t == 1:
            s = blob[p + 8:p + 8 + ln].decode("utf-16-le", errors="replace")
            if strings == 0: fd["target"] = s.rstrip("\x00")
            elif strings == 1: fd["mime"] = s.rstrip("\x00")
            else: fd.setdefault("extra", []).append(s.rstrip("\x00"))
            strings += 1
            p = p + 8 + ln + pad(ln)
            continue
        if t == 25:  # SISHash{algo u32, SISBlob{u32 len, data}}
            algo = u32(blob, p + 8)
            blen = u32(blob, p + 16)
            fd["sha1"] = blob[p + 24:p + 24 + 20].hex() if algo == 1 else f"algo{algo}"
            p = p + 8 + ln + pad(ln)
            continue
        break  # non-TLV region (raw ints) reached
    # raw section: op(4) opopts(4) lcomp(8) lunc(8) file_index(4)
    rem = end - p
    if rem >= 28:
        op, opopt = struct.unpack_from("<II", blob, p)
        lcomp, lunc = struct.unpack_from("<QQ", blob, p + 8)
        fidx = u32(blob, p + 24)
        fd.update(operation=op, op_options=opopt, compressed_len=lcomp,
                  uncompressed_len=lunc, file_index=fidx)
    elif rem:
        fd["raw_tail_hex"] = blob[p:end].hex()
    return fd


def parse_info(info_field, blob, out):
    for c in info_field.children:
        if c.type == 9:
            out["uid"] = f"{c.ints('<I')[0]:#010x}"
        elif c.type == 1 and "vendor" not in out:
            out["vendor"] = c.text
        elif c.type == 2 and c.element_type == 1:
            texts = []
            for elen, boff in c.elements:
                texts.append(blob[boff:boff + elen].decode("utf-16-le", errors="replace").rstrip("\x00"))
            out["names"] = texts
        elif c.type == 4:
            out["version"] = ".".join(map(str, c.ints("<III")))
        elif c.type == 6 and isinstance(c, Field) and False:
            pass


def walk_controller(node, out, depth=0):
    if depth > 12:
        return
    for ch in node.children:
        if ch.type == 14:
            parse_info(ch, ch.blob, out)
        elif ch.type == 2 and ch.element_type == 24:
            for elen, boff in ch.elements:
                out["files"].append(parse_file_desc(ch.blob, boff, elen))
        elif ch.type in (13, 28):
            walk_controller(ch, out, depth + 1)
        elif ch.type == 40:
            out["data_index"] = ch.ints("<I")[0]


def ext_from_magic_value(payload):
    u1 = struct.unpack_from("<I", payload, 0)[0] if len(payload) >= 4 else 0
    if u1 == 0x1000007A: return ".exe"
    if u1 == 0x10000079: return ".dll"
    if u1 == 0x10003A3F: return ".app"
    if payload.startswith(b"\x89PNG"): return ".png"
    if payload.startswith(b"\xff\xd8\xff"): return ".jpg"
    if payload.startswith(b"RIFF"): return ".wav"
    if payload.startswith(b"MTMc"): return "."
    if payload.startswith(b"<?xml") or payload[:4] == b"<\x00?\x00": return ".xml"
    if payload[:4] == b"XE3U": return ".s3e"
    if payload[:1] == b"]" and len(payload) > 8: return ".lzma"
    return ".bin"


def safe_rel(target, fallback):
    rel = (target or fallback).replace("\\", "/").replace(":", "")
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    return "/".join(parts) if parts else fallback


def parse_sisx(path, outdir):
    d = open(path, "rb").read()
    name = os.path.splitext(os.path.basename(path))[0]
    uid1, uid2, uid3, uidc = struct.unpack_from("<IIII", d, 0)
    assert uid1 == 0x10201A7A, f"{path}: bad uid1 {uid1:#010x}"
    contents = parse_tlv(d, 16)
    assert contents.type == 12, f"root type {contents.type}"

    controller_c = next(f for f in contents.children if f.type == 3)
    data_f = next((f for f in contents.children if f.type == 30), None)

    algo, ctrl_blob = inflate_comp(controller_c)
    ctrl = parse_tlv(ctrl_blob, 0)
    assert ctrl.type == 13, f"controller type {ctrl.type}"
    info = {"files": [], "data_index": 0}
    walk_controller(ctrl, info)

    payload = []
    if data_f:
        for comp in units_of(data_f):
            algo, out = inflate_comp(comp)
            payload.append((algo, out))

    print(json.dumps({
        "sis": os.path.basename(path),
        "package_uid": info.get("uid"), "name": info.get("names"),
        "vendor": info.get("vendor"), "version": info.get("version"),
        "data_index": info["data_index"],
        "file_descriptions": len(info["files"]), "data_units": len(payload),
    }, indent=1))

    os.makedirs(outdir, exist_ok=True)
    manifest = []
    for i, fd in enumerate(info["files"]):
        idx = fd.get("file_index", i)
        if idx >= len(payload):
            manifest.append({"i": i, "target": fd["target"], "error": f"missing data idx {idx}"})
            continue
        algo, blob = payload[idx]
        tgt = fd["target"] or f"file_{i}"
        dst = os.path.join(outdir, name, safe_rel(tgt, f"file_{i}.bin"))
        if os.path.splitext(dst)[1] == "":
            dst += ext_from_magic_value(blob)
        elif os.path.splitext(dst)[1].lower() == ".bin" and ext_from_magic_value(blob) != ".bin":
            dst = dst[:-4] + ext_from_magic_value(blob)
        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        open(dst, "wb").write(blob)
        manifest.append({"i": i, "file_index": idx, "target": tgt, "mime": fd.get("mime"),
                         "algo": algo, "size": len(blob), "written": os.path.relpath(dst, outdir)})
    for i, fd in enumerate(info["files"], len(manifest)):
        pass
    json.dump({"sis": os.path.basename(path), "package_uid": info.get("uid"),
               "files": manifest}, open(os.path.join(outdir, f"{name}_manifest.json"), "w"), indent=1)
    print(f"  extracted {sum(1 for m in manifest if 'size' in m)} files -> {outdir}/{name}/")


if __name__ == "__main__":
    args = sys.argv[1:]
    outdir = "unpacked"
    if args and args[0] == "-o":
        outdir = args[1]; args = args[2:]
    paths = [p for p in args if os.path.isfile(p)]
    for p in paths:
        parse_sisx(p, outdir)
    if not paths:
        print("usage: sisx.py [-o outdir] <sis files...>")
