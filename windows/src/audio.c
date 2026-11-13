/* Fledgling Live for Windows: audio engine.
 *
 *  mic (WASAPI shared) --capture thread--> fx_process (21 ms PSOLA) --> ring --> virtual mic output
 *                                                                   \-> ring --> headphones ("hear myself")
 *
 * Each output has its own drift-corrected ring (ring.h), because the mic, VB-CABLE and the
 * headphones each run on their own clock. miniaudio converts sample rates and channel counts,
 * so the effect always runs mono at 48 kHz.
 */
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MINIAUDIO_IMPLEMENTATION
#include "../third_party/miniaudio.h"

#include "audio.h"
#include "ring.h"
#include "../../box/dsp/fx.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <windows.h>

#define PERIOD_MS 10

static struct {
  int ctx_ok;
  ma_context ctx;
  ma_device cap, out, mon;
  int cap_ok, out_ok, mon_ok;
  fx_t *fx;
  ring_t *q_out, *q_mon;
  /* settings, written by the UI thread, applied on the audio thread */
  _Atomic int looks[4], voice, bypass, ver;
  _Atomic float mon_gain;
  int applied_ver;
  /* status */
  _Atomic int running, stopping;
  _Atomic float in_pk, out_pk;
  HWND notify_hwnd; UINT notify_msg;
  char error[256];
} E;

static void set_error(const char *what, ma_result r) {
  snprintf(E.error, sizeof E.error, "%s (%s)", what, ma_result_description(r));
}

static int ensure_ctx(void) {
  if (E.ctx_ok) return 1;
  ma_context_config cc = ma_context_config_init();
  ma_backend be[] = { ma_backend_wasapi };
  if (ma_context_init(be, 1, &cc, &E.ctx) != MA_SUCCESS) { snprintf(E.error, sizeof E.error, "Windows audio is not available"); return 0; }
  E.ctx_ok = 1;
  return 1;
}

int eng_list(int capture, eng_dev *out, int max) {
  if (!ensure_ctx()) return 0;
  ma_device_info *pb, *cp; ma_uint32 npb, ncp;
  if (ma_context_get_devices(&E.ctx, &pb, &npb, &cp, &ncp) != MA_SUCCESS) return 0;
  ma_device_info *d = capture ? cp : pb; ma_uint32 n = capture ? ncp : npb;
  int k = 0;
  for (ma_uint32 i = 0; i < n && k < max; i++, k++) {
    snprintf(out[k].name, sizeof out[k].name, "%s", d[i].name);
    out[k].is_default = d[i].isDefault;
  }
  return k;
}

/* Finds a device id by exact name; returns 0 (use default) when name is empty or not found. */
static int find_dev(int capture, const char *name, ma_device_id *id) {
  if (!name || !*name) return 0;
  ma_device_info *pb, *cp; ma_uint32 npb, ncp;
  if (ma_context_get_devices(&E.ctx, &pb, &npb, &cp, &ncp) != MA_SUCCESS) return 0;
  ma_device_info *d = capture ? cp : pb; ma_uint32 n = capture ? ncp : npb;
  for (ma_uint32 i = 0; i < n; i++)
    if (!strcmp(d[i].name, name)) { *id = d[i].id; return 1; }
  return 0;
}

static void apply_settings(void) {
  int v = atomic_load(&E.ver);
  if (v == E.applied_ver) return;
  E.applied_ver = v;
  fx_set_voice(E.fx, atomic_load(&E.voice));
  fx_set_looks(E.fx, (float)atomic_load(&E.looks[0]), (float)atomic_load(&E.looks[1]),
               (float)atomic_load(&E.looks[2]), (float)atomic_load(&E.looks[3]));
  fx_set_bypass(E.fx, atomic_load(&E.bypass));
}

static float peak(const float *x, int n) {
  float p = 0;
  for (int i = 0; i < n; i++) { float a = fabsf(x[i]); if (a > p) p = a; }
  return p;
}

static void on_capture(ma_device *dev, void *out, const void *in, ma_uint32 n) {
  (void)dev; (void)out;
  const float *x = (const float *)in;
  float y[1024];
  apply_settings();
  float pi = peak(x, (int)n), po = 0;
  while (n > 0) {
    int k = n > 1024 ? 1024 : (int)n;
    fx_process(E.fx, x, y, k);
    float p = peak(y, k); if (p > po) po = p;
    ring_write(E.q_out, y, k);
    ring_write(E.q_mon, y, k);
    x += k; n -= (ma_uint32)k;
  }
  /* peak hold with a slow fall, read by the UI */
  float a = atomic_load(&E.in_pk) * 0.9f, b = atomic_load(&E.out_pk) * 0.9f;
  atomic_store(&E.in_pk, pi > a ? pi : a);
  atomic_store(&E.out_pk, po > b ? po : b);
}

static void on_out(ma_device *dev, void *out, const void *in, ma_uint32 n) {
  (void)dev; (void)in;
  ring_read(E.q_out, (float *)out, (int)n);
}

static void on_mon(ma_device *dev, void *out, const void *in, ma_uint32 n) {
  (void)dev; (void)in;
  float *y = (float *)out, g = atomic_load(&E.mon_gain);
  ring_read(E.q_mon, y, (int)n);
  for (ma_uint32 i = 0; i < n; i++) y[i] *= g;
}

static void on_notify(const ma_device_notification *nt) {
  if (nt->type == ma_device_notification_type_stopped && !atomic_load(&E.stopping) && E.notify_hwnd)
    PostMessageW(E.notify_hwnd, E.notify_msg, 0, 0);
}

static int open_dev(ma_device *d, ma_device_type type, const char *name, ma_device_data_proc cb) {
  ma_device_config c = ma_device_config_init(type);
  ma_device_id id; int has = find_dev(type == ma_device_type_capture, name, &id);
  if (type == ma_device_type_capture) {
    c.capture.pDeviceID = has ? &id : NULL; c.capture.format = ma_format_f32; c.capture.channels = 1;
    c.capture.shareMode = ma_share_mode_shared;
  } else {
    c.playback.pDeviceID = has ? &id : NULL; c.playback.format = ma_format_f32; c.playback.channels = 1;
    c.playback.shareMode = ma_share_mode_shared;
  }
  c.sampleRate = ENG_SR;
  c.periodSizeInMilliseconds = PERIOD_MS;
  c.performanceProfile = ma_performance_profile_low_latency;
  c.dataCallback = cb;
  c.notificationCallback = on_notify;
  c.noPreSilencedOutputBuffer = MA_FALSE;
  c.wasapi.noAutoStreamRouting = MA_FALSE;   /* follow Windows default changes when "default" is chosen */
  ma_result r = ma_device_init(&E.ctx, &c, d);
  if (r != MA_SUCCESS) {
    set_error(type == ma_device_type_capture ? "Could not open the microphone" : "Could not open the output", r);
    return 0;
  }
  return 1;
}

static int period_frames(ma_device *d, int capture) {
  ma_uint32 p = capture ? d->capture.internalPeriodSizeInFrames : d->playback.internalPeriodSizeInFrames;
  ma_uint32 sr = capture ? d->capture.internalSampleRate : d->playback.internalSampleRate;
  if (!p || !sr) return ENG_SR / 100;
  return (int)((double)p * ENG_SR / sr + 0.5);
}

int eng_start(const char *mic, const char *out, const char *mon, void *hwnd, unsigned msg) {
  eng_stop();
  E.error[0] = 0;
  if (!ensure_ctx()) return 0;
  E.notify_hwnd = (HWND)hwnd; E.notify_msg = msg;
  if (!E.fx) E.fx = fx_create(ENG_SR, 0);
  if (!E.q_out) E.q_out = (ring_t *)malloc(sizeof(ring_t));
  if (!E.q_mon) E.q_mon = (ring_t *)malloc(sizeof(ring_t));
  if (!E.fx || !E.q_out || !E.q_mon) { snprintf(E.error, sizeof E.error, "Out of memory"); return 0; }
  E.applied_ver = -1;

  if (!(E.cap_ok = open_dev(&E.cap, ma_device_type_capture, mic, on_capture))) return 0;
  if (!(E.out_ok = open_dev(&E.out, ma_device_type_playback, out, on_out))) { eng_stop(); return 0; }
  if (mon) {
    E.mon_ok = open_dev(&E.mon, ma_device_type_playback, mon, on_mon);
    if (!E.mon_ok) E.error[0] = 0;  /* "hear myself" is optional: carry on without it */
  }
  int pc = period_frames(&E.cap, 1);
  /* target fill = one output block + half a mic block + 2 ms of slack; grows by 2 ms per dropout */
  ring_init(E.q_out, ENG_SR, period_frames(&E.out, 0) + pc / 2 + ENG_SR / 500);
  ring_init(E.q_mon, ENG_SR, (E.mon_ok ? period_frames(&E.mon, 0) : pc) + pc / 2 + ENG_SR / 500);

  atomic_store(&E.stopping, 0);
  ma_result r;
  if ((r = ma_device_start(&E.out)) != MA_SUCCESS) { set_error("Could not start the output", r); eng_stop(); return 0; }
  if (E.mon_ok && ma_device_start(&E.mon) != MA_SUCCESS) { ma_device_uninit(&E.mon); E.mon_ok = 0; }
  if ((r = ma_device_start(&E.cap)) != MA_SUCCESS) { set_error("Could not start the microphone", r); eng_stop(); return 0; }
  atomic_store(&E.running, 1);
  return 1;
}

void eng_stop(void) {
  atomic_store(&E.stopping, 1);
  atomic_store(&E.running, 0);
  if (E.cap_ok) { ma_device_uninit(&E.cap); E.cap_ok = 0; }
  if (E.out_ok) { ma_device_uninit(&E.out); E.out_ok = 0; }
  if (E.mon_ok) { ma_device_uninit(&E.mon); E.mon_ok = 0; }
}

void eng_set_looks(int a, int c, int t, int g) {
  atomic_store(&E.looks[0], a); atomic_store(&E.looks[1], c);
  atomic_store(&E.looks[2], t); atomic_store(&E.looks[3], g);
  atomic_fetch_add(&E.ver, 1);
}
void eng_set_voice(int v) { atomic_store(&E.voice, v); atomic_fetch_add(&E.ver, 1); }
void eng_set_bypass(int on) { atomic_store(&E.bypass, on); atomic_fetch_add(&E.ver, 1); }
void eng_set_monitor_gain(float g) { atomic_store(&E.mon_gain, g); }

static float to_db(float p) { return p > 1e-5f ? 20.f * log10f(p) : -100.f; }

void eng_get_status(eng_status *s) {
  memset(s, 0, sizeof *s);
  s->running = atomic_load(&E.running);
  snprintf(s->error, sizeof s->error, "%s", E.error);
  if (!s->running || !E.fx) return;
  fx_stats st; fx_get_stats(E.fx, &st);   /* a torn read here only affects the display */
  s->f0 = st.f0; s->voice = st.voice;
  s->in_db = to_db(atomic_load(&E.in_pk)); s->out_db = to_db(atomic_load(&E.out_pk));
  s->dropouts = atomic_load(&E.q_out->underruns);
  int frames = fx_latency(E.fx) + period_frames(&E.cap, 1) + atomic_load(&E.q_out->target_now)
             + period_frames(&E.out, 0);
  s->latency_ms = frames * 1000.f / ENG_SR;
}
