# webix

Blink-backed x86_64 Linux userspace emulator. Browser + Node. A compact host over a Blink wasm that owns CPU, MMU, ~150 Linux x86_64 syscalls, signals, threads, and AF_INET/UNIX/INET6 sockets. (No `fork()` — emscripten has none — so full shell pipelines are out; everything else is upstream Blink.)

Replaces what most projects in this category hand-roll: no JS instruction decoder, no JS syscall ABI, no JS VFS — Blink upstream owns all three. The host's job is to feed an ELF in and pump signals/exit out.

## Install

```bash
npm install
npm test    # 18/18 integration cases against real busybox/apk via Blink
```

## CLI

```bash
node bin/xos.mjs run-x86_64 containers/hello-x86_64.elf
node bin/xos.mjs run-shell containers/busybox-x86_64.elf script.sh
```

## Library

```js
import { createBlinkHost } from "webix";

const host = await createBlinkHost({});
const r = await host.runElf(elfBytes, { argv: ["hello"] });
// { exitCode, stdout, stderr, signal }

host.mountTarBytes(alpineRootfsTarBytes);
const r2 = await host.runElf(host.Module.FS.readFile("/bin/busybox"), { argv: ["ls", "/etc"] });
```

Browser variant in `./blink-browser`. Witness page at `public/x86_64-witness.html` exposes `window.__debug.x86_64` with live RIP/RSP/RAX..R15 register snapshot.

## Architecture

```
src/elf.js                       ELF32/ELF64 header parse — 30L
src/arch.js                      I386/X86_64 architecture dispatch — 28L
src/blink-core.js                createBlinkCore: boot, runElf, snapshot — 192L
src/blink-core-helpers.js        X-server FS/proxy-pump + rootfs extraction — 79L
src/blink-core-boot.js           Wasm factory boot + preemption resume — 92L
src/blink-core-mem.js            WASM linear-memory buffer accessor — 14L
src/blink-core-io.js             argv writers + register accessor — 61L
src/blink-core-fb.js             Framebuffer accessors (fbInfo/fbView) — 138L
src/blink-core-x.js              Persistent X-server run model — 65L
src/x86_64-blink.js              Node host shim — 22L
src/x86_64-blink-browser.js      Browser host shim — 10L
src/x86_64-witness-bootstrap.js  installWindowDebug helper — 25L
src/index.js                     Node entry — 4L
src/browser.js                   Browser entry (no node:fs) — 6L
test.js                          Single integration suite — <200L
```

No bespoke runtime — the i386 interpreter, custom VFS, syscall dispatcher, and tar/package layers were removed in favor of Blink's upstream coverage. `createBlinkHost` is the only orchestration layer; the earlier XState kernel/process/scheduler actor wrapping (src/kernel.js, src/machines.js) was removed as unused indirection over runElf that the browser demo/CLI never exercised.

## Witnessed coverage

18/18 integration cases in `test.js`:
ELF64 dispatch · hand-built hello (exit 42) · musl-static busybox (echo/uname/expr) · alpine dynamic /bin/busybox + /sbin/apk via ld-musl · multi-line sh script from MEMFS · runShellScript · byte-exact snapshot/restore of wasm memory + registers · SSE2 round-trip · AVX SIGILL boundary · NODEFS host passthrough · sockets enabled · multi-word argv survival · pipe() syscall · framebuffer getters + pipeline · preloadFile handle reuse · apk add extraction (JS-driven + real multi-member) · apk info/list.


## Live demo

GitHub Pages: <https://anentrypoint.github.io/webix/> — boots the Blink wasm
in your tab, runs `hello-x86_64.elf` (exit 42, stdout `hi`), and lets you
fire busybox commands and snapshot 16MB of linear memory + register state
live. Styled via [`anentrypoint-design`](https://github.com/AnEntrypoint/Design)
@latest from unpkg, no build step.

The page source is `docs/index.html`. The deploy workflow at
`.github/workflows/pages.yml` syncs `containers/blinkenlib.{wasm,js}`,
`containers/{hello,busybox}-x86_64.elf`, and the three browser-host JS
files from `src/` into `docs/assets/` before publishing.

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

To preview the styled `docs/index.html` locally, sync the assets first:

```bash
mkdir -p docs/assets
cp containers/{blinkenlib.wasm,blinkenlib.js,hello-x86_64.elf,busybox-x86_64.elf} docs/assets/
cp src/{blink-core.js,x86_64-blink-browser.js,x86_64-witness-bootstrap.js} docs/assets/
# then point the snippet above at /docs/index.html instead of /public/x86_64-witness.html
```

`docs/assets/` is gitignored — CI repopulates it on every push.

## Build-flag residuals

This is the threaded, sockets-enabled, framebuffer-capable `portabox` Blink build (see `blink-core.js` capabilities). Genuine residuals require an emscripten rebuild of `jart/blink`:

- AVX/AVX-512 — currently SIGILL (SSE2 only).
- `fork()`/full shell pipelines — emscripten has no fork(), so `sh -c 'a | b'` cannot spawn stages (pipe() itself works).
- JIT — structurally impossible under wasm32; NOJIT is permanent in-browser.

`.github/workflows/build-blink.yml` rebuilds blinkenlib.wasm on demand.

## Clean-room boundary

Independent reimplementation of the *host* surface around an unmodified Blink upstream wasm. Does not contain or reverse-engineer CheerpX internals.

## License

MIT (this repo). Blink upstream is ISC.
