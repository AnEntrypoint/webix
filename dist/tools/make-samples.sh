#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
as --32 samples/cat_data.S -o samples/cat_data.o
ld -m elf_i386 -nostdlib -o samples/cat_data.elf samples/cat_data.o
rm samples/cat_data.o
printf 'built samples/cat_data.elf\n'
