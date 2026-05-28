// docs/assets/cli.js — busybox CLI panel for the webix gh-pages demo
// Single-command-per-line. argv space-joined upstream; no pipes, no persistent FS.
// Banner `\n$ ./busybox <argv>\n` is stripped before display.

const ASSETS = new URL('./', import.meta.url).href;

let busyboxBytes = null;
let queue = Promise.resolve();

async function loadBusybox(){
  if (busyboxBytes) return busyboxBytes;
  const r = await fetch(ASSETS + 'busybox-x86_64.elf');
  busyboxBytes = new Uint8Array(await r.arrayBuffer());
  return busyboxBytes;
}

function tokenize(line){
  // light tokenizer: respect double-quoted segments client-side. blink will still
  // space-join, so quoted-with-space args lose their grouping at the wasm boundary —
  // surfaced as a documented residual in the page.
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
  const banner = `\n$ ${argv.join(' ')}\n`;
  if (stdout.startsWith(banner)) return stdout.slice(banner.length);
  // sometimes the leading newline is suppressed
  const alt = `$ ${argv.join(' ')}\n`;
  if (stdout.startsWith(alt)) return stdout.slice(alt.length);
  return stdout;
}

export function createCli({ onLine, onStatus }){
  const history = [];
  let histIdx = -1;
  let pending = '';

  async function execApk(x, tokens){
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
      return { stdout:'', stderr:`apk: unknown subcommand '${sub}' (try add|info|list)`, exitCode:1 };
    } catch (e){
      return { stdout:'', stderr:'apk error: '+(e?.message||e), exitCode:1 };
    }
  }

  async function exec(input){
    const trimmed = input.trim();
    if (!trimmed) return { stdout:'', stderr:'', exitCode:0 };
    const x = window.__debug?.x86_64;
    if (!x) return { stdout:'', stderr:'host not ready', exitCode:1 };

    const userTokens = tokenize(trimmed);
    if (userTokens[0] === 'apk') return execApk(x, userTokens.slice(1));
    const argv = ['./busybox', ...userTokens];
    const bytes = await loadBusybox();

    onStatus?.('running');
    const r = await x.runElf(bytes, { argv });
    onStatus?.('ready');
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
    return [
      'webix busybox shell — single-applet per line.',
      'try: ls -la /  ·  uname -a  ·  date  ·  cal  ·  expr 7 \\* 6  ·  id  ·  --list',
      'alpine: apk add <pkg>  ·  apk list  ·  apk info <pkg>  (live from the alpine repo via CORS proxy)',
      'caveats: no pipes, no /tmp persistence, argv space-joined (quoted args lose grouping).',
      ''
    ].join('\n');
  }

  return { submit, recall, history, intro };
}
