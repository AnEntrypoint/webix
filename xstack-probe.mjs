// Feasibility probe: can an Alpine X server be installed into the blink rootfs
// and exec under the (single-thread NOJIT) blink wasm? Resolves guest-rootfs-x11.
//
// Steps: boot host -> mount alpine-minirootfs -> createApk -> install an X
// server package from the live Alpine repo -> assert the X binary lands in the
// rootfs -> attempt to exec it under blink and report what happens.
import fs from "node:fs";
import zlib from "node:zlib";
import { createBlinkHost } from "./src/x86_64-blink.js";
import { createApk } from "./src/alpine-apk.js";

globalThis.self ??= globalThis; // -pthread glue references worker-scope `self`

const TARGET = process.argv[2] || "xvfb";

function log(...a) { console.log(...a); }

const host = await createBlinkHost({});
// Mount the vendored minirootfs (gunzip first; mountTarBytes wants the tar).
const gz = fs.readFileSync("containers/alpine-minirootfs-x86_64.tar.gz");
host.mountTarBytes(zlib.gunzipSync(gz));
log("rootfs mounted");

const apk = createApk(host, { fetchImpl: fetch });
log(`installing '${TARGET}' (+dep closure) from alpine v3.21 ...`);
let installed;
try {
  installed = await apk.addByName(TARGET);
} catch (e) {
  log("INSTALL FAILED:", e.message);
  process.exit(3);
}
log("installed packages:", apk.list().map(p => `${p.name}@${p.version}(${p.fileCount}f)`).join(", "));

// Find candidate X binaries in the rootfs.
const FS = host.Module.FS;
const candidates = [];
for (const dir of ["/usr/bin", "/usr/lib/xorg", "/usr/libexec"]) {
  try {
    for (const f of FS.readdir(dir)) {
      if (f === "." || f === "..") continue;
      if (/^X|Xvfb|Xorg|Xfbdev|xinit$/.test(f)) candidates.push(`${dir}/${f}`);
    }
  } catch { /* dir absent */ }
}
log("X binary candidates in rootfs:", candidates.length ? candidates.join(", ") : "(none found)");

if (!candidates.length) {
  log("RESULT: package installed but no X server binary present");
  process.exit(2);
}

// Attempt to exec the first candidate under blink (just -version / -help so it
// exits fast). Report exitCode + stderr tail -- this is the "exec under blink"
// witness.
const bin = candidates.find(c => /Xvfb|Xorg|Xfbdev/.test(c)) || candidates[0];
log(`exec under blink: ${bin} -version`);
let elfBytes;
try {
  elfBytes = FS.readFile(bin); // Uint8Array from the rootfs
  log(`read ${elfBytes.length} bytes; ELF magic=`, [...elfBytes.slice(0, 4)].join(","));
} catch (e) {
  log("could not read X binary bytes:", e.message);
  process.exit(5);
}
try {
  const r = await Promise.race([
    host.runElf(elfBytes, { progname: bin, argv: [bin, "-version"] }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("exec timeout 25s")), 25000)),
  ]);
  log("EXEC RESULT exitCode=", r.exitCode);
  log("stdout:", JSON.stringify((r.stdout || "").slice(0, 600)));
  log("stderr:", JSON.stringify((r.stderr || "").slice(0, 600)));
} catch (e) {
  log("EXEC THREW/TIMEOUT:", e.message);
  process.exit(4);
}
