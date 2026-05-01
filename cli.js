#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";

import {
  createRuntime,
  ByteQueue,
  WebSocketTcpNetwork,
  mountAlpineMiniRootfs,
} from "./src/index.js";

const ROOTFS_URL =
  "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86/alpine-minirootfs-3.23.4-x86.tar.gz";

const gateway = process.env.GATEWAY || "ws://127.0.0.1:8787/tcp";

const stdin = new ByteQueue();

const rt = createRuntime({
  stdin,
  network: new WebSocketTcpNetwork({ gatewayUrl: gateway }),
  env: {
    PATH: "/sbin:/bin:/usr/sbin:/usr/bin",
    HOME: "/root",
    USER: "root",
    SHELL: "/bin/sh",
    TERM: "xterm",
  },
  onWrite: (_fd, text) => process.stdout.write(text),
  maxSteps: 100_000_000,
});

async function loadRootfs() {
  console.log("[*] Downloading Alpine rootfs...");
  const res = await fetch(ROOTFS_URL);
  const buf = new Uint8Array(await res.arrayBuffer());

  console.log("[*] Mounting rootfs...");
  await mountAlpineMiniRootfs(rt.vfs, {
    bytes: buf,
    progress: (msg) => console.log("[rootfs]", msg),
  });

  console.log("[✓] Rootfs ready");

  try {
    const rel = new TextDecoder().decode(
      rt.vfs.readFile("/etc/alpine-release")
    );
    console.log("[Alpine version]", rel.trim());
  } catch {}
}

async function startShell() {
  console.log("[*] Starting /bin/sh");

  rt.loadExecutableFromVFS("/bin/sh", {
    argv: ["/bin/sh", "-i"],
    execPath: "/bin/sh",
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (line) => {
    stdin.push(line + "\n");
  });

  try {
    await rt.runAsync({
      maxSteps: 2_000_000_000,
      yieldEvery: 2048,
    });
  } catch (e) {
    console.error("\n[emulator stopped]", e.message);
    if (e.registers) console.error(e.registers);
  }

  rl.close();
}
// Add these constants somewhere central
export const S_IFCHR = 0o020000;
export const ENOTTY = 25;
export const TCGETS = 0x5401;
export const TIOCGWINSZ = 0x5413;
export const TIOCSWINSZ = 0x5414;

export function installTtyDevices(vfs) {
  try {
    vfs.mkdir("/dev");
  } catch {}

  // Adapt this to your VFS API if device nodes are represented differently.
  if (typeof vfs.mknod === "function") {
    try {
      vfs.mknod("/dev/tty", S_IFCHR | 0o666, { major: 5, minor: 0 });
    } catch {}

    try {
      vfs.mknod("/dev/console", S_IFCHR | 0o600, { major: 5, minor: 1 });
    } catch {}

    try {
      vfs.mknod("/dev/null", S_IFCHR | 0o666, { major: 1, minor: 3 });
    } catch {}
  }
}
(async () => {
  await loadRootfs();
  installTtyDevices(rt.vfs);
  await startShell();
})();