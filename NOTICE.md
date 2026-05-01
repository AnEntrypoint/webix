# Third-party notices

webix vendors and depends on third-party software.

## Bundled (containers/)

- **Blink** (jart/blink, fork robalb/blink@libblink) — ISC.
  Compiled to wasm via emscripten 3.1.69; vendored as
  containers/blinkenlib.wasm and containers/blinkenlib.js.
  Source: https://github.com/jart/blink — license: ISC.

- **Alpine Linux mini-rootfs** (containers/alpine-minirootfs-x86_64.tar.gz) —
  GPL-2.0 + assorted package licenses. Used for integration tests against
  real busybox + apk. Source: https://alpinelinux.org/

- **busybox-static** (containers/busybox-x86_64.elf, containers/busybox-static.apk) —
  GPL-2.0. Source: https://busybox.net/

- **Hand-assembled test ELFs** (containers/hello-x86_64.elf,
  containers/sse2-test.elf, containers/avx-test.elf) — original to this repo,
  MIT (same as repo).

## Runtime dependencies (npm)

- **xstate** v5 — MIT — https://github.com/statelyai/xstate
