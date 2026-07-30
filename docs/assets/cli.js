// docs/assets/cli.js — busybox CLI panel for the webix gh-pages demo
// Single-command-per-line. argv is NUL-separated so multi-word/quoted args
// survive to the guest; no full shell pipelines (no fork), no persistent FS.
// Banner `\n$ ./busybox <argv>\n` is stripped before display.

const ASSETS = new URL('./', import.meta.url).href;

let busyboxHandle = null;
let queue = Promise.resolve();

// Preload busybox into the host FS once via preloadFile, then reuse the handle
// across every command — blink-core skips the ~1MB FS rewrite when the same
// handle is already sitting at /program (see runElf's lastLoaded check).
async function loadBusybox(x){
  if (busyboxHandle && x.host.isPreloaded?.(busyboxHandle)) return busyboxHandle;
  const r = await fetch(ASSETS + 'busybox-x86_64.elf');
  const bytes = new Uint8Array(await r.arrayBuffer());
  busyboxHandle = x.host.preloadFile('busybox', bytes);
  return busyboxHandle;
}

function tokenize(line){
  // light tokenizer: respect double-quoted segments client-side. argv crosses the
  // wasm boundary NUL-separated, so a quoted-with-space token stays one argument
  // all the way to the guest (verified by test.js "multi-word argument survives").
  const out=[]; let cur=''; let q=false;
  for (const ch of line){
    if (ch === '"'){ q = !q; continue }
    if (ch === ' ' && !q){ if (cur){ out.push(cur); cur='' }; continue }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function stripBanner(stdout, argv){
  // The guest emits a leading banner line `\n$ ./busybox\n` (progname only —
  // under NUL-separated argv the C banner no longer echoes the full argv, so
  // reconstructing it from argv.join(' ') would mismatch and leak the banner).
  // Strip a single leading `$ <argv0>` line up to and including its newline.
  const arg0 = argv[0] || './busybox';
  const banner = `\n$ ${arg0}\n`;
  if (stdout.startsWith(banner)) return stdout.slice(banner.length);
  const alt = `$ ${arg0}\n`;
  if (stdout.startsWith(alt)) return stdout.slice(alt.length);
  return stdout;
}

export function createCli({ onLine, onStatus }){
  const history = [];
  let histIdx = -1;
  let pending = '';

  async function execApk(x, tokens){
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

  // Resolve the first token to a real installed binary's path -- apk-installed
  // packages (nodejs, python3, etc) land in /usr/bin or /bin as real ELFs, not
  // busybox applets, so forcing every command through `./busybox <cmd>` made
  // them unreachable ("applet not found") even after a successful apk add.
  // Checked ONLY for names not already resolvable as a busybox applet path
  // (an absolute/relative path the user typed directly, e.g. `/usr/bin/node`,
  // is tried as-is first).
  function findRealBinary(x, name){
    if (name.includes('/')) return name.startsWith('/') ? name : null;
    // window.__debug.x86_64 has no `Module` of its own -- the emscripten
    // Module/FS lives on `host.Module`. x.Module?.FS was always undefined,
    // so this always fell through to busybox; live-witnessed nodejs
    // installing fine (23 packages) yet `node` still "applet not found".
    const FS = x.host?.Module?.FS;
    if (!FS) return null;
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']){
      const p = `${dir}/${name}`;
      try { if (FS.analyzePath(p).exists) return p; } catch(_){}
    }
    return null;
  }

  async function exec(input){
    const trimmed = input.trim();
    if (!trimmed) return { stdout:'', stderr:'', exitCode:0 };
    const x = window.__debug?.x86_64;
    if (!x) return { stdout:'', stderr:'host not ready', exitCode:1 };

    const userTokens = tokenize(trimmed);
    if (userTokens[0] === 'apk') return execApk(x, userTokens.slice(1));

    const realBin = findRealBinary(x, userTokens[0]);
    const argv = realBin ? [realBin, ...userTokens.slice(1)] : ['./busybox', ...userTokens];
    const path = realBin ? undefined : await loadBusybox(x);
    const bytes = realBin ? x.host.Module.FS.readFile(realBin) : undefined;

    onStatus?.('running');
    const r = realBin
      ? await x.runElf(bytes, { argv, progname: realBin })
      : await x.runElf(null, { argv, path });
    onStatus?.('ready');
    // The banner (`\n$ <argv0>\n`) is emitted by the guest's own init/libc
    // path regardless of whether the ELF ran via busybox or a directly
    // loaded real binary -- confirmed live for both /usr/bin/hello (a
    // freestanding ELF) and /bin/ls (an alpine musl-libc binary, itself a
    // busybox symlink installed by the base rootfs, not by apk). Always
    // strip it.
    const clean = stripBanner(r.stdout, argv);
    return { stdout: clean, stderr: r.stderr, exitCode: r.exitCode, argv };
  }

  function submit(input){
    if (input.trim()){ history.push(input); histIdx = history.length }
    onLine?.({ kind:'prompt', text:'$ ' + input });
    queue = queue.then(async () => {
      try {
        const r = await exec(input);
        if (r.stdout) onLine?.({ kind:'stdout', text:r.stdout });
        if (r.stderr) onLine?.({ kind:'stderr', text:r.stderr });
        onLine?.({ kind:'exit', text:`exit ${r.exitCode}`, code:r.exitCode });
        return r;
      } catch (e){
        onLine?.({ kind:'stderr', text:'error: '+(e?.message||e) });
      }
    });
    return queue;
  }

  function recall(direction){
    if (!history.length) return null;
    if (direction === 'up'){
      histIdx = Math.max(0, histIdx - 1);
    } else {
      histIdx = Math.min(history.length, histIdx + 1);
    }
    return histIdx === history.length ? '' : history[histIdx];
  }

  function intro(){
    // the page seeds its own MOTD on boot; keep this minimal to avoid a double banner.
    return [
      'busybox shell - one applet per line. caveats: no shell pipelines (no fork),',
      'no /tmp persistence across commands. quoted multi-word args are preserved.',
      ''
    ].join('\n');
  }

  return { submit, recall, history, intro };
}
