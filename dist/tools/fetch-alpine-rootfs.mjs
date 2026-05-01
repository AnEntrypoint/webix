#!/usr/bin/env node
import { createWriteStream, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import https from "node:https";
import { ALPINE_X86_MINIROOTFS_URL } from "../src/rootfs.js";

const url = process.argv[2] || ALPINE_X86_MINIROOTFS_URL;
const out = resolve(process.argv[3] || `assets/${url.split('/').pop()}`);
mkdirSync(dirname(out), { recursive: true });

function get(url) {
  return new Promise((resolvePromise, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolvePromise(get(new URL(res.headers.location, url).toString()));
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      resolvePromise(res);
    }).on("error", reject);
  });
}

if (!existsSync(out)) {
  console.log(`Downloading ${url}`);
  const res = await get(url);
  await new Promise((resolvePromise, reject) => {
    const file = createWriteStream(out);
    res.pipe(file);
    res.on("error", reject); file.on("error", reject); file.on("finish", resolvePromise);
  });
} else {
  console.log(`${out} already exists`);
}
const bytes = readFileSync(out);
console.log(`${out}`);
console.log(`size=${bytes.length} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
