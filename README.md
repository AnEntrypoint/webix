# webix

Blink-backed x86_64 Linux userspace emulator. Browser + Node. ~280 lines of host code over a 240KB Blink wasm that owns CPU, MMU, ~150 Linux x86_64 syscalls, signals, fork/clone, and AF_INET/UNIX/INET6.

Replaces what most projects in this category hand-roll: no JS instruction decoder, no JS syscall ABI, no JS VFS — Blink upstream owns all three. The host's job is to feed an ELF in and pump signals/exit out.

## Install

```bash
npm install
npm test    # 11/11 integration cases against real busybox/apk via Blink
```

## CLI

```bash
node bin/xos.mjs run-x86_64 containers/hello-x86_64.elf
node bin/xos.mjs run-shell containers/busybox-x86_64.elf script.sh
```

## Library

```js
import { createKernel, createBlinkHost } from "webix";

const kernel = createKernel({});
const r = await kernel.runX86_64Bytes(elfBytes, { argv: ["hello"] });
// { pid, exitCode, stdout, stderr, signal }

const host = await createBlinkHost({});
host.mountTarBytes(alpineRootfsTarBytes);
const r2 = await host.runElf(host.Module.FS.readFile("/bin/busybox"), { argv: ["ls", "/etc"] });
```

Browser variant in `./blink-browser`. Witness page at `public/x86_64-witness.html` exposes `window.__debug.x86_64` with live RIP/RSP/RAX..R15 register snapshot.

## Architecture

```
src/elf.js                       ELF32/ELF64 header parse — 30L
src/arch.js                      I386/X86_64 architecture dispatch — 28L
src/machines.js                  XState 5 kernel/process/scheduler actors — 56L
src/kernel.js                    XOSKernel — Blink host + actor lifecycle — 43L
src/blink-core.js                Shared Blink core: tar, snapshot, runElf, runShellScript — 142L
src/x86_64-blink.js              Node host shim — 22L
src/x86_64-blink-browser.js      Browser host shim — 10L
src/x86_64-witness-bootstrap.js  installWindowDebug helper — 25L
src/index.js                     Node entry — 4L
src/browser.js                   Browser entry (no node:fs) — 6L
test.js                          Single integration suite, 11 cases — <200L
```

XState 5 (real npm package) drives the kernel/process/scheduler state machines. No bespoke runtime — the i386 interpreter, custom VFS, syscall dispatcher, and tar/package layers were removed in favor of Blink's upstream coverage.

## Witnessed coverage

11/11 integration cases in `test.js`:
ELF64 dispatch · hand-built hello (exit 42) · kernel API + ProcessActor · musl-static busybox (echo/uname/expr) · alpine dynamic /bin/busybox + /sbin/apk via ld-musl · multi-line sh script from MEMFS · runShellScript · byte-exact snapshot/restore of wasm memory + registers · SSE2 round-trip · AVX SIGILL boundary · NODEFS host passthrough · NOSOCK ENOSYS witness.


## Run the witness page locally

The browser host runs in any static server. The wasm must be served with
`Content-Type: application/wasm` (most servers infer this from the
extension; check yours if you see `MIME type ... is not supported`).

```bash
node -e 'const http=require("http"),fs=require("fs"),path=require("path"); \
  const m={".html":"text/html",".js":"text/javascript",".wasm":"application/wasm",".elf":"application/octet-stream"}; \
  http.createServer((q,r)=>fs.readFile(path.resolve("."+q.url.split("?")[0]),(e,d)=>{ \
    if(e){r.writeHead(404);r.end()} \
    else{r.writeHead(200,{"content-type":m[path.extname(q.url).toLowerCase()]||"application/octet-stream"});r.end(d)}})) \
  .listen(8000,()=>console.log("http://localhost:8000/public/x86_64-witness.html"))'
```

Open the URL and inspect `window.__debug.x86_64` in DevTools — it
exposes `exitCode`, `stdout`, `stderr`, hex `registers`,
`runElf(bytes, opts)`, `pushStdin(bytes)`, `snapshot()`.

## Build-flag residuals

This Blink build is `POSIX NOJIT NOSOCK`. Genuine residuals require an emscripten rebuild of `jart/blink`:

- AVX/AVX-512 — currently SIGILL.
- TCP/UDP networking — `socket(AF_INET)` returns ENOSYS.
- pthread_create — single-threaded build.

`.github/workflows/build-blink.yml` rebuilds blinkenlib.wasm on demand.

## Clean-room boundary

Independent reimplementation of the *host* surface around an unmodified Blink upstream wasm. Does not contain or reverse-engineer CheerpX internals.

## License

MIT (this repo). Blink upstream is ISC.
