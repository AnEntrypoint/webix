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
