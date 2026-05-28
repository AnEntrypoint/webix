// alpine-apk.js — install from the Alpine package ecosystem on a blink host.
//
// The vendored blink wasm is POSIX NOJIT NOSOCK single-threaded: socket(AF_INET)
// is ENOSYS, pipe() is EBADF, pthread_create unsupported. The real apk-tools
// binary cannot fetch over the network or spawn its child stages here. So apk is
// implemented JS-side: a .apk is a gzip tarball; "apk add" decompresses it and
// extracts its members into the host's emscripten FS rootfs, then records the
// package in /lib/apk/db/installed. The installed files are then runnable via
// host.runElf because the FS persists for the lifetime of the host singleton.
//
// Alpine mirrors send NO CORS headers, so a static page cannot fetch the real
// repo. addByName resolves against a same-origin bundled manifest instead.

import { gunzip, parseTar, mkdirp, writeRecord, readPkgInfo } from "./apk-format.js";

// Create an apk surface over a blink host. `root` is the guest rootfs prefix
// (default "/") into which packages extract; the alpine minirootfs is expected
// to already be mounted there (host.mountTarBytes) for libc/busybox deps.
export function createApk(host, { root="", fetchImpl=(typeof fetch!=="undefined"?fetch:null) }={}){
  const FS=host.Module.FS;
  const installed=new Map(); // name -> {version, files:[]}
  const dbPath="/lib/apk/db/installed";

  function flushDb(){
    mkdirp(FS, "/lib/apk/db");
    let txt="";
    for(const [name,p] of installed){
      txt+=`P:${name}\nV:${p.version||"0"}\nF:${(p.files||[]).join(" ")}\n\n`;
    }
    try{ FS.unlink(dbPath) }catch(_){}
    const s=FS.open(dbPath,"w+");
    const bytes=new TextEncoder().encode(txt);
    if(bytes.length) FS.write(s, bytes, 0, bytes.length, 0);
    FS.close(s);
  }

  function addBytes(apkBytes){
    return gunzip(apkBytes).then(tarU8=>{
      const records=parseTar(tarU8);
      const meta=readPkgInfo(records);
      const files=[];
      for(const rec of records){ if(writeRecord(FS, root, rec)) files.push(rec.name); }
      const name=meta.name||"unknown";
      installed.set(name, { version:meta.version, files });
      flushDb();
      return { name, version:meta.version, files };
    });
  }

  async function addUrl(url){
    if(!fetchImpl) throw new Error("alpine-apk: no fetch available for addUrl");
    const res=await fetchImpl(url);
    if(!res.ok) throw new Error("alpine-apk: fetch "+url+" -> "+res.status);
    return addBytes(new Uint8Array(await res.arrayBuffer()));
  }

  // Same-origin bundled repo: a curated set of .apk files + a manifest vendored
  // alongside the page (Alpine mirrors have no CORS). Manifest entries map name
  // (and `provides` tokens like cmd:nano / so:libfoo.so.6) -> {version, file,
  // provides, depends}.
  let manifestPromise=null;
  function loadManifest(manifestUrl){
    if(manifestPromise) return manifestPromise;
    if(!fetchImpl) return Promise.reject(new Error("alpine-apk: no fetch available"));
    manifestPromise=fetchImpl(manifestUrl).then(r=>{
      if(!r.ok) throw new Error("apk repo manifest "+manifestUrl+" -> "+r.status);
      return r.json();
    }).then(m=>{
      const pkgs=m.packages||{};
      const byProvide=new Map();
      for(const [name,p] of Object.entries(pkgs)){
        for(const tok of (p.provides||[])) byProvide.set(tok, name);
      }
      return { pkgs, byProvide };
    });
    return manifestPromise;
  }

  function resolveName(M, token){
    if(M.pkgs[token]) return token;
    if(M.byProvide.has(token)) return M.byProvide.get(token);
    return null;
  }

  // Install a name (or provide-token) and its depends from the bundled repo.
  // so:/cmd:/pc: depends not in the manifest are assumed satisfied by the base
  // mounted rootfs and skipped; other unresolvable depends are an error.
  async function addByName(name, { manifestUrl="apk/manifest.json", baseUrl="", _seen=new Set() }={}){
    const M=await loadManifest(baseUrl+manifestUrl);
    const pkgName=resolveName(M, name);
    if(!pkgName){
      const available=Object.keys(M.pkgs).join(", ");
      throw new Error(`'${name}' not in the bundled repo. network apk needs a CORS-enabled mirror (Alpine mirrors send none). available: ${available}`);
    }
    if(installed.has(pkgName)){
      const p=installed.get(pkgName);
      return { name:pkgName, version:p.version, files:p.files, alreadyInstalled:true };
    }
    if(_seen.has(pkgName)) return null; // cycle guard
    _seen.add(pkgName);
    const p=M.pkgs[pkgName];
    for(const dep of (p.depends||[])){
      const depPkg=resolveName(M, dep);
      if(depPkg && installed.has(depPkg)) continue;
      if(!depPkg){
        if(/^(so|cmd|pc):/.test(dep)) continue; // assumed in base rootfs
        throw new Error(`'${pkgName}' needs '${dep}' which is not in the bundled repo`);
      }
      await addByName(depPkg, { manifestUrl, baseUrl, _seen });
    }
    return addUrl(baseUrl+p.file);
  }

  return {
    addBytes,
    addUrl,
    addByName,
    info(name){ return installed.get(name)||null; },
    list(){ return [...installed.entries()].map(([name,p])=>({ name, version:p.version, fileCount:(p.files||[]).length })); },
    isInstalled(name){ return installed.has(name); }
  };
}
