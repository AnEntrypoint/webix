// OpenX86 browser networking bridge. It keeps the browser demo installable and
// provides a Service Worker channel for virtual localhost HTTP routes. Raw TCP is
// still handled by tools/net-gateway.mjs because browsers intentionally do not
// expose arbitrary TCP sockets to JavaScript.
const CHANNEL = "openx86-virtual-http";
const pending = new Map();
let nextId = 1;

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("message", event => {
  const msg = event.data || {};
  if (msg.type === "openx86-response" && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

async function routeToClients(request, port) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (!clients.length) return new Response("No OpenX86 client is available\n", { status: 503 });
  const id = nextId++;
  const body = new Uint8Array(await request.arrayBuffer());
  const headers = [...request.headers.entries()];
  const promise = new Promise(resolve => pending.set(id, resolve));
  for (const client of clients) client.postMessage({ type: "openx86-request", id, port, method: request.method, url: request.url, headers, body }, [body.buffer]);
  const reply = await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ status: 504, body: new TextEncoder().encode("OpenX86 virtual request timed out\n") }), 30000))]);
  return new Response(reply.body ?? new Uint8Array(0), { status: reply.status ?? 200, headers: reply.headers ?? {} });
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname === "/__openx86__/health") {
    event.respondWith(new Response(JSON.stringify({ ok: true, channel: CHANNEL }), { headers: { "Content-Type": "application/json" } }));
    return;
  }
  const match = url.pathname.match(/^\/__openx86__\/port\/(\d+)(\/.*)?$/);
  if (match) {
    event.respondWith(routeToClients(event.request, Number(match[1])));
  }
});
