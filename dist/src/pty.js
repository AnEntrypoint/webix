import { ByteQueue } from "./io.js";
import { bytesToString, stringToBytes } from "./util.js";

export class PtyEndpoint {
  constructor(options = {}) {
    this.input = new ByteQueue();
    this.output = "";
    this.rows = options.rows ?? 24;
    this.cols = options.cols ?? 80;
    this.listeners = new Set();
  }
  writeInput(text) { this.input.push(text); }
  sendLine(text = "") { this.input.push(`${text}\n`); }
  closeInput() { this.input.close(); }
  read(count) { return this.input.read(count); }
  write(bytes) {
    const text = typeof bytes === "string" ? bytes : bytesToString(bytes);
    this.output += text;
    for (const cb of this.listeners) cb(text);
    return typeof bytes === "string" ? stringToBytes(bytes).length : bytes.length;
  }
  onData(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  ioctl(request, memory, addr) {
    if (request === 0x5413) { // TIOCGWINSZ
      memory.write16(addr + 0, this.rows); memory.write16(addr + 2, this.cols); memory.write16(addr + 4, 0); memory.write16(addr + 6, 0); return 0;
    }
    return -25;
  }
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
