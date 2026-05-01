import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = new URL("..", import.meta.url);
mkdirSync(fileURLToPath(new URL("samples", root)), { recursive: true });
function u16le(a, off, v) { a[off] = v & 255; a[off + 1] = (v >>> 8) & 255; }
function u32le(a, off, v) { a[off] = v & 255; a[off + 1] = (v >>> 8) & 255; a[off + 2] = (v >>> 16) & 255; a[off + 3] = (v >>> 24) & 255; }
function imm32(v) { return [v, v >>> 8, v >>> 16, v >>> 24].map(x => x & 255); }
function elfFromCodeAndData(code, data = new Uint8Array(0), base = 0x08048000) {
  const eh = 52, ph = 32;
  const entryOff = eh + ph;
  const entry = base + entryOff;
  const fileSize = entryOff + code.length + data.length;
  const a = new Uint8Array(fileSize);
  Object.assign(a, [0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
  u16le(a, 16, 2); u16le(a, 18, 3); u32le(a, 20, 1); u32le(a, 24, entry); u32le(a, 28, eh); u32le(a, 32, 0); u32le(a, 36, 0);
  u16le(a, 40, eh); u16le(a, 42, ph); u16le(a, 44, 1);
  u32le(a, eh + 0, 1); u32le(a, eh + 4, 0); u32le(a, eh + 8, base); u32le(a, eh + 12, base); u32le(a, eh + 16, fileSize); u32le(a, eh + 20, fileSize); u32le(a, eh + 24, 7); u32le(a, eh + 28, 0x1000);
  a.set(code, entryOff); a.set(data, entryOff + code.length);
  return { bytes: a, entry, entryOff, base };
}

{
  const msg = new TextEncoder().encode("Hello from clean-room x86 JS emulator!\n");
  const code = [];
  const push = (...xs) => code.push(...xs.map(x => x & 255));
  const codeLen = 31;
  const msgAddr = 0x08048000 + 52 + 32 + codeLen;
  push(0xb8, ...imm32(4));          // mov eax, SYS_write
  push(0xbb, ...imm32(1));          // mov ebx, stdout
  push(0xb9, ...imm32(msgAddr));    // mov ecx, msg
  push(0xba, ...imm32(msg.length)); // mov edx, len
  push(0xcd, 0x80);                 // int 0x80
  push(0xb8, ...imm32(1));          // mov eax, SYS_exit
  push(0x31, 0xdb);                 // xor ebx, ebx
  push(0xcd, 0x80);
  const { bytes } = elfFromCodeAndData(new Uint8Array(code), msg);
  writeFileSync(new URL("samples/hello.elf", root), bytes);
  writeFileSync(new URL("samples/hello.S", root), `.global _start\n_start:\n  mov $4,%eax\n  mov $1,%ebx\n  mov $msg,%ecx\n  mov $len,%edx\n  int $0x80\n  mov $1,%eax\n  xor %ebx,%ebx\n  int $0x80\nmsg: .ascii "Hello from clean-room x86 JS emulator!\\n"\nlen = . - msg\n`);
  console.log(`wrote samples/hello.elf (${bytes.length} bytes)`);
}

{
  // Exercises open/read/write/close/stat64 enough to validate VFS syscalls.
  const path = new TextEncoder().encode("/etc/hosts\0");
  const code = [];
  const push = (...xs) => code.push(...xs.map(x => x & 255));
  const base = 0x08048000, entryOff = 52 + 32;
  const pathAddr = base + entryOff + 256;
  const bufAddr = pathAddr + path.length + 16;
  push(0xb8, ...imm32(5), 0xbb, ...imm32(pathAddr), 0x31, 0xc9, 0x31, 0xd2, 0xcd, 0x80); // open(path,0,0)
  push(0x89, 0xc3); // mov ebx,eax
  push(0xb8, ...imm32(3), 0xb9, ...imm32(bufAddr), 0xba, ...imm32(64), 0xcd, 0x80); // read(fd,buf,64)
  push(0x89, 0xc2); // mov edx,eax
  push(0xb8, ...imm32(4), 0xbb, ...imm32(1), 0xb9, ...imm32(bufAddr), 0xcd, 0x80); // write(1,buf,n)
  push(0xb8, ...imm32(1), 0x31, 0xdb, 0xcd, 0x80); // exit
  while (code.length < 256) code.push(0x90);
  const data = new Uint8Array(path.length + 16 + 128);
  data.set(path, 0);
  const { bytes } = elfFromCodeAndData(new Uint8Array(code), data);
  writeFileSync(new URL("samples/read-hosts.elf", root), bytes);
  console.log(`wrote samples/read-hosts.elf (${bytes.length} bytes)`);
}
