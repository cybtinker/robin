/* Fledgling live voice makeup: streaming effect core.
 * Portable C99, no dependencies, no allocation after fx_create. Mono float in/out.
 * The same four two-way sliders as the app (-100..100, 0 = off):
 *   age:    Older <-> Younger      conf:   Timid <-> Confident
 *   tone:   Breathy <-> Clear      gender: Masculine <-> Feminine
 */
#ifndef FLEDGLING_FX_H
#define FLEDGLING_FX_H
#ifdef __cplusplus
extern "C" {
#endif

typedef struct fx fx_t;

typedef struct {
  float pitch_st;     /* pitch shift, semitones */
  float formant_pct;  /* voice size: + = smaller (younger/feminine), - = bigger */
  float wobble_pct;   /* pitch wander: -90 = much steadier, +150 = shakier */
  float clarity_db;   /* + = clearer (less breath noise), - = breathier */
  float presence_db;  /* 2-5 kHz lift (confident) or cut (timid) */
  float comp;         /* 0..1 levelling (confident = more even, forward) */
  float gain_db;      /* output trim */
} fx_params;

typedef struct {
  float f0;           /* last pitch in Hz, 0 when unvoiced */
  float f0_median;    /* running typical pitch of the speaker */
  float in_db, out_db;/* levels, dBFS */
  int voice;          /* 1 = low (male) voice, 2 = high (female) voice: the one in use */
} fx_stats;

enum { FX_VOICE_AUTO = 0, FX_VOICE_LOW = 1, FX_VOICE_HIGH = 2 };

/* latency_ms: 0 = default 21 ms. Lower suits high voices; low voices need ~2 pitch periods */
fx_t *fx_create(int sample_rate, int latency_ms);
void fx_destroy(fx_t *fx);
int fx_latency(const fx_t *fx);            /* samples added by the effect */
void fx_set_looks(fx_t *fx, float age, float conf, float tone, float gender);
void fx_set_voice(fx_t *fx, int voice);    /* FX_VOICE_* */
void fx_set_params(fx_t *fx, const fx_params *p); /* direct control (overrides looks) */
void fx_get_params(const fx_t *fx, fx_params *p);
void fx_set_bypass(fx_t *fx, int on);      /* on = dry signal, same latency (no click) */
void fx_process(fx_t *fx, const float *in, float *out, int n); /* any n; in may equal out */
void fx_get_stats(const fx_t *fx, fx_stats *s);

#ifdef __cplusplus
}
#endif
#endif
