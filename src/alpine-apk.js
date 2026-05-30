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
// Alpine mirrors send no CORS headers, so addByName fetches the real repo through
// a CORS-proxy chain (see apk-repo.js): parse APKINDEX, resolve name + deps, pull
// each .apk live, extract into the FS.

import { gunzip, parseTar, mkdirp, writeRecord, readPkgInfo } from "./apk-format.js";
import { makeRepo, corsFetch, depKey } from "./apk-repo.js";

// Create an apk surface over a blink host. `root` is the guest rootfs prefix
// (default "/") into which packages extract; the alpine minirootfs is expected
// to already be mounted there (host.mountTarBytes) for libc/busybox deps.
export function createApk(host, { root="", fetchImpl=(typeof fetch!=="undefined"?fetch:null), repoOpts=null }={}){
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

  const repo=makeRepo({ fetchImpl, ...(repoOpts||{}) });

  // Install a package by name (or provide-token) from the live Alpine repo,
  // resolving its dependency closure. so:/cmd:/pc: deps not present as packages
  // are assumed satisfied by the mounted base rootfs (musl, busybox) and skipped.
  async function addByName(name, { _seen=new Set() }={}){
    const pkgName=await repo.resolve(name);
    if(!pkgName){
      throw new Error(`apk: '${name}' not found in alpine v3.21 main/community`);
    }
    if(installed.has(pkgName)){
      const p=installed.get(pkgName);
      return { name:pkgName, version:p.version, files:p.files, alreadyInstalled:true };
    }
    if(_seen.has(pkgName)) return null; // cycle guard
    _seen.add(pkgName);
    const meta=await repo.apkUrl(pkgName);
    if(!meta) throw new Error(`apk: '${pkgName}' has no .apk in the index`);
    for(const dep of meta.depends){
      const key=depKey(dep);
      if(!key) continue; // conflict (!pkg)
      const depPkg=await repo.resolve(dep);
      if(depPkg && installed.has(depPkg)) continue;
      if(!depPkg){ if(/^(so|cmd|pc):/.test(dep)) continue; else continue; } // base rootfs
      await addByName(depPkg, { _seen });
    }
    const bytes=await corsFetch(meta.url, { fetchImpl, ...(repoOpts||{}) });
    const r=await addBytes(bytes);
    return { ...r, url:meta.url };
  }

  // Remove an installed package: unlink its files from the guest FS + drop the
  // db entry. Best-effort (leaves shared deps).
  function remove(name){
    const p=installed.get(name);
    if(!p) return { name, removed:false };
    for(const f of (p.files||[])){ try{ host.Module.FS.unlink(f.startsWith("/")?f:"/"+f); }catch(_){} }
    installed.delete(name);
    flushDb();
    return { name, removed:true };
  }

  return {
    addBytes,
    addUrl,
    addByName,
    remove,
    repo,
    // Catalog browse (merged APKINDEX): {packages:[{name,version,summary}], total}.
    search(query, opts){ return repo.search(query, opts); },
    pkgInfo(name){ return repo.pkgInfo(name); },
    info(name){ return installed.get(name)||null; },
    list(){ return [...installed.entries()].map(([name,p])=>({ name, version:p.version, fileCount:(p.files||[]).length })); },
    isInstalled(name){ return installed.has(name); }
  };
}
