/* Opt-in research log, kept on this phone only. Nothing is uploaded.
 * Each take and each try (rendered version) is added to a CSV with a random ID made on this phone; the audio
 * (24 kHz mono WAV) is kept alongside unless the tester turns voice recordings off. "Send research log" puts log.csv + audio into one .zip and opens the
 * share sheet, so the tester can send it to the researcher by mail or chat. No name, email, IP or file names.
 */
'use strict';
const Research = (() => {
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  let device = store.get('yv-device');
  if (!device) { device = uuid(); store.set('yv-device', device); }
  let optedIn = store.get('yv-research') === '1';
  let withAudio = store.get('yv-audio') !== '0'; // tester's choice: keep voice recordings, or numbers only
  let take = null;

  // ---- IndexedDB: rows (one per try) and audio blobs
  let dbp = null;
  const db = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('yv-research', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('rows', { keyPath: 'try_id' }); r.result.createObjectStore('audio'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (stores, mode, fn) => { const d = await db(); return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); const out = fn(t); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); };

  async function to24k(pcm, sr) {
    const OAC = self.OfflineAudioContext || self.webkitOfflineAudioContext;
    if (!OAC || sr === 24000) return { pcm, sr };
    const n = Math.ceil(pcm.length * 24000 / sr), ctx = new OAC(1, n, 24000);
    const buf = ctx.createBuffer(1, pcm.length, sr); buf.copyToChannel(Float32Array.from(pcm), 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    const out = await ctx.startRendering(); return { pcm: out.getChannelData(0), sr: 24000 };
  }
  function newTake(pcm, sr, meta, wavOf) { take = { id: uuid(), pcm, sr, meta, wavOf, saved: null }; }
  function saveTake() {
    if (!take.saved) { const tk = take; tk.saved = (async () => {
      const a = await to24k(tk.pcm, tk.sr);
      await tx(['audio'], 'readwrite', t => t.objectStore('audio').put(tk.wavOf(a.pcm, a.sr), `${tk.id}/original.wav`));
    })(); }
    return take.saved;
  }
  async function logTry(pcm, sr, s) {
    if (!optedIn || !take) return null;
    if (withAudio) await saveTake();
    const id = uuid(), a = withAudio ? await to24k(pcm, sr) : null, m = take.meta;
    const row = { created_at: new Date().toISOString(), device_id: device, take_id: take.id, try_id: id,
      original_age_guess: m.age, self_rated_age: s.self_rated_age ?? '', duration_s: +(take.pcm.length / take.sr).toFixed(2), f0_median: m.f0med ? Math.round(m.f0med) : '',
      source: m.source, direction: s.direction, pitch_st: s.pitch_st, formant_pct: s.formant_pct, texture: s.texture,
      est_delta_years: s.est_delta_years, est_age: s.est_age, lang: s.lang, app_version: m.version,
      original_audio: a ? `audio/${take.id}/original.wav` : '', try_audio: a ? `audio/${take.id}/${id}.wav` : '', cues: JSON.stringify(s.cues) };
    await tx(['rows', 'audio'], 'readwrite', t => { t.objectStore('rows').put(row); if (a) t.objectStore('audio').put(take.wavOf(a.pcm, a.sr), `${take.id}/${id}.wav`); });
    return id;
  }
  const count = () => tx(['rows'], 'readonly', t => t.objectStore('rows').count()).catch(() => 0);

  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
  }
  // ---- minimal zip writer (stored, no compression)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function zip(files) { // [{ name, data: Blob|string }]
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
      const name = enc.encode(f.name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, off, true);
      central.push(c.buffer, name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((n, b) => n + (b.byteLength ?? b.length), 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
  }
  // What would be sent: rows (audio columns blanked where no file is included) + the audio files, if the tester allows audio.
  async function collect() {
    const rows = (await tx(['rows'], 'readonly', t => t.objectStore('rows').getAll())).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const d = await db();
    const keys = withAudio ? await new Promise((res, rej) => { const r = d.transaction('audio').objectStore('audio').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }) : [];
    const have = new Set(keys.map(k => `audio/${k}`));
    for (const r of rows) { if (!have.has(r.original_audio)) r.original_audio = ''; if (!have.has(r.try_audio)) r.try_audio = ''; }
    return { rows, keys };
  }
  async function exportZip() {
    const { rows, keys } = await collect();
    const files = [{ name: 'log.csv', data: '\ufeff' + toCsv(rows) }];
    for (const k of keys) { const blob = await getAudio(k); if (blob) files.push({ name: `audio/${k}`, data: blob }); }
    return { blob: await zip(files), rows: rows.length };
  }
  async function review() { // everything that would be sent, for the confirm screen
    const { rows, keys } = await collect();
    let bytes = 0;
    for (const k of keys) { const b = await getAudio(k); bytes += b ? b.size : 0; }
    return { rows, files: keys.length, bytes, csv: toCsv(rows), keys: new Set(keys) };
  }
  const getAudio = async (k) => { const d = await db(); return new Promise((res, rej) => { const r = d.transaction('audio').objectStore('audio').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); };
  const clearAudio = async () => { await tx(['audio'], 'readwrite', t => t.objectStore('audio').clear()); if (take) take.saved = null; };
  const clear = () => tx(['rows', 'audio'], 'readwrite', t => { t.objectStore('rows').clear(); t.objectStore('audio').clear(); });
  return { device, get optedIn() { return optedIn; }, setOptIn(v) { optedIn = !!v; store.set('yv-research', optedIn ? '1' : '0'); },
    get withAudio() { return withAudio; }, setAudio(v) { withAudio = !!v; store.set('yv-audio', withAudio ? '1' : '0'); },
    newTake, logTry, count, exportZip, clear, clearAudio, review, getAudio, _toCsv: toCsv };
})();
