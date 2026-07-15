// apk-repo.js — live Alpine repository over CORS.
//
// Alpine mirrors send no CORS headers, so a static page can't read them directly.
// We fetch through a ranked proxy chain: try the mirror directly first (works when
// the browser/extension allows it), then public CORS proxies. codetabs is the one
// reliable proxy (verified: type:cors 200, full binary, no rate limit); the others
// are best-effort fallbacks for when codetabs blips.

import { gunzip, parseTar } from "./apk-format.js";

// quest takes the RAW url (no encoding); the rest take an encoded url.
// wranger is our self-hosted Cloudflare Worker (open generic-proxy mode); listed
// last so it absorbs traffic only when the three public proxies all fail.
export const DEFAULT_PROXIES=[
  u=>`https://api.codetabs.com/v1/proxy/?quest=${u}`,
  u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u=>`https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u=>`https://wranger.almagestfraternite.workers.dev/?quest=${u}`
];

export const DEFAULT_REPOS=[
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64",
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/community/x86_64"
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

// Fetch a url as bytes, racing direct + each proxy staggered by
// CORS_FETCH_STAGGER_MS instead of trying them strictly in sequence -- a dead
// first attempt no longer costs a full timeout before the next one starts.
// Each individual attempt is bounded by CORS_FETCH_TIMEOUT_MS so a HANGING
// (not just erroring) proxy can't stall the whole race. Throws naming every
// attempt if all fail (never silently hangs).
export async function corsFetch(url, { fetchImpl=fetch, proxies=DEFAULT_PROXIES, timeoutMs=CORS_FETCH_TIMEOUT_MS, staggerMs=CORS_FETCH_STAGGER_MS }={}){
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

// Strip an apk dependency token to a resolvable key: drop version constraints
// (pkg>=1.2, pkg=1.2-r3, pkg~1.2) and ignore conflicts (!pkg). so:/cmd:/pc:
// tokens are returned as-is (resolved via the provides map).
export function depKey(tok){
  if(!tok || tok[0]==="!") return null;
  return tok.split(/[<>=~]/)[0];
}

// Parse the inner APKINDEX text (blank-line-separated records of K:V lines) into
// a {byName, byProvide} db. Each record: P name, V version, D depends, p provides.
function parseIndexText(text){
  const byName=new Map(), byProvide=new Map();
  for(const block of text.split("\n\n")){
    if(!block.trim()) continue;
    const rec={ depends:[], provides:[] };
    for(const line of block.split("\n")){
      const k=line[0], v=line.slice(2);
      if(k==="P") rec.name=v;
      else if(k==="V") rec.version=v;
      else if(k==="T") rec.summary=v;          // pkgdesc (one-line title)
      else if(k==="D") rec.depends=v.split(" ").filter(Boolean);
      else if(k==="p") rec.provides=v.split(" ").filter(Boolean);
    }
    if(!rec.name) continue;
    byName.set(rec.name, rec);
    for(const prov of rec.provides) byProvide.set(depKey(prov), rec.name);
  }
  return { byName, byProvide };
}

const APKINDEX_CACHE="webix-apkindex-v1";
const APKINDEX_TTL_MS=6*60*60*1000; // 6h: index changes infrequently, tolerable staleness

// Fetch+cache raw APKINDEX.tar.gz bytes in Cache API with a TTL (stamped via a
// sibling cache entry storing the fetch time). Cache-hit skips the network +
// every CORS proxy entirely on repeat sessions within the TTL window.
async function cachedApkIndexBytes(repo, fetchImpl, proxies){
  const url=repo+"/APKINDEX.tar.gz";
  if(typeof caches==="undefined") return corsFetch(url, { fetchImpl, proxies });
  try{
    const cache=await caches.open(APKINDEX_CACHE);
    const metaRes=await cache.match(url+"#meta");
    if(metaRes){
      const { ts }=await metaRes.json();
      if(Date.now()-ts<APKINDEX_TTL_MS){
        const res=await cache.match(url);
        if(res) return new Uint8Array(await res.arrayBuffer());
      }
    }
    const bytes=await corsFetch(url, { fetchImpl, proxies });
    await cache.put(url, new Response(bytes));
    await cache.put(url+"#meta", new Response(JSON.stringify({ ts:Date.now() })));
    return bytes;
  }catch(_){ return corsFetch(url, { fetchImpl, proxies }); }
}

// Load + cache the merged package db across all repos (main, community).
export function makeRepo({ fetchImpl=fetch, repos=DEFAULT_REPOS, proxies=DEFAULT_PROXIES }={}){
  let dbPromise=null;
  async function load(){
    const merged={ byName:new Map(), byProvide:new Map(), repoOf:new Map() };
    // Fetch every repo's index in parallel instead of a sequential for-loop --
    // main+community are independent, so there's no reason to serialize them.
    const results=await Promise.all(repos.map(async repo=>{
      const gz=await cachedApkIndexBytes(repo, fetchImpl, proxies);
      const tar=await gunzip(gz);
      const idx=parseTar(tar).find(r=>r.name==="APKINDEX");
      return idx ? { repo, ...parseIndexText(new TextDecoder().decode(idx.data)) } : null;
    }));
    for(const r of results){
      if(!r) continue;
      for(const [n,rec] of r.byName){ if(!merged.byName.has(n)){ merged.byName.set(n,rec); merged.repoOf.set(n,r.repo); } }
      for(const [p,n] of r.byProvide){ if(!merged.byProvide.has(p)) merged.byProvide.set(p,n); }
    }
    return merged;
  }
  function db(){ return (dbPromise||=load()); }
  return {
    db,
    async resolve(token){
      const M=await db();
      const key=depKey(token);
      if(key && M.byName.has(key)) return key;
      if(M.byProvide.has(token)) return M.byProvide.get(token);
      if(key && M.byProvide.has(key)) return M.byProvide.get(key);
      return null;
    },
    async apkUrl(name){
      const M=await db();
      const r=M.byName.get(name); if(!r) return null;
      return { url:`${M.repoOf.get(name)}/${r.name}-${r.version}.apk`, version:r.version, depends:r.depends };
    },
    // Browse the merged repo index: substring match over name+summary, optional
    // GUI-only filter (depends on an X/display lib), paginated. Powers the
    // in-page App Store catalog without the removed remote /packages service.
    async search(query, { gui=false, offset=0, limit=50 }={}){
      const M=await db();
      const q=(query||"").trim().toLowerCase();
      const isGui=(r)=>r.depends.some(d=>/^(libx11|libxcb|gtk|qt|libxext|libxrender|cairo|pango|mesa|wayland)/i.test(d));
      const all=[];
      for(const r of M.byName.values()){
        if(q && !(r.name.toLowerCase().includes(q) || (r.summary||"").toLowerCase().includes(q))) continue;
        if(gui && !isGui(r)) continue;
        all.push({ name:r.name, version:r.version, summary:r.summary||"" });
      }
      all.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
      return { packages:all.slice(offset, offset+limit), total:all.length };
    },
    async pkgInfo(name){
      const M=await db();
      const r=M.byName.get(name); if(!r) return null;
      return { name:r.name, version:r.version, summary:r.summary||"", depends:r.depends, repo:M.repoOf.get(name) };
    }
  };
}
