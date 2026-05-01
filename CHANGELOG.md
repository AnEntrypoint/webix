# Changelog

## [unreleased]

- feat(x86_64): NODEFS host-filesystem passthrough — `host.mountNodeDir`
  uses emscripten's built-in NODEFS to expose any host directory at
  `/host` in the guest VFS. Witnessed: `cat /host/numbers.txt` reads
  a real host file via real busybox. CI build now passes
  `-lnodefs.js -lidbfs.js -sFORCE_FILESYSTEM=1` so future rebuilt
  wasms automatically have NODEFS (node) + IDBFS (browser) plugins.
- feat(sw): `public/openx86-sw.js` now cache-firsts `/containers/*`
  + `/src/x86_64-blink*` + `/public/x86_64-witness*` via Cache API.
  Second page load boots without re-downloading the wasm.
- test.js: 11/11 — adds NODEFS round-trip case.

## [unreleased]

- feat(x86_64): host.runShellScript writes quoted scripts to /tmp and
  invokes `sh /path` to bypass Blink's whitespace-only argc parser;
  arbitrary multi-line shell with quoting, vars, arithmetic supported.
- feat(x86_64): host.snapshot()/restore() — byte-exact wasm linear
  memory + register state (RIP, RSP, RAX..R15, RFLAGS) round-trip.
  Mutate then restore confirmed equal across 50MB memory image.
- test(x86_64): SSE2 round-trip (movq xmm0, rdi) exit 0; AVX round-trip
  (VEX-encoded vmovq) traps SIGILL exit 132. Definitive boundary on
  Blink build vector ISA coverage.
- test(x86_64): NOSOCK uname flag confirmed by direct witness — busybox
  nc fails with ENOSYS on socket(AF_INET). Networking is upstream
  Blink build flag, requires emscripten rebuild.
- test(x86_64): test.js now 10/10 integration cases — adds
  runShellScript, snapshot/restore, SSE2-vs-AVX boundary, NOSOCK.

## [unreleased]

- test(x86_64): add root test.js with 6 integration cases covering
  ELF64 dispatch, hand-built hello, kernel API, musl-static busybox
  (echo+uname+expr), alpine dynamic busybox+apk-tools via ld-musl,
  and sh-script with arithmetic from MEMFS. All 6 pass.

## [unreleased]

- feat(x86_64): land Blink-backed x86_64 backend with witnessed
  hello-world. Vendor `jart/blink` wasm via `robalb/x86-64-playground`
  (ISC, 246871 bytes). Add `parseELF64`, `X86_64Architecture`
  (machine=62, ELFCLASS64), `src/x86_64-blink.js` node host,
  `kernel.runX86_64Bytes`, `xos run-x86_64 <file>` CLI. Hand-assembled
  `containers/hello-x86_64.elf` does `write(1,"hi\n",3); exit(42)` via
  the x86_64 syscall instruction; witnessed end-to-end (stdout=`hi\n`,
  exit=42) under both bun/node and a real Chromium tab.
- feat(x86_64): browser-side host (`src/x86_64-blink-browser.js`) +
  witness page (`public/x86_64-witness.html`) expose
  `window.__debug.x86_64` with live RIP/RSP/RAX..R15/RFLAGS register
  snapshot from the Blink cross-language struct after run.
