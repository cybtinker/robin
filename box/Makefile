# Fledgling live voice box. On the Pi:  sudo apt install build-essential libasound2-dev && make
CFLAGS ?= -O2 -Wall -Wextra
ARCH := $(shell uname -m)
ifeq ($(ARCH),aarch64)
  CFLAGS += -mcpu=native
endif

all: fledgling-box wavfx

fledgling-box: engine/fledgling-box.c dsp/fx.c dsp/fx.h
	$(CC) $(CFLAGS) -o $@ engine/fledgling-box.c dsp/fx.c -lasound -lm -lpthread

wavfx: tools/wavfx.c dsp/fx.c dsp/fx.h
	$(CC) $(CFLAGS) -o $@ tools/wavfx.c dsp/fx.c -lm

clean:
	rm -f fledgling-box wavfx

.PHONY: all clean
