import { REG, REG_NAMES, FLAGS, hex32, s8, s16, sign32, parity8, makeBigUint64, makeBigInt64, lo32FromBigInt, hi32FromBigInt } from "./util.js";

export class CPUError extends Error {}
export class UnsupportedOpcodeError extends CPUError {
  constructor(op, at) { super(`Unsupported opcode ${op} at ${hex32(at)}`); this.op = op; this.at = at >>> 0; }
}

const SEG_PREFIX = new Map([[0x26, "es"], [0x2e, "cs"], [0x36, "ss"], [0x3e, "ds"], [0x64, "fs"], [0x65, "gs"]]);
const LOW_MASK = { 8: 0xff, 16: 0xffff, 32: 0xffffffff };
const SIGN_BIT = { 8: 0x80, 16: 0x8000, 32: 0x80000000 };
const DEFAULT_EFLAGS = 0x202;

function maskFor(width) { return width === 32 ? 0xffffffff : (1 << width) - 1; }
function signBit(width) { return width === 32 ? 0x80000000 : (1 << (width - 1)); }
function truncate(v, width) { return width === 32 ? (v >>> 0) : (v & maskFor(width)); }
function signExtend(v, width) {
  v = truncate(v, width);
  if (width === 8) return s8(v);
  if (width === 16) return s16(v);
  return v >> 0;
}

export class CPU {
  constructor(memory, syscalls = null, options = {}) {
    this.mem = memory;
    this.syscalls = syscalls;
    this.regs = new Uint32Array(8);
    this.sregs = { es: 0x2b, cs: 0x23, ss: 0x2b, ds: 0x2b, fs: 0, gs: 0 };
    this.segBase = { es: 0, cs: 0, ss: 0, ds: 0, fs: 0, gs: 0 };
    this.eip = options.eip >>> 0;
    this.eflags = DEFAULT_EFLAGS;
    this.steps = 0;
    this.trace = options.trace ?? false;
    this.logger = options.logger ?? console;
    this.lastPrefix = null;
    this.xmm = Array.from({ length: 8 }, () => new Uint8Array(16));
    this.fpu = { stack: [], control: 0x037f, status: 0 };
    this.mxcsr = 0x1f80;
  }

  fetch8() { const v = this.mem.read8exec(this.eip); this.eip = (this.eip + 1) >>> 0; return v; }
  fetch16() { const lo = this.fetch8(); return lo | (this.fetch8() << 8); }
  fetch32() { return (this.fetch8() | (this.fetch8() << 8) | (this.fetch8() << 16) | (this.fetch8() << 24)) >>> 0; }
  fetchImm(width) { return width === 8 ? this.fetch8() : width === 16 ? this.fetch16() : this.fetch32(); }
  fetchSignedImm(width) { return signExtend(this.fetchImm(width), width); }

  getFlag(mask) { return (this.eflags & mask) !== 0; }
  setFlag(mask, value) { this.eflags = value ? ((this.eflags | mask) >>> 0) : ((this.eflags & ~mask) >>> 0); }

  getReg(width, id) {
    id &= 7;
    if (width === 8) {
      if (id < 4) return this.regs[id] & 0xff;
      return (this.regs[id - 4] >>> 8) & 0xff;
    }
    if (width === 16) return this.regs[id] & 0xffff;
    return this.regs[id] >>> 0;
  }

  setReg(width, id, value) {
    id &= 7; value = truncate(value, width);
    if (width === 8) {
      if (id < 4) this.regs[id] = (this.regs[id] & 0xffffff00) | value;
      else this.regs[id - 4] = (this.regs[id - 4] & 0xffff00ff) | (value << 8);
      return;
    }
    if (width === 16) this.regs[id] = (this.regs[id] & 0xffff0000) | value;
    else this.regs[id] = value >>> 0;
  }

  _readXmmOperand(m, bytes = 16) {
    if (m.rm.type === "reg") return this.xmm[m.rm.reg].slice(0, bytes);
    return this.mem.readBytes(m.rm.addr, bytes);
  }
  _writeXmmOperand(m, bytes, data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (m.rm.type === "reg") { this.xmm[m.rm.reg].set(b.subarray(0, bytes), 0); return; }
    this.mem.writeBytes(m.rm.addr, b.subarray(0, bytes));
  }
  _xmmDataView(reg) { return new DataView(this.xmm[reg].buffer, this.xmm[reg].byteOffset, 16); }
  _fpuPush(v) { this.fpu.stack.unshift(Number(v)); if (this.fpu.stack.length > 8) this.fpu.stack.length = 8; }
  _fpuPop() { return this.fpu.stack.length ? this.fpu.stack.shift() : 0; }
  _fpuPeek(i = 0) { return this.fpu.stack[i] ?? 0; }
  _fpuCompare(a, b) {
    // x87 compare result is reported in status word bits C0/C2/C3.
    // Clear C0(8), C2(10), C3(14), then set according to Intel FCOM semantics.
    this.fpu.status &= ~((1 << 8) | (1 << 10) | (1 << 14));
    if (Number.isNaN(a) || Number.isNaN(b)) { this.fpu.status |= (1 << 8) | (1 << 10) | (1 << 14); return; }
    if (a < b) this.fpu.status |= (1 << 8);
    else if (a === b) this.fpu.status |= (1 << 14);
  }

  push(value, width = 32) {
    if (width === 16) {
      this.regs[REG.ESP] = (this.regs[REG.ESP] - 2) >>> 0;
      this.mem.write16(this.regs[REG.ESP], value);
    } else {
      this.regs[REG.ESP] = (this.regs[REG.ESP] - 4) >>> 0;
      this.mem.write32(this.regs[REG.ESP], value);
    }
  }
  push32(v) { this.push(v, 32); }
  pop(width = 32) {
    if (width === 16) {
      const v = this.mem.read16(this.regs[REG.ESP]);
      this.regs[REG.ESP] = (this.regs[REG.ESP] + 2) >>> 0;
      return v;
    }
    const v = this.mem.read32(this.regs[REG.ESP]);
    this.regs[REG.ESP] = (this.regs[REG.ESP] + 4) >>> 0;
    return v >>> 0;
  }
  pop32() { return this.pop(32); }

  parsePrefixes() {
    const p = { operandSize: 32, addressSize: 32, rep: null, lock: false, seg: null };
    let done = false;
    while (!done) {
      const b = this.mem.read8exec(this.eip);
      switch (b) {
        case 0x66: p.operandSize = 16; this.eip = (this.eip + 1) >>> 0; break;
        case 0x67: p.addressSize = 16; this.eip = (this.eip + 1) >>> 0; break;
        case 0xf0: p.lock = true; this.eip = (this.eip + 1) >>> 0; break;
        case 0xf2: p.rep = "repne"; this.eip = (this.eip + 1) >>> 0; break;
        case 0xf3: p.rep = "rep"; this.eip = (this.eip + 1) >>> 0; break;
        default:
          if (SEG_PREFIX.has(b)) { p.seg = SEG_PREFIX.get(b); this.eip = (this.eip + 1) >>> 0; }
          else done = true;
      }
    }
    this.lastPrefix = p;
    return p;
  }

  _segBase(seg) { return this.segBase[seg ?? "ds"] >>> 0; }
  _applySeg(addr, seg) { return (addr + this._segBase(seg)) >>> 0; }

  decodeModRM(prefix = this.lastPrefix) {
    const byte = this.fetch8();
    const mod = byte >>> 6;
    const reg = (byte >>> 3) & 7;
    const rmNo = byte & 7;
    if (mod === 3) return { byte, mod, reg, rm: { type: "reg", reg: rmNo } };

    if (prefix?.addressSize === 16) return this.decodeModRM16(byte, mod, reg, rmNo, prefix);

    let addr = 0;
    let defaultSeg = "ds";
    let sib = null;
    if (rmNo === 4) {
      sib = this.fetch8();
      const scale = 1 << (sib >>> 6);
      const index = (sib >>> 3) & 7;
      const base = sib & 7;
      if (index !== 4) addr = (addr + Math.imul(this.regs[index], scale)) >>> 0;
      if (base === 5 && mod === 0) addr = (addr + this.fetch32()) >>> 0;
      else {
        addr = (addr + this.regs[base]) >>> 0;
        if (base === REG.EBP || base === REG.ESP) defaultSeg = "ss";
      }
    } else if (rmNo === 5 && mod === 0) {
      addr = this.fetch32() >>> 0;
    } else {
      addr = this.regs[rmNo] >>> 0;
      if (rmNo === REG.EBP) defaultSeg = "ss";
    }
    if (mod === 1) addr = (addr + s8(this.fetch8())) >>> 0;
    else if (mod === 2) addr = (addr + sign32(this.fetch32())) >>> 0;
    const seg = prefix?.seg ?? defaultSeg;
    return { byte, mod, reg, sib, rm: { type: "mem", addr: this._applySeg(addr, seg), rawAddr: addr >>> 0, seg } };
  }

  decodeModRM16(byte, mod, reg, rmNo, prefix) {
    const bx = this.regs[REG.EBX] & 0xffff, bp = this.regs[REG.EBP] & 0xffff, si = this.regs[REG.ESI] & 0xffff, di = this.regs[REG.EDI] & 0xffff;
    const table = [bx + si, bx + di, bp + si, bp + di, si, di, 0, bx];
    let addr, defaultSeg = (rmNo === 2 || rmNo === 3 || rmNo === 6) ? "ss" : "ds";
    if (mod === 0 && rmNo === 6) addr = this.fetch16();
    else addr = table[rmNo] & 0xffff;
    if (mod === 1) addr = (addr + s8(this.fetch8())) & 0xffff;
    else if (mod === 2) addr = (addr + s16(this.fetch16())) & 0xffff;
    const seg = prefix?.seg ?? defaultSeg;
    return { byte, mod, reg, rm: { type: "mem", addr: this._applySeg(addr, seg), rawAddr: addr >>> 0, seg } };
  }

  getRM(width, rm) {
    if (rm.type === "reg") return this.getReg(width, rm.reg);
    if (width === 8) return this.mem.read8(rm.addr);
    if (width === 16) return this.mem.read16(rm.addr);
    return this.mem.read32(rm.addr);
  }
  setRM(width, rm, value) {
    if (rm.type === "reg") return this.setReg(width, rm.reg, value);
    if (width === 8) return this.mem.write8(rm.addr, value);
    if (width === 16) return this.mem.write16(rm.addr, value);
    return this.mem.write32(rm.addr, value);
  }

  _setZS(width, result) {
    result = truncate(result, width);
    this.setFlag(FLAGS.ZF, result === 0);
    this.setFlag(FLAGS.SF, (result & signBit(width)) !== 0);
    this.setFlag(FLAGS.PF, parity8(result));
  }
  _setAF(a, b, r) { this.setFlag(FLAGS.AF, ((a ^ b ^ r) & 0x10) !== 0); }

  _add(a, b, width, carry = 0) {
    const mask = width === 32 ? 0xffffffffn : BigInt(maskFor(width));
    const sign = BigInt(signBit(width) >>> 0);
    const A = BigInt(truncate(a, width));
    const B = BigInt(truncate(b, width));
    const C = BigInt(carry ? 1 : 0);
    const R = A + B + C;
    const r = Number(R & mask) >>> 0;
    this._setZS(width, r);
    this.setFlag(FLAGS.CF, R > mask);
    this.setFlag(FLAGS.OF, (((~(Number(A) ^ Number(B)) & (Number(A) ^ r)) & Number(sign)) !== 0));
    this._setAF(Number(A), Number(B) + Number(C), r);
    return truncate(r, width);
  }

  _sub(a, b, width, borrow = 0) {
    const A = BigInt(truncate(a, width));
    const B = BigInt(truncate(b, width)) + BigInt(borrow ? 1 : 0);
    const mod = 1n << BigInt(width);
    const r = Number((A - B + mod) & (mod - 1n)) >>> 0;
    const sign = signBit(width);
    this._setZS(width, r);
    this.setFlag(FLAGS.CF, A < B);
    this.setFlag(FLAGS.OF, ((((Number(A) ^ Number(B)) & (Number(A) ^ r)) & sign) !== 0));
    this._setAF(Number(A), Number(B), r);
    return truncate(r, width);
  }

  _logic(result, width) {
    result = truncate(result, width);
    this._setZS(width, result);
    this.setFlag(FLAGS.CF, false);
    this.setFlag(FLAGS.OF, false);
    this.setFlag(FLAGS.AF, false);
    return result;
  }

  alu(kind, a, b, width) {
    switch (kind) {
      case 0: return this._add(a, b, width); // add
      case 1: return this._logic(a | b, width); // or
      case 2: return this._add(a, b, width, this.getFlag(FLAGS.CF) ? 1 : 0); // adc
      case 3: return this._sub(a, b, width, this.getFlag(FLAGS.CF) ? 1 : 0); // sbb
      case 4: return this._logic(a & b, width); // and
      case 5: return this._sub(a, b, width); // sub
      case 6: return this._logic(a ^ b, width); // xor
      case 7: return this._sub(a, b, width); // cmp; caller does not store
      default: throw new CPUError(`bad alu kind ${kind}`);
    }
  }

  cond(code) {
    switch (code & 0xf) {
      case 0x0: return this.getFlag(FLAGS.OF);
      case 0x1: return !this.getFlag(FLAGS.OF);
      case 0x2: return this.getFlag(FLAGS.CF);
      case 0x3: return !this.getFlag(FLAGS.CF);
      case 0x4: return this.getFlag(FLAGS.ZF);
      case 0x5: return !this.getFlag(FLAGS.ZF);
      case 0x6: return this.getFlag(FLAGS.CF) || this.getFlag(FLAGS.ZF);
      case 0x7: return !this.getFlag(FLAGS.CF) && !this.getFlag(FLAGS.ZF);
      case 0x8: return this.getFlag(FLAGS.SF);
      case 0x9: return !this.getFlag(FLAGS.SF);
      case 0xa: return this.getFlag(FLAGS.PF);
      case 0xb: return !this.getFlag(FLAGS.PF);
      case 0xc: return this.getFlag(FLAGS.SF) !== this.getFlag(FLAGS.OF);
      case 0xd: return this.getFlag(FLAGS.SF) === this.getFlag(FLAGS.OF);
      case 0xe: return this.getFlag(FLAGS.ZF) || (this.getFlag(FLAGS.SF) !== this.getFlag(FLAGS.OF));
      case 0xf: return !this.getFlag(FLAGS.ZF) && (this.getFlag(FLAGS.SF) === this.getFlag(FLAGS.OF));
      default: return false;
    }
  }

  executeGroup1(width, group, dst, imm, store) {
    const result = this.alu(group, dst, imm, width);
    if (group !== 7) store(result);
  }

  shiftRotate(width, group, value, count) {
    count &= 0x1f;
    value = truncate(value, width);
    if (count === 0) return value;
    const mask = maskFor(width);
    const sign = signBit(width);
    let result = value;
    switch (group) {
      case 0: // rol
        count %= width;
        result = truncate((value << count) | (value >>> (width - count)), width);
        this.setFlag(FLAGS.CF, (result & 1) !== 0);
        if (count === 1) this.setFlag(FLAGS.OF, ((result & sign) !== 0) !== this.getFlag(FLAGS.CF));
        break;
      case 1: // ror
        count %= width;
        result = truncate((value >>> count) | (value << (width - count)), width);
        this.setFlag(FLAGS.CF, (result & sign) !== 0);
        if (count === 1) this.setFlag(FLAGS.OF, ((result & sign) !== 0) !== ((result & (sign >>> 1)) !== 0));
        break;
      case 2: // rcl, approximate through shl-like carry
      case 3: // rcr, approximate through shr-like carry
        return this.shiftRotate(width, group === 2 ? 4 : 5, value, count);
      case 4: // shl/sal
      case 6:
        result = truncate(value << count, width);
        this.setFlag(FLAGS.CF, ((value << (count - 1)) & sign) !== 0);
        if (count === 1) this.setFlag(FLAGS.OF, ((result & sign) !== 0) !== this.getFlag(FLAGS.CF));
        this._setZS(width, result);
        break;
      case 5: // shr
        result = truncate(value >>> count, width);
        this.setFlag(FLAGS.CF, ((value >>> (count - 1)) & 1) !== 0);
        if (count === 1) this.setFlag(FLAGS.OF, (value & sign) !== 0);
        this._setZS(width, result);
        break;
      case 7: { // sar
        const signed = signExtend(value, width);
        result = truncate(signed >> count, width);
        this.setFlag(FLAGS.CF, ((value >>> (count - 1)) & 1) !== 0);
        if (count === 1) this.setFlag(FLAGS.OF, false);
        this._setZS(width, result);
        break;
      }
      default: throw new CPUError(`bad shift group ${group}`);
    }
    result &= mask;
    return truncate(result, width);
  }

  handleStringOp(op, prefix) {
    const width = (op === 0xa4 || op === 0xa6 || op === 0xaa || op === 0xac || op === 0xae) ? 8 : prefix.operandSize;
    const size = width / 8;
    const direction = this.getFlag(FLAGS.DF) ? -size : size;
    const repeat = prefix.rep ? (this.regs[REG.ECX] >>> 0) : 1;
    let iterations = 0;
    while (iterations < repeat) {
      switch (op) {
        case 0xa4: // movsb
        case 0xa5: {
          const val = width === 8 ? this.mem.read8(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : width === 16 ? this.mem.read16(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : this.mem.read32(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds"));
          if (width === 8) this.mem.write8(this._applySeg(this.regs[REG.EDI], "es"), val);
          else if (width === 16) this.mem.write16(this._applySeg(this.regs[REG.EDI], "es"), val);
          else this.mem.write32(this._applySeg(this.regs[REG.EDI], "es"), val);
          this.regs[REG.ESI] = (this.regs[REG.ESI] + direction) >>> 0;
          this.regs[REG.EDI] = (this.regs[REG.EDI] + direction) >>> 0;
          break;
        }
        case 0xa6:
        case 0xa7: {
          const a = width === 8 ? this.mem.read8(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : width === 16 ? this.mem.read16(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : this.mem.read32(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds"));
          const b = width === 8 ? this.mem.read8(this._applySeg(this.regs[REG.EDI], "es")) : width === 16 ? this.mem.read16(this._applySeg(this.regs[REG.EDI], "es")) : this.mem.read32(this._applySeg(this.regs[REG.EDI], "es"));
          this._sub(a, b, width);
          this.regs[REG.ESI] = (this.regs[REG.ESI] + direction) >>> 0;
          this.regs[REG.EDI] = (this.regs[REG.EDI] + direction) >>> 0;
          if (prefix.rep === "rep" && !this.getFlag(FLAGS.ZF)) { iterations++; if (prefix.rep) this.regs[REG.ECX] = (repeat - iterations) >>> 0; return; }
          if (prefix.rep === "repne" && this.getFlag(FLAGS.ZF)) { iterations++; if (prefix.rep) this.regs[REG.ECX] = (repeat - iterations) >>> 0; return; }
          break;
        }
        case 0xaa:
        case 0xab: {
          const val = this.getReg(width, REG.EAX);
          if (width === 8) this.mem.write8(this._applySeg(this.regs[REG.EDI], "es"), val);
          else if (width === 16) this.mem.write16(this._applySeg(this.regs[REG.EDI], "es"), val);
          else this.mem.write32(this._applySeg(this.regs[REG.EDI], "es"), val);
          this.regs[REG.EDI] = (this.regs[REG.EDI] + direction) >>> 0;
          break;
        }
        case 0xac:
        case 0xad: {
          const val = width === 8 ? this.mem.read8(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : width === 16 ? this.mem.read16(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds")) : this.mem.read32(this._applySeg(this.regs[REG.ESI], prefix.seg ?? "ds"));
          this.setReg(width, REG.EAX, val);
          this.regs[REG.ESI] = (this.regs[REG.ESI] + direction) >>> 0;
          break;
        }
        case 0xae:
        case 0xaf: {
          const val = width === 8 ? this.mem.read8(this._applySeg(this.regs[REG.EDI], "es")) : width === 16 ? this.mem.read16(this._applySeg(this.regs[REG.EDI], "es")) : this.mem.read32(this._applySeg(this.regs[REG.EDI], "es"));
          this._sub(this.getReg(width, REG.EAX), val, width);
          this.regs[REG.EDI] = (this.regs[REG.EDI] + direction) >>> 0;
          if (prefix.rep === "rep" && !this.getFlag(FLAGS.ZF)) { iterations++; if (prefix.rep) this.regs[REG.ECX] = (repeat - iterations) >>> 0; return; }
          if (prefix.rep === "repne" && this.getFlag(FLAGS.ZF)) { iterations++; if (prefix.rep) this.regs[REG.ECX] = (repeat - iterations) >>> 0; return; }
          break;
        }
      }
      iterations++;
    }
    if (prefix.rep) this.regs[REG.ECX] = 0;
  }

  handleFPU(op, at, prefix) {
    const b = this.mem.read8exec(this.eip);
    // Register-only x87 encodings that are common in libc start-up and math fallbacks.
    if (op === 0xd9 && b >= 0xc0) {
      this.eip = (this.eip + 1) >>> 0;
      if (b >= 0xc0 && b <= 0xc7) { this._fpuPush(this._fpuPeek(b & 7)); return; } // fld st(i)
      if (b >= 0xc8 && b <= 0xcf) { const i = b & 7; const t = this.fpu.stack[0] ?? 0; this.fpu.stack[0] = this.fpu.stack[i] ?? 0; this.fpu.stack[i] = t; return; } // fxch
      if (b === 0xe8) { this._fpuPush(1); return; } // fld1
      if (b === 0xee) { this._fpuPush(0); return; } // fldz
      if (b === 0xf0) { this._fpuPush(Math.PI * Math.log10(2)); return; }
      if (b === 0xf1) { this._fpuPush(Math.PI); return; }
      if (b === 0xf5) { this._fpuPush(Math.log10(2)); return; }
      if (b === 0xf8) { this.fpu.stack[0] = Math.sqrt(Math.max(0, this._fpuPeek())); return; }
      return;
    }
    if (op === 0xdf && b === 0xe0) { this.eip = (this.eip + 1) >>> 0; this.setReg(16, REG.EAX, this.fpu.status); return; } // fnstsw ax
    const m = this.decodeModRM(prefix);
    const dv4 = addr => new DataView(this.mem.readBytes(addr, 4).buffer);
    const dv8 = addr => new DataView(this.mem.readBytes(addr, 8).buffer);
    switch (op) {
      case 0xd9:
        if (m.reg === 0) { this._fpuPush(dv4(m.rm.addr).getFloat32(0, true)); return; } // fld m32real
        if (m.reg === 3) { const out = new Uint8Array(4); new DataView(out.buffer).setFloat32(0, this._fpuPop(), true); this.mem.writeBytes(m.rm.addr, out); return; } // fstp m32real
        if (m.reg === 5) { this.fpu.control = this.mem.read16(m.rm.addr); return; } // fldcw
        if (m.reg === 7) { this.mem.write16(m.rm.addr, this.fpu.control); return; } // fnstcw
        break;
      case 0xdb:
        if (m.reg === 0) { this._fpuPush(this.mem.read32s(m.rm.addr)); return; } // fild m32int
        if (m.reg === 3) { this.mem.write32(m.rm.addr, Math.trunc(this._fpuPop()) >>> 0); return; } // fistp m32int
        break;
      case 0xdd:
        if (m.reg === 0) { this._fpuPush(dv8(m.rm.addr).getFloat64(0, true)); return; } // fld m64real
        if (m.reg === 3) { const out = new Uint8Array(8); new DataView(out.buffer).setFloat64(0, this._fpuPop(), true); this.mem.writeBytes(m.rm.addr, out); return; } // fstp m64real
        if (m.reg === 7) { this.mem.write16(m.rm.addr, this.fpu.status); return; } // fnstsw m2byte
        break;
      case 0xdf:
        if (m.reg === 5) { const lo = this.mem.read32(m.rm.addr); const hi = this.mem.read32(m.rm.addr + 4); this._fpuPush(Number(makeBigInt64(lo, hi))); return; } // fild m64int
        if (m.reg === 7) { const v = BigInt(Math.trunc(this._fpuPop())); this.mem.write32(m.rm.addr, lo32FromBigInt(v)); this.mem.write32(m.rm.addr + 4, hi32FromBigInt(v)); return; } // fistp m64int
        break;
      case 0xd8:
      case 0xdc: {
        const rhs = op === 0xd8 ? dv4(m.rm.addr).getFloat32(0, true) : dv8(m.rm.addr).getFloat64(0, true);
        if (m.reg === 0) this.fpu.stack[0] = this._fpuPeek() + rhs; // FADD
        else if (m.reg === 1) this.fpu.stack[0] = this._fpuPeek() * rhs; // FMUL
        else if (m.reg === 2) this._fpuCompare(this._fpuPeek(), rhs); // FCOM
        else if (m.reg === 3) { this._fpuCompare(this._fpuPeek(), rhs); this._fpuPop(); } // FCOMP
        else if (m.reg === 4) this.fpu.stack[0] = this._fpuPeek() - rhs; // FSUB
        else if (m.reg === 5) this.fpu.stack[0] = rhs - this._fpuPeek(); // FSUBR
        else if (m.reg === 6) this.fpu.stack[0] = this._fpuPeek() / rhs; // FDIV
        else if (m.reg === 7) this.fpu.stack[0] = rhs / this._fpuPeek(); // FDIVR
        else throw new CPUError(`Unsupported x87 ${op.toString(16)} /${m.reg} at ${hex32(at)}`);
        return;
      }
    }
    throw new CPUError(`Unsupported x87 ${op.toString(16)} /${m.reg} at ${hex32(at)}`);
  }

  handle0F(op2, at, prefix) {
    const width = prefix.operandSize;
    if (op2 >= 0x80 && op2 <= 0x8f) {
      const rel = sign32(this.fetch32());
      if (this.cond(op2 & 0xf)) this.eip = (this.eip + rel) >>> 0;
      return;
    }
    if (op2 >= 0x90 && op2 <= 0x9f) {
      const m = this.decodeModRM(prefix);
      this.setRM(8, m.rm, this.cond(op2 & 0xf) ? 1 : 0);
      return;
    }
    if (op2 >= 0x40 && op2 <= 0x4f) {
      const m = this.decodeModRM(prefix);
      if (this.cond(op2 & 0xf)) this.setReg(width, m.reg, this.getRM(width, m.rm));
      return;
    }
    if (op2 >= 0xc8 && op2 <= 0xcf) {
      const r = op2 - 0xc8;
      const v = this.regs[r];
      this.regs[r] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
      return;
    }

    switch (op2) {
      case 0x05: { if (!this.syscalls) throw new CPUError("syscall with no syscall layer"); this.syscalls.handle(this); return; }
      case 0x10: case 0x11: case 0x28: case 0x29: {
        const bytes = (prefix.rep === "rep") ? 4 : (prefix.rep === "repne") ? 8 : 16;
        const m = this.decodeModRM(prefix);
        if (op2 === 0x10 || op2 === 0x28) { const src = this._readXmmOperand(m, bytes); this.xmm[m.reg].set(src, 0); }
        else this._writeXmmOperand(m, bytes, this.xmm[m.reg]);
        return;
      }
      case 0x2e: case 0x2f: { // ucomis{s,d}/comis{s,d}
        const bytes = prefix.rep === "repne" ? 8 : 4;
        const m = this.decodeModRM(prefix);
        const a = bytes === 8 ? this._xmmDataView(m.reg).getFloat64(0, true) : this._xmmDataView(m.reg).getFloat32(0, true);
        const bbuf = this._readXmmOperand(m, bytes); const bdv = new DataView(bbuf.buffer, bbuf.byteOffset, bbuf.byteLength);
        const b = bytes === 8 ? bdv.getFloat64(0, true) : bdv.getFloat32(0, true);
        const unordered = Number.isNaN(a) || Number.isNaN(b);
        this.setFlag(FLAGS.ZF, unordered || a === b); this.setFlag(FLAGS.PF, unordered); this.setFlag(FLAGS.CF, unordered || a < b); this.setFlag(FLAGS.OF, false); this.setFlag(FLAGS.SF, false); this.setFlag(FLAGS.AF, false);
        return;
      }
      case 0x57: case 0xef: { const m = this.decodeModRM(prefix); const src = this._readXmmOperand(m, 16); for (let i = 0; i < 16; i++) this.xmm[m.reg][i] ^= src[i]; return; }
      case 0x6e: { const m = this.decodeModRM(prefix); this.xmm[m.reg].fill(0); const v = this.getRM(32, m.rm); new DataView(this.xmm[m.reg].buffer, this.xmm[m.reg].byteOffset, 16).setUint32(0, v, true); return; }
      case 0x7e: { const m = this.decodeModRM(prefix); this.setRM(32, m.rm, new DataView(this.xmm[m.reg].buffer, this.xmm[m.reg].byteOffset, 16).getUint32(0, true)); return; }
      case 0x6f: case 0x7f: { const m = this.decodeModRM(prefix); if (op2 === 0x6f) this.xmm[m.reg].set(this._readXmmOperand(m, 16)); else this._writeXmmOperand(m, 16, this.xmm[m.reg]); return; }
      case 0xae: {
        const m = this.decodeModRM(prefix);
        if (m.reg === 0) { if (m.rm.type !== "mem") return; for (let i = 0; i < 512; i++) this.mem.write8(m.rm.addr + i, 0); this.mem.write16(m.rm.addr, this.fpu.control); this.mem.write32(m.rm.addr + 24, this.mxcsr); return; } // fxsave
        if (m.reg === 1) { if (m.rm.type !== "mem") return; this.fpu.control = this.mem.read16(m.rm.addr); this.mxcsr = this.mem.read32(m.rm.addr + 24); return; } // fxrstor
        if (m.reg === 2) { this.mxcsr = this.mem.read32(m.rm.addr); return; } // ldmxcsr
        if (m.reg === 3) { this.mem.write32(m.rm.addr, this.mxcsr); return; } // stmxcsr
        return; // fences are host-memory ordered in JS execution
      }
      case 0xa4: case 0xa5: { const m = this.decodeModRM(prefix); const count = op2 === 0xa4 ? this.fetch8() : (this.getReg(8, REG.ECX) & 0x1f); if (count) { const dst = this.getRM(width, m.rm); const src = this.getReg(width, m.reg); const r = truncate((dst << count) | (src >>> (width - count)), width); this.setRM(width, m.rm, r); this._setZS(width, r); } return; }
      case 0xac: case 0xad: { const m = this.decodeModRM(prefix); const count = op2 === 0xac ? this.fetch8() : (this.getReg(8, REG.ECX) & 0x1f); if (count) { const dst = this.getRM(width, m.rm); const src = this.getReg(width, m.reg); const r = truncate((dst >>> count) | (src << (width - count)), width); this.setRM(width, m.rm, r); this._setZS(width, r); } return; }
      case 0xb0: { const m = this.decodeModRM(prefix); const dst = this.getRM(8, m.rm); const acc = this.getReg(8, REG.EAX); this._sub(acc, dst, 8); if (acc === dst) this.setRM(8, m.rm, this.getReg(8, m.reg)); else this.setReg(8, REG.EAX, dst); return; }
      case 0xb3: case 0xbb: { const m = this.decodeModRM(prefix); const bit = this.getReg(width, m.reg) & 31; const base = this.getRM(width, m.rm); this.setFlag(FLAGS.CF, ((base >>> bit) & 1) !== 0); this.setRM(width, m.rm, op2 === 0xb3 ? (base & ~(1 << bit)) : (base ^ (1 << bit))); return; }
      case 0xc7: { const m = this.decodeModRM(prefix); if (m.reg !== 1) throw new CPUError(`Unsupported 0F C7 /${m.reg}`); const lo = this.getRM(32, m.rm); const hi = m.rm.type === "mem" ? this.mem.read32(m.rm.addr + 4) : 0; const match = lo === this.regs[REG.EAX] && hi === this.regs[REG.EDX]; this.setFlag(FLAGS.ZF, match); if (match && m.rm.type === "mem") { this.mem.write32(m.rm.addr, this.regs[REG.EBX]); this.mem.write32(m.rm.addr + 4, this.regs[REG.ECX]); } else { this.regs[REG.EAX] = lo; this.regs[REG.EDX] = hi; } return; }
      case 0x1f: { this.decodeModRM(prefix); return; } // multi-byte NOP
      case 0x31: { // rdtsc
        const n = BigInt(Date.now()) * 1000000n;
        this.regs[REG.EAX] = lo32FromBigInt(n);
        this.regs[REG.EDX] = hi32FromBigInt(n);
        return;
      }
      case 0x34: { // sysenter: approximate as Linux syscall entry
        if (!this.syscalls) throw new CPUError("sysenter with no syscall layer");
        this.syscalls.handle(this);
        return;
      }
      case 0xa2: { // cpuid
        const leaf = this.regs[REG.EAX] >>> 0;
        if (leaf === 0) {
          this.regs[REG.EAX] = 1;
          this.regs[REG.EBX] = 0x756e6547; // Genu
          this.regs[REG.EDX] = 0x49656e69; // ineI
          this.regs[REG.ECX] = 0x6c65746e; // ntel
        } else if (leaf === 1) {
          this.regs[REG.EAX] = 0x00000663;
          this.regs[REG.EBX] = 0;
          this.regs[REG.ECX] = 0;
          this.regs[REG.EDX] = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 15) | (1 << 23) | (1 << 24) | (1 << 25) | (1 << 26); // FPU, TSC, CX8, CMOV, MMX, FXSR, SSE, SSE2
        } else {
          this.regs[REG.EAX] = this.regs[REG.EBX] = this.regs[REG.ECX] = this.regs[REG.EDX] = 0;
        }
        return;
      }
      case 0xaf: { // imul r32, r/m32
        const m = this.decodeModRM(prefix);
        const a = BigInt(signExtend(this.getReg(width, m.reg), width));
        const b = BigInt(signExtend(this.getRM(width, m.rm), width));
        const full = a * b;
        const result = Number(BigInt.asUintN(width, full));
        const signExtended = BigInt.asIntN(width, full);
        this.setReg(width, m.reg, result);
        const overflow = signExtended !== full;
        this.setFlag(FLAGS.CF, overflow); this.setFlag(FLAGS.OF, overflow);
        return;
      }
      case 0xb6: case 0xb7: case 0xbe: case 0xbf: {
        const srcWidth = (op2 === 0xb6 || op2 === 0xbe) ? 8 : 16;
        const sign = (op2 === 0xbe || op2 === 0xbf);
        const m = this.decodeModRM(prefix);
        let v = this.getRM(srcWidth, m.rm);
        if (sign) v = signExtend(v, srcWidth);
        this.setReg(width, m.reg, v);
        return;
      }
      case 0xb1: { // cmpxchg r/m32,r32
        const m = this.decodeModRM(prefix);
        const dst = this.getRM(width, m.rm);
        const acc = this.getReg(width, REG.EAX);
        this._sub(acc, dst, width);
        if (acc === dst) this.setRM(width, m.rm, this.getReg(width, m.reg));
        else this.setReg(width, REG.EAX, dst);
        return;
      }
      case 0xc1: { // xadd r/m,r
        const m = this.decodeModRM(prefix);
        const dst = this.getRM(width, m.rm);
        const src = this.getReg(width, m.reg);
        const res = this._add(dst, src, width);
        this.setReg(width, m.reg, dst);
        this.setRM(width, m.rm, res);
        return;
      }
      case 0xbc: case 0xbd: { // bsf/bsr
        const m = this.decodeModRM(prefix);
        const v = this.getRM(width, m.rm);
        if (v === 0) { this.setFlag(FLAGS.ZF, true); }
        else {
          this.setFlag(FLAGS.ZF, false);
          let idx;
          if (op2 === 0xbc) { idx = 0; while (((v >>> idx) & 1) === 0) idx++; }
          else { idx = width - 1; while (((v >>> idx) & 1) === 0) idx--; }
          this.setReg(width, m.reg, idx);
        }
        return;
      }
      case 0xa3: { // bt r/m, r
        const m = this.decodeModRM(prefix);
        const bit = this.getReg(width, m.reg) & 31;
        const base = this.getRM(width, m.rm);
        this.setFlag(FLAGS.CF, ((base >>> bit) & 1) !== 0);
        return;
      }
      case 0xab: { // bts r/m, r
        const m = this.decodeModRM(prefix);
        const bit = this.getReg(width, m.reg) & 31;
        const base = this.getRM(width, m.rm);
        this.setFlag(FLAGS.CF, ((base >>> bit) & 1) !== 0);
        this.setRM(width, m.rm, base | (1 << bit));
        return;
      }
      case 0xba: { // BT/BTS/BTR/BTC r/m, imm8 group
        const m = this.decodeModRM(prefix);
        const bit = this.fetch8() & 31;
        const base = this.getRM(width, m.rm);
        this.setFlag(FLAGS.CF, ((base >>> bit) & 1) !== 0);
        if (m.reg === 4) return; // BT
        if (m.reg === 5) this.setRM(width, m.rm, base | (1 << bit)); // BTS
        else if (m.reg === 6) this.setRM(width, m.rm, base & ~(1 << bit)); // BTR
        else if (m.reg === 7) this.setRM(width, m.rm, base ^ (1 << bit)); // BTC
        else throw new CPUError(`Unsupported 0F BA /${m.reg} at ${hex32(at)}`);
        return;
      }
      default:
        throw new UnsupportedOpcodeError(`0f ${op2.toString(16).padStart(2, "0")}`, at);
    }
  }

  step() {
    const at = this.eip >>> 0;
    const prefix = this.parsePrefixes();
    const op = this.fetch8();
    const width = prefix.operandSize;
    this.steps++;

    if (this.trace) this.logger.log(`${hex32(at)} op=${op.toString(16).padStart(2, "0")} eax=${hex32(this.regs[0])} ebx=${hex32(this.regs[3])} ecx=${hex32(this.regs[1])} edx=${hex32(this.regs[2])} esp=${hex32(this.regs[4])}`);

    if ((op >= 0x00 && op <= 0x3d) && ((op & 0x07) <= 5) && ![0x06,0x07,0x0e,0x0f,0x16,0x17,0x1e,0x1f,0x26,0x27,0x2e,0x2f,0x36,0x37,0x3e,0x3f].includes(op)) {
      const kind = op >>> 3;
      const form = op & 7;
      if (form === 0 || form === 1) {
        const w = form === 0 ? 8 : width;
        const m = this.decodeModRM(prefix);
        const r = this.alu(kind, this.getRM(w, m.rm), this.getReg(w, m.reg), w);
        if (kind !== 7) this.setRM(w, m.rm, r);
        return;
      }
      if (form === 2 || form === 3) {
        const w = form === 2 ? 8 : width;
        const m = this.decodeModRM(prefix);
        const r = this.alu(kind, this.getReg(w, m.reg), this.getRM(w, m.rm), w);
        if (kind !== 7) this.setReg(w, m.reg, r);
        return;
      }
      if (form === 4 || form === 5) {
        const w = form === 4 ? 8 : width;
        const imm = this.fetchImm(w);
        const r = this.alu(kind, this.getReg(w, REG.EAX), imm, w);
        if (kind !== 7) this.setReg(w, REG.EAX, r);
        return;
      }
    }

    if (op >= 0x40 && op <= 0x47) { const r = op - 0x40; const oldCF = this.getFlag(FLAGS.CF); this.setReg(width, r, this._add(this.getReg(width, r), 1, width)); this.setFlag(FLAGS.CF, oldCF); return; }
    if (op >= 0x48 && op <= 0x4f) { const r = op - 0x48; const oldCF = this.getFlag(FLAGS.CF); this.setReg(width, r, this._sub(this.getReg(width, r), 1, width)); this.setFlag(FLAGS.CF, oldCF); return; }
    if (op >= 0x50 && op <= 0x57) { this.push(this.getReg(width, op - 0x50), width); return; }
    if (op >= 0x58 && op <= 0x5f) { this.setReg(width, op - 0x58, this.pop(width)); return; }
    if (op >= 0x70 && op <= 0x7f) { const rel = s8(this.fetch8()); if (this.cond(op & 0xf)) this.eip = (this.eip + rel) >>> 0; return; }
    if (op >= 0x90 && op <= 0x97) { if (op !== 0x90) { const r = op - 0x90; const tmp = this.regs[REG.EAX]; this.regs[REG.EAX] = this.regs[r]; this.regs[r] = tmp; } return; }
    if (op >= 0xb0 && op <= 0xb7) { this.setReg(8, op - 0xb0, this.fetch8()); return; }
    if (op >= 0xb8 && op <= 0xbf) { this.setReg(width, op - 0xb8, this.fetchImm(width)); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.handleFPU(op, at, prefix); return; }

    switch (op) {
      case 0x06: case 0x0e: case 0x16: case 0x1e: this.push(0, width); return; // segment push: compatibility placeholder
      case 0x07: case 0x17: case 0x1f: this.pop(width); return; // segment pop ignored
      case 0x60: { const esp = this.regs[REG.ESP]; for (const r of [REG.EAX, REG.ECX, REG.EDX, REG.EBX]) this.push(this.regs[r], 32); this.push(esp, 32); for (const r of [REG.EBP, REG.ESI, REG.EDI]) this.push(this.regs[r], 32); return; }
      case 0x61: { for (const r of [REG.EDI, REG.ESI, REG.EBP]) this.regs[r] = this.pop32(); this.regs[REG.ESP] = (this.regs[REG.ESP] + 4) >>> 0; for (const r of [REG.EBX, REG.EDX, REG.ECX, REG.EAX]) this.regs[r] = this.pop32(); return; }
      case 0x68: this.push(this.fetchImm(width), width); return;
      case 0x69: case 0x6b: {
        const m = this.decodeModRM(prefix);
        const imm = op === 0x69 ? this.fetchSignedImm(width) : s8(this.fetch8());
        const full = BigInt(signExtend(this.getRM(width, m.rm), width)) * BigInt(imm);
        const result = Number(BigInt.asUintN(width, full));
        this.setReg(width, m.reg, result);
        const overflow = BigInt.asIntN(width, full) !== full;
        this.setFlag(FLAGS.CF, overflow); this.setFlag(FLAGS.OF, overflow);
        return;
      }
      case 0x6a: this.push(s8(this.fetch8()) >>> 0, width); return;
      case 0x80: case 0x82: case 0x81: case 0x83: {
        const w = (op === 0x80 || op === 0x82) ? 8 : width;
        const m = this.decodeModRM(prefix);
        const imm = op === 0x81 ? this.fetchImm(w) : (op === 0x83 ? signExtend(this.fetch8(), 8) : this.fetch8());
        this.executeGroup1(w, m.reg, this.getRM(w, m.rm), imm, r => this.setRM(w, m.rm, r));
        return;
      }
      case 0x84: case 0x85: { const w = op === 0x84 ? 8 : width; const m = this.decodeModRM(prefix); this._logic(this.getRM(w, m.rm) & this.getReg(w, m.reg), w); return; }
      case 0x86: case 0x87: { const w = op === 0x86 ? 8 : width; const m = this.decodeModRM(prefix); const a = this.getRM(w, m.rm); const b = this.getReg(w, m.reg); this.setRM(w, m.rm, b); this.setReg(w, m.reg, a); return; }
      case 0x88: { const m = this.decodeModRM(prefix); this.setRM(8, m.rm, this.getReg(8, m.reg)); return; }
      case 0x89: { const m = this.decodeModRM(prefix); this.setRM(width, m.rm, this.getReg(width, m.reg)); return; }
      case 0x8a: { const m = this.decodeModRM(prefix); this.setReg(8, m.reg, this.getRM(8, m.rm)); return; }
      case 0x8b: { const m = this.decodeModRM(prefix); this.setReg(width, m.reg, this.getRM(width, m.rm)); return; }
      case 0x8c: { const m = this.decodeModRM(prefix); const segNames = ["es", "cs", "ss", "ds", "fs", "gs"]; this.setRM(16, m.rm, this.sregs[segNames[m.reg] ?? "ds"] ?? 0); return; }
      case 0x8d: { const m = this.decodeModRM(prefix); if (m.rm.type !== "mem") throw new CPUError(`LEA with register at ${hex32(at)}`); this.setReg(width, m.reg, m.rm.rawAddr); return; }
      case 0x8e: { const m = this.decodeModRM(prefix); const segNames = ["es", "cs", "ss", "ds", "fs", "gs"]; const name = segNames[m.reg]; if (name) this.sregs[name] = this.getRM(16, m.rm); return; }
      case 0x8f: { const m = this.decodeModRM(prefix); if (m.reg !== 0) throw new CPUError(`Unsupported 8F /${m.reg}`); this.setRM(width, m.rm, this.pop(width)); return; }
      case 0x98: { if (width === 16) this.setReg(16, REG.EAX, s8(this.getReg(8, REG.EAX)) & 0xffff); else this.regs[REG.EAX] = s16(this.regs[REG.EAX]) >>> 0; return; }
      case 0x99: { if (width === 16) this.setReg(16, REG.EDX, (this.getReg(16, REG.EAX) & 0x8000) ? 0xffff : 0); else this.regs[REG.EDX] = (this.regs[REG.EAX] & 0x80000000) ? 0xffffffff : 0; return; }
      case 0x9b: return; // fwait
      case 0x9c: this.push(this.eflags, width); return;
      case 0x9d: this.eflags = (this.pop(width) | 0x2) >>> 0; return;
      case 0x9e: { const ah = this.getReg(8, 4); this.setFlag(FLAGS.SF, ah & 0x80); this.setFlag(FLAGS.ZF, ah & 0x40); this.setFlag(FLAGS.AF, ah & 0x10); this.setFlag(FLAGS.PF, ah & 0x04); this.setFlag(FLAGS.CF, ah & 0x01); return; }
      case 0x9f: { let ah = 0x02; if (this.getFlag(FLAGS.SF)) ah |= 0x80; if (this.getFlag(FLAGS.ZF)) ah |= 0x40; if (this.getFlag(FLAGS.AF)) ah |= 0x10; if (this.getFlag(FLAGS.PF)) ah |= 0x04; if (this.getFlag(FLAGS.CF)) ah |= 0x01; this.setReg(8, 4, ah); return; }
      case 0xa0: { const addr = this._applySeg(this.fetch32(), prefix.seg ?? "ds"); this.setReg(8, REG.EAX, this.mem.read8(addr)); return; }
      case 0xa1: { const addr = this._applySeg(this.fetch32(), prefix.seg ?? "ds"); this.setReg(width, REG.EAX, width === 16 ? this.mem.read16(addr) : this.mem.read32(addr)); return; }
      case 0xa2: { const addr = this._applySeg(this.fetch32(), prefix.seg ?? "ds"); this.mem.write8(addr, this.getReg(8, REG.EAX)); return; }
      case 0xa3: { const addr = this._applySeg(this.fetch32(), prefix.seg ?? "ds"); if (width === 16) this.mem.write16(addr, this.getReg(16, REG.EAX)); else this.mem.write32(addr, this.regs[REG.EAX]); return; }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf: this.handleStringOp(op, prefix); return;
      case 0xa8: this._logic(this.getReg(8, REG.EAX) & this.fetch8(), 8); return;
      case 0xa9: this._logic(this.getReg(width, REG.EAX) & this.fetchImm(width), width); return;
      case 0xc0: case 0xc1: { const w = op === 0xc0 ? 8 : width; const m = this.decodeModRM(prefix); const count = this.fetch8(); this.setRM(w, m.rm, this.shiftRotate(w, m.reg, this.getRM(w, m.rm), count)); return; }
      case 0xc2: { const imm = this.fetch16(); this.eip = this.pop(width); this.regs[REG.ESP] = (this.regs[REG.ESP] + imm) >>> 0; return; }
      case 0xc3: this.eip = this.pop(width); return;
      case 0xc6: case 0xc7: { const w = op === 0xc6 ? 8 : width; const m = this.decodeModRM(prefix); if (m.reg !== 0) throw new CPUError(`Unsupported ${op.toString(16)} /${m.reg}`); this.setRM(w, m.rm, this.fetchImm(w)); return; }
      case 0xc8: { const frameSize = this.fetch16(); const nesting = this.fetch8(); this.push(this.regs[REG.EBP], width); const frameTemp = this.regs[REG.ESP]; for (let i = 1; i < (nesting & 31); i++) { this.regs[REG.EBP] = (this.regs[REG.EBP] - (width/8)) >>> 0; this.push(width === 16 ? this.mem.read16(this.regs[REG.EBP]) : this.mem.read32(this.regs[REG.EBP]), width); } if (nesting) this.push(frameTemp, width); this.regs[REG.EBP] = frameTemp; this.regs[REG.ESP] = (this.regs[REG.ESP] - frameSize) >>> 0; return; }
      case 0xc9: this.regs[REG.ESP] = this.regs[REG.EBP]; this.regs[REG.EBP] = this.pop(width); return;
      case 0xcc: throw new CPUError(`INT3 breakpoint at ${hex32(at)}`);
      case 0xcd: { const imm = this.fetch8(); if (imm !== 0x80) throw new CPUError(`Unsupported interrupt ${imm} at ${hex32(at)}`); if (!this.syscalls) throw new CPUError("int 0x80 with no syscall layer"); this.syscalls.handle(this); return; }
      case 0xce: if (this.getFlag(FLAGS.OF)) throw new CPUError(`INTO trap at ${hex32(at)}`); return;
      case 0xd0: case 0xd1: { const w = op === 0xd0 ? 8 : width; const m = this.decodeModRM(prefix); this.setRM(w, m.rm, this.shiftRotate(w, m.reg, this.getRM(w, m.rm), 1)); return; }
      case 0xd2: case 0xd3: { const w = op === 0xd2 ? 8 : width; const m = this.decodeModRM(prefix); this.setRM(w, m.rm, this.shiftRotate(w, m.reg, this.getRM(w, m.rm), this.getReg(8, REG.ECX))); return; }
      case 0xe0: { const rel = s8(this.fetch8()); this.regs[REG.ECX] = (this.regs[REG.ECX] - 1) >>> 0; if (this.regs[REG.ECX] !== 0 && this.getFlag(FLAGS.ZF)) this.eip = (this.eip + rel) >>> 0; return; }
      case 0xe1: { const rel = s8(this.fetch8()); this.regs[REG.ECX] = (this.regs[REG.ECX] - 1) >>> 0; if (this.regs[REG.ECX] !== 0 && !this.getFlag(FLAGS.ZF)) this.eip = (this.eip + rel) >>> 0; return; }
      case 0xe2: { const rel = s8(this.fetch8()); this.regs[REG.ECX] = (this.regs[REG.ECX] - 1) >>> 0; if (this.regs[REG.ECX] !== 0) this.eip = (this.eip + rel) >>> 0; return; }
      case 0xe3: { const rel = s8(this.fetch8()); if (this.regs[REG.ECX] === 0) this.eip = (this.eip + rel) >>> 0; return; }
      case 0xe8: { const rel = sign32(this.fetch32()); this.push(this.eip, width); this.eip = (this.eip + rel) >>> 0; return; }
      case 0xe9: { const rel = sign32(this.fetch32()); this.eip = (this.eip + rel) >>> 0; return; }
      case 0xeb: { const rel = s8(this.fetch8()); this.eip = (this.eip + rel) >>> 0; return; }
      case 0xf4: throw new CPUError(`HLT at ${hex32(at)}`);
      case 0xf5: this.setFlag(FLAGS.CF, !this.getFlag(FLAGS.CF)); return;
      case 0xf6: case 0xf7: {
        const w = op === 0xf6 ? 8 : width;
        const m = this.decodeModRM(prefix);
        const val = this.getRM(w, m.rm);
        switch (m.reg) {
          case 0: this._logic(val & this.fetchImm(w), w); return;
          case 2: this.setRM(w, m.rm, (~val) & maskFor(w)); return;
          case 3: this.setRM(w, m.rm, this._sub(0, val, w)); return;
          case 4: { // mul unsigned accumulator
            if (w === 8) { const r = this.getReg(8, REG.EAX) * val; this.setReg(16, REG.EAX, r); this.setFlag(FLAGS.CF, r > 0xff); this.setFlag(FLAGS.OF, r > 0xff); }
            else if (w === 16) { const r = this.getReg(16, REG.EAX) * val; this.setReg(16, REG.EAX, r); this.setReg(16, REG.EDX, r >>> 16); this.setFlag(FLAGS.CF, r > 0xffff); this.setFlag(FLAGS.OF, r > 0xffff); }
            else { const r = BigInt(this.regs[REG.EAX]) * BigInt(val >>> 0); this.regs[REG.EAX] = lo32FromBigInt(r); this.regs[REG.EDX] = hi32FromBigInt(r); const high = this.regs[REG.EDX] !== 0; this.setFlag(FLAGS.CF, high); this.setFlag(FLAGS.OF, high); }
            return;
          }
          case 5: { // imul accumulator
            if (w === 8) { const r = BigInt(s8(this.getReg(8, REG.EAX))) * BigInt(s8(val)); const nr = Number(BigInt.asUintN(16, r)); this.setReg(16, REG.EAX, nr); const ov = BigInt.asIntN(8, r) !== r; this.setFlag(FLAGS.CF, ov); this.setFlag(FLAGS.OF, ov); }
            else if (w === 16) { const r = BigInt(s16(this.getReg(16, REG.EAX))) * BigInt(s16(val)); const nr = Number(BigInt.asUintN(32, r)); this.setReg(16, REG.EAX, nr); this.setReg(16, REG.EDX, nr >>> 16); const ov = BigInt.asIntN(16, r) !== r; this.setFlag(FLAGS.CF, ov); this.setFlag(FLAGS.OF, ov); }
            else { const r = BigInt(this.regs[REG.EAX] >> 0) * BigInt(val >> 0); this.regs[REG.EAX] = lo32FromBigInt(r); this.regs[REG.EDX] = hi32FromBigInt(r); const ov = BigInt.asIntN(32, r) !== r; this.setFlag(FLAGS.CF, ov); this.setFlag(FLAGS.OF, ov); }
            return;
          }
          case 6: case 7: { // div/idiv
            const signed = m.reg === 7;
            if (w === 8) {
              const dividend = this.getReg(16, REG.EAX);
              const divisor = val & 0xff;
              if (divisor === 0) throw new CPUError("divide by zero");
              if (!signed) { const q = Math.floor(dividend / divisor), r = dividend % divisor; if (q > 0xff) throw new CPUError("divide overflow"); this.setReg(8, REG.EAX, q); this.setReg(8, 4, r); }
              else { const q = Math.trunc(s16(dividend) / s8(divisor)), r = s16(dividend) % s8(divisor); if (q < -128 || q > 127) throw new CPUError("idiv overflow"); this.setReg(8, REG.EAX, q); this.setReg(8, 4, r); }
            } else if (w === 32) {
              const divisor = BigInt(signed ? (val >> 0) : (val >>> 0)); if (divisor === 0n) throw new CPUError("divide by zero");
              const dividend = signed ? makeBigInt64(this.regs[REG.EAX], this.regs[REG.EDX]) : makeBigUint64(this.regs[REG.EAX], this.regs[REG.EDX]);
              const q = dividend / divisor; const r = dividend % divisor;
              if ((!signed && (q < 0n || q > 0xffffffffn)) || (signed && (q < -0x80000000n || q > 0x7fffffffn))) throw new CPUError("divide overflow");
              this.regs[REG.EAX] = lo32FromBigInt(q); this.regs[REG.EDX] = lo32FromBigInt(r);
            } else {
              const dividend = ((this.getReg(16, REG.EDX) << 16) | this.getReg(16, REG.EAX)) >>> 0;
              const divisor = val & 0xffff; if (divisor === 0) throw new CPUError("divide by zero");
              if (!signed) { const q = Math.floor(dividend / divisor), r = dividend % divisor; if (q > 0xffff) throw new CPUError("divide overflow"); this.setReg(16, REG.EAX, q); this.setReg(16, REG.EDX, r); }
              else { const q = Math.trunc((dividend >> 0) / s16(divisor)), r = (dividend >> 0) % s16(divisor); if (q < -32768 || q > 32767) throw new CPUError("idiv overflow"); this.setReg(16, REG.EAX, q); this.setReg(16, REG.EDX, r); }
            }
            return;
          }
          default: throw new CPUError(`Unsupported F6/F7 /${m.reg}`);
        }
      }
      case 0xf8: this.setFlag(FLAGS.CF, false); return;
      case 0xf9: this.setFlag(FLAGS.CF, true); return;
      case 0xfa: this.setFlag(FLAGS.IF, false); return;
      case 0xfb: this.setFlag(FLAGS.IF, true); return;
      case 0xfc: this.setFlag(FLAGS.DF, false); return;
      case 0xfd: this.setFlag(FLAGS.DF, true); return;
      case 0xfe: { const m = this.decodeModRM(prefix); const oldCF = this.getFlag(FLAGS.CF); if (m.reg === 0) this.setRM(8, m.rm, this._add(this.getRM(8, m.rm), 1, 8)); else if (m.reg === 1) this.setRM(8, m.rm, this._sub(this.getRM(8, m.rm), 1, 8)); else throw new CPUError(`Unsupported FE /${m.reg}`); this.setFlag(FLAGS.CF, oldCF); return; }
      case 0xff: { const m = this.decodeModRM(prefix); switch (m.reg) { case 0: { const oldCF = this.getFlag(FLAGS.CF); this.setRM(width, m.rm, this._add(this.getRM(width, m.rm), 1, width)); this.setFlag(FLAGS.CF, oldCF); return; } case 1: { const oldCF = this.getFlag(FLAGS.CF); this.setRM(width, m.rm, this._sub(this.getRM(width, m.rm), 1, width)); this.setFlag(FLAGS.CF, oldCF); return; } case 2: { const target = this.getRM(width, m.rm); this.push(this.eip, width); this.eip = target >>> 0; return; } case 4: this.eip = this.getRM(width, m.rm) >>> 0; return; case 6: this.push(this.getRM(width, m.rm), width); return; default: throw new CPUError(`Unsupported FF /${m.reg}`); } }
      case 0x0f: this.handle0F(this.fetch8(), at, prefix); return;
      default: throw new UnsupportedOpcodeError(`0x${op.toString(16).padStart(2, "0")}`, at);
    }
  }

  run(maxSteps = 1_000_000) {
    while (this.steps < maxSteps) this.step();
    throw new CPUError(`Step limit reached (${maxSteps})`);
  }

  dumpRegs() {
    return Object.fromEntries(REG_NAMES.map((name, i) => [name, this.regs[i] >>> 0]).concat([["eip", this.eip >>> 0], ["eflags", this.eflags >>> 0], ["fsBase", this.segBase.fs >>> 0], ["gsBase", this.segBase.gs >>> 0]]));
  }
}
