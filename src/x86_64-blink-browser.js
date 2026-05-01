const BLINK_PREEMPT = 40;
const BLINK_FAKE_TTY = 42;
const SIGTRAP = 5;

export async function createBlinkHostBrowser(options = {}) {
  const wasmUrl = options.wasmUrl ?? "/containers/blinkenlib.wasm";
  const glueUrl = options.glueUrl ?? "/containers/blinkenlib.js";
  const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  const factory = (await import(glueUrl)).default;
  let stdoutBuf = "", stderrBuf = "", exitCode = null, lastSignal = null;
  const stdinQueue = [];
  const Module = await factory({
    noInitialRun: true,
    wasmBinary,
    preRun: (M) => {
      M.FS.init(
        () => stdinQueue.length ? stdinQueue.pop() : null,
        (c) => { if (c !== null) { stdoutBuf += String.fromCharCode(c); options.onStdout?.(c); } },
        (c) => { if (c !== null) { stderrBuf += String.fromCharCode(c); options.onStderr?.(c); } }
      );
    }
  });
  const signalCb = Module.addFunction((sig, code) => {
    if (sig !== SIGTRAP) { lastSignal = { sig, code }; exitCode = 128 + sig; return; }
    if (code === BLINK_PREEMPT) Module._blinkenlib_preempt_resume();
    else if (code === BLINK_FAKE_TTY) {
      if (options.onTtyPause) options.onTtyPause();
      else Module._blinkenlib_faketty_resume();
    }
  }, "vii");
  const exitCb = Module.addFunction((code) => { exitCode = code; }, "vi");
  Module.callMain([signalCb.toString(), exitCb.toString()]);
  const argcPtr = Module._blinkenlib_get_argc_string();
  const argvPtr = Module._blinkenlib_get_argv_string();
  const prognamePtr = Module._blinkenlib_get_progname_string();
  function writeStr(ptr, str, max) {
    const view = new DataView(Module.wasmExports.memory.buffer);
    const n = Math.min(str.length, max - 1);
    for (let i = 0; i < n; i++) view.setUint8(ptr + i, str.charCodeAt(i));
    view.setUint8(ptr + n, 0);
  }
  return {
    Module,
    clstruct: Module._blinkenlib_get_clstruct(),
    async runElf(bytes, { argv = [], progname = "/program" } = {}) {
      const FS = Module.FS;
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      try { FS.unlink("/program"); } catch (_) {}
      const stream = FS.open("/program", "w+");
      FS.write(stream, data, 0, data.length, 0);
      FS.close(stream);
      FS.chmod("/program", 0o755);
      writeStr(prognamePtr, progname, 200);
      const cmdline = argv.length ? argv.join(" ") : progname;
      writeStr(argcPtr, cmdline, 200);
      writeStr(argvPtr, "", 200);
      stdoutBuf = ""; stderrBuf = ""; exitCode = null; lastSignal = null;
      Module._blinkenlib_run();
      while (exitCode === null) await new Promise((r) => setTimeout(r, 5));
      return { exitCode, stdout: stdoutBuf, stderr: stderrBuf, signal: lastSignal };
    },
    pushStdin(bytes) { for (const b of [...bytes].reverse()) stdinQueue.unshift(b); }
  };
}
