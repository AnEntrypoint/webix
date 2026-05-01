# XState Linux OS Emulator — clean-room IA-32/Linux runtime

This repository is a clean-room browser/Node Linux userspace emulator. It keeps the original emulator surface, adds XState-style actor orchestration, and implements real i386 ELF execution, virtual memory, Linux `int 0x80` syscalls, tar rootfs mounting, writable overlays, package tar installation, networking adapters, CLI commands, tests, and benchmarks.

It does **not** contain CheerpX code, deobfuscated CheerpX internals, or proprietary implementation details. It is an independent runtime that targets the same broad product category: browser/Node execution of Linux userspace binaries from a rootfs image.

## Current capabilities

| Area | Status |
|---|---|
| CPU | IA-32 interpreter with registers, flags, stack, ModR/M/SIB addressing, string ops, common integer/control-flow ops, x87 subset, SSE/SSE2 subset, CPUID, faults, and diagnostics. |
| ELF | ELF32/i386 parser and loader for `ET_EXEC`/`ET_DYN`, `PT_LOAD`, `PT_INTERP`, stack/auxv setup, dynamic table parsing, and limited i386 relocation helpers. |
| VM | Page-based memory with permissions, `mmap`, `munmap`, `mprotect`, `brk`, copy-on-write clone, copy-in/copy-out helpers. |
| Syscalls | Linux i386 `int 0x80` dispatcher with file/process/time/memory/dirent/socket/futex/poll/select/sysinfo coverage and trace hooks. |
| Filesystem | POSIX-like VFS, tar/tar.gz rootfs load, symlinks, modes, uid/gid, mtimes, device nodes, writable overlay, snapshots. |
| Package install | `xos package install` unpacks real tar/tar.gz packages into the overlay and records installed files. |
| Networking | Node raw TCP adapter, browser WebSocket-to-TCP gateway, virtual DNS, socketcall client socket support. |
| Terminal/process | PTY endpoint, stdio inheritance, fork/vfork/clone subset, wait4, process manager, XState-style kernel/process/scheduler actors. |
| Browser | Alpine-oriented HTML demo, service-worker virtual HTTP routing, IndexedDB/localStorage snapshot helpers. |
| CI | `npm run typecheck`, `npm test`, `npm run build`, `npm run benchmark`. |

## Architecture

```text
Browser/Node host
  ├─ CLI / web demo / embedding API
  ├─ XState-style actors
  │    ├─ kernel machine
  │    ├─ scheduler machine
  │    └─ process actor machines
  ├─ Runtime
  │    ├─ IA-32 CPU interpreter + hot-block JIT hook
  │    ├─ ELF32 loader + execve image replacement
  │    ├─ Linux i386 syscall ABI
  │    └─ process/fork/wait/futex/signal state
  ├─ Virtual memory manager
  ├─ VFS / overlay / tar rootfs / package installer
  └─ Host bridges
       ├─ Node TCP sockets
       ├─ browser WebSocket TCP gateway
       ├─ Service Worker virtual HTTP ports
       └─ IndexedDB/localStorage persistence
```

CPU stepping is intentionally outside the actor hot path. Lifecycle, process creation, exit, faults, scheduling events, and device activity flow through the XState-style actors.

## Install and verify

```bash
npm run typecheck
npm test
npm run build
npm run benchmark
```

Expected smoke demo:

```bash
npm run demo
# Hello from clean-room x86 JS emulator!
```

## CLI

```bash
xos boot --rootfs rootfs.tar.gz
xos run --rootfs rootfs.tar /bin/busybox echo hello
xos shell --rootfs rootfs.tar.gz
xos trace --rootfs rootfs.tar /bin/busybox ls /
xos package install --rootfs rootfs.tar.gz package.tar.gz --snapshot rootfs.vfs
xos benchmark 250000
```

During local development without global install:

```bash
node bin/xos.mjs run --rootfs rootfs.tar /bin/hello
```

## Alpine/rootfs demo

The browser demo targets Alpine `x86` minirootfs archives. Use the 32-bit `x86` rootfs, not `x86_64`.

```bash
npm run fetch:alpine   # optional
npm run gateway        # optional network bridge
npm run serve
# open http://localhost:8000/alpine.html
```

Node smoke runner:

```bash
node tools/run-alpine-smoke.mjs alpine-minirootfs-3.23.4-x86.tar.gz /bin/cat /etc/alpine-release
```

## Build tiny i386 ELF fixtures

The repository includes prebuilt tiny i386 ELF fixtures in `samples/`. To regenerate them on a Linux host with i386 binutils:

```bash
npm run make-samples
```

The fixtures are intentionally tiny static assembly programs so CI can test real ELF loading and syscall dispatch without bundling third-party binaries.

## Package install flow

`xos package install` is not a fake command handler. It unpacks the supplied tar/tar.gz package through the same VFS primitives used by guest syscalls. It preserves directories, symlinks, file modes, uid/gid, mtimes, and device nodes where representable by the emulator.

```bash
node bin/xos.mjs package install --rootfs rootfs.tar.gz busybox-package.tar.gz --snapshot after-install.vfs
```

## Networking model

Node mode uses a real TCP bridge via `net.Socket`. Browser mode cannot expose arbitrary raw TCP directly, so guest sockets are bridged through `tools/net-gateway.mjs` over WebSocket. The gateway should be allow-listed and not exposed to untrusted networks.

```bash
OPENX86_ALLOW_HOSTS=example.com,dl-cdn.alpinelinux.org npm run gateway
```


## Alpine 3.23.4 compatibility fixes

This build includes targeted fixes for the failures observed in the Alpine web/Node demo:

- BusyBox `top` now sees numeric `/proc/<pid>` process entries plus `/proc/stat`, `/proc/meminfo`, `/proc/uptime`, and `/proc/loadavg`.
- Alpine `apk` execs receive guest `LD_LIBRARY_PATH` plus an `apk`-specific `LD_PRELOAD` assembled from real guest `libz`, `libcrypto`, and `libssl` libraries when present in the mounted rootfs.
- The IA-32 interpreter now supports x87 `FCOM/FCOMP m64real` (`DC /2` and `/3`), fixing the crash path seen in `ping`.
- `node tools/ci.mjs` runs typecheck, tests, and build directly.

See `docs/ALPINE_FIXES_0.5.2.md`.

## Known limitations

The repository is substantially more complete than a toy simulator, but it is **not yet honestly validated as full commercial CheerpX parity**. The current CI validates real ELF execution, VFS overlay/package semantics, syscall traces, CLI, memory protections, and CPU extension paths. The final user-facing parity gate:

```sh
/bin/sh -i
apk update
apk add curl
curl http://example.com
```

still depends on closing these remaining gaps across real Alpine binaries:

- complete IA-32 instruction coverage and exact x87/SSE exception/flag behavior;
- true thread-mode `clone`, full signal-frame delivery, job control, and process groups;
- broader musl dynamic-loader and package-manager syscall coverage under real rootfs tests;
- production WebAssembly DBT for hot memory/branch-heavy blocks;
- differential corpus against QEMU user-mode and native i386 Linux.

The emulator reports unsupported opcodes/syscalls with instruction pointer, register state, syscall arguments, and memory maps through the diagnostics helpers so these gaps can be closed one by one without guessing.

## Clean-room boundary

The implementation is based on public ISA/ABI/Linux behavior and independent tests. It does not copy or reverse-engineer proprietary CheerpX internals.

## Browser-safe imports

The browser demos import `./src/index.js`, which is browser-safe and does not statically import Node builtins. Node-only networking and filesystem adapters are available from `./src/node.js` or the package subpath `./node`.

If you see a browser error mentioning `node:net`, `node:dns/promises`, or CORS for a `node:*` URL, a Node-only module has been imported into the browser graph. Use `WebSocketTcpNetwork` or `BrowserFetchNetwork` from `./src/index.js` in the browser, and run `npm run gateway` for raw TCP bridging.
