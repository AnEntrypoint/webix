import net from "node:net";
import dns from "node:dns/promises";
import { VirtualDNS } from "./network.js";

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

export class NodeTcpNetwork {
  constructor(options = {}) { this.dns = options.dns ?? new VirtualDNS(options.dnsOptions); this.timeoutMs = options.timeoutMs ?? 30000; }
  resolve(host) { return this.dns.resolve(host); }
  reverse(ip) { return this.dns.reverse(ip); }
  async openTcp(host, port) {
    host = this.reverse(host);
    const socket = net.createConnection({ host, port, timeout: this.timeoutMs });
    const queue = [], waiters = [];
    let closed = false, error = null;
    socket.on("data", b => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); if (waiters.length) waiters.shift()(u); else queue.push(u); });
    socket.on("error", e => { error = e; closed = true; while (waiters.length) waiters.shift()(new Uint8Array(0)); });
    socket.on("close", () => { closed = true; while (waiters.length) waiters.shift()(new Uint8Array(0)); });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return {
      send(bytes) { socket.write(Buffer.from(bytes)); return bytes.length; },
      async recv(count) { if (queue.length) return takeBytes(queue, count); if (closed) return new Uint8Array(0); return new Promise(resolve => waiters.push(b => { if (b.length <= count) resolve(b); else { queue.unshift(b.subarray(count)); resolve(b.subarray(0, count)); } })); },
      close() { try { socket.end(); socket.destroy(); } catch {} closed = true; },
      hasData() { return queue.length > 0 || closed; },
      get error() { return error; },
    };
  }
  async lookup(host) { const r = await dns.lookup(host); return r.address; }
}
