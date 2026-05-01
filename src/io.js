import { stringToBytes } from "./util.js";

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return stringToBytes(data);
  return new Uint8Array(data ?? []);
}

export class ByteQueue {
  constructor(initial = "") {
    this.chunks = [];
    this.length = 0;
    this.waiters = [];
    this.closed = false;
    if (initial && (typeof initial !== "string" || initial.length)) this.push(initial);
  }
  push(data) {
    if (this.closed) return;
    const bytes = asBytes(data);
    if (!bytes.length) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
    this._flush();
  }
  close() { this.closed = true; this._flush(); }
  _take(count) {
    const n = Math.min(count >>> 0, this.length);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n && this.chunks.length) {
      const first = this.chunks[0];
      const take = Math.min(first.length, n - off);
      out.set(first.subarray(0, take), off);
      off += take;
      if (take === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(take);
    }
    this.length -= n;
    return out;
  }
  _flush() {
    while (this.waiters.length && (this.length > 0 || this.closed)) {
      const { count, resolve } = this.waiters.shift();
      resolve(this.length > 0 ? this._take(count) : new Uint8Array(0));
    }
  }
  read(count) {
    count >>>= 0;
    if (count === 0) return new Uint8Array(0);
    if (this.length > 0) return this._take(count);
    if (this.closed) return new Uint8Array(0);
    return new Promise(resolve => this.waiters.push({ count, resolve }));
  }
}
