#!/usr/bin/env python3
"""Symian flate decompressor - faithful Python port of EKA2L1's flate.cpp/bytepair.cpp.
Used to decompress E32 image bodies (compression_type 0x101F7AFC / 0x102822AA).
"""

HUFFMAN_MAX_CODELENGTH = 27

huffman_dec = [
    0x0004006c, 0x00040064, 0x0004005c, 0x00040050, 0x00040044, 0x0004003c,
    0x00040034, 0x00040021, 0x00040023, 0x00040025, 0x00040027, 0x00040029,
    0x00040014, 0x0004000c, 0x00040035, 0x00390037, 0x00330031, 0x0004002b,
    0x002f002d, 0x001f001d, 0x001b0019, 0x00040013, 0x00170015, 0x0004000d,
    0x0011000f, 0x000b0009, 0x00070003, 0x00050001,
]

# flate constants
DEFLATE_CODE_OFFSET = 27
ENCODING_LITERALS = 256
ENCODING_LENGTHS = (8 - 1) * 4   # 28
ENCODING_SPECIALS = 1
ENCODING_DISTS = (12 - 1) * 4    # 44
ENCODING_LITERAL_LEN = ENCODING_LITERALS + ENCODING_LENGTHS + ENCODING_SPECIALS  # 285
ENCODING_EOS = ENCODING_LITERALS + ENCODING_LENGTHS  # 284
DEFLATE_CODES = ENCODING_LITERAL_LEN + ENCODING_DISTS  # 329
DEFLATE_LENGTH_MAG = 8
DEFLATE_DIST_MAG = 12
DEFLATE_MIN_LENGTH = 3
DEFLATE_MAX_LENGTH = DEFLATE_MIN_LENGTH - 1 + (1 << DEFLATE_LENGTH_MAG)
DEFLATE_MAX_DIST = 1 << DEFLATE_DIST_MAG
DEFLATE_DIST_CODE_BASE = 0x200


class BitInput:
    """Burps bits MSB-first, from data (interpreted as big-endian words like swap_bo)."""
    def __init__(self, data, off=0):
        self.n = len(data)
        self.byte_i = off >> 3
        self.bit_i = 7 - (off & 7)

    def read(self, size=1):
        val = 0
        for _ in range(size):
            if self.byte_i >= self.n:
                raise EOFError('bit read underflow')
            b = (self.data[self.byte_i] >> self.bit_i) & 1
            val = (val << 1) | b
            self.bit_i -= 1
            if self.bit_i < 0:
                self.bit_i = 7
                self.byte_i += 1
        return val

    def huffman(self, tree_words):
        """tree_words: list/array of 32-bit ints laid out like the C code (byte arena)."""
        # emulate byte-arena: bytes of the array little-endian words
        arena = bytearray()
        for w in tree_words:
            arena += w.to_bytes(4, 'little')
        base = 0
        huff = 0
        while True:
            base += (huff >> 16) * 1  # offset in BYTES
            idx = base // 4
            if base & 3 or idx >= len(tree_words):
                # unaligned read: reconstruct little-endian word into int
                if base + 4 > len(arena):
                    raise ValueError('tree overread')
                huff = arena[base] | (arena[base+1] << 8) | (arena[base+2] << 16) | (arena[base+3] << 24)
            else:
                huff = tree_words[idx]
            bit = self.read(1)
            if bit == 0:
                huff = (huff << 16) & 0xFFFFFFFF
            if (huff & 0x10000) != 0:
                return huff >> 17

    def huffman_len_tree(self):
        """The fixed model used to internalize lengths: returns symbol value as the C does."""
        return self.huffman(huffman_dec)


def internalize(len_in, num_codes):
    """huffman::internalize bit_input -> huffman lengths array (uint32 len[num_codes])."""
    lengths = [0] * num_codes
    hist = list(range(HUFFMAN_MAX_CODELENGTH + 1))
    p = 0
    last = 0
    rl = 0
    while p + rl < num_codes:
        c = len_in.huffman_len_tree()
        if c < 2:
            rl += rl + c + 1
        else:
            while rl > 0:
                if p > num_codes:
                    raise ValueError('internalize overflow')
                lengths[p] = last; p += 1
                rl -= 1
            list_ = hist
            list_[0] = last
            last = list_[c]
            list_ = [list_[c]] + list_[:c]  # shift
            hist = [last] + hist[1:c] + [hist[c]] + hist[c+1:]
            if p > num_codes:
                raise ValueError('internalize overflow')
            lengths[p] = last; p += 1
    while rl > 0:
        if p > num_codes: raise ValueError('internalize overflow')
        lengths[p] = last; p += 1
        rl -= 1
    return lengths


def huffman_decoding(lengths, num_codes, sym_base=0):
    """huffman::decoding - builds decode tree (list of u32) from code lengths."""
    counts = [0] * HUFFMAN_MAX_CODELENGTH
    codes = 0
    for i in range(num_codes):
        if lengths[i]:
            counts[lengths[i] - 1] += 1
            codes += 1
    total = codes + num_codes
    tree = [0] * total
    for i in range(num_codes):
        tree[i] = lengths[i] & 0xFF

    # lvl[i] = lit; lit -= counts[i]
    lit = codes
    lvl = [0] * HUFFMAN_MAX_CODELENGTH
    for i in range(HUFFMAN_MAX_CODELENGTH):
        lvl[i] = lit
        lit -= counts[i]
    sym_base = (sym_base << 17) + (1 << 16)
    for i in range(num_codes):
        ln = lengths[i]
        if ln:
            idx = lvl[ln - 1]
            lvl[ln - 1] = idx - 1
            tree[idx] |= (i << 17) + sym_base

    if codes == 1:
        term = tree[0] >> 16
        tree[0] = term | (term << 16)
    elif codes > 1:
        _huffman_subtree(tree, codes - 1, codes - 1, lvl, 0)
    return tree


def _huffman_subtree(tree, ptr, val, lvl, depth=0):
    def lvl_at(i):
        return lvl[i]
    left = lvl[0]
    lvl = lvl  # python: pointers in list lvl[0]
    # port exactly: left = *lvl++; if left > val ...
    raise NotImplementedError('huffman_subtree port needed')
