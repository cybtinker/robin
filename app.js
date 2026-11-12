/* Fledgling: UI, recording, playback. Heavy work runs in worker.js. */
'use strict';
const VERSION = 'poc-10.2';
const MAX_S = 90;        // longest take
const OLD_MAX_S = 150;   // an old recording: first 2.5 minutes are enough
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ worker RPC
const worker = new Worker('worker.js');
let nextId = 1;
const pending = new Map();
let onProgress = () => {};
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') return onProgress(m);
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id);
  m.ok ? p.resolve(m.res) : p.reject(new Error(m.error));
};
const call = (cmd, args, transfer = []) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  worker.postMessage({ id, cmd, args }, transfer);
});
call('warmup').catch(() => {});

// ------------------------------------------------------------ small helpers
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;
const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
const fmtS = (ms) => (ms / 1000).toFixed(1) + ' s';
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let toastTimer = 0;
function toast(msg, err) {
  const el = $('toast'); clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg; el.classList.toggle('err', !!err); el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, err ? 7000 : 3500);
}
function setStatus(text, sub = '') { $('singText').textContent = text; $('singSub').textContent = sub; }
function idleStatus() {
  if (state.take) setStatus(t('yourTake'), `${(state.take.pcm.length / state.take.sr).toFixed(1)} s` + (state.lastMs != null ? ' · ' + t('readyIn', { t: fmtS(state.lastMs) }) : ''));
  else setStatus(t('singLine'));
}
function showProgress(frac) { $('prog').hidden = frac == null; $('progBar').style.width = Math.round((frac || 0) * 100) + '%'; }

// ------------------------------------------------------------ age bands and data-based defaults
// Common Voice medians per band (index 0 = men, 1 = women), from the age study (1,055 speakers, speech):
// speaking pitch change from the 20s (st), pitch wobble SD (st), formant change (%), harmonics-to-noise (dB).
const BANDS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']; // Teens, 20s, 30s, 40s, 50s, 60+
const BAND_EN = ['teens', '20s', '30s', '40s', '50s', '60plus']; // for the log and file names
const DATA = {
  pitch: [[0.2, 0, -0.5, -0.7, -1.1, -0.9], [0.4, 0, -1.9, -2.3, -2.4, -3.0]],
  wob: [[3.44, 3.31, 3.76, 3.81, 3.96, 4.23], [3.47, 3.58, 3.86, 3.90, 3.98, 4.13]],
  form: [[0, 0, 0, 0, 0, -0.5], [0, 0, 0, 0, 0, -2.3]],
  hnr: [[9.4, 9.9, 9.1, 8.9, 8.6, 9.1], [12.5, 12.5, 11.2, 11.3, 12.3, 12.0]],
};
const METRICS = [
  { id: 'pitch', min: -12, max: 12, step: 0.1, unit: ' st', tint: '#d9efe9', icon: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z' },
  { id: 'wobble', min: -90, max: 150, step: 1, unit: ' %', tint: '#e6e9f7', icon: 'M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0' },
  { id: 'formant', min: -20, max: 25, step: 0.5, unit: ' %', tint: '#f7e9d6', icon: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0' },
  { id: 'clarity', min: -10, max: 10, step: 0.1, unit: ' dB', tint: '#f3e3ef', icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6' },
  { id: 'texture', min: 0, max: 2, step: 0.05, unit: '', tint: '#efe9dc', icon: 'M5 6h.01M10 6h.01M15 6h.01M19 6h.01M7 11h.01M12 11h.01M17 11h.01M5 16h.01M10 16h.01M15 16h.01M19 16h.01' },
];
const bandFrom = (k, d) => { const v = +store.get(k); return Number.isInteger(v) && v >= 0 && v <= 5 && store.get(k) != null ? v : d; };

// ------------------------------------------------------------ state
const state = {
  age: bandFrom('yv-age-band', 4), target: bandFrom('yv-target-band', 1),
  voice: store.get('yv-voice') || 'male', voicePicked: !!store.get('yv-voice'),
  over: {}, cues: {}, looks: null, old: null, feat: null,
  take: null, timings: {}, fxBlob: null, busy: false, queued: false, lastMs: null,
};
const direction = () => (state.looks && state.looks.age < 0) || state.target > state.age ? 'older' : 'younger';
// The "typical" slider values for the chosen ages. With an old recording of the user, their own pitch,
// steadiness and clarity back then replace the averages (capped, since key and mic differ between recordings).
function typical() {
  const g = state.voice === 'female' ? 1 : 0, a = state.age, b = state.target;
  const T = {
    pitch: r1(DATA.pitch[g][b] - DATA.pitch[g][a]),
    wobble: Math.round((DATA.wob[g][b] / DATA.wob[g][a] - 1) * 100),
    // Measured formants barely move with age, but a slightly smaller-sounding voice is the strongest
    // "younger" cue listeners hear (blind test, poc-2..7: about +5 % for 50s to 20s). So the formant
    // default is perceptual: +1.7 % per band younger (max +8 %), -1.3 % per band older, plus the data.
    formant: r1(clamp(DATA.form[g][b] - DATA.form[g][a] + (b < a ? 1.7 : 1.3) * (a - b), -8, 8)),
    clarity: r1(DATA.hnr[g][b] - DATA.hnr[g][a]),
    texture: a === b ? 0 : r1(Math.min(0.9, 0.4 + 0.1 * Math.abs(a - b)) * 100) / 100,
  };
  const o = state.old, f = state.feat;
  if (o && f) {
    if (o.f0med > 0 && f.f0med > 0) T.pitch = r1(clamp(12 * Math.log2(o.f0med / f.f0med), -3, 3));
    if (o.wobble > 0 && f.wobble > 0) T.wobble = Math.round(clamp((o.wobble / f.wobble - 1) * 100, -40, 40));
    if (o.hnr && f.hnr) T.clarity = r1(clamp(o.hnr - f.hnr, -3, 3));
  }
  return T;
}
// Voice makeup: four two-way sliders (-100..100, 0 = off) mix into the five fine-tune values.
// Each has a left and a right end; positive = right end.
const LOOKS = [
  { id: 'age', l: 'e_older', r: 'e_younger', tint: '#d9efe9', icon: 'M12 3l2.2 5.6L20 9.2l-4.5 3.9L17 19l-5-3.2L7 19l1.5-5.9L4 9.2l5.8-.6z' },
  { id: 'conf', l: 'e_timid', r: 'e_conf', tint: '#e6e9f7', icon: 'M3 12h4l3-7 4 14 3-7h4' },
  { id: 'tone', l: 'e_breathy', r: 'e_clear', tint: '#f3e3ef', icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6' },
  { id: 'gender', l: 'e_masc', r: 'e_fem', tint: '#f7e9d6', icon: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z' },
];
const LOOK_DEF = { age: 50, conf: 40, tone: 30, gender: 0 };
function loadLooks() { try { const o = JSON.parse(store.get('yv-looks2') || '{}'); const r = {}; for (const k in LOOK_DEF) r[k] = Number.isFinite(o[k]) ? clamp(o[k], -100, 100) : LOOK_DEF[k]; return r; } catch (e) { return { ...LOOK_DEF }; } }
state.looks = loadLooks();
const BOOST = 3; // v10.1: the far end is 3x the v9 maximum (Yong: "make it 3x")
const K = BOOST / 1.6; // the other sliders were sized for 1.6x in v10
function base() {
  const T = typical(), L = state.looks, a = L.age / 100, c = L.conf / 100, k = L.tone / 100, g = L.gender / 100;
  let pitch = 0, formant = 0, wobble = 0, clarity = 0, texture = 0;
  if (a > 0) { pitch += BOOST * a * T.pitch; formant += BOOST * a * T.formant; wobble += BOOST * a * T.wobble; clarity += BOOST * a * T.clarity; texture = BOOST * a * T.texture; }
  if (a < 0) { const s = -a * K; pitch -= 1.5 * s; formant -= 6 * s; wobble += 40 * s; clarity -= 2.5 * s; texture = 1.0 * s; }
  wobble += K * (c >= 0 ? -45 * c : -60 * c); clarity += K * 2 * c;           // confident: steadier, less breathy
  clarity += K * (k >= 0 ? 3 * k : 4 * k); if (k > 0 && a >= 0) texture = Math.max(texture, K * 0.6 * k); // clear: smoother
  pitch += K * 4 * g; formant += K * 10 * g;                                 // feminine: higher and smaller; masculine: lower and bigger
  return {
    pitch: r1(clamp(pitch, -12, 12)), formant: r1(clamp(formant, -20, 25)),
    wobble: Math.round(clamp(wobble, -90, 150)), clarity: r1(clamp(clarity, -10, 10)),
    texture: Math.round(clamp(texture, 0, 2) * 100) / 100,
  };
}
const val = (k) => state.over[k] ?? base()[k];
// how much each measure changes between the chosen ages (Common Voice), 0-3 bars
function impact(k) {
  const v = Math.abs(typical()[k]); if (state.target === state.age) return 0;
  if (k === 'pitch') return v >= 1.5 ? 3 : v >= 0.5 ? 2 : 1;
  if (k === 'wobble') return v >= 15 ? 3 : v >= 7 ? 2 : 1;
  if (k === 'formant') return v >= 4 ? 3 : v >= 1.5 ? 2 : 1;
  if (k === 'clarity') return v >= 1 ? 2 : 1;
  return 2;
}
const fmtVal = (m, v) => (m.id === 'texture' ? v.toFixed(2) : sign(v)) + m.unit;

// ------------------------------------------------------------ build the controls
const ageSel = $('ageSel'), targetSel = $('targetSel');
function fillBands() {
  for (const sel of [ageSel, targetSel]) {
    const v = sel.value; sel.innerHTML = '';
    BANDS.forEach((b, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t(b); sel.appendChild(o); });
    sel.value = v || '0';
  }
  ageSel.value = state.age; targetSel.value = state.target;
}
METRICS.forEach((m) => {
  const row = document.createElement('div'); row.className = 'metric';
  row.innerHTML = `<span class="ico" style="background:${m.tint}" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1d1a20" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${m.icon}"/></svg></span>`
    + `<label for="m_${m.id}" data-i18n="m_${m.id}"></label>`
    + `<svg class="imp" id="imp_${m.id}" width="14" height="14" viewBox="0 0 14 14" role="img"><title></title><rect x="1" y="9" width="3" height="4" rx="1"/><rect x="5.5" y="5" width="3" height="8" rx="1"/><rect x="10" y="1" width="3" height="12" rx="1"/></svg>`
    + `<input type="range" id="m_${m.id}" min="${m.min}" max="${m.max}" step="${m.step}">`
    + `<output id="o_${m.id}" for="m_${m.id}"></output>`
    + `<button class="info" type="button" data-info="info_m_${m.id}" data-i18n-aria="infoLabel" aria-label="What is this?">i</button>`;
  $('metrics').appendChild(row);
  const inp = row.querySelector('input');
  inp.addEventListener('input', () => { state.over[m.id] = +inp.value; $(`o_${m.id}`).textContent = fmtVal(m, +inp.value); });
  inp.addEventListener('change', render);
});
// Look strength as a word instead of a percent (Yong: '%' was unclear); the side is named by the end word.
const lvWord = (v) => { const m = Math.abs(v); return m === 0 ? t('lvOff') : t(m < 35 ? 'lvLight' : m < 70 ? 'lvMed' : 'lvStrong'); };
const lookSay = (l, v) => v === 0 ? t('lvOff') : `${lvWord(v)} · ${t(v > 0 ? l.r : l.l)}`;
function showLook(l) {
  const v = state.looks[l.id], row = $(`l_${l.id}`).closest('.look');
  $(`lo_${l.id}`).textContent = lvWord(v);
  $(`l_${l.id}`).setAttribute('aria-valuetext', lookSay(l, v));
  row.querySelector('.e-l').classList.toggle('on', v < 0); row.querySelector('.e-r').classList.toggle('on', v > 0);
}
LOOKS.forEach((l) => {
  const row = document.createElement('div'); row.className = 'look';
  row.innerHTML = `<span class="ico" style="background:${l.tint}" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1d1a20" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${l.icon}"/></svg></span>`
    + `<div class="bip"><input type="range" id="l_${l.id}" min="-100" max="100" step="5" data-i18n-aria="l_${l.id}">`
    + `<div class="ends" aria-hidden="true"><span class="e-l" data-i18n="${l.l}"></span><span class="e-r" data-i18n="${l.r}"></span></div></div>`
    + `<output id="lo_${l.id}" for="l_${l.id}"></output>`
    + `<button class="info" type="button" data-info="info_l_${l.id}" data-i18n-aria="infoLabel" aria-label="What is this?">i</button>`;
  $('looks').appendChild(row);
  const inp = row.querySelector('input');
  inp.addEventListener('input', () => { let v = +inp.value; if (Math.abs(v) <= 5) v = 0; state.looks[l.id] = v; showLook(l); });
  inp.addEventListener('change', () => { if (state.prank) { state.prank = null; showPrank(); } inp.value = state.looks[l.id]; store.set('yv-looks2', JSON.stringify(state.looks)); state.over = {}; showMetrics(); render(); });
});
function showMetrics() {
  LOOKS.forEach((l) => { $(`l_${l.id}`).value = state.looks[l.id]; showLook(l); });
  METRICS.forEach((m) => {
    const v = val(m.id), lv = impact(m.id);
    $(`m_${m.id}`).value = v; $(`o_${m.id}`).textContent = fmtVal(m, v);
    const imp = $(`imp_${m.id}`), lab = t('impact', { x: t('imp' + lv) });
    imp.querySelectorAll('rect').forEach((r, i) => r.classList.toggle('on', lv > i));
    imp.setAttribute('aria-label', lab); imp.querySelector('title').textContent = lab;
  });
  $('ageV').textContent = t(BANDS[state.age]); $('targetV').textContent = t(BANDS[state.target]);
  $('vMale').setAttribute('aria-pressed', state.voice === 'male'); $('vFemale').setAttribute('aria-pressed', state.voice === 'female');
  $('fxLabel').textContent = fxLabel();
  document.documentElement.classList.toggle('older', direction() === 'older');
}
const fxLabel = () => state.prank ? t('pr_' + state.prank) : t('playMakeup');

// fine-tune cues (Settings)
const CUES = ['vibrato', 'jitter', 'shimmer', 'breath', 'tilt', 'clarity'];
CUES.forEach((k) => {
  state.cues[k] = 1;
  const d = document.createElement('label'); d.className = 'cue';
  d.innerHTML = `<span data-i18n="cue_${k}"></span><output id="cue_${k}_o">1.0×</output><input type="range" id="cue_${k}" min="0" max="2" step="0.1" value="1">`;
  $('cues').appendChild(d);
  const inp = d.querySelector('input');
  inp.addEventListener('input', () => { state.cues[k] = +inp.value; $(`cue_${k}_o`).textContent = `${(+inp.value).toFixed(1)}×`; });
  inp.addEventListener('change', render);
});

function changed(resetOver = true) { if (resetOver) state.over = {}; showMetrics(); render(); }
ageSel.addEventListener('change', () => { state.age = +ageSel.value; store.set('yv-age-band', state.age); changed(); });
targetSel.addEventListener('change', () => { state.target = +targetSel.value; store.set('yv-target-band', state.target); changed(); });
function pickVoice(v) { state.voice = v; state.voicePicked = true; store.set('yv-voice', v); changed(); }
$('vMale').onclick = () => pickVoice('male');
$('vFemale').onclick = () => pickVoice('female');
$('typicalBtn').onclick = () => changed();
$('tuneBtn').onclick = () => $('tune').showModal();
// Prank mode (Yong's idea): one button cycles through over-the-top voices, then back to the makeup.
const PRANKS = [
  { id: 'chipmunk', dir: 'younger', v: { pitch: 12, formant: 25, wobble: 0, clarity: 2, texture: 0 } },
  { id: 'giant', dir: 'older', v: { pitch: -10, formant: -20, wobble: 0, clarity: 0, texture: 0.5 } },
  { id: 'robot', dir: 'younger', robot: true, v: { pitch: 0, formant: 0, wobble: 0, clarity: 20, texture: 0 } },
  { id: 'wobbly', dir: 'older', v: { pitch: 0, formant: 0, wobble: 300, clarity: -2, texture: 1 } },
];
state.prank = null;
function showPrank() {
  const b = $('prankBtn'); b.setAttribute('aria-pressed', !!state.prank);
  $('prankTxt').textContent = state.prank ? t('pr_' + state.prank) : t('prank');
  $('looks').classList.toggle('dim', !!state.prank); $('fxLabel').textContent = fxLabel();
}
$('prankBtn').onclick = () => {
  const i = state.prank ? PRANKS.findIndex(p => p.id === state.prank) + 1 : 0;
  state.prank = i < PRANKS.length ? PRANKS[i].id : null;
  showPrank(); render();
};

// ------------------------------------------------------------ WAV encode / audio
function wavBlob(pcm, sr) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}
function setAudio(el, blob) {
  el.pause();
  if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
  const u = URL.createObjectURL(blob); el.dataset.url = u; el.src = u; el.load();
}
// bottom bar: two play/pause buttons, one plays at a time
const players = [['playOrig', 'origAudio'], ['playFx', 'fxAudio']];
players.forEach(([b, a]) => {
  const btn = $(b), au = $(a);
  btn.onclick = () => {
    if (!au.paused) { au.pause(); return; }
    players.forEach(([, o]) => { if (o !== a) $(o).pause(); });
    au.currentTime = au.ended ? 0 : au.currentTime; au.play().catch(() => {});
  };
  au.addEventListener('play', () => btn.classList.add('playing'));
  ['pause', 'ended', 'emptied'].forEach(ev => au.addEventListener(ev, () => btn.classList.remove('playing')));
});

// ------------------------------------------------------------ pipeline
async function loadTake(pcm, sr, label) {
  if (state.busy) return;
  toast('');
  const dur = pcm.length / sr;
  if (dur < 1) return toast(t('errShort'), true);
  if (dur > MAX_S) { pcm = pcm.slice(0, MAX_S * sr); toast(t('errCut', { s: MAX_S })); }
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v)); // normalise quiet takes
  if (peak > 0 && peak < 0.5) { const k = 0.5 / peak; pcm = pcm.map(v => v * k); }
  state.take = { pcm, sr, label }; state.lastMs = null;
  setAudio($('origAudio'), wavBlob(pcm, sr)); $('playOrig').disabled = false;
  $('sLen').textContent = `${dur.toFixed(1)} s`;
  $('sAna').textContent = $('sFx').textContent = $('sRt').textContent = '–';
  state.busy = true; $('recBtn').disabled = true;
  onProgress = (m) => showProgress(m.done);
  setStatus(t('reading')); showProgress(0.02);
  try {
    const r = await call('analyse', { pcm: Float32Array.from(pcm), sr });
    state.timings = { analyse: r.ms, chunks: r.chunks };
    $('sAna').textContent = fmtS(r.ms);
    state.feat = { f0med: r.f0med || 0, wobble: r.wobble || 0, hnr: r.hnr || 0 };
    if (!state.voicePicked && r.f0med) state.voice = r.f0med > 280 ? 'female' : 'male'; // singing; ~160 Hz for speech
    Research.newTake(pcm, sr, { version: VERSION, source: label === 'recording' || label === 'sample' ? label : 'file', /* file names are never sent */
      features: { f0_median: Math.round(r.f0med || 0), wobble_st: r1(r.wobble * 100) / 100, hnr_db: r1(r.hnr || 0), analyse_ms: Math.round(r.ms) } }, wavBlob);
  } catch (e) {
    state.busy = false; $('recBtn').disabled = false; showProgress(null); state.take = null; idleStatus();
    return toast(t('errRead', { e: e.message }), true);
  }
  state.busy = false; $('recBtn').disabled = false;
  state.over = {}; showMetrics();
  render();
}

async function render() {
  if (!state.take) return;
  if (state.busy) { state.queued = true; return; }
  state.busy = true; $('shareBtn').disabled = true; $('playFx').disabled = true;
  const pr = state.prank ? PRANKS.find(p => p.id === state.prank) : null;
  const v = pr ? pr.v : { pitch: val('pitch'), wobble: val('wobble'), formant: val('formant'), clarity: val('clarity'), texture: val('texture') };
  const dir = pr ? pr.dir : direction();
  setStatus(t('applying')); onProgress = (m) => showProgress(m.done); showProgress(0.05);
  try {
    const r = await call('render', { strength: v.texture, direction: dir,
      cues: { ...state.cues, pitch_cents: Math.round(v.pitch * 100), formant_pct: v.formant, wobble_pct: v.wobble, hnr_db: v.clarity, robot_hz: pr && pr.robot && state.feat ? state.feat.f0med : 0 } });
    state.timings.render = r.ms; state.lastMs = r.ms;
    { // match the original's loudness (big effects such as Wobbly can come out much quieter)
      const rms = (a) => { let q = 0; for (const x of a) q += x * x; return Math.sqrt(q / a.length); };
      let pf = 0; for (const x of r.pcm) pf = Math.max(pf, Math.abs(x));
      const ro = rms(state.take.pcm), rf = rms(r.pcm), k = rf > 0 && pf > 0 ? Math.min(8, ro / rf, 0.98 / pf) : 1;
      if (k > 1.3) for (let i = 0; i < r.pcm.length; i++) r.pcm[i] *= k;
    }
    state.fxBlob = wavBlob(r.pcm, state.take.sr);
    setAudio($('fxAudio'), state.fxBlob);
    $('shareBtn').disabled = false; $('playFx').disabled = false;
    const dur = state.take.pcm.length / state.take.sr;
    $('sFx').textContent = fmtS(r.ms);
    $('sRt').textContent = `${((state.timings.analyse + r.ms) / 1000 / dur * 100).toFixed(0)} %`;
    if (Research.optedIn) {
      const T = typical();
      Research.logTry(r.pcm, state.take.sr, {
        voice: state.voice, age_band: BAND_EN[state.age], target_band: BAND_EN[state.target], direction: dir,
        used_old_recording: state.old ? 'yes' : 'no', old_f0_median: state.old ? Math.round(state.old.f0med) : '',
        old_wobble_st: state.old ? r1(state.old.wobble * 100) / 100 : '', old_hnr_db: state.old ? r1(state.old.hnr) : '',
        prank: state.prank || '', look_age: state.looks.age, look_confidence: state.looks.conf, look_tone: state.looks.tone, look_gender: state.looks.gender,
        pitch_st: v.pitch, steadiness_pct: v.wobble, formant_pct: v.formant, clarity_db: v.clarity, texture: v.texture,
        typical_pitch_st: T.pitch, typical_steadiness_pct: T.wobble, typical_formant_pct: T.formant, typical_clarity_db: T.clarity,
        changed_by_user: Object.keys(state.over).join(' '), cues: JSON.stringify(state.cues), lang: LANG,
        effect_ms: Math.round(r.ms), ...DEVICE })
        .then(showCount)
        .catch((e) => toast(t('rsFail', { e: e.message }), true));
    }
  } catch (e) {
    toast(t('errFx', { e: e.message }), true);
  }
  showProgress(null); idleStatus();
  state.busy = false;
  if (state.queued) { state.queued = false; render(); }
}

// ------------------------------------------------------------ recording
let rec = null, audioCtx = null;
const getCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());
async function startRec() {
  toast('');
  if (!navigator.mediaDevices?.getUserMedia) return toast(t('errNoRec'), true);
  const ctx = getCtx(); await ctx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: $('nsBox').checked, autoGainControl: false, channelCount: 1 } });
  } catch (e) { return toast(t('errMic'), true); }
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
  const parts = []; let n = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); n += d.length;
    let p = 0; for (let i = 0; i < d.length; i += 8) p = Math.max(p, Math.abs(d[i]));
    $('level').style.width = Math.min(100, p * 140) + '%';
    const s = n / ctx.sampleRate;
    setStatus(fmtClock(s), t('timerMax'));
    if (s >= MAX_S) stopRec();
  };
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  rec = { stream, src, proc, mute, parts, get n() { return n; }, sr: ctx.sampleRate };
  $('recBtn').classList.add('on'); $('recBtn').setAttribute('aria-label', t('recStop'));
  $('meter').hidden = false; $('singBtns').hidden = true; setStatus('0:00', t('timerMax'));
}
function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  r.proc.onaudioprocess = null; r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect();
  r.stream.getTracks().forEach(tr => tr.stop());
  $('recBtn').classList.remove('on'); $('recBtn').setAttribute('aria-label', t('recStart'));
  $('level').style.width = '0'; $('meter').hidden = true; $('singBtns').hidden = false;
  const pcm = new Float32Array(r.n); let o = 0; for (const p of r.parts) { pcm.set(p, o); o += p.length; }
  loadTake(pcm.subarray(Math.round(0.15 * r.sr)), r.sr, 'recording'); // drop the button tap
}
$('recBtn').onclick = () => (rec ? stopRec() : startRec());

// ------------------------------------------------------------ files (audio or video)
async function decodeToMono(arrayBuf) {
  const ctx = getCtx();
  const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(arrayBuf, res, rej); if (p && p.then) p.then(res, rej); });
  const ch = ab.numberOfChannels, n = ab.length, pcm = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) pcm[i] += d[i] / ch; }
  return { pcm, sr: ab.sampleRate };
}
async function resample(pcm, sr, to, maxS) {
  const n = Math.min(pcm.length, Math.round(maxS * sr));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC || sr === to) return { pcm: pcm.slice(0, n), sr };
  const ctx = new OAC(1, Math.ceil(n * to / sr), to), buf = ctx.createBuffer(1, n, sr);
  buf.copyToChannel(pcm.subarray(0, n), 0);
  const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination); s.start();
  return { pcm: (await ctx.startRendering()).getChannelData(0), sr: to };
}
$('fileIn').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { getCtx().resume(); const { pcm, sr } = await decodeToMono(await f.arrayBuffer()); loadTake(pcm, sr, 'file'); }
  catch (err) { toast(t('errOpen'), true); }
  e.target.value = '';
});
$('sampleBtn').onclick = async () => {
  try { getCtx().resume(); const { pcm, sr } = await decodeToMono(await (await fetch('sample.wav')).arrayBuffer()); loadTake(pcm, sr, 'sample'); }
  catch (err) { toast(t('errSample'), true); }
};
// An old recording of the user: measure their pitch, steadiness and clarity back then.
$('oldIn').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (state.busy) return toast(t('busy'));
  state.busy = true; $('recBtn').disabled = true;
  setStatus(t('oldReading')); onProgress = (m) => showProgress(m.done); showProgress(0.02);
  try {
    getCtx().resume();
    const d = await decodeToMono(await f.arrayBuffer());
    const { pcm, sr } = await resample(d.pcm, d.sr, 16000, OLD_MAX_S);
    const r = await call('measure', { pcm: Float32Array.from(pcm), sr });
    if (!r.f0med) throw new Error(t('oldNoVoice'));
    state.old = { f0med: r.f0med, wobble: r.wobble, hnr: r.hnr, seconds: Math.round(pcm.length / sr) };
    toast(t('oldDone'));
  } catch (err) { toast(t('oldFail', { e: err.message }), true); }
  state.busy = false; $('recBtn').disabled = false; showProgress(null); idleStatus(); showOld();
  if (state.queued) state.queued = false;
  changed();
});
$('oldClear').onclick = () => { state.old = null; showOld(); changed(); };
function showOld() {
  const on = !!state.old;
  $('oldBtn').classList.toggle('has', on); $('oldClear').hidden = !on;
  $('oldText').textContent = on ? t('oldUsing', { s: state.old.seconds }) : t('oldRec');
}

// ------------------------------------------------------------ share / speed report
$('shareBtn').onclick = async () => {
  if (!state.fxBlob) return;
  const name = `fledgling-${BAND_EN[state.age]}-to-${BAND_EN[state.target]}.wav`;
  const file = new File([state.fxBlob], name, { type: 'audio/wav' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
};
function report() {
  const tm = state.timings, dur = state.take ? state.take.pcm.length / state.take.sr : 0;
  return [`Fledgling ${VERSION} speed report`, `Device: ${navigator.userAgent}`, `Model: ${DEVICE.device_model || '?'}`, `Cores: ${navigator.hardwareConcurrency || '?'}`,
    `Take: ${dur.toFixed(1)} s at ${state.take ? state.take.sr : '?'} Hz, ${tm.chunks || 0} chunk(s)`,
    `Reading the voice: ${tm.analyse ? fmtS(tm.analyse) : '–'}`, `Age effect (${fxLabel()}): ${tm.render ? fmtS(tm.render) : '–'}`].join('\n');
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(report()); $('copyNote').textContent = t('copied'); } catch { $('copyNote').textContent = report(); }
};
$('setBtn').onclick = () => $('settings').showModal();

// ------------------------------------------------------------ device info for the research log (no IDs, no IP)
const DEVICE = {
  device_platform: navigator.userAgentData?.platform || navigator.platform || '', device_model: '',
  device_mobile: navigator.userAgentData ? String(navigator.userAgentData.mobile) : '', user_agent: navigator.userAgent,
  device_cores: navigator.hardwareConcurrency || '', device_memory_gb: navigator.deviceMemory || '',
  screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`,
};
navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']).then((h) => {
  DEVICE.device_model = h.model || ''; DEVICE.device_platform += h.platformVersion ? ' ' + h.platformVersion : '';
}).catch(() => {});

// ------------------------------------------------------------ languages
const langSel = $('langSel');
const langAuto = document.createElement('option'); langAuto.value = 'auto'; langSel.appendChild(langAuto);
LANGS.forEach(([code, name]) => { const o = document.createElement('option'); o.value = code; o.textContent = name; langSel.appendChild(o); });
function refreshLang() {
  applyI18n();
  langAuto.textContent = `${t('th_auto')} · ${LANGS.find(([c]) => c === deviceLang())[1]}`;
  document.title = t('appName');
  $('ver').textContent = t('version', { v: VERSION }); $('verBadge').textContent = VERSION.replace('poc-', 'v');
  $('rsId').textContent = t('rsId', { id: Research.device.slice(0, 8) });
  fillBands(); fillThemes(); showMetrics(); showOld(); showCount(); showPrank();
  if (!rec && !state.busy) idleStatus();
}
langSel.value = savedLang() ? LANG : 'auto';
langSel.addEventListener('change', () => { closePop(); setLang(langSel.value); refreshLang(); });

// ------------------------------------------------------------ themes
const THEMES = ['season', 'auto', 'bright', 'dark', 'spring', 'summer', 'fall', 'winter', 'thanksgiving', 'christmas'];
const themeSel = $('themeSel');
let theme = THEMES.includes(store.get('yv-theme')) ? store.get('yv-theme') : 'season'; // default: follow the calendar
// Season from today's date (northern hemisphere): Christmas Dec 1-26, Thanksgiving the week around the
// 4th Thursday of November, then spring Mar-May, summer Jun-Aug, fall Sep-Nov, winter Dec-Feb.
function seasonNow(d = new Date()) {
  const m = d.getMonth(), day = d.getDate();
  if (m === 11 && day <= 26) return 'christmas';
  if (m === 10) { const first = new Date(d.getFullYear(), 10, 1).getDay(), tg = 1 + ((4 - first + 7) % 7) + 21;
    if (day >= tg - 6 && day <= tg + 3) return 'thanksgiving'; }
  return m <= 1 || m === 11 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'fall';
}
function fillThemes() {
  themeSel.innerHTML = '';
  THEMES.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k === 'season' ? `${t('th_season')} · ${t('th_' + seasonNow())}` : t('th_' + k); themeSel.appendChild(o); });
  themeSel.value = theme;
}
function applyTheme() {
  const root = document.documentElement, th = theme === 'season' ? seasonNow() : theme;
  if (th === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', th === 'bright' ? 'light' : th);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (th !== 'auto') { $('tcLight').content = bg; $('tcDark').content = bg; } else { $('tcLight').content = '#f3efe8'; $('tcDark').content = '#16141a'; }
}
themeSel.addEventListener('change', () => { theme = themeSel.value; store.set('yv-theme', theme); applyTheme(); });

// ------------------------------------------------------------ help improve this app (log stays on the phone)
async function showCount() {
  const on = Research.optedIn;
  $('rsSwitch').setAttribute('aria-checked', on); $('rsRow').hidden = !on;
  const n = await Research.count();
  $('rsCount').textContent = t('tries', { n }); $('rsSend').disabled = $('rsSendNo').disabled = !n;
}
$('rsSwitch').onclick = () => { Research.setOptIn(!Research.optedIn); showCount(); };
let outbox = null; // { zip, files } built before the confirm tap
async function openReview(withAudio) {
  try {
    const { blob, rows, files } = await Research.exportZip(withAudio); // build first, so the confirm tap can share at once
    if (!rows) return toast(t('rsEmpty'));
    const stem = `fledgling-research-${Research.device.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
    const loose = files.map(f => f.name === 'log.csv' ? new File([f], `${stem}.csv`, { type: 'text/csv' }) : f);
    outbox = { zip: new File([blob], `${stem}${withAudio ? '' : '-no-audio'}.zip`, { type: 'application/zip' }), parts: splitParts(loose), i: 0 };
    sendLabel();
    const rv = await Research.review(withAudio);
    $('rvFiles').textContent = rv.files ? t('rvFiles', { n: rv.files, mb: (rv.bytes / 1048576).toFixed(1) }) : t('rvNoAudio');
    $('rvId').textContent = t('rvId', { id: Research.device }) + ' · ' + t('version', { v: VERSION });
    $('rvCsv').textContent = rv.csv;
    const tb = $('rvRows'); tb.innerHTML = '';
    const hm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const play = (k) => rv.keys.has(k) ? `<button type="button" class="rv-play" data-key="${k}">${t('rvPlay')}</button>` : '';
    const seen = new Set();
    for (const r of rv.rows) {
      if (!seen.has(r.take_id)) {
        seen.add(r.take_id);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${hm(r.created_at)}</td><td>${t('rvOriginal')} · ${r.duration_s} s</td><td>${play(`${r.take_id}/original.wav`)}</td>`;
        tb.appendChild(tr);
      }
      const tr = document.createElement('tr');
      const what = r.age_band ? `${r.age_band}→${r.target_band} · ${sign(+r.pitch_st)} ${t('st')} · ${t('textureShort')} ${r.texture}` : `${r.pitch_st} ${t('st')} · ${r.formant_pct}%`;
      tr.innerHTML = `<td>${hm(r.created_at)}</td><td>${what}</td><td>${play(`${r.take_id}/${r.try_id}.wav`)}</td>`;
      tb.appendChild(tr);
    }
    $('rvOk').disabled = false; $('review').returnValue = ''; $('review').showModal();
  } catch (e) { toast(t('rsFail', { e: e.message }), true); }
}
$('rsSend').onclick = () => openReview(true);
$('rsSendNo').onclick = () => openReview(false);
$('rvRows').addEventListener('click', async (e) => {
  const b = e.target.closest('.rv-play'); if (!b) return;
  const au = $('rvAudio'), blob = await Research.getAudio(b.dataset.key); if (!blob) return;
  if (au.dataset.url) URL.revokeObjectURL(au.dataset.url);
  au.dataset.url = au.src = URL.createObjectURL(blob); au.play().catch(() => {});
});
$('review').addEventListener('close', () => { $('rvAudio').pause(); });
// Share inside the confirm tap itself: phones only allow the share sheet straight from a tap.
// Share sheets refuse .zip files (Android Chrome rejects with "Permission denied"), so share log.csv and the
// WAVs as separate files; if the phone still says no, save the .zip to Downloads to attach by hand.
function saveZip(zip) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = zip.name; a.click();
  toast(t('rsSaved', { f: zip.name }));
}
// Android Chrome also refuses a share of more than 10 files or about 50 MB ("Permission denied"),
// so a big log goes out in parts, one tap each: part 1 has the CSV, the rest carry the recordings.
function splitParts(files) {
  const parts = []; let cur = [], bytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= 10 || bytes + f.size > 40 * 1048576)) { parts.push(cur); cur = []; bytes = 0; }
    cur.push(f); bytes += f.size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
function sendLabel() {
  const o = outbox; if (!o) return;
  $('rvOk').textContent = o.parts.length > 1 ? t('rvPart', { i: o.i + 1, n: o.parts.length }) : t('rvOk');
}
$('rvOk').addEventListener('click', () => {
  const o = outbox; if (!o) return;
  const files = o.parts[o.i];
  let ok = false; try { ok = !!(navigator.canShare && navigator.canShare({ files })); } catch (e) {}
  const giveUp = () => { outbox = null; $('review').close(); saveZip(o.zip); };
  if (!ok) return giveUp();
  navigator.share({ files, title: `Fledgling research log ${o.i + 1}/${o.parts.length}` }).then(() => {
    o.i++;
    if (o.i >= o.parts.length) { outbox = null; $('review').close(); toast(t('rvSent')); } else sendLabel();
  }).catch((e) => { if (e.name !== 'AbortError') giveUp(); });
});
$('rsDelAudio').onclick = async () => { await Research.clearAudio(); toast(t('rsAudioDeleted')); };
$('rsDel').onclick = async () => { await Research.clear(); toast(t('rsDeleted')); showCount(); };

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (window.YV_PREVIEW) { $('recBtn').hidden = true; $('shareBtn').hidden = true; } // claude.ai preview: no mic, no saving

// ------------------------------------------------------------ (i) pop-ups
let popEl = null, popBtn = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; } if (popBtn) { popBtn.setAttribute('aria-expanded', 'false'); popBtn = null; } }
function popText(key) {
  const T = typical();
  const vars = { info_m_pitch: { v: sign(T.pitch) }, info_m_wobble: { v: sign(T.wobble) }, info_m_clarity: { v: sign(T.clarity) } }[key];
  return t(key, vars) + (state.old && /pitch|wobble|clarity/.test(key) ? ' ' + t('fromOld') : '');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.info');
  if (!b) { if (popEl && !popEl.contains(e.target)) closePop(); return; }
  e.preventDefault(); e.stopPropagation();
  const same = b === popBtn; closePop(); if (same) return;
  popBtn = b; b.setAttribute('aria-expanded', 'true');
  popEl = document.createElement('div'); popEl.className = 'pop'; popEl.setAttribute('role', 'note');
  popEl.textContent = popText(b.dataset.info); (b.closest('dialog') || document.body).appendChild(popEl);
  const r = b.getBoundingClientRect(), w = popEl.offsetWidth, h = popEl.offsetHeight;
  popEl.style.left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left + r.width / 2 - w / 2)) + 'px';
  popEl.style.top = (r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, r.top - 8 - h) : r.bottom + 8) + 'px';
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
window.addEventListener('resize', closePop);
$('metrics').addEventListener('scroll', closePop); document.querySelector('.content').addEventListener('scroll', closePop);

refreshLang();
applyTheme();
window.__yv = { state, call, loadTake, report, typical }; // for automated tests
