/* Fledgling Live for Windows: audio engine (mic -> voice makeup -> virtual mic, plus "hear myself"). */
#ifndef FLEDGLING_AUDIO_H
#define FLEDGLING_AUDIO_H
#ifdef __cplusplus
extern "C" {
#endif

#define ENG_SR 48000

typedef struct { char name[256]; int is_default; } eng_dev;

typedef struct {
  int running;           /* 1 when the mic and output are open */
  float in_db, out_db;   /* recent peak levels, dBFS */
  float f0;              /* current pitch, Hz (0 = not voiced) */
  int voice;             /* 1 low, 2 high: the one the effect is using */
  float latency_ms;      /* estimated mic-to-virtual-mic delay */
  int dropouts;          /* output underruns since start */
  char error[256];       /* last error, empty when fine */
} eng_status;

/* Lists capture (capture=1) or playback devices. Returns the count (at most max). */
int eng_list(int capture, eng_dev *out, int max);

/* Opens the devices by name ("" = Windows default). mon may be NULL for no "hear myself".
 * notify_hwnd gets notify_msg when a device stops on its own (unplugged, format change). */
int eng_start(const char *mic, const char *out, const char *mon, void *notify_hwnd, unsigned notify_msg);
void eng_stop(void);

void eng_set_looks(int age, int conf, int tone, int gender); /* -100..100 each */
void eng_set_voice(int voice);                               /* 0 auto, 1 low, 2 high */
void eng_set_bypass(int on);
void eng_set_monitor_gain(float g);                          /* 0..1 */
void eng_get_status(eng_status *s);

#ifdef __cplusplus
}
#endif
#endif
