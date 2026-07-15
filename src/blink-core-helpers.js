// blink-core-helpers.js — X-server FS/proxy-pump helpers and rootfs
// extraction, shared across blink-core.js's createBlinkCore closure. Split
// out to keep blink-core.js under the repo's <200-line-per-file cap; the
// memory/io/boot/register pieces live in their own sibling modules
// (blink-core-mem.js, blink-core-io.js, blink-core-boot.js) re-exported here
// for import-site convenience.

import { parseTar, mkdirp } from "./apk-format.js";

export { memBuffer } from "./blink-core-mem.js";
export { writeStr, writeArgv, makeRegisterAccessor } from "./blink-core-io.js";
export { bootBlinkModule } from "./blink-core-boot.js";

// Write guest program bytes to a fixed FS path (blink always execs by path
// for the X entry points, unlike runElf's preload-handle scheme). Shared by
// startXServer/launchXClient, which were previously each carrying an
// identical inline copy.
export function writeProg(FS,path,bytes){
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  try{ FS.unlink(path) }catch(_){}
  const fd=FS.open(path,"w+");
  FS.write(fd,u8,0,u8.length,0);
  FS.close(fd);
  FS.chmod(path,0o755);
}

// Pump the emscripten main-thread proxy queue once, swallowing errors. Worker
// pthreads (the X server/client under -pthread) proxy their blocking syscalls
// to the main thread; without servicing this queue a worker stalls and its
// thread_done flag never flips. No-op on a non-threaded build (symbol absent).
export function makePumpProxy(Module){
  return typeof Module._emscripten_main_thread_process_queued_calls==="function"
    ? () => { try{ Module._emscripten_main_thread_process_queued_calls() }catch(_){} }
    : () => {};
}

// Poll a thread slot until blinkenlib_thread_done_slot flips or timeoutMs
// elapses, pumping the proxy queue every tick so the worker's proxied
// syscalls get serviced promptly (relying on a setInterval pump alone left
// slot-1 clients wedged -- see launchXClient's original inline comment).
// Returns {timedOut, exitCode} where exitCode is "RUNNING" if timed out.
export async function waitForSlot(Module,slot,{timeoutMs=60000,pollMs=20}={}){
  const pumpProxy=makePumpProxy(Module);
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const t0=Date.now();
  let timedOut=false;
  while(!Module._blinkenlib_thread_done_slot(slot)){
    if(Date.now()-t0>timeoutMs){ timedOut=true; break; }
    pumpProxy();
    await sleep(pollMs);
  }
  const exitCode=Module._blinkenlib_thread_done_slot(slot)
    ? Module._blinkenlib_thread_status_slot(slot) : "RUNNING";
  return { timedOut, exitCode };
}

// Extract a full rootfs tar onto FS, using the shared parseTar (handles GNU
// long-name ('L') entries -- extractTarToFS's own hand-rolled loop didn't).
// Unlike apk-format.js's writeRecord (which skips dotfile-named apk metadata
// members and preserves each entry's tar mode), a rootfs mount wants every
// entry written and every regular file made executable (0o755) regardless of
// its tar mode, matching the prior extractTarToFS behavior exactly.
export function extractTarToFS(FS, tarBytes, onError){
  const u8 = tarBytes instanceof Uint8Array ? tarBytes : new Uint8Array(tarBytes);
  for(const rec of parseTar(u8)){
    const full="/"+rec.name;
    try{
      if(rec.type==="5") mkdirp(FS,full);
      else if(rec.type==="2"){ mkdirp(FS,full.replace(/\/[^/]*$/,"")); try{FS.unlink(full)}catch(_){}; FS.symlink(rec.linkname,full) }
      else if(rec.type==="0"||rec.type===""||rec.type===" "){
        mkdirp(FS,full.replace(/\/[^/]*$/,""));
        try{FS.unlink(full)}catch(_){}
        const s=FS.open(full,"w+");
        if(rec.data.length) FS.write(s,rec.data,0,rec.data.length,0);
        FS.close(s); FS.chmod(full,0o755);
      }
    }catch(e){ (onError||((m,err)=>console.warn("tar:",m,err.message)))(full,e) }
  }
}
