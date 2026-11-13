/* Offline test of the live effect: wavfx in.wav out.wav [--age 50 --conf 40 --tone 30 --gender 0]
 *   [--voice auto|low|high] [--latency 21] [--block 128] [--pitch st --formant pct --wobble pct --clarity db]
 * Processes in small blocks exactly as the box does, then prints the real-time factor. */
#include "../dsp/fx.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static float *read_wav(const char *path, int *sr, int *n) {
  FILE *f = fopen(path, "rb"); if (!f) { perror(path); exit(1); }
  unsigned char h[12]; if (fread(h, 1, 12, f) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) { fprintf(stderr, "not a wav\n"); exit(1); }
  int fmt = 0, ch = 0, bits = 0; float *out = NULL;
  for (;;) {
    unsigned char c[8]; if (fread(c, 1, 8, f) != 8) break;
    uint32_t len = c[4] | c[5] << 8 | c[6] << 16 | (uint32_t)c[7] << 24;
    unsigned char *d = malloc(len + 1); if (fread(d, 1, len, f) != len) { free(d); break; }
    if (len & 1) fgetc(f);
    if (!memcmp(c, "fmt ", 4)) { fmt = d[0] | d[1] << 8; ch = d[2] | d[3] << 8; *sr = d[4] | d[5] << 8 | d[6] << 16 | d[7] << 24; bits = d[14] | d[15] << 8;
      if (fmt == 0xFFFE) fmt = d[24] | d[25] << 8; }
    else if (!memcmp(c, "data", 4)) {
      int bps = bits / 8; *n = len / (bps * ch); out = malloc(sizeof(float) * *n);
      for (int i = 0; i < *n; i++) {
        float s = 0;
        for (int k = 0; k < ch; k++) {
          unsigned char *p = d + (i * ch + k) * bps;
          if (fmt == 3 && bits == 32) { float v; memcpy(&v, p, 4); s += v; }
          else if (bits == 16) s += (int16_t)(p[0] | p[1] << 8) / 32768.f;
          else if (bits == 24) s += ((int32_t)(p[0] << 8 | p[1] << 16 | (uint32_t)p[2] << 24) >> 8) / 8388608.f;
          else if (bits == 32) s += (int32_t)(p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24) / 2147483648.f;
        }
        out[i] = s / ch;
      }
      free(d); break;
    }
    free(d);
  }
  fclose(f); if (!out) { fprintf(stderr, "no data\n"); exit(1); }
  return out;
}

static void w32(FILE *f, uint32_t v) { fputc(v, f); fputc(v >> 8, f); fputc(v >> 16, f); fputc(v >> 24, f); }
static void write_wav(const char *path, const float *x, int n, int sr) {
  FILE *f = fopen(path, "wb"); if (!f) { perror(path); exit(1); }
  fwrite("RIFF", 1, 4, f); w32(f, 36 + n * 2); fwrite("WAVEfmt ", 1, 8, f); w32(f, 16);
  fputc(1, f); fputc(0, f); fputc(1, f); fputc(0, f); w32(f, sr); w32(f, sr * 2); fputc(2, f); fputc(0, f); fputc(16, f); fputc(0, f);
  fwrite("data", 1, 4, f); w32(f, n * 2);
  for (int i = 0; i < n; i++) { float v = x[i] * 32767.f; if (v > 32767) v = 32767; if (v < -32768) v = -32768; int16_t s = (int16_t)v; fwrite(&s, 2, 1, f); }
  fclose(f);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: wavfx in.wav out.wav [options]\n"); return 1; }
  float age = 50, conf = 40, tone = 30, gender = 0; int voice = FX_VOICE_AUTO, frame = 0, block = 128, direct = 0;
  fx_params P = { 0 };
  for (int i = 3; i + 1 < argc; i += 2) {
    const char *k = argv[i], *v = argv[i + 1];
    if (!strcmp(k, "--age")) age = atof(v); else if (!strcmp(k, "--conf")) conf = atof(v);
    else if (!strcmp(k, "--tone")) tone = atof(v); else if (!strcmp(k, "--gender")) gender = atof(v);
    else if (!strcmp(k, "--voice")) voice = !strcmp(v, "low") ? FX_VOICE_LOW : !strcmp(v, "high") ? FX_VOICE_HIGH : FX_VOICE_AUTO;
    else if (!strcmp(k, "--latency")) frame = atoi(v); else if (!strcmp(k, "--block")) block = atoi(v);
    else if (!strcmp(k, "--pitch")) { P.pitch_st = atof(v); direct = 1; }
    else if (!strcmp(k, "--formant")) { P.formant_pct = atof(v); direct = 1; }
    else if (!strcmp(k, "--wobble")) { P.wobble_pct = atof(v); direct = 1; }
    else if (!strcmp(k, "--clarity")) { P.clarity_db = atof(v); direct = 1; }
    else { fprintf(stderr, "unknown option %s\n", k); return 1; }
  }
  int sr = 0, n = 0; float *x = read_wav(argv[1], &sr, &n);
  fx_t *fx = fx_create(sr, frame);
  fx_set_voice(fx, voice); fx_set_looks(fx, age, conf, tone, gender);
  if (direct) fx_set_params(fx, &P);
  int lat = fx_latency(fx), total = n + lat;
  float *y = calloc(total, sizeof(float)), *xin = calloc(total, sizeof(float));
  memcpy(xin, x, sizeof(float) * n);
  struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
  for (int i = 0; i < total; i += block) fx_process(fx, xin + i, y + i, i + block <= total ? block : total - i);
  clock_gettime(CLOCK_MONOTONIC, &t1);
  double sec = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9, dur = (double)n / sr;
  fx_stats s; fx_get_stats(fx, &s); fx_get_params(fx, &P);
  write_wav(argv[2], y + lat, n, sr);
  fprintf(stderr, "%s: %.2f s audio, %.3f s cpu (%.1f%% of one core), latency %.1f ms, voice %s (median %.0f Hz)\n"
    "  pitch %+.1f st, size %+.1f%%, wobble %+.0f%%, clarity %+.1f dB, presence %+.1f dB, level %.2f\n",
    argv[2], dur, sec, 100 * sec / dur, 1000.0 * lat / sr, s.voice == FX_VOICE_HIGH ? "high" : "low", s.f0_median,
    P.pitch_st, P.formant_pct, P.wobble_pct, P.clarity_db, P.presence_db, P.comp);
  fx_destroy(fx); free(x); free(y); free(xin);
  return 0;
}
