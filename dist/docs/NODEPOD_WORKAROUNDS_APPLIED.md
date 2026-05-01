# Browser-runtime workarounds applied from the NodePod post

The Scelar/NodePod post describes several browser-runtime lessons that also apply to this x86/Linux emulator: avoid a huge C++/Wasm port when the host browser already has strong primitives, build a synchronous-fast-path/async-slow-path bridge, use `SharedArrayBuffer`/`Atomics.wait()` where genuine blocking is required, model processes with workers, transfer filesystem state with compact binary snapshots, and use a service-worker bridge for virtual networking.

This clean-room runtime now applies those ideas without copying NodePod internals:

- `src/sync.js`
  - `SyncThenable` and `SyncPromise` provide a synchronous resolution path for already-available data.
  - `BlockingSlotPool` provides a `SharedArrayBuffer`/`Atomics` slot protocol for worker-style blocking calls.
  - `FutexTable` implements real guest futex wait/wake queues for async runtime execution.
- `src/vfs.js`
  - Adds VFS watchers.
  - Adds binary and JSON snapshot round-tripping.
  - Adds rename, mkdir, rmdir, chmod, chown, truncate, utimes, and hardlink operations.
- `src/process-manager.js`
  - Adds a process table, PID allocation, parent/child state, VFS snapshot handoff, shared futex namespace, and deterministic run/wait/kill operations.
- `sw.js`
  - Adds a service-worker virtual HTTP-port bridge so browser-hosted guest services can be addressed through `/__openx86__/port/{port}/...`.
- `src/memory.js`
  - Adds copy-on-write page cloning for fork-style process creation.
- `src/jit.js`
  - Replaces the interpreter-only tiering hook with a conservative dynamic binary translation cache for hot straight-line IA-32 blocks.

These changes address the same categories of browser limitations highlighted in the NodePod article: synchronous APIs on asynchronous browser storage/networking, process isolation without OS processes, and routing virtual runtime services through browser primitives.
