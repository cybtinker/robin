/* Fledgling live voice makeup: streaming effect core. See fx.h.
 *
 * Method: time-domain PSOLA (pitch-synchronous overlap-add), which suits a single voice and keeps
 * latency low. No frequency-domain frames, so low male voices stay sharp.
 *  1. pitch: autocorrelation tracker (Boersma) on the last ~43 ms, every 5 ms
 *  2. analysis marks one pitch period apart, each nudged to line up with the previous period
 *  3. each output "grain" is a 2-period slice around a mark, Hann windowed, placed every
 *     period / pitch-ratio (pitch shift that keeps the vocal tract)
 *  4. voice size (formants): the grain is read slightly faster or slower than real time
 *  5. steadiness: output periods follow a smoothed pitch line, so tremor and jitter shrink
 *     (or grow, for "older")
 *  6. clarity: each grain is blended with the previous two periods, which keeps the repeating
 *     voice and averages away breath noise; "breathy" adds shaped noise instead
 *  7. presence EQ, levelling compressor, soft limiter
 * Unvoiced sounds (s, f, pauses) pass through grain by grain with the same latency.
 */
#include "fx.h"
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define PI 3.14159265358979323846
#define TWO_PI 6.28318530717958647692
#define RB 32768            /* ring buffers (samples), power of two */
#define RM (RB - 1)
#define MR 256              /* analysis-mark ring */
#define MM (MR - 1)

typedef struct { float re, im; } cpx;

struct fx {
  int sr, L, Tu;
  float *in, *out, *ws;
  int64_t now;
  /* pitch tracker */
  int PW, PN, hop, hop_cnt; cpx *tw, *buf; int *rev; float *pwin, *pwin_ac;
  float T_cur, voicing, f0, f0_mean_log; int have_mean, voiced_count;
  /* analysis marks */
  double mpos[MR]; float mT[MR], mW[MR], mTs[MR]; unsigned char mv[MR]; int64_t mcount;
  float lT_slow; int last_voiced;
  /* synthesis */
  double ts, phi; int started;
  /* params */
  float looks[4]; int voice_mode, voice_used, direct; fx_params P;
  /* post */
  float b0, b1, b2, a1, a2, z1, z2, pres_set;   /* presence peaking EQ */
  float hp_x, hp_y, br_env;                      /* breath noise */
  float comp_env, comp_gain, lim_env, bypass_g; int bypass;
  float in_pow, out_pow; unsigned rng;
};

static float clampf(float x, float a, float b) { return x < a ? a : x > b ? b : x; }
static float db2lin(float d) { return powf(10.f, d / 20.f); }
static float frand(fx_t *fx) { fx->rng = fx->rng * 1664525u + 1013904223u; return (fx->rng >> 8) * (1.0f / 16777216.0f) * 2.f - 1.f; }

/* ------------------------------------------------------------------ FFT (pitch tracker only) */
static void fft(fx_t *fx, cpx *a, int inv) {
  int n = fx->PN;
  for (int i = 0; i < n; i++) { int j = fx->rev[i]; if (j > i) { cpx t = a[i]; a[i] = a[j]; a[j] = t; } }
  for (int len = 2; len <= n; len <<= 1) {
    int half = len >> 1, step = n / len;
    for (int i = 0; i < n; i += len)
      for (int k = 0; k < half; k++) {
        cpx w = fx->tw[k * step]; if (inv) w.im = -w.im;
        cpx u = a[i + k], v = a[i + k + half];
        cpx t = { v.re * w.re - v.im * w.im, v.re * w.im + v.im * w.re };
        a[i + k].re = u.re + t.re; a[i + k].im = u.im + t.im;
        a[i + k + half].re = u.re - t.re; a[i + k + half].im = u.im - t.im;
      }
  }
}

/* ------------------------------------------------------------------ looks -> params (port of app.js base()) */
static void looks_to_params(fx_t *fx) {
  const float BOOST = 3.f, Kk = BOOST / 1.6f;
  int fem = fx->voice_used == FX_VOICE_HIGH;
  float a = fx->looks[0] / 100.f, c = fx->looks[1] / 100.f, k = fx->looks[2] / 100.f, g = fx->looks[3] / 100.f;
  /* "typical" 50s -> 20s change from the app's Common Voice table, x3 and capped as in the app */
  float Tp = fem ? 2.4f : 1.1f, Tf = 5.1f, Tw = fem ? -10.f : -16.f, Tc = fem ? 0.2f : 1.3f;
  float pitch = 0, formant = 0, wobble = 0, clarity = 0, presence = 0;
  if (a > 0) {
    pitch += a * clampf(BOOST * Tp, -3, fem ? 2.5f : 3); formant += a * clampf(BOOST * Tf, -8, fem ? 6 : 10);
    wobble += BOOST * a * Tw; clarity += BOOST * a * Tc; presence += 1.5f * a;
  }
  if (a < 0) { float s = -a * Kk; pitch -= 1.5f * s; formant -= 6 * s; wobble += 40 * s; clarity -= 2.5f * s; presence -= 1.0f * s; }
  wobble += Kk * (c >= 0 ? -45 * c : -60 * c); clarity += Kk * 2 * c;   /* confident: steadier, less breathy */
  clarity += Kk * (k >= 0 ? 3 * k : 4 * k);                              /* clear / breathy */
  float gk = g > 0 ? (fem ? 0.35f : 1) : (fem ? 1 : 0.35f);
  pitch += gk * Kk * 4 * g; formant += gk * Kk * 10 * g;                 /* feminine: higher, smaller */
  presence += 4.f * c + 1.5f * k;                                        /* live-only: forward / soft */
  fx->P.pitch_st = clampf(pitch, -12, fem ? 5 : 12);
  fx->P.formant_pct = clampf(formant, -20, fem ? 12 : 25);
  fx->P.wobble_pct = clampf(wobble, -90, 150);
  fx->P.clarity_db = clampf(clarity, -10, 10);
  fx->P.presence_db = clampf(presence, -8, 8);
  fx->P.comp = c > 0 ? c : 0;
  fx->P.gain_db = c < 0 ? 3.f * c : 0;
}

/* ------------------------------------------------------------------ create */
fx_t *fx_create(int sr, int latency_ms) {
  fx_t *fx = calloc(1, sizeof *fx);
  if (!fx) return NULL;
  fx->sr = sr;
  fx->L = (int)(sr * (latency_ms > 0 ? latency_ms : 21) / 1000.0);
  fx->Tu = sr / 250;                                  /* 4 ms grains when unvoiced */
  fx->in = calloc(RB, sizeof(float)); fx->out = calloc(RB, sizeof(float)); fx->ws = calloc(RB, sizeof(float));
  fx->PW = 256; while (fx->PW * 1000 < sr * 40) fx->PW <<= 1;  /* >= 40 ms: 3 periods of a 75 Hz voice */
  fx->PN = 2 * fx->PW; fx->hop = sr / 200;
  int PN = fx->PN, PW = fx->PW;
  fx->tw = malloc(sizeof(cpx) * PN); fx->buf = malloc(sizeof(cpx) * PN); fx->rev = malloc(sizeof(int) * PN);
  for (int i = 0; i < PN; i++) { fx->tw[i].re = (float)cos(TWO_PI * i / PN); fx->tw[i].im = (float)-sin(TWO_PI * i / PN); }
  int bits = 0; while ((1 << bits) < PN) bits++;
  for (int i = 0; i < PN; i++) { int x = i, y = 0; for (int j = 0; j < bits; j++) { y = (y << 1) | (x & 1); x >>= 1; } fx->rev[i] = y; }
  fx->pwin = malloc(sizeof(float) * PW); fx->pwin_ac = malloc(sizeof(float) * PW);
  for (int i = 0; i < PW; i++) fx->pwin[i] = (float)(0.5 - 0.5 * cos(TWO_PI * (i + 0.5) / PW));
  for (int t = 0; t < PW; t++) { double s = 0; for (int i = 0; i + t < PW; i++) s += fx->pwin[i] * fx->pwin[i + t]; fx->pwin_ac[t] = (float)s; }
  for (int t = PW - 1; t >= 0; t--) fx->pwin_ac[t] /= fx->pwin_ac[0];
  fx->T_cur = (float)fx->Tu;
  fx->voice_mode = FX_VOICE_AUTO; fx->voice_used = FX_VOICE_LOW;
  fx->looks[0] = 50; fx->looks[1] = 40; fx->looks[2] = 30; fx->looks[3] = 0;   /* app defaults */
  looks_to_params(fx);
  fx->pres_set = 1e9f; fx->comp_gain = 1; fx->rng = 12345;
  return fx;
}

void fx_destroy(fx_t *fx) {
  if (!fx) return;
  free(fx->in); free(fx->out); free(fx->ws); free(fx->tw); free(fx->buf); free(fx->rev); free(fx->pwin); free(fx->pwin_ac);
  free(fx);
}

int fx_latency(const fx_t *fx) { return fx->L; }
void fx_set_looks(fx_t *fx, float a, float c, float t, float g) {
  fx->looks[0] = clampf(a, -100, 100); fx->looks[1] = clampf(c, -100, 100);
  fx->looks[2] = clampf(t, -100, 100); fx->looks[3] = clampf(g, -100, 100);
  fx->direct = 0; looks_to_params(fx);
}
void fx_set_voice(fx_t *fx, int v) {
  fx->voice_mode = v;
  if (v != FX_VOICE_AUTO) fx->voice_used = v;
  if (!fx->direct) looks_to_params(fx);
}
void fx_set_params(fx_t *fx, const fx_params *p) { fx->P = *p; fx->direct = 1; }
void fx_get_params(const fx_t *fx, fx_params *p) { *p = fx->P; }
void fx_set_bypass(fx_t *fx, int on) { fx->bypass = on; }
void fx_get_stats(const fx_t *fx, fx_stats *s) {
  s->f0 = fx->f0; s->f0_median = fx->have_mean ? expf(fx->f0_mean_log) : 0;
  s->in_db = 10 * log10f(fx->in_pow + 1e-12f); s->out_db = 10 * log10f(fx->out_pow + 1e-12f);
  s->voice = fx->voice_used;
}

/* ------------------------------------------------------------------ pitch tracker */
static void track_pitch(fx_t *fx) {
  int PW = fx->PW, PN = fx->PN; cpx *a = fx->buf; double e = 0;
  int64_t start = fx->now - PW;
  for (int i = 0; i < PW; i++) { float x = fx->in[(start + i) & RM]; e += x * x; a[i].re = x * fx->pwin[i]; a[i].im = 0; }
  for (int i = PW; i < PN; i++) a[i].re = a[i].im = 0;
  float best = 0, T = 0;
  if (e / PW > 1e-7) {                                /* below about -70 dBFS counts as silence */
    fft(fx, a, 0);
    for (int i = 0; i < PN; i++) { a[i].re = a[i].re * a[i].re + a[i].im * a[i].im; a[i].im = 0; }
    fft(fx, a, 1);
    float r0 = a[0].re;
    int tmin = fx->sr / 600, tmax = fx->sr / 65; if (tmax > PW / 3) tmax = PW / 3;
    float gmax = 0;
    for (int t = tmin; t <= tmax; t++) { float r = a[t].re / (r0 * fx->pwin_ac[t]); if (r > gmax) gmax = r; }
    for (int t = tmin + 1; t < tmax; t++) {           /* first strong peak wins: avoids octave-down errors */
      float r = a[t].re / (r0 * fx->pwin_ac[t]), rl = a[t - 1].re / (r0 * fx->pwin_ac[t - 1]), rr = a[t + 1].re / (r0 * fx->pwin_ac[t + 1]);
      if (r >= rl && r >= rr && r > 0.88f * gmax) {
        float d = rl - 2 * r + rr, off = d < 0 ? 0.5f * (rl - rr) / d : 0;
        best = r; T = t + off; break;
      }
    }
  }
  if (T > 0 && best > 0.5f) {
    fx->T_cur = T; fx->voicing = best; fx->f0 = fx->sr / T;
    float lf = logf(fx->f0), dt = (float)fx->hop / fx->sr;
    if (!fx->have_mean) { fx->f0_mean_log = lf; fx->have_mean = 1; }
    else fx->f0_mean_log += (1 - expf(-dt / 3.f)) * (lf - fx->f0_mean_log);
    if (fx->voice_mode == FX_VOICE_AUTO && ++fx->voiced_count > 40) {
      float m = expf(fx->f0_mean_log); int v = fx->voice_used;
      if (m > 200) v = FX_VOICE_HIGH; else if (m < 180) v = FX_VOICE_LOW;
      if (v != fx->voice_used) { fx->voice_used = v; if (!fx->direct) looks_to_params(fx); }
    }
  } else { fx->voicing = 0; fx->f0 = 0; }
}

/* linear-interpolated read of the input ring at a fractional position */
static inline float rd(const fx_t *fx, double p) {
  int64_t i = (int64_t)floor(p); float f = (float)(p - i);
  return fx->in[i & RM] * (1 - f) + fx->in[(i + 1) & RM] * f;
}

/* ------------------------------------------------------------------ analysis marks */
static void make_marks(fx_t *fx) {
  float alpha = 1.f + fx->P.formant_pct / 100.f;
  for (;;) {
    int voiced = fx->voicing > 0.5f;
    float T = voiced ? fx->T_cur : (float)fx->Tu;
    double last = fx->mcount ? fx->mpos[(fx->mcount - 1) & MM] : (double)fx->PW;
    int prev_v = fx->mcount ? fx->mv[(fx->mcount - 1) & MM] : 0;
    double cand = fx->mcount ? last + T : last;
    int search = (voiced && prev_v) ? (int)(T / 6) : 0;
    float cap = (fx->L - T / 6 - 16) / (1.f + 1.f / alpha);
    float W = T < cap ? T : cap;
    if (cand + W + search + 2 >= (double)fx->now) break;
    if (search) {                                       /* line this period up with the previous one */
      int half = (int)(T / 2), bs = 0; double bc = -1e30, ci = floor(cand), li = floor(last);
      for (int s = -search; s <= search; s++) {
        double c = 0;
        for (int n = -half; n < half; n += 2) c += fx->in[(int64_t)(li + n) & RM] * fx->in[(int64_t)(ci + s + n) & RM];
        if (c > bc) { bc = c; bs = s; }
      }
      cand = ci + bs;
    }
    int64_t j = fx->mcount & MM;
    float lT = logf(T);
    if (voiced && fx->last_voiced) fx->lT_slow += (1 - expf(-T / (0.07f * fx->sr))) * (lT - fx->lT_slow);
    else fx->lT_slow = lT;
    fx->last_voiced = voiced;
    fx->mpos[j] = cand; fx->mT[j] = fx->mcount && voiced && prev_v ? (float)(cand - last) : T;
    fx->mW[j] = W; fx->mv[j] = (unsigned char)voiced; fx->mTs[j] = fx->lT_slow;
    fx->mcount++;
  }
}

/* ------------------------------------------------------------------ synthesis */
static void place_grains(fx_t *fx) {
  const fx_params *P = &fx->P;
  float ratio = powf(2.f, P->pitch_st / 12.f), alpha = 1.f + P->formant_pct / 100.f;
  float wob = P->wobble_pct / 100.f, clar = P->clarity_db > 0 ? P->clarity_db / 10.f : 0;
  if (!fx->started) { if (!fx->mcount) return; fx->phi = 0; fx->ts = fx->mpos[0]; fx->started = 1; }
  for (;;) {
    int64_t j = (int64_t)floor(fx->phi);
    if (j >= fx->mcount) break;
    if (j < fx->mcount - MR + 8) { j = fx->mcount - 1; fx->phi = (double)j; }
    int64_t jm = j & MM;
    double pa = fx->mpos[jm];
    int v = fx->mv[jm];
    /* forward spacing when known (exact identity at ratio 1), else backward */
    float Tj = (j + 1 < fx->mcount && fx->mv[(j + 1) & MM] == v) ? (float)(fx->mpos[(j + 1) & MM] - pa) : fx->mT[jm];
    if (Tj < 8) Tj = 8;
    float Tsyn = Tj, r = 1.f;
    if (v) {
      r = ratio;
      if (wob != 0) { float lT = logf(Tj), lS = fx->mTs[jm]; Tsyn = expf(lS + (lT - lS) * clampf(1.f + wob, 0.f, 3.f)); }
    }
    float Tout = Tsyn / r;
    float Win = fx->mW[jm], Wout = Win / alpha;
    double lo = (double)(fx->now - fx->L);              /* earliest output sample still writable */
    if (fx->ts + Wout < lo) fx->ts = lo + Wout;         /* fell behind (should not happen): resync */
    /* clarity: blend in the two previous periods of the same voice */
    float m = 0; double p1 = 0, p2 = 0;
    if (v && clar > 0 && j >= 2 && fx->mv[(j - 1) & MM] && fx->mv[(j - 2) & MM] && fx->voicing > 0.5f) {
      p1 = fx->mpos[(j - 1) & MM]; p2 = fx->mpos[(j - 2) & MM];
      float d1 = (float)(pa - p1), d2 = (float)(p1 - p2);
      if (fabsf(d1 - d2) < 0.12f * Tj && fabsf(d1 - Tj) < 0.2f * Tj) m = clampf(0.6f * clar, 0, 0.6f);
    }
    int64_t c = (int64_t)floor(fx->ts + 0.5);
    int u0 = (int)ceil(-Wout), u1 = (int)floor(Wout);
    for (int u = u0; u <= u1; u++) {
      int64_t o = c + u;
      if ((double)o < lo) continue;
      double off = (o - fx->ts) * alpha;
      float w = (float)(0.5 + 0.5 * cos(PI * (o - fx->ts) / Wout));
      float x = rd(fx, pa + off);
      if (m > 0) x = (1 - m) * x + 0.5f * m * (rd(fx, p1 + off) + rd(fx, p2 + off));
      fx->out[o & RM] += w * x; fx->ws[o & RM] += w;
    }
    fx->ts += Tout;
    fx->phi += Tout / Tj;
    /* keep synthesis time lined up with analysis time on average */
    int64_t j2 = (int64_t)floor(fx->phi);
    if (j2 < fx->mcount) {
      double pa2 = fx->mpos[j2 & MM] + (fx->phi - j2) * fx->mT[j2 & MM];
      fx->phi += clampf((float)((fx->ts - pa2) / fx->mT[j2 & MM]) * 0.05f, -0.2f, 0.2f);
    }
  }
}

/* ------------------------------------------------------------------ streaming */
void fx_process(fx_t *fx, const float *in, float *out, int n) {
  const fx_params *P = &fx->P;
  if (P->presence_db != fx->pres_set) {               /* RBJ peaking EQ at 3.2 kHz, Q 0.8 */
    double A = pow(10, P->presence_db / 40), w0 = TWO_PI * 3200 / fx->sr, al = sin(w0) / (2 * 0.8), a0 = 1 + al / A;
    fx->b0 = (float)((1 + al * A) / a0); fx->b1 = (float)(-2 * cos(w0) / a0); fx->b2 = (float)((1 - al * A) / a0);
    fx->a1 = fx->b1; fx->a2 = (float)((1 - al / A) / a0); fx->pres_set = P->presence_db;
  }
  float g_out = db2lin(P->gain_db), breath = P->clarity_db < 0 ? -P->clarity_db / 10.f : 0;
  float ratio = 1.f + 3.f * P->comp, thr = -30.f, makeup = 6.f * P->comp;
  float a_env = 1 - expf(-1.f / (0.010f * fx->sr));
  float a_att = 1 - expf(-1.f / (0.003f * fx->sr)), a_rel = 1 - expf(-1.f / (0.120f * fx->sr));
  float a_lim = 1 - expf(-1.f / (0.060f * fx->sr)), a_byp = 1 - expf(-1.f / (0.015f * fx->sr));
  float a_meter = 1 - expf(-1.f / (0.100f * fx->sr)), a_hp = expf(-TWO_PI * 1500.f / fx->sr);
  for (int i = 0; i < n; i++) {
    float x = in[i];
    fx->in[fx->now & RM] = x; fx->now++;
    if (++fx->hop_cnt >= fx->hop && fx->now >= fx->PW) { fx->hop_cnt = 0; track_pitch(fx); }
    make_marks(fx);
    place_grains(fx);
    int64_t o = fx->now - fx->L;
    float y = 0, d = 0;
    if (o >= 0) {
      float w = fx->ws[o & RM];
      y = fx->out[o & RM] / (w > 0.25f ? w : 0.25f);
      fx->out[o & RM] = 0; fx->ws[o & RM] = 0;
      d = fx->in[o & RM];
    }
    /* breathy: high-passed noise that follows the voice level */
    if (breath > 0) {
      float nz = frand(fx), hp = a_hp * (fx->hp_y + nz - fx->hp_x); fx->hp_x = nz; fx->hp_y = hp;
      fx->br_env += a_env * (fabsf(y) - fx->br_env);
      y = y * (1 - 0.25f * breath) + hp * fx->br_env * 0.9f * breath;
    }
    /* presence */
    float e = fx->b0 * y + fx->z1; fx->z1 = fx->b1 * y - fx->a1 * e + fx->z2; fx->z2 = fx->b2 * y - fx->a2 * e; y = e;
    /* levelling compressor (confident) */
    fx->comp_env += a_env * (y * y - fx->comp_env);
    float target = 1;
    if (P->comp > 0) {
      float lvl = 10 * log10f(fx->comp_env + 1e-10f);
      float gdb = lvl > thr ? (thr + (lvl - thr) / ratio - lvl) : 0;
      if (lvl < -60) gdb -= makeup;                     /* don't lift background noise in pauses */
      target = db2lin(gdb + makeup);
    }
    fx->comp_gain += (target < fx->comp_gain ? a_att : a_rel) * (target - fx->comp_gain);
    y *= fx->comp_gain * g_out;
    /* soft limiter */
    float ay = fabsf(y);
    if (ay > fx->lim_env) fx->lim_env = ay; else fx->lim_env += a_lim * (ay - fx->lim_env);
    if (fx->lim_env > 0.89f) y *= 0.89f / fx->lim_env;
    /* bypass crossfade, same latency */
    fx->bypass_g += a_byp * ((fx->bypass ? 1.f : 0.f) - fx->bypass_g);
    y = y * (1 - fx->bypass_g) + d * fx->bypass_g;
    if (y > 1) y = 1; else if (y < -1) y = -1;
    fx->in_pow += a_meter * (x * x - fx->in_pow); fx->out_pow += a_meter * (y * y - fx->out_pow);
    out[i] = y;
  }
}
