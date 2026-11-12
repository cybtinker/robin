/* Fledgling core: WORLD vocoder (WebAssembly) + rule-based age transform.
 * Line-by-line port of rejuvenate.py v2 (step 2 desktop prototype).
 * WORLD (c) M. Morise, modified BSD licence. This file: project code.
 */
(function (root) {
  'use strict';
  const FRAME_MS = 5.0;
  const FRAME_RATE = 1000 / FRAME_MS; // 200 frames/s

  // Butterworth order-2 SOS at fs=200 (scipy.signal.butter), plus sosfilt_zi
  const F = {
    LP: { sos: [[0.0020805671354922925, 0.004161134270984585, 0.0020805671354922925, 1.0, -1.866892279711715, 0.875214548253684]],
          zi: [[0.9979194328645093, -0.8731339811181931]] },
    BP: { sos: [[0.006638303539978171, 0.013276607079956341, 0.006638303539978171, 1.0, -1.7901351968327028, 0.8488206089041218],
                [1.0, -2.0, 1.0, 1.0, -1.908132659934937, 0.9227050367727776]],
          zi: [[0.44582872740798474, -0.3774250371783118], [-0.45246703094796287, 0.45246703094796287]] },
    HP: null, // filled below
  };

  const YOUNGER = { vib_extent: 0.45, vib_rate: 1.10, vib_regular: 1.0, jitter: 0.1, shimmer: 0.15,
    breath_db: -14.0, tilt_db: 8.0, formant: 1.08, clarity: 0.35 };
  const OLDER = { vib_extent: 2.2, vib_rate: 0.82, vib_regular: 0.0, vib_wobble: 0.7, jitter: 4.0, shimmer: 3.5,
    breath_db: 10.0, tilt_db: -7.0, formant: 0.93, clarity: -0.3 };

  // ---------------------------------------------------------------- filters
  function sosfilt(sos, x, zi0) {
    let y = Float64Array.from(x);
    for (let s = 0; s < sos.length; s++) {
      const [b0, b1, b2, , a1, a2] = sos[s];
      let z0 = zi0[s][0], z1 = zi0[s][1];
      for (let i = 0; i < y.length; i++) {
        const xi = y[i];
        const yi = b0 * xi + z0;
        z0 = b1 * xi - a1 * yi + z1;
        z1 = b2 * xi - a2 * yi;
        y[i] = yi;
      }
    }
    return y;
  }
  // scipy sosfiltfilt with odd extension and padlen = min(n-1, 6*nsec)
  function filt(f, x) {
    const n = x.length;
    const pad = Math.min(n - 1, 3 * 2 * f.sos.length);
    const ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
    ext.set(x, pad);
    for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    const zi = (v) => f.zi.map(r => [r[0] * v, r[1] * v]);
    let y = sosfilt(f.sos, ext, zi(ext[0]));
    y.reverse();
    y = sosfilt(f.sos, y, zi(y[0]));
    y.reverse();
    return y.slice(pad, pad + n);
  }

  // ---------------------------------------------------------------- FFT (any length, Bluestein)
  function fftPow2(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inv ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  function dft(re, im, inv) { // in place, any n; inverse is unscaled
    const n = re.length;
    if ((n & (n - 1)) === 0) return fftPow2(re, im, inv);
    let m = 1; while (m < 2 * n - 1) m <<= 1;
    const sgn = inv ? 1 : -1;
    const wr = new Float64Array(n), wi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.PI * ((k * k) % (2 * n)) / n;
      wr[k] = Math.cos(a); wi[k] = sgn * Math.sin(a);
    }
    const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
    for (let k = 0; k < n; k++) {
      ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k];
      br[k] = wr[k]; bi[k] = -wi[k];
      if (k) { br[m - k] = wr[k]; bi[m - k] = -wi[k]; }
    }
    fftPow2(ar, ai, false); fftPow2(br, bi, false);
    for (let i = 0; i < m; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
    fftPow2(ar, ai, true);
    for (let k = 0; k < n; k++) {
      const r = ar[k] / m, i = ai[k] / m;
      re[k] = r * wr[k] - i * wi[k]; im[k] = r * wi[k] + i * wr[k];
    }
  }
  function hilbert(x) { // scipy.signal.hilbert -> [re, im]
    const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
    dft(re, im, false);
    for (let k = 0; k < n; k++) {
      let h;
      if (k === 0) h = 1;
      else if (n % 2 === 0) h = k < n / 2 ? 2 : (k === n / 2 ? 1 : 0);
      else h = k < (n + 1) / 2 ? 2 : 0;
      re[k] *= h; im[k] *= h;
    }
    dft(re, im, true);
    for (let k = 0; k < n; k++) { re[k] /= n; im[k] /= n; }
    return [re, im];
  }

  // ---------------------------------------------------------------- numpy helpers
  function hann(nInner) { // np.hanning(n+2)[1:-1], normalised
    const M = nInner + 2, k = new Float64Array(nInner);
    let s = 0;
    for (let i = 0; i < nInner; i++) { k[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (M - 1)); s += k[i]; }
    for (let i = 0; i < nInner; i++) k[i] /= s;
    return k;
  }
  // np.convolve(np.pad(x,(n,n),'edge'), k, 'same')[n:-n] for a kernel of length n
  function edgeConv(x, k, out, xOff, outOff, L) {
    const n = k.length, c = (n - 1) >> 1;
    for (let j = 0; j < L; j++) {
      // y[j] = sum_t xp[j + n + c - t] * k[t], xp index p -> x index clamp(p - n)
      let acc = 0;
      const base = j + c;
      for (let t = 0; t < n; t++) {
        let q = base - t; if (q < 0) q = 0; else if (q >= L) q = L - 1;
        acc += x[xOff + q] * k[t];
      }
      out[outOff + j] = acc;
    }
  }
  function smooth(x, seconds) {
    const n = Math.max(1, Math.floor(seconds * FRAME_RATE));
    if (n <= 1 || x.length < n) return Float64Array.from(x);
    const out = new Float64Array(x.length);
    edgeConv(x, hann(n), out, 0, 0, x.length);
    return out;
  }
  function gradient(x) {
    const n = x.length, g = new Float64Array(n);
    if (n < 2) return g;
    g[0] = x[1] - x[0]; g[n - 1] = x[n - 1] - x[n - 2];
    for (let i = 1; i < n - 1; i++) g[i] = (x[i + 1] - x[i - 1]) / 2;
    return g;
  }
  function unwrap(p) {
    const n = p.length, out = new Float64Array(n);
    out[0] = p[0];
    let corr = 0;
    for (let i = 1; i < n; i++) {
      const d = p[i] - p[i - 1];
      let dd = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      if (dd === -Math.PI && d > 0) dd = Math.PI;
      let c = dd - d;
      if (Math.abs(d) < Math.PI) c = 0;
      corr += c;
      out[i] = p[i] + corr;
    }
    return out;
  }
  function voicedSegments(f0, minLen = 40) {
    const segs = []; let start = -1;
    for (let i = 0; i <= f0.length; i++) {
      const on = i < f0.length && f0[i] > 0;
      if (on && start < 0) start = i;
      else if (!on && start >= 0) { if (i - start >= minLen) segs.push([start, i]); start = -1; }
    }
    return segs;
  }
  function steadyMask(cents) {
    const base = filt(F.LP, cents), g = gradient(base);
    const m = new Float64Array(cents.length);
    for (let i = 0; i < m.length; i++) m[i] = Math.abs(g[i]) * FRAME_RATE < 250 ? 1 : 0;
    const s = smooth(m, 0.08);
    for (let i = 0; i < s.length; i++) s[i] = Math.min(1, Math.max(0, s[i]));
    return s;
  }

  // Simple seeded RNG (older direction only; does not match numpy's stream)
  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    const u = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s + 0.5) / 4294967296; };
    return { normal() { return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()); } };
  }
  const randn = (rng, n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = rng.normal(); return a; };

  // ---------------------------------------------------------------- transform
  // f0: Float64Array(nf); sp, ap: Float64Array(nf*nb) row-major. Returns new arrays.
  function transform(f0In, spIn, apIn, nb, sr, strength = 0.6, direction = 'younger', cues = {}, seed = 0) {
    const C = Object.assign({ vibrato: 1, jitter: 1, shimmer: 1, breath: 1, tilt: 1, formant: 1, clarity: 1, pitch_cents: 0, formant_pct: null,
      wobble_pct: 0, hnr_db: 0 }, cues);
    const P = direction === 'younger' ? YOUNGER : OLDER;
    const s = +strength, older = direction === 'older';
    const rng = makeRng(seed + 1);
    const lerp = (target, slider) => Math.max(0.02, 1 + (target - 1) * s * slider); // never flip a cue past zero at high strength
    const f0 = Float64Array.from(f0In), sp = Float64Array.from(spIn), ap = Float64Array.from(apIn);
    const nf = f0.length;
    const freqs = new Float64Array(nb);
    for (let i = 0; i < nb; i++) freqs[i] = (sr / 2) * i / (nb - 1);

    // --- pitch: vibrato, jitter
    const ext = lerp(P.vib_extent, C.vibrato), rate = lerp(P.vib_rate, C.vibrato);
    const regular = Math.min(1, (P.vib_regular || 0) * s * C.vibrato);
    const wobble = (P.vib_wobble || 0) * s * C.vibrato;
    const jitK = Math.max(0, lerp(P.jitter, C.jitter));
    for (const [a, b] of voicedSegments(f0)) {
      const L = b - a, cents = new Float64Array(L);
      for (let i = 0; i < L; i++) cents[i] = 1200 * Math.log2(f0[a + i]);
      const base = filt(F.LP, cents);
      const resid = cents.map((c, i) => c - base[i]);
      const vib = filt(F.BP, resid), jit = filt(F.HP, resid);
      const [hr, hi] = hilbert(vib);
      let amp = new Float64Array(L), ph = new Float64Array(L);
      for (let i = 0; i < L; i++) { amp[i] = Math.hypot(hr[i], hi[i]); ph[i] = Math.atan2(hi[i], hr[i]); }
      let phase = unwrap(ph);
      const ampS = smooth(amp, 0.35);
      for (let i = 0; i < L; i++) amp[i] = (1 - regular) * amp[i] + regular * ampS[i];
      // linear fit of phase
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < L; i++) { sx += i; sy += phase[i]; sxx += i * i; sxy += i * phase[i]; }
      const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx), icpt = (sy - slope * sx) / L;
      for (let i = 0; i < L; i++) phase[i] = (1 - regular) * phase[i] + regular * (slope * i + icpt);
      if (wobble > 0) {
        const w1 = smooth(randn(rng, L), 0.4); let m1 = 0; for (const v of w1) m1 = Math.max(m1, Math.abs(v));
        for (let i = 0; i < L; i++) amp[i] *= 1 + wobble * w1[i] / (m1 + 1e-9);
        const w2 = smooth(randn(rng, L), 0.5); let m2 = 0; for (const v of w2) m2 = Math.max(m2, Math.abs(v));
        let cs = 0;
        for (let i = 0; i < L; i++) { cs += w2[i] / (m2 + 1e-9); phase[i] += wobble * 2.5 * cs / FRAME_RATE * 2 * Math.PI; }
      }
      const m = steadyMask(cents);
      for (let i = 0; i < L;) { // re-time vibrato phase inside each held run
        if (m[i] > 0) {
          let j = i; while (j < L && m[j] > 0) j++;
          const p0 = phase[i];
          for (let k = i; k < j; k++) phase[k] = p0 + (phase[k] - p0) * rate;
          i = j;
        } else i++;
      }
      for (let i = 0; i < L; i++) {
        const vNew = ext * amp[i] * Math.cos(phase[i]);
        let jNew = jit[i] * jitK;
        if (older) jNew += (jitK - 1) * 3.0 * rng.normal();
        f0[a + i] = Math.pow(2, (cents[i] + m[i] * ((vNew - vib[i]) + (jNew - jit[i]))) / 1200);
      }
    }
    // steadiness: scale how far pitch wanders around the sung melody (vibrato + drift + jitter), absolute, in %
    if (C.wobble_pct) {
      const g = Math.max(0, 1 + C.wobble_pct / 100);
      for (const [a, b] of voicedSegments(f0)) {
        const L = b - a, cents = new Float64Array(L);
        for (let i = 0; i < L; i++) cents[i] = 1200 * Math.log2(f0[a + i]);
        const base = filt(F.LP, cents);
        for (let i = 0; i < L; i++) f0[a + i] = Math.pow(2, (base[i] + g * (cents[i] - base[i])) / 1200);
      }
    }
    if (C.pitch_cents) { const k = Math.pow(2, C.pitch_cents / 1200); for (let i = 0; i < nf; i++) if (f0[i] > 0) f0[i] *= k; }
    if (C.robot_hz > 0) for (let i = 0; i < nf; i++) if (f0[i] > 0) f0[i] = C.robot_hz; // prank: one flat note

    // --- shimmer
    const shK = Math.max(0, lerp(P.shimmer, C.shimmer));
    if (shK !== 1) {
      for (const [a, b] of voicedSegments(f0)) {
        const L = b - a, le = new Float64Array(L);
        for (let i = 0; i < L; i++) { let t = 0; const o = (a + i) * nb; for (let k = 0; k < nb; k++) t += sp[o + k]; le[i] = Math.log(t + 1e-12); }
        let fast = filt(F.HP, le);
        if (older) { const r = smooth(randn(rng, L), 0.015); fast = fast.map((v, i) => v + 0.03 * (shK - 1) * r[i]); }
        for (let i = 0; i < L; i++) { const g = Math.exp((shK - 1) * fast[i]), o = (a + i) * nb; for (let k = 0; k < nb; k++) sp[o + k] *= g; }
      }
    }

    // --- breathiness
    const bDb = P.breath_db * s * C.breath;
    if (bDb) {
      const g = freqs.map(f => Math.pow(10, bDb * Math.min(1, Math.max(0.3, 1.2 - f / 6000)) / 20));
      for (let i = 0; i < nf; i++) if (f0[i] > 0) {
        const o = i * nb;
        for (let k = 0; k < nb; k++) ap[o + k] = Math.min(1 - 1e-6, Math.max(1e-3, ap[o + k] * g[k]));
      }
    }

    // clarity in dB of harmonics-to-noise: lower aperiodicity by that much, absolute
    if (C.hnr_db) {
      const g = Math.pow(10, -C.hnr_db / 20);
      for (let i = 0; i < nf; i++) if (f0[i] > 0) { const o = i * nb; for (let k = 0; k < nb; k++) ap[o + k] = Math.min(1 - 1e-6, Math.max(1e-3, ap[o + k] * g)); }
    }

    // --- formant stretch (np.interp on the log envelope)
    // formant_pct (if given) sets the vocal-tract stretch directly, independent of strength,
    // so pitch and formant can be explored as two separate axes.
    const alpha = (C.formant_pct != null) ? 1 + C.formant_pct / 100 : lerp(P.formant, C.formant);
    if (Math.abs(alpha - 1) > 1e-4) {
      const df = freqs[1] - freqs[0];
      const idx = new Int32Array(nb), fr = new Float64Array(nb);
      for (let k = 0; k < nb; k++) {
        const src = Math.min(freqs[nb - 1], Math.max(0, freqs[k] / alpha));
        let j = Math.min(nb - 2, Math.floor(src / df));
        // guard against rounding at grid points
        while (j < nb - 2 && freqs[j + 1] <= src) j++;
        while (j > 0 && freqs[j] > src) j--;
        idx[k] = j; fr[k] = (src - freqs[j]) / (freqs[j + 1] - freqs[j]);
      }
      const ls = new Float64Array(nb), la = new Float64Array(nb);
      for (let i = 0; i < nf; i++) {
        const o = i * nb;
        for (let k = 0; k < nb; k++) { ls[k] = Math.log(sp[o + k]); la[k] = Math.log(ap[o + k]); }
        for (let k = 0; k < nb; k++) {
          const j = idx[k], t = fr[k];
          sp[o + k] = Math.exp(ls[j] + t * (ls[j + 1] - ls[j]));
          ap[o + k] = Math.exp(la[j] + t * (la[j + 1] - la[j]));
        }
      }
    }

    // --- clarity: formant peak contrast around a ~600 Hz moving average
    const c = P.clarity * s * C.clarity;
    if (c) {
      const width = Math.max(3, Math.floor(600 / (freqs[1] - freqs[0])));
      const k = hann(width), ls = new Float64Array(nb), env = new Float64Array(nb);
      for (let i = 0; i < nf; i++) {
        if (!(f0[i] > 0)) continue;
        const o = i * nb;
        for (let q = 0; q < nb; q++) ls[q] = Math.log(sp[o + q] + 1e-20);
        edgeConv(ls, k, env, 0, 0, nb);
        for (let q = 0; q < nb; q++) {
          const gq = freqs[q] < 200 ? 0 : c;
          sp[o + q] = Math.exp(ls[q] + gq * (ls[q] - env[q]));
        }
      }
    }

    // --- spectral tilt
    const tDb = P.tilt_db * s * C.tilt;
    if (tDb) {
      const g = freqs.map(f => {
        const op = Math.min(1, Math.max(0, Math.log2(Math.max(f, 1) / 500) / 4));
        return Math.pow(10, tDb * (0.5 - 0.5 * Math.cos(Math.PI * op)) / 10);
      });
      for (let i = 0; i < nf; i++) { const o = i * nb; for (let q = 0; q < nb; q++) sp[o + q] *= g[q]; }
    }
    return { f0, sp, ap };
  }


  // ---------------------------------------------------------------- voice features: pitch, steadiness, clarity
  function voiceFeatures(f0, sp, ap, nb, sr) {
    const freqs = new Float64Array(nb);
    for (let i = 0; i < nb; i++) freqs[i] = (sr / 2) * i / (nb - 1);
    const voiced = []; for (let i = 0; i < f0.length; i++) if (f0[i] > 0) voiced.push(f0[i]);
    if (voiced.length < 40) return null;
    const sorted = voiced.slice().sort((a, b) => a - b), f0med = sorted[sorted.length >> 1];
    let jitSum = 0, jitN = 0, shSum = 0, shN = 0;
    for (const [a, b] of voicedSegments(f0)) {
      const L = b - a, cents = new Float64Array(L), le = new Float64Array(L);
      for (let i = 0; i < L; i++) {
        cents[i] = 1200 * Math.log2(f0[a + i]);
        let tE = 0; const o = (a + i) * nb; for (let k = 0; k < nb; k++) tE += sp[o + k]; le[i] = Math.log(tE + 1e-12);
      }
      const jh = filt(F.HP, cents), sh = filt(F.HP, le);
      for (let i = 0; i < L; i++) { jitSum += jh[i] * jh[i]; shSum += sh[i] * sh[i]; }
      jitN += L; shN += L;
    }
    let apS = 0, apN = 0, tilt = 0, tN = 0;
    for (let i = 0; i < f0.length; i++) {
      if (!(f0[i] > 0)) continue;
      const o = i * nb; let lo = 0, hi = 0;
      for (let k = 0; k < nb; k++) {
        const fq = freqs[k];
        if (fq >= 500 && fq <= 3000) { apS += ap[o + k]; apN++; }
        if (fq >= 100 && fq < 1500) lo += sp[o + k]; else if (fq >= 3000 && fq < 6000) hi += sp[o + k];
      }
      tilt += 10 * Math.log10((hi + 1e-20) / (lo + 1e-20)); tN++;
    }
    let wSum = 0, wN = 0; // pitch wander around the melody line, in semitones (RMS)
    for (const [a, b] of voicedSegments(f0)) {
      const L = b - a, cents = new Float64Array(L);
      for (let i = 0; i < L; i++) cents[i] = 1200 * Math.log2(f0[a + i]);
      const base = filt(F.LP, cents);
      for (let i = 0; i < L; i++) { const d = (cents[i] - base[i]) / 100; wSum += d * d; } wN += L;
    }
    const breath = apS / Math.max(1, apN);
    return { f0med, jitter: Math.sqrt(jitSum / Math.max(1, jitN)), shimmer: Math.sqrt(shSum / Math.max(1, shN)),
      breath, tilt: tilt / Math.max(1, tN), wobble: Math.sqrt(wSum / Math.max(1, wN)), hnr: -20 * Math.log10(Math.max(1e-4, breath)) };
  }

  function matchLoudness(y, ref) {
    const rms = z => { let s = 0; for (const v of z) s += v * v; return Math.sqrt(s / z.length + 1e-12); };
    const k = rms(ref) / rms(y);
    let peak = 0;
    for (let i = 0; i < y.length; i++) { y[i] *= k; peak = Math.max(peak, Math.abs(y[i])); }
    if (peak > 0.98) for (let i = 0; i < y.length; i++) y[i] *= 0.98 / peak;
    return y;
  }

  // ---------------------------------------------------------------- WORLD (wasm) wrapper
  async function createWorld(wasmBytes) {
    const env = { sin: Math.sin, cos: Math.cos, exp: Math.exp, log: Math.log, log10: Math.log10,
      pow: Math.pow, atan: Math.atan, fmod: (a, b) => a % b };
    const { instance } = await WebAssembly.instantiate(wasmBytes, { env });
    const X = instance.exports;
    const heap = () => new Float64Array(X.memory.buffer);
    const put = (arr) => { const p = X.walloc(arr.length * 8); heap().set(arr, p >> 3); return p; };
    const get = (p, n) => heap().slice(p >> 3, (p >> 3) + n);
    const alloc = (n) => X.walloc(n * 8);

    function analyse(x, fs, onStep = () => {}) {
      const px = put(x), n = x.length;
      const nf = X.harvest_len(fs, n, FRAME_MS);
      const pt = alloc(nf), pf = alloc(nf);
      const t0 = performance.now();
      X.harvest(px, n, fs, 60.0, 1100.0, FRAME_MS, pt, pf);
      const t1 = performance.now(); onStep('pitch', t1 - t0);
      const fft = X.ct_fft_size(fs, 71.0), nb = fft / 2 + 1;
      const psp = alloc(nf * nb);
      X.cheaptrick(px, n, fs, pt, pf, nf, fft, psp);
      const t2 = performance.now(); onStep('envelope', t2 - t1);
      const pap = alloc(nf * nb);
      X.d4c(px, n, fs, pt, pf, nf, fft, 0.85, pap);
      const t3 = performance.now(); onStep('aperiodicity', t3 - t2);
      const out = { f0: get(pf, nf), sp: get(psp, nf * nb), ap: get(pap, nf * nb), nb, fft, fs };
      [px, pt, pf, psp, pap].forEach(p => X.wfree(p));
      return out;
    }
    function synth(f0, sp, ap, fft, fs) {
      const nf = f0.length, ylen = Math.floor(nf * FRAME_MS * fs / 1000);
      const a = put(f0), b = put(sp), c = put(ap), py = alloc(ylen);
      heap().fill(0, py >> 3, (py >> 3) + ylen);
      X.synth(a, nf, b, c, fft, FRAME_MS, fs, ylen, py);
      const y = get(py, ylen);
      [a, b, c, py].forEach(p => X.wfree(p));
      return y;
    }
    return { analyse, synth, memory: X.memory };
  }

  F.HP = { sos: [[0.7655999879134588, -1.5311999758269177, 0.7655999879134588, 1.0, -1.475480443592646, 0.5869195080611902]], zi: [[-0.7655999879134588, 0.7655999879134588]] };
  const VoiceCore = { createWorld, transform, matchLoudness, voiceFeatures, FRAME_MS, _F: F, _internals: { filt, hilbert, smooth, steadyMask, unwrap } };
  root.VoiceCore = VoiceCore;
  if (typeof module !== 'undefined') module.exports = VoiceCore;
})(typeof self !== 'undefined' ? self : globalThis);
