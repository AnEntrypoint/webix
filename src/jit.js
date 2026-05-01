import { REG } from "./util.js";
import { ProcessExit, AsyncSyscallPending, ExecveTrap } from "./syscalls.js";

/**
 * Clean-room dynamic binary translation tier.
 *
 * This tier compiles a conservative subset of straight-line IA-32 blocks into JS
 * closures. It is intentionally correct-first: any prefix, ModR/M, branch form, or
 * instruction it cannot prove safe falls back to the interpreter for one step. The
 * cache tracks guest address ranges and invalidates on guest writes, which is the
 * hard requirement for self-modifying code. A WebAssembly backend can share the same
 * block descriptor and invalidation machinery; this JS backend is the working DBT
 * tier used by tests today.
 */
export class BlockCacheJIT {
  constructor(options = {}) {
    this.hotThreshold = options.hotThreshold ?? 8;
    this.maxBlockBytes = options.maxBlockBytes ?? 64;
    this.maxBlockInsns = options.maxBlockInsns ?? 24;
    this.hits = new Map();
    this.blocks = new Map();
    this.stats = { compiled: 0, executed: 0, bailed: 0, invalidated: 0 };
  }

  invalidate(addr, len = 1) {
    const start = addr >>> 0, end = (addr + len) >>> 0;
    for (const key of [...this.blocks.keys()]) {
      const block = this.blocks.get(key);
      if (block && block.start < end && block.end > start) { this.blocks.delete(key); this.stats.invalidated++; }
    }
  }

  _read32(mem, addr) { return (mem.read8exec(addr) | (mem.read8exec((addr + 1) >>> 0) << 8) | (mem.read8exec((addr + 2) >>> 0) << 16) | (mem.read8exec((addr + 3) >>> 0) << 24)) >>> 0; }
  _s8(x) { x &= 0xff; return x & 0x80 ? x - 0x100 : x; }

  compile(cpu, start = cpu.eip >>> 0) {
    const mem = cpu.mem;
    const ops = [];
    let pc = start >>> 0;
    let terminal = false;
    try {
      for (let i = 0; i < this.maxBlockInsns && ((pc - start) >>> 0) < this.maxBlockBytes && !terminal; i++) {
        const at = pc >>> 0;
        const op = mem.read8exec(pc); pc = (pc + 1) >>> 0;
        if (op === 0x90) { ops.push(c => { c.steps++; }); continue; }
        if (op >= 0xb8 && op <= 0xbf) { const reg = op - 0xb8; const imm = this._read32(mem, pc); pc = (pc + 4) >>> 0; ops.push(c => { c.regs[reg] = imm >>> 0; c.steps++; }); continue; }
        if (op >= 0x50 && op <= 0x57) { const reg = op - 0x50; ops.push(c => { c.push32(c.regs[reg]); c.steps++; }); continue; }
        if (op >= 0x58 && op <= 0x5f) { const reg = op - 0x58; ops.push(c => { c.regs[reg] = c.pop32(); c.steps++; }); continue; }
        if (op >= 0x40 && op <= 0x47) { const reg = op - 0x40; ops.push(c => { const oldCF = c.getFlag(1); c.regs[reg] = c._add(c.regs[reg], 1, 32); c.setFlag(1, oldCF); c.steps++; }); continue; }
        if (op >= 0x48 && op <= 0x4f) { const reg = op - 0x48; ops.push(c => { const oldCF = c.getFlag(1); c.regs[reg] = c._sub(c.regs[reg], 1, 32); c.setFlag(1, oldCF); c.steps++; }); continue; }
        if (op === 0x31) { // xor r/m32,r32: only compile reg,reg form
          const m = mem.read8exec(pc); pc = (pc + 1) >>> 0;
          if ((m >>> 6) !== 3) return null;
          const reg = (m >>> 3) & 7, rm = m & 7;
          ops.push(c => { c.regs[rm] = c._logic(c.regs[rm] ^ c.regs[reg], 32); c.steps++; }); continue;
        }
        if (op === 0x83) { // group1 r/m32, imm8: only reg form
          const m = mem.read8exec(pc); pc = (pc + 1) >>> 0;
          if ((m >>> 6) !== 3) return null;
          const group = (m >>> 3) & 7, rm = m & 7; const imm = this._s8(mem.read8exec(pc)); pc = (pc + 1) >>> 0;
          ops.push(c => { const r = c.alu(group, c.regs[rm], imm, 32); if (group !== 7) c.regs[rm] = r; c.steps++; }); continue;
        }
        if (op === 0xcd && mem.read8exec(pc) === 0x80) { pc = (pc + 1) >>> 0; const after = pc >>> 0; ops.push(c => { c.eip = after; c.steps++; c.syscalls.handle(c); }); terminal = true; continue; }
        if (op === 0xe9) { const rel = this._read32(mem, pc) | 0; pc = (pc + 4) >>> 0; const target = (pc + rel) >>> 0; ops.push(c => { c.eip = target; c.steps++; }); terminal = true; continue; }
        if (op === 0xeb) { const rel = this._s8(mem.read8exec(pc)); pc = (pc + 1) >>> 0; const target = (pc + rel) >>> 0; ops.push(c => { c.eip = target; c.steps++; }); terminal = true; continue; }
        if (op === 0xc3) { ops.push(c => { c.eip = c.pop32(); c.steps++; }); terminal = true; continue; }
        return null;
      }
    } catch { return null; }
    if (!ops.length) return null;
    const end = pc >>> 0;
    return {
      start, end, ops,
      run(cpu) {
        const beginSteps = cpu.steps;
        for (const op of ops) op(cpu);
        if (!terminal) cpu.eip = end;
        return cpu.steps - beginSteps;
      }
    };
  }

  run(cpu, maxSteps = 1_000_000) {
    while (cpu.steps < maxSteps) {
      const eip = cpu.eip >>> 0;
      let block = this.blocks.get(eip);
      if (!block) {
        const n = (this.hits.get(eip) ?? 0) + 1;
        this.hits.set(eip, n);
        if (n >= this.hotThreshold) {
          block = this.compile(cpu, eip);
          if (block) { this.blocks.set(eip, block); this.stats.compiled++; }
        }
      }
      if (block) { this.stats.executed++; block.run(cpu); }
      else { this.stats.bailed++; cpu.step(); }
    }
    throw new Error(`Step limit reached (${maxSteps})`);
  }
}
