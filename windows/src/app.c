/* Fledgling Live for Windows: the window.
 * Plain Win32 (no frameworks), so the whole app is one small .exe with no runtime to install. */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>
#include "audio.h"
#include "resource.h"

#define APP_NAME L"Fledgling Live"
#define WM_DEVLOST (WM_APP + 1)
#define VBCABLE_URL L"https://vb-audio.com/Cable/"

enum {
  ID_MIC = 100, ID_OUT, ID_MON, ID_VOICE, ID_ON, ID_HEAR, ID_RESET, ID_GETCABLE, ID_ABOUT, ID_PRIVACY,
  ID_SLIDER = 200, ID_SVAL = 210, ID_TIMER = 300, ID_RETRY
};

static const struct { const wchar_t *key, *left, *right, *name; int def; } SL[4] = {
  { L"age",    L"Older",     L"Younger",  L"Younger",   50 },
  { L"conf",   L"Timid",     L"Confident",L"Confident", 40 },
  { L"tone",   L"Breathy",   L"Clear",    L"Clear",     30 },
  { L"gender", L"Masculine", L"Feminine", L"Feminine",   0 },
};

static HINSTANCE hinst;
static HWND hwnd, hMic, hOut, hMon, hVoice, hOn, hHear, hHint, hCableNote, hGetCable, hStatus, hMeter, hPrivacy;
static HWND hSl[4], hSv[4];
static HFONT fNormal, fTitle, fSmall, fBold;
static HBRUSH bgBrush, noteBrush;
static int dpi = 96;
static wchar_t ini[MAX_PATH];
static int looks[4], voice, makeup_on = 1, hear = 0;
static float meter_in = -100, meter_out = -100;
static int has_cable;

#define S(x) MulDiv((x), dpi, 96)
#define COL_BG RGB(255, 255, 255)
#define COL_NOTE RGB(255, 246, 220)
#define COL_INK RGB(30, 30, 40)
#define COL_MUTED RGB(100, 104, 115)
#define COL_ACCENT RGB(40, 140, 120)

/* ---------------------------------------------------------------- UTF-8 <-> UTF-16 */
static void to_w(const char *s, wchar_t *w, int n) { MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n); }
static void to_u8(const wchar_t *w, char *s, int n) { WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL); }

/* ---------------------------------------------------------------- settings (%APPDATA%\Fledgling Live\settings.ini) */
static void ini_path(void) {
  wchar_t base[MAX_PATH];
  if (SHGetFolderPathW(NULL, CSIDL_APPDATA, NULL, 0, base) != S_OK) { ini[0] = 0; return; }
  swprintf(ini, MAX_PATH, L"%ls\\Fledgling Live", base);
  CreateDirectoryW(ini, NULL);
  wcscat(ini, L"\\settings.ini");
}
static int get_i(const wchar_t *k, int d) { return ini[0] ? (int)GetPrivateProfileIntW(L"live", k, d, ini) : d; }
static void put_i(const wchar_t *k, int v) {
  if (!ini[0]) return;
  wchar_t b[16]; swprintf(b, 16, L"%d", v); WritePrivateProfileStringW(L"live", k, b, ini);
}
static void get_s(const wchar_t *k, wchar_t *v, int n) { v[0] = 0; if (ini[0]) GetPrivateProfileStringW(L"live", k, L"", v, n, ini); }
static void put_s(const wchar_t *k, const wchar_t *v) { if (ini[0]) WritePrivateProfileStringW(L"live", k, v, ini); }

/* ---------------------------------------------------------------- device lists */
static int is_virtual_mic_output(const wchar_t *n) {
  /* playback side of a virtual cable: whatever is played here comes out of its "microphone" */
  return wcsstr(n, L"CABLE Input") || wcsstr(n, L"CABLE-A Input") || wcsstr(n, L"CABLE-B Input") ||
         wcsstr(n, L"VoiceMeeter Input") || wcsstr(n, L"Voicemeeter Input") || wcsstr(n, L"Virtual Audio Cable") ||
         wcsstr(n, L"Line 1 (Virtual");
}
static int is_virtual_mic_input(const wchar_t *n) { return wcsstr(n, L"CABLE") && wcsstr(n, L"Output"); }

/* Fills a combo box. first = optional first item (e.g. "Windows default"). Keeps want selected if present. */
static void fill_combo(HWND cb, int capture, const wchar_t *first, const wchar_t *want, int prefer_cable) {
  static eng_dev d[64];
  int n = eng_list(capture, d, 64);
  SendMessageW(cb, CB_RESETCONTENT, 0, 0);
  if (first) SendMessageW(cb, CB_ADDSTRING, 0, (LPARAM)first);
  int sel = -1, cable = -1, nonvirt = -1;
  for (int i = 0; i < n; i++) {
    wchar_t w[256]; to_w(d[i].name, w, 256);
    int idx = (int)SendMessageW(cb, CB_ADDSTRING, 0, (LPARAM)w);
    if (want && *want && !wcscmp(want, w)) sel = idx;
    if (cable < 0 && is_virtual_mic_output(w)) cable = idx;
    if (nonvirt < 0 && !wcsstr(w, L"CABLE")) nonvirt = idx;
  }
  if (!capture && !first) has_cable = cable >= 0;
  if (sel < 0) sel = prefer_cable ? (cable >= 0 ? cable : (n ? 0 : -1)) : (first ? 0 : nonvirt);
  SendMessageW(cb, CB_SETCURSEL, sel, 0);
}

static void combo_text(HWND cb, wchar_t *w, int n) {
  int i = (int)SendMessageW(cb, CB_GETCURSEL, 0, 0);
  w[0] = 0;
  if (i <= 0 && (cb == hMic || cb == hMon)) return;    /* item 0 = Windows default */
  if (i < 0) return;
  if (SendMessageW(cb, CB_GETLBTEXTLEN, i, 0) < n) SendMessageW(cb, CB_GETLBTEXT, i, (LPARAM)w);
}

/* ---------------------------------------------------------------- UI text */
static void slider_text(int i) {
  wchar_t b[64]; int v = looks[i];
  if (v == 0) swprintf(b, 64, L"off");
  else swprintf(b, 64, L"%ls %d", v > 0 ? SL[i].right : SL[i].left, v > 0 ? v : -v);
  SetWindowTextW(hSv[i], b);
}

static void update_hint(void) {
  wchar_t out[256]; combo_text(hOut, out, 256);
  ShowWindow(hCableNote, has_cable ? SW_HIDE : SW_SHOW);
  ShowWindow(hGetCable, has_cable ? SW_HIDE : SW_SHOW);
  ShowWindow(hHint, has_cable ? SW_SHOW : SW_HIDE);
  if (has_cable) {
    wchar_t h[512];
    if (wcsstr(out, L"CABLE"))
      swprintf(h, 512, L"In Zoom, Teams, Discord or Meet, pick \x201C" L"CABLE Output (VB-Audio Virtual Cable)\x201D as the microphone.");
    else
      swprintf(h, 512, L"In your call app, pick the microphone side of \x201C%ls\x201D.", out);
    SetWindowTextW(hHint, h);
  }
}

/* ---------------------------------------------------------------- engine control */
static void push_settings(void) {
  eng_set_looks(looks[0], looks[1], looks[2], looks[3]);
  eng_set_voice(voice);
  eng_set_bypass(!makeup_on);
  eng_set_monitor_gain(hear ? 1.f : 0.f);
}

static void start_audio(void) {
  wchar_t wm[256], wo[256], wh[256]; char m[512], o[512], h[512];
  combo_text(hMic, wm, 256); combo_text(hOut, wo, 256); combo_text(hMon, wh, 256);
  to_u8(wm, m, 512); to_u8(wo, o, 512); to_u8(wh, h, 512);
  push_settings();
  KillTimer(hwnd, ID_RETRY);
  ShowWindow(hPrivacy, SW_HIDE);
  if (!wo[0]) { eng_stop(); SetWindowTextW(hStatus, L"No output device found."); return; }
  if (wm[0] && is_virtual_mic_input(wm)) {
    eng_stop();
    SetWindowTextW(hStatus, L"Pick your real microphone, not the CABLE one (that would loop back).");
    return;
  }
  if (!eng_start(m, o, hear ? h : NULL, hwnd, WM_DEVLOST)) {
    eng_status st; eng_get_status(&st);
    wchar_t e[300]; to_w(st.error, e, 300);
    wchar_t b[400]; swprintf(b, 400, L"%ls. Check the device, or Windows Settings \x2192 Privacy \x2192 Microphone.", e);
    SetWindowTextW(hStatus, b);
    ShowWindow(hPrivacy, SW_SHOW);
    SetTimer(hwnd, ID_RETRY, 3000, NULL);
  }
}

static void save_devices(void) {
  wchar_t w[256];
  combo_text(hMic, w, 256); put_s(L"mic", w);
  combo_text(hOut, w, 256); put_s(L"out", w);
  combo_text(hMon, w, 256); put_s(L"monitor", w);
}

/* ---------------------------------------------------------------- level meter */
static void paint_meter(HDC dc, RECT rc) {
  HBRUSH back = CreateSolidBrush(RGB(236, 238, 242)), in = CreateSolidBrush(RGB(160, 170, 185)),
         out = CreateSolidBrush(COL_ACCENT), hot = CreateSolidBrush(RGB(214, 90, 60));
  FillRect(dc, &rc, bgBrush);
  int h = (rc.bottom - rc.top - S(4)) / 2, w = rc.right - rc.left;
  float lv[2] = { meter_in, meter_out };
  for (int k = 0; k < 2; k++) {
    RECT r = { rc.left, rc.top + k * (h + S(4)), rc.right, rc.top + k * (h + S(4)) + h };
    FillRect(dc, &r, back);
    float f = (lv[k] + 60.f) / 60.f; if (f < 0) f = 0; if (f > 1) f = 1;
    RECT b = r; b.right = r.left + (int)(f * w);
    FillRect(dc, &b, lv[k] > -1.f ? hot : (k ? out : in));
  }
  DeleteObject(back); DeleteObject(in); DeleteObject(out); DeleteObject(hot);
}

static LRESULT CALLBACK meter_proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_PAINT) {
    PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps); RECT rc; GetClientRect(h, &rc);
    paint_meter(dc, rc); EndPaint(h, &ps); return 0;
  }
  if (m == WM_ERASEBKGND) return 1;
  return DefWindowProcW(h, m, w, l);
}

/* ---------------------------------------------------------------- layout */
static HWND mk(const wchar_t *cls, const wchar_t *txt, DWORD style, int x, int y, int w, int h, int id, HFONT f) {
  HWND c = CreateWindowExW(0, cls, txt, WS_CHILD | WS_VISIBLE | style, S(x), S(y), S(w), S(h), hwnd,
                           (HMENU)(INT_PTR)id, hinst, NULL);
  SendMessageW(c, WM_SETFONT, (WPARAM)f, TRUE);
  return c;
}

static HFONT font(int pt, int weight) {
  return CreateFontW(-MulDiv(pt, dpi, 72), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
}

#define W 460
static void build(void) {
  int x = 20, cw = W - 40, y = 14;
  mk(L"STATIC", APP_NAME, SS_LEFT, x, y, 260, 32, 0, fTitle);
  mk(L"STATIC", L"Live voice makeup for calls", SS_LEFT, x, y + 32, 260, 20, 0, fSmall);
  mk(L"BUTTON", L"About", BS_PUSHBUTTON | WS_TABSTOP, W - 20 - 70, y + 6, 70, 26, ID_ABOUT, fNormal);
  y += 66;

  mk(L"STATIC", L"Microphone", SS_LEFT, x, y + 4, 90, 20, 0, fNormal);
  hMic = mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, x + 92, y, cw - 92, 300, ID_MIC, fNormal);
  y += 34;
  mk(L"STATIC", L"Send to", SS_LEFT, x, y + 4, 90, 20, 0, fNormal);
  hOut = mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, x + 92, y, cw - 92, 300, ID_OUT, fNormal);
  y += 34;
  hHint = mk(L"STATIC", L"", SS_LEFT, x + 92, y, cw - 92, 36, 0, fSmall);
  hCableNote = mk(L"STATIC", L"No virtual microphone found. Install the free VB-CABLE driver, restart your PC, then open Fledgling Live again.",
                  SS_LEFT, x, y, cw - 120, 40, 0, fSmall);
  hGetCable = mk(L"BUTTON", L"Get VB-CABLE", BS_PUSHBUTTON | WS_TABSTOP, W - 20 - 110, y + 4, 110, 28, ID_GETCABLE, fNormal);
  y += 50;

  for (int i = 0; i < 4; i++) {
    mk(L"STATIC", SL[i].left, SS_LEFT, x, y, 120, 20, 0, fNormal);
    hSv[i] = mk(L"STATIC", L"", SS_CENTER, x + 120, y, cw - 240, 20, ID_SVAL + i, fBold);
    mk(L"STATIC", SL[i].right, SS_RIGHT, W - 20 - 120, y, 120, 20, 0, fNormal);
    hSl[i] = mk(TRACKBAR_CLASSW, L"", TBS_HORZ | TBS_AUTOTICKS | TBS_BOTTOM | WS_TABSTOP, x - 6, y + 20, cw + 12, 32,
                ID_SLIDER + i, fNormal);
    SendMessageW(hSl[i], TBM_SETRANGE, TRUE, MAKELPARAM(0, 200));
    SendMessageW(hSl[i], TBM_SETTICFREQ, 50, 0);
    SendMessageW(hSl[i], TBM_SETPAGESIZE, 0, 10);
    SendMessageW(hSl[i], TBM_SETLINESIZE, 0, 5);
    SendMessageW(hSl[i], TBM_SETPOS, TRUE, looks[i] + 100);
    slider_text(i);
    y += 60;
  }
  y += 4;
  mk(L"STATIC", L"My voice", SS_LEFT, x, y + 4, 90, 20, 0, fNormal);
  hVoice = mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_TABSTOP, x + 92, y, 200, 200, ID_VOICE, fNormal);
  SendMessageW(hVoice, CB_ADDSTRING, 0, (LPARAM)L"Auto");
  SendMessageW(hVoice, CB_ADDSTRING, 0, (LPARAM)L"Lower (most men)");
  SendMessageW(hVoice, CB_ADDSTRING, 0, (LPARAM)L"Higher (most women)");
  SendMessageW(hVoice, CB_SETCURSEL, voice, 0);
  mk(L"BUTTON", L"Reset", BS_PUSHBUTTON | WS_TABSTOP, W - 20 - 80, y, 80, 26, ID_RESET, fNormal);
  y += 36;
  hOn = mk(L"BUTTON", L"Voice makeup on", BS_AUTOCHECKBOX | WS_TABSTOP, x, y, 200, 22, ID_ON, fNormal);
  SendMessageW(hOn, BM_SETCHECK, makeup_on ? BST_CHECKED : BST_UNCHECKED, 0);
  y += 28;
  hHear = mk(L"BUTTON", L"Hear myself in", BS_AUTOCHECKBOX | WS_TABSTOP, x, y + 2, 130, 22, ID_HEAR, fNormal);
  SendMessageW(hHear, BM_SETCHECK, hear ? BST_CHECKED : BST_UNCHECKED, 0);
  hMon = mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, x + 132, y, cw - 132, 300, ID_MON, fNormal);
  y += 36;

  hMeter = CreateWindowExW(0, L"FledglingMeter", L"", WS_CHILD | WS_VISIBLE, S(x), S(y), S(cw), S(14), hwnd, NULL, hinst, NULL);
  y += 20;
  hStatus = mk(L"STATIC", L"Starting\x2026", SS_LEFT, x, y, cw - 120, 36, 0, fSmall);
  hPrivacy = mk(L"BUTTON", L"Mic privacy", BS_PUSHBUTTON | WS_TABSTOP, W - 20 - 110, y, 110, 26, ID_PRIVACY, fNormal);
  ShowWindow(hPrivacy, SW_HIDE);
}
#define H_CLIENT 612

static void populate(void) {
  wchar_t m[256], o[256], h[256];
  get_s(L"mic", m, 256); get_s(L"out", o, 256); get_s(L"monitor", h, 256);
  fill_combo(hMic, 1, L"Windows default microphone", m, 0);
  fill_combo(hOut, 0, NULL, o, 1);
  fill_combo(hMon, 0, L"Windows default speakers", h, 0);
  update_hint();
}

static void refresh_combo(HWND cb) {
  wchar_t cur[256]; int i = (int)SendMessageW(cb, CB_GETCURSEL, 0, 0); cur[0] = 0;
  if (i >= 0 && SendMessageW(cb, CB_GETLBTEXTLEN, i, 0) < 256) SendMessageW(cb, CB_GETLBTEXT, i, (LPARAM)cur);
  if (cb == hMic) fill_combo(hMic, 1, L"Windows default microphone", i <= 0 ? L"" : cur, 0);
  else if (cb == hOut) fill_combo(hOut, 0, NULL, cur, 1);
  else fill_combo(hMon, 0, L"Windows default speakers", i <= 0 ? L"" : cur, 0);
}

/* ---------------------------------------------------------------- status timer */
static void tick(void) {
  static int last_drops, show_drops;
  eng_status st; eng_get_status(&st);
  if (st.dropouts != last_drops) { last_drops = st.dropouts; show_drops = 30; } /* 3 s */
  else if (show_drops > 0) show_drops--;
  if (st.running) {
    meter_in = st.in_db; meter_out = st.out_db;
    wchar_t b[256], p[64] = L"";
    if (st.f0 > 0) swprintf(p, 64, L" \x00B7 pitch %d Hz", (int)(st.f0 + 0.5f));
    swprintf(b, 256, L"Live \x00B7 about %d ms delay \x00B7 %ls voice%ls%ls", (int)(st.latency_ms + 0.5f),
             st.voice == 2 ? L"higher" : L"lower", p, show_drops ? L" \x00B7 adjusting buffer" : L"");
    SetWindowTextW(hStatus, b);
  } else { meter_in = meter_out = -100; }
  InvalidateRect(hMeter, NULL, FALSE);
}

static void about(void) {
  MessageBoxW(hwnd,
    L"Fledgling Live " APP_VERSION_W L"\n"
    L"Live voice makeup: Younger, Confident, Clear and Masculine/Feminine.\n\n"
    L"How it works: Fledgling Live takes your microphone, changes your voice (about 20 ms of processing), "
    L"and plays it into a virtual microphone. In your call app, pick that virtual microphone.\n\n"
    L"Virtual microphone: VB-CABLE by VB-Audio Software (www.vb-cable.com) is donationware and is "
    L"installed separately.\n\n"
    L"Open-source parts:\n"
    L"\x2022 miniaudio by David Reid, public domain / MIT No Attribution\n\n"
    L"Settings are stored in %APPDATA%\\Fledgling Live\\settings.ini. "
    L"Your voice never leaves this PC.",
    L"About " APP_NAME, MB_OK | MB_ICONINFORMATION);
}

/* ---------------------------------------------------------------- window proc */
static LRESULT CALLBACK wnd_proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
  case WM_CREATE:
    hwnd = h; build(); populate(); start_audio();
    SetTimer(h, ID_TIMER, 100, NULL);
    return 0;
  case WM_CTLCOLORSTATIC: {
    HDC dc = (HDC)w; HWND c = (HWND)l;
    SetBkMode(dc, TRANSPARENT);
    if (c == hCableNote) { SetTextColor(dc, RGB(120, 70, 0)); return (LRESULT)bgBrush; }
    if (c == hHint || c == hStatus) SetTextColor(dc, COL_MUTED);
    else if (c == hSv[0] || c == hSv[1] || c == hSv[2] || c == hSv[3]) SetTextColor(dc, COL_ACCENT);
    else SetTextColor(dc, COL_INK);
    return (LRESULT)bgBrush;
  }
  case WM_HSCROLL:
    for (int i = 0; i < 4; i++)
      if ((HWND)l == hSl[i]) {
        int v = (int)SendMessageW(hSl[i], TBM_GETPOS, 0, 0) - 100;
        if (LOWORD(w) == TB_ENDTRACK && v != 0 && v > -5 && v < 5) { v = 0; SendMessageW(hSl[i], TBM_SETPOS, TRUE, 100); }
        looks[i] = v; slider_text(i);
        eng_set_looks(looks[0], looks[1], looks[2], looks[3]);
        if (LOWORD(w) == TB_ENDTRACK) put_i(SL[i].key, v);
      }
    return 0;
  case WM_COMMAND: {
    int id = LOWORD(w), code = HIWORD(w);
    if ((id == ID_MIC || id == ID_OUT || id == ID_MON) && code == CBN_DROPDOWN) { refresh_combo((HWND)l); return 0; }
    if ((id == ID_MIC || id == ID_OUT || id == ID_MON) && code == CBN_SELCHANGE) {
      save_devices(); update_hint(); start_audio(); return 0;
    }
    if (id == ID_VOICE && code == CBN_SELCHANGE) {
      voice = (int)SendMessageW(hVoice, CB_GETCURSEL, 0, 0); put_i(L"voice", voice); eng_set_voice(voice); return 0;
    }
    if (id == ID_ON) { makeup_on = SendMessageW(hOn, BM_GETCHECK, 0, 0) == BST_CHECKED; put_i(L"on", makeup_on); eng_set_bypass(!makeup_on); return 0; }
    if (id == ID_HEAR) { hear = SendMessageW(hHear, BM_GETCHECK, 0, 0) == BST_CHECKED; put_i(L"hear", hear); start_audio(); return 0; }
    if (id == ID_RESET) {
      for (int i = 0; i < 4; i++) { looks[i] = SL[i].def; SendMessageW(hSl[i], TBM_SETPOS, TRUE, looks[i] + 100); slider_text(i); put_i(SL[i].key, looks[i]); }
      eng_set_looks(looks[0], looks[1], looks[2], looks[3]);
      return 0;
    }
    if (id == ID_GETCABLE) { ShellExecuteW(h, L"open", VBCABLE_URL, NULL, NULL, SW_SHOWNORMAL); return 0; }
    if (id == ID_PRIVACY) { ShellExecuteW(h, L"open", L"ms-settings:privacy-microphone", NULL, NULL, SW_SHOWNORMAL); return 0; }
    if (id == ID_ABOUT) { about(); return 0; }
    break;
  }
  case WM_TIMER:
    if (w == ID_TIMER) tick();
    if (w == ID_RETRY) { KillTimer(h, ID_RETRY); refresh_combo(hMic); refresh_combo(hOut); refresh_combo(hMon); update_hint(); start_audio(); }
    return 0;
  case WM_DEVLOST:
    eng_stop();
    SetWindowTextW(hStatus, L"A sound device stopped. Reconnecting\x2026");
    SetTimer(h, ID_RETRY, 1500, NULL);
    return 0;
  case WM_DESTROY:
    eng_stop(); PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev; (void)cmd;
  hinst = hi;
  HANDLE one = CreateMutexW(NULL, TRUE, L"FledglingLiveSingleInstance");
  if (one && GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND other = FindWindowW(L"FledglingLive", NULL);
    if (other) { ShowWindow(other, SW_RESTORE); SetForegroundWindow(other); }
    return 0;
  }
  INITCOMMONCONTROLSEX icc = { sizeof icc, ICC_BAR_CLASSES | ICC_STANDARD_CLASSES };
  InitCommonControlsEx(&icc);
  HDC sdc = GetDC(NULL); dpi = GetDeviceCaps(sdc, LOGPIXELSY); ReleaseDC(NULL, sdc);
  fNormal = font(10, FW_NORMAL); fSmall = font(9, FW_NORMAL); fBold = font(10, FW_SEMIBOLD); fTitle = font(17, FW_SEMIBOLD);
  bgBrush = CreateSolidBrush(COL_BG); noteBrush = CreateSolidBrush(COL_NOTE);

  ini_path();
  for (int i = 0; i < 4; i++) { looks[i] = get_i(SL[i].key, SL[i].def); if (looks[i] < -100) looks[i] = -100; if (looks[i] > 100) looks[i] = 100; }
  voice = get_i(L"voice", 0); if (voice < 0 || voice > 2) voice = 0;
  makeup_on = get_i(L"on", 1) != 0; hear = get_i(L"hear", 0) != 0;

  WNDCLASSW mc = { 0 }; mc.lpfnWndProc = meter_proc; mc.hInstance = hi; mc.lpszClassName = L"FledglingMeter";
  mc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW); RegisterClassW(&mc);
  WNDCLASSW wc = { 0 };
  wc.lpfnWndProc = wnd_proc; wc.hInstance = hi; wc.lpszClassName = L"FledglingLive";
  wc.hIcon = LoadIconW(hi, MAKEINTRESOURCEW(IDI_APP)); wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
  wc.hbrBackground = bgBrush;
  RegisterClassW(&wc);
  DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
  RECT r = { 0, 0, S(W), S(H_CLIENT) }; AdjustWindowRect(&r, style, FALSE);
  HWND h = CreateWindowExW(0, L"FledglingLive", APP_NAME, style, CW_USEDEFAULT, CW_USEDEFAULT,
                           r.right - r.left, r.bottom - r.top, NULL, NULL, hi, NULL);
  if (!h) return 1;
  ShowWindow(h, show); UpdateWindow(h);
  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    if (IsDialogMessageW(h, &msg)) continue;
    TranslateMessage(&msg); DispatchMessageW(&msg);
  }
  return 0;
}
