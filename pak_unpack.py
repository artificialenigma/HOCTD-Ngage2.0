import struct, sys, os, json

PUZ = '/Users/fa-001524/Documents/protos/appdecompile/Hooked On_Creatures of the Deep/game_payloads/0063_1230672.bin'
B = open(PUZ,'rb').read()
CODE_OFF, CODE_BASE, CODE_SIZE = 0x9c, 0x8000, 0x1256ac

from unicorn import *
from unicorn.arm_const import *

MAGIC = 0xF0000000
STATE = 0x20000000
SRC   = 0x21000000
DST   = 0x22000000
RET_A = 0xF1000000
STACK = 0x10000000

def udivmod_hook(uc):
    r0 = uc.reg_read(UC_ARM_REG_R0) % (1<<32); r1 = uc.reg_read(UC_ARM_REG_R1) % (1<<32)
    if r1 == 0: q, m = 0, 0
    else: q, m = r0 // r1, r0 % r1
    uc.reg_write(UC_ARM_REG_R0, q)
    uc.reg_write(UC_ARM_REG_R1, m)

class Hooked:
    __slots__ = ('uc','impl','name')
    def __init__(self, uc, name, impl):
        self.uc = uc; self.impl = impl; self.name = name
    def __call__(self, uc, addr, size, ud):
        self.impl(uc)
        uc.reg_write(UC_ARM_REG_PC, uc.reg_read(UC_ARM_REG_LR))

class Emu:
    def __init__(self):
        uc = self.uc = Uc(UC_ARCH_ARM, UC_MODE_ARM)
        uc.mem_map(CODE_BASE, 0x140000)
        uc.mem_write(CODE_BASE, B[CODE_OFF:CODE_OFF+CODE_SIZE])
        uc.mem_map(MAGIC, 0x100000)
        uc.mem_map(STATE, 0x400000)
        uc.mem_map(SRC, 0x200000)
        uc.mem_map(DST, 0x400000)
        uc.mem_map(STACK, 0x100000)
        uc.mem_map(RET_A, 0x1000)
        uc.mem_write(RET_A, b'\x00\x00\xa0\xe1')
        uc.reg_write(UC_ARM_REG_SP, STACK + 0x80000)
        # no-op internal progress callback in the decode loop
        for nop in (0x13ca0, 0x13eb8):
            uc.mem_write(nop, b'\x00\x00\xa0\xe1')
        # stub all import thunks (ldr pc,[pc,#-4]); default = udiv-of-slot-909
        impls = {0x10dcd0: udivmod_hook, 0x10dc90: udivmod_hook, 0x10dca8: udivmod_hook}
        wd = struct.unpack_from(f'<{CODE_SIZE//4}I', B, CODE_OFF)
        self.thunk_names = {}
        n = 0
        for i, w in enumerate(wd):
            if w != 0xe51ff004: continue
            va = CODE_BASE + i*4
            sa = MAGIC + n*8; n += 1
            impl = impls.get(va, udivmod_hook)
            uc.mem_write(va + 4, struct.pack('<I', sa))
            uc.hook_add(UC_HOOK_CODE, Hooked(uc, f'unk@{va:08x}', impl), begin=sa, end=sa+3)
            self.thunk_names[sa] = va

    def decode(self, blob):
        """blob: full de-XORed payload incl. leading u32 uncompressed size.
        Returns (uncompressed bytes, r0)."""
        uc = self.uc
        assert len(blob) < 0x200000
        uc.mem_write(SRC, blob)
        uc.mem_write(STATE, b'\x00' * 0x1000)
        uc.reg_write(UC_ARM_REG_R0, STATE)
        uc.reg_write(UC_ARM_REG_R1, SRC)
        uc.reg_write(UC_ARM_REG_R2, DST)
        uc.mem_write(RET_A, b'\x00\x00\xa0\xe1')  # in case it got clobbered
        uc.mem_write(RET_A, b'\x00\x00\xa0\xe1')  # in case it got clobbered
        uc.reg_write(UC_ARM_REG_LR, RET_A)
        self.err = None
        try:
            uc.emu_start(0x13a94, RET_A)
        except UcError as e:
            self.err = f"UcError: {e} pc={uc.reg_read(UC_ARM_REG_PC):#x}"
            return None
        dn = uc.reg_read(UC_ARM_REG_R0)
        if dn >= DST:            # return path gives dst|size
            dn -= DST
        if dn == 0 or dn > 0x400000:
            self.err = f"bad outsize {dn:#x}"
            return None
        return bytes(uc.mem_read(DST, dn))

def main():
    base = '/Users/fa-001524/Documents/protos/appdecompile/Hooked On_Creatures of the Deep'
    ents = json.load(open(base + '/pak_out/index.json'))
    d = open(base + '/extracted_full/Game/!/private/2000AFBC/data0000.pak','rb').read()
    outdir = base + '/pak_out/comp'
    os.makedirs(outdir, exist_ok=True)
    emu = Emu()
    comp = [e for e in ents if e['f2'] == 2]
    ok = fail = 0
    faildetail = []
    for e in comp:
        pay = bytes(x ^ 0xAA for x in d[e['off']:e['off']+e['comp']])
        want = struct.unpack('<I', pay[:4])[0]
        out = emu.decode(pay)
        if out is None or len(out) != want:
            fail += 1
            faildetail.append((e['k'], e['comp'], want, emu.err, 'len mismatch' if out is not None else 'null'))
            continue
        ok += 1
        open(f"{outdir}/{e['k']:05d}.bin",'wb').write(out)
    print(f"OK {ok}/{len(comp)}  FAIL {fail}")
    for f in faildetail[:20]:
        print("  fail", f)

if __name__ == '__main__':
    main()
