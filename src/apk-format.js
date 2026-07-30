// apk-format.js — byte-level Alpine .apk (gzip+tar) decode helpers.
// A .apk is a (possibly multi-member) gzip tarball; these functions decompress
// and parse it into FS-writable records. Shared by alpine-apk.js.

const td=new TextDecoder();

export function concat(arrs){
  let n=0; for(const a of arrs) n+=a.length;
  const out=new Uint8Array(n); let p=0;
  for(const a of arrs){ out.set(a,p); p+=a.length; }
  return out;
}

async function inflateOne(u8){
  const ds=new DecompressionStream("gzip");
  const stream=new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decompress a (possibly multi-member) gzip stream. Real apk v2 files are
// concatenated gzip members ([signature?][control.tar.gz][data.tar.gz]); Chrome's
// DecompressionStream errors on the trailing member rather than continuing, so we
// walk candidate member starts (gzip magic 1f 8b 08) and inflate each separately,
// returning every member's output concatenated (the data/files tarball included).
//
// The byte-by-byte magic scan only runs as a FALLBACK when the whole-buffer
// single-stream attempt fails (i.e. only for genuinely multi-member payloads,
// already the case below) -- for the common single-member case (most non-apk
// gzip payloads: rootfs .tar.gz, APKINDEX.tar.gz) the O(n) scan never runs at
// all, so there is no unconditional per-byte cost to skip.
export async function gunzip(bytes){
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(typeof DecompressionStream==="undefined"){
    throw new Error("alpine-apk: DecompressionStream unavailable (need browser or Node >=18)");
  }
  // First try the whole buffer as a single stream (works for single-member .apk).
  try{ return await inflateOne(u8); }catch(_){ /* multi-member: walk below */ }
  // Find every gzip member start: magic 0x1f 0x8b, method 0x08.
  const starts=[];
  for(let i=0;i+2<u8.length;i++){ if(u8[i]===0x1f && u8[i+1]===0x8b && u8[i+2]===0x08) starts.push(i); }
  const members=[];
  for(let s=0;s<starts.length;s++){
    const begin=starts[s];
    // Try progressively shorter end boundaries (next member start, then EOF).
    const candidates=[ s+1<starts.length?starts[s+1]:u8.length, u8.length ];
    for(const end of candidates){
      try{ members.push(await inflateOne(u8.subarray(begin,end))); break; }catch(_){ /* try next */ }
    }
  }
  if(!members.length) throw new Error("alpine-apk: no decodable gzip member found");
  return concat(members);
}

// Parse a POSIX/GNU tar buffer into {name, type, mode, data} records.
// Handles the GNU long-name ('L') extension apk uses for deep paths.
export function parseTar(u8){
  const out=[]; let p=0; let pendingLongName=null;
  while(p+512<=u8.length){
    const block=u8.subarray(p,p+512);
    if(block.every(b=>b===0)){ p+=512; continue }
    let name=td.decode(block.subarray(0,100)).replace(/\0.*/,"");
    const mode=parseInt(td.decode(block.subarray(100,108)).replace(/[\0\s]/g,"")||"0",8)||0o644;
    const size=parseInt(td.decode(block.subarray(124,136)).replace(/[\0\s]/g,"")||"0",8)||0;
    const type=String.fromCharCode(block[156]||0x30);
    const prefix=td.decode(block.subarray(345,500)).replace(/\0.*/,"");
    if(prefix) name=prefix+"/"+name;
    const data=u8.subarray(p+512,p+512+size);
    p+=512+Math.ceil(size/512)*512;
    if(type==="L"){ pendingLongName=td.decode(data).replace(/\0.*/,""); continue }
    if(pendingLongName){ name=pendingLongName; pendingLongName=null; }
    out.push({ name:name.replace(/^\.\//,""), type, mode, data, linkname:td.decode(block.subarray(157,257)).replace(/\0.*/,"") });
  }
  return out;
}

export function mkdirp(FS,path){
  let cur="";
  for(const seg of path.split("/").filter(Boolean)){
    cur+="/"+seg;
    try{ FS.mkdir(cur,0o755) }catch(_){}
  }
}

// Write one tar record into the FS rooted at `root`. Skips apk metadata members
// (.PKGINFO, .SIGN.*, .pre-install, etc.) — they describe the package, not files.
export function writeRecord(FS, root, rec){
  if(rec.name.startsWith(".")) return false;
  const full=(root+"/"+rec.name).replace(/\/+/g,"/");
  if(rec.type==="5"){ mkdirp(FS, full); return true }
  mkdirp(FS, full.replace(/\/[^/]*$/,""));
  if(rec.type==="2"||rec.type==="1"){
    try{ FS.unlink(full) }catch(_){}
    try{ FS.symlink(rec.linkname, full) }catch(_){}
    return true;
  }
  if(rec.type==="0"||rec.type===""||rec.type===" "){
    try{ FS.unlink(full) }catch(_){}
    const s=FS.open(full,"w+");
    if(rec.data.length) FS.write(s, rec.data, 0, rec.data.length, 0);
    FS.close(s); FS.chmod(full, rec.mode||0o644);
    return true;
  }
  return false;
}

// Find the byte range [start,end) of the FIRST gzip member (magic 1f 8b 08)
// in a possibly-multi-member buffer, matching gunzip()'s own member walk.
// Real apk v2 files are [optional .SIGN.RSA gzip member][control.tar.gz
// member][data.tar.gz member] concatenated -- the control member is
// whichever one is first EXCEPT when a signature member precedes it (real
// signed packages: signature first, so its own gzip magic is member 0 and
// control.tar.gz is member 1). Distinguishing them requires inflating each
// candidate and checking for a .PKGINFO entry, since apk-tools itself
// verifies the checksum this way (over the control member specifically),
// not the whole file.
function findGzipMemberStarts(u8){
  const starts=[];
  for(let i=0;i+2<u8.length;i++){ if(u8[i]===0x1f && u8[i+1]===0x8b && u8[i+2]===0x08) starts.push(i); }
  return starts;
}

// Verify a fetched .apk's bytes against APKINDEX's C: field ("Q1<base64
// sha1>"). apk-tools computes this SHA1 over the COMPRESSED bytes of the
// control.tar.gz member specifically (the one containing .PKGINFO), not the
// whole concatenated .apk file -- verified live against a real fetched
// musl-1.2.5-r11.apk whose whole-file SHA1 did not match its APKINDEX C:
// field, while extracting the member with a .PKGINFO entry inside does.
// Returns true/false; a missing/malformed checksum, an undecodable member,
// or no crypto.subtle returns null (unverifiable, not a mismatch) so callers
// distinguish "proven bad" from "nothing to check against".
export async function verifyChecksum(bytes, checksum){
  if(!checksum || !checksum.startsWith("Q1")) return null;
  if(typeof crypto==="undefined" || !crypto.subtle) return null;
  const u8=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const starts=findGzipMemberStarts(u8);
  if(!starts.length) return null;
  // Whole-file single-member case (no concatenation): hash the whole thing.
  if(starts.length===1){
    const digest=await crypto.subtle.digest("SHA-1", u8);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))===checksum.slice(2);
  }
  // Multi-member: find the member whose inflated tar contains .PKGINFO,
  // hash THAT member's still-compressed byte range.
  for(let s=0;s<starts.length;s++){
    const begin=starts[s];
    const end=s+1<starts.length?starts[s+1]:u8.length;
    const memberBytes=u8.subarray(begin,end);
    try{
      const tar=await inflateOne(memberBytes);
      if(parseTar(tar).some(r=>r.name===".PKGINFO")){
        const digest=await crypto.subtle.digest("SHA-1", memberBytes);
        return btoa(String.fromCharCode(...new Uint8Array(digest)))===checksum.slice(2);
      }
    }catch(_){ /* not a valid member on its own, try next */ }
  }
  return null;
}

export function readPkgInfo(records){
  const info=records.find(r=>r.name===".PKGINFO");
  const meta={ name:null, version:null };
  if(info){
    for(const line of td.decode(info.data).split("\n")){
      const m=line.match(/^(\w[\w-]*)\s*=\s*(.+)$/);
      if(m){ if(m[1]==="pkgname") meta.name=m[2].trim(); if(m[1]==="pkgver") meta.version=m[2].trim(); }
    }
  }
  return meta;
}
