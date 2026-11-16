# Fledgling Live for Windows. Builds with MinGW-w64, either on Windows (MSYS2) or cross from Linux:
#   sudo apt install gcc-mingw-w64-x86-64 && make
CC      = x86_64-w64-mingw32-gcc
WINDRES = x86_64-w64-mingw32-windres
ifeq ($(OS),Windows_NT)
  CC = gcc
  WINDRES = windres
endif
CFLAGS  = -O2 -std=c11 -Wall -Wextra -Wno-unused-function -municode -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0A00
LDFLAGS = -mwindows -municode -static -s
LIBS    = -lole32 -lcomctl32 -lshell32 -luuid -lavrt -lwinmm -lm

OUT = build/FledglingLive.exe
SRC = src/app.c src/audio.c ../box/dsp/fx.c

all: $(OUT)

build/app.res.o: src/app.rc src/app.manifest src/app.ico src/resource.h
	@mkdir -p build
	$(WINDRES) -I src -O coff src/app.rc $@

$(OUT): $(SRC) src/audio.h src/ring.h ../box/dsp/fx.h build/app.res.o
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $(SRC) build/app.res.o $(LDFLAGS) $(LIBS)

clean:
	rm -rf build

.PHONY: all clean
