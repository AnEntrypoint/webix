// Node-only entrypoint.
//
// Browser pages must import ./index.js, which intentionally has no node:*
// imports in its static module graph. Node CLIs and servers may import this
// file to get the raw TCP/DNS network adapter and filesystem snapshot helpers.
export * from "./index.js";
export { NodeTcpNetwork } from "./network-node.js";
export { saveVfsSnapshotToFile, loadVfsSnapshotFromFile } from "./persistence-node.js";
