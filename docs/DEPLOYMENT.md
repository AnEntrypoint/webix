# Browser deployment notes

The browser demo in this repo runs without build tooling when served over a local HTTP server:

```bash
python3 -m http.server 8000
```

For production, serve all assets with standard static hosting. If you add SharedArrayBuffer, pthreads, or a worker-based Wasm JIT, enable cross-origin isolation headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Recommended production split:

- Main thread: terminal UI, canvas, file picker, high-level controls.
- Worker: CPU runtime, syscall/VFS dispatcher, JIT cache, device cache.
- IndexedDB: writable overlay and local disk cache.
- HTTP Range endpoint: large root filesystem/disk images.

## Browser import boundary

Browser pages must import `./src/index.js` or package subpath `./browser`. That entrypoint is intentionally browser-safe and has no static `node:*` imports in its module graph.

Node-only adapters live behind explicit Node entrypoints:

```js
import { NodeTcpNetwork } from "./src/node.js";
// or package consumers: import { NodeTcpNetwork } from "xstate-linux-os-emulator-cleanroom/node";
```

Do **not** import `./src/network-node.js`, `./src/persistence-node.js`, or `./src/node.js` from a browser page. Browsers cannot load `node:net`, `node:dns/promises`, or `node:fs`; attempting to do so produces errors like:

```text
Access to script at 'node:net' from origin 'http://localhost:8000' has been blocked by CORS policy
```

For browser networking use:

```js
import { WebSocketTcpNetwork, BrowserFetchNetwork } from "./src/index.js";
```

Run the gateway separately in Node when guest TCP is needed:

```bash
npm run gateway
```
