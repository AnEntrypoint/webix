import { PagedMemory, PERM } from "./memory.js";
import { alignDown, alignUp, stringToBytes } from "./util.js";

export class ELFError extends Error {}

const PT_LOAD = 1, PT_DYNAMIC = 2, PT_INTERP = 3, PT_PHDR = 6;
const ET_EXEC = 2, ET_DYN = 3;
const DT_NULL = 0, DT_HASH = 4, DT_STRTAB = 5, DT_SYMTAB = 6, DT_PLTRELSZ = 2, DT_JMPREL = 23, DT_REL = 17, DT_RELSZ = 18, DT_RELENT = 19;
const R_386_NONE = 0, R_386_32 = 1, R_386_PC32 = 2, R_386_GLOB_DAT = 6, R_386_JMP_SLOT = 7, R_386_RELATIVE = 8;
const PF_X = 1, PF_W = 2, PF_R = 4;

function asU8(bytes) { return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); }
function viewOf(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }
function readString(u8, off, len) {
  let end = off;
  while (end < off + len && u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(off, end));
}
function flagsToPerm(flags) {
  let p = 0;
  if (flags & PF_R) p |= PERM.R;
  if (flags & PF_W) p |= PERM.W;
  if (flags & PF_X) p |= PERM.X;
  return p || PERM.R;
}

export function parseELF32(bytes) {
  const u8 = asU8(bytes);
  const dv = viewOf(u8);
  if (u8.length < 52 || u8[0] !== 0x7f || u8[1] !== 0x45 || u8[2] !== 0x4c || u8[3] !== 0x46) throw new ELFError("Not an ELF file");
  if (u8[4] !== 1) throw new ELFError("Only ELFCLASS32 is supported");
  if (u8[5] !== 1) throw new ELFError("Only little-endian ELF is supported");
  if (dv.getUint16(18, true) !== 3) throw new ELFError("Only EM_386/i386 ELF files are supported");
  const header = {
    type: dv.getUint16(16, true), machine: dv.getUint16(18, true), version: dv.getUint32(20, true), entry: dv.getUint32(24, true),
    phoff: dv.getUint32(28, true), shoff: dv.getUint32(32, true), flags: dv.getUint32(36, true), ehsize: dv.getUint16(40, true),
    phentsize: dv.getUint16(42, true), phnum: dv.getUint16(44, true), shentsize: dv.getUint16(46, true), shnum: dv.getUint16(48, true), shstrndx: dv.getUint16(50, true),
  };
  const ph = [];
  for (let i = 0; i < header.phnum; i++) {
    const off = header.phoff + i * header.phentsize;
    ph.push({
      type: dv.getUint32(off + 0, true), offset: dv.getUint32(off + 4, true), vaddr: dv.getUint32(off + 8, true), paddr: dv.getUint32(off + 12, true),
      filesz: dv.getUint32(off + 16, true), memsz: dv.getUint32(off + 20, true), flags: dv.getUint32(off + 24, true), align: dv.getUint32(off + 28, true),
    });
  }
  return { bytes: u8, header, ph };
}

export function loadELF32Image(bytes, options = {}) {
  const elf = parseELF32(bytes);
  const mem = options.memory ?? new PagedMemory();
  const pageSize = mem.pageSize;
  const name = options.name ?? "[elf]";
  const loadBias = elf.header.type === ET_DYN ? (options.loadBias ?? 0x56555000) >>> 0 : (options.loadBias ?? 0) >>> 0;
  if (![ET_EXEC, ET_DYN].includes(elf.header.type)) throw new ELFError(`Unsupported ELF type ${elf.header.type}`);

  let minVaddr = 0xffffffff, maxVaddr = 0, interp = null, dynamicAddr = 0, phdrAddr = 0;
  for (const p of elf.ph) {
    if (p.type === PT_INTERP) interp = readString(elf.bytes, p.offset, p.filesz);
    if (p.type === PT_LOAD) {
      minVaddr = Math.min(minVaddr, p.vaddr);
      maxVaddr = Math.max(maxVaddr, p.vaddr + p.memsz);
      const segStart = alignDown((loadBias + p.vaddr) >>> 0, pageSize);
      const segEnd = alignUp((loadBias + p.vaddr + p.memsz) >>> 0, pageSize);
      const perm = flagsToPerm(p.flags);
      mem.map(segStart, segEnd - segStart, PERM.RW | PERM.X, name);
      if (p.filesz > 0) mem.writeBytes((loadBias + p.vaddr) >>> 0, elf.bytes.subarray(p.offset, p.offset + p.filesz));
      if (p.memsz > p.filesz) {
        const start = (loadBias + p.vaddr + p.filesz) >>> 0;
        for (let a = start; a < (loadBias + p.vaddr + p.memsz) >>> 0; a++) mem.write8(a, 0);
      }
      mem.protect(segStart, segEnd - segStart, perm);
    }
    if (p.type === PT_DYNAMIC) dynamicAddr = (loadBias + p.vaddr) >>> 0;
    if (p.type === PT_PHDR) phdrAddr = (loadBias + p.vaddr) >>> 0;
  }
  if (!phdrAddr) phdrAddr = (loadBias + elf.header.phoff) >>> 0;
  const entry = (loadBias + elf.header.entry) >>> 0;
  const image = {
    memory: mem,
    elf,
    entry,
    base: loadBias,
    type: elf.header.type,
    phdrAddr,
    phent: elf.header.phentsize,
    phnum: elf.header.phnum,
    interp,
    dynamicAddr,
    minAddr: (loadBias + minVaddr) >>> 0,
    maxAddr: (loadBias + maxVaddr) >>> 0,
    brk: alignUp((loadBias + maxVaddr) >>> 0, pageSize),
    name,
  };
  if (dynamicAddr && options.applyRelocations !== false) applyELF32Relocations(image);
  return image;
}

export function loadFlatBinary(bytes, loadAddress = 0x08048000, options = {}) {
  const u8 = asU8(bytes);
  const mem = options.memory ?? new PagedMemory();
  mem.loadBytes(loadAddress >>> 0, u8, options.perm ?? (PERM.R | PERM.X), options.name ?? "[flat]");
  return { memory: mem, entry: loadAddress >>> 0, base: loadAddress >>> 0, phdrAddr: 0, phent: 0, phnum: 0, interp: null, brk: alignUp(loadAddress + u8.length, mem.pageSize), name: options.name ?? "[flat]" };
}

export function setupInitialStack(cpu, options = {}) {
  const stackTop = options.stackTop ?? 0xbffff000;
  const argv = options.argv ?? [options.execPath ?? "emulated"];
  const env = options.env ?? { PATH: "/bin:/usr/bin", HOME: "/home/user", USER: "user", SHELL: "/bin/sh", TERM: "xterm" };
  const auxv = options.auxv ?? [];
  let sp = stackTop >>> 0;
  const putBytes = bytes => { sp = (sp - bytes.length) >>> 0; cpu.mem.writeBytes(sp, bytes); return sp; };
  const putString = s => putBytes(stringToBytes(s + "\0"));

  const randomBytes = new Uint8Array(16);
  for (let i = 0; i < randomBytes.length; i++) randomBytes[i] = (Math.random() * 256) | 0;
  const randomPtr = putBytes(randomBytes);
  const platformPtr = putString("i686");
  const execfnPtr = putString(argv[0] ?? "emulated");

  const argPtrs = [];
  for (let i = argv.length - 1; i >= 0; i--) argPtrs.unshift(putString(argv[i]));
  const envPairs = Array.isArray(env) ? env : Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const envPtrs = [];
  for (let i = envPairs.length - 1; i >= 0; i--) envPtrs.unshift(putString(envPairs[i]));

  sp &= ~0xf;
  cpu.regs[4] = sp >>> 0;
  const defaultAux = [
    [3, options.phdrAddr ?? 0], [4, options.phent ?? 32], [5, options.phnum ?? 0], [6, cpu.mem.pageSize], [7, options.base ?? 0], [8, 0], [9, options.entry ?? cpu.eip],
    [11, options.uid ?? 1000], [12, options.uid ?? 1000], [13, options.gid ?? 1000], [14, options.gid ?? 1000], [17, 100], [25, randomPtr], [15, platformPtr], [31, execfnPtr],
  ];
  const allAux = [...auxv, ...defaultAux, [0, 0]];
  for (let i = allAux.length - 1; i >= 0; i--) { cpu.push32(allAux[i][1]); cpu.push32(allAux[i][0]); }
  cpu.push32(0);
  for (let i = envPtrs.length - 1; i >= 0; i--) cpu.push32(envPtrs[i]);
  cpu.push32(0);
  for (let i = argPtrs.length - 1; i >= 0; i--) cpu.push32(argPtrs[i]);
  cpu.push32(argPtrs.length);
  return cpu.regs[4];
}

export function loadELF32Process(bytes, options = {}) {
  const mem = options.memory ?? new PagedMemory();
  const main = loadELF32Image(bytes, { memory: mem, name: options.execPath ?? "[program]", loadBias: options.loadBias });
  let entry = main.entry;
  let interp = null;
  let base = 0;
  if (main.interp && options.vfs) {
    try {
      const interpBytes = options.vfs.readFile(main.interp);
      interp = loadELF32Image(interpBytes, { memory: mem, name: main.interp, loadBias: options.interpLoadBias ?? 0xf7dd0000 });
      entry = interp.entry;
      base = interp.base;
    } catch (e) {
      if (!options.ignoreMissingInterp) throw new ELFError(`ELF requests interpreter ${main.interp}, but it is not mounted in the VFS`);
    }
  }
  const stackTop = options.stackTop ?? 0xbffff000;
  const stackSize = options.stackSize ?? 8 * 1024 * 1024;
  mem.map((stackTop - stackSize) >>> 0, stackSize, PERM.RW, "[stack]");
  return { memory: mem, main, interp, entry, base, brk: main.brk, stackTop, stackSize };
}

export const ELF_DYNAMIC_TAG = Object.freeze({
  NULL: 0, NEEDED: 1, PLTRELSZ: 2, PLTGOT: 3, HASH: 4, STRTAB: 5, SYMTAB: 6, RELA: 7, RELASZ: 8, RELAENT: 9,
  STRSZ: 10, SYMENT: 11, INIT: 12, FINI: 13, SONAME: 14, RPATH: 15, SYMBOLIC: 16, REL: 17, RELSZ: 18, RELENT: 19,
  PLTREL: 20, DEBUG: 21, TEXTREL: 22, JMPREL: 23, BIND_NOW: 24, FLAGS: 30,
});
export const R_386 = Object.freeze({ NONE: 0, _32: 1, PC32: 2, GLOB_DAT: 6, JMP_SLOT: 7, RELATIVE: 8, R_386_32: 1, R_386_PC32: 2, R_386_GLOB_DAT: 6, R_386_JMP_SLOT: 7, R_386_RELATIVE: 8 });

function vaddrToOffset(elf, vaddr) {
  for (const p of elf.ph) {
    if (p.type !== PT_LOAD) continue;
    if (vaddr >= p.vaddr && vaddr < p.vaddr + p.filesz) return p.offset + (vaddr - p.vaddr);
  }
  return null;
}
function dynString(elf, strtab, off) {
  const fileOff = vaddrToOffset(elf, strtab + off);
  if (fileOff === null) return "";
  return readString(elf.bytes, fileOff, elf.bytes.length - fileOff);
}

export function parseELF32DynamicInfo(bytesOrElf) {
  const elf = bytesOrElf?.header ? bytesOrElf : parseELF32(bytesOrElf);
  const dynPh = elf.ph.find(p => p.type === PT_DYNAMIC);
  if (!dynPh) return { entries: [], needed: [], rel: [], rela: [], jmprel: [], strtab: 0, symtab: 0, syment: 16 };
  const dv = viewOf(elf.bytes);
  const entries = [];
  for (let off = dynPh.offset; off + 8 <= dynPh.offset + dynPh.filesz; off += 8) {
    const tag = dv.getInt32(off, true), val = dv.getUint32(off + 4, true);
    entries.push({ tag, val });
    if (tag === 0) break;
  }
  const get = tag => entries.find(e => e.tag === tag)?.val ?? 0;
  const all = tag => entries.filter(e => e.tag === tag).map(e => e.val);
  const strtab = get(ELF_DYNAMIC_TAG.STRTAB);
  const rel = [];
  const relAddr = get(ELF_DYNAMIC_TAG.REL), relSize = get(ELF_DYNAMIC_TAG.RELSZ), relEnt = get(ELF_DYNAMIC_TAG.RELENT) || 8;
  const relOff = relAddr ? vaddrToOffset(elf, relAddr) : null;
  if (relOff !== null) for (let off = relOff; off + relEnt <= relOff + relSize; off += relEnt) rel.push({ offset: dv.getUint32(off, true), info: dv.getUint32(off + 4, true), type: dv.getUint32(off + 4, true) & 0xff, sym: dv.getUint32(off + 4, true) >>> 8, addend: null });
  const jmprel = [];
  const jmpAddr = get(ELF_DYNAMIC_TAG.JMPREL), jmpSize = get(ELF_DYNAMIC_TAG.PLTRELSZ), jmpOff = jmpAddr ? vaddrToOffset(elf, jmpAddr) : null;
  if (jmpOff !== null) for (let off = jmpOff; off + 8 <= jmpOff + jmpSize; off += 8) jmprel.push({ offset: dv.getUint32(off, true), info: dv.getUint32(off + 4, true), type: dv.getUint32(off + 4, true) & 0xff, sym: dv.getUint32(off + 4, true) >>> 8, addend: null });
  const needed = strtab ? all(ELF_DYNAMIC_TAG.NEEDED).map(off => dynString(elf, strtab, off)).filter(Boolean) : [];
  return { entries, needed, rel, rela: [], jmprel, strtab, symtab: get(ELF_DYNAMIC_TAG.SYMTAB), syment: get(ELF_DYNAMIC_TAG.SYMENT) || 16 };
}

export function applyELF32Relocations(image, options = {}) {
  const { memory, elf, base = 0 } = image;
  const dyn = parseELF32DynamicInfo(elf);
  const resolver = options.resolveSymbol ?? (() => 0);
  const stats = { applied: 0, skipped: 0, unsupported: [] };
  const write32 = (addr, value) => typeof memory.forceWrite32 === "function" ? memory.forceWrite32(addr, value) : memory.write32(addr, value);
  const applyOne = r => {
    const addr = (base + r.offset) >>> 0;
    const old = memory.read32(addr);
    switch (r.type) {
      case R_386.NONE: return;
      case R_386.RELATIVE: write32(addr, (base + old) >>> 0); stats.applied++; return;
      case R_386.GLOB_DAT:
      case R_386.JMP_SLOT: { const sym = resolver(r.sym, dyn, image) >>> 0; if (!sym) { stats.skipped++; return; } write32(addr, sym); stats.applied++; return; }
      case R_386._32: { const sym = resolver(r.sym, dyn, image) >>> 0; if (r.sym && !sym) { stats.skipped++; return; } write32(addr, (sym + old) >>> 0); stats.applied++; return; }
      case R_386.PC32: { const sym = resolver(r.sym, dyn, image) >>> 0; if (r.sym && !sym) { stats.skipped++; return; } write32(addr, (sym + old - addr) >>> 0); stats.applied++; return; }
      default:
        stats.unsupported.push(r.type);
        if (options.strict) throw new ELFError(`Unsupported i386 relocation type ${r.type}`);
    }
  };
  for (const r of dyn.rel) applyOne(r);
  for (const r of dyn.jmprel) applyOne(r);
  image.dynamic = dyn; image.relocations = stats;
  return dyn;
}

export const DT = Object.freeze({ NULL: 0, NEEDED: 1, PLTRELSZ: 2, PLTGOT: 3, HASH: 4, STRTAB: 5, SYMTAB: 6, RELA: 7, RELASZ: 8, RELAENT: 9, STRSZ: 10, SYMENT: 11, INIT: 12, FINI: 13, SONAME: 14, RPATH: 15, SYMBOLIC: 16, REL: 17, RELSZ: 18, RELENT: 19, PLTREL: 20, DEBUG: 21, JMPREL: 23 });

export function parseELF32Sections(bytes) {
  const elf = parseELF32(bytes);
  const dv = viewOf(elf.bytes);
  const sections = [];
  let shstr = new Uint8Array(0);
  if (elf.header.shoff && elf.header.shnum && elf.header.shstrndx < elf.header.shnum) {
    const off = elf.header.shoff + elf.header.shstrndx * elf.header.shentsize;
    const strOff = dv.getUint32(off + 16, true), strSize = dv.getUint32(off + 20, true);
    shstr = elf.bytes.subarray(strOff, strOff + strSize);
  }
  for (let i = 0; i < elf.header.shnum; i++) {
    const off = elf.header.shoff + i * elf.header.shentsize;
    const nameOff = dv.getUint32(off + 0, true);
    const s = {
      name: readString(shstr, nameOff, shstr.length - nameOff), type: dv.getUint32(off + 4, true), flags: dv.getUint32(off + 8, true), addr: dv.getUint32(off + 12, true),
      offset: dv.getUint32(off + 16, true), size: dv.getUint32(off + 20, true), link: dv.getUint32(off + 24, true), info: dv.getUint32(off + 28, true), addralign: dv.getUint32(off + 32, true), entsize: dv.getUint32(off + 36, true)
    };
    sections.push(s);
  }
  return { ...elf, sections };
}

export function readDynamicTable(memory, dynamicAddr, base = 0) {
  const tags = new Map();
  if (!dynamicAddr) return tags;
  for (let off = dynamicAddr >>> 0, i = 0; i < 4096; i++, off += 8) {
    const tag = memory.read32(off) >>> 0;
    const val = memory.read32(off + 4) >>> 0;
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(val);
    if (tag === DT.NULL) break;
  }
  const get = tag => tags.get(tag)?.[0] ?? 0;
  return { tags, get, base };
}

function readSym(memory, symtab, index, syment = 16) {
  const off = (symtab + index * syment) >>> 0;
  return { name: memory.read32(off), value: memory.read32(off + 4), size: memory.read32(off + 8), info: memory.read8(off + 12), other: memory.read8(off + 13), shndx: memory.read16(off + 14) };
}

export function applyI386Relocations(image, options = {}) {
  const memory = options.memory ?? image.memory;
  const base = image.base >>> 0;
  const dyn = readDynamicTable(memory, image.dynamicAddr, base);
  const rels = [];
  const rel = dyn.get?.(DT.REL) ?? 0, relsz = dyn.get?.(DT.RELSZ) ?? 0, relent = dyn.get?.(DT.RELENT) || 8;
  const jmprel = dyn.get?.(DT.JMPREL) ?? 0, pltrelsz = dyn.get?.(DT.PLTRELSZ) ?? 0;
  if (rel && relsz) rels.push([rel, relsz, relent]);
  if (jmprel && pltrelsz) rels.push([jmprel, pltrelsz, 8]);
  const symtab = dyn.get?.(DT.SYMTAB) ?? 0, syment = dyn.get?.(DT.SYMENT) || 16;
  let applied = 0;
  for (const [addr0, size, ent] of rels) {
    for (let off = 0; off < size; off += ent) {
      const addr = (addr0 + off) >>> 0;
      const rOffset = memory.read32(addr) >>> 0;
      const rInfo = memory.read32(addr + 4) >>> 0;
      const type = rInfo & 0xff;
      const symIndex = rInfo >>> 8;
      const P = rOffset >>> 0;
      const A = memory.read32(P) >>> 0;
      const S = symtab && symIndex ? ((base + readSym(memory, symtab, symIndex, syment).value) >>> 0) : 0;
      if (type === R_386.NONE) continue;
      if (type === R_386.R_386_RELATIVE) memory.write32(P, (base + A) >>> 0);
      else if (type === R_386.R_386_32) memory.write32(P, (S + A) >>> 0);
      else if (type === R_386.R_386_PC32) memory.write32(P, (S + A - P) >>> 0);
      else if (type === R_386.R_386_GLOB_DAT || type === R_386.R_386_JMP_SLOT) memory.write32(P, S >>> 0);
      else if (options.strict) throw new ELFError(`unsupported i386 relocation ${type}`);
      applied++;
    }
  }
  return { applied, dynamic: dyn };
}
