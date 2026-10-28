#!/usr/bin/env python3
"""Harvest all SISCompressed payloads from an SISX, regardless of file-description quality.

Usage: python3 sis_harvest.py <sisx> <outdir>
Writes <outdir>/NNN_size.bin files; prints magic summary.
"""
import sys, os, struct, zlib, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sisx import parse_tlv, units_of, inflate_comp


def harvest_blob(blob):
    """Walk top-level TLV chain from offset 16; harvest every SISData unit (recursive)."""
    payloads = []
    seen = set()

    def walk_field(f, depth=0):
        if depth > 8 or id(f) in seen:
            return
        seen.add(id(f))
        if f.type == 30:
            try:
                for c in units_of(f):
                    payloads.append(c)
            except Exception:
                pass
        for ch in getattr(f, 'children', []):
            walk_field(ch, depth + 1)

    pos = 16
    while pos + 8 <= len(blob):
        try:
            f = parse_tlv(blob, pos)
        except Exception:
            pos += 4
            continue
        walk_field(f)
        nxt = f.next_off
        if nxt <= pos:
            break
        pos = nxt
    return payloads


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    blob = open(path, 'rb').read()
    payloads = harvest_blob(blob)
    os.makedirs(outdir, exist_ok=True)
    base = os.path.basename(path).rsplit('.', 1)[0].replace(' ', '_')
    magics = collections.Counter()
    n_ok = 0
    for i, f in enumerate(payloads):
        try:
            algo, data = inflate_comp(f)
        except Exception:
            continue
        m = data[:4].hex()
        magics[m] += 1
        open(os.path.join(outdir, f"{base}_{i:03d}_{len(data)}.bin"), 'wb').write(data)
        n_ok += 1
    print(f"{path}: {len(payloads)} payloads, {n_ok} inflated -> {outdir}")
    print("magic census:", collections.Counter()) if False else None
    for m, n in magics.most_common(15):
        v = struct.unpack('<I', bytes.fromhex(m))[0]
        print(f"  {m}: {n}")


if __name__ == '__main__':
    main()
