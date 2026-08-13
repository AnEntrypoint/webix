// docs/assets/cli-apk.js — apk subcommand handling for the webix CLI panel,
// split out of cli.js to stay under the repo's <200-line-per-file cap.

const ASSETS = new URL('./', import.meta.url).href;

// Flush the /persist IDBFS mount (see host.persistDir in blink-core.js,
// enabled by installWindowDebug({persist:true})) after a mutation. NOTE:
// apk installs land under /usr, /lib, /etc per the package's own tar
// layout, not under /persist, so this does not yet persist apk-installed
// packages across a reload -- it only flushes whatever a guest program
// itself wrote under /persist. No-op when persistence isn't mounted
// (host._persistDir unset). See AGENTS.md's IDBFS persistence note for
// what full apk-install persistence still needs.
async function flushPersist(x){
  if (x.host?._persistDir) { try { await x.host.syncPersist(); } catch(_){} }
}

export async function execApk(x, tokens){
  // apk may still be lazy-mounting in the background (lazyRootfs mode) --
  // wait for it once rather than reporting a false "unavailable".
  if (!x.apk && x.apkReady) await x.apkReady;
  if (!x.apk) return { stdout:'', stderr:'apk unavailable: rootfs not mounted', exitCode:1 };
  const sub = tokens[0];
  try {
    if (sub === 'add'){
      const targets = tokens.slice(1);
      if (!targets.length) return { stdout:'', stderr:'apk add: missing package name', exitCode:1 };
      const out = [];
      for (const target of targets){
        let r;
        if (/^https?:\/\//.test(target) || /\.apk$/.test(target)){
          // explicit URL or a .apk filename -> fetch that file directly
          const url = /^https?:\/\//.test(target) ? target : (ASSETS + target);
          r = await x.apk.addUrl(url);
        } else {
          // a bare package name -> resolve+fetch live from the Alpine repo
          // (via a CORS proxy; Alpine mirrors send no CORS headers)
          r = await x.apk.addByName(target);
        }
        out.push(r.alreadyInstalled
          ? `${r.name} (${r.version||'?'}) is already installed`
          : `Installing ${r.name} (${r.version||'?'}) — ${r.files.length} files`);
      }
      out.push('OK: ' + x.apk.list().length + ' packages installed');
      await flushPersist(x);
      return { stdout: out.join('\n') + '\n', stderr:'', exitCode:0 };
    }
    if (sub === 'info'){
      const i = x.apk.info(tokens[1]);
      return i ? { stdout:`${tokens[1]}-${i.version}\n${i.files.length} files\n`, stderr:'', exitCode:0 }
               : { stdout:'', stderr:`${tokens[1]||''} not installed`, exitCode:1 };
    }
    if (sub === 'list' || !sub){
      const rows = x.apk.list().map(p=>`${p.name}-${p.version} [${p.fileCount} files]`);
      return { stdout: (rows.join('\n') || '(no packages installed)') + '\n', stderr:'', exitCode:0 };
    }
    if (sub === 'search'){
      const query = tokens.slice(1).join(' ');
      if (!query) return { stdout:'', stderr:'apk search: missing query', exitCode:1 };
      const { packages, total } = await x.apk.search(query, { limit:40 });
      if (!packages.length) return { stdout:'', stderr:`apk search: no match for '${query}' in alpine v3.21 main/community`, exitCode:1 };
      const rows = packages.map(p=>`${p.name}-${p.version}${p.summary ? ' — '+p.summary : ''}`);
      const suffix = total>packages.length ? `\n(${total} total matches, showing ${packages.length} — narrow the query for more)` : '';
      return { stdout: rows.join('\n') + suffix + '\n', stderr:'', exitCode:0 };
    }
    return { stdout:'', stderr:`apk: unknown subcommand '${sub}' (try add|search|info|list)`, exitCode:1 };
  } catch (e){
    return { stdout:'', stderr:'apk error: '+(e?.message||e), exitCode:1 };
  }
}
