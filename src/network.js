import { stringToBytes, bytesToString, nowSeconds } from "./util.js";
import { S_IFSOCK, VFSError } from "./vfs.js";

const ERRNO = Object.freeze({ EINVAL: 22, ESPIPE: 29, ENOTDIR: 20, EAFNOSUPPORT: 97, ENOTCONN: 107 });
export const AF_INET = 2, SOCK_STREAM = 1, SOCK_DGRAM = 2, IPPROTO_TCP = 6, IPPROTO_UDP = 17;

function concatBytes(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
function takeBytes(queue, count) {
  let remaining = count, parts = [];
  while (remaining > 0 && queue.length) {
    const first = queue[0];
    if (first.length <= remaining) { parts.push(first); queue.shift(); remaining -= first.length; }
    else { parts.push(first.subarray(0, remaining)); queue[0] = first.subarray(remaining); remaining = 0; }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function parseQName(packet, off) {
  const labels = []; let p = off;
  while (p < packet.length) { const len = packet[p++]; if (!len) break; if ((len & 0xc0) !== 0) throw new Error("compressed DNS qname in query"); labels.push(bytesToString(packet.subarray(p, p + len))); p += len; }
  return { name: labels.join("."), next: p };
}
function ipv4ToBytes(ip) { return String(ip).split(".").map(x => Number(x) & 0xff); }
export function bytesToIPv4(bytes, off = 0) { return `${bytes[off]}.${bytes[off + 1]}.${bytes[off + 2]}.${bytes[off + 3]}`; }

export class VirtualDNS {
  constructor(options = {}) {
    this.next = options.firstHost ?? 15;
    this.hostToIp = new Map(Object.entries(options.hosts ?? {}));
    this.ipToHost = new Map([...this.hostToIp.entries()].map(([h, ip]) => [ip, h]));
    this.prefix = options.prefix ?? "10.0.2";
  }
  resolve(host) {
    host = String(host || "").toLowerCase();
    if (!host) return "0.0.0.0";
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    if (!this.hostToIp.has(host)) { const ip = `${this.prefix}.${this.next++}`; this.hostToIp.set(host, ip); this.ipToHost.set(ip, host); }
    return this.hostToIp.get(host);
  }
  reverse(ip) { return this.ipToHost.get(ip) ?? ip; }
  buildResponse(query) {
    const q = query instanceof Uint8Array ? query : new Uint8Array(query);
    if (q.length < 12) return new Uint8Array(0);
    let parsed; try { parsed = parseQName(q, 12); } catch { return new Uint8Array(0); }
    const qEnd = parsed.next + 4;
    const qtype = (q[parsed.next] << 8) | q[parsed.next + 1];
    const question = q.subarray(12, qEnd);
    const header = new Uint8Array([q[0], q[1], 0x81, 0x80, 0, 1, 0, qtype === 1 ? 1 : 0, 0, 0, 0, 0]);
    const answer = qtype === 1 ? new Uint8Array([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ipv4ToBytes(this.resolve(parsed.name))]) : new Uint8Array(0);
    const out = new Uint8Array(header.length + question.length + answer.length);
    out.set(header); out.set(question, header.length); out.set(answer, header.length + question.length);
    return out;
  }
}

export class BrowserFetchNetwork {
  constructor(options = {}) { this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis); this.proxyBase = options.proxyBase ?? ""; this.dns = options.dns ?? new VirtualDNS(options.dnsOptions); }
  resolve(host) { return this.dns.resolve(host); }
  reverse(ip) { return this.dns.reverse(ip); }
  async exchangeHttp(host, port, requestBytes) {
    if (!this.fetch) throw new Error("BrowserFetchNetwork requires fetch");
    const text = bytesToString(requestBytes);
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "GET / HTTP/1.1";
    const [methodRaw, pathRaw] = firstLine.split(/\s+/);
    const method = methodRaw || "GET", path = pathRaw || "/";
    const scheme = port === 443 ? "https" : "http";
    const url = /^https?:\/\//.test(path) ? path : `${scheme}://${host}${port && port !== 80 && port !== 443 ? `:${port}` : ""}${path}`;
    const res = this.proxyBase ? await this.fetch(`${this.proxyBase.replace(/\/$/, "")}/fetch?url=${encodeURIComponent(url)}`) : await this.fetch(url, { method: method === "HEAD" ? "HEAD" : "GET" });
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = [`HTTP/1.1 ${res.status} ${res.statusText || "OK"}`, `Content-Length: ${body.length}`, "Connection: close"];
    for (const [k, v] of res.headers) if (!["content-length", "connection"].includes(k.toLowerCase())) headers.push(`${k}: ${v}`);
    return concatBytes(stringToBytes(headers.join("\r\n") + "\r\n\r\n"), body);
  }
}

export class WebSocketTcpNetwork {
  constructor(options = {}) { this.gatewayUrl = options.gatewayUrl ?? "ws://127.0.0.1:8787/tcp"; this.dns = options.dns ?? new VirtualDNS(options.dnsOptions); }
  resolve(host) { return this.dns.resolve(host); }
  reverse(ip) { return this.dns.reverse(ip); }
  async openTcp(host, port) {
    if (typeof WebSocket === "undefined") throw new Error("WebSocketTcpNetwork requires browser WebSocket");
    const ws = new WebSocket(`${this.gatewayUrl}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`);
    ws.binaryType = "arraybuffer";
    const queue = [], waiters = []; let closed = false;
    ws.onmessage = ev => { const b = new Uint8Array(ev.data); if (waiters.length) waiters.shift()(b); else queue.push(b); };
    ws.onclose = ws.onerror = () => { closed = true; while (waiters.length) waiters.shift()(new Uint8Array(0)); };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return { send(bytes) { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); return bytes.length; }, async recv(count) { if (queue.length) return takeBytes(queue, count); if (closed) return new Uint8Array(0); const b = await new Promise(resolve => waiters.push(resolve)); if (b.length <= count) return b; queue.unshift(b.subarray(count)); return b.subarray(0, count); }, close() { try { ws.close(); } catch {} closed = true; }, hasData() { return queue.length > 0 || closed; } };
  }
}

export class SocketHandle {
  constructor(sys, domain, type, protocol) { this.sys = sys; this.domain = domain >>> 0; this.type = type & 0xf; this.protocol = protocol >>> 0; this.recvQueue = []; this.waiters = []; this.connected = false; this.peer = null; this.conn = null; this.httpBuffer = new Uint8Array(0); this.closed = false; this.lastFrom = { family: AF_INET, port: 53, ip: "10.0.2.3" }; }
  stat() { return { dev: 1, ino: 7000, mode: S_IFSOCK | 0o777, nlink: 1, uid: this.sys.uid, gid: this.sys.gid, rdev: 0, size: 0, blksize: 4096, blocks: 0, atime: nowSeconds(), mtime: nowSeconds(), ctime: nowSeconds() }; }
  lseek() { throw new VFSError(ERRNO.ESPIPE, "socket"); }
  readdir() { throw new VFSError(ERRNO.ENOTDIR, "socket"); }
  hasData() { return this.recvQueue.length > 0 || this.conn?.hasData?.() || this.closed; }
  _enqueue(bytes) { const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); if (this.waiters.length) this.waiters.shift()(b); else this.recvQueue.push(b); }
  async connect(addr) { if (this.domain !== AF_INET) throw new VFSError(ERRNO.EAFNOSUPPORT, "only AF_INET is supported"); this.peer = addr; this.connected = true; const net = this.sys.network; if (this.type === SOCK_STREAM && net?.openTcp) this.conn = await net.openTcp(net.reverse?.(addr.ip) ?? addr.ip, addr.port); return 0; }
  close() { this.closed = true; this.conn?.close?.(); while (this.waiters.length) this.waiters.shift()(new Uint8Array(0)); return 0; }
  async send(bytes) { if (!this.connected && !this.peer) throw new VFSError(ERRNO.ENOTCONN, "socket is not connected"); if (this.conn) return this.conn.send(bytes); const net = this.sys.network; if (this.type === SOCK_STREAM && net?.exchangeHttp) { this.httpBuffer = concatBytes(this.httpBuffer, bytes); if (/\r?\n\r?\n/.test(bytesToString(this.httpBuffer))) { const response = await net.exchangeHttp(net.reverse?.(this.peer.ip) ?? this.peer.ip, this.peer.port, this.httpBuffer); this.httpBuffer = new Uint8Array(0); this._enqueue(response); } return bytes.length; } return bytes.length; }
  write(bytes) { return this.send(bytes); }
  async recv(count) { if (this.recvQueue.length) return takeBytes(this.recvQueue, count); if (this.conn) return this.conn.recv(count); if (this.closed) return new Uint8Array(0); return new Promise(resolve => this.waiters.push(bytes => { if (bytes.length <= count) resolve(bytes); else { this.recvQueue.unshift(bytes.subarray(count)); resolve(bytes.subarray(0, count)); } })); }
  read(count) { return this.recv(count); }
  async sendto(bytes, addr) { if (this.type !== SOCK_DGRAM) return this.send(bytes); const net = this.sys.network; if (addr?.port === 53 && net?.dns) { this.lastFrom = { family: AF_INET, port: 53, ip: "10.0.2.3" }; this._enqueue(net.dns.buildResponse(bytes)); } return bytes.length; }
  async recvfrom(count) { return { data: await this.recv(count), from: this.lastFrom }; }
}
