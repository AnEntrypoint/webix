# Alpine compatibility fixes in 0.5.2

This pass targets the concrete Alpine 3.23.4 failures observed while running a real x86 minirootfs.

## `/proc` process visibility for `top`

BusyBox `top` scans numeric `/proc/<pid>` directories and reads files such as `stat`, `status`, `cmdline`, `comm`, `meminfo`, `stat`, `uptime`, and `loadavg`. The syscall layer now refreshes process-oriented pseudo-files before path opens/stats, including `/proc/1`, `/proc/<current-pid>`, and `/proc/self`.

## `apk` relocation failures against zlib/OpenSSL

Recent Alpine `apk-tools` may require zlib/OpenSSL symbols through `libapk.so`. The runtime now seeds:

- `/etc/ld-musl-i386.path`
- `LD_LIBRARY_PATH=/lib:/usr/lib`
- symlink aliases for common `libz`, `libcrypto`, and `libssl` sonames when they exist in either `/lib` or `/usr/lib`
- an `apk`-specific `LD_PRELOAD` generated from real guest libraries present in the mounted rootfs

This does not add host-native crypto/zlib mocks. It only helps the guest musl loader resolve real guest shared objects.

## x87 `DC /2` crash from `ping`

The IA-32 interpreter now handles x87 memory compare group forms:

- `D8 /2` and `DC /2` (`FCOM m32/m64real`)
- `D8 /3` and `DC /3` (`FCOMP m32/m64real`)
- reverse subtract/divide forms `/5` and `/7`

The test suite includes a regression for `DC /2` setting the x87 C3 status bit on equality.

## Performance-sensitive fixes

The fixes are implemented in hot paths with low overhead:

- `/proc` refresh writes compact pseudo-files only on path-oriented syscalls that already cross the kernel boundary.
- Alpine library preloading is computed during `execve`, not per instruction.
- x87 comparison uses a small status-word update helper and avoids allocating objects on the interpreter hot path.

## Validation

Validated directly with:

```bash
node tools/typecheck.mjs
node tools/run-tests.mjs
node tools/build.mjs
node tools/ci.mjs
```

`npm test` may remain sensitive to npm/stdout pipe handling in some container harnesses; the authoritative CI path is `node tools/ci.mjs`, and `npm run ci` delegates to the same scripts in normal shells.
