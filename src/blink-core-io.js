// blink-core-io.js — argv/progname string writers and the register accessor
// for a blink-core Module instance. Split out of blink-core-helpers.js to
// keep each file under the repo's <200-line-per-file cap.

import { memBuffer } from "./blink-core-mem.js";

const REGS=["rip","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15","rax","rbx","rcx","rdx"];

const strEncoder=new TextEncoder();

// encodeInto writes directly into the target buffer (no intermediate
// allocation) and, unlike a raw byte-count slice, never splits a multi-byte
// UTF-8 sequence when the string overflows max -- it only ever writes whole
// code points, so a truncated write is still valid UTF-8. This also fixes a
// latent correctness bug the old per-byte DataView loop had: charCodeAt(i)
// wrote raw UTF-16 code units as bytes, corrupting any non-ASCII path/progname.
export function writeStr(Module,ptr,str,max){
  const view=new Uint8Array(memBuffer(Module));
  const { written }=strEncoder.encodeInto(String(str), view.subarray(ptr,ptr+max-1));
  view[ptr+written]=0;
}

// Write an argv array as a NUL-separated buffer terminated by a double NUL.
// Matches stringToArgsArray() in blinkenlib.c, which splits on NUL so that
// arguments containing spaces survive (the old space-joined scheme broke
// every multi-word arg). ARGC_MAX_LINE_LEN is 4096 in the patched build.
export function writeArgv(Module,ptr,args,max){
  const view=new Uint8Array(memBuffer(Module));
  let off=0;
  for(const a of args){
    const bytes=strEncoder.encode(String(a));
    if(off+bytes.length+2>max){
      throw new Error(`blink-core: argv exceeds ${max}-byte buffer (arg ${JSON.stringify(String(a)).slice(0,64)} at offset ${off}) -- truncating would silently execute a different command line`);
    }
    view.set(bytes,ptr+off); off+=bytes.length;
    view[ptr+off]=0; off++;
  }
  view[ptr+off]=0; // terminating empty arg
}

export function makeRegisterAccessor(Module, clstruct){
  const dv=()=>new DataView(memBuffer(Module));
  const off=(i)=>dv().getUint32(clstruct+i*4,true);
  return {
    snapshot(){
      const memBuf=memBuffer(Module);
      const memCopy=new Uint8Array(memBuf.byteLength);
      memCopy.set(new Uint8Array(memBuf));
      const v=dv();
      const regs={ flags:v.getUint32(off(7),true) };
      REGS.forEach((n,i)=>{ regs[n]=v.getBigUint64(off(9+i),true) });
      return { memory:memCopy, registers:regs };
    },
    restore(snap){
      const memBuf=memBuffer(Module);
      if(snap.memory.byteLength>memBuf.byteLength) throw new Error("snapshot memory larger than current");
      new Uint8Array(memBuf).set(snap.memory);
      const v=dv();
      REGS.forEach((n,i)=>{ v.setBigUint64(off(9+i),snap.registers[n],true) });
      v.setUint32(off(7),snap.registers.flags,true);
    },
    readRegisters(){
      const v=dv();
      const r={ flags:v.getUint32(off(7),true) };
      REGS.forEach((n,i)=>{ r[n]=v.getBigUint64(off(9+i),true) });
      return r;
    }
  };
}
