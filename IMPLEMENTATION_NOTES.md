# Implementation notes

## Main modules

- `src/cpu.js` — IA-32 interpreter.
- `src/memory.js` — sparse paged memory and permissions.
- `src/elf.js` — ELF32 loader and initial Linux process stack.
- `src/syscalls.js` — Linux i386 syscall translation.
- `src/vfs.js` — in-memory virtual filesystem.
- `src/runtime.js` — high-level runtime glue.
- `src/jit.js` — tiering/JIT extension point.

## Production path to browser parity

1. Add a test corpus that records unsupported opcodes/syscalls.
2. Implement the missing opcodes in frequency order.
3. Add mounted i386 rootfs support and run `/lib/ld-linux.so.2` through the existing `PT_INTERP` path.
4. Expand syscall semantics around `clone`, `futex`, signals, sockets, and tty.
5. Replace `BlockCacheJIT` with a WebAssembly basic-block emitter.
6. Add a framebuffer device and terminal/GUI layers.
7. Differential-test against Linux/QEMU for register, memory, stdout, stderr, and syscall traces.

## Known simplifications

- `sysenter` is approximated as a syscall dispatch rather than modeling Linux's exact return convention.
- `futex`, `poll`, and `nanosleep` are cooperative/no-op implementations suitable for single-threaded bootstrap programs.
- `stat` layouts are compatible enough for many programs but should be verified against real i386 libc expectations.
- Dynamic interpreter loading is wired, but full glibc execution requires more opcode, TLS, thread, signal, and rootfs work.
