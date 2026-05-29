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
  let exited=false;
  function settleExit(code){
    exited=true;
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
  // Trampoline the cooperative-preemption resume off the signal callback's
  // stack. The guest raises SIGTRAP/PREEMPT every MAX_CYCLES; calling
  // _blinkenlib_preempt_resume() synchronously from inside signalCb re-enters
  // the guest WITHOUT unwinding, so each slice nests another invoke_viii frame
  // and a forever-running guest (e.g. the X server) overflows the JS call stack
  // after ~thousands of slices. Instead, return from signalCb (leaving the guest
  // paused) and schedule the resume on a fresh stack via setTimeout(0), which
  // also lets the JS event loop (rAF/blits/input) breathe between slices.
  const resumeSoon=()=>{ if(exited) return; setTimeout(()=>{ if(!exited){ try{ Module._blinkenlib_preempt_resume() }catch(e){ settleExit(255) } } },0); };
  // The signal/exit callbacks delegate to a swappable handler so the run model
  // can be a single foreground run (default) OR a cooperative multi-VM scheduler
  // (runConcurrent) where a per-call flag records preempt/exit for the VM that
  // was active when callMain/resume was invoked.
  let activeHandler=null;
  const signalCb=Module.addFunction((sig,code)=>{
    if(activeHandler){ activeHandler.onSignal(sig,code); return }
    if(sig!==SIGTRAP){ lastSignal={sig,code}; settleExit(128+sig); return }
    if(code===BLINK_PREEMPT) resumeSoon();
    else if(code===BLINK_FAKE_TTY){ if(options.onTtyPause) options.onTtyPause(); else Module._blinkenlib_faketty_resume() }
  },"vii");
  const exitCb=Module.addFunction((code)=>{ if(activeHandler){ activeHandler.onExit(code); return } settleExit(code) },"vi");
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
  // Reusable output buffer for the page-assembled framebuffer copy.
  let fbCopyBuf=null;
  // Return the guest framebuffer pixels as a contiguous Uint8ClampedArray.
  //
  // IMPORTANT: blink's SpyAddress (memory.c LookupAddress2) returns a host
  // pointer valid only for the 4096-byte PAGE containing the queried vaddr --
  // guest pages map to arbitrary, non-contiguous host pages. A single
  // spy_address(fb_vaddr) is therefore valid for just the first 4KB; reading
  // stride*height contiguously past that returns unrelated host memory (this
  // was the "framebuffer goes black past the first page" bug). So we COPY the
  // framebuffer page-by-page: for each 4KB span we re-query spy_address to get
  // that page's host pointer and copy it into a contiguous output buffer.
  function fbView(){
    const info=fbInfo(); if(!info) return null;
    const vaddr=Module._blinkenlib_get_fb_vaddr(); // u64; may arrive signed
    // normalize a possibly-signed 32-bit marshalled vaddr to unsigned
    const base=vaddr<0?vaddr>>>0:vaddr;
    if(!base) return null;
    const len=info.stride*info.height;
    if(!fbCopyBuf||fbCopyBuf.length!==len) fbCopyBuf=new Uint8ClampedArray(len);
    const PAGE=4096;
    let off=0;
    while(off<len){
      const host=Module._blinkenlib_spy_address(base+off);
      const chunk=Math.min(PAGE-((base+off)&(PAGE-1)), len-off);
      if(host){
        const src=new Uint8Array(memBuffer(Module), host, chunk);
        fbCopyBuf.set(src, off);
      } // unmapped page -> leave as-is (transparent/previous)
      off+=chunk;
    }
    return { ...info, pixels:fbCopyBuf };
  }
  // Host -> guest input. Maps display.js's event shape to the C input device
  // (blinkenlib_push_input(type, code, x, y, value)). type: 1=key 2=motion
  // 3=button. Guest drains via syscall 0x5fc. No-op (with a guard) if the
  // running wasm predates the input device, so display.js stays graceful.
  const INPUT_TYPE={ key:1, motion:2, button:3 };
  const hasInputDevice=typeof Module._blinkenlib_push_input==="function";
  function pushInput(evt){
    if(!hasInputDevice || !evt) return false;
    const type=INPUT_TYPE[evt.type]; if(!type) return false;
    const code=(evt.code ?? evt.button ?? 0)|0;
    const x=(evt.x ?? 0)|0, y=(evt.y ?? 0)|0;
    const value=(evt.down ?? evt.value ?? 0)|0;
    Module._blinkenlib_push_input(type, code, x, y, value);
    return true;
  }
  function inputPending(){ return hasInputDevice ? Module._blinkenlib_input_pending() : 0; }
  return {
    Module, clstruct,
    // Capability flags reflect the portabox max-perf build. `pipe` is the
    // pipe()/pipe2() SYSCALL (implemented), distinct from `pipelines` (shell
    // `a | b`) which needs fork() -- absent under emscripten, so false.
    // `threads` requires crossOriginIsolated (COOP/COEP) at serve time for the
    // SharedArrayBuffer the pthread pool needs.
    capabilities:{ tarMount:true, nodefs:!!Module.FS.filesystems?.NODEFS, sockets:true, threads:true, sharedMemory:typeof SharedArrayBuffer!=="undefined", pipe:true, pipelines:false, fork:false, framebuffer:true, jit:false, vectorISA:"sse2" },
    fbInfo, fbView, pushInput, inputPending,
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
    // Run a long-lived SERVER guest and a CLIENT guest concurrently in this one
    // wasm instance so they share the MEMFS + in-process AF_UNIX sockets (X
    // server + X client). Cooperative: each VM runs MAX_CYCLES then preempts;
    // the scheduler switches the active VM (blinkenlib_vm_set) and resumes the
    // other. Resolves when the CLIENT exits (the server keeps serving) or on
    // serverTimeoutMs. Returns the client's exit + both VMs' captured output.
    // DUAL-WORKER concurrency: run a long-lived SERVER guest and a CLIENT guest
    // on SEPARATE pthreads (Web Workers under -pthread) sharing this wasm
    // instance's memory/MEMFS/fds/g_socks. Each VM uses NORMAL blocking syscalls
    // (its own thread blocks; real preemptive scheduling interleaves them), so
    // the X server can accept + handshake while the client blocks reading — no
    // cooperative-scheduler starvation. The main thread spins waiting for the
    // client thread to finish (the server thread keeps serving). Output is the
    // combined guest stdout/stderr (both threads write the shared buffers).
    async runConcurrent(serverBytes, clientBytes, {
      serverArgv=[], serverProgname="/xserver",
      clientArgv=[], clientProgname="/xclient",
      clientDelayMs=2000, overallTimeoutMs=40000,
    }={}){
      if(exitDeferred) throw new Error("blink-core: a run is already in flight");
      if(typeof Module._blinkenlib_run_thread!=="function")
        throw new Error("blink-core: blinkenlib_run_thread missing (rebuild blink)");
      const FS=Module.FS;
      const writeProg=(p,bytes)=>{ const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes); try{FS.unlink(p)}catch(_){} const fd=FS.open(p,"w+"); FS.write(fd,u8,0,u8.length,0); FS.close(fd); FS.chmod(p,0o755); };
      writeProg("/xserver",serverBytes); writeProg("/xclient",clientBytes);
      outBytes=[]; errBytes=[];
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      // Spawn + launch the SERVER on its own thread (it runs forever, serving).
      const spawn=(progname,argvArr)=>{
        writeStr(prognamePtr,progname,1024);
        writeArgv(argcPtr, argvArr.length?argvArr:[progname], 4096);
        writeStr(argvPtr,"",4096);
        return Module._blinkenlib_vm_spawn(0);   // fresh (m,s) at progname, current
      };
      const serverH=spawn("/xserver",["Xvfb",...serverArgv]);
      Module._blinkenlib_run_thread(serverH);
      // Give the server real time to reach its listening dispatch loop.
      await sleep(clientDelayMs);
      // Spawn + launch the CLIENT on its own thread; it connects to the server.
      const clientH=spawn("/xclient",[clientProgname.split("/").pop(),...clientArgv]);
      Module._blinkenlib_run_thread(clientH);
      // Wait for the client thread to finish (or overall timeout).
      const t0=Date.now(); let timedOut=false;
      while(!Module._blinkenlib_thread_done()){
        if(Date.now()-t0>overallTimeoutMs){ timedOut=true; break; }
        await sleep(100);
      }
      const clientCode=Module._blinkenlib_thread_done()?Module._blinkenlib_thread_status():"RUNNING";
      const out=decode(outBytes), err=decode(errBytes);
      return { timedOut,
               client:{ exitCode:clientCode, stdout:out, stderr:err },
               server:{ exitCode:"RUNNING", stdout:out, stderr:err } };
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
