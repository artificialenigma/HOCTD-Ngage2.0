# Hooked On: Creatures of the Deep — Reverse Engineering & three.js Port Project

Complete reverse-engineering of the N-Gage game **"Hooked On: Creatures of the Deep"** (uid3 `0x2000AFBC`, authored by Infinite Dreams, published by Nokia) with the goal of porting it to a modern **three.js web game** (static, Node-free).

Everything in `pak_out/` (~57 MB, 5,688 blobs) was recovered with **zero failures**, every decompressed byte size-verified against the container's own index — using the game's *own* decompressor code, emulated faithfully on the host CPU.

---

## 1. Contents of this directory

```
Hooked On_Creatures of the Deep/
├── hookedoncr_ud49zkwq.sis        ← original N-Gage SIS installer (input artifact)
├── Hooked.On.Creatures.of.the.Deep.n-gage   ← original N-Gage title file
├── extracted/                     ← first-stage SIS extraction (active payload dir)
├── extracted_full/                ← full extraction tree
│   └── Game/!/private/2000AFBC/
│       ├── data0000.pak           ← the game's 26,372,484-byte data pack (input artifact)
│       └── ...                    ← other runtime files
├── game_payloads/                 ← raw chunks carved from the SIS payload
│   ├── 0000_51670.bin … 0063_1230672.bin
│   └── 0063_1230672.bin           ← THE GAME EXECUTABLE (plain E32 image, all loader/codec code)
├── sis_harvest.py                 ← SIS payload carver (multi-record SIS parser)
├── sisx.py                        ← SISX/SIS archive tooling
├── e32dec.py                      ← Symbian E32 image reader (deflate + Nokia bytepair decompression)
├── symflate.py                    ← Symbian "flate" (pre-deflate) decompressor
├── reloc.py                       ← E32 relocation-section builder (EKA2L1 semantics, in progress)
├── pak_unpack.py                  ← ★ Unicorn-based pak blob decoder (emulates the real ARM codec)
├── pak_hash.py                    ← ★ recovered engine name-hash function (see §6)
├── pak_out/                       ← ★ decoded output (see §3)
├── assets/                        ← typed copy of all classified blobs (see §4)
├── PAK_FORMAT_NOTES.md            ← concise living format documentation
├── unpacked/                      ← intermediate E32 unpack artifacts
├── launcher/, othergames/         ← side material (unrelated lead archived under othergames/)
└── __pycache__/
```

## 2. The journey, step by step

### Phase 1 — SIS harvesting
- `hookedoncr_ud49zkwq.sis` is a Symbian SIS (multi-record) installer. `sis_harvest.py` walks the SIS record chain and carves every payload chunk (`game_payloads/0000_…bin` … `0063_…bin`).
- Chunk `0063_1230672.bin` turned out to be the **game executable** — a *plain* (uncompressed) E32 image, `uid3 = 0x2000AFBC`.

### Phase 2 — E32 image parsing
- `e32dec.py` parses the E32 header of the game exe:
  - `code_base=0x8000`, `data_base=0x400000`, `code_off=0x9c`
  - `code_size=0x1256ac`, `data_size=0xd90`
  - `creloc=0x127038`, `dreloc=0x12c728`, `import_off=0x1264d8`
  - vaddr↔file mapping used everywhere: **`file_off = vaddr - 0x8000 + 0x9c`**
- It also handles compressed E32 images generally (deflate + Symbian bytepair), used for older attempts on other chunks.

### Phase 3 — the data pack
- `extracted_full/Game/!/private/2000AFBC/data0000.pak` (26,372,484 B) is the game's asset store.
- Total byte-level XOR of the file with **`0xAA`** de-obfuscates it (found at `CFileSystem::Read`, vaddr `0x12ddc`).
- Container layout (all multi-byte fields stored `^0xAAAAAAAA`):
  - `@16` count = plain u32 (5,680 entries)
  - `@24` index = 5,680 × 16-byte entries `[+0 offset][+4 uncomprSize][+8 comprSize&0xFFFFFF | f2<<24][+12 hash32]`
  - `f2` = 0 → blob stored *raw*, `f2` = 2 → blob stored *compressed*
  - per-blob frame: `[u32 uncompressedSize][payload][padding]`

### Phase 4 — identifying the mystery codec (the hard part)
Naive attempts all **failed**: deflate/zlib, Symbian flate, bytepair, LZSS, gzip — none matched. A look at `CFileSystem::LoadEntry` (vaddr `0x12788`) showed the decoder lives in the exe, so:

- Disassembled the whole decode path in `game_payloads/0063_1230672.bin` (capstone):
  - entry **`Decode(state, compSrc, dst)` @ vaddr `0x13a94`** — returns uncompressed size in `r0` (or `dst|size`, mask `0x22000000`),
  - init `0x135b8` (distance model, 4096-entry table at `[state+0x58]`),
  - `getbit` `0x13538`–`0x13574`, canonical cumulative-frequency binary search `0x13578`,
  - region init `0x13850`, wrapper chain `0x12788/0x12998/0x129e8`,
  - progress-loop callbacks `bl 0x8394` at `0x13ca0`/`0x13eb8` must be NOPped in emulation.
- **Verdict: a bespoke NE3D-engine codec — a 17-bit adaptive range coder over cumulative-frequency tables with move-to-front and renewal at count 0x7fff.** Not any published algorithm.

### Phase 5 — faithful decoding via emulation
- Rather than hand-translating this intricate coder (high error risk), `pak_unpack.py`
  **Unicorn-emulates the real ARM code**: loads the exe segment, patches the import thunks
  (`ldr pc,[pc,#-4]` stubs with ordinal words; nominals map to `__aeabi_uidiv/udivmod`) to stub
  handlers, NOPs the two progress calls, and drives `Decode` in a fresh subprocess per blob.
- Result: **all 3,187 compressed blobs decoded, 0 failures, every output size exactly the index-claimed
  `unc` value.** Raw blobs (1,698) copied verbatim.
- Consolidated per-blob manifest: `pak_out/manifest.json` (k / off / comp / unc / f2 / hash).

### Phase 6 — classification & typed export
- `assets_manifest.json` + `types.json` classify every blob by content signature; the whole set is
  exported to `assets/<type>/<k>.<ext>`:
  | count | type | what |
  |---|---|---|
  | 474  | jpeg  | photos, postcards, backgrounds |
  | 413  | ntex  | `NE3DNTEX` engine-native textures |
  | 398  | nscene| `NE3DXSCN` scene graphs (fish/perch/rod anchors, refs `*.mesh`) |
  | 589  | png   | (288 compressed + 301 raw) UI panels, icons, maps |
  | 75   | wav   | RIFF PCM sounds |
  | 118  | script| `skrypt\0<GUID-hex>\0` + `SQSC` bytecode (game logic / UI) |
  | 121  | keyframes | animation key tracks |
  | ~163 | record| small `[ff ff ff ff][u16][cdcd][GUID16]` resource records |
  | rest | other | misc structures / dialog chunks / menu headers |
  Plus 1,698 raw blobs under `assets/raw/`.

### Phase 7 — resource-name tables
- Nine name-table blobs parse cleanly as **12-byte header + N×48-byte records
  `[GUID16][31-char name][\0]+cd-pad`, sorted ascending by the first u32 of the GUID**
  (verified: `file_size == 12 + N*48` exactly for every table).
- All tables recovered to `pak_out/name_tables.json`:

  | blob | count | family |
  |---|---|---|
  | 5130 | 493 | pictures (`panel\gps.png`, `rods\rod2_hand_sunset.png`, …) |
  | 5282 | 76 | sounds (`rod_caststart_1.wav`, `diary_newspaper.wav`, …) |
  | 2314 | 414 | textures `*.ntex` |
  | 1486 | 381 | scenes `*.nscene` |
  | 3394 | 749 | texts / quests / tournaments (`02 - quest10`, `sailfish`, …) |
  | 2644 | 294 | dialogs (`skrypt`, `04 guest 3`, …) |
  | 5370 | 62 | events |
  | 5547 | 76 | animations `*.flc` |
  | 5307 | 19 | misc |

### Phase 8 — the name-hash (see §6) & linkage investigations
- The GUID network continues to be mapped: table-record GUID16 values appear **inside
  "other"-family scene chunk blobs at offset 84** (190+ blobs confirmed), proving chunks reference
  assets via GUID and that name/GUID pairing can be content-verified externally.
- `.ldat` "locked-resource" filenames embedded in `ReadFile` checks (vaddr 0x129f8 area):
  `2cfc395e9d614ffab74562469f77de36.ldat`, `4a0b431dc77e4f3fb1ba68bc5c65ba4b.ldat`,
  `727f47ff92cf39952500144f.ldat`, `5343b7e40c924f649939bc57d7d9860f.ldat`, `license.ldat`,
  and a `.ngdat` suffix-append path.

## 3. `pak_out/` artifacts

- `manifest.json` — per-k meta from the index: `{k, off, comp, unc, f2, h}` (off/comp/unc/hash decoded).
- `index.json`     — same as list, used by all tools.
- `types.json`     — content signature classification.
- `assets_manifest.json` — `{k: {type, sub, size, f2}}`.
- `name_tables.json` — all nine name tables (hash / guid / name per record).
- `names_textures.json` — first extracted texture names (historical).
- `comp/`, `raw/` — decoded blob binaries, `<k>.bin`.
- `sample_*.png` — early verified sample decodes.

## 4. Tools

| tool | purpose | status |
|---|---|---|
| `sis_harvest.py` | carve SIS payload records into `game_payloads/` | ✓ |
| `e32dec.py` | E32 image header parse + deflate/bytepair unpack | ✓ |
| `symflate.py` | Symbian flate (legacy) decoder | ✓ (ruled out for this pak) |
| `pak_unpack.py` | **emulate the game's own ARM decompressor with Unicorn** and decode every compressed blob | ✓ 3,187/3,187 |
| `pak_hash.py` | implement the recovered engine name-hash `H()` | ✓ |
| `reloc.py` | build a relocated image to annotate code vs. data pointer words | WIP |
| `extracted/`, `extracted_full/`, `game_payloads/` | source artifacts carved from `.sis`/E32 | ✓ |

## 5. The compression codec (detailed)

Custom **17-bit adaptive range coder with cumulative-frequency model** (unique to the NE3D engine):

- State block: value `[state+0x80]`, low `[+0x7c]`, hi `[+0x84]`, model cumfreq `[+0x50..0x58]`,
  MTF swap cells `[+0x60]/[+0x5c]`, 0x1000-entry cumfreq table `[+0x58]`,
  distance model init at `0x135b8`.
- renewal rule: when the total count hits `0x7fff`, the model is re-equilibrated.
- canonical (canon) table resolved via binary search `0x13578`; bit reader `0x13538`.
- loop progress callbacks `bl 0x8394` at `0x13ca0` and `0x13eb8` (blocked during emulation).
- enters through `CFileSystem::LoadEntry` `0x12788`; whole-file read via `CFileSystem::ReadFile`
  `0x129e8`; the decoder called with `(r0=state, r1=compSrc, r2=dst)`.
- Import thunks `ldr pc,[pc,#-4]` (0xe51ff004) with an ordinal word at +4; used ordinals {0x24,0x15C,
  0x15E, 0x160, 0x161, 0x087, 0x092, 0x09B …} = udiv / udivmod / string-ctor style libc, all stubbed.

## 6. The recovered name-hash

From `LookupIndexByName` **@ vaddr `0x126dc`** (an inlined twin exists at `0x126a0` with an extra
`'A'`-terminator branch); seed **`0x12345678`** from the literal pool at `0x12b30`:

```
h = 0x12345678; i = 1
for each ASCII byte c until \0 (or 'A' in the twin):
    h += (i * c) << ((i & 3) * 8)      # lane rotation: (h<<30)>>27 == (i&3)*8
    i += 1
```

- Python implementation: `pak_hash.py` (`H()`), verified three ways:
  1. manual bit-level decode of each instruction,
  2. Unicorn run with code-hook tracing (`r3` progression matched the formula byte-for-byte),
  3. disassembly cross-checked for MUL/LML lane encodings (`e00c0c91`, `e083341c`).
- Callers of `0x126dc`: `0x12764`, `0x12ad0` (ReadFile fallback), `0x12c0c`, `0x12c78`, `0x12cc4`.

**What is still open:** `H(name)` matches **no** hash32 field of the 5,680 index entries for any of
the recovered table names (10 encodings × salts, 0 hits), nor the table record keys (duplicate names
with different keys prove the keys aren't a pure function of the visible 31-char name). Working
hypothesis: table labels are truncations of longer loader names, and/or index keys are
GUID-tagged `.ldat` file paths. Salt brute-force (all 25,887 printable 2–20-char strings in the
exe, prefix/suffix) also found nothing. This linkage is not needed for rendering: scenes reference
textures **by GUID**, and GUI scripts reference names/pairs that can be matched conservatively.

## 7. Key facts / gotchas for future work

- vaddr→file for the game exe: `file = vaddr - 0x8000 + 0x9c`; data segment at file 0x125748.
- Data segment (0xd90) contains GUID-like hex strings and identity float matrices (`0x3f800000`).
- The pak index `hash32` matches *nothing* tried: not content crc32/adler32 (raw, de-XORed, `payload[4:]`,
  decoded blob), not md5/sha1 truncates, not any common name hash — see `name-hash` section above.
- Name-table GUID structure matches UUIDv4 layout: byte7 ∈ `0x40..0x4F`, byte8 ∈ `0x80..0xBF`.
- Names longer than 31 chars are truncated in-table — the same visible name can consequently appear
  with different keys, e.g. `land_seagulls_1.wav` twice in table 5282.
- Emulation details that matter when redoing this:
  - imports are `ldr pc,[pc,#-4]` thunks (`0xe51ff004`) with the ordinal right behind (`+4`).
  - emulate ARM mode; `emu_start(0x13a94, RET_A)`; reset `r0/r1/r2` per decode call.
  - the decode return path can carry `dst|size` — mask `rn - dst`.
  - NOP `bl 0x8394` at `0x13ca0` and `0x13eb8`.
- `reloc.py` semantics (from EKA2L1 sources):
  blocks = `[u32 base][u32 size][u16 deltas…]`, delta = `(type<<12)|offset12`,
  types `0`=inferred / `1`=data / `2`=text (inferred picks text if the word lands in
  `[code_base, code_base+code_size)` else data), delta `0` = skip sentinel.
  At load-base == file base the relocation is a no-op — its main future use is to statically
  distinguish code from data-pointer words for literal-pool xref scans.

## 8. The web port (`web/`)

`web/` is the working three.js port. Serve statically and open — no build step, no Node:

```
cd "Hooked On_Creatures of the Deep/web"
python3 -m http.server 8000
# → http://localhost:8000
```

- `index.html` — loading screen, HUD (state banner / charge bar / score), importmap pinning `three@0.160.0` (unpkg CDN)
- `style.css` — HUD/loading styling
- `js/main.js` — `Assets` loader (asset registry + WAV pool), `World` (sky dome shader, animated water ShaderMaterial using three real caustic JPEG tiles from the pak, boat+rod, bobber, splash decal, fish leap sprite), `Game` — full cast-loop state machine:
  **IDLE → hold CHARGE → release CAST (ballistic arc + line) → FLOAT (random bite) → STRIKE (timed window) → CATCH / miss → reset**
- `assets/index.json` — generated registry: 1,466 images (288 pak PNGs + 301 raw PNGs + 474 JPEGs + 403 NE3DNTEX→PNG) and 75 WAVs, keyed by pak blob id
- `assets/img/…`, `assets/sfx/…` — the converted/copied files

Smoke-tested with headless Chromium (playwright): boot → load screen → start → charge → cast → strike → CATCH is verified green; screenshots in `pak_out/webshot_*.png`.

**Known approximations (documented, on purpose):**
- SFX selection is duration-heuristic (see `SFX_KEYS`): the recovered sound name table (`pak_out/name_tables.json`, 76 names like `rod_caststart_1.wav`, `menu_select.wav`) can't yet be linked to blob ids — name-hash linkage is an open item.
- Sky/boat/fish are procedural stand-ins; the caustic water, terrain strips and splash decal are genuine game art.
- The fullscreen NE3DXSCN scene graph is not used yet — that's the next depth phase.

## 9. NE3DNTEX texture format (cracked)

Recovered from the blob set + verified visually on 403/413 files:

```
header (32 bytes):
  +0  magic "NE3DNTEX"
  +8  version u32 (3)
  +12 width u16, +14 height u16
  +16 0x840 / 0x801
  +20 2
  +24 0x30
  +28 palette byte-size u32  (0x200 = 512 → 256 RGB565 entries; some use 0x100 → 128)
payload:
  palette: palbytes of RGB565 u16 LE
  pixels:  w*h bytes, each an index into the palette
  tail:    8 extra bytes
```

Converted with the loop in this README's history / `web/` bootstrap; PNGs in
`pak_out/ntex_png/` and used directly by the web port. The 10 failures are a
variant sub-layout (64×64, pal 256 B but data offset mismatch) — unexplored.

## 10. Where this project is heading

1. ~~SIS carve~~ 2. ~~E32 parse~~ 3. ~~pack decode~~ 4. ~~classification~~ 5. ~~name tables~~ 6. ~~hash function~~
7. ~~three.js cast-loop scaffold (working, headless-verified)~~
8. **⇒ next: port depth**
   - game/system load: reimplement `CFileSystem` (pak framing + hash index) in JS at runtime,
     so the port reads `data0000.pak` directly,
   - or pre-export asset digests via the GUID linkage found in the scene chunks,
   - decode `NE3DNTEX` textures (565-format), `NE3DXSCN` scene graphs, `SQSC` scripts, and drive the
     UI from the recovered name tables.

## 9. Provenance & IP note

All content here is extracted from a commercially-distributed SIE/Game title (© Infinite Dreams /
Nokia) stored as produced—**preservation-style analysis only**; the original `.sis` is untouched and
no re-distribution occurs by this toolchain. Be mindful of the
rights holders in any public release.
