#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import dns from "node:dns/promises";

const listenHost = process.env.OPENX86_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.OPENX86_GATEWAY_PORT || 8787);
const allowPrivate = process.env.OPENX86_ALLOW_PRIVATE === "1";
const allowList = (process.env.OPENX86_ALLOW_HOSTS || "").split(",").map(s => s.trim()).filter(Boolean);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
function isPrivate(host) {
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a,b] = m.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
}
function allowed(host, port) {
  if (allowList.length && !allowList.includes(host)) return false;
  if (!allowPrivate && isPrivate(host)) return false;
  return port > 0 && port < 65536;
}
function wsAccept(key) {
  return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}
function sendFrame(socket, payload) {
  const data = payload instanceof Buffer ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) header = Buffer.from([0x82, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x82; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  socket.write(Buffer.concat([header, data]));
}
function sendClose(socket) { try { socket.write(Buffer.from([0x88, 0x00])); } catch {} }

class WsParser {
  constructor(onData, onClose) { this.buf = Buffer.alloc(0); this.onData = onData; this.onClose = onClose; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; const n = this.buf.readBigUInt64BE(off); if (n > BigInt(64 * 1024 * 1024)) throw new Error("oversize websocket frame"); len = Number(n); off += 8; }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mask = this.buf.subarray(maskOff, maskOff + 4);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.onClose(); return; }
      if (opcode === 0x9) continue; // ping ignored
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) this.onData(payload);
    }
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tcp: "/tcp", dns: "/dns" }));
    return;
  }
  if (url.pathname === "/dns") {
    const name = url.searchParams.get("name") || "";
    try {
      const addresses = await dns.resolve4(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name, addresses }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name, error: e.message, addresses: [] }));
    }
    return;
  }
  res.writeHead(404); res.end("not found\n");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/tcp") { socket.destroy(); return; }
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port") || 0);
  if (!allowed(host, port)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);

  const target = net.connect({ host, port });
  target.on("data", chunk => sendFrame(socket, chunk));
  target.on("error", () => { sendClose(socket); socket.end(); });
  target.on("close", () => { sendClose(socket); socket.end(); });
  const parser = new WsParser(chunk => target.write(chunk), () => { target.end(); socket.end(); });
  socket.on("data", chunk => { try { parser.push(chunk); } catch { target.destroy(); socket.destroy(); } });
  socket.on("error", () => target.destroy());
  socket.on("close", () => target.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(`openx86 network gateway listening on http://${listenHost}:${listenPort}`);
  console.log("WebSocket TCP endpoint: ws://" + listenHost + ":" + listenPort + "/tcp?host=<host>&port=<port>");
  if (!allowPrivate) console.log("Private/loopback targets are blocked. Set OPENX86_ALLOW_PRIVATE=1 for local testing.");
});
