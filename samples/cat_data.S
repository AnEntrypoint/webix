.intel_syntax noprefix
.global _start
.section .text
_start:
  mov eax, 5          # open(path, O_RDONLY)
  mov ebx, offset path
  xor ecx, ecx
  int 0x80
  mov esi, eax        # save fd

  mov eax, 3          # read(fd, buf, 4096)
  mov ebx, esi
  mov ecx, offset buf
  mov edx, 4096
  int 0x80
  mov edi, eax        # bytes read

  mov eax, 4          # write(1, buf, n)
  mov ebx, 1
  mov ecx, offset buf
  mov edx, edi
  int 0x80

  mov eax, 6          # close(fd)
  mov ebx, esi
  int 0x80

  mov eax, 1          # exit(0)
  xor ebx, ebx
  int 0x80
.section .rodata
path:
  .asciz "/data/message.txt"
.section .bss
.lcomm buf, 4096
