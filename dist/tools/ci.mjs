#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(label, args) {
  console.log(`\n[ci] ${label}`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 180000 });
  if (r.error) { console.error(`[ci] ${label} failed: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("typecheck", ["tools/typecheck.mjs"]);
run("test", ["tools/run-tests.mjs"]);
run("build", ["tools/build.mjs"]);
console.log("\nci passed");
process.exit(0);
