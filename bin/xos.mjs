#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { createKernel } from "../src/kernel.js";
import { createBlinkHost } from "../src/x86_64-blink.js";

function usage(exit=0){
  console.log(`xos - Blink-backed x86_64 Linux userspace emulator

Commands:
  xos run-x86_64 <file> [argv...]   Execute a static x86_64 ELF
  xos run-shell <busybox> <script>  Run a shell script via busybox sh
  xos help                          Show this message
`);
  process.exit(exit);
}

const [cmd, ...args] = process.argv.slice(2);
const handlers = {
  "help": () => usage(0),
  "--help": () => usage(0),
  "run-x86_64": async () => {
    const file=args.shift(); if(!file) usage(2);
    const bytes=new Uint8Array(await readFile(file));
    if(bytes[0]!==0x7f||bytes[4]!==2||new DataView(bytes.buffer).getUint16(18,true)!==62){
      console.error("not an ELF64-x86_64 file:",file); process.exit(2);
    }
    const r=await createKernel({}).runX86_64Bytes(bytes,{argv:args});
    if(r.stdout) process.stdout.write(r.stdout);
    if(r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode??0);
  },
  "run-shell": async () => {
    const [bb,script]=args; if(!bb||!script) usage(2);
    const host=await createBlinkHost({});
    const r=await host.runShellScript(new Uint8Array(await readFile(bb)), await readFile(script,"utf8"));
    if(r.stdout) process.stdout.write(r.stdout);
    if(r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode??0);
  }
};

try{
  const fn=handlers[cmd]||(()=>usage(cmd?2:0));
  await fn();
}catch(e){ console.error(e?.stack||e?.message||String(e)); process.exit(1) }
