/* Single-writer, single-reader audio ring with clock-drift correction on the reader side.
 * The mic and the output device run on different clocks (e.g. a USB mic and VB-CABLE), so the
 * reader resamples by a tiny ratio (at most +-0.5 %) that keeps the buffer near its target fill.
 * Header-only, no allocation after ring_init, safe for one capture and one playback thread. */
#ifndef FLEDGLING_RING_H
#define FLEDGLING_RING_H
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RING_SIZE 65536 /* samples, power of two (1.4 s at 48 kHz) */

typedef struct {
  float buf[RING_SIZE];
  _Atomic int64_t w;     /* total samples written (writer) */
  _Atomic int reset;     /* set by the controller to make the reader start over */
  /* reader only */
  double r, ratio, fill_avg;
  int64_t prime_at;
  int primed, target, min_target, max_target, sr;
  _Atomic int underruns, target_now;
} ring_t;

static inline void ring_init(ring_t *q, int sr, int target) {
  memset(q->buf, 0, sizeof q->buf);
  atomic_store(&q->w, 0); atomic_store(&q->reset, 0);
  q->r = 0; q->ratio = 1; q->fill_avg = target; q->primed = 0; q->prime_at = target;
  q->sr = sr; q->target = q->min_target = target; q->max_target = sr / 8; /* 125 ms */
  atomic_store(&q->underruns, 0); atomic_store(&q->target_now, target);
}

static inline void ring_write(ring_t *q, const float *x, int n) {
  int64_t w = atomic_load_explicit(&q->w, memory_order_relaxed);
  for (int i = 0; i < n; i++) q->buf[(w + i) & (RING_SIZE - 1)] = x[i];
  atomic_store_explicit(&q->w, w + n, memory_order_release);
}

/* Fills out[0..n) and never blocks. Returns the number of real (non-silent) samples. */
static inline int ring_read(ring_t *q, float *out, int n) {
  int64_t w = atomic_load_explicit(&q->w, memory_order_acquire);
  if (atomic_exchange(&q->reset, 0)) { q->primed = 0; q->prime_at = w + q->target; }
  if (!q->primed) {
    if (w < q->prime_at) { memset(out, 0, sizeof(float) * n); return 0; } /* wait until there is enough */
    q->r = (double)(w - q->target); q->fill_avg = q->target; q->ratio = 1; q->primed = 1;
  }
  double fill = (double)w - q->r;
  if (fill > q->target + q->sr / 10) {                       /* far behind (e.g. after a stall): jump */
    q->r = (double)(w - q->target); fill = q->target; q->fill_avg = fill;
  }
  /* smoothed fill, ~0.25 s time constant; correction pulls back over ~2 s */
  double a = (double)n / (0.25 * q->sr); if (a > 1) a = 1;
  q->fill_avg += a * (fill - q->fill_avg);
  double want = 1.0 + (q->fill_avg - q->target) / (2.0 * q->sr);
  if (want > 1.005) want = 1.005;
  if (want < 0.995) want = 0.995;
  q->ratio = want;
  for (int i = 0; i < n; i++) {
    int64_t i0 = (int64_t)q->r;
    if (i0 + 1 >= w) {                                        /* ran dry: silence, then refill a bit deeper */
      memset(out + i, 0, sizeof(float) * (n - i));
      q->primed = 0; atomic_fetch_add(&q->underruns, 1);
      q->target += q->sr / 500; if (q->target > q->max_target) q->target = q->max_target;
      q->prime_at = w + q->target;
      atomic_store(&q->target_now, q->target);
      return i;
    }
    float f = (float)(q->r - (double)i0);
    float x0 = q->buf[i0 & (RING_SIZE - 1)], x1 = q->buf[(i0 + 1) & (RING_SIZE - 1)];
    out[i] = x0 + f * (x1 - x0);
    q->r += q->ratio;
  }
  return n;
}
#endif
