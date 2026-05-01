const virtualPorts = new Map();
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'openx86-register-port') virtualPorts.set(Number(msg.port), event.source.id);
  if (msg.type === 'openx86-unregister-port') virtualPorts.delete(Number(msg.port));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
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
