# Alpine Linux web demo

This package includes an Alpine-target browser demo at `alpine.html`.

It is wired for Alpine Linux `x86` minirootfs 3.23.4, the current stable Alpine version at the time this package was prepared. The runtime is a 32-bit IA-32 emulator, so use Alpine's `x86` rootfs, not `x86_64`.

## Start the demo

```bash
npm run fetch:alpine      # optional but recommended, avoids browser CORS issues
npm run gateway           # terminal 1, enables guest TCP
npm run serve             # terminal 2
```

Open:

```text
http://localhost:8000/alpine.html
```

In the browser, either upload `assets/alpine-minirootfs-3.23.4-x86.tar.gz` or try loading the CDN URL directly. CDN fetch may be blocked by CORS in some browsers, so the upload path is the reliable path.

## Networking model

Browsers do not expose raw TCP sockets to JavaScript. The guest still sees Linux i386 `socketcall` sockets. The runtime maps those sockets to either:

- `WebSocketTcpNetwork`: guest TCP -> browser WebSocket -> `tools/net-gateway.mjs` -> host TCP.
- `BrowserFetchNetwork`: limited HTTP-only fallback useful for simple GET-like clients.

DNS is handled by `VirtualDNS`. Guest UDP DNS queries receive synthetic `10.0.2.x` addresses. When the guest later connects to that address, the network adapter maps it back to the original hostname and asks the gateway to open the real TCP connection.

## What the demo now includes

- Browser UI for loading Alpine x86 minirootfs.
- Gzip + tar unpacking into the emulator VFS.
- Alpine seed files: `/etc/resolv.conf`, `/etc/apk/repositories`, `/proc`, `/sys`, `/run`, `/var/cache/apk`, `/root`.
- Async stdin via `ByteQueue` for interactive programs.
- Async syscall execution via `runAsync()`.
- i386 `socketcall` support for client sockets: `socket`, `connect`, `send`, `recv`, `sendto`, `recvfrom`, `getsockname`, `getpeername`, `setsockopt`, `getsockopt`, and `shutdown`.
- WebSocket-to-TCP gateway with optional DNS endpoint and host allow-list controls.
- A smoke runner: `npm run alpine:smoke`.

## Current hard blockers for true CheerpX-level parity

The Alpine demo is intentionally wired end-to-end, but a robust full Alpine shell requires more than rootfs and networking. Remaining work includes:

- More IA-32 instruction coverage, especially x87/MMX/SSE and rare flag behavior.
- true threaded `clone`, complete process trees, and exact file descriptor inheritance. A simplified fork/vfork/wait4 path is included for shell-style fork/exec/wait flows.
- Signal delivery and default signal actions.
- Complete tty/pty behavior and job control.
- A production WebAssembly dynamic binary translator.
- Larger differential test corpus against QEMU user-mode and real Alpine binaries.

The demo prints the exact unsupported opcode or syscall when the current interpreter hits a missing piece.
