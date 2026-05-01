# Changelog

## [unreleased] — GitHub Pages live demo

- docs/index.html: styled landing + live x86_64 demo. AppShell/Topbar/
  Hero/Section/Status from anentrypoint-design @latest via unpkg (no
  build step). webjsx `h()` for the demo card. Boots the Blink wasm,
  runs hello-x86_64.elf (exit 42, stdout `hi`, rax=0x3c, rdi=0x2a),
  exposes buttons for busybox echo/uname -a/expr 7*6 and a 17_039_360
  byte memory snapshot. State driven by window.__webixDemo.state and
  window.__debug.x86_64 — same contract used by the test suite.
- src/x86_64-witness-bootstrap.js: defineProperty fallback when
  window.__debug already exists as a non-writable getter (the design
  SDK's own debug module owns that key). Without this, the witness
  page errored "Cannot assign to read only property '__debug'" the
  moment the SDK loaded alongside it.
- .github/workflows/pages.yml: build job syncs blinkenlib.{wasm,js},
  hello + busybox ELFs, and the three browser-host JS files from
  src/ into docs/assets/, then deploys ./docs via official Pages
  actions. Triggered on changes under docs/, src/, or any of those
  source binaries.
- .gitignore: docs/assets/ is gitignored — CI repopulates from the
  sources of truth so we don't ship the wasm twice.
- README.md: "Live demo" section + local preview recipe.

## [0.6.2] — Third-pass policy alignment

- blink-core.js: replaced setTimeout(5) busy-wait with deferred Promise
  resolved by the exit/signal callbacks. test.js wall time drops from
  ~5s to ~2.4s. Added a runtime guard ("previous run not yet settled")
  that fails loud on overlapping runElf calls instead of silently
  corrupting shared state.
- blink-core.js: surface a host.capabilities object: { tarMount, nodefs,
  nosock, vectorISA: "sse2" }. Replaces the FS.filesystems sniff in
  test.js with a one-line check.
- test.js: deduped via three module-level constants (ALPINE_TAR, HELLO,
  BUSYBOX_STATIC) and helpers (alpineHost(), guestBytes()). Eight cases
  no longer re-gunzip the same 3.5MB rootfs. Drops from 160L to 141L.
- public/openx86-sw.js (47L) deleted: unwitnessed cache-firsting code
  with no version-bump strategy. Repeat-load caching belongs to the
  deployment server's Cache-Control headers, not to this repo.
- public/x86_64-witness.html: dropped SW registration, added wasm
  preload hint. Browser witness still passes via exec:browser:
  exitCode=42, rax=0x3c, rdi=0x2a, rip=0x4000a4, hasSW=false.
- .gitattributes: `* text=auto eol=lf` + binary markers for
  *.wasm *.elf *.tar.gz *.apk. Ends the recurring CRLF warnings on
  Windows commits.
- .editorconfig: 2-space, LF, UTF-8 across the repo.
- .nvmrc: pins Node 22 for local dev (CI matrix still tests 20+22).
- AGENTS.md: gains "Browser witness pattern" section documenting the
  exec:browser → installWindowDebug → page.evaluate flow, and a
  "Build flag residuals" section noting the POSIX NOJIT NOSOCK build.
- README.md: gains "Run the witness page locally" with a one-line
  static server invocation.
- package.json bumps to 0.6.2; files allowlist drops openx86-sw.js.

# Changelog

## [0.6.1] — Second-pass re-architecture

- src/blink-core.js (142L): shared Blink host core. Tar mount, NODEFS,
  runElf, snapshot/restore, register accessor, runShellScript all live
  here as a dispatch table over a single Module instance.
- src/x86_64-blink.js shrinks from 149L to 22L: just the Node-flavored
  shim (fs.readFileSync + ensureWebEnv + pathToFileURL import).
- src/x86_64-blink-browser.js shrinks to 10L: fetch + factory + delegate.
  Browser host now has FULL parity with Node — snapshot, restore, tar
  mount, runShellScript, NODEFS — for free, via the shared core.
- src/x86_64-witness-bootstrap.js: extracts the witness page boot logic
  (host load, ELF run, register dump, window.__debug.x86_64 install)
  out of inline HTML.
- public/x86_64-witness.html drops from 60L of inline JS to 23L total
  (one import + call). Browser witness passes via puppeteer:
  exitCode=42, stdout="hi\n", rax=0x3c, rdi=0x2a, rip=0x4000a4.
- src/browser.js: dedicated browser entry, no node:fs in its import
  graph. package.json "browser" field + ./browser export point at it.
  Fixes a real bug where importing webix from a browser bundle pulled
  in node:fs through the Node host transitively.
- package.json gains: files allowlist (npm publish ships only src/,
  bin/, public/, blinkenlib.{wasm,js}, README, CHANGELOG, LICENSE,
  NOTICE, AGENTS — not the 4MB rootfs/test-elf bundle), repository,
  homepage, bugs, keywords, author, prepublishOnly:"node test.js".
  Conditional exports: node→index.js, browser→browser.js.
- kernel.js: gains reap(pid) — explicit cleanup. Auto-delete-on-EXIT
  was rejected because test.js asserts the exited process remains
  inspectable in snapshot (POSIX wait() semantics in miniature).
- containers/blink-wrapper.ts (755L upstream reference, never imported,
  imports from non-existent paths) deleted.
- tsconfig.json deleted (no consumer; no typecheck script; no .d.ts).
- AGENTS.md, NOTICE.md added. LICENSE copyright updated to AnEntrypoint
  contributors. NOTICE attributes Blink (ISC), Alpine (GPL-2.0),
  busybox (GPL-2.0), xstate (MIT).
- test.yml: Node 20 + 22 matrix, concurrency.cancel-in-progress.
- 11/11 test.js still pass + browser host now witnessed end-to-end.

# Changelog

## [0.6.0] — Blink-only re-architecture

- Removed: src/cpu.js (804L IA-32 interpreter), src/syscalls.js (767L Linux i386
  ABI), src/jit.js, src/memory.js, src/vfs.js, src/devices.js, src/ext2.js,
  src/runtime.js, src/process-manager.js, src/network.js, src/network-node.js,
  src/overlay-vfs.js, src/package-manager.js, src/persistence*.js, src/pty.js,
  src/rootfs.js, src/snapshot.js, src/tar.js, src/signals.js, src/sync.js,
  src/io.js, src/util.js, src/diagnostics.js, src/cli-runtime.js, src/node.js,
  src/browser_bridge.js, src/xstate-orchestration.js, src/xstate-lite.js.
  All tests/, dist/, samples/, docs/, tools/, assets/. cli.js, sw.js,
  alpine.html, index.html, IMPLEMENTATION_NOTES.md.
- Replaced xstate-lite hand-roll with real `xstate` v5 npm package
  (machines.js wraps actors so getSnapshot returns plain {value,context,status}).
- Slim survivors all <200L per repo policy: elf.js 30L, arch.js 28L,
  machines.js 56L, kernel.js 36L, index.js 6L, bin/xos.mjs 47L.
- Single test.js at root, 11/11 pass against real Blink wasm.
- bin/xos.mjs reduced to run-x86_64 + run-shell. No more i386 boot/shell/run/
  trace/package commands.
- package.json: name → webix, version 0.6.0, scripts trimmed to test + xos,
  exports list ./, ./browser, ./blink, ./blink-browser, ./kernel.

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
