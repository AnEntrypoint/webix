export async function registerOpenX86ServiceWorker(url = "./sw.js") {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) throw new Error("Service workers are not available");
  const reg = await navigator.serviceWorker.register(url);
  await navigator.serviceWorker.ready;
  return reg;
}

export function registerVirtualHttpPort(port, handler) {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) throw new Error("No active OpenX86 service worker controller");
  navigator.serviceWorker.controller.postMessage({ type: "openx86-register-port", port });
  const listener = async event => {
    const msg = event.data || {};
    if (msg.type !== "openx86-http-request" || msg.port !== port) return;
    const replyPort = event.ports[0];
    try {
      const res = await handler(msg);
      replyPort.postMessage({ status: res.status ?? 200, headers: res.headers ?? {}, body: res.body ?? "" });
    } catch (e) {
      replyPort.postMessage({ status: 500, headers: { "text/plain": "text/plain" }, body: String(e?.stack || e) });
    }
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => {
    navigator.serviceWorker.removeEventListener("message", listener);
    navigator.serviceWorker.controller?.postMessage({ type: "openx86-unregister-port", port });
  };
}
