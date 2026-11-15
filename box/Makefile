# Fledgling live voice box. On the Pi:  sudo apt install build-essential libasound2-dev libsodium-dev && make
# The licence public key comes from $(KEY) (made by `licence/make-card init`). Without it the build
# still works, but no licence can ever be valid: the engine stays in 10-minute demo mode.
CFLAGS ?= -O2 -Wall -Wextra
ARCH := $(shell uname -m)
ifeq ($(ARCH),aarch64)
  CFLAGS += -mcpu=native
endif
KEY ?= $(HOME)/.fledgling/licence-public.hex
# static, so the check can't be swapped out with LD_PRELOAD
SODIUM = -Wl,-Bstatic -lsodium -Wl,-Bdynamic
ENGINE_SRC = engine/fledgling-box.c engine/licence.c dsp/fx.c

all: fledgling-box wavfx

engine/licence_key.h: FORCE
	@sh tools/gen-key-header.sh "$(KEY)" engine/licence_key.h

fledgling-box: $(ENGINE_SRC) engine/licence.h engine/licence_key.h dsp/fx.h
	$(CC) $(CFLAGS) -o fledgling-box $(ENGINE_SRC) $(SODIUM) -lasound -lm -lpthread
	strip fledgling-box

licence-test: engine/licence-test.c engine/licence.c engine/licence.h engine/licence_key.h
	$(CC) $(CFLAGS) -DLICENCE_TEST -o licence-test engine/licence-test.c engine/licence.c $(SODIUM)

wavfx: tools/wavfx.c dsp/fx.c dsp/fx.h
	$(CC) $(CFLAGS) -o wavfx tools/wavfx.c dsp/fx.c -lm

clean:
	rm -f fledgling-box wavfx licence-test engine/licence_key.h

.PHONY: all clean FORCE
