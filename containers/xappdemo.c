/* xappdemo: a self-contained in-guest GUI "app" for the blinkenlib framebuffer.
 *
 * This is the in-guest display producer: a static x86_64 ELF that renders a
 * real windowed desktop UI (background + a draggable window with a title bar
 * and content) straight to an mmap'd RGBA framebuffer, publishes it to the host
 * via syscall 0x5fb (blinkenlib_fb_register), and consumes host-injected
 * keyboard/mouse events via syscall 0x5fc (blinkenlib_input_read) to drag the
 * window. The sandcastle DesktopCanvas blits the framebuffer to a <canvas> and
 * forwards canvas input into the ring, so this app appears as a live,
 * interactive GUI window in the browser -- the "X app" experience without the
 * weight of a full X server (impractical under single-thread NOJIT blink).
 *
 * Raw syscalls only (no libc); built static + freestanding in CI.
 *
 * Input event layout (must match blinkenlib.c): 16 bytes
 *   { u16 type; u16 code; i32 x; i32 y; i32 value; u32 _pad }
 *   type: 1=key 2=motion 3=button.  button: value=1 down / 0 up.
 */
#include <stdint.h>

#define SYS_mmap        9
#define SYS_write       1
#define SYS_exit        60
#define SYS_nanosleep   35
#define SYS_fb_register 0x5fb
#define SYS_input_read  0x5fc

#define W 800
#define H 600
#define STRIDE (W * 4)
#define EVSZ 16
#define MAXEV 64

static long sc6(long n, long a, long b, long c, long d, long e, long f) {
  long ret;
  register long r10 __asm__("r10") = d;
  register long r8  __asm__("r8")  = e;
  register long r9  __asm__("r9")  = f;
  __asm__ volatile("syscall" : "=a"(ret)
                   : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
                   : "rcx", "r11", "memory");
  return ret;
}
#define sc3(n,a,b,c) sc6((n),(a),(b),(c),0,0,0)

static uint8_t *fb;

static inline void px(int x, int y, uint32_t rgba) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  *(uint32_t *)(fb + (long)y * STRIDE + (long)x * 4) = rgba;
}
static void fill(int x0, int y0, int w, int h, uint32_t c) {
  for (int y = y0; y < y0 + h; y++)
    for (int x = x0; x < x0 + w; x++) px(x, y, c);
}
/* RGBA little-endian: byte0=R byte1=G byte2=B byte3=A. */
#define RGBA(r,g,b) ((uint32_t)(r) | ((uint32_t)(g)<<8) | ((uint32_t)(b)<<16) | 0xff000000u)

/* a tiny 5x7 block-glyph "WINDOW" stand-in: draw the title bar text as bars */
static void titlebar_label(int x, int y) {
  /* draw 6 little 6x7 filled marks to suggest text, white */
  for (int i = 0; i < 6; i++) fill(x + i * 8, y, 5, 7, RGBA(240,240,240));
}

void _start(void) {
  long len = (long)STRIDE * H;
  fb = (uint8_t *)sc6(SYS_mmap, 0, len, 3 /*RW*/, 0x22 /*PRIV|ANON*/, -1, 0);
  if ((long)fb < 0) sc3(SYS_exit, 1, 0, 0);

  /* window state */
  int wx = 220, wy = 150, ww = 360, wh = 240;
  const int TITLE_H = 28;
  int dragging = 0, grabx = 0, graby = 0;
  int mx = W / 2, my = H / 2, mdown = 0;

  uint8_t evbuf[MAXEV * EVSZ];

  for (int frame = 0; ; frame++) {
    /* ---- drain input ---- */
    long n = sc3(SYS_input_read, (long)evbuf, MAXEV, 0);
    for (long i = 0; i < n; i++) {
      uint8_t *e = evbuf + i * EVSZ;
      uint16_t type; int32_t ex, ey, val;
      __builtin_memcpy(&type, e + 0, 2);
      __builtin_memcpy(&ex, e + 4, 4);
      __builtin_memcpy(&ey, e + 8, 4);
      __builtin_memcpy(&val, e + 12, 4);
      if (type == 2) { mx = ex; my = ey; }            /* motion */
      else if (type == 3) {                            /* button */
        mdown = val;
        if (val) {
          /* press inside title bar -> start drag */
          if (mx >= wx && mx < wx + ww && my >= wy && my < wy + TITLE_H) {
            dragging = 1; grabx = mx - wx; graby = my - wy;
          }
        } else dragging = 0;
      }
    }
    if (dragging && mdown) { wx = mx - grabx; wy = my - graby; }

    /* ---- paint ---- */
    /* desktop background: vertical gradient */
    for (int y = 0; y < H; y++) {
      uint32_t c = RGBA(20 + y * 30 / H, 30 + y * 50 / H, 60 + y * 80 / H);
      for (int x = 0; x < W; x++) *(uint32_t *)(fb + (long)y * STRIDE + (long)x * 4) = c;
    }
    /* window shadow + body */
    fill(wx + 6, wy + 6, ww, wh, RGBA(0,0,0));
    fill(wx, wy, ww, wh, RGBA(235,235,238));
    /* title bar */
    fill(wx, wy, ww, TITLE_H, RGBA(40,90,200));
    titlebar_label(wx + 12, wy + 11);
    /* close box */
    fill(wx + ww - 22, wy + 8, 12, 12, RGBA(220,70,70));
    /* content: animated block so motion is visible frame-to-frame */
    int bx = wx + 24 + (frame % (ww > 96 ? ww - 96 : 1));
    fill(wx + 24, wy + TITLE_H + 20, ww - 48, 40, RGBA(120,170,120));
    fill(bx % (wx + ww - 60) + 0, wy + TITLE_H + 80, 48, 48, RGBA(200,150,60));
    /* mouse cursor */
    fill(mx, my, 8, 8, RGBA(255,255,0));

    /* publish: register on frame 0, then bump generation each frame via re-register */
    sc6(SYS_fb_register, (long)fb, W, H, STRIDE, 0, 0);

    if (frame == 0) {
      const char msg[] = "xappdemo: window up\n";
      sc3(SYS_write, 1, (long)msg);
    }

    /* sleep ~33ms (timespec {0, 33000000}) */
    long ts[2] = { 0, 33000000L };
    sc6(SYS_nanosleep, (long)ts, 0, 0, 0, 0, 0);

    /* In CI smoke we only need a few frames; exit after a bounded run when
     * BLINK has no input source (so the smoke test terminates). Live in the
     * browser, input keeps arriving and the loop runs until the host stops it. */
#ifdef XAPP_SMOKE_FRAMES
    if (frame >= XAPP_SMOKE_FRAMES) { sc3(SYS_exit, 0, 0, 0); }
#endif
  }
}
