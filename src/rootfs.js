import { mountTar } from "./tar.js";
import { stringToBytes } from "./util.js";

export const ALPINE_VERSION = "3.23.4";
export const ALPINE_ARCH = "x86";
export const ALPINE_X86_MINIROOTFS_URL = `https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86/alpine-minirootfs-${ALPINE_VERSION}-${ALPINE_ARCH}.tar.gz`;
export const ALPINE_REPOSITORY_BASE = "https://dl-cdn.alpinelinux.org/alpine/v3.23";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return stringToBytes(data);
  return new Uint8Array(data ?? []);
}

export async function gzipDecompress(bytes) {
  const u8 = asBytes(bytes);
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error("gzip rootfs support requires DecompressionStream in this entrypoint; Node >=18 and modern browsers provide it");
}

export async function fetchBytes(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("fetch is unavailable; pass { fetch } or provide a local rootfs file");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function _firstExisting(vfs, paths) { for (const p of paths) { try { if (vfs.exists(p)) return p; } catch {} } return null; }
function _safeSymlink(vfs, target, link) {
  try { if (!vfs.exists(link) && vfs.exists(target)) vfs.symlink(target, link); } catch {}
}

export function findAlpinePreloadLibraries(vfs) {
  const groups = [
    ["/lib/libz.so.1", "/usr/lib/libz.so.1"],
    ["/lib/libcrypto.so.3", "/usr/lib/libcrypto.so.3"],
    ["/lib/libssl.so.3", "/usr/lib/libssl.so.3"],
  ];
  return groups.map(g => _firstExisting(vfs, g)).filter(Boolean);
}

export function buildAlpineRuntimeEnv(vfs, baseEnv = {}, execPath = "") {
  const env = Array.isArray(baseEnv) ? Object.fromEntries(baseEnv.map(x => { const i = String(x).indexOf("="); return i === -1 ? [String(x), ""] : [String(x).slice(0, i), String(x).slice(i + 1)]; })) : { ...baseEnv };
  env.PATH ??= "/sbin:/bin:/usr/sbin:/usr/bin";
  env.HOME ??= "/root";
  env.USER ??= "root";
  env.SHELL ??= "/bin/sh";
  env.TERM ??= "xterm";
  env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${env.LD_LIBRARY_PATH}:/lib:/usr/lib` : "/lib:/usr/lib";
  // Alpine apk-tools in recent minirootfs builds may expose OpenSSL/zlib symbols through
  // transitive or optional libapk dependencies. Preloading the real guest libraries makes
  // the guest musl resolver see those symbols without host-side native shims.
  if ((execPath === "apk" || execPath.endsWith("/apk") || execPath.endsWith("/sbin/apk")) && !env.LD_PRELOAD) {
    const preload = findAlpinePreloadLibraries(vfs).join(":");
    if (preload) env.LD_PRELOAD = preload;
  }
  return env;
}

export function seedAlpineRuntimeFiles(vfs, options = {}) {
  vfs.mkdirp("/proc/self/fd");
  vfs.mkdirp("/sys");
  vfs.mkdirp("/run");
  vfs.mkdirp("/var/cache/apk");
  vfs.mkdirp("/var/lib/apk");
  vfs.mkdirp("/var/tmp");
  vfs.mkdirp("/root");
  vfs.mkdirp("/etc/apk");
  vfs.writeFile("/etc/resolv.conf", options.resolvConf ?? "nameserver 10.0.2.3\noptions timeout:1 attempts:1\n");
  vfs.writeFile("/etc/hosts", options.hosts ?? "127.0.0.1 localhost localhost.localdomain\n10.0.2.2 host.local\n");
  vfs.writeFile("/etc/apk/repositories", options.repositories ?? `${ALPINE_REPOSITORY_BASE}/main\n${ALPINE_REPOSITORY_BASE}/community\n`);
  vfs.writeFile("/etc/ld-musl-i386.path", "/lib\n/usr/local/lib\n/usr/lib\n");
  for (const soname of ["libz.so.1", "libcrypto.so.3", "libssl.so.3"]) {
    _safeSymlink(vfs, `/lib/${soname}`, `/usr/lib/${soname}`);
    _safeSymlink(vfs, `/usr/lib/${soname}`, `/lib/${soname}`);
  }
  vfs.writeFile("/etc/profile", "export PATH=/sbin:/bin:/usr/sbin:/usr/bin\nexport HOME=/root\nexport TERM=xterm\nexport LD_LIBRARY_PATH=/lib:/usr/lib\n");
  vfs.writeFile("/etc/issue", `OpenX86 Alpine ${ALPINE_VERSION} (${ALPINE_ARCH}) on clean-room JS IA-32\n`);
  vfs.writeFile("/proc/mounts", "rootfs / rootfs rw 0 0\nproc /proc proc rw 0 0\ndevtmpfs /dev devtmpfs rw 0 0\n");
  vfs.writeFile("/proc/version", "Linux version 6.12.0-openx86 (clean-room user-mode emulation)\n");
  vfs.writeFile("/proc/uptime", "1.00 0.50\n");
  vfs.writeFile("/proc/loadavg", "0.00 0.00 0.00 1/1 100\n");
  vfs.writeFile("/proc/meminfo", "MemTotal:        262144 kB\nMemFree:         196608 kB\nMemAvailable:    196608 kB\nBuffers:              0 kB\nCached:           32768 kB\nSwapCached:           0 kB\nActive:           32768 kB\nInactive:         32768 kB\nSwapTotal:            0 kB\nSwapFree:             0 kB\n");
  vfs.writeFile("/proc/stat", "cpu  1 0 1 100 0 0 0 0 0 0\ncpu0 1 0 1 100 0 0 0 0 0 0\nintr 0\nctxt 0\nbtime 1\nprocesses 1\nprocs_running 1\nprocs_blocked 0\n");
  for (const [fd, target] of [["0", "/dev/tty"], ["1", "/dev/tty"], ["2", "/dev/tty"]]) {
    try { if (!vfs.exists(`/proc/self/fd/${fd}`)) vfs.symlink(target, `/proc/self/fd/${fd}`); } catch {}
  }
}

export async function mountAlpineMiniRootfs(vfs, options = {}) {
  const progress = options.progress ?? (() => {});
  let archive;
  if (options.bytes) { progress("using supplied Alpine minirootfs archive"); archive = asBytes(options.bytes); }
  else { const url = options.url ?? ALPINE_X86_MINIROOTFS_URL; progress(`fetching ${url}`); archive = await fetchBytes(url, options); }
  progress(`decompressing ${Math.round(archive.length / 1024)} KiB gzip archive`);
  const tar = await gzipDecompress(archive);
  progress(`unpacking ${Math.round(tar.length / 1024)} KiB tar image into VFS`);
  const mounted = mountTar(vfs, tar, { root: options.root ?? "/", ignoreErrors: options.ignoreErrors ?? false });
  seedAlpineRuntimeFiles(vfs, options);
  const stats = { entries: mounted.entries.length, files: mounted.count, dirs: 0, symlinks: 0 };
  progress(`mounted ${mounted.count} tar entries`);
  return stats;
}
