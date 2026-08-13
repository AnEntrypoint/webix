// src/shell-pipeline.js — non-streaming shell-pipeline emulation.
// blink-core.js's exitDeferred guard forces strict sequential runElf calls,
// and emscripten has no fork(), so a real guest `sh -c 'a | b'` cannot run:
// each stage would need to fork. This fakes it batch-style at the JS layer --
// run stage a to completion, capture its full stdout, feed those bytes as
// stage b's stdin via host.pushStdin. Non-streaming by construction: works
// for `ls | sort`, fails for `yes | head`, `tail -f | grep`, or anything
// interactive/infinite (documented scope, not a defect).

// Split a shell command line on top-level unquoted `|`. Quoted segments
// (single or double) are passed through untouched so `grep "a|b"` doesn't
// get mis-split.
export function splitPipeline(cmdline){
  const stages=[]; let cur=""; let q=null;
  for(const ch of cmdline){
    if(q){ cur+=ch; if(ch===q) q=null; continue }
    if(ch==='"'||ch==="'"){ q=ch; cur+=ch; continue }
    if(ch==="|"){ stages.push(cur); cur=""; continue }
    cur+=ch;
  }
  stages.push(cur);
  return stages.map(s=>s.trim());
}

// A real pipeline is 2+ NON-EMPTY stages. An empty stage means `||` (bash's
// OR operator, a completely different meaning we don't emulate), a leading
// `|`, or a trailing `|` -- `splitPipeline` used to silently .filter(Boolean)
// those away, so "echo a || echo b" was misread as a real 2-stage pipe
// (live-witnessed: it ran "echo b" unconditionally with "echo a"'s output as
// a trailing file argument, producing "b /tmp/..." instead of bash's "a").
// Rejecting any empty stage here routes `||` to the ordinary single-command
// path instead, which passes it through literally -- not the real OR
// semantics, but honest rather than silently wrong.
export function isPipeline(cmdline){
  const stages = splitPipeline(cmdline);
  return stages.length > 1 && stages.every(Boolean);
}

// Split one stage into argv tokens, respecting double/single-quoted segments.
function tokenizeStage(stage){
  const out=[]; let cur=""; let q=null;
  for(const ch of stage){
    if(q){ if(ch===q) q=null; else cur+=ch; continue }
    if(ch==='"'||ch==="'"){ q=ch; continue }
    if(ch===" "||ch==="\t"){ if(cur){ out.push(cur); cur="" } continue }
    cur+=ch;
  }
  if(cur) out.push(cur);
  return out;
}

// Run a multi-stage pipeline against one busybox host. `host` is a
// createBlinkHost() instance (or window.__debug.x86_64's `.host`). Each
// stage's argv is dispatched DIRECTLY to busybox's multi-call applet
// (`argv:[applet,...args]`, the same direct-exec path test.js's own
// echo/uname/expr cases use) rather than through `sh -c` -- ash forks to
// exec any applet that isn't one of its own shell builtins, and emscripten
// has no fork(), so wrapping a stage in `sh -c` fails (exit 126) the moment
// the stage names a real external applet like `wc` or `sort`.
//
// The previous stage's stdout is handed to the next stage as a TEMP FILE
// argument, not real stdin: a blocking stdin read only completes cleanly on
// a host's first runElf (the fast synchronous main-thread path); every
// runElf after the first on the same host re-enters through blink-core.js's
// thread-slot RE-ENTRANCY path, and a stdin read from that proxied-syscall
// path was witnessed live to hang (test timeout, not a wrong-output bug).
// Every applet used for a pipeline stage (wc/sort/tail/grep/...) accepts a
// trailing filename in place of stdin, so this sidesteps the hang entirely
// and is honest about the "non-streaming batch" nature already documented
// for this feature -- there is no real stdin stream here, by design.
// A stage that exits non-zero before the last stage stops the pipeline
// early (nothing meaningful to feed forward), mirroring a real shell's
// short-circuit on a broken pipe. Returns the final stage's {exitCode,
// stdout, stderr}, with stderr from every stage concatenated so upstream
// failures stay visible.
// The guest emits a leading banner line `\n$ <argv0>\n` (progname only, per
// cli.js's own stripBanner) before real output; feeding it forward as file
// content would corrupt every downstream stage's word/line counts.
function stripBanner(stdout, argv0){
  const banner = `\n$ ${argv0}\n`;
  if(stdout.startsWith(banner)) return stdout.slice(banner.length);
  const alt = `$ ${argv0}\n`;
  return stdout.startsWith(alt) ? stdout.slice(alt.length) : stdout;
}

// `busybox` is either raw ELF bytes (Uint8Array) for the first/only run
// against a host, or a string handle from host.preloadFile() -- passing the
// handle lets a caller that already preloaded busybox (e.g. the CLI's
// loadBusybox()) skip re-fetching and re-writing the ~1MB ELF on every
// pipelined command.
export async function runPipeline(host, busybox, cmdline, { progname="/program" } = {}){
  const stages = splitPipeline(cmdline);
  if(!(stages.length > 1 && stages.every(Boolean))){
    throw new Error("shell-pipeline: not a valid pipeline (call isPipeline() first): "+JSON.stringify(cmdline));
  }
  const isHandle = typeof busybox === "string";
  const FS = host.Module.FS;
  let feedPath = null;
  let last = null;
  let cleanStdout = "";
  let stderrAll = "";
  for(let i=0;i<stages.length;i++){
    const argv = tokenizeStage(stages[i]);
    if(feedPath) argv.push(feedPath);
    last = await host.runElf(isHandle ? null : busybox, { argv, progname, path: isHandle ? busybox : undefined });
    cleanStdout = stripBanner(last.stdout, argv[0]);
    if(last.stderr) stderrAll += last.stderr;
    if(last.exitCode !== 0 && i < stages.length-1) break;
    if(i < stages.length-1){
      feedPath = "/tmp/_webix_pipe_"+i;
      try{ FS.mkdir("/tmp") }catch(_){}
      FS.writeFile(feedPath, cleanStdout);
    }
  }
  return { exitCode: last.exitCode, stdout: cleanStdout, stderr: stderrAll, stageCount: stages.length };
}
