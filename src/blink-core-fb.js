// blink-core-fb.js — framebuffer accessors (fbInfo/fbView) for a blink-core
// Module instance. Split out of blink-core.js to keep it under the repo's
// <200-line-per-file cap; the only shared state (fbRgbaBuf, the page-pointer
// cache) is private to this factory's closure, one instance per Module.

import { memBuffer } from "./blink-core-helpers.js";

// Framebuffer geometry + a page-pointer-cached, tight-packed RGBA pixel view
// over a blink Module's guest framebuffer (published via the synthetic 0x5fb
// syscall, mapped zero-copy through spy_address(fb_vaddr)).
export function createFbAccessors(Module){
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
  // Reusable output buffer when the caller doesn't supply its own destination.
  let fbRgbaBuf=null;
  // Cache of page-index -> host pointer for the CURRENT (vaddr, generation)
  // mapping. Guest fb pages rarely remap between frames (the same mmap'd
  // buffer is reused every paint), so re-querying spy_address for every page
  // every frame is ~(stride*height/4096) wasted wasm calls (e.g. ~470 for an
  // 800x600x4 frame) once the mapping is known to be stable. Invalidated
  // whenever the fb geometry's generation changes (a real remap/re-register)
  // OR the wasm memory buffer's byteLength changes (ALLOW_MEMORY_GROWTH can
  // move/resize the backing buffer, which can shift page->host mappings).
  let fbPageCache=null; // Map<pageIndex, hostPtr>
  let fbPageCacheKey=null; // `${base}:${generation}:${byteLength}`
  function pageCacheFor(base, generation){
    const byteLength=memBuffer(Module).byteLength;
    const key=`${base}:${generation}:${byteLength}`;
    if(fbPageCacheKey!==key){ fbPageCache=new Map(); fbPageCacheKey=key; }
    return fbPageCache;
  }
  // Return the guest framebuffer pixels as a contiguous, tight-packed RGBA
  // Uint8ClampedArray (stride === width*4 always, regardless of guest stride).
  //
  // IMPORTANT: blink's SpyAddress (memory.c LookupAddress2) returns a host
  // pointer valid only for the 4096-byte PAGE containing the queried vaddr --
  // guest pages map to arbitrary, non-contiguous host pages. A single
  // spy_address(fb_vaddr) is therefore valid for just the first 4KB; reading
  // stride*height contiguously past that returns unrelated host memory (this
  // was the "framebuffer goes black past the first page" bug). So we COPY the
  // framebuffer page-by-page: for each 4KB span we re-query spy_address to get
  // that page's host pointer and copy it directly into the destination.
  //
  // destRgba (optional): a caller-supplied Uint8Array/Uint8ClampedArray of
  // exactly width*height*4 bytes (e.g. ImageData.data) to write into instead
  // of the internal fbCopyBuf, fusing the page copy with the caller's own
  // copy and eliminating a full extra frame-sized memcpy on every blit.
  function fbView(destRgba){
    const info=fbInfo(); if(!info) return null;
    const vaddr=Module._blinkenlib_get_fb_vaddr(); // u64; may arrive signed
    // normalize a possibly-signed 32-bit marshalled vaddr to unsigned
    const base=vaddr<0?vaddr>>>0:vaddr;
    if(!base) return null;
    const { width:w, height:h, stride:srcStride } = info;
    const bpp=w>0?srcStride/w:4;
    const tightStride=w*4;
    const outLen=tightStride*h;
    const out = destRgba && destRgba.length===outLen ? destRgba
      : (fbRgbaBuf&&fbRgbaBuf.length===outLen ? fbRgbaBuf : (fbRgbaBuf=new Uint8ClampedArray(outLen)));
    const PAGE=4096;
    // The framebuffer belongs to the VM that registered it (the X server runs
    // on its own pthread). spy_address resolves against the CALLER thread's
    // _Thread_local machine, which on the host's main-thread blit is a
    // different/null VM -> returns 0 and the fb reads all-zero under a live X
    // server. fb_spy_address resolves against the registering machine
    // (fb_machine, captured at fb_register), so a worker-VM framebuffer is
    // readable from the main thread. Prefer it; fall back to spy_address for an
    // older wasm that predates the cross-VM fix (single-VM apps still resolve).
    const spyRaw = typeof Module._blinkenlib_fb_spy_address==="function"
      ? (v)=>Module._blinkenlib_fb_spy_address(v)
      : (v)=>Module._blinkenlib_spy_address(v);
    // Cache page-index -> host pointer for this (vaddr, generation, memory
    // byteLength) triple. Guest fb pages rarely remap between paints, so the
    // cache turns ~(stride*height/4096) wasm calls/frame into ~0 after the
    // first frame at a given geometry -- only a real remap (generation bump)
    // or a memory-growth event evicts it (see pageCacheFor).
    const pageCache=pageCacheFor(base, info.generation);
    const spy=(addr)=>{
      const pageIdx=addr>>>12; // addr / 4096, unsigned
      let host=pageCache.get(pageIdx);
      if(host===undefined){ host=spyRaw(addr); pageCache.set(pageIdx, host); }
      return host;
    };
    // One page-wise pass reads each guest page once and writes straight into
    // `out`, handling stride (16bpp RGB565 vs 32bpp RGBX) and any row padding
    // in the same loop -- no separate fbCopyBuf intermediate, no second pass.
    const srcLen=srcStride*h;
    let off=0;
    while(off<srcLen){
      const host=spy(base+off);
      const chunk=Math.min(PAGE-((base+off)&(PAGE-1)), srcLen-off);
      if(host){
        const page=new Uint8Array(memBuffer(Module), host, chunk);
        let p=0;
        while(p<chunk){
          const srcOff=off+p;                 // byte offset within the guest fb
          const y=(srcOff/srcStride)|0;
          const xByte=srcOff-y*srcStride;      // byte offset within the row
          if(bpp===2){
            // RGB565: consume 2 src bytes -> 4 dst bytes per pixel.
            if(xByte>=w*2){ p+=srcStride-xByte; continue } // row padding, skip to next row
            const x=(xByte/2)|0;
            if(p+1>=chunk){ p++; continue } // pixel split across a page boundary: picked up next chunk
            const lo=page[p], hi=page[p+1];
            const v=lo|(hi<<8);
            const r=(v>>11)&0x1f, g=(v>>5)&0x3f, b=v&0x1f;
            const di=y*tightStride+x*4;
            out[di]=(r*527+23)>>6;     // r5 -> r8
            out[di+1]=(g*259+33)>>6;   // g6 -> g8
            out[di+2]=(b*527+23)>>6;   // b5 -> b8
            out[di+3]=255;
            p+=2;
          } else {
            // 32bpp (or any >=4 bytes/px): copy the tight-width run of this
            // page-chunk in one set(), skip any trailing stride padding.
            if(xByte>=tightStride){ p+=srcStride-xByte; continue }
            const runLen=Math.min(tightStride-xByte, chunk-p);
            const di=y*tightStride+xByte;
            out.set(page.subarray(p,p+runLen), di);
            p+=runLen;
          }
        }
      }
      off+=chunk;
    }
    return { ...info, width:w, height:h, stride:tightStride, bpp:4, pixels:out };
  }
  return { fbInfo, fbView };
}
