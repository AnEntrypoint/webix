import assert from "node:assert/strict";
import { CPU, PagedMemory, PERM, REG, FLAGS } from "../src/index.js";

function runBytes(bytes, setup = () => {}) {
  const mem = new PagedMemory();
  mem.map(0x1000, 0x1000, PERM.RWX, "test");
  mem.writeBytes(0x1000, new Uint8Array(bytes));
  const cpu = new CPU(mem, null, { eip: 0x1000 });
  setup(cpu, mem);
  for (let i = 0; i < 20; i++) {
    try { cpu.step(); } catch (e) { if (/HLT/.test(e.message)) break; else throw e; }
  }
  return { cpu, mem };
}

// cpuid advertises FPU/SSE/SSE2 now that those compatibility paths exist.
{
  const { cpu } = runBytes([0xb8,1,0,0,0,0x0f,0xa2,0xf4]);
  assert.ok(cpu.regs[REG.EDX] & (1 << 0));
  assert.ok(cpu.regs[REG.EDX] & (1 << 25));
  assert.ok(cpu.regs[REG.EDX] & (1 << 26));
}

// SSE register moves/xor zero the destination XMM register.
{
  const { cpu } = runBytes([0x0f,0x57,0xc0,0xf4], cpu => cpu.xmm[0].fill(0xff));
  assert.deepEqual([...cpu.xmm[0]], Array(16).fill(0));
}

// x87 fnstcw writes the default control word.
{
  const { mem } = runBytes([0xd9,0x3d,0x00,0x20,0x00,0x00,0xf4], (_cpu, mem) => mem.map(0x2000, 0x1000, PERM.RW));
  assert.equal(mem.read16(0x2000), 0x037f);
}

console.log("cpu extension tests passed");
