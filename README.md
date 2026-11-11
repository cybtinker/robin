# Fledgling — on-device proof of concept (step 3)

(Called Younger Voice until poc-4; renamed Fledgling on 2026-11-11.)

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

## Languages and age estimate (poc-3, 2026-11-11)
- i18n.js: English, 한국어, 日本語, 中文, Français, Español. Picker in the header; first visit follows the phone language, the choice is remembered on the device.
- The pad draws rough age contour lines (every 10 years). Weights follow published voice-aging trends, scaled to the 2026-11-10 blind test; not fitted to data.
- After reading a take, the app guesses its age (voicecore.guessAge: loudness flutter + spectral tilt, least-squares fit to the one-listener blind-test ratings of 12 clips, RMSE ~6 years on those clips). The thick green line is that age. Unscientific: expect 10+ years of error on new voices.
- Grey corners on the pad: unlikely mixes (high pitch with low formants, or low pitch with high formants). Likely band: pitch = 0.2 st per 1 % formant, ±1.25 st.

## Myna icon, themes, research log (poc-4, 2026-11-11)
- Myna app icon (icon.svg, icon-180/192/512.png), drawn for this project.
- Theme picker: Automatic, Bright, Dark, Spring, Summer, Fall, Winter, Thanksgiving, Christmas (tokens + a small ornament strip per theme). Remembered on the device.
- Research log (research.js), opt-in, off by default, no accounts or servers: each take and each try is added to a CSV kept on the phone (IndexedDB) with a random device ID, plus 24 kHz WAVs. "Send research log" shares one .zip (log.csv + audio/) through the phone's share sheet. Not kept: name, email, IP, location, file names. log.csv columns: created_at, device_id, take_id, try_id, original_age_guess, duration_s, f0_median, source, direction, pitch_st, formant_pct, texture, est_delta_years, est_age, lang, app_version, original_audio, try_audio, cues.

## Simpler screen (poc-6, 2026-11-11)
- Main screen is just Sing → Age → Listen. Noise reduction, research log, speed table and credits sit under "More".
- Small (i) buttons pop up a one-paragraph explanation (recording, pad, age guess, texture, cues, research).
- Live notes while sliding: the pad shows years younger and the age you'd sound; texture shows the years it adds; each cue shows its own share in years (vibrato 25 %, the other five 15 % each of the texture effect).
- "Send research log" first opens a review dialog listing every row and audio file (playable) and the raw log.csv; nothing is shared until "Looks fine, send it".

## Licences
WORLD: modified BSD (keep WORLD-LICENSE.txt with the app). All other code is project code. No GPL.

## Ideas to speed it up later
Read the voice in parallel workers (one per chunk); DIO instead of Harvest for pitch (much faster, slightly less robust); native build of the same C++ for an App Store version.

## poc-7
- Research log: "Include my voice recordings" on/off (in More and on the check-before-sending screen). Off = no audio is saved or sent, only the numbers in log.csv. "Remove my audio" deletes stored recordings and keeps the numbers.
- Language: new "Automatic" choice (the default) follows the phone/browser language; picking a language pins it.
- Theme: new "By date" choice (the default) picks spring/summer/fall/winter, Thanksgiving week or Christmas (Dec 1–26) from today's date.
