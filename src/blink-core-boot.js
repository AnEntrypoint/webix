// blink-core-boot.js — emscripten factory boot sequence + cooperative
// preemption resume scheduling for blink-core.js's createBlinkCore. Split
// out to keep blink-core.js under the repo's <200-line-per-file cap.

import { memBuffer } from "./blink-core-mem.js";

const BLINK_PREEMPT=40, BLINK_FAKE_TTY=42, SIGTRAP=5;

// MessageChannel-based "fresh stack" scheduler: posting to a MessageChannel
// port resolves on a fresh macrotask, same as setTimeout(0), but browsers do
// NOT clamp it to ~4ms after repeated nesting (the classic setTimeout(0)
// clamp). For a guest that preempts every MAX_CYCLES, that clamp otherwise
// halves-or-worse effective guest throughput once nesting depth grows. Only
// schedule() is used (queueMicrotask would starve rAF/input entirely since it
// never yields to a real macrotask boundary).
function makeFreshStackScheduler(){
  const { port1, port2 } = new MessageChannel();
  const queue=[];
  port1.onmessage=()=>{ const fn=queue.shift(); if(fn) fn(); };
  return (fn)=>{ queue.push(fn); port2.postMessage(0); };
}

// Boot the emscripten factory into a running Module, wire the signal/exit
// callbacks (settleExit + cooperative-preemption resume), and wait until the
// wasm linear-memory buffer is reachable.
//
// `io` bundles the stdout/stdin plumbing this needs to set up FS.init:
// stdinQueue (array, popped for stdin), pushOut(charCode), pushErr(charCode).
// Returns { Module } once booted; the caller's own settleExit-equivalent is
// invoked via onSettle(code), and onSignal({sig,code}) records a fault.
export async function bootBlinkModule({ wasmBinary, factory, options, io, onSettle, onSignal }){
  const factoryArgs={
    noInitialRun:true,
    preRun:(M)=>{
      M.FS.init(
        ()=>io.stdinQueue.length?io.stdinQueue.pop():null,
        (c)=>{ if(c!==null){ io.pushOut(c); options.onStdout?.(c) } },
        (c)=>{ if(c!==null){ io.pushErr(c); options.onStderr?.(c) } }
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
  // paused) and schedule the resume on a fresh stack.
  //
  // Use MessageChannel (un-clamped) for most resumes so a long-running guest
  // doesn't lose most of its wall-clock to the browser's ~4ms setTimeout(0)
  // nesting clamp -- but fall back to a real setTimeout every RAF_BREATHE_EVERY
  // slices so rAF/input callbacks (which are lower priority than message-port
  // macrotasks under sustained back-to-back scheduling) still get a turn.
  const RAF_BREATHE_EVERY=32;
  let resumeTick=0;
  let exited=false;
  const scheduleFreshStack=makeFreshStackScheduler();
  const doResume=()=>{ if(!exited){ try{ Module._blinkenlib_preempt_resume() }catch(e){ settleExit(255) } } };
  const resumeSoon=()=>{
    if(exited) return;
    resumeTick=(resumeTick+1)%RAF_BREATHE_EVERY;
    if(resumeTick===0) setTimeout(doResume,0);
    else scheduleFreshStack(doResume);
  };
  function settleExit(code){ exited=true; onSettle(code); }
  const signalCb=Module.addFunction((sig,code)=>{
    if(sig!==SIGTRAP){ onSignal({sig,code}); settleExit(128+sig); return }
    if(code===BLINK_PREEMPT) resumeSoon();
    else if(code===BLINK_FAKE_TTY){ if(options.onTtyPause) options.onTtyPause(); else Module._blinkenlib_faketty_resume() }
  },"vii");
  const exitCb=Module.addFunction((code)=>{ settleExit(code) },"vi");
  Module.callMain([signalCb.toString(), exitCb.toString()]);
  return { Module };
}
