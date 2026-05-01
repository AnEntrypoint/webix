# Linux i386 syscall coverage snapshot

This is a practical coverage snapshot for the clean-room syscall layer.

## Implemented coverage groups

- Process: `exit`, `exit_group`, `fork`, `vfork`, fork-like `clone`, `execve`, `waitpid`, `wait4`, `getpid`, `getppid`, `gettid`, `getpgid`, `setsid`.
- File I/O: `open`, `openat`, `close`, `read`, `write`, `readv`, `writev`, `pread64`, `pwrite64`, `lseek`, `_llseek`, `dup`, `dup2`, `pipe`, `fcntl`, `fcntl64`, `ioctl` for common tty queries.
- Filesystem: `stat`, `lstat`, `fstat`, `stat64`, `lstat64`, `fstat64`, `fstatat64`, `access`, `faccessat`, `readlink`, `readlinkat`, `symlink`, `symlinkat`, `linkat`, `unlink`, `unlinkat`, `rename`, `renameat`, `mkdir`, `mkdirat`, `rmdir`, `chmod`, `fchmod`, `fchmodat`, `chown`, `fchown`, `truncate`, `ftruncate`, `getdents`, `getdents64`, `getcwd`, `statfs64`, `fstatfs64`.
- Memory: `brk`, `mmap`, `mmap2`, `munmap`, `mprotect`, simplified `mremap`, `msync`.
- Time: `time`, `gettimeofday`, `clock_gettime`, `clock_getres`, `nanosleep`.
- Synchronization: `futex` wait/wake/requeue subset, `set_robust_list`, `sched_yield`.
- TLS: `set_thread_area`, `get_thread_area`.
- Networking: i386 `socketcall` for socket/connect/send/recv/sendto/recvfrom/getsockname/getpeername/setsockopt/getsockopt/shutdown.
- Poll/event FDs: `select`, `poll`, `epoll_create`, `epoll_ctl`, `epoll_wait`, `epoll_pwait`, `eventfd`, `eventfd2` for readiness-style workloads.
- Misc: `uname`, `getrlimit`, `ugetrlimit`, `prlimit64`, `getrandom`, `prctl`, `flock`, `fsync`, `fdatasync`, signal action bookkeeping.

## Not complete

- Full signal frame delivery.
- Full thread-mode clone.
- Inotify.
- Privileged operations such as mount/module/swap/reboot.
- Exact ioctl matrix beyond terminal basics.
- Full guest-hosted inbound TCP server semantics: `bind` is accepted for compatibility, but `listen`/`accept` remain unsupported beyond the service-worker virtual HTTP bridge.
