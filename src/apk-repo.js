// apk-repo.js — live Alpine repository over CORS.
//
// Alpine mirrors send no CORS headers, so a static page can't read them directly.
// We fetch through a ranked proxy chain: try the mirror directly first (works when
// the browser/extension allows it), then public CORS proxies. codetabs is the one
// reliable proxy (verified: type:cors 200, full binary, no rate limit); the others
// are best-effort fallbacks for when codetabs blips.

import { gunzip, parseTar } from "./apk-format.js";

// quest takes the RAW url (no encoding); the rest take an encoded url.
export const DEFAULT_PROXIES=[
  u=>`https://api.codetabs.com/v1/proxy/?quest=${u}`,
  u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u=>`https://corsproxy.io/?url=${encodeURIComponent(u)}`
];

export const DEFAULT_REPOS=[
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64",
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/community/x86_64"
];

// Fetch a url as bytes, trying direct then each proxy until one returns ok.
// Throws naming every attempt if all fail (never silently hangs).
export async function corsFetch(url, { fetchImpl=fetch, proxies=DEFAULT_PROXIES }={}){
  const tried=[];
  const attempts=[ ["direct", url], ...proxies.map((p,i)=>[`proxy${i}`, p(url)]) ];
  for(const [label, u] of attempts){
    try{
      const r=await fetchImpl(u);
      if(r.ok) return new Uint8Array(await r.arrayBuffer());
      tried.push(`${label}:${r.status}`);
    }catch(e){ tried.push(`${label}:${(e&&e.name)||"err"}`); }
  }
  throw new Error(`apk: could not fetch ${url} (tried ${tried.join(", ")}); network or all CORS proxies unreachable`);
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
      else if(k==="D") rec.depends=v.split(" ").filter(Boolean);
      else if(k==="p") rec.provides=v.split(" ").filter(Boolean);
    }
    if(!rec.name) continue;
    byName.set(rec.name, rec);
    for(const prov of rec.provides) byProvide.set(depKey(prov), rec.name);
  }
  return { byName, byProvide };
}

// Load + cache the merged package db across all repos (main, community).
export function makeRepo({ fetchImpl=fetch, repos=DEFAULT_REPOS, proxies=DEFAULT_PROXIES }={}){
  let dbPromise=null;
  async function load(){
    const merged={ byName:new Map(), byProvide:new Map(), repoOf:new Map() };
    for(const repo of repos){
      const gz=await corsFetch(repo+"/APKINDEX.tar.gz", { fetchImpl, proxies });
      const tar=await gunzip(gz);
      const idx=parseTar(tar).find(r=>r.name==="APKINDEX");
      if(!idx) continue;
      const { byName, byProvide }=parseIndexText(new TextDecoder().decode(idx.data));
      for(const [n,r] of byName){ if(!merged.byName.has(n)){ merged.byName.set(n,r); merged.repoOf.set(n,repo); } }
      for(const [p,n] of byProvide){ if(!merged.byProvide.has(p)) merged.byProvide.set(p,n); }
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
    }
  };
}
