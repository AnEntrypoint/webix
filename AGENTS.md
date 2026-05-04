# AGENTS.md

Project invariants for agents (and humans) working on webix.

## Architecture

- **Blink owns the CPU/syscall surface.** No JS instruction decoder, no JS
  Linux ABI, no JS VFS. The host module's only job is to feed an ELF in and
  pump signals/exit/registers out.
- **Single test.js at repo root.** No tests/ directory, no fixtures, no
  mocks. test.js exercises Blink+xstate against real ELF and rootfs bytes
  in containers/.
- **<200 lines per file.** If a module grows past 200 lines, split it
  before merging.
- **xstate v5 only** for actor lifecycle. The xstate-lite hand-roll was
  removed in 0.6.0; do not reintroduce.
- **kernel.js never auto-deletes processes.** Processes remain in
  processActors Map after EXIT with value=="exited", implementing POSIX
  wait() semantics. Use kernel.reap(pid) for explicit cleanup. Retention
  is intentional for post-mortem inspection; do not "fix the leak".
- **browser.js is a separate entry point.** package.json conditional
  exports route "." → src/index.js (Node) and "browser" → src/browser.js.
  This split is critical: importing webix in a bundler that previously
  pulled node:fs through src/x86_64-blink.js was a real bug. Do not merge
  browser.js back into the main export.
- **window.__debug.x86_64 shape.** src/x86_64-witness-bootstrap.js exports
  installWindowDebug({wasmUrl, glueUrl, elfUrl, argv, onLog}). Witness
  HTML calls this once; the resulting window.__debug.x86_64 exposes
  {ready, exitCode, stdout, stderr, signal, registers, runElf, pushStdin,
  snapshot}. This is the contract for witness pages using the x86_64 module.

## Do not restore

The following modules were removed in v0.6.0 in favor of upstream Blink
coverage. Do not bring them back without an explicit user instruction:
cpu.js, syscalls.js, jit.js, memory.js, vfs.js, devices.js, ext2.js,
runtime.js, process-manager.js, network.js, network-node.js,
overlay-vfs.js, package-manager.js, persistence*.js, pty.js, rootfs.js,
snapshot.js, tar.js, signals.js, sync.js, io.js, util.js, diagnostics.js,
cli-runtime.js, node.js, browser_bridge.js, xstate-orchestration.js,
xstate-lite.js, bench.js. Plus tests/, dist/, samples/, docs/, tools/,
assets/, cli.js, sw.js, alpine.html, index.html.

## Build the wasm

`gh workflow run build-blink.yml` rebuilds containers/blinkenlib.wasm
from robalb/blink@libblink via emsdk 3.1.69. The default flags include
`-sENVIRONMENT=web,worker,node -lnodefs.js -lidbfs.js -sFORCE_FILESYSTEM=1`
so the same artifact runs in Node and the browser.

## Identity

Commits go in as `lanmower <almagestfraternite@gmail.com>` from local
dev, `github-actions` from CI. The git/GitHub identity discipline is
documented in user CLAUDE.md.

## Learning audit

**Cycle 1 (2026-05-01)**: Baseline audit. Sampled 5 AGENTS.md items
(Blink owns surface, test.js single, <200L per file, xstate v5, do not
restore list). rs-learn was fresh (0 prior ingests). 0 items migrated
(baseline — store must internalize before recall succeeds). 10 new facts
ingested to rs-learn (webix v0.6.1 architecture, kernel, browser split,
npm pack, CI, licenses, deleted files). Next cycle will test recall on
all 10 + re-sample these 5 to measure learning curve.

**Cycle 2 (2026-05-01, webix v0.6.2)**: 7 new facts ingested
(blink-core polling removal, host.capabilities API, service worker
deletion, gitattributes config, test.js dedup pattern, browser-witness
protocol, memorize scope guard). Audit sampled 5 stable AGENTS.md items
(Blink owns surface, test.js single, xstate v5, kernel.reap, browser
entry point). All 5 returned no recall results — rs-learn store is still
populating. Added non-obvious caveat to AGENTS.md: blink-core overlap
guard prevents runElf re-entrance. 0 items migrated this cycle. Store
expected to be ready for recall migrations in Cycle 3.

**Cycle 4 (2026-05-01, gh-pages deploy)**: 6 new facts ingested
(gh-pages live URL + witness, anentrypoint-design SDK shape,
`window.__debug` getter trap, pages workflow layout, Pages enablement
prerequisite, witness-bootstrap base-path gotcha). Re-sampled 5 stable
items (Blink owns surface, single test.js, xstate v5, kernel.reap,
browser entry split) — all 5 still return no recall results. Four
cycles in, no migrations yet; store population continues. Added new
"gh-pages demo (docs/)" section with the two non-obvious deploy
gotchas. 0 items migrated this cycle.

**Cycle 3 (2026-05-01, webix v0.6.2 full validation)**: 6 new facts
ingested (v0.6.2 node+bun parity, CLI verb shapes, witness register
expectations, snapshot key shape, mprotect noise advisory, port-8765
squatter advisory). Re-sampled the same 5 stable items from Cycle 2 —
all 5 still return no recall results. Store population is slower than
hoped; no migrations possible yet. Added two non-obvious caveats below
(emscripten mprotect warnings are benign; port 8765 is squatted on dev
box). 0 items migrated this cycle.


## Live CLI surface limits (v0.6.3 demo, witnessed 2026-05-04)

The in-page busybox shell at `#cli-panel` runs each command as a single
`runElf(['./busybox', applet, ...args])` invocation. The actual reachable
surface, witnessed against the POSIX NOJIT NOSOCK build:

- **argv space-joined upstream.** `blink-core.writeStr(argcPtr, argv.join(' '))`
  means single-token args only. Quoted args lose grouping at the wasm boundary;
  `printf 'FB %d\n' 4` becomes `printf FB %d\n 4`.
- **No pipes.** `pipe()` returns EBADF — `echo hi | wc -c` fails with
  `can't create pipe: Bad file descriptor`. Disqualifies sh-with-pipelines,
  loops needing temp files, redirection.
- **No FS persistence across runElf.** `/tmp/marker` written in run 1 is
  gone in run 2 even via direct `FS.readFile`. Treat the emscripten FS as
  ephemeral per call — each runElf is its own fresh boot.
- **Banner prefix.** stdout always begins with `\n$ ./busybox <argv>\n`
  before applet output. The CLI strips it.
- **Working applets witnessed live in the page**: `ls`/`ls -la`, `echo`,
  `uname -a`, `date`, `id`, `expr`, `printf`, `env`, `cal`, `--list`, bare
  `busybox` (usage). Failing: anything reading `/proc/*` (proc unmounted),
  `whoami` (no /etc/passwd), `seq` (signal 132, AVX-ish), pipes/loops/redirects.

## Display residual (v0.6.3)

The display panel paints into a `<canvas>` via two parsers — ANSI tty
(SGR colors, cursor reset) and an FB pixel protocol (`FB <w> <h>\n<base64
rgba>\n`). The parsers and a JS-side demo frame are real and witnessed
(`getImageData` returns a non-uniform gradient). What is **residual**:

- No real X server. Build is NOJIT NOSOCK; no `/dev/fb0`, no mmap surface
  exposed by blinkenlib, no shared linear memory window for the guest.
- No guest-driven framebuffer emitter. argv space-joining + missing
  `pipe()` mean a busybox-shell-only program cannot construct the
  `FB W H\n<base64>\n` byte stream from inside the wasm. Fixing this
  requires either (a) a custom static ELF that writes pre-baked pixel
  data to stdout, or (b) lifting the build flags to enable pipes.

## Witness host gotchas (v0.6.2)

- **emscripten mprotect noise.** Running musl-static busybox prints
  `warning: unsupported syscall: __syscall_mprotect` repeatedly. Benign
  with the POSIX NOJIT NOSOCK build — do not chase as a regression.
- **Port 8765 is frequently squatted** on the dev box by a background
  `python -m http.server`. Use 9123 (or any other free port) for the
  static-server step in the browser witness flow.
- **Bun parity.** `bun test.js` passes 11/11 alongside Node 23.10.0 —
  file:// dynamic import + emscripten glue + wasm load all work in Bun
  1.3.8 without modification. Both runtimes are first-class for tests.

## gh-pages demo (docs/)

webix ships a live demo at https://anentrypoint.github.io/webix/ via
`.github/workflows/pages.yml`. The build step copies
`containers/blinkenlib.{wasm,js}`, the hello/busybox/sse2-test ELFs,
and `src/{blink-core,x86_64-blink-browser,x86_64-witness-bootstrap}.js`
into `docs/assets/` (gitignored — repopulated by CI). The page mounts
the design SDK via `installStyles()` + `mount(...)` and renders
`C.AppShell` with hero / live-witness / acid / architecture /
what-runs / quickstart panels — same `window.__debug.x86_64` contract
the test suite asserts against. Two non-obvious caveats discovered
during the v0.6.2 deploy (re-witnessed v0.6.3 redesign — both still
hold):

- **anentrypoint-design installs `window.__debug` as a non-writable
  getter** at module load. Code that does
  `window.__debug = window.__debug ?? {}` throws "Cannot assign to read
  only property '__debug'". Use
  `if(!window.__debug) Object.defineProperty(window,"__debug",{value:{},writable:true,configurable:true})`
  then assign sub-keys (`.x86_64`) onto it.
- **witness-bootstrap defaults are absolute (`/containers/...`)** and
  break under `/webix/` on gh-pages. The demo page must pass explicit
  URLs via `new URL('./assets/X', document.baseURI).href` so the dynamic
  glue import inside `x86_64-blink-browser.js` doesn't double-resolve.
- **First-time setup**: `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`
  must run before the first push, or the deploy job fails.

## Browser witness pattern

Edits to browser-facing code (`public/*.html`, `src/x86_64-blink-browser.js`,
`src/x86_64-witness-bootstrap.js`, `src/browser.js`) must be witnessed via
`exec:browser` in the same turn as the edit:

1. Spin a static server (any will do; `exec:nodejs` http server works).
2. `page.goto("http://localhost:PORT/public/x86_64-witness.html")`.
3. `page.waitForFunction(() => window.__debug?.x86_64?.ready === true)`.
4. `page.evaluate(() => window.__debug.x86_64)` — assert
   `exitCode===42`, `registers.rax==="3c"`, `registers.rdi==="2a"`.

The witness page surface lives at `installWindowDebug` in
`src/x86_64-witness-bootstrap.js`. Don't duplicate the host-load /
register-dump logic into other pages — extend that module instead.

## blink-core polling removed (v0.6.2+)

`runElf()` in blink-core no longer polls. Instead it returns a deferred
Promise that resolves when exit/signal callbacks fire. Wall time for full
test.js dropped from ~5s to ~2.4s as a side effect.

**Critical**: A guard `if(exitDeferred) throw new Error("blink-core: previous
run not yet settled")` now prevents overlapping `runElf()` calls. Overlapping
runs were always unsafe (shared mutable stdoutBuf, lastSignal, lastExitCode
across calls) but used to corrupt silently. Now they fail loud. If test.js
calls runElf in a loop, ensure each Promise settles before the next call.

## Build flag residuals (Blink wasm)

The vendored `containers/blinkenlib.wasm` is built `POSIX NOJIT NOSOCK`:

- AVX/AVX-512 traps SIGILL — only SSE2 verified. Test
  `containers/sse2-test.elf` succeeds; `avx-test.elf` returns 132.
- `socket(AF_INET)` returns ENOSYS. Test asserts this directly.
- pthread_create — single-threaded.

These are upstream-Blink-build concerns, not host work. To unblock,
use `gh workflow run build-blink.yml` with a different blink_repo
fork patched for sockets/threads/AVX.
