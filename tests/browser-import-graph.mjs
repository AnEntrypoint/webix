#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve("src");
const seen = new Set();
const disallowed = [];

function scan(rel) {
  const abs = path.resolve(root, rel);
  if (seen.has(abs)) return;
  seen.add(abs);
  const source = readFileSync(abs, "utf8");
  if (/['\"]node:/.test(source)) disallowed.push(`${path.relative(process.cwd(), abs)} imports node:*`);
  if (path.basename(abs) === "network-node.js" || path.basename(abs) === "persistence-node.js") disallowed.push(`${path.relative(process.cwd(), abs)} reached from browser entry`);
  const importRe = /(?:import\s+(?:[^'\"]+\s+from\s+)?|export\s+(?:[^'\"]*\s+from\s+))['\"](\.\.?\/[^'\"]+)['\"]/g;
  let m;
  while ((m = importRe.exec(source))) {
    let child = m[1];
    if (!child.endsWith(".js")) child += ".js";
    const childAbs = path.resolve(path.dirname(abs), child);
    if (childAbs.startsWith(root) && existsSync(childAbs)) scan(path.relative(root, childAbs));
  }
}

scan("index.js");
assert.deepEqual(disallowed, []);
console.log(`browser import graph clean: ${seen.size} modules, no node:* modules reachable from src/index.js`);
