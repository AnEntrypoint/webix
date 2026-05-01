import { parseELF32, parseELF64 } from "./elf.js";

export class Architecture {
  constructor(id,opts={}){this.id=id;this.bits=opts.bits;this.machine=opts.machine}
  matchesELF(_){return false}
}
export class I386Architecture extends Architecture {
  constructor(){super("i386",{bits:32,machine:"EM_386"})}
  parseExecutable(b){return parseELF32(b)}
  matchesELF(elf){return elf?.header?.machine===3 && elf?.bytes?.[4]===1}
  syscallAbi(){return {trap:"int 0x80",number:"eax",args:["ebx","ecx","edx","esi","edi","ebp"],result:"eax"}}
}
export class X86_64Architecture extends Architecture {
  constructor(){super("x86_64",{bits:64,machine:"EM_X86_64"})}
  parseExecutable(b){return parseELF64(b)}
  matchesELF(elf){return elf?.header?.machine===62 && elf?.bytes?.[4]===2}
  syscallAbi(){return {trap:"syscall",number:"rax",args:["rdi","rsi","rdx","r10","r8","r9"],result:"rax"}}
}
export class ArchitectureRegistry {
  constructor(){this.arches=new Map()}
  register(a){this.arches.set(a.id,a);return a}
  get(id){const a=this.arches.get(id);if(!a)throw new Error(`unknown arch ${id}`);return a}
  list(){return [...this.arches.keys()]}
}
export const architectures=new ArchitectureRegistry();
export const i386=architectures.register(new I386Architecture());
export const x86_64=architectures.register(new X86_64Architecture());
