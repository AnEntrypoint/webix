// alpine-apk.js — install from the Alpine package ecosystem on a blink host.
//
// emscripten has no fork() (there is no real process creation under wasm), so
// the real apk-tools binary cannot spawn its child fetch/extract stages here —
// this is the permanent blocker, not a socket/thread limit (the vendored wasm is
// threaded + sockets-enabled, see blink-core.js capabilities). So apk is
// implemented JS-side: a .apk is a gzip tarball; "apk add" decompresses it and
// extracts its members into the host's emscripten FS rootfs, then records the
// package in /lib/apk/db/installed. The installed files are then runnable via
// host.runElf because the FS persists for the lifetime of the host singleton.
//
// Alpine mirrors send no CORS headers, so addByName fetches the real repo through
// a CORS-proxy chain (see apk-repo.js): parse APKINDEX, resolve name + deps, pull
// each .apk live, extract into the FS.

import { gunzip, parseTar, mkdirp, writeRecord, readPkgInfo, verifyChecksum } from "./apk-format.js";
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

  // Phase 1 (pure index work, no .apk fetches): resolve the full dependency
  // closure for `name` into an ordered list of package names to install,
  // dependencies before dependents. `seen` is shared across the whole
  // recursion (not per-branch) so a package reachable via two different
  // dependency paths is only queued once even when both paths are still
  // being resolved concurrently -- resolve() calls themselves don't mutate
  // shared state, only this Set does, so concurrent recursion is safe.
  async function resolveClosure(name, seen, order){
    const pkgName=await repo.resolve(name);
    if(!pkgName) throw new Error(`apk: '${name}' not found in alpine v3.21 main/community`);
    if(installed.has(pkgName) || seen.has(pkgName)) return pkgName;
    seen.add(pkgName); // claim before recursing: concurrent dep branches sharing this pkg see it claimed immediately
    const meta=await repo.apkUrl(pkgName);
    if(!meta) throw new Error(`apk: '${pkgName}' has no .apk in the index`);
    const depPkgs=(await Promise.all(meta.depends.map(async dep=>{
      const key=depKey(dep);
      if(!key) return null; // conflict (!pkg)
      const depPkg=await repo.resolve(dep);
      if(!depPkg) return null; // so:/cmd:/pc: with no package -> assumed satisfied by base rootfs
      return depPkg;
    }))).filter(Boolean);
    await Promise.all(depPkgs.map(dep=>resolveClosure(dep, seen, order)));
    order.push({ name:pkgName, url:meta.url, version:meta.version, checksum:meta.checksum });
    return pkgName;
  }

  // Bounded-concurrency map: run `fn` over `items` with at most `limit` in
  // flight at once, preserving each item's own result position.
  async function mapLimit(items, limit, fn){
    const out=new Array(items.length);
    let next=0;
    async function worker(){
      while(next<items.length){
        const i=next++; out[i]=await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)}, worker));
    return out;
  }

  // Install a package by name (or provide-token) from the live Alpine repo.
  // Phase 1 resolves the whole dependency closure (pure index work, already
  // parallelized inside resolveClosure); phase 2 fetches every .apk with
  // bounded concurrency (default 4) instead of one dependency at a time;
  // phase 3 extracts each in closure order (deps before dependents).
  async function addByName(name, { concurrency=4 }={}){
    const pkgName=await repo.resolve(name);
    if(pkgName && installed.has(pkgName)){
      const p=installed.get(pkgName);
      return { name:pkgName, version:p.version, files:p.files, alreadyInstalled:true };
    }
    const order=[];
    await resolveClosure(name, new Set(), order);
    const fetched=await mapLimit(order, concurrency, async pkg=>({ pkg, bytes:await corsFetch(pkg.url, { fetchImpl, ...(repoOpts||{}) }) }));
    // Verify each fetch against APKINDEX's checksum before extracting -- a
    // compromised/MITM'd CORS proxy (third-party infra we don't control) could
    // otherwise silently substitute a malicious .apk. A missing/unparseable
    // checksum (verifyChecksum returns null) is not itself a failure -- it just
    // means the index didn't carry one to check against.
    for(const { pkg, bytes } of fetched){
      const ok=await verifyChecksum(bytes, pkg.checksum);
      if(ok===false) throw new Error(`apk: checksum mismatch for ${pkg.name}-${pkg.version} (possible corrupted fetch or tampered CORS-proxy response)`);
    }
    let result=null;
    for(const { pkg, bytes } of fetched){
      const r=await addBytes(bytes);
      if(pkg.name===order[order.length-1].name) result={ ...r, url:pkg.url };
    }
    return result;
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
