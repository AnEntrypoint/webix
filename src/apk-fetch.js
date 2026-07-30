// apk-fetch.js — CORS-proxy fetch layer for the live Alpine repo.
//
// Alpine mirrors send no CORS headers, so a static page can't read them directly.
// We fetch through a ranked proxy chain: try the mirror directly first (works when
// the browser/extension allows it), then public CORS proxies. codetabs is the one
// reliable proxy (verified: type:cors 200, full binary, no rate limit); the others
// are best-effort fallbacks for when codetabs blips.

// quest takes the RAW url (no encoding); the rest take an encoded url.
// wranger is our self-hosted Cloudflare Worker (open generic-proxy mode); listed
// last so it absorbs traffic only when the three public proxies all fail.
export const DEFAULT_PROXIES=[
  u=>`https://api.codetabs.com/v1/proxy/?quest=${u}`,
  u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u=>`https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u=>`https://wranger.almagestfraternite.workers.dev/?quest=${u}`
];

const CORS_FETCH_TIMEOUT_MS=8000;
const CORS_FETCH_STAGGER_MS=1500;

// Fetch one attempt with a timeout so a HANGING (not just erroring) proxy
// can't block the whole stagger/race indefinitely.
async function fetchAttempt(fetchImpl, url, timeoutMs){
  const ac=typeof AbortController!=="undefined"?new AbortController():null;
  const timer=ac?setTimeout(()=>ac.abort(),timeoutMs):null;
  try{
    const r=await fetchImpl(url, ac?{signal:ac.signal}:{});
    if(!r.ok) throw Object.assign(new Error("http "+r.status),{httpStatus:r.status});
    return new Uint8Array(await r.arrayBuffer());
  } finally { if(timer) clearTimeout(timer); }
}

// One race over direct + every proxy, staggered by staggerMs instead of tried
// strictly in sequence -- a dead first attempt no longer costs a full timeout
// before the next one starts. Each individual attempt is bounded by timeoutMs
// so a HANGING (not just erroring) proxy can't stall the whole race. Rejects
// naming every attempt if all fail (never silently hangs).
async function corsFetchOnce(url, { fetchImpl, proxies, timeoutMs, staggerMs }){
  const attempts=[ ["direct", url], ...proxies.map((p,i)=>[`proxy${i}`, p(url)]) ];
  const tried=new Array(attempts.length);
  const settled=attempts.map((_, i)=>
    new Promise(resolve=>{
      setTimeout(async ()=>{
        const [label, u]=attempts[i];
        try{ resolve({ ok:true, i, bytes:await fetchAttempt(fetchImpl, u, timeoutMs) }); }
        catch(e){ tried[i]=`${label}:${e?.httpStatus ?? e?.name ?? "err"}`; resolve({ ok:false, i }); }
      }, i*staggerMs);
    })
  );
  return new Promise((resolve, reject)=>{
    let remaining=settled.length;
    for(const p of settled){
      p.then(r=>{
        if(r.ok){ resolve(r.bytes); return; }
        remaining--;
        if(remaining===0) reject(new Error(`apk: could not fetch ${url} (tried ${tried.join(", ")}); network or all CORS proxies unreachable`));
      });
    }
  });
}

const CORS_FETCH_RETRIES=2; // total attempts = 1 + this many re-races
const CORS_FETCH_RETRY_BACKOFF_MS=1000;

// Fetch a url as bytes, retrying the WHOLE direct+proxies race on total
// failure. A single race attempt can fail end-to-end from bad luck alone (a
// transient CDN 500 on direct coinciding with unrelated proxy hiccups) even
// though every path is individually healthy moments later -- witnessed live:
// a 22-package dependency closure (nodejs) hit exactly this, one package's
// single race losing all 5 attempts simultaneously and sinking the whole
// install, while a manual retry of that same URL immediately succeeded.
// Bounded retry count + backoff turns a rare multi-attempt coincidence into a
// transient delay instead of a hard failure, without masking a genuine
// all-paths-down outage (which still exhausts the retries and throws).
export async function corsFetch(url, { fetchImpl=fetch, proxies=DEFAULT_PROXIES, timeoutMs=CORS_FETCH_TIMEOUT_MS, staggerMs=CORS_FETCH_STAGGER_MS, retries=CORS_FETCH_RETRIES, retryBackoffMs=CORS_FETCH_RETRY_BACKOFF_MS }={}){
  let lastErr;
  for(let attempt=0; attempt<=retries; attempt++){
    try{ return await corsFetchOnce(url, { fetchImpl, proxies, timeoutMs, staggerMs }); }
    catch(e){
      lastErr=e;
      if(attempt<retries) await new Promise(r=>setTimeout(r, retryBackoffMs*(attempt+1)));
    }
  }
  throw new Error(`${lastErr.message} (gave up after ${retries+1} attempts)`);
}
