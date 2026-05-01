const virtualPorts = new Map();
const ASSET_CACHE = 'webix-assets-v1';
const ASSET_PREFIXES = ['/containers/', '/src/x86_64-blink', '/public/x86_64-witness'];
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== ASSET_CACHE).map(k => caches.delete(k)));
})()));
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'openx86-register-port') virtualPorts.set(Number(msg.port), event.source.id);
  if (msg.type === 'openx86-unregister-port') virtualPorts.delete(Number(msg.port));
});
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && (res.status === 200 || res.status === 0)) cache.put(request, res.clone()).catch(() => {});
  return res;
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && ASSET_PREFIXES.some(p => url.pathname.startsWith(p))) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  const m = url.pathname.match(/^\/__virtual__\/(\d+)(\/.*)?$/);
  if (!m) return;
  const port = Number(m[1]);
  const owner = virtualPorts.get(port);
  if (!owner) { event.respondWith(new Response('virtual port not registered', { status: 502 })); return; }
  event.respondWith((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    const client = clients.find(c => c.id === owner);
    if (!client) return new Response('virtual owner unavailable', { status: 502 });
    const body = new Uint8Array(await event.request.arrayBuffer());
    const id = crypto.randomUUID();
    const channel = new MessageChannel();
    const reply = new Promise(resolve => { channel.port1.onmessage = ev => resolve(ev.data); });
    client.postMessage({ type: 'openx86-http-request', id, port, method: event.request.method, path: m[2] || '/', headers: [...event.request.headers], body }, [channel.port2]);
    const res = await reply;
    return new Response(res.body || '', { status: res.status || 200, headers: res.headers || {} });
  })());
});
