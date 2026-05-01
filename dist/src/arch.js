import { CPU } from "./cpu.js";
import { loadELF32Process, loadFlatBinary, parseELF32, setupInitialStack } from "./elf.js";

export class ArchitectureError extends Error {}

export class Architecture {
  constructor(id, options = {}) { this.id = id; this.bits = options.bits; this.endian = options.endian ?? "little"; this.machine = options.machine; }
  createCPU() { throw new Error(`${this.id}: createCPU not implemented`); }
  parseExecutable() { throw new Error(`${this.id}: parseExecutable not implemented`); }
  loadProcess() { throw new ArchitectureError(`${this.id}: loadProcess not implemented`); }
  setupInitialStack() { throw new ArchitectureError(`${this.id}: setupInitialStack not implemented`); }
  matchesELF(_elf) { return false; }
}

export class I386Architecture extends Architecture {
  constructor() { super("i386", { bits: 32, endian: "little", machine: "EM_386" }); }
  createCPU(memory, syscalls, options = {}) { return new CPU(memory, syscalls, options); }
  parseExecutable(bytes) { return parseELF32(bytes); }
  matchesELF(elf) { return elf?.header?.machine === 3 && elf?.bytes?.[4] === 1; }
  loadProcess(bytes, options = {}) { return loadELF32Process(bytes, options); }
  loadFlat(bytes, address, options = {}) { return loadFlatBinary(bytes, address, options); }
  setupInitialStack(cpu, options = {}) { return setupInitialStack(cpu, options); }
  syscallAbi() { return { trap: "int 0x80", number: "eax", args: ["ebx", "ecx", "edx", "esi", "edi", "ebp"], result: "eax", errno: "negative" }; }
}

export class ArchitectureRegistry {
  constructor() { this.arches = new Map(); }
  register(arch) { this.arches.set(arch.id, arch); return arch; }
  get(id) { const arch = this.arches.get(id); if (!arch) throw new Error(`unknown architecture ${id}`); return arch; }
  list() { return [...this.arches.keys()]; }
}

export const architectures = new ArchitectureRegistry();
export const i386 = architectures.register(new I386Architecture());

export const defaultArchitectureRegistry = architectures;
