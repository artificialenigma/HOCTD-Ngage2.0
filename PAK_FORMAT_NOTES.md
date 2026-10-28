# Hooked On: Creatures of the Deep — pak format notes (RE state, Oct 2026)

## Status: FULL DATA RECOVERY COMPLETE

All 5,688 blobs of `extracted_full/Game/!/private/2000AFBC/data0000.pak` decoded:
1,698 raw + 3,187 compressed. Compiled output: `pak_out/` (~57MB), exported/typed copy: `assets/`.

## pak container
- Whole-file single-byte XOR: key 0xAA (confirmed in `CFileSystem::Read` @ vaddr 0x12ddc).
- Blob format (after deXOR): `[u32 uncompressedSize LE][payload][zero padding]`.
- Index = 20-byte file header then 5,680 × 16-byte entries:
  `[off ^ 0xAAAAAAAA, unc ^ 0xAAAAAAAA, comp ^ 0xAAAAAA, hash32]` (f1 always 0, f2 ∈ {0 raw, 2 compressed}).
- Index `hash32` ≠ name hash; not crc32/adler32 of any content we tried (still open what it hashes).

## Compressed blob codec (the big discovery)
Custom NE3D engine codec (NOT deflate/zlib/Symbian flate/bytepair):
**17-bit adaptive range-coded LZ** with cumfreq tables and `__aeabi_uidiv` normalisation,
resident in the game exe `game_payloads/0063_1230672.bin` (uid3=0x2000AFBC):
- entry point vaddr `0x13a94` = `Decode(state, compSrc, dst)`; init at `0x135b8` (dist model, 4096-entry
  table), `getbit` at `0x13538`, canon table search `0x13578`, helper region init `0x13850`.
- caller wrapper: `CFileSystem::LoadEntry` region (vaddr `0x12788` … caller `0x12998`).
- progress callbacks `bl 0x8394` inside the loop at `0x13ca0`/`0x13eb8` must be nopped in emulation.
- Reimplemented 1:1 by **Unicorn emulation** of the real ARM code (no hand-translation):
  `pak_unpack.py` (repo root; needs `pip3 install unicorn`).
- Import thunks inside the exe are `ldr pc,[pc,#-4]` stubs (0xe51ff004) with an ordinal payload word
  at `+4` (0x87/0x92/0x9b … used ones are udiv/udivmod); we patch all of them to stub handlers.
- Decode returns either `unc size` in r0, or `dst|size` (0x22000000-base return path).
- Verification: all 3,187 blobs decode to exactly their index-claimed `unc` size.

## Blob types (by decoded signature)
| count | type | notes |
|---|---|---|
| 474 | jpeg | photos / postcard backgrounds |
| 413 | ntex | starts `NE3DNTEX`, engine native texture (RGBA565 etc.); 414 named |
| 398 | nscene | starts `NE3DXSCN`, scene graph (fish perches/rod/unlockables, refs `*.mesh`) |
| 589 | png | 288 compressed + 301 raw |
| 75 | wav | RIFF PCM sounds |
| 118 | script | `skrypt\0<GUID-hex>\0` + `SQSC` bytecode (UI/logic scripts, Polish-authored) |
| 121 | keyframes | `[..][u32 n][float track]` animation key data |
| ~160 | record | small [ff ff ff ff][u16][cdcd][GUID16] resource records, 36–48 B |
| ~1041 incl. | quests/guests | dialog chunks literally named `01 quest…`, `02 guest…` |
| 62 | guidstr | `[GUID16][name]` scenery pieces: `Paper-wood_alaska`, `Paper-board_costarica` … |

## ENGINE NAME-HASH (RECOVERED, emulation-verified Oct 2026)
`LookupIndexByName` vaddr **0x126dc** (inlined twin `0x126a0`, which also terminates on `'A'`), seed
literal **0x12345678** at vaddr 0x12b30 (file 0xABCC):

    h = 0x12345678; i = 1
    for c in name_bytes:            # ldrb, ASCII, until \0 (or 'A' in the twin)
        h += (i * c) << ((i & 3) * 8)   # lane = ((h<<30)>>27) == (i&3)*8
        i += 1

Python impl: `pak_hash.py`. Verified instruction-by-instruction with Unicorn (loop trace = formula).
Callers of 0x126dc: 0x12764, 0x12ad0 (ReadFile fallback), 0x12c0c, 0x12c78, 0x12cc4.

**Pak index entry layout (corrected!):** index starts at file off **24**, count = plain u32 @ off 16.
Entry (whole file is XOR 0xAA, so these are post-de-XOR values):
`[+0 off][+4 uncomprSize][+8 comprSize | f2<<24][+12 hash32]` (all fields stored ^0xAAAAAAAA in file).
CFileSystem init @ 0x12608: read count `4B @file 0x10`, then `count*16 @file 0x14`. LoadEntry uses
`entry+4`; ReadFile-to-blob path uses `entry+8` (r1=8+idx*16); LookupIndexByName compares `entry+0`
== H(name).

**Still open:** H(name) matches no hash32 of the 5,680 entries for ANY of the names from the
recovered tables (10 string-encodings, 0 hits), nor table record keys (dups prove keys aren't a pure
name hash). So the loader-visible filenames differ from the (≤31-char truncated) table labels, or
entries are keyed by GUID-hex-tagged paths (see `.ldat` names like
`2cfc395e9d614ffab74562469f77de36.ldat` found via ReadFile ext-checks @0x129f8; pool @0x12b48).
Salt brute-force (all 25,887 printable 2–20-char strings in the exe, prefix/suffix) found nothing.

## RESOURCE NAME TABLES (all recovered; parse: header12B, then N×48B records `[GUID16][31-char name]`, sorted by first u32 key)
- blob 5130: 493 pictures (.png/.bmp paths like `panel\gps.png`, `rods\rod2_hand_sunset.png`)
- blob 5282: 76 sounds (`diary_newspaper.wav`, `rod_caststart_1.wav` …; note `land_seagulls_1.wav` twice)
- blob 2314: 414 textures (`*.ntex`: `redfish.ntex`, `brazil/brazil_flag_color.ntex` …)
- blob 1486: 381 scenes (`*.nscene`: `scotland/bream.nscene`, `rod1.nscene` …)
- blob 3394: 749 text/quest names (`snow-test`, `02 - quest10`, `sailfish` …)
- blob 2644: 294 dialogs (`skrypt`, `04 guest 3 -`) — pairs with the `skrypt\0<GUID>\0SQSC` script blobs
- blob 5370: 62 tournament/event names
- blob 5547: 76 `*.flc` sprite animations
- misc tables: 5307 (19), 5622/5671 etc.

Every table has `header[8..10..11]` = record count at byte 8 (`panel: u32`), 12-byte prefix, then
records; file size == 12 + N*48 exact. First `u32` of the 16-byte key is unique per record and the
table is sorted ascending by it ( ⇒ first u32 = deterministic name/GUID key, still NOT reproduced by
any standard hash — djb2/sdbm/fnv/crc/javadoc over 8-bit *and* 16-bit units, md5/sha1-derived GUID
candidates all failed ⇒ the engine has a bespoke seeded hash or uuid4-with-salt).

## Open
- exact name→blob-k linker (needs the bespoke hash algo from the exe; static references to the
  engine string literals use relocated literal pools — reloc parsing may resolve where ADR scans fail).
- index `hash32` source field.
