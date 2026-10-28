#!/usr/bin/env python3
"""Hooked On: Creatures of the Deep — NE3D engine name-hash (recovered from exe, emulation-verified).

Source: game_payloads/0063_1230672.bin, LookupIndexByName @ vaddr 0x126dc
(inlined copy also at 0x126a0 with an extra 'A'-terminator branch):

    ip  = h << 30            ; lsl r4, r1, #0x1e
    ip  = h * c              ; mul ip, r1, ip
    r4  = ip >> 27           ; r4 == (h & 3) * 8  -> byte lane
    r3 += ip << r4           ; r3 += (h*c) << ((h&3)*8)
    h++; s++

with seed r3 = literal-pool value 0x12345678 (file 0x12b30) and r1 = h starting at 1.
Verified with Unicorn (loop trace matches formula exactly).
"""
import struct, sys

SEED = 0x12345678


def H(s: str, seed: int = SEED) -> int:
    a = seed & 0xFFFFFFFF
    for i, ch in enumerate(s, 1):
        a = (a + (i * ord(ch) << ((i & 3) * 8))) & 0xFFFFFFFF
    return a


if __name__ == '__main__':
    for name in sys.argv[1:]:
        print(f"{H(name):08x}  {name}")
