export class ELFError extends Error {}

function asU8(b){return b instanceof Uint8Array?b:new Uint8Array(b)}
function dv(u8){return new DataView(u8.buffer,u8.byteOffset,u8.byteLength)}

export function parseELF64(bytes){
  const u8=asU8(bytes),v=dv(u8);
  if(u8.length<64||u8[0]!==0x7f||u8[1]!==0x45||u8[2]!==0x4c||u8[3]!==0x46) throw new ELFError("Not an ELF file");
  if(u8[4]!==2) throw new ELFError("Not ELFCLASS64");
  if(u8[5]!==1) throw new ELFError("Only little-endian ELF64 supported");
  const machine=v.getUint16(18,true);
  if(machine!==62) throw new ELFError(`Only EM_X86_64 ELF64 supported (got machine=${machine})`);
  const header={
    type:v.getUint16(16,true),machine,version:v.getUint32(20,true),
    entry:v.getBigUint64(24,true),phoff:v.getBigUint64(32,true),shoff:v.getBigUint64(40,true),
    flags:v.getUint32(48,true),ehsize:v.getUint16(52,true),
    phentsize:v.getUint16(54,true),phnum:v.getUint16(56,true),
    shentsize:v.getUint16(58,true),shnum:v.getUint16(60,true),shstrndx:v.getUint16(62,true)
  };
  return {bytes:u8,header};
}

export function parseELF32(bytes){
  const u8=asU8(bytes),v=dv(u8);
  if(u8.length<52||u8[0]!==0x7f||u8[1]!==0x45||u8[2]!==0x4c||u8[3]!==0x46) throw new ELFError("Not an ELF file");
  if(u8[4]!==1) throw new ELFError("Not ELFCLASS32");
  const header={type:v.getUint16(16,true),machine:v.getUint16(18,true),entry:v.getUint32(24,true)};
  return {bytes:u8,header};
}
