/* Background worker: runs WORLD analysis once, then renders the age effect on demand.
 * Long recordings are cut into ~15 s chunks at quiet moments so memory stays bounded.
 */
importScripts('voicecore.js');
const VC = self.VoiceCore;

let world = null;
let job = null; // { x, sr, chunks: [{start, end, from, to, f0, sp, ap, nb, fft}] }

const CHUNK_S = 15, PAD_S = 0.3, XF_S = 0.02;

async function ensureWorld() {
  if (!world) {
    const bytes = await (await fetch('world.wasm')).arrayBuffer();
    world = await VC.createWorld(bytes);
  }
  return world;
}

// quietest 20 ms window within +-3 s of each 15 s mark
function cutPoints(x, sr) {
  const n = x.length, cuts = [0];
  const win = Math.round(0.02 * sr);
  let pos = CHUNK_S * sr;
  while (pos < n - 5 * sr) {
    let best = pos, bestE = Infinity;
    for (let c = Math.max(cuts[cuts.length - 1] + 5 * sr, pos - 3 * sr); c < Math.min(n - win, pos + 3 * sr); c += win >> 1) {
      let e = 0;
      for (let i = c; i < c + win; i++) e += x[i] * x[i];
      if (e < bestE) { bestE = e; best = c + (win >> 1); }
    }
    cuts.push(Math.round(best));
    pos = best + CHUNK_S * sr;
  }
  cuts.push(n);
  return cuts;
}

async function analyse({ pcm, sr }) {
  const W = await ensureWorld();
  const x = Float64Array.from(pcm);
  const cuts = cutPoints(x, sr);
  const pad = Math.round(PAD_S * sr);
  const chunks = [];
  const t0 = performance.now();
  for (let k = 0; k < cuts.length - 1; k++) {
    const start = cuts[k], end = cuts[k + 1];
    const from = Math.max(0, start - pad), to = Math.min(x.length, end + pad);
    const A = W.analyse(x.subarray(from, to), sr, () => {});
    // keep the analysis in float32 to halve memory; promoted back to float64 per render
    chunks.push({ start, end, from, to, f0: A.f0, sp: Float32Array.from(A.sp), ap: Float32Array.from(A.ap), nb: A.nb, fft: A.fft });
    postMessage({ type: 'progress', stage: 'analyse', done: end / x.length });
  }
  job = { x, sr, chunks };
  return { ms: performance.now() - t0, chunks: chunks.length };
}

function render({ strength, direction, cues }) {
  const { x, sr, chunks } = job;
  const t0 = performance.now();
  const out = new Float64Array(x.length);
  const xf = Math.round(XF_S * sr);
  let prev = null; // previous chunk's output + offset
  chunks.forEach((c, k) => {
    let f0 = c.f0, sp = Float64Array.from(c.sp), ap = Float64Array.from(c.ap);
    if (strength > 0 || cues.pitch_cents || cues.formant_pct) ({ f0, sp, ap } = VC.transform(f0, sp, ap, c.nb, sr, strength, direction, cues, k));
    const y = world.synth(f0, sp, ap, c.fft, sr); // covers [from, from + y.length)
    const val = (i) => { const j = i - c.from; return j >= 0 && j < y.length ? y[j] : 0; };
    for (let i = c.start; i < c.end; i++) out[i] = val(i);
    if (prev && xf > 0) { // crossfade across the cut
      for (let i = Math.max(0, c.start - xf); i < Math.min(x.length, c.start + xf); i++) {
        const w = (i - (c.start - xf)) / (2 * xf);
        out[i] = (1 - w) * prev(i) + w * val(i);
      }
    }
    prev = val;
    postMessage({ type: 'progress', stage: 'render', done: (k + 1) / chunks.length });
  });
  VC.matchLoudness(out, x);
  return { ms: performance.now() - t0, pcm: Float32Array.from(out) };
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    let res;
    if (cmd === 'analyse') res = await analyse(args);
    else if (cmd === 'render') res = render(args);
    else if (cmd === 'warmup') { await ensureWorld(); res = {}; }
    const transfer = res && res.pcm ? [res.pcm.buffer] : [];
    postMessage({ id, ok: true, res }, transfer);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
