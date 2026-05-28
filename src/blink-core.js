const BLINK_PREEMPT=40, BLINK_FAKE_TTY=42, SIGTRAP=5;

const REGS=["rip","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15","rax","rbx","rcx","rdx"];

function mkdirp(FS,p){
  let cur="";
  for(const seg of p.split("/").filter(Boolean)){
    cur+="/"+seg;
    try{ FS.mkdir(cur,0o755) }catch(_){}
  }
}

function extractTarToFS(FS, tarBytes, onError){
  const u8 = tarBytes instanceof Uint8Array ? tarBytes : new Uint8Array(tarBytes);
  const td=new TextDecoder();
  let p=0;
  while(p+512<=u8.length){
    const name=td.decode(u8.subarray(p,p+100)).replace(/\0.*/,"");
    if(!name){ p+=512; continue }
    const sizeStr=td.decode(u8.subarray(p+124,p+136)).replace(/[\0\s]/g,"");
    const size=parseInt(sizeStr||"0",8)||0;
    const tf=String.fromCharCode(u8[p+156]||0x30);
    const linkname=td.decode(u8.subarray(p+157,p+257)).replace(/\0.*/,"");
    const full="/"+name.replace(/^\.\//,"");
    try{
      if(tf==="5") mkdirp(FS,full);
      else if(tf==="2"){ mkdirp(FS,full.replace(/\/[^/]*$/,"")); try{FS.unlink(full)}catch(_){}; FS.symlink(linkname,full) }
      else if(tf==="0"||tf===""||tf===" "){
        mkdirp(FS,full.replace(/\/[^/]*$/,""));
        const data=u8.subarray(p+512,p+512+size);
        try{FS.unlink(full)}catch(_){}
        const s=FS.open(full,"w+");
        if(size) FS.write(s,data,0,size,0);
        FS.close(s); FS.chmod(full,0o755);
      }
    }catch(e){ (onError||((m,err)=>console.warn("tar:",m,err.message)))(full,e) }
    p+=512+Math.ceil(size/512)*512;
  }
}

// Return the live WASM linear-memory ArrayBuffer. Under -pthread the memory is
// IMPORTED + shared (--import-memory --shared-memory), so it is NOT an export:
// wasmExports.memory is undefined and only Module.wasmMemory / the HEAP views
// point at it. HEAPU8.buffer is the most portable + always-current handle
// (emscripten re-points the HEAP* views on every growth), so prefer it; fall
// back to wasmMemory then the (single-thread-only) wasmExports.memory.
function memBuffer(Module){
  const b = Module.HEAPU8?.buffer || Module.wasmMemory?.buffer || Module.wasmExports?.memory?.buffer;
  if(!b) throw new Error("blink-core: cannot locate WASM memory buffer");
  return b;
}

function makeRegisterAccessor(Module, clstruct){
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

export async function createBlinkCore({ wasmBinary, factory, options={} }){
  // byte-buffered stdout/stderr: per-char String concat was O(n^2) for large output.
  let outBytes=[], errBytes=[], lastSignal=null, lastExitCode=null;
  const td=new TextDecoder();
  const decode=(arr)=>td.decode(new Uint8Array(arr));
  let exitDeferred=null;
  let lastLoaded=null;
  const preloaded=new Map();
  const stdinQueue=options.stdinBytes?[...options.stdinBytes].reverse():[];
  function settleExit(code){
    lastExitCode=code;
    if(exitDeferred){ const d=exitDeferred; exitDeferred=null; d.resolve(code) }
  }
  const factoryArgs={
    noInitialRun:true,
    preRun:(M)=>{
      M.FS.init(
        ()=>stdinQueue.length?stdinQueue.pop():null,
        (c)=>{ if(c!==null){ outBytes.push(c); options.onStdout?.(c) } },
        (c)=>{ if(c!==null){ errBytes.push(c); options.onStderr?.(c) } }
      );
    }
  };
  // Either supply raw bytes (Node/tests) or an instantiateWasm streaming hook (browser).
  if(options.instantiateWasm) factoryArgs.instantiateWasm=options.instantiateWasm;
  else factoryArgs.wasmBinary=wasmBinary;
  const Module=await factory(factoryArgs);
  // Under -pthread the memory is imported + shared, so it lives on
  // Module.wasmMemory / the HEAP views, NOT on wasmExports.memory (which is
  // undefined for an imported memory). The MODULARIZE factory also resolves
  // once the main-thread runtime is up; wait until a memory buffer is reachable
  // through any of the portable handles before touching it.
  if(!Module.HEAPU8 && !Module.wasmMemory && !Module.wasmExports?.memory){
    if(typeof Module.ready?.then==="function"){ try{ await Module.ready }catch(_){} }
    for(let i=0;i<2000 && !(Module.HEAPU8||Module.wasmMemory||Module.wasmExports?.memory);i++){
      await new Promise(r=>setTimeout(r,0));
    }
  }
  // memBuffer throws a clear error if no handle resolved; probe it once now.
  memBuffer(Module);
  const signalCb=Module.addFunction((sig,code)=>{
    if(sig!==SIGTRAP){ lastSignal={sig,code}; settleExit(128+sig); return }
    if(code===BLINK_PREEMPT) Module._blinkenlib_preempt_resume();
    else if(code===BLINK_FAKE_TTY){ if(options.onTtyPause) options.onTtyPause(); else Module._blinkenlib_faketty_resume() }
  },"vii");
  const exitCb=Module.addFunction((code)=>{ settleExit(code) },"vi");
  Module.callMain([signalCb.toString(), exitCb.toString()]);
  const clstruct=Module._blinkenlib_get_clstruct();
  const argcPtr=Module._blinkenlib_get_argc_string();
  const argvPtr=Module._blinkenlib_get_argv_string();
  const prognamePtr=Module._blinkenlib_get_progname_string();
  const regs=makeRegisterAccessor(Module, clstruct);
  function writeStr(ptr,str,max){
    const view=new DataView(memBuffer(Module));
    const n=Math.min(str.length,max-1);
    for(let i=0;i<n;i++) view.setUint8(ptr+i,str.charCodeAt(i));
    view.setUint8(ptr+n,0);
  }
  // Write an argv array as a NUL-separated buffer terminated by a double NUL.
  // Matches stringToArgsArray() in blinkenlib.c, which splits on NUL so that
  // arguments containing spaces survive (the old space-joined scheme broke
  // every multi-word arg). ARGC_MAX_LINE_LEN is 4096 in the patched build.
  function writeArgv(ptr,args,max){
    const enc=new TextEncoder();
    const view=new Uint8Array(memBuffer(Module));
    let off=0;
    for(const a of args){
      const bytes=enc.encode(String(a));
      if(off+bytes.length+2>max) break; // leave room for two NULs
      view.set(bytes,ptr+off); off+=bytes.length;
      view[ptr+off]=0; off++;
    }
    view[ptr+off]=0; // terminating empty arg
  }
  // Framebuffer accessors: geometry published by the guest via the synthetic
  // 0x5fb syscall, pixels mapped zero-copy through spy_address(fb_vaddr).
  function fbInfo(){
    const w=Module._blinkenlib_get_fb_width();
    const h=Module._blinkenlib_get_fb_height();
    if(!w||!h) return null;
    return {
      vaddr:Module._blinkenlib_get_fb_vaddr(),
      width:w, height:h,
      stride:Module._blinkenlib_get_fb_stride(),
      generation:Module._blinkenlib_get_fb_generation(),
    };
  }
  // Return a fresh Uint8ClampedArray view over the guest framebuffer. Must be
  // re-derived each frame: ALLOW_MEMORY_GROWTH detaches the old ArrayBuffer.
  function fbView(){
    const info=fbInfo(); if(!info) return null;
    const host=Module._blinkenlib_get_fb_ptr(); if(!host) return null;
    const len=info.stride*info.height;
    return { ...info, pixels:new Uint8ClampedArray(memBuffer(Module),host,len) };
  }
  return {
    Module, clstruct,
    // Capability flags reflect the portabox max-perf build. `pipe` is the
    // pipe()/pipe2() SYSCALL (implemented), distinct from `pipelines` (shell
    // `a | b`) which needs fork() -- absent under emscripten, so false.
    // `threads` requires crossOriginIsolated (COOP/COEP) at serve time for the
    // SharedArrayBuffer the pthread pool needs.
    capabilities:{ tarMount:true, nodefs:!!Module.FS.filesystems?.NODEFS, sockets:true, threads:true, sharedMemory:typeof SharedArrayBuffer!=="undefined", pipe:true, pipelines:false, fork:false, framebuffer:true, jit:false, vectorISA:"sse2" },
    fbInfo, fbView,
    mountTarBytes(tarBytes, onError){ extractTarToFS(Module.FS, tarBytes, onError) },
    mountNodeDir(hostDir, guestDir="/host"){
      const FS=Module.FS;
      if(!FS.filesystems?.NODEFS) throw new Error("NODEFS not compiled in");
      try{ FS.mkdir(guestDir) }catch(_){}
      FS.mount(FS.filesystems.NODEFS,{root:hostDir},guestDir);
      return guestDir;
    },
    // Mount an IDBFS-backed dir so its contents survive page reloads (browser only).
    // Call syncPersist() after writes to flush to IndexedDB; loadPersist() once at
    // boot to populate from IndexedDB. Used to persist apk-installed packages.
    async persistDir(guestDir="/persist"){
      const FS=Module.FS;
      if(!FS.filesystems?.IDBFS) throw new Error("IDBFS not compiled in");
      mkdirp(FS, guestDir);
      FS.mount(FS.filesystems.IDBFS,{},guestDir);
      await new Promise((res,rej)=>FS.syncfs(true,(e)=>e?rej(e):res()));
      this._persistDir=guestDir;
      return guestDir;
    },
    syncPersist(){
      const FS=Module.FS;
      return new Promise((res,rej)=>FS.syncfs(false,(e)=>e?rej(e):res()));
    },
    // Cache the bytes that should sit at /program (blink always execs /program).
    // Reusing the same handle across runElf skips the per-call multi-MB FS write
    // (busybox is ~1MB). Returns the opaque handle to pass back as runElf opts.path.
    preloadFile(name, bytes){
      const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      const handle="pre:"+name;
      preloaded.set(handle, data);
      return handle;
    },
    isPreloaded(handle){ return preloaded.has(handle); },
    async runElf(bytes,{ argv=[], progname="/program", path }={}){
      if(exitDeferred) throw new Error("blink-core: previous run not yet settled");
      const FS=Module.FS;
      // Resolve the bytes: explicit bytes, or a preloaded handle.
      let data=bytes;
      if(!data && path){
        data=preloaded.get(path);
        if(!data) throw new Error("blink-core: unknown preload handle "+path);
      }
      if(!data) throw new Error("blink-core: runElf needs bytes or a preload handle");
      const writeKey=path||null;
      // Skip the FS write if the identical handle is already sitting at /program.
      if(!(writeKey && lastLoaded===writeKey)){
        const u8=data instanceof Uint8Array?data:new Uint8Array(data);
        try{ FS.unlink("/program") }catch(_){}
        const s=FS.open("/program","w+");
        FS.write(s,u8,0,u8.length,0); FS.close(s); FS.chmod("/program",0o755);
        lastLoaded=writeKey;
      }
      writeStr(prognamePtr,progname,1024);
      // NUL-separated argv (patched blinkenlib parses on NUL, buffer is 4096).
      writeArgv(argcPtr, argv.length?argv:[progname], 4096);
      writeStr(argvPtr,"",4096);
      outBytes=[]; errBytes=[]; lastSignal=null; lastExitCode=null;
      const done=new Promise((resolve,reject)=>{ exitDeferred={resolve,reject} });
      Module._blinkenlib_run();
      const exitCode=await done;
      return { exitCode, stdout:decode(outBytes), stderr:decode(errBytes), signal:lastSignal };
    },
    pushStdin(bytes){ for(const b of [...bytes].reverse()) stdinQueue.unshift(b) },
    async runShellScript(busyboxBytes, scriptText, { argv=[], progname="/program" }={}){
      const FS=Module.FS;
      const scriptPath="/tmp/_xos_"+Math.random().toString(36).slice(2,10)+".sh";
      try{ FS.mkdir("/tmp") }catch(_){}
      FS.writeFile(scriptPath, scriptText); FS.chmod(scriptPath, 0o755);
      return this.runElf(busyboxBytes, { argv:["sh", scriptPath, ...argv], progname });
    },
    snapshot(){
      const s=regs.snapshot();
      return { ...s, exitCode:lastExitCode, stdoutTail:decode(outBytes).slice(-4096), stderrTail:decode(errBytes).slice(-4096) };
    },
    restore(snap){ regs.restore(snap) },
    readRegisters(){ return regs.readRegisters() }
  };
}
