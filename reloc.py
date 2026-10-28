import struct, sys
sys.path.insert(0, '/Users/fa-001524/Documents/protos/appdecompile/Hooked On_Creatures of the Deep')
from e32dec import parse_header_exact

b = open('/Users/fa-001524/Documents/protos/appdecompile/Hooked On_Creatures of the Deep/game_payloads/0063_1230672.bin','rb').read()
_, h = parse_header_exact(b)
BASE = 0x400000  # use data_base as simulated load base for cohesive reading? Use code_base for code.

# build a flat image at code_base 0x8000 covering code then data at data_base 0x400000 in separate dict
# We'll build ONE region per segment.
def build_segment(base, off, size):
    return bytearray(b[off:off+size]), base

code_seg, code_base = build_segment(h['code_base'], h['code_off'], h['code_size'])

def apply_relocs(section_file_off, seg, seg_base):
    o = section_file_off
    OCR = b
    def u32(p): return struct.unpack_from('<I', OCR, p)[0]
    def u16(p): return struct.unpack_from('<H', OCR, p)[0]
    osize = u32(o); nrelocs = u32(o+4)
    print("reloc size", osize, "num", nrelocs)
    p = o + 8
    for i in range(nrelocs):
        page_base = u32(p); psize = u32(p+4)
        p += 8
        # psizes are odd (byte pairs); read (psize-8)/2 u16s
        cnt = (psize - 8) // 2
        for j in range(cnt):
            ri = u16(p); p += 2
            if ri & 0xC000:  # hmm typical: value 0 = skip page; high bits type
                pass
        p = p  # noop
    # EKA2L1 uses psize as ENTRY SIZE with SIGN map; we follow their loop:
    # Actually per their code after: rel_info processing in set_relocations; we replicate simply:
    return

# per EKA2L1: decode_entries: for each u16: if 0: skip? (special), else: type = ...; offset = ri
# 'rel_info' layout in eka2l1: type in high 4 bits; offset in low 12 bits; 0 => new segment base? 
