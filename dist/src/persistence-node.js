import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { serializeVfsBinary, restoreVfsBinary } from "./snapshot.js";

export function saveVfsSnapshotToFile(vfs, path) {
  const bytes = serializeVfsBinary(vfs);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length };
}
export function loadVfsSnapshotFromFile(path, options = {}) {
  if (!existsSync(path)) return null;
  return restoreVfsBinary(readFileSync(path), options);
}
