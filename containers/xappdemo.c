/* xappdemo: in-guest GUI "app" for the blinkenlib framebuffer (render-once).
 *
 * The in-guest display producer. A static x86_64 freestanding ELF that:
 *   1. mmaps an 800x600 RGBA framebuffer,
 *   2. drains queued host input via syscall 0x5fc (mouse position + buttons +
 *      a persisted window position carried in the first key event's payload),
 *   3. paints a desktop + a draggable window (title bar + content + cursor),
 *   4. publishes the frame via syscall 0x5fb (blinkenlib_fb_register),
 *   5. writes the new window position to stdout and exits.
 *
 * RENDER-ONCE model: runElf() in the host is synchronous and blocks the JS
 * thread, so a forever-loop GUI app would freeze the page. Instead the host
 * (sandcastle DesktopApp) re-runs this ELF each animation tick, feeding the
 * latest mouse state through the input ring and passing the window's current
 * position via argv, and reads the framebuffer back between runs. Each run is
 * one frame: cheap, bounded, never blocks. The window drag state lives in the
 * host across frames (argv: x y dragging grabx graby).
 *
 * Raw syscalls only; built static + freestanding in CI.
 *
 * Input event layout (matches blinkenlib.c), 16 bytes:
 *   { u16 type; u16 code; i32 x; i32 y; i32 value; u32 _pad }
 *   type 1=key 2=motion 3=button; button value 1=down/0=up.
 */
#include <stdint.h>

#define SYS_write       1
#define SYS_exit        60
#define SYS_mmap        9
#define SYS_fb_register 0x5fb
#define SYS_input_read  0x5fc

#define W 800
#define H 600
#define STRIDE (W * 4)
#define TITLE_H 28
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

static uint8_t *fb;
static inline void px(int x, int y, uint32_t c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  *(uint32_t *)(fb + (long)y * STRIDE + (long)x * 4) = c;
}
static void fill(int x0, int y0, int w, int h, uint32_t c) {
  for (int y = y0; y < y0 + h; y++)
    for (int x = x0; x < x0 + w; x++) px(x, y, c);
}
#define RGBA(r,g,b) ((uint32_t)(r) | ((uint32_t)(g)<<8) | ((uint32_t)(b)<<16) | 0xff000000u)

/* parse a non-negative int from a NUL/space-terminated arg; returns -1 on '-' */
static int atoi_arg(const char *s) {
  if (!s || !*s) return 0;
  int neg = 0, v = 0;
  if (*s == '-') { neg = 1; s++; }
  while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); s++; }
  return neg ? -v : v;
}
/* write a signed int to buf, return chars written */
static int itoa_buf(char *buf, int v) {
  int p = 0; char tmp[12]; int t = 0;
  if (v < 0) { buf[p++] = '-'; v = -v; }
  if (v == 0) tmp[t++] = '0';
  while (v) { tmp[t++] = (char)('0' + v % 10); v /= 10; }
  while (t) buf[p++] = tmp[--t];
  return p;
}

/* Freestanding entry: a naked _start captures the SysV stack pointer (which
 * points exactly at [argc] at process entry, before any prologue mangles rsp)
 * and tail-calls main(argc, argv). Doing the rsp read inside a normal C
 * function is unreliable because the compiler emits a prologue first. */
__attribute__((naked, used)) void _start(void) {
  __asm__ volatile(
      "mov (%rsp), %rdi\n"      /* argc */
      "lea 8(%rsp), %rsi\n"     /* &argv[0] */
      "and $-16, %rsp\n"        /* 16-byte align for the call */
      "call xappdemo_main\n"
      "mov $60, %rax\n"          /* SYS_exit if main returns */
      "xor %rdi, %rdi\n"
      "syscall\n");
}

void xappdemo_main(long argc, char **argv) {
  /* argv: progname x y dragging grabx graby  (defaults if absent) */
  int wx = argc > 1 ? atoi_arg(argv[1]) : 220;
  int wy = argc > 2 ? atoi_arg(argv[2]) : 150;
  int dragging = argc > 3 ? atoi_arg(argv[3]) : 0;
  int grabx = argc > 4 ? atoi_arg(argv[4]) : 0;
  int graby = argc > 5 ? atoi_arg(argv[5]) : 0;
  const int ww = 360, wh = 240;

  long len = (long)STRIDE * H;
  long mret = sc6(SYS_mmap, 0, len, 3, 0x22, -1, 0);
  /* mmap returns the mapping addr on success, or -errno (small negative) on
   * failure. Treat the top of the address space (>= -4095) as an error. */
  if (mret >= -4095L && mret < 0) sc6(SYS_exit, 2, 0, 0, 0, 0, 0);
  fb = (uint8_t *)mret;

  /* ---- drain input: latest motion + button transitions ---- */
  uint8_t evbuf[MAXEV * EVSZ];
  int mx = -1, my = -1, mdown = -1;
  long n = sc6(SYS_input_read, (long)evbuf, MAXEV, 0, 0, 0, 0);
  for (long i = 0; i < n; i++) {
    uint8_t *e = evbuf + i * EVSZ;
    uint16_t type; int32_t ex, ey, val;
    __builtin_memcpy(&type, e + 0, 2);
    __builtin_memcpy(&ex, e + 4, 4);
    __builtin_memcpy(&ey, e + 8, 4);
    __builtin_memcpy(&val, e + 12, 4);
    if (type == 2) { mx = ex; my = ey; }
    else if (type == 3) { mdown = val; if (mx < 0) { mx = ex; my = ey; } }
  }

  /* ---- update window drag state ---- */
  if (mdown == 1 && !dragging && mx >= 0) {
    if (mx >= wx && mx < wx + ww && my >= wy && my < wy + TITLE_H) {
      dragging = 1; grabx = mx - wx; graby = my - wy;
    }
  } else if (mdown == 0) {
    dragging = 0;
  }
  if (dragging && mx >= 0) { wx = mx - grabx; wy = my - graby; }

  /* ---- paint ---- */
  for (int y = 0; y < H; y++) {
    uint32_t c = RGBA(20 + y * 30 / H, 30 + y * 50 / H, 60 + y * 80 / H);
    for (int x = 0; x < W; x++) *(uint32_t *)(fb + (long)y * STRIDE + (long)x * 4) = c;
  }
  fill(wx + 6, wy + 6, ww, wh, RGBA(0,0,0));            /* shadow */
  fill(wx, wy, ww, wh, RGBA(235,235,238));              /* body */
  fill(wx, wy, ww, TITLE_H, RGBA(40,90,200));           /* title bar */
  for (int i = 0; i < 6; i++) fill(wx + 12 + i*8, wy + 11, 5, 7, RGBA(240,240,240)); /* "text" */
  fill(wx + ww - 22, wy + 8, 12, 12, RGBA(220,70,70));  /* close box */
  fill(wx + 24, wy + TITLE_H + 24, ww - 48, 44, RGBA(120,170,120)); /* content panel */
  fill(wx + 40, wy + TITLE_H + 96, 64, 64, RGBA(200,150,60));       /* content block */
  if (mx >= 0) fill(mx, my, 8, 8, RGBA(255,255,0));     /* cursor */

  /* publish frame */
  sc6(SYS_fb_register, (long)fb, W, H, STRIDE, 0, 0);

  /* emit new window state + a self-readback of the title-bar pixel (so the host
   * can tell whether the guest's own paint landed): "x y drag gx gy | r g b\n" */
  uint8_t *tbp = fb + (long)158 * STRIDE + (long)240 * 4;
  char out[96]; int p = 0;
  p += itoa_buf(out + p, wx); out[p++] = ' ';
  p += itoa_buf(out + p, wy); out[p++] = ' ';
  p += itoa_buf(out + p, dragging); out[p++] = ' ';
  p += itoa_buf(out + p, grabx); out[p++] = ' ';
  p += itoa_buf(out + p, graby);
  out[p++] = ' '; out[p++] = '|'; out[p++] = ' ';
  p += itoa_buf(out + p, tbp[0]); out[p++] = ' ';
  p += itoa_buf(out + p, tbp[1]); out[p++] = ' ';
  p += itoa_buf(out + p, tbp[2]); out[p++] = '\n';
  sc6(SYS_write, 1, (long)out, p, 0, 0, 0);

  sc6(SYS_exit, 0, 0, 0, 0, 0, 0);
}
