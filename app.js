/* Younger Voice PoC: UI, recording, playback. Heavy work runs in worker.js. */
'use strict';
const VERSION = 'poc-3';
const MAX_S = 90;
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

// ------------------------------------------------------------ state
const state = { direction: 'younger', strength: 0.6, pitch: 0, formant: 5, f0med: 0, age: null, cues: {}, take: null, timings: {}, fxBlob: null, busy: false, queued: false };
const CUES = ['vibrato', 'jitter', 'shimmer', 'breath', 'tilt', 'clarity'];
CUES.forEach((k) => {
  state.cues[k] = 1;
  const d = document.createElement('label');
  d.className = 'cue';
  d.innerHTML = `<span data-i18n="cue_${k}">${t('cue_' + k)}</span><output id="cue_${k}_o">1.0×</output><input type="range" id="cue_${k}" min="0" max="2" step="0.1" value="1">`;
  $('cues').appendChild(d);
  const inp = d.querySelector('input');
  inp.addEventListener('input', () => { state.cues[k] = +inp.value; $(`cue_${k}_o`).textContent = (+inp.value).toFixed(1) + '×'; });
  inp.addEventListener('change', render);
});

function setError(msg) { $('err').hidden = !msg; $('err').textContent = msg || ''; }
function showProgress(text, frac) {
  $('prog').hidden = frac == null;
  if (text) $('progText').textContent = text;
  $('progBar').style.width = Math.round((frac || 0) * 100) + '%';
}
const fmtS = (ms) => (ms / 1000).toFixed(1) + ' s';
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------ WAV encode
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
  if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
  const u = URL.createObjectURL(blob); el.dataset.url = u; el.src = u; el.load();
}

// ------------------------------------------------------------ pipeline
async function loadTake(pcm, sr, label) {
  if (state.busy) return;
  setError('');
  const dur = pcm.length / sr;
  if (dur < 1) return setError(t('errShort'));
  if (dur > MAX_S) { pcm = pcm.slice(0, MAX_S * sr); setError(t('errCut', { s: MAX_S })); }
  // normalise peak so quiet takes analyse well
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  if (peak > 0 && peak < 0.5) { const k = 0.5 / peak; pcm = pcm.map(v => v * k); }
  state.take = { pcm, sr, label };
  setAudio($('origAudio'), wavBlob(pcm, sr));
  $('origLen').textContent = `${dur.toFixed(1)} s · ${sr / 1000} kHz`;
  $('sLen').textContent = `${dur.toFixed(1)} s`;
  $('sAna').textContent = $('sFx').textContent = $('sRt').textContent = '–';
  state.busy = true; $('recBtn').disabled = true;
  onProgress = (m) => showProgress(m.stage === 'analyse' ? t('reading') : t('applying'), m.done);
  showProgress(t('reading'), 0.02);
  try {
    const t0 = performance.now();
    const r = await call('analyse', { pcm: Float32Array.from(pcm), sr });
    state.timings = { analyse: r.ms, analyseWall: performance.now() - t0, chunks: r.chunks };
    $('sAna').textContent = fmtS(r.ms);
    state.f0med = r.f0med || 0; state.age = r.age ? Math.round(r.age) : null; showAgeGuess(); drawPadGrid(); setPad(state.pitch, state.formant);
  } catch (e) {
    state.busy = false; $('recBtn').disabled = false; showProgress(null, null);
    state.take = null;
    return setError(t('errRead', { e: e.message }));
  }
  state.busy = false; $('recBtn').disabled = false;
  render();
}

async function render() {
  if (!state.take) return;
  if (state.busy) { state.queued = true; return; }
  state.busy = true; $('shareBtn').disabled = true;
  const label = labelFor();
  $('fxState').textContent = t('working');
  showProgress(t('applying'), 0.05);
  try {
    const r = await call('render', { strength: state.strength, direction: state.direction, cues: { ...state.cues, pitch_cents: Math.round(state.pitch * 100), formant_pct: state.formant } });
    state.timings.render = r.ms;
    state.fxBlob = wavBlob(r.pcm, state.take.sr);
    setAudio($('fxAudio'), state.fxBlob);
    $('fxLabel').textContent = label;
    $('fxState').textContent = t('readyIn', { t: fmtS(r.ms) }); $('fxState').dataset.done = '1'; state.lastMs = r.ms;
    $('shareBtn').disabled = false;
    const dur = state.take.pcm.length / state.take.sr;
    $('sFx').textContent = fmtS(r.ms);
    $('sRt').textContent = `${((state.timings.analyse + r.ms) / 1000 / dur * 100).toFixed(0)} %`;
  } catch (e) {
    setError(t('errFx', { e: e.message }));
    $('fxState').textContent = '';
  }
  showProgress(null, null);
  state.busy = false;
  if (state.queued) { state.queued = false; render(); }
}
const sgn = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const padText = () => `${sgn(state.pitch, 1)} ${t('st')} · ${sgn(state.formant, 0)}%`;
const labelFor = () => `${t(state.direction)} · ${padText()} · ${t('textureShort')} ${state.strength.toFixed(2)}`;

// ------------------------------------------------------------ controls
function setDirection(d) {
  state.direction = d;
  setPad(0, PAD_DEFAULT[d]); drawPadGrid();
  $('dirYoung').setAttribute('aria-pressed', d === 'younger');
  $('dirOld').setAttribute('aria-pressed', d === 'older');
  document.documentElement.classList.toggle('older', d === 'older');
  render();
}
// Pitch x formant pad: x = formant shift (%), y = pitch shift (semitones).
// Both are absolute and independent of the texture strength slider.
const PAD = { fMin: -8, fMax: 16, pMin: -2, pMax: 4 };
const PAD_DEFAULT = { younger: 5, older: -4 }; // formant % that matches strength 0.6 of the old single dial
// Rough age model (years; negative = younger). Not fitted to data: weights follow published voice-aging
// trends, scaled so +8 % formant + full texture ≈ 22 years younger, as in the 2026-11-10 blind test.
// Formant ≈ 1.4 yr per %, pitch ≈ 5 yr/st (male) or 7 yr/st (female) up to a knee, texture ≈ 11 yr at 1.0.
const AGE_MODEL = { male: { kP: 5, knee: 1.5, kDown: 4 }, female: { kP: 7, knee: 2, kDown: 5 } };
const K_FORMANT = 1.4, TEX_YOUNG = 11, TEX_OLD = 5;
function pitchYears(p, m) { return p >= 0 ? m.kP * Math.min(p, m.knee) + 0.25 * m.kP * Math.max(0, p - m.knee) : m.kDown * p; }
function ageDelta(f, p) {
  const m = AGE_MODEL[state.f0med > 280 ? 'female' : 'male'];
  const tex = state.direction === 'younger' ? -TEX_YOUNG * state.strength : TEX_OLD * state.strength;
  return -(K_FORMANT * f + pitchYears(p, m)) + tex;
}
const ageText = (d) => (Math.abs(d) < 1 ? t('sameAge') : t(d < 0 ? 'yrsYounger' : 'yrsOlder', { n: Math.round(Math.abs(d)) }))
  + (state.age ? ' · ' + t('ageAbout', { a: Math.round(Math.max(5, state.age + d)) }) : '');
function showAgeGuess() { $('ageGuess').hidden = !state.age; if (state.age) $('ageGuess').textContent = t('ageGuess', { a: state.age }); }
const LEVELS = [-40, -30, -20, -10, 0, 10, 20];
// Likely band: in real voices pitch and formants shift together with age (shorter vocal tract, smaller folds).
// Outside it (high pitch with low formants, or low pitch with high formants) tends to sound unnatural.
const BAND = { slope: 0.2, half: 1.25 }; // centre: +0.2 st per 1 % formant; band ±1.25 st
const inBand = (f, p) => Math.abs(p - BAND.slope * f) <= BAND.half;
const padEl = $('pad'), dotEl = $('padDot');
const fx = (f) => (f - PAD.fMin) / (PAD.fMax - PAD.fMin), py = (p) => 1 - (p - PAD.pMin) / (PAD.pMax - PAD.pMin);
function drawPadGrid() {
  const svg = $('padGrid'), W = padEl.clientWidth, H = padEl.clientHeight;
  if (!W) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let h = '';
  { // shade the two unlikely corners, then dash the band edges
    const up = (f) => BAND.slope * f + BAND.half, lo = (f) => BAND.slope * f - BAND.half;
    const X = (f) => fx(f) * W, Y = (p) => py(Math.max(PAD.pMin, Math.min(PAD.pMax, p))) * H;
    const fs = [PAD.fMin, PAD.fMax];
    h += `<polygon class="unl" points="${X(fs[0])},${Y(PAD.pMax)} ${X(fs[1])},${Y(PAD.pMax)} ${X(fs[1])},${Y(up(fs[1]))} ${X(fs[0])},${Y(up(fs[0]))}"/>`;
    h += `<polygon class="unl" points="${X(fs[0])},${Y(PAD.pMin)} ${X(fs[1])},${Y(PAD.pMin)} ${X(fs[1])},${Y(lo(fs[1]))} ${X(fs[0])},${Y(lo(fs[0]))}"/>`;
    h += `<line class="bandedge" x1="${X(fs[0])}" y1="${Y(up(fs[0]))}" x2="${X(fs[1])}" y2="${Y(up(fs[1]))}"/>`;
    h += `<line class="bandedge" x1="${X(fs[0])}" y1="${Y(lo(fs[0]))}" x2="${X(fs[1])}" y2="${Y(lo(fs[1]))}"/>`;
  }
  for (let f = PAD.fMin; f <= PAD.fMax; f += 4) {
    const x = fx(f) * W; h += `<line class="${f ? 'gl' : 'g0'}" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
    if (f > PAD.fMin && f < PAD.fMax) h += `<text class="tick" x="${x + 3}" y="${H - 6}">${f > 0 ? '+' : ''}${f}%</text>`;
  }
  for (let p = PAD.pMin; p <= PAD.pMax; p += 1) {
    const y = py(p) * H; h += `<line class="${p ? 'gl' : 'g0'}" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`;
    if (p > PAD.pMin && p < PAD.pMax) h += `<text class="tick" x="4" y="${y - 3}">${p > 0 ? '+' : ''}${p} ${t('st')}</text>`;
  }
  // age contours: ageDelta is monotone in formant, so solve for formant at each pitch
  const m = AGE_MODEL[state.f0med > 280 ? 'female' : 'male'];
  const tex = state.direction === 'younger' ? -TEX_YOUNG * state.strength : TEX_OLD * state.strength;
  LEVELS.forEach((L, li) => {
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const p = PAD.pMin + i / 60 * (PAD.pMax - PAD.pMin);
      const f = (tex - L - pitchYears(p, m)) / K_FORMANT;
      if (f >= PAD.fMin && f <= PAD.fMax) pts.push([fx(f) * W, py(p) * H, p, f]);
    }
    if (pts.length < 2 || (state.age && state.age + L < 12)) return;
    h += `<polyline class="iso ${L < 0 ? 'y' : L > 0 ? 'o' : 'z'}" points="${pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ')}"/>`;
    // label each line where it crosses the middle of the likely band
    const off = (q) => Math.abs(q[2] - BAND.slope * q[3]), q = pts.reduce((a, b) => (off(b) < off(a) ? b : a));
    {
      const x = Math.min(W - 14, Math.max(14, q[0]));
      const txt = L === 0 ? (state.age ? `${t('ageNow')} ${state.age}` : t('ageNow'))
        : state.age ? String(Math.max(5, state.age + L)) : `${L > 0 ? '+' : '−'}${Math.abs(L)}`;
      h += `<text class="isolab${L === 0 ? ' now' : ''}" x="${x}" y="${q[1] + 4}" text-anchor="middle">${txt}</text>`;
    }
  });
  svg.innerHTML = h;
}
function setPad(p, f) {
  state.pitch = Math.round(Math.min(PAD.pMax, Math.max(PAD.pMin, p)) * 10) / 10;
  state.formant = Math.round(Math.min(PAD.fMax, Math.max(PAD.fMin, f)) * 2) / 2;
  dotEl.style.left = fx(state.formant) * 100 + '%';
  dotEl.style.top = py(state.pitch) * 100 + '%';
  $('padOut').textContent = padText();
  $('padAge').textContent = ageText(ageDelta(state.formant, state.pitch)) + (inBand(state.formant, state.pitch) ? '' : ' · ' + t('unlikely'));
  padEl.setAttribute('aria-valuetext', t('padValue', { p: sgn(state.pitch, 1), f: sgn(state.formant, 0) }) + ', ' + ageText(ageDelta(state.formant, state.pitch)));
  $('fxLabel').textContent = labelFor();
}
function padFromEvent(e) {
  const r = padEl.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  setPad(PAD.pMin + (1 - v) * (PAD.pMax - PAD.pMin), PAD.fMin + u * (PAD.fMax - PAD.fMin));
}
let padDrag = false;
padEl.addEventListener('pointerdown', (e) => { padDrag = true; padEl.setPointerCapture(e.pointerId); padFromEvent(e); });
padEl.addEventListener('pointermove', (e) => { if (padDrag) padFromEvent(e); });
const padEnd = () => { if (padDrag) { padDrag = false; render(); } };
padEl.addEventListener('pointerup', padEnd);
padEl.addEventListener('pointercancel', padEnd);
let padKeyTimer = 0;
padEl.addEventListener('keydown', (e) => {
  const d = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [0.25, 0], ArrowDown: [-0.25, 0] }[e.key];
  if (!d) return;
  e.preventDefault(); setPad(state.pitch + d[0], state.formant + d[1]);
  clearTimeout(padKeyTimer); padKeyTimer = setTimeout(render, 400);
});
$('padReset').onclick = () => { setPad(0, PAD_DEFAULT[state.direction]); render(); };
new ResizeObserver(drawPadGrid).observe(padEl);
setPad(0, PAD_DEFAULT.younger);

$('dirYoung').onclick = () => setDirection('younger');
$('dirOld').onclick = () => setDirection('older');
$('strength').addEventListener('input', (e) => { state.strength = +e.target.value; $('strengthOut').textContent = state.strength.toFixed(2); $('fxLabel').textContent = labelFor(); $('padAge').textContent = ageText(ageDelta(state.formant, state.pitch)); drawPadGrid(); });
$('strength').addEventListener('change', render);

// ------------------------------------------------------------ recording
let rec = null;
let audioCtx = null;
const getCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

async function startRec() {
  setError('');
  if (!navigator.mediaDevices?.getUserMedia) return setError(t('errNoRec'));
  const ctx = getCtx(); await ctx.resume();
  let stream;
  try {
    const ns = $('nsBox').checked;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: ns, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    return setError(t('errMic'));
  }
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const parts = []; let n = 0; const t0 = performance.now();
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); n += d.length;
    let p = 0; for (let i = 0; i < d.length; i += 8) p = Math.max(p, Math.abs(d[i]));
    $('level').style.width = Math.min(100, p * 140) + '%';
    const s = n / ctx.sampleRate;
    $('timer').innerHTML = `${fmtClock(s)} <small data-i18n="timerMax">${t('timerMax')}</small>`;
    if (s >= MAX_S) stopRec();
  };
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  rec = { stream, src, proc, mute, parts, get n() { return n; }, sr: ctx.sampleRate, t0 };
  $('recBtn').classList.add('on'); $('recBtn').dataset.i18nAria = 'recStop'; $('recBtn').setAttribute('aria-label', t('recStop'));
  $('recHint').dataset.i18n = 'recHintOn'; $('recHint').textContent = t('recHintOn');
}
function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  r.proc.onaudioprocess = null; r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect();
  r.stream.getTracks().forEach(t => t.stop());
  $('recBtn').classList.remove('on'); $('recBtn').dataset.i18nAria = 'recStart'; $('recBtn').setAttribute('aria-label', t('recStart'));
  $('level').style.width = '0';
  $('recHint').dataset.i18n = 'recHint'; $('recHint').textContent = t('recHint');
  const pcm = new Float32Array(r.n); let o = 0; for (const p of r.parts) { pcm.set(p, o); o += p.length; }
  // drop the first 150 ms (button tap)
  loadTake(pcm.subarray(Math.round(0.15 * r.sr)), r.sr, 'recording');
}
$('recBtn').onclick = () => (rec ? stopRec() : startRec());

// ------------------------------------------------------------ files
async function decodeToMono(arrayBuf) {
  const ctx = getCtx();
  const ab = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuf, res, rej); if (p && p.then) p.then(res, rej);
  });
  const ch = ab.numberOfChannels, n = ab.length, pcm = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) pcm[i] += d[i] / ch; }
  return { pcm, sr: ab.sampleRate };
}
$('fileIn').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { getCtx().resume(); const { pcm, sr } = await decodeToMono(await f.arrayBuffer()); loadTake(pcm, sr, f.name); }
  catch (err) { setError(t('errOpen')); }
  e.target.value = '';
});
$('sampleBtn').onclick = async () => {
  try { getCtx().resume(); const { pcm, sr } = await decodeToMono(await (await fetch('sample.wav')).arrayBuffer()); loadTake(pcm, sr, 'sample'); }
  catch (err) { setError(t('errSample')); }
};

// ------------------------------------------------------------ share / report
$('shareBtn').onclick = async () => {
  if (!state.fxBlob) return;
  const name = `younger-voice-${state.direction}-p${Math.round(state.pitch * 100)}c-f${Math.round(state.formant * 10) / 10}pct-t${Math.round(state.strength * 100)}.wav`;
  const file = new File([state.fxBlob], name, { type: 'audio/wav' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
};
function report() {
  const t = state.timings, dur = state.take ? state.take.pcm.length / state.take.sr : 0;
  return [
    `Younger Voice ${VERSION} speed report`,
    `Device: ${navigator.userAgent}`,
    `Cores: ${navigator.hardwareConcurrency || '?'}`,
    `Take: ${dur.toFixed(1)} s at ${state.take ? state.take.sr : '?'} Hz (${state.take ? state.take.label : 'none'}), ${t.chunks || 0} chunk(s)`,
    `Reading the voice: ${t.analyse ? fmtS(t.analyse) : '–'}`,
    `Age effect (${labelFor()}): ${t.render ? fmtS(t.render) : '–'}`,
  ].join('\n');
}
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(report()); $('copyNote').textContent = t('copied'); }
  catch { $('copyNote').textContent = report(); }
};

// ------------------------------------------------------------ offline install
// ------------------------------------------------------------ languages
const langSel = $('langSel');
LANGS.forEach(([code, name]) => { const o = document.createElement('option'); o.value = code; o.textContent = name; langSel.appendChild(o); });
function refreshLang() {
  applyI18n();
  document.title = t('appName');
  $('ver').textContent = t('version', { v: VERSION });
  $('fxLabel').textContent = labelFor();
  if ($('fxState').dataset.done && state.lastMs != null) $('fxState').textContent = t('readyIn', { t: fmtS(state.lastMs) });
  setPad(state.pitch, state.formant); drawPadGrid(); showAgeGuess();
}
langSel.value = LANG;
langSel.addEventListener('change', () => { setLang(langSel.value); refreshLang(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Preview mode (claude.ai page): no microphone, no saving, no offline install
if (window.YV_PREVIEW) {
  document.querySelector('.rec-row').hidden = true;
  $('nsBox').parentElement.hidden = true;
  $('shareBtn').hidden = true;
  $('offlineTag').dataset.i18n = 'pvTag';
  const n = document.createElement('p'); n.className = 'hint';
  n.dataset.i18nHtml = 'pvNote';
  $('takeH').after(n);
  $('foot1').dataset.i18n = 'pvFoot';
  const lbl = document.querySelector('.filebtn'); lbl.className = 'btn primary'; lbl.dataset.i18n = 'pvOpen';
}
refreshLang();
window.__yv = { state, call, loadTake, report }; // for automated tests
