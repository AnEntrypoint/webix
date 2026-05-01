# Alpine / CheerpX-class parity matrix

| Area | Implemented now | Remaining for production Alpine parity |
|---|---|---|
| Browser demo | Alpine rootfs loader, terminal input queue, async run loop | Worker isolation, xterm.js PTY fidelity, snapshot/resume |
| Root filesystem | Official Alpine `x86` minirootfs tar.gz mounting, VFS patches for `/proc`, `/dev`, `/etc` | Lazy package/image streaming, persisted writable overlay, permissions/audit model |
| Networking | i386 `socketcall`, synthetic DNS, WebSocket raw TCP gateway, browser HTTP fallback | UDP beyond DNS, epoll, nonblocking edge cases, TLS-heavy workload testing |
| ELF/runtime | ELF32 `ET_EXEC`/`ET_DYN`, `PT_INTERP`, stack/auxv, `execve` handoff | Complete musl/glibc dynamic-loader behavior under large app corpus |
| CPU | Broad IA-32 integer interpreter | x87, MMX/SSE, exact flags/exceptions, obscure instructions |
| Syscalls | Core file, memory, time, tty, metadata, futex, socket basics, select/poll | true `clone` threads, signals, process groups, robust futex/epoll |
| Filesystem | In-memory Unix VFS, symlinks, dirs, char devices, tar mounting, ext2 reader | Mount namespaces, device nodes, COW overlay journal, large image streaming |
| Performance | Interpreter plus invalidation-capable JIT hook | Wasm DBT/basic-block emitter and hot-code tiering |
| Testing | Smoke ELF tests and VFS demo | Differential QEMU-user test corpus across Alpine BusyBox/apk/OpenSSL/musl |

## Gateway model

Browsers do not provide raw TCP sockets to JavaScript. The demo therefore uses a local WebSocket-to-TCP gateway. The guest still performs normal Linux socket operations; the emulator translates those socket syscalls to the gateway.

## Current known blocker

A rootfs can be mounted and binaries can be launched from it, but arbitrary Alpine interactivity is gated by remaining CPU/syscall/process coverage. The demo is now wired end-to-end so unsupported opcodes/syscalls become concrete implementation tasks instead of missing product architecture.
