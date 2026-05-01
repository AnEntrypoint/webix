# Commercial parity status

This repository is an implementation pass toward a CheerpX-class browser/Node Linux runtime. It is clean-room and does not contain proprietary CheerpX code.

## Implemented in this pass

- i386 architecture abstraction so x86_64/RISC-V can be added without rewriting runtime orchestration.
- XState-style kernel, process, and scheduler actors for lifecycle/fault/event orchestration.
- CLI commands: `boot`, `run`, `shell`, `trace`, `package install`, and `benchmark`.
- Real ELF32/i386 execution of fixture binaries with Linux `int 0x80` syscalls.
- Page-based VM with permissions and copy-on-write fork cloning.
- Tar/tar.gz rootfs mounting with modes, uid/gid, mtimes, symlinks, hardlinks, and device nodes.
- Writable overlay filesystem with copy-up and whiteout behavior.
- Tar package installation through VFS operations, not command mocks.
- Node TCP networking, browser WebSocket TCP gateway, virtual DNS, service-worker virtual HTTP routing.
- PTY/stdin/stdout plumbing and async syscall support.
- Dynamic ELF table parsing and limited i386 relocation helpers for `R_386_RELATIVE`, `R_386_GLOB_DAT`, `R_386_JMP_SLOT`, `R_386_32`, and `R_386_PC32`.
- Tests for CPU extensions, ELF execution, VM protections, CLI, VFS overlay/package install, syscall tracing, and conformance smoke paths.
- Build/typecheck/benchmark scripts.

## Verified commands

```bash
npm run typecheck
npm test
npm run build
npm run benchmark -- 1000
```

## Not yet claimable as full parity

The repo is not yet validated to run the full acceptance script:

```sh
/bin/sh -i
apk update
apk add curl
curl http://example.com
```

The missing pieces are not hidden or faked. They are:

1. Full IA-32 coverage, including complete x87/MMX/SSE/SSE2 arithmetic, exceptions, and rare flags.
2. Real parallel thread-mode `clone` with shared address spaces/file tables/TLS and blocking futexes across Workers.
3. Full signal frame creation/restoration and job-control semantics.
4. Larger syscall coverage discovered by running real `busybox`, `apk`, `openssl`, and `curl` under Alpine x86.
5. Production WebAssembly DBT for hot blocks beyond the current conservative JIT hook.
6. Differential testing against QEMU user-mode and native i386 Linux.

## Acceptance workflow for future parity runs

```bash
npm run fetch:alpine
npm run gateway
node tools/run-alpine-smoke.mjs assets/alpine-minirootfs-3.23.4-x86.tar.gz /bin/sh -i
```

Then run inside the guest:

```sh
apk update
apk add curl
curl http://example.com
```

Any failure should be captured with trace mode and converted into a regression test before implementing the missing opcode/syscall/semantic behavior.
