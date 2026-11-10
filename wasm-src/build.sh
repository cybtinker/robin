#!/bin/sh
# Rebuild world.wasm with plain clang (no Emscripten). Needs clang + wasm-ld (LLVM 18 tested)
# and the WORLD sources, e.g. from the pyworld 0.3.5 sdist: lib/World/src
set -e
W=${1:?usage: build.sh path/to/World/src}
cd "$(dirname "$0")"
FL="--target=wasm32 -O3 -nostdlib -nostdinc -ffreestanding -fno-exceptions -fno-rtti -isystem inc -isystem $(clang -print-resource-dir)/include -I$W -msimd128"
for f in $W/common.cpp $W/fft.cpp $W/matlabfunctions.cpp $W/harvest.cpp $W/cheaptrick.cpp $W/d4c.cpp $W/synthesis.cpp $W/dio.cpp $W/stonemask.cpp api.cpp; do
  clang++ $FL -c "$f" -o "$(basename "$f" .cpp).o"; done
clang++ $FL -fno-builtin -c rt.cpp -o rt.o
wasm-ld --no-entry --allow-undefined --strip-all -O3 *.o -o ../world.wasm
rm -f *.o
