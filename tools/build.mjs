#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
const root = new URL("..", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const dir of ["src", "bin", "tools", "samples", "docs", "public"]) {
  const from = new URL(`../${dir}/`, import.meta.url);
  if (existsSync(from)) await cp(from, new URL(`../dist/${dir}/`, import.meta.url), { recursive: true });
}
for (const file of ["README.md", "LICENSE", "package.json", "index.html", "alpine.html", "sw.js", "tsconfig.json"]) {
  const from = new URL(`../${file}`, import.meta.url);
  if (existsSync(from)) await cp(from, new URL(`../dist/${file}`, import.meta.url));
}
await writeFile(new URL("../dist/BUILD_INFO.json", import.meta.url), JSON.stringify({ builtAt: new Date().toISOString(), entry: "src/index.js", cli: "bin/xos.mjs" }, null, 2));
console.log(`built ${path.resolve(dist.pathname)}`);
