/* fbtest: minimal in-guest display producer for the blinkenlib framebuffer
 * pipeline. mmaps an RGBA buffer, paints a deterministic gradient, then
 * publishes it to the host via the synthetic syscall 0x5fb
 * (blinkenlib_fb_register: vaddr, width, height, stride). The JS host reads
 * the geometry through blinkenlib_get_fb_* and maps the pixels zero-copy via
 * blinkenlib_spy_address(vaddr). This is the smallest end-to-end proof that a
 * guest program can drive the canvas; the real fbdev X server does the same
 * thing at scale.
 *
 * Built static x86_64 in CI (the runner's native gcc emits exactly the ELF
 * Blink executes). No libc framebuffer assumptions: we raw-syscall everything.
 */
#include <stdint.h>

#define SYS_mmap   9
#define SYS_write  1
#define SYS_exit   60
#define SYS_fb     0x5fb   /* blinkenlib_fb_register */

#define W 320
#define H 240
#define STRIDE (W * 4)

static long syscall6(long n, long a, long b, long c, long d, long e, long f) {
  long ret;
  register long r10 __asm__("r10") = d;
  register long r8  __asm__("r8")  = e;
  register long r9  __asm__("r9")  = f;
  __asm__ volatile("syscall"
                   : "=a"(ret)
                   : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
                   : "rcx", "r11", "memory");
  return ret;
}

void _start(void) {
  /* PROT_READ|PROT_WRITE=3, MAP_PRIVATE|MAP_ANONYMOUS=0x22 */
  long len = (long)STRIDE * H;
  uint8_t *fb = (uint8_t *)syscall6(SYS_mmap, 0, len, 3, 0x22, -1, 0);
  if ((long)fb < 0) syscall6(SYS_exit, 1, 0, 0, 0, 0, 0);

  /* Deterministic gradient: R=x, G=y, B=x^y, A=255. Guarantees the host's
   * getImageData is non-uniform (the witness assertion). */
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      uint8_t *p = fb + (long)y * STRIDE + (long)x * 4;
      p[0] = (uint8_t)(x & 0xff);
      p[1] = (uint8_t)(y & 0xff);
      p[2] = (uint8_t)((x ^ y) & 0xff);
      p[3] = 0xff;
    }
  }

  /* Publish to the host. */
  syscall6(SYS_fb, (long)fb, W, H, STRIDE, 0, 0);

  /* Emit a marker on stdout so the smoke test can also assert via stdout. */
  const char msg[] = "fbtest: registered 320x240 gradient\n";
  syscall6(SYS_write, 1, (long)msg, sizeof(msg) - 1, 0, 0, 0);

  syscall6(SYS_exit, 42, 0, 0, 0, 0, 0);
}
