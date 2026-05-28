/* inputtest: minimal guest consumer of the blinkenlib input device.
 * Drains queued input events via the synthetic syscall 0x5fc into a local
 * buffer, prints how many it got and the first event's fields, and exits with
 * the event count. The host pushes events via blinkenlib_push_input() BEFORE
 * runElf (the ring buffer holds them); the guest drains them on start. This
 * proves the host->guest input path end-to-end.
 *
 * Packed event layout (must match blinkenlib.c):
 *   struct { u16 type; u16 code; i32 x; i32 y; i32 value; u32 _pad; } // 16B
 *
 * Built static x86_64 in CI. Raw syscalls only (no libc).
 */
#include <stdint.h>

#define SYS_write       1
#define SYS_exit        60
#define SYS_input_read  0x5fc

#define MAXEV 32
#define EVSZ  16

static long syscall3(long n, long a, long b, long c) {
  long ret;
  __asm__ volatile("syscall" : "=a"(ret)
                   : "a"(n), "D"(a), "S"(b), "d"(c)
                   : "rcx", "r11", "memory");
  return ret;
}

/* tiny unsigned-int -> decimal, appended to buf at *pos */
static void putu(char *buf, int *pos, unsigned v) {
  char tmp[12]; int t = 0;
  if (v == 0) tmp[t++] = '0';
  while (v) { tmp[t++] = (char)('0' + v % 10); v /= 10; }
  while (t) buf[(*pos)++] = tmp[--t];
}

void _start(void) {
  static uint8_t evbuf[MAXEV * EVSZ];
  long n = syscall3(SYS_input_read, (long)evbuf, MAXEV, 0);
  if (n < 0) n = 0;

  char out[128]; int p = 0;
  const char pre[] = "input: n=";
  for (int i = 0; pre[i]; i++) out[p++] = pre[i];
  putu(out, &p, (unsigned)n);

  if (n > 0) {
    uint16_t type, code; int32_t value;
    __builtin_memcpy(&type, evbuf + 0, 2);
    __builtin_memcpy(&code, evbuf + 2, 2);
    __builtin_memcpy(&value, evbuf + 12, 4);
    const char s1[] = " type="; for (int i = 0; s1[i]; i++) out[p++] = s1[i];
    putu(out, &p, type);
    const char s2[] = " code="; for (int i = 0; s2[i]; i++) out[p++] = s2[i];
    putu(out, &p, code);
    const char s3[] = " value="; for (int i = 0; s3[i]; i++) out[p++] = s3[i];
    putu(out, &p, (unsigned)value);
  }
  out[p++] = '\n';
  syscall3(SYS_write, 1, (long)out, p);

  syscall3(SYS_exit, (long)n, 0, 0);  /* exit code = events drained */
}
