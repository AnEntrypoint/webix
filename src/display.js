// Framebuffer display + input bridge for the blink host.
//
// The guest publishes its RGBA framebuffer via the synthetic 0x5fb syscall
// (blinkenlib_fb_register); the host reads geometry through host.fbInfo() and
// maps the pixels zero-copy via host.fbView() (a Uint8ClampedArray over the
// guest framebuffer in WASM linear memory). attachDisplay() runs a
// requestAnimationFrame loop that blits to a <canvas>, and forwards canvas
// keyboard/mouse events into the guest input device.
//
// Performance notes (the whole point of the zero-copy path):
//   - fbView() is re-derived every frame: ALLOW_MEMORY_GROWTH detaches the
//     backing ArrayBuffer when the guest grows memory, which silently
//     invalidates any cached typed-array view. Reading geometry+pointer fresh
//     each frame is cheap (a few wasm calls) and detach-safe.
//   - We only blit when host.fbInfo().generation changed since the last paint
//     (the guest bumps it on register + flip), so an idle desktop costs one
//     generation read per frame and no putImageData.

const DEFAULT_FPS_CAP = 60;

export function attachDisplay(host, canvas, opts = {}) {
  if (!host || typeof host.fbView !== "function") {
    throw new Error("attachDisplay: host lacks fbView (rebuild blinkenlib with the framebuffer patch)");
  }
  if (!canvas) throw new Error("attachDisplay: canvas required");

  const fpsCap = opts.fpsCap || DEFAULT_FPS_CAP;
  const minFrameMs = 1000 / fpsCap;
  const ctx = canvas.getContext("2d", { alpha: false });

  let running = true;
  let lastGen = -1;
  let lastPaint = 0;
  let blits = 0;
  let frames = 0;
  let rafId = 0;
  let imageData = null;
  let imgW = 0, imgH = 0;

  function paint(now) {
    if (!running) return;
    rafId = requestAnimationFrame(paint);
    frames++;
    if (now - lastPaint < minFrameMs) return;

    const info = host.fbInfo();
    if (!info) return; // guest has not registered a framebuffer yet
    if (info.generation === lastGen) return; // nothing changed since last paint

    if (canvas.width !== info.width || canvas.height !== info.height) {
      canvas.width = info.width;
      canvas.height = info.height;
    }
    // Reuse the ImageData buffer across frames unless geometry changed.
    if (!imageData || imgW !== info.width || imgH !== info.height) {
      imageData = ctx.createImageData(info.width, info.height);
      imgW = info.width; imgH = info.height;
    }
    // fbView writes guest pixels straight into imageData.data (stride handling
    // lives in the one page-wise copy loop inside blink-core, not here) --
    // fuses the guest-page copy with the ImageData copy, deleting a full
    // extra frame-sized memcpy every blit.
    const view = host.fbView(imageData.data);
    if (!view) return;
    ctx.putImageData(imageData, 0, 0);
    lastGen = info.generation;
    lastPaint = now;
    blits++;
  }

  rafId = requestAnimationFrame(paint);

  // ---- Input forwarding ----
  // The guest input device (added to blink C) consumes a packed event stream.
  // host.pushInput(evt) is the host-side writer; if the running wasm predates
  // the input device, pushInput is absent and input is silently a no-op so the
  // display still works. Event shape: {type, ...} kept small + JSON-free.
  const hasInput = typeof host.pushInput === "function";
  const listeners = [];
  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  }
  if (hasInput) {
    on(canvas, "keydown", (e) => { host.pushInput({ type: "key", down: 1, code: e.keyCode, key: e.key }); e.preventDefault(); });
    on(canvas, "keyup", (e) => { host.pushInput({ type: "key", down: 0, code: e.keyCode, key: e.key }); e.preventDefault(); });
    // Pointer Events cover mouse+touch+pen through one API (unlike the old
    // mouse-only listeners, which left the framebuffer/X-display feature
    // unusable on touch-only devices). setPointerCapture keeps drag events
    // arriving even if a touch slides off the canvas mid-gesture.
    canvas.style.touchAction = "none";
    on(canvas, "pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      host.pushInput({ type: "motion", x: ((e.clientX - r.left) * canvas.width / r.width) | 0, y: ((e.clientY - r.top) * canvas.height / r.height) | 0 });
      host.pushInput({ type: "button", down: 1, button: e.button });
      e.preventDefault();
    });
    on(canvas, "pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      host.pushInput({ type: "motion", x: ((e.clientX - r.left) * canvas.width / r.width) | 0, y: ((e.clientY - r.top) * canvas.height / r.height) | 0 });
    });
    on(canvas, "pointerup", (e) => { host.pushInput({ type: "button", down: 0, button: e.button }); });
    on(canvas, "pointercancel", (e) => { host.pushInput({ type: "button", down: 0, button: e.button }); });
    canvas.tabIndex = 0; // make the canvas focusable for key events
  }

  return {
    stats: () => ({ blits, frames, lastGen, hasInput, fb: host.fbInfo() }),
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
      for (const [t, ty, fn] of listeners) t.removeEventListener(ty, fn);
    },
  };
}
