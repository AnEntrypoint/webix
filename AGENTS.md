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

Cycles 1-4 (2026-05-01, v0.6.1→v0.6.2) drained to rs-learn — 29 facts
ingested, 0 migrated (store still populating; recall on the 5 stable
sampled items returned nothing). Full per-cycle detail is in recall
memory (`mem-1779967657135-1-897`). The non-obvious caveats those cycles
surfaced live in their own sections below.

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

## apk add <name> — same-origin bundled repo (v0.6.9, witnessed 2026-05-28)

`apk add nano` (bare name) is supported via a **same-origin bundled repo**,
NOT a live mirror. Alpine mirrors send **no CORS headers** (verified: dl-cdn,
the official Fastly CDN `alpine.global.ssl.fastly.net`, uk, clarkson all lack
`access-control-allow-origin` even with an `Origin` header), and public CORS
proxies are unreliable — so a static gh-pages page cannot fetch the real repo.
Instead, curated `.apk` files + `manifest.json` are vendored into
`docs/assets/apk/` (committed; un-ignored via `docs/assets/apk/**` since CI
can't fetch them). `alpine-apk.js` `addByName(name,{baseUrl})` loads the
manifest, resolves the name or a provide-token (`cmd:`/`so:`), installs
`depends` first (`so:`/`cmd:`/`pc:` tokens not in the manifest are assumed
satisfied by the mounted base rootfs), fetches each `.apk` same-origin,
idempotent via `isInstalled`. `cli.js`: bare name → `addByName`, `.apk`
filename/URL → `addUrl`. **To add a package**: download its `.apk` + dep
closure from dl-cdn into `docs/assets/apk/`, add manifest entries
`{version,file,provides,depends}`, commit. Witnessed: `apk add nano` installs
nano + libncursesw + ncurses-terminfo-base and the extracted `/usr/bin/nano`
runs `nano --version` → exit 0. The format helpers were split into
`src/apk-format.js` to stay under the 200-line cap (pages.yml `cp`s it).

**CORS-witnessing gotcha**: the Playwright/automated chromium runs with web
security disabled, so a cross-origin `fetch()` returns `type:"basic"` 200 (a
FALSE POSITIVE for CORS). Verify real CORS with `curl -I -H Origin` from the
shell, never the test browser.

## Alpine apk install (v0.6.4, witnessed 2026-05-28)

The gh-pages demo can install from the Alpine package ecosystem. Because
the build is NOSOCK (socket ENOSYS), single-threaded, and pipe()=EBADF,
the **real apk-tools binary cannot fetch over the network or spawn its
child stages** in-page. apk is therefore implemented JS-side in
`src/alpine-apk.js`:

- **`createApk(host, {root, fetchImpl})`** returns `{addBytes, addUrl,
  info, list, isInstalled}`. A `.apk` is a gzip tarball; "add"
  decompresses it and extracts members into `host.Module.FS` (the same
  mounted alpine minirootfs), then records the package in
  `/lib/apk/db/installed`. No guest fork/pipe/socket needed.
- **Real apk v2 files are CONCATENATED gzip members** (`[signature?]`
  `[control.tar.gz][data.tar.gz]`). Chrome's `DecompressionStream("gzip")`
  errors "Failed to fetch" on the trailing member instead of continuing.
  `gunzip()` in alpine-apk.js handles this: try the whole buffer as one
  stream, and on failure walk gzip-magic (`1f 8b 08`) member starts,
  inflate each separately, concat outputs. Node's `zlib.gunzipSync`
  handles concatenation natively; the browser path needs the member walk.
- **Witnessed live**: `apk add busybox-static.apk` on the demo page
  installs `busybox-static 1.36.1-r31`, extracts `bin/busybox.static`
  into the rootfs, and `apk list` shows it. The CLI intercepts `apk`
  tokens in `cli.js` `execApk` BEFORE the busybox argv-join path, so apk
  subcommands never cross the wasm argv boundary (immune to space-join).
- `installWindowDebug({rootfsUrl})` mounts the rootfs and exposes
  `window.__debug.x86_64.apk`. Without `rootfsUrl`, `apk` is null and the
  CLI reports "apk unavailable: rootfs not mounted".

## Browser performance (v0.6.4)

- **Streaming compile + Cache API.** `x86_64-blink-browser.js` now passes
  an emscripten `instantiateWasm` hook that uses
  `WebAssembly.instantiateStreaming` when the wasm Response is
  `application/wasm`, with an arrayBuffer fallback. The wasm Response is
  cached in `caches.open("webix-wasm-v1")` so repeat visits skip the
  network. Test/Node path still passes raw `wasmBinary`.
- **Byte-buffered stdout/stderr.** `blink-core.js` collects output bytes
  into arrays and `TextDecoder`-decodes once at run end, replacing the
  per-char `String.fromCharCode` concat that was O(n^2) for large output.
- **preloadFile / handle reuse.** `host.preloadFile(name, bytes)` caches
  ELF bytes by handle; `runElf(null, {path:handle})` skips the per-call
  FS write when `lastLoaded===handle`. blink always execs `/program`, so
  the handle controls what bytes sit there, not an arbitrary exec path.

## FS persistence correction (supersedes the "No FS persistence" note above)

The "No FS persistence across runElf" bullet in the Live CLI section
describes the *busybox CLI's* fresh-write-per-invocation pattern, NOT the
host. The blink host is a **singleton** (`installWindowDebug` creates it
once; `runElf` reuses it), so the emscripten FS **does persist across
runElf calls within a page session**. This is why JS-driven apk install
works: extracted files survive into later runs. Cross-reload persistence
still needs an explicit IDBFS mount (`-lidbfs.js` is compiled in but no
`FS.mount`/`syncfs` is wired yet).

## Hero text correction (v0.6.4)

The old `docs/index.html` hero claimed the wasm owns "fork/clone, and
AF_INET/UNIX/INET6". This contradicted `blink-core.js`
`capabilities:{nosock:true}` and the NOSOCK build. Corrected to state
"POSIX NOJIT NOSOCK single-threaded: sse2 only, sockets return ENOSYS".
Keep marketing copy in sync with `capabilities`.

## Jank-fix pass (v0.6.5, witnessed 2026-05-28)

A page-polish sweep of the gh-pages demo. The fork/clone false claim was
NOT isolated to the hero — `featuresPanel` item 1 ("blink owns the cpu
surface") carried the SAME lie (`fork/clone, mmu, AF_INET/UNIX/INET6`).
**Lesson: marketing copy lives on multiple surfaces** (hero `p`, features
RowLink desc, examples desc, chips). When you correct a claim, grep the
whole page for every restatement. README.md and src/*.js were already
clean; the only remaining tree-wide matches are the vendored
`blinkenlib.js` and this documented note.

Other jank found + fixed, each browser-witnessed live:

- **Broken nav anchor.** Topbar "architecture" → `#architecture` but no
  element had that id (`featuresPanel`'s Panel was unwrapped). Wrapped it
  in `h('div',{id:'architecture'}, C.Panel(...))`. Witness `archExists`
  false → true.
- **Stale test count.** Hero chip + features said "11/11"; the suite is
  now 15/15. Witness `has11:false has15:true`.
- **REPL polish.** CLI input did not refocus after Enter and the terminal
  did not auto-scroll. Added `inputRef.focus()` + `scrollTermToBottom()`
  via `requestAnimationFrame` on submit and on each `onLine`. Witness
  `repl.refocused:true atBottom:true`.
- **Canvas aspect squash.** `.wb-canvas` was `width:100%;height:280px`
  with a 640×280 buffer — squashed on narrow screens. Switched to
  `aspect-ratio:640/280;height:auto`. Witness mobile canvas 259×113,
  `canvasAspectOk:true` (was 259×280).
- **Theme support.** A pre-paint inline script sets `data-theme` from
  `localStorage` then `prefers-color-scheme`; a dark/light toggle button
  persists the choice. canvas2d can't read CSS vars, so `display.js`
  resolves `--panel-2` via `getComputedStyle`.
- **Loading skeleton.** `<div id=app>loading…</div>` → shimmer skeleton
  (`.wb-boot`/`.wb-skel`) replaced by `mount` on ready.
- **Empty-state + token cleanup.** Bare parentheticals unified under a
  `.wb-empty` class; stderr reds routed through `var(--danger,…)`.

apk add/list still witnessed installing `busybox-static 1.36.1-r31`
(4 files) after the UX copy changes, via the `window.__debug.x86_64.apk`
contract.

## Live gh-pages was BROKEN; CI asset-sync must cover the full import graph (v0.6.6, witnessed 2026-05-28)

Validating the live URL `https://anentrypoint.github.io/webix/` found it
**completely dead**: `window.__debug` was `undefined`, wasm never booted,
because `assets/alpine-apk.js` returned **404**. `pages.yml`'s asset-sync
copied `x86_64-witness-bootstrap.js` but not `alpine-apk.js` — and the
bootstrap `import`s `./alpine-apk.js` (added in the v0.6.4 apk work). A 404
on any ES-module import **aborts the whole module graph**, so the page's
loader never ran and the entire demo was inert. The v0.6.4/0.6.5 work was
witnessed against a *local* server (which had every file) and never
re-witnessed against the live deploy.

**Lesson: when you add an `import` to any file CI copies into `docs/assets/`,
add the imported file to `pages.yml`'s `cp` list in the same change.** The
sync list must cover the transitive closure of the page's module graph, not
just the entry points. The full set the page needs:
`x86_64-witness-bootstrap.js` → `x86_64-blink-browser.js`, `blink-core.js`,
`alpine-apk.js`; plus runtime assets `alpine-minirootfs-x86_64.tar.gz` and
`busybox-static.apk` (referenced by `rootfsUrl` and the `apk add` button —
both were also missing from the cp list). `cli.js`/`display.js` are the only
`docs/assets/*` files committed to git (gitignore exception); everything else
is repopulated by CI from `src/`+`containers/`, so a missing `cp` line = a
guaranteed live 404 that local witnessing cannot catch.

Fix witnessed by serving the corrected `docs/` locally and asserting the
contract: `ready:true exitCode:42 rax:3c rdi:2a apkPresent:true`,
`failures:[]` (zero 404s), CLI `echo hi there → exit 0`, and
`apk.addUrl(busybox-static.apk)` taking the installed list 0→1. Also fixed a
stale `C.Status` count (`11/11`→`15/15`) the v0.6.5 sweep missed.

## anentrypoint-design SDK gotchas (de-jank pass, v0.6.7, witnessed 2026-05-28)

The page looked dead/janky; root causes were all SDK-usage traps. Recorded
in recall memory too (`mem-*-3`). When editing `docs/index.html`:

- **`C.Btn`/`C.RowLink` want `onClick` (capital C), not `onclick`.** The SDK
  binds `onClick` via `addEventListener`; a lowercase `onclick` is treated as
  a raw attribute and the handler NEVER fires. Every demo/CLI/theme button was
  silently inert (boot only ran from the auto `boot()` at load). Native
  `h('a',{onclick})`/`h('input',{oninput})` elements still use lowercase.
- **`C.AppShell` is a fixed-viewport dashboard shell, not a page frame.**
  `.app-main{overflow:auto;height:100%}` inside `.app-body{flex:1;grid rows
  minmax(0,1fr)}` traps tall content in an internal scroll pane — the landing
  page was cut off at the live-witness panel with an empty right half. For a
  scrolling page use document flow: sticky `.wb-header` + panels in `.wb-wrap`
  + footer. Witness `bodyScrollH == mainScrollH`, no clamped-overflow ancestor.
- **`C.RowLink` collapses title+sub into a ~120px column** (it's a list-row
  expecting middle content). Use a responsive card grid for feature lists.
- **`--ink` is a FIXED dark brand color; `--fg` is theme-aware.** Custom text
  on the page background must use `var(--fg,…)` — `--ink` rendered the hero
  lede dark-on-dark (invisible) in dark mode. `--panel-text*` for muted text.
- **`installStyles()` sets `data-theme="auto"`** (matches no rule). Re-assert a
  concrete `dark`/`light` value AFTER each `mount()` and persist to
  `localStorage`; the SDK re-applies "auto" on every mount.
- **Witnessing button clicks needs trusted events** (`page.mouse.click(x,y)`);
  a synthetic `MouseEvent('click')` dispatch does NOT fire SDK-delegated
  handlers, so it falsely reads as a dead button.

## Local SDK + Install gotcha (design pass, v0.6.8, witnessed 2026-05-28)

The page now loads the **local `c:/dev/anentrypoint-design` build**, not
unpkg. `dist/247420.{js,css}` are vendored + committed into `docs/assets/`
(un-ignored in `.gitignore`) and the importmap + stylesheet point at
`./assets/247420.*`. CI cannot reach `c:/dev`, so the dist must be committed;
`upload-pages-artifact` deploys `docs/` wholesale so no `pages.yml` cp is
needed. Re-sync = `cp c:/dev/anentrypoint-design/dist/247420.* docs/assets/`
then commit. `COMPONENT_API.md` in that repo documents the real contracts
(`Btn variant: primary|ghost|default`, `Hero/Section/Kpi/Install/Manifesto`).

- **`C.Install({cmd,copied,onCopy})` does NOT wire `onCopy` in this build.**
  It renders `<div class=cli><span class=prompt>$</span><span class=cmd>…
  </span><span class=copy>copy</span></div>` — the `.copy` is a static span.
  To make copy work, wrap `Install` in a div with `onclick` that checks
  `e.target.closest('.copy')` and copies/sets state yourself.
