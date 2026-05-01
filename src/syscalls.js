import { REG, errno, readCString, stringToBytes, bytesToString, nowSeconds, lo32FromBigInt, hi32FromBigInt } from "./util.js";
import { PERM } from "./memory.js";
import { VFS, VFSError, O, S_IFDIR, S_IFREG, S_IFLNK, S_IFCHR } from "./vfs.js";
import { SocketHandle, AF_INET } from "./network.js";
import { FutexTable } from "./sync.js";

export class ProcessExit extends Error {
  constructor(code = 0) {
    super(`Process exited with status ${code}`);
    this.code = code | 0;
  }
}

export class AsyncSyscallPending extends Error {
  constructor(promise) {
    super("Async syscall pending");
    this.promise = promise;
  }
}

export class ExecveTrap extends Error {
  constructor(path, argv = [], env = []) {
    super(`execve(${path})`);
    this.path = path;
    this.argv = argv;
    this.env = env;
  }
}

export const ERR = Object.freeze({
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9,
  ECHILD: 10, EAGAIN: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, EBUSY: 16, EEXIST: 17, EXDEV: 18,
  ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, ETXTBSY: 26,
  EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32, ERANGE: 34, ENOSYS: 38,
  ENOTEMPTY: 39, ELOOP: 40, ENAMETOOLONG: 36, EOPNOTSUPP: 95, ENOTSOCK: 88,
  EDESTADDRREQ: 89, EAFNOSUPPORT: 97, ENETUNREACH: 101, ENOTCONN: 107, ETIMEDOUT: 110,
});

function retErr(n) { return errno(n); }
function isPromiseLike(v) { return v && typeof v.then === "function"; }
function protToPerm(prot) {
  let p = 0;
  if (prot & 1) p |= PERM.R;
  if (prot & 2) p |= PERM.W;
  if (prot & 4) p |= PERM.X;
  return p || PERM.RW;
}
function modeToDType(mode) {
  if ((mode & 0o170000) === S_IFDIR) return 4;
  if ((mode & 0o170000) === S_IFCHR) return 2;
  if ((mode & 0o170000) === S_IFLNK) return 10;
  if ((mode & 0o170000) === S_IFREG) return 8;
  return 0;
}
function align(n, a) { return (n + a - 1) & ~(a - 1); }

class StdioHandle {
  constructor(kind, sys) { this.kind = kind; this.sys = sys; this.offset = 0; }
  read(count) {
    if (this.kind !== "stdin") throw new VFSError(ERR.EBADF, "not readable");
    return this.sys.readStdin(count);
  }
  write(bytes) {
    if (this.kind === "stdin") throw new VFSError(ERR.EBADF, "not writable");
    const text = bytesToString(bytes);
    if (this.kind === "stdout") this.sys.output += text;
    else this.sys.stderr += text;
    this.sys.onWrite(this.kind === "stdout" ? 1 : 2, text, bytes);
    return bytes.length;
  }
  lseek() { throw new VFSError(ERR.ESPIPE, "stream is not seekable"); }
  stat() { return { dev: 1, ino: this.kind === "stdin" ? 10 : this.kind === "stdout" ? 11 : 12, mode: S_IFCHR | 0o666, nlink: 1, uid: 0, gid: 0, rdev: 0x0500, size: 0, blksize: 4096, blocks: 0, atime: nowSeconds(), mtime: nowSeconds(), ctime: nowSeconds() }; }
  readdir() { throw new VFSError(ERR.ENOTDIR, "not dir"); }
}


class EventFdHandle {
  constructor(initial = 0, flags = 0) { this.value = BigInt(initial >>> 0); this.flags = flags >>> 0; }
  read(count) {
    if (count < 8) throw new VFSError(ERR.EINVAL, "eventfd read needs 8 bytes");
    const out = new Uint8Array(8);
    const v = this.value;
    this.value = 0n;
    const dv = new DataView(out.buffer);
    dv.setUint32(0, Number(v & 0xffffffffn), true); dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
    return out;
  }
  write(bytes) {
    if (bytes.length < 8) throw new VFSError(ERR.EINVAL, "eventfd write needs 8 bytes");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.value += BigInt(dv.getUint32(0, true)) | (BigInt(dv.getUint32(4, true)) << 32n);
    return 8;
  }
  hasData() { return this.value !== 0n; }
  stat() { return { dev: 1, ino: 8000, mode: 0o010000 | 0o666, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 4096, blocks: 0, atime: nowSeconds(), mtime: nowSeconds(), ctime: nowSeconds() }; }
  lseek() { throw new VFSError(ERR.ESPIPE, "eventfd"); }
}

class EpollHandle {
  constructor(sys) { this.sys = sys; this.interests = new Map(); }
  ctl(op, fd, eventAddr) {
    if (op === 2) { this.interests.delete(fd); return 0; }
    const events = this.sys.memory.read32(eventAddr);
    const data = this.sys.memory.read32(eventAddr + 4);
    this.interests.set(fd >>> 0, { events, data });
    return 0;
  }
  wait(eventsAddr, maxEvents, timeoutMs) {
    let n = 0;
    for (const [fd, e] of this.interests) {
      if (n >= maxEvents) break;
      let ready = 0;
      const h = this.sys.fd.get(fd);
      if (!h) ready = 0x20;
      else { if ((e.events & 0x001) && (fd === 0 || h.hasData?.())) ready |= 0x001; if (e.events & 0x004) ready |= 0x004; }
      if (!ready) continue;
      const base = eventsAddr + n * 12;
      this.sys.memory.write32(base, ready);
      this.sys.memory.write32(base + 4, e.data);
      this.sys.memory.write32(base + 8, 0);
      n++;
    }
    return n;
  }
  read() { throw new VFSError(ERR.EINVAL, "epoll fd"); }
  write() { throw new VFSError(ERR.EINVAL, "epoll fd"); }
  stat() { return { dev: 1, ino: 8100, mode: 0o010000 | 0o600, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 4096, blocks: 0, atime: nowSeconds(), mtime: nowSeconds(), ctime: nowSeconds() }; }
  lseek() { throw new VFSError(ERR.ESPIPE, "epoll"); }
}

class PipeEnd {
  constructor(pipe, readable, writable) { this.pipe = pipe; this.readable = readable; this.writable = writable; }
  read(count) {
    if (!this.readable) throw new VFSError(ERR.EBADF, "not readable");
    const n = Math.min(count, this.pipe.buffer.length);
    const out = this.pipe.buffer.slice(0, n);
    this.pipe.buffer = this.pipe.buffer.slice(n);
    return out;
  }
  write(bytes) {
    if (!this.writable) throw new VFSError(ERR.EBADF, "not writable");
    const grown = new Uint8Array(this.pipe.buffer.length + bytes.length);
    grown.set(this.pipe.buffer); grown.set(bytes, this.pipe.buffer.length);
    this.pipe.buffer = grown;
    return bytes.length;
  }
  stat() { return { dev: 1, ino: 99, mode: 0o010000 | 0o666, nlink: 1, uid: 0, gid: 0, rdev: 0, size: this.pipe.buffer.length, blksize: 4096, blocks: 0, atime: nowSeconds(), mtime: nowSeconds(), ctime: nowSeconds() }; }
  lseek() { throw new VFSError(ERR.ESPIPE, "pipe"); }
}

export class LinuxSyscalls {
  constructor(memory, options = {}) {
    this.memory = memory;
    this.vfs = options.vfs ?? new VFS();
    this.output = "";
    this.stderr = "";
    this.stdinReader = typeof options.stdin === "function" ? options.stdin : (options.stdin && typeof options.stdin.read === "function" ? count => options.stdin.read(count) : null);
    this.stdin = this.stdinReader ? new Uint8Array(0) : stringToBytes(options.stdin ?? "");
    this.stdinOffset = 0;
    this.onWrite = options.onWrite ?? (() => {});
    this.network = options.network ?? null;
    this.onExecve = options.onExecve ?? null;
    this.onFork = options.onFork ?? null;
    this.onWait4 = options.onWait4 ?? null;
    this.brk = options.brk ?? 0x09000000;
    this.pid = options.pid ?? 100;
    this.ppid = options.ppid ?? 1;
    this.uid = options.uid ?? 1000;
    this.gid = options.gid ?? 1000;
    this.mmapMin = options.mmapMin ?? 0x40000000;
    this.mmapMax = options.mmapMax ?? 0xb0000000;
    this.fd = new Map([[0, new StdioHandle("stdin", this)], [1, new StdioHandle("stdout", this)], [2, new StdioHandle("stderr", this)]]);
    this.nextFd = 3;
    this.cwd = "/";
    this.threadArea = { entry: 6, base: 0, limit: 0xfffff, flags: 0x51 };
    this.futex = options.futex ?? new FutexTable();
    this.signalActions = new Map();
    this.signalMask = new Set();
    this.trace = options.syscallTrace ?? options.traceSyscalls ?? options.trace ?? false;
    this.syscallTrace = [];
    this.onSyscall = options.onSyscall ?? null;
  }

  allocFd(handle, preferred = null) {
    if (preferred !== null) { this.fd.set(preferred, handle); return preferred; }
    let n = this.nextFd;
    while (this.fd.has(n)) n++;
    this.fd.set(n, handle);
    this.nextFd = n + 1;
    return n;
  }
  getFd(n) { const h = this.fd.get(n >>> 0); if (!h) throw new VFSError(ERR.EBADF, `bad fd ${n}`); return h; }
  closeFd(n) { if (n <= 2) return 0; const key = n >>> 0; const h = this.fd.get(key); if (!h) throw new VFSError(ERR.EBADF, `bad fd ${n}`); h.close?.(); this.fd.delete(key); return 0; }

  _refreshProcFiles() {
    try {
      const nowTicks = Math.max(1, Math.floor(Date.now() / 10));
      const statLine = (pid, name, ppid = 0) => `${pid} (${name}) R ${ppid} ${pid} ${pid} 0 0 0 0 0 0 0 1 1 0 0 20 0 1 0 ${nowTicks} 1048576 256 4294967295 134512640 134520000 3221225472 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
      const status = (pid, name, ppid = 0) => `Name:\t${name}\nState:\tR (running)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${ppid}\nUid:\t${this.uid}\t${this.uid}\t${this.uid}\t${this.uid}\nGid:\t${this.gid}\t${this.gid}\t${this.gid}\t${this.gid}\nThreads:\t1\nVmSize:\t1024 kB\nVmRSS:\t256 kB\n`;
      this.vfs.mkdirp("/proc/self/fd");
      for (const pid of [1, this.pid]) {
        this.vfs.mkdirp(`/proc/${pid}/fd`);
        this.vfs.writeFile(`/proc/${pid}/stat`, statLine(pid, pid === 1 ? "init" : "sh", pid === 1 ? 0 : this.ppid));
        this.vfs.writeFile(`/proc/${pid}/status`, status(pid, pid === 1 ? "init" : "sh", pid === 1 ? 0 : this.ppid));
        this.vfs.writeFile(`/proc/${pid}/cmdline`, pid === 1 ? "init\0" : "sh\0");
        this.vfs.writeFile(`/proc/${pid}/comm`, pid === 1 ? "init\n" : "sh\n");
        this.vfs.writeFile(`/proc/${pid}/maps`, this.memory.formatMaps());
        try { if (!this.vfs.exists(`/proc/${pid}/exe`)) this.vfs.symlink("/bin/sh", `/proc/${pid}/exe`); } catch {}
        for (const [fd, target] of [["0", "/dev/tty"], ["1", "/dev/tty"], ["2", "/dev/tty"]]) {
          try { if (!this.vfs.exists(`/proc/${pid}/fd/${fd}`)) this.vfs.symlink(target, `/proc/${pid}/fd/${fd}`); } catch {}
        }
      }
      this.vfs.writeFile("/proc/self/maps", this.memory.formatMaps());
      this.vfs.writeFile("/proc/self/stat", statLine(this.pid, "sh", this.ppid));
      this.vfs.writeFile("/proc/self/status", status(this.pid, "sh", this.ppid));
      this.vfs.writeFile("/proc/uptime", `${Math.floor(Date.now() / 1000)}.00 0.00\n`);
      this.vfs.writeFile("/proc/loadavg", "0.00 0.00 0.00 1/2 100\n");
      this.vfs.writeFile("/proc/stat", "cpu  1 0 1 100 0 0 0 0 0 0\ncpu0 1 0 1 100 0 0 0 0 0 0\nintr 0\nctxt 1\nbtime 1\nprocesses 2\nprocs_running 1\nprocs_blocked 0\n");
    } catch { /* ignore */ }
  }

  _path(addr) { return readCString(this.memory, addr); }
  _atPath(dirfd, addr) {
    const p = this._path(addr);
    if (p.startsWith("/") || (dirfd | 0) === -100) return p;
    const h = this.getFd(dirfd);
    const base = h.path ?? this.cwd;
    return `${base.replace(/\/$/, "")}/${p}`;
  }
  _pathAt(dirfd, addr) {
    const path = this._path(addr);
    if (path.startsWith("/") || (dirfd | 0) === -100) return path;
    const h = this.fd.get(dirfd >>> 0);
    const base = h?.path && h.node?.type === "dir" ? h.path : this.cwd;
    return this.vfs.normalize(path, base);
  }
  _timespecSeconds(addr) { return addr ? this.memory.read32(addr) >>> 0 : nowSeconds(); }
  _writeStatx(addr, st) {
    const m = this.memory;
    for (let i = 0; i < 256; i++) m.write8(addr + i, 0);
    m.write32(addr + 0, 0x000017ff); // mask: basic stats
    m.write32(addr + 4, st.blksize || 4096);
    m.write32(addr + 16, st.nlink >>> 0);
    m.write32(addr + 20, st.uid >>> 0);
    m.write32(addr + 24, st.gid >>> 0);
    m.write16(addr + 28, st.mode & 0xffff);
    m.write32(addr + 32, st.ino >>> 0); m.write32(addr + 36, 0);
    m.write32(addr + 40, st.size >>> 0); m.write32(addr + 44, Math.floor(st.size / 0x100000000));
    m.write32(addr + 48, st.blocks >>> 0); m.write32(addr + 52, Math.floor(st.blocks / 0x100000000));
    const writeTs = (off, sec) => { m.write32(addr + off, sec >>> 0); m.write32(addr + off + 4, 0); m.write32(addr + off + 8, 0); m.write32(addr + off + 12, 0); };
    writeTs(56, st.atime); writeTs(72, st.mtime); writeTs(88, st.ctime);
  }

  _mknod(path, mode, dev = 0) {
    const type = mode & 0o170000;
    if (type === 0o040000) { this.vfs.mkdir(path, mode & 0o7777); return 0; }
    if (type === 0o120000) return retErr(ERR.EINVAL);
    if (type === 0o010000) { this.vfs.mknod(path, "fifo", mode & 0o7777, dev); return 0; }
    if (type === 0o020000 || type === 0o060000) { this.vfs.mknod(path, "null", mode & 0o7777, dev); return 0; }
    this.vfs.writeFile(path, new Uint8Array(0), mode & 0o7777 || 0o644);
    return 0;
  }

  _fcntl(fd, cmd, arg) {
    this.getFd(fd);
    switch (cmd >>> 0) {
      case 0: return this.allocFd(this.getFd(fd)); // F_DUPFD
      case 1: return 0; // F_GETFD
      case 2: return 0; // F_SETFD
      case 3: return 0; // F_GETFL
      case 4: return 0; // F_SETFL
      case 12: case 13: return 0; // locks accepted in single-host runtime
      default: return 0;
    }
  }

  _fillRandom(addr, count) {
    const out = new Uint8Array(count >>> 0);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out);
    else for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 256) | 0;
    this.memory.writeBytes(addr, out);
    return out.length;
  }

  readStdin(count) {
    count >>>= 0;
    if (this.stdinReader) return this.stdinReader(count);
    const n = Math.min(count, this.stdin.length - this.stdinOffset);
    const out = this.stdin.subarray(this.stdinOffset, this.stdinOffset + n);
    this.stdinOffset += n;
    return out;
  }

  _readCStringArray(ptr) {
    const out = [];
    if (!ptr) return out;
    for (let i = 0; i < 4096; i++) {
      const p = this.memory.read32(ptr + i * 4);
      if (!p) break;
      out.push(readCString(this.memory, p));
    }
    return out;
  }

  _readInto(fd, addr, count) {
    const data = this.getFd(fd).read(count);
    if (isPromiseLike(data)) return data.then(bytes => { this.memory.writeBytes(addr, bytes); return bytes.length; });
    this.memory.writeBytes(addr, data);
    return data.length;
  }

  _writeFrom(fd, addr, count) {
    return this.getFd(fd).write(this.memory.readBytes(addr, count));
  }

  _readSockaddrIn(addr) {
    if (!addr) return null;
    const family = this.memory.read16(addr);
    const port = (this.memory.read8(addr + 2) << 8) | this.memory.read8(addr + 3);
    const ip = `${this.memory.read8(addr + 4)}.${this.memory.read8(addr + 5)}.${this.memory.read8(addr + 6)}.${this.memory.read8(addr + 7)}`;
    return { family, port, ip };
  }

  _writeSockaddrIn(addr, value) {
    if (!addr || !value) return;
    this.memory.write16(addr, AF_INET);
    this.memory.write8(addr + 2, (value.port >>> 8) & 0xff);
    this.memory.write8(addr + 3, value.port & 0xff);
    const parts = String(value.ip || "0.0.0.0").split(".").map(x => Number(x) & 0xff);
    for (let i = 0; i < 4; i++) this.memory.write8(addr + 4 + i, parts[i] ?? 0);
    for (let i = 8; i < 16; i++) this.memory.write8(addr + i, 0);
  }

  _socketCall(sub, argsPtr) {
    const arg = i => this.memory.read32(argsPtr + i * 4) >>> 0;
    switch (sub) {
      case 1: { // socket(domain,type,protocol)
        const sock = new SocketHandle(this, arg(0), arg(1), arg(2));
        return this.allocFd(sock);
      }
      case 2: return 0; // bind: accept silently for client workloads
      case 3: { // connect(fd, sockaddr*, len)
        const h = this.getFd(arg(0));
        if (!(h instanceof SocketHandle)) return retErr(ERR.ENOTSOCK);
        return h.connect(this._readSockaddrIn(arg(1)));
      }
      case 4: return retErr(ERR.EOPNOTSUPP); // listen
      case 5: return retErr(ERR.EOPNOTSUPP); // accept
      case 6: { // getsockname
        const h = this.getFd(arg(0));
        if (!(h instanceof SocketHandle)) return retErr(ERR.ENOTSOCK);
        this._writeSockaddrIn(arg(1), { family: AF_INET, port: 0, ip: "0.0.0.0" });
        if (arg(2)) this.memory.write32(arg(2), 16);
        return 0;
      }
      case 7: { // getpeername
        const h = this.getFd(arg(0));
        if (!(h instanceof SocketHandle)) return retErr(ERR.ENOTSOCK);
        if (!h.peer) return retErr(ERR.ENOTCONN);
        this._writeSockaddrIn(arg(1), h.peer);
        if (arg(2)) this.memory.write32(arg(2), 16);
        return 0;
      }
      case 8: return retErr(ERR.EOPNOTSUPP); // socketpair
      case 9: { // send
        const data = this.memory.readBytes(arg(1), arg(2));
        return this.getFd(arg(0)).write(data);
      }
      case 10: return this._readInto(arg(0), arg(1), arg(2)); // recv
      case 11: { // sendto
        const h = this.getFd(arg(0));
        if (!(h instanceof SocketHandle)) return retErr(ERR.ENOTSOCK);
        return h.sendto(this.memory.readBytes(arg(1), arg(2)), arg(4) ? this._readSockaddrIn(arg(4)) : null);
      }
      case 12: { // recvfrom
        const h = this.getFd(arg(0));
        if (!(h instanceof SocketHandle)) return retErr(ERR.ENOTSOCK);
        return h.recvfrom(arg(2)).then(({ data, from }) => {
          this.memory.writeBytes(arg(1), data);
          if (arg(4)) this._writeSockaddrIn(arg(4), from);
          if (arg(5)) this.memory.write32(arg(5), 16);
          return data.length;
        });
      }
      case 13: { this.getFd(arg(0)).close?.(); return 0; } // shutdown
      case 14: return 0; // setsockopt
      case 15: { // getsockopt
        if (arg(3)) this.memory.write32(arg(3), 0);
        if (arg(4)) this.memory.write32(arg(4), 4);
        return 0;
      }
      default: return retErr(ERR.ENOSYS);
    }
  }

  _poll(fdsAddr, nfds, timeoutMs) {
    let ready = 0;
    for (let i = 0; i < nfds; i++) {
      const base = fdsAddr + i * 8;
      const fd = this.memory.read32(base) | 0;
      const events = this.memory.read16(base + 4);
      let revents = 0;
      if (fd >= 0 && this.fd.has(fd)) {
        const h = this.fd.get(fd);
        if ((events & 0x0001) && (h.hasData?.() || fd === 0)) revents |= 0x0001; // POLLIN
        if (events & 0x0004) revents |= 0x0004; // POLLOUT
      } else if (fd >= 0) revents |= 0x0020; // POLLNVAL
      this.memory.write16(base + 6, revents);
      if (revents) ready++;
    }
    return ready;
  }

  _select(nfds, readfds, writefds, exceptfds, timeout) {
    const words = Math.ceil(nfds / 32);
    const getBit = (base, fd) => base && ((this.memory.read32(base + ((fd >> 5) * 4)) >>> (fd & 31)) & 1);
    const clearAll = base => { if (base) for (let i = 0; i < words; i++) this.memory.write32(base + i * 4, 0); };
    const setBit = (base, fd) => { if (base) this.memory.write32(base + ((fd >> 5) * 4), this.memory.read32(base + ((fd >> 5) * 4)) | (1 << (fd & 31))); };
    const rWanted = [], wWanted = [];
    for (let fd = 0; fd < nfds; fd++) { if (getBit(readfds, fd)) rWanted.push(fd); if (getBit(writefds, fd)) wWanted.push(fd); }
    clearAll(readfds); clearAll(writefds); clearAll(exceptfds);
    let ready = 0;
    for (const fd of rWanted) if (this.fd.has(fd) && (fd === 0 || this.fd.get(fd).hasData?.())) { setBit(readfds, fd); ready++; }
    for (const fd of wWanted) if (this.fd.has(fd)) { setBit(writefds, fd); ready++; }
    return ready;
  }

  _writeStat32(addr, st) {
    const m = this.memory;
    for (let i = 0; i < 64; i++) m.write8(addr + i, 0);
    m.write16(addr + 0, st.dev); m.write16(addr + 4, st.ino); m.write32(addr + 8, st.mode);
    m.write16(addr + 12, st.nlink); m.write16(addr + 14, st.uid); m.write16(addr + 16, st.gid); m.write16(addr + 18, st.rdev);
    m.write32(addr + 20, st.size >>> 0); m.write32(addr + 24, st.blksize); m.write32(addr + 28, st.blocks);
    m.write32(addr + 32, st.atime); m.write32(addr + 40, st.mtime); m.write32(addr + 48, st.ctime);
  }

  _writeStat64(addr, st) {
    const m = this.memory;
    for (let i = 0; i < 96; i++) m.write8(addr + i, 0);
    m.write32(addr + 0, st.dev); m.write32(addr + 4, 0); m.write32(addr + 12, st.ino >>> 0);
    m.write32(addr + 16, st.mode); m.write32(addr + 20, st.nlink); m.write32(addr + 24, st.uid); m.write32(addr + 28, st.gid);
    m.write32(addr + 32, st.rdev); m.write32(addr + 36, 0); m.write32(addr + 44, st.size >>> 0); m.write32(addr + 48, Math.floor(st.size / 0x100000000));
    m.write32(addr + 52, st.blksize); m.write32(addr + 56, st.blocks >>> 0); m.write32(addr + 60, Math.floor(st.blocks / 0x100000000));
    m.write32(addr + 64, st.atime); m.write32(addr + 68, 0); m.write32(addr + 72, st.mtime); m.write32(addr + 76, 0); m.write32(addr + 80, st.ctime); m.write32(addr + 84, 0);
    m.write32(addr + 88, st.ino >>> 0); m.write32(addr + 92, 0);
  }

  _writeUtsname(addr) {
    const fields = ["Linux", "cheerpx-cleanroom", "6.1.0-emulated", "#1 CleanRoom", "i686", "localdomain"];
    for (let i = 0; i < fields.length; i++) {
      const bytes = stringToBytes(fields[i]);
      const off = addr + i * 65;
      for (let j = 0; j < 65; j++) this.memory.write8(off + j, 0);
      this.memory.writeBytes(off, bytes.subarray(0, 64));
    }
  }

  _writeTimeval(addr) { const nowMs = Date.now(); this.memory.write32(addr, Math.floor(nowMs / 1000)); this.memory.write32(addr + 4, (nowMs % 1000) * 1000); }
  _writeTimespec(addr) { const nowMs = Date.now(); this.memory.write32(addr, Math.floor(nowMs / 1000)); this.memory.write32(addr + 4, (nowMs % 1000) * 1000000); }
  _readTimespecMs(addr) { if (!addr) return null; const sec = this.memory.read32(addr) >>> 0; const nsec = this.memory.read32(addr + 4) >>> 0; return sec * 1000 + Math.ceil(nsec / 1000000); }
  _writeRandom(addr, len) { const out = new Uint8Array(len >>> 0); const c = globalThis.crypto; if (c?.getRandomValues) c.getRandomValues(out); else for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 256) & 0xff; this.memory.writeBytes(addr, out); return out.length; }
  _writeSigaction(addr, action) { if (!addr) return; for (let i = 0; i < 16; i++) this.memory.write8(addr + i, 0); this.memory.write32(addr, action.handler ?? 0); this.memory.write32(addr + 4, action.mask ?? 0); this.memory.write32(addr + 8, action.flags ?? 0); this.memory.write32(addr + 12, action.restorer ?? 0); }
  _readSigaction(addr) { if (!addr) return { handler: 0, mask: 0, flags: 0, restorer: 0 }; return { handler: this.memory.read32(addr), mask: this.memory.read32(addr + 4), flags: this.memory.read32(addr + 8), restorer: this.memory.read32(addr + 12) }; }

  _mmap(addr, length, prot, flags, fd, offset) {
    length >>>= 0;
    if (length === 0) return retErr(ERR.EINVAL);
    const perm = protToPerm(prot);
    const fixed = (flags & 0x10) !== 0;
    const mapAddr = fixed && addr ? (addr >>> 0) : this.memory.findFreeRegion(length, { min: this.mmapMin, max: this.mmapMax });
    this.memory.map(mapAddr, length, perm, fd === 0xffffffff || fd === -1 ? "[anon]" : `[fd:${fd}]`);
    if (fd !== -1 && fd !== 0xffffffff && this.fd.has(fd)) {
      const h = this.fd.get(fd);
      if (h?.node?.type === "file") {
        const slice = h.node.data.subarray(offset, offset + length);
        const oldPerm = perm;
        this.memory.protect(mapAddr, length, PERM.RW | PERM.X);
        this.memory.writeBytes(mapAddr, slice);
        this.memory.protect(mapAddr, length, oldPerm);
      }
    }
    return mapAddr >>> 0;
  }

  _getdents64(fd, dirp, count) {
    const h = this.getFd(fd);
    const entries = h.readdir(count);
    let off = 0;
    for (const e of entries) {
      const name = stringToBytes(e.name);
      const reclen = align(19 + name.length + 1, 8);
      if (off + reclen > count) break;
      const base = dirp + off;
      const st = e.node.stat();
      this.memory.write32(base + 0, st.ino >>> 0); this.memory.write32(base + 4, 0);
      this.memory.write32(base + 8, h.dirOffset >>> 0); this.memory.write32(base + 12, 0);
      this.memory.write16(base + 16, reclen); this.memory.write8(base + 18, modeToDType(st.mode));
      this.memory.writeBytes(base + 19, name); this.memory.write8(base + 19 + name.length, 0);
      for (let i = 19 + name.length + 1; i < reclen; i++) this.memory.write8(base + i, 0);
      off += reclen;
    }
    return off;
  }

  _getdents(fd, dirp, count) {
    const h = this.getFd(fd);
    const entries = h.readdir(count);
    let off = 0;
    for (const e of entries) {
      const name = stringToBytes(e.name);
      const reclen = align(10 + name.length + 1 + 1, 4);
      if (off + reclen > count) break;
      const base = dirp + off;
      const st = e.node.stat();
      this.memory.write32(base + 0, st.ino >>> 0);
      this.memory.write32(base + 4, h.dirOffset >>> 0);
      this.memory.write16(base + 8, reclen);
      this.memory.writeBytes(base + 10, name); this.memory.write8(base + 10 + name.length, 0);
      this.memory.write8(base + reclen - 1, modeToDType(st.mode));
      off += reclen;
    }
    return off;
  }

  handle(cpu) {
    const r = cpu.regs;
    const nr = r[REG.EAX] >>> 0;
    const a1 = r[REG.EBX] >>> 0, a2 = r[REG.ECX] >>> 0, a3 = r[REG.EDX] >>> 0, a4 = r[REG.ESI] >>> 0, a5 = r[REG.EDI] >>> 0, a6 = r[REG.EBP] >>> 0;
    let ret;
    const traceRecord = this.trace || this.onSyscall ? { nr, args: [a1, a2, a3, a4, a5, a6], eip: cpu.eip >>> 0 } : null;
    try { ret = this.dispatch(cpu, nr, a1, a2, a3, a4, a5, a6); }
    catch (e) {
      if (e instanceof ProcessExit || e instanceof ExecveTrap) throw e;
      if (e instanceof VFSError) ret = retErr(e.errno);
      else throw e;
    }
    if (isPromiseLike(ret)) {
      throw new AsyncSyscallPending(Promise.resolve(ret).then(value => {
        if (traceRecord) { traceRecord.ret = value === undefined ? r[REG.EAX] >>> 0 : value >>> 0; this.syscallTrace.push(traceRecord); this.onSyscall?.(traceRecord); }
        if (value !== undefined) r[REG.EAX] = value >>> 0;
      }).catch(e => {
        if (e instanceof ProcessExit || e instanceof ExecveTrap) throw e;
        if (e instanceof VFSError) r[REG.EAX] = retErr(e.errno) >>> 0;
        else throw e;
      }));
    }
    if (traceRecord) { traceRecord.ret = ret === undefined ? r[REG.EAX] >>> 0 : ret >>> 0; this.syscallTrace.push(traceRecord); this.onSyscall?.(traceRecord); }
    if (ret !== undefined) r[REG.EAX] = ret >>> 0;
  }

  dispatch(cpu, nr, a1, a2, a3, a4, a5, a6) {
    switch (nr) {
      case 1: throw new ProcessExit(a1 | 0);
      case 2: return this.onFork ? this.onFork(cpu, "fork") : retErr(ERR.ENOSYS); // fork
      case 3: return this._readInto(a1, a2, a3);
      case 4: return this._writeFrom(a1, a2, a3);
      case 5: { this._refreshProcFiles(); const path = this._path(a1); return this.allocFd(this.vfs.open(path, a2, a3)); }
      case 6: return this.closeFd(a1);
      case 7: return this.onWait4 ? this.onWait4(a1 | 0, a2, 0, 0) : retErr(ERR.ECHILD); // waitpid
      case 8: return this.allocFd(this.vfs.open(this._path(a1), O.CREAT | O.WRONLY | O.TRUNC, a2)); // creat
      case 10: this.vfs.unlink(this._path(a1)); return 0;
      case 11: { const path = this._path(a1); const argv = this._readCStringArray(a2); const env = this._readCStringArray(a3); if (this.onExecve) return this.onExecve(path, argv, env, cpu); throw new ExecveTrap(path, argv, env); }
      case 12: { const p = this.vfs.normalize(this._path(a1), this.cwd); const st = this.vfs.stat(p); if ((st.mode & 0o170000) !== S_IFDIR) return retErr(ERR.ENOTDIR); this.cwd = p; this.vfs.cwd = p; return 0; }
      case 13: { const t = nowSeconds(); if (a1) this.memory.write32(a1, t); return t; }
      case 14: { const mode = a2 >>> 0; if ((mode & 0o170000) === S_IFCHR) { this.vfs.mknod(this._path(a1), "null", mode & 0o777, a3); return 0; } this.vfs.writeFile(this._path(a1), new Uint8Array(0), mode & 0o777); return 0; } // mknod
      case 15: { this.vfs.chmod(this._path(a1), a2); return 0; }
      case 16: { this.vfs.chown(this._path(a1), a2 | 0, a3 | 0); return 0; }
      case 18: { this._writeStat32(a2, this.vfs.stat(this._path(a1))); return 0; } // oldstat
      case 19: return this.getFd(a1).lseek(a2 | 0, a3);
      case 20: return this.pid;
      case 23: this.uid = a1 >>> 0; return 0; // setuid
      case 24: return this.uid;
      case 30: this.vfs.utimes(this._path(a1), nowSeconds(), nowSeconds()); return 0; // utime minimal
      case 33: { try { this.vfs.stat(this._path(a1)); return 0; } catch (e) { if (e instanceof VFSError) return retErr(e.errno); throw e; } }
      case 46: this.gid = a1 >>> 0; return 0; // setgid
      case 37: return 0; // kill: no-op
      case 38: this.vfs.rename(this._path(a1), this._path(a2)); return 0; // rename
      case 39: this.vfs.mkdir(this._path(a1), a2); return 0; // mkdir
      case 40: this.vfs.rmdir(this._path(a1)); return 0; // rmdir
      case 41: return this.allocFd(this.getFd(a1)); // dup
      case 42: { const pipe = { buffer: new Uint8Array(0) }; const rfd = this.allocFd(new PipeEnd(pipe, true, false)); const wfd = this.allocFd(new PipeEnd(pipe, false, true)); this.memory.write32(a1, rfd); this.memory.write32(a1 + 4, wfd); return 0; }
      case 46: this.gid = a1 >>> 0; return 0; // setgid
      case 47: return this.gid;
      case 49: return this.uid; // geteuid
      case 50: return this.gid; // getegid
      case 45: { if (a1 === 0) return this.brk >>> 0; if (a1 > this.brk) this.memory.map(this.brk, a1 - this.brk, PERM.RW, "[heap]"); this.brk = a1 >>> 0; return this.brk; }
      case 54: { // ioctl
        if (a2 === 0x5401) { // TCGETS: zero termios
          for (let i = 0; i < 44; i++) this.memory.write8(a3 + i, 0);
          return 0;
        }
        if (a2 === 0x5413) { // TIOCGWINSZ
          this.memory.write16(a3 + 0, 24); this.memory.write16(a3 + 2, 80); this.memory.write16(a3 + 4, 0); this.memory.write16(a3 + 6, 0); return 0;
        }
        return retErr(ERR.ENOTTY);
      }
      case 55: return this._fcntl(a1, a2, a3); // fcntl
      case 57: return 0; // setpgid
      case 60: { const old = this.umask ?? 0o022; this.umask = a1 & 0o777; return old; } // umask
      case 63: { const h = this.getFd(a1); this.fd.set(a2, h); return a2; } // dup2
      case 64: return this.ppid;
      case 65: return this.pid;
      case 66: return this.pid;
      case 76: case 191: { // getrlimit/ugetrlimit
        const inf = 0x7fffffff; this.memory.write32(a2, inf); this.memory.write32(a2 + 4, inf); return 0;
      }
      case 78: { this._writeTimeval(a1); if (a2) { this.memory.write32(a2, 0); this.memory.write32(a2 + 4, 0); } return 0; }
      case 83: { this.vfs.symlink(this._path(a1), this._path(a2)); return 0; }
      case 85: { const target = stringToBytes(this.vfs.readlink(this._path(a1))); const n = Math.min(target.length, a3); this.memory.writeBytes(a2, target.subarray(0, n)); return n; }
      case 92: { this.vfs.truncate(this._path(a1), a2); return 0; }
      case 93: { const h = this.getFd(a1); if (!h.node || h.node.type !== "file") return retErr(ERR.EINVAL); const out = new Uint8Array(a2 >>> 0); out.set(h.node.data.subarray(0, Math.min(a2 >>> 0, h.node.data.length))); h.node.data = out; return 0; }
      case 94: { const h = this.getFd(a1); if (h.node) h.node.mode = (h.node.mode & 0o170000) | (a2 & 0o7777); return 0; }
      case 95: { const h = this.getFd(a1); if (h.node) { if ((a2 | 0) >= 0) h.node.uid = a2; if ((a3 | 0) >= 0) h.node.gid = a3; } return 0; }
      case 90: { // old mmap(struct mmap_arg_struct*)
        const p = a1; return this._mmap(this.memory.read32(p), this.memory.read32(p + 4), this.memory.read32(p + 8), this.memory.read32(p + 12), this.memory.read32(p + 16) | 0, this.memory.read32(p + 20));
      }
      case 91: this.memory.unmap(a1, a2); return 0;
      case 102: return this._socketCall(a1, a2);
      case 106: { this._writeStat32(a2, this.vfs.stat(this._path(a1))); return 0; }
      case 107: { this._writeStat32(a2, this.vfs.lstat(this._path(a1))); return 0; }
      case 108: { this._writeStat32(a2, this.getFd(a1).stat()); return 0; }
      case 114: return this.onWait4 ? this.onWait4(a1 | 0, a2, a3, a4) : retErr(ERR.ECHILD); // wait4
      case 118: return 0; // fsync: VFS writes are committed immediately
      case 119: return 0; // sigreturn: signal frames are not injected unless process manager requests them
      case 120: { // clone: support fork-like SIGCHLD clones; reject thread-sharing clones
        const threadFlags = 0x00000100 | 0x00000200 | 0x00000400 | 0x00010000 | 0x00020000 | 0x00040000 | 0x00080000;
        return (a1 & threadFlags) ? retErr(ERR.ENOSYS) : (this.onFork ? this.onFork(cpu, "clone") : retErr(ERR.ENOSYS));
      }
      case 122: this._writeUtsname(a1); return 0;
      case 126: return 0; // sigprocmask, old ABI
      case 131: return 0; // sigaltstack
      case 132: return this.pid; // getpgid
      case 133: { const h = this.getFd(a1); if (!h.path) return retErr(ERR.ENOTDIR); const st = h.stat(); if ((st.mode & 0o170000) !== S_IFDIR) return retErr(ERR.ENOTDIR); this.cwd = h.path; this.vfs.cwd = h.path; return 0; }
      case 143: return 0; // flock
      case 144: return 0; // msync
      case 158: return 0; // sched_yield
      case 125: this.memory.protect(a1, a2, protToPerm(a3)); return 0;
      case 140: { // _llseek(fd, hi, lo, result, whence)
        const off = Number((BigInt(a2) << 32n) | BigInt(a3)); const pos = this.getFd(a1).lseek(off, a5); this.memory.write32(a4, pos >>> 0); this.memory.write32(a4 + 4, 0); return 0;
      }
      case 141: return this._getdents(a1, a2, a3);
      case 142: return this._select(a1, a2, a3, a4, a5); // _newselect
      case 145: { // readv
        const readOne = i => {
          const base = this.memory.read32(a2 + i * 8);
          const len = this.memory.read32(a2 + i * 8 + 4);
          return this._readInto(a1, base, len);
        };
        let total = 0;
        const loop = i => {
          if (i >= a3) return total;
          const n = readOne(i);
          if (isPromiseLike(n)) return n.then(v => { total += v; return v < this.memory.read32(a2 + i * 8 + 4) ? total : loop(i + 1); });
          total += n;
          return n < this.memory.read32(a2 + i * 8 + 4) ? total : loop(i + 1);
        };
        return loop(0);
      }
      case 146: { // writev
        let total = 0; const h = this.getFd(a1); const pending = [];
        for (let i = 0; i < a3; i++) {
          const base = this.memory.read32(a2 + i * 8); const len = this.memory.read32(a2 + i * 8 + 4);
          const n = h.write(this.memory.readBytes(base, len));
          if (isPromiseLike(n)) pending.push(n.then(v => { total += v; })); else total += n;
        }
        return pending.length ? Promise.all(pending).then(() => total) : total;
      }
      case 162: return new Promise(resolve => setTimeout(() => resolve(0), this._readTimespecMs(a1) ?? 0)); // nanosleep
      case 163: { const newAddr = this.memory.findFreeRegion(a3 || a2, { min: this.mmapMin, max: this.mmapMax }); this.memory.map(newAddr, a3 || a2, PERM.RW, "[mremap]"); return newAddr; }
      case 168: return this._poll(a1, a2, a3); // poll
      case 172: return 0; // prctl
      case 173: return 0; // rt_sigreturn
      case 174: { const sig = a1 >>> 0; if (a3) this._writeSigaction(a3, this.signalActions.get(sig) ?? {}); if (a2) this.signalActions.set(sig, this._readSigaction(a2)); return 0; }
      case 175: return 0; // rt_sigprocmask
      case 180: { const h = this.getFd(a1); const old = h.offset ?? 0; h.offset = a4 >>> 0; const r = this._readInto(a1, a2, a3); h.offset = old; return r; }
      case 181: { const h = this.getFd(a1); const old = h.offset ?? 0; h.offset = a4 >>> 0; const r = this._writeFrom(a1, a2, a3); h.offset = old; return r; }
      case 183: { const cwdBytes = stringToBytes(this.cwd + "\0"); if (cwdBytes.length > a2) return retErr(ERR.ERANGE); this.memory.writeBytes(a1, cwdBytes); return a1; }
      case 190: return this.onFork ? this.onFork(cpu, "vfork") : retErr(ERR.ENOSYS); // vfork
      case 192: return this._mmap(a1, a2, a3, a4, a5 | 0, (a6 >>> 0) * 4096);
      case 195: { this._refreshProcFiles(); this._writeStat64(a2, this.vfs.stat(this._path(a1))); return 0; }
      case 196: { this._writeStat64(a2, this.vfs.lstat(this._path(a1))); return 0; }
      case 197: { this._writeStat64(a2, this.getFd(a1).stat()); return 0; }
      case 198: { this.vfs.chown(this._path(a1), a2 | 0, a3 | 0, { noFollow: true }); return 0; } // lchown32
      case 199: return this.uid;
      case 200: return this.gid;
      case 201: return this.uid;
      case 202: return this.gid;
      case 203: case 204: return 0;
      case 220: return this._getdents64(a1, a2, a3);
      case 221: return 0; // fcntl64
      case 224: return this.pid;
      case 240: { // futex
        const FUTEX_WAIT = 0, FUTEX_WAKE = 1, FUTEX_REQUEUE = 3, FUTEX_CMP_REQUEUE = 4;
        const op = a2 & 0x7f;
        if (op === FUTEX_WAIT) {
          if (this.memory.read32(a1) !== (a3 >>> 0)) return retErr(ERR.EAGAIN);
          return this.futex.wait(a1, a3, this._readTimespecMs(a4)).then(v => v === -110 ? retErr(ERR.ETIMEDOUT) : 0);
        }
        if (op === FUTEX_WAKE) return this.futex.wake(a1, a3 || 1);
        if (op === FUTEX_REQUEUE || op === FUTEX_CMP_REQUEUE) return this.futex.wake(a1, a3 || 1);
        return 0;
      }
      case 243: { // set_thread_area(struct user_desc*)
        let entry = this.memory.read32(a1) | 0;
        if (entry === -1) { entry = 6; this.memory.write32(a1, entry); }
        const base = this.memory.read32(a1 + 4);
        const limit = this.memory.read32(a1 + 8);
        const flags = this.memory.read32(a1 + 12);
        this.threadArea = { entry, base, limit, flags };
        cpu.segBase.gs = base >>> 0;
        cpu.sregs.gs = ((entry << 3) | 3) & 0xffff;
        return 0;
      }
      case 244: { this.memory.write32(a1, this.threadArea.entry); this.memory.write32(a1 + 4, this.threadArea.base); this.memory.write32(a1 + 8, this.threadArea.limit); this.memory.write32(a1 + 12, this.threadArea.flags); return 0; }
      case 252: throw new ProcessExit(a1 | 0);
      case 254: return this.allocFd(new EpollHandle(this)); // epoll_create
      case 255: { const h = this.getFd(a1); if (!(h instanceof EpollHandle)) return retErr(ERR.EINVAL); return h.ctl(a2, a3, a4); } // epoll_ctl
      case 256: { const h = this.getFd(a1); if (!(h instanceof EpollHandle)) return retErr(ERR.EINVAL); return h.wait(a2, a3, a4); } // epoll_wait
      case 258: if (a1) this.clearChildTid = a1; return this.pid; // set_tid_address
      case 265: this._writeTimespec(a2); return 0;
      case 266: this.memory.write32(a2, 0); this.memory.write32(a2 + 4, 1); return 0;
      case 268: case 269: { // statfs64/fstatfs64 minimal
        const buf = nr === 268 ? a3 : a2; for (let i = 0; i < 84; i++) this.memory.write8(buf + i, 0); this.memory.write32(buf + 0, 0xEF53); this.memory.write32(buf + 4, 4096); return 0;
      }
      case 295: { // openat(dirfd,path,flags,mode)
        this._refreshProcFiles(); return this.allocFd(this.vfs.open(this._pathAt(a1 | 0, a2), a3, a4));
      }
      case 296: this.vfs.mkdir(this._pathAt(a1 | 0, a2), a3); return 0; // mkdirat
      case 297: { const mode = a3 >>> 0; const pth = this._pathAt(a1 | 0, a2); if ((mode & 0o170000) === S_IFCHR) this.vfs.mknod(pth, "null", mode & 0o777, a4); else this.vfs.writeFile(pth, new Uint8Array(0), mode & 0o777); return 0; } // mknodat
      case 298: this.vfs.chown(this._pathAt(a1 | 0, a2), a3 | 0, a4 | 0); return 0; // fchownat
      case 299: return 0; // futimesat compatibility
      case 300: { this._writeStat64(a4, (a5 & 0x100) ? this.vfs.lstat(this._pathAt(a1 | 0, a2)) : this.vfs.stat(this._pathAt(a1 | 0, a2))); return 0; } // fstatat64
      case 301: { const pth = this._pathAt(a1 | 0, a2); if (a3 & 0x200) this.vfs.rmdir(pth); else this.vfs.unlink(pth); return 0; } // unlinkat
      case 302: this.vfs.rename(this._pathAt(a1 | 0, a2), this._pathAt(a3 | 0, a4)); return 0; // renameat
      case 303: this.vfs.link(this._pathAt(a1 | 0, a2), this._pathAt(a3 | 0, a4)); return 0; // linkat
      case 304: this.vfs.symlink(this._path(a1), this._pathAt(a2 | 0, a3)); return 0; // symlinkat
      case 305: { const target = stringToBytes(this.vfs.readlink(this._pathAt(a1 | 0, a2))); const n = Math.min(target.length, a4); this.memory.writeBytes(a3, target.subarray(0, n)); return n; } // readlinkat
      case 306: this.vfs.chmod(this._pathAt(a1 | 0, a2), a3); return 0; // fchmodat
      case 307: { try { this.vfs.stat(this._pathAt(a1 | 0, a2)); return 0; } catch (e) { if (e instanceof VFSError) return retErr(e.errno); throw e; } } // faccessat
      case 308: return this._select(a1, a2, a3, a4, 0); // pselect6 minimal
      case 309: return this._poll(a1, a2, a3); // ppoll minimal
      case 311: return 0; // set_robust_list
      case 312: if (a1) this.memory.write32(a1, 0); if (a2) this.memory.write32(a2, 0); return 0; // get_robust_list
      case 319: { const h = this.getFd(a1); if (!(h instanceof EpollHandle)) return retErr(ERR.EINVAL); return h.wait(a2, a3, a4); } // epoll_pwait
      case 320: { const pth = this._pathAt(a1 | 0, a2); const at = a3 ? this._timespecSeconds(a3) : nowSeconds(); const mt = a3 ? this._timespecSeconds(a3 + 8) : at; this.vfs.utimes(pth, at, mt, { noFollow: !!(a4 & 0x100) }); return 0; } // utimensat
      case 323: return this.allocFd(new EventFdHandle(a1, 0)); // eventfd (legacy)
      case 322: return this.allocFd(new EventFdHandle(a1, a2)); // signalfd placeholder fd
      case 328: return this.allocFd(new EventFdHandle(a1, a2)); // eventfd2
      case 329: return this.allocFd(new EpollHandle(this)); // epoll_create1 alias on some i386 tables
      case 330: return this.allocFd(new EpollHandle(this)); // epoll_create1
      case 331: { if (a1 === a2) return retErr(ERR.EINVAL); const h = this.getFd(a1); this.fd.set(a2, h); return a2; } // dup3
      case 332: { const pipe = { buffer: new Uint8Array(0) }; const rfd = this.allocFd(new PipeEnd(pipe, true, false)); const wfd = this.allocFd(new PipeEnd(pipe, false, true)); this.memory.write32(a1, rfd); this.memory.write32(a1 + 4, wfd); return 0; } // pipe2
      case 340: { const inf = 0x7fffffff; const out = a4 || a3; if (out) { this.memory.write32(out, inf); this.memory.write32(out + 4, inf); } return 0; } // prlimit64
      case 355: return this._fillRandom(a1, a2); // getrandom
      case 383: { const st = this.vfs.stat(this._pathAt(a1 | 0, a2)); this._writeStatx(a5, st); return 0; } // statx
      case 403: this._writeTimespec(a2); return 0; // clock_gettime64
      case 406: this.memory.write32(a2, 0); this.memory.write32(a2 + 4, 1); this.memory.write32(a2 + 8, 0); this.memory.write32(a2 + 12, 0); return 0; // clock_getres_time64
      case 412: { const pth = this._pathAt(a1 | 0, a2); const at = a3 ? this._timespecSeconds(a3) : nowSeconds(); const mt = a3 ? this._timespecSeconds(a3 + 16) : at; this.vfs.utimes(pth, at, mt, { noFollow: !!(a4 & 0x100) }); return 0; } // utimensat_time64
      case 413: return this._select(a1, a2, a3, a4, 0); // pselect6_time64 minimal
      case 414: return this._poll(a1, a2, a3); // ppoll_time64 minimal
      case 422: return this.dispatch(cpu, 240, a1, a2, a3, a4, a5, a6); // futex_time64
      default:
        return retErr(ERR.ENOSYS);
    }
  }
}
