/* fledgling-box: the live audio engine for the Fledgling voice box.
 *
 *   headset mic --> [voice makeup] --> USB gadget "mic" --> phone / computer
 *   headset ear <-- (+ optional sidetone) <-- USB gadget "speaker" <-- phone / computer
 *
 * Each direction runs in its own thread. The headset and the phone run on different clocks,
 * so each path keeps its output buffer at a fixed fill with a tiny adaptive resampler.
 * Control: UDP text commands on 127.0.0.1:9555 (see README), sent by the touch-screen UI.
 *
 * Build: make   (needs libasound2-dev)
 */
#define _GNU_SOURCE
#include "../dsp/fx.h"
#include <alsa/asoundlib.h>
#include <arpa/inet.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static const char *dev_mic = NULL;            /* NULL = first USB headset found (hot-plug friendly) */
static const char *dev_ear = NULL;
static const char *dev_host = "plughw:CARD=UAC2Gadget,DEV=0";
static int rate = 48000, period = 128, ctl_port = 9555, verbose = 0, latency_ms = 0;
static volatile sig_atomic_t quit = 0;

static fx_t *fx;
static pthread_mutex_t fx_lock = PTHREAD_MUTEX_INITIALIZER;
static atomic_int monitor_pct = 0;           /* sidetone: hear your made-up voice, 0..100 */
static atomic_int talk_ok = 0, listen_ok = 0, xruns = 0;
static atomic_int bypass_on = 0;

/* sidetone ring: talk thread writes processed voice, listen thread mixes it in */
#define ST_N 8192
static float st_buf[ST_N]; static atomic_uint st_w = 0; static unsigned st_r = 0;

static void logm(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap); fputc('\n', stderr);
}

/* ------------------------------------------------------------------ ALSA helpers */
/* First USB audio card that is not our own gadget, e.g. "plughw:CARD=H390,DEV=0". */
static const char *find_headset(void) {
  static char name[64];
  int card = -1;
  while (snd_card_next(&card) == 0 && card >= 0) {
    char hw[16]; snd_ctl_t *ctl; snd_ctl_card_info_t *info; snd_ctl_card_info_alloca(&info);
    snprintf(hw, sizeof hw, "hw:%d", card);
    if (snd_ctl_open(&ctl, hw, 0) < 0) continue;
    int ok = snd_ctl_card_info(ctl, info) == 0 && !strcmp(snd_ctl_card_info_get_driver(info), "USB-Audio");
    if (ok) snprintf(name, sizeof name, "plughw:CARD=%s,DEV=0", snd_ctl_card_info_get_id(info));
    snd_ctl_close(ctl);
    if (ok) return name;
  }
  return NULL;
}

static snd_pcm_t *open_pcm(const char *name, snd_pcm_stream_t dir, int ch, int buf_periods) {
  snd_pcm_t *p;
  if (snd_pcm_open(&p, name, dir, 0) < 0) return NULL;
  snd_pcm_hw_params_t *hw; snd_pcm_hw_params_alloca(&hw);
  snd_pcm_hw_params_any(p, hw);
  unsigned r = rate; snd_pcm_uframes_t per = period, buf = (snd_pcm_uframes_t)period * buf_periods;
  if (snd_pcm_hw_params_set_access(p, hw, SND_PCM_ACCESS_RW_INTERLEAVED) < 0 ||
      snd_pcm_hw_params_set_format(p, hw, SND_PCM_FORMAT_FLOAT_LE) < 0 ||
      snd_pcm_hw_params_set_channels(p, hw, ch) < 0 ||
      snd_pcm_hw_params_set_rate_near(p, hw, &r, 0) < 0 ||
      snd_pcm_hw_params_set_period_size_near(p, hw, &per, 0) < 0 ||
      snd_pcm_hw_params_set_buffer_size_near(p, hw, &buf) < 0 ||
      snd_pcm_hw_params(p, hw) < 0) { snd_pcm_close(p); return NULL; }
  if (verbose) logm("opened %s %s: %u Hz, %d ch, period %lu, buffer %lu", name,
    dir == SND_PCM_STREAM_CAPTURE ? "capture" : "playback", r, ch, (unsigned long)per, (unsigned long)buf);
  return p;
}

/* Read exactly n frames (blocking, recovers from overruns). Returns 0 on success. */
static int read_frames(snd_pcm_t *p, float *buf, int n, int ch) {
  int got = 0;
  while (got < n && !quit) {
    if (snd_pcm_wait(p, 200) == 0) return -2;   /* nothing arriving (host not streaming) */
    snd_pcm_sframes_t r = snd_pcm_readi(p, buf + got * ch, n - got);
    if (r == -EAGAIN) continue;
    if (r < 0) { atomic_fetch_add(&xruns, 1); if (snd_pcm_recover(p, (int)r, 1) < 0) return -1; snd_pcm_start(p); continue; }
    got += (int)r;
  }
  return 0;
}

/* Clock-drift follower: linear-interpolating resampler whose ratio nudges the playback
 * fill level toward a target (in frames). */
typedef struct { double pos, ratio, integ; float last[2]; int ch; } drift_t;
static int drift_run(drift_t *d, const float *in, int n, float *out, int maxout, long fill, long target) {
  double err = (double)(fill - target) / target;          /* + = too full: consume input faster */
  d->integ += err * 1e-5; if (d->integ > 0.003) d->integ = 0.003; if (d->integ < -0.003) d->integ = -0.003;
  d->ratio = 1.0 + d->integ + err * 2e-3;
  if (d->ratio > 1.005) d->ratio = 1.005;
  if (d->ratio < 0.995) d->ratio = 0.995;
  int m = 0;
  while (m < maxout) {
    int i = (int)floor(d->pos); double f = d->pos - i;
    if (i >= n) break;
    for (int c = 0; c < d->ch; c++) {
      float a = i == 0 ? d->last[c] : in[(i - 1) * d->ch + c], b = in[i * d->ch + c];
      out[m * d->ch + c] = (float)(a + (b - a) * f);
    }
    m++; d->pos += d->ratio;
  }
  d->pos -= n;
  for (int c = 0; c < d->ch; c++) d->last[c] = in[(n - 1) * d->ch + c];
  return m;
}

/* ------------------------------------------------------------------ talk: mic -> effect -> host */
static void *talk_thread(void *arg) {
  (void)arg;
  float in[4096], fxo[4096], rs[4096 * 2];
  while (!quit) {
    const char *mic_name = dev_mic ? dev_mic : find_headset();
    snd_pcm_t *mic = mic_name ? open_pcm(mic_name, SND_PCM_STREAM_CAPTURE, 1, 4) : NULL;
    snd_pcm_t *out = mic ? open_pcm(dev_host, SND_PCM_STREAM_PLAYBACK, 1, 8) : NULL;
    if (!mic || !out) {
      if (mic) snd_pcm_close(mic);
      atomic_store(&talk_ok, 0); sleep(1); continue;    /* headset or phone not plugged in yet */
    }
    logm("talk path up: %s -> %s", mic_name, dev_host);
    atomic_store(&talk_ok, 1);
    drift_t d = { .ratio = 1, .ch = 1 };
    long target = period * 3;
    static float z[4096]; snd_pcm_writei(out, z, target);   /* prime */
    snd_pcm_start(mic);
    while (!quit) {
      int r = read_frames(mic, in, period, 1);
      if (r == -1) break;
      if (r == -2) memset(in, 0, sizeof(float) * period);
      pthread_mutex_lock(&fx_lock); fx_process(fx, in, fxo, period); pthread_mutex_unlock(&fx_lock);
      /* sidetone copy */
      unsigned w = atomic_load(&st_w);
      for (int i = 0; i < period; i++) st_buf[(w + i) & (ST_N - 1)] = fxo[i];
      atomic_store(&st_w, w + period);
      snd_pcm_sframes_t delay = 0;
      if (snd_pcm_delay(out, &delay) < 0) delay = target;
      int m = drift_run(&d, fxo, period, rs, 4096, delay, target);
      int off = 0;
      while (off < m && !quit) {
        snd_pcm_sframes_t k = snd_pcm_writei(out, rs + off, m - off);
        if (k == -EAGAIN) continue;
        if (k < 0) { atomic_fetch_add(&xruns, 1); if (snd_pcm_recover(out, (int)k, 1) < 0) goto reopen; snd_pcm_writei(out, z, target); continue; }
        off += (int)k;
      }
    }
reopen:
    atomic_store(&talk_ok, 0);
    snd_pcm_close(mic); snd_pcm_close(out);
    if (!quit) { logm("talk path lost, retrying"); sleep(1); }
  }
  return NULL;
}

/* ------------------------------------------------------------------ listen: host -> headset (+ sidetone) */
static void *listen_thread(void *arg) {
  (void)arg;
  float in[4096 * 2], rs[4096 * 2];
  while (!quit) {
    snd_pcm_t *src = open_pcm(dev_host, SND_PCM_STREAM_CAPTURE, 2, 4);
    const char *ear_name = dev_ear ? dev_ear : find_headset();
    snd_pcm_t *ear = src && ear_name ? open_pcm(ear_name, SND_PCM_STREAM_PLAYBACK, 2, 8) : NULL;
    if (!src || !ear) { if (src) snd_pcm_close(src); atomic_store(&listen_ok, 0); sleep(1); continue; }
    logm("listen path up: %s -> %s", dev_host, ear_name);
    atomic_store(&listen_ok, 1);
    drift_t d = { .ratio = 1, .ch = 2 };
    long target = period * 3;
    static float z[4096 * 2]; snd_pcm_writei(ear, z, target);
    snd_pcm_start(src);
    st_r = atomic_load(&st_w);
    while (!quit) {
      int r = read_frames(src, in, period, 2);
      if (r == -1) break;
      if (r == -2) memset(in, 0, sizeof(float) * period * 2);   /* phone silent: keep sidetone going */
      float mon = atomic_load(&monitor_pct) / 100.f;
      unsigned w = atomic_load(&st_w);
      if (w - st_r > ST_N / 2) st_r = w - period;                /* resync if far behind */
      for (int i = 0; i < period; i++) {
        float s = 0;
        if (st_r != w) { s = st_buf[st_r & (ST_N - 1)]; st_r++; }
        in[2 * i] += mon * s; in[2 * i + 1] += mon * s;
      }
      snd_pcm_sframes_t delay = 0;
      if (snd_pcm_delay(ear, &delay) < 0) delay = target;
      int m = drift_run(&d, in, period, rs, 4096, delay, target);
      int off = 0;
      while (off < m && !quit) {
        snd_pcm_sframes_t k = snd_pcm_writei(ear, rs + off * 2, m - off);
        if (k == -EAGAIN) continue;
        if (k < 0) { atomic_fetch_add(&xruns, 1); if (snd_pcm_recover(ear, (int)k, 1) < 0) goto reopen; snd_pcm_writei(ear, z, target); continue; }
        off += (int)k;
      }
    }
reopen:
    atomic_store(&listen_ok, 0);
    snd_pcm_close(src); snd_pcm_close(ear);
    if (!quit) { logm("listen path lost, retrying"); sleep(1); }
  }
  return NULL;
}

/* ------------------------------------------------------------------ control (UDP, localhost) */
static void handle(char *cmd, char *reply, size_t rn) {
  float a, c, t, g; int v; char word[16];
  reply[0] = 0;
  pthread_mutex_lock(&fx_lock);
  if (sscanf(cmd, "looks %f %f %f %f", &a, &c, &t, &g) == 4) { fx_set_looks(fx, a, c, t, g); snprintf(reply, rn, "ok"); }
  else if (sscanf(cmd, "bypass %d", &v) == 1) { fx_set_bypass(fx, v); atomic_store(&bypass_on, v); snprintf(reply, rn, "ok"); }
  else if (sscanf(cmd, "monitor %d", &v) == 1) { atomic_store(&monitor_pct, v < 0 ? 0 : v > 100 ? 100 : v); snprintf(reply, rn, "ok"); }
  else if (sscanf(cmd, "voice %15s", word) == 1) {
    fx_set_voice(fx, !strcmp(word, "low") ? FX_VOICE_LOW : !strcmp(word, "high") ? FX_VOICE_HIGH : FX_VOICE_AUTO);
    snprintf(reply, rn, "ok");
  } else if (!strncmp(cmd, "stat", 4)) {
    fx_stats s; fx_params p; fx_get_stats(fx, &s); fx_get_params(fx, &p);
    snprintf(reply, rn, "f0=%.0f median=%.0f in=%.1f out=%.1f voice=%s talk=%d listen=%d xruns=%d latency_ms=%.1f "
      "pitch=%.2f size=%.1f wobble=%.0f clarity=%.1f presence=%.1f bypass=%d monitor=%d",
      s.f0, s.f0_median, s.in_db, s.out_db, s.voice == FX_VOICE_HIGH ? "high" : "low",
      atomic_load(&talk_ok), atomic_load(&listen_ok), atomic_load(&xruns),
      1000.0 * (fx_latency(fx) + 4 * period) / rate,
      p.pitch_st, p.formant_pct, p.wobble_pct, p.clarity_db, p.presence_db, atomic_load(&bypass_on), atomic_load(&monitor_pct));
  } else snprintf(reply, rn, "error: unknown command");
  pthread_mutex_unlock(&fx_lock);
}

static void *control_thread(void *arg) {
  (void)arg;
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(ctl_port) };
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("control bind"); return NULL; }
  struct timeval tv = { 0, 300000 }; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  char buf[256], reply[512];
  while (!quit) {
    struct sockaddr_in from; socklen_t fl = sizeof from;
    ssize_t n = recvfrom(s, buf, sizeof buf - 1, 0, (struct sockaddr *)&from, &fl);
    if (n <= 0) continue;
    buf[n] = 0; handle(buf, reply, sizeof reply);
    sendto(s, reply, strlen(reply), 0, (struct sockaddr *)&from, fl);
  }
  close(s);
  return NULL;
}

static void on_sig(int s) { (void)s; quit = 1; }

int main(int argc, char **argv) {
  float looks[4] = { 50, 40, 30, 0 };
  for (int i = 1; i < argc; i++) {
    const char *k = argv[i], *v = i + 1 < argc ? argv[i + 1] : "";
    if (!strcmp(k, "--mic")) { dev_mic = v; i++; }
    else if (!strcmp(k, "--ear")) { dev_ear = v; i++; }
    else if (!strcmp(k, "--host")) { dev_host = v; i++; }
    else if (!strcmp(k, "--rate")) { rate = atoi(v); i++; }
    else if (!strcmp(k, "--period")) { period = atoi(v); i++; }
    else if (!strcmp(k, "--latency")) { latency_ms = atoi(v); i++; }
    else if (!strcmp(k, "--port")) { ctl_port = atoi(v); i++; }
    else if (!strcmp(k, "--looks")) { sscanf(v, "%f,%f,%f,%f", &looks[0], &looks[1], &looks[2], &looks[3]); i++; }
    else if (!strcmp(k, "-v")) verbose = 1;
    else {
      fprintf(stderr, "usage: fledgling-box [--mic DEV] [--ear DEV] [--host DEV] [--rate 48000] [--period 128]\n"
        "                     [--latency MS] [--looks age,conf,tone,gender] [--port 9555] [-v]\n"
        "  list devices with: arecord -L / aplay -L (use the plughw:CARD=... names)\n");
      return 1;
    }
  }
  if (period > 1024) period = 1024;
  signal(SIGINT, on_sig); signal(SIGTERM, on_sig);
  fx = fx_create(rate, latency_ms);
  fx_set_looks(fx, looks[0], looks[1], looks[2], looks[3]);
  logm("fledgling-box: %d Hz, period %d, effect latency %.1f ms", rate, period, 1000.0 * fx_latency(fx) / rate);
  pthread_t t1, t2, t3;
  pthread_create(&t3, NULL, control_thread, NULL);
  pthread_create(&t1, NULL, talk_thread, NULL);
  pthread_create(&t2, NULL, listen_thread, NULL);
  /* real-time priority for the audio threads when allowed (systemd unit grants it) */
  struct sched_param sp = { .sched_priority = 70 };
  pthread_setschedparam(t1, SCHED_FIFO, &sp); pthread_setschedparam(t2, SCHED_FIFO, &sp);
  pthread_join(t1, NULL); pthread_join(t2, NULL); pthread_join(t3, NULL);
  fx_destroy(fx);
  return 0;
}
