import assert from "node:assert/strict";
import { VFS, OverlayVFS, createTar, installTarPackage } from "../src/index.js";

const base = new VFS();
base.writeFile("/etc/base.conf", "base\n", 0o644);
base.writeFile("/bin/tool", "old\n", 0o755);
const upper = new VFS();
const ovl = new OverlayVFS(base, upper);
assert.equal(new TextDecoder().decode(ovl.readFile("/etc/base.conf")), "base\n");
ovl.writeFile("/etc/base.conf", "upper\n", 0o600);
assert.equal(new TextDecoder().decode(base.readFile("/etc/base.conf")), "base\n");
assert.equal(new TextDecoder().decode(ovl.readFile("/etc/base.conf")), "upper\n");
ovl.unlink("/bin/tool");
assert.equal(ovl.exists("/bin/tool"), false);

const pkg = createTar({ "usr/bin/hello": "#!/bin/sh\necho hello\n", "etc/pkg.conf": "installed\n" });
const result = await installTarPackage(ovl, pkg, { name: "fixture" });
assert.ok(result.installed.includes("/usr/bin/hello"));
assert.equal(new TextDecoder().decode(ovl.readFile("/etc/pkg.conf")), "installed\n");
assert.match(new TextDecoder().decode(ovl.readFile("/var/lib/xos/packages.log")), /fixture/);
console.log("overlay/package tests passed");
