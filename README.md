# Younger Voice — on-device proof of concept (step 3)

A web app (PWA) that records a cappella singing, applies the step 2 younger/older effect,
and plays it back. Everything runs on the phone: the WORLD vocoder is compiled to
WebAssembly (84 KB) and rejuvenate.py v2 is ported line by line to JavaScript. After the
first visit it works in airplane mode and can be added to the home screen on iPhone and Android.

## Files
- index.html, app.js — UI: record (max 90 s) or open a file, Younger/Older, a pitch × formant pad (pitch −2…+4 semitones, formant −8…+16 %; default 0 st / +5 %), texture strength (vibrato, roughness, breath, brightness, clarity; default 0.6), per-cue sliders, playback, save/share, speed report
- worker.js — background worker; reads the voice once per take, then re-renders on each setting change. Takes over 20 s are cut into ~15 s chunks at quiet moments (20 ms crossfade).
- voicecore.js — the transform (port of rejuvenate.py) + WORLD wasm wrapper
- world.wasm — WORLD (harvest, cheaptrick, d4c, synthesis), built with wasm-src/build.sh (plain clang, no Emscripten)
- sw.js, manifest.webmanifest, icons — offline cache and home-screen install
- sample.wav — MTG sms-tools-materials singing clip, CC BY 4.0

## Checks (2026-11-10)
- Same input as desktop: younger 0.6 and 1.0 match rejuvenate.py to ~210 dB SNR (bit-identical in practice); through the browser UI incl. 16-bit WAV output: 74 dB SNR.
- Older direction uses random wobble/jitter, so it matches statistically, not sample for sample (numpy's RNG is not reproduced).
- Speed, headless Chrome on a 4-core cloud CPU (about as fast as native pyworld here):
  12.6 s take at 48 kHz: 10 s to read the voice (once per take), 1.4 s per effect render. 50 s take: 27.5 s + 4.3 s.
  Phones: use the in-app "Copy speed report".

## Pitch and formant as two axes (poc-2, 2026-11-11)
Pitch (f0 shift, keeps formants) and formant (vocal-tract stretch, keeps pitch) are set directly on a 2D pad and do
not depend on the strength slider. In voicecore.transform they are the cues `pitch_cents` and `formant_pct`; with
`formant_pct` unset the old strength-scaled formant cue is used, so rejuvenate.py parity is unchanged.

## Licences
WORLD: modified BSD (keep WORLD-LICENSE.txt with the app). All other code is project code. No GPL.

## Ideas to speed it up later
Read the voice in parallel workers (one per chunk); DIO instead of Harvest for pitch (much faster, slightly less robust); native build of the same C++ for an App Store version.
