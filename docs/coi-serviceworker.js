// coi-serviceworker.js — makes the page crossOriginIsolated on static hosts
// (GitHub Pages) that cannot set Cross-Origin-Opener-Policy/Cross-Origin-
// Embedder-Policy response headers themselves. blinkenlib.js unconditionally
// requests a `shared:true` WebAssembly.Memory (the -pthread build), which
// throws unless crossOriginIsolated is true. This worker intercepts every
// same-origin fetch and re-serves the response with COOP/COEP injected, then
// forces a one-time reload so the freshly-isolated context takes effect.
// Adapted from the public-domain gist github.com/gzuidhof/coi-serviceworker.

if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
    // Only the document/navigation and same-origin asset loads need the
    // COOP/COEP header injection -- that's what makes the PAGE itself
    // crossOriginIsolated. Cross-origin requests (CORS-proxy fetches to
    // codetabs/allorigins/corsproxy.io/wranger, or a direct attempt at
    // dl-cdn.alpinelinux.org for apk) must pass through untouched: re-fetching
    // them here and trying to rebuild a Response with injected headers hits
    // the SW's own same-origin-policy restrictions on a cross-origin fetch
    // (even one the page's own fetch() could read via CORS), so `fetch(req)`
    // inside the worker throws and the .catch() below turned every failed
    // apk network call into a synthetic 500 body "coi-serviceworker fetch
    // failed: ..." -- gunzip() then saw that text instead of real gzip bytes
    // and apk search/add broke silently. Only intercept same-origin.
    if (req.mode !== "same-origin" && new URL(req.url).origin !== self.location.origin) return;
    event.respondWith(
      fetch(req).then((res) => {
        if (res.status !== 0 && !res.headers.get("Cross-Origin-Embedder-Policy")) {
          const headers = new Headers(res.headers);
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
        return res;
      }).catch((e) => new Response("coi-serviceworker fetch failed: " + e.message, { status: 500 }))
    );
  });
} else {
  (async () => {
    if (window.crossOriginIsolated !== false) return; // already isolated, or unsupported browser
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.register(window.document.currentScript.src);
    reg.addEventListener("updatefound", () => {});
    // If this worker just took control, the CURRENT document still isn't
    // isolated (headers only apply to the next navigation) — reload once.
    if (navigator.serviceWorker.controller) return;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!sessionStorage.getItem("coi-reloaded")) {
        sessionStorage.setItem("coi-reloaded", "1");
        window.location.reload();
      }
    });
  })();
}
