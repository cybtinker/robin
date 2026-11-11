/* Younger Voice PoC: UI, recording, playback. Heavy work runs in worker.js. */
'use strict';
const VERSION = 'poc-2';
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
const state = { direction: 'younger', strength: 0.6, pitch: 0, formant: 5, cues: {}, take: null, timings: {}, fxBlob: null, busy: false, queued: false };
const CUES = [
  ['vibrato', 'Vibrato'], ['jitter', 'Pitch roughness'], ['shimmer', 'Loudness flutter'],
  ['breath', 'Breathiness'], ['tilt', 'Brightness'], ['clarity', 'Clarity'],
];
CUES.forEach(([k, label]) => {
  state.cues[k] = 1;
  const d = document.createElement('label');
  d.className = 'cue';
  d.innerHTML = `<span>${label}</span><output id="cue_${k}_o">1.0×</output><input type="range" id="cue_${k}" min="0" max="2" step="0.1" value="1">`;
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
  if (dur < 1) return setError('That take is under a second long. Sing a phrase or two and try again.');
  if (dur > MAX_S) { pcm = pcm.slice(0, MAX_S * sr); setError(`Only the first ${MAX_S} seconds are used in this test version.`); }
  // normalise peak so quiet takes analyse well
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  if (peak > 0 && peak < 0.5) { const k = 0.5 / peak; pcm = pcm.map(v => v * k); }
  state.take = { pcm, sr, label };
  setAudio($('origAudio'), wavBlob(pcm, sr));
  $('origLen').textContent = `${dur.toFixed(1)} s · ${sr / 1000} kHz`;
  $('sLen').textContent = `${dur.toFixed(1)} s`;
  $('sAna').textContent = $('sFx').textContent = $('sRt').textContent = '–';
  state.busy = true; $('recBtn').disabled = true;
  onProgress = (m) => showProgress(m.stage === 'analyse' ? 'Reading your voice…' : 'Applying the effect…', m.done);
  showProgress('Reading your voice…', 0.02);
  try {
    const t0 = performance.now();
    const r = await call('analyse', { pcm: Float32Array.from(pcm), sr });
    state.timings = { analyse: r.ms, analyseWall: performance.now() - t0, chunks: r.chunks };
    $('sAna').textContent = fmtS(r.ms);
  } catch (e) {
    state.busy = false; $('recBtn').disabled = false; showProgress(null, null);
    state.take = null;
    return setError('Could not read this recording: ' + e.message);
  }
  state.busy = false; $('recBtn').disabled = false;
  render();
}

async function render() {
  if (!state.take) return;
  if (state.busy) { state.queued = true; return; }
  state.busy = true; $('shareBtn').disabled = true;
  const label = labelFor();
  $('fxState').textContent = 'Working…';
  showProgress('Applying the effect…', 0.05);
  try {
    const r = await call('render', { strength: state.strength, direction: state.direction, cues: { ...state.cues, pitch_cents: Math.round(state.pitch * 100), formant_pct: state.formant } });
    state.timings.render = r.ms;
    state.fxBlob = wavBlob(r.pcm, state.take.sr);
    setAudio($('fxAudio'), state.fxBlob);
    $('fxLabel').textContent = label;
    $('fxState').textContent = `ready in ${fmtS(r.ms)}`;
    $('shareBtn').disabled = false;
    const dur = state.take.pcm.length / state.take.sr;
    $('sFx').textContent = fmtS(r.ms);
    $('sRt').textContent = `${((state.timings.analyse + r.ms) / 1000 / dur * 100).toFixed(0)} %`;
  } catch (e) {
    setError('The effect failed: ' + e.message);
    $('fxState').textContent = '';
  }
  showProgress(null, null);
  state.busy = false;
  if (state.queued) { state.queued = false; render(); }
}
const sgn = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const padText = () => `${sgn(state.pitch, 1)} st · ${sgn(state.formant, 0)}%`;
const labelFor = () => `${state.direction === 'younger' ? 'Younger' : 'Older'} · ${padText()} · texture ${state.strength.toFixed(2)}`;

// ------------------------------------------------------------ controls
function setDirection(d) {
  state.direction = d;
  setPad(0, PAD_DEFAULT[d]);
  $('dirYoung').setAttribute('aria-pressed', d === 'younger');
  $('dirOld').setAttribute('aria-pressed', d === 'older');
  document.documentElement.classList.toggle('older', d === 'older');
  render();
}
// Pitch x formant pad: x = formant shift (%), y = pitch shift (semitones).
// Both are absolute and independent of the texture strength slider.
const PAD = { fMin: -8, fMax: 16, pMin: -2, pMax: 4 };
const PAD_DEFAULT = { younger: 5, older: -4 }; // formant % that matches strength 0.6 of the old single dial
const ZONE = { f0: 3, f1: 8, p0: 0, p1: 1 };    // blind test: strength 0.5–0.7 ≈ 20s; keep pitch small (key)
const padEl = $('pad'), dotEl = $('padDot');
const fx = (f) => (f - PAD.fMin) / (PAD.fMax - PAD.fMin), py = (p) => 1 - (p - PAD.pMin) / (PAD.pMax - PAD.pMin);
function drawPadGrid() {
  const svg = $('padGrid'), W = padEl.clientWidth, H = padEl.clientHeight;
  if (!W) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  let h = `<rect class="zone" x="${fx(ZONE.f0) * W}" y="${py(ZONE.p1) * H}" width="${(fx(ZONE.f1) - fx(ZONE.f0)) * W}" height="${(py(ZONE.p0) - py(ZONE.p1)) * H}" rx="6"/>`;
  for (let f = PAD.fMin; f <= PAD.fMax; f += 4) {
    const x = fx(f) * W; h += `<line class="${f ? 'gl' : 'g0'}" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
    if (f > PAD.fMin && f < PAD.fMax) h += `<text class="tick" x="${x + 3}" y="${H - 6}">${f > 0 ? '+' : ''}${f}%</text>`;
  }
  for (let p = PAD.pMin; p <= PAD.pMax; p += 1) {
    const y = py(p) * H; h += `<line class="${p ? 'gl' : 'g0'}" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`;
    if (p > PAD.pMin && p < PAD.pMax) h += `<text class="tick" x="4" y="${y - 3}">${p > 0 ? '+' : ''}${p} st</text>`;
  }
  svg.innerHTML = h;
}
function setPad(p, f) {
  state.pitch = Math.round(Math.min(PAD.pMax, Math.max(PAD.pMin, p)) * 10) / 10;
  state.formant = Math.round(Math.min(PAD.fMax, Math.max(PAD.fMin, f)) * 2) / 2;
  dotEl.style.left = fx(state.formant) * 100 + '%';
  dotEl.style.top = py(state.pitch) * 100 + '%';
  $('padOut').textContent = padText();
  padEl.setAttribute('aria-valuetext', `pitch ${sgn(state.pitch, 1)} semitones, formant ${sgn(state.formant, 0)} percent`);
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
$('strength').addEventListener('input', (e) => { state.strength = +e.target.value; $('strengthOut').textContent = state.strength.toFixed(2); $('fxLabel').textContent = labelFor(); });
$('strength').addEventListener('change', render);

// ------------------------------------------------------------ recording
let rec = null;
let audioCtx = null;
const getCtx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

async function startRec() {
  setError('');
  if (!navigator.mediaDevices?.getUserMedia) return setError('This browser cannot record here. Open the page in Safari (iPhone) or Chrome (Android), or use "Open a recording".');
  const ctx = getCtx(); await ctx.resume();
  let stream;
  try {
    const ns = $('nsBox').checked;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: ns, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    return setError('Microphone access was refused. Allow the microphone for this site in Settings, then try again.');
  }
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const parts = []; let n = 0; const t0 = performance.now();
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); n += d.length;
    let p = 0; for (let i = 0; i < d.length; i += 8) p = Math.max(p, Math.abs(d[i]));
    $('level').style.width = Math.min(100, p * 140) + '%';
    const s = n / ctx.sampleRate;
    $('timer').innerHTML = `${fmtClock(s)} <small>/ 1:30 max</small>`;
    if (s >= MAX_S) stopRec();
  };
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  rec = { stream, src, proc, mute, parts, get n() { return n; }, sr: ctx.sampleRate, t0 };
  $('recBtn').classList.add('on'); $('recBtn').setAttribute('aria-label', 'Stop recording');
  $('recHint').textContent = 'Recording… tap again to stop.';
}
function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  r.proc.onaudioprocess = null; r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect();
  r.stream.getTracks().forEach(t => t.stop());
  $('recBtn').classList.remove('on'); $('recBtn').setAttribute('aria-label', 'Start recording');
  $('level').style.width = '0';
  $('recHint').textContent = 'A cappella, in a quiet room. Hold the phone about 20 cm away.';
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
  catch (err) { setError('Could not open that file. Try a .m4a, .wav or .mp3 recording.'); }
  e.target.value = '';
});
$('sampleBtn').onclick = async () => {
  try { getCtx().resume(); const { pcm, sr } = await decodeToMono(await (await fetch('sample.wav')).arrayBuffer()); loadTake(pcm, sr, 'sample'); }
  catch (err) { setError('Could not load the sample voice.'); }
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
  try { await navigator.clipboard.writeText(report()); $('copyNote').textContent = 'Copied. Paste it into the chat.'; }
  catch { $('copyNote').textContent = report(); }
};

// ------------------------------------------------------------ offline install
$('ver').textContent = `Version ${VERSION}`;
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Preview mode (claude.ai page): no microphone, no saving, no offline install
if (window.YV_PREVIEW) {
  document.querySelector('.rec-row').hidden = true;
  $('nsBox').parentElement.hidden = true;
  $('shareBtn').hidden = true;
  $('offlineTag').textContent = 'Preview · open a recording';
  const n = document.createElement('p'); n.className = 'hint';
  n.innerHTML = 'This preview cannot use the microphone. Record yourself in <b>Voice Memos</b>, tap <b>…</b> → <b>Save to Files</b>, then tap the button below and pick it. Or try the sample voice.';
  $('takeH').after(n);
  document.querySelector('footer p').textContent = 'Preview of the proof of concept. The voice processing runs in this browser; your recording is not uploaded. The installable version adds recording and offline use.';
  const lbl = document.querySelector('.filebtn'); lbl.className = 'btn primary'; lbl.textContent = 'Open a recording';
}
window.__yv = { state, call, loadTake, report }; // for automated tests
