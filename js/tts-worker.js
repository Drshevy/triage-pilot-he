// On-device Hebrew neural TTS worker (module worker; all assets are served from this site).
//   text → renikud G2P (ONNX; port of renikud-onnx/__init__.py) → stressed IPA
//        → Piper VITS "noa" (ONNX) → Float32 PCM @ 22.05 kHz
// Messages: {type:'init'} → progress… ready | {type:'synth', id, text, rate} → {type:'audio', id, pcm, sampleRate, ipa}
import * as ort from '../vendor/tts/ort/ort.wasm.min.mjs';

const BASE = new URL('../vendor/tts/', import.meta.url).href;
ort.env.wasm.wasmPaths = BASE + 'ort/';
ort.env.wasm.numThreads = 1;          // GitHub Pages is not cross-origin isolated → no SharedArrayBuffer
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

let g2p, voice, meta, cfg, initP;

async function fetchBuf(url, label, share) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total); let got = 0; const rd = res.body.getReader();
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    out.set(value, got); got += value.length;
    postMessage({ type: 'progress', label, loaded: got, total, share });
  }
  return out;
}

async function init() {
  [meta, cfg] = await Promise.all([
    fetch(BASE + 'models/renikud-meta.json').then(r => r.json()),
    fetch(BASE + 'models/he_IL-noa-medium.onnx.json').then(r => r.json())
  ]);
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [g, v] = await Promise.all([
    fetchBuf(BASE + 'models/renikud.onnx', 'g2p', 0.2),
    fetchBuf(BASE + 'models/he_IL-noa-medium.onnx', 'voice', 0.8)
  ]);
  g2p = await ort.InferenceSession.create(g, opts);
  voice = await ort.InferenceSession.create(v, opts);
}

// ---------------- renikud G2P ----------------
const isHeb = c => c >= 'א' && c <= 'ת';
const STRESS = 'ˈ';
const normalizeGraphemes = t => t.replace(/[׳'`´]/g, "'").replace(/[״"“”]/g, '"');
const argmax = (arr, off, n) => { let b = 0, bv = -Infinity; for (let i = 0; i < n; i++) if (arr[off + i] > bv) { bv = arr[off + i]; b = i; } return b; };

async function phonemize(text) {
  text = normalizeGraphemes(text);
  const s = text.normalize('NFD');
  const chars = Array.from(s);                    // Hebrew letters/niqqud are BMP → index == code unit index
  const unk = meta.vocab['[UNK]'] ?? 0;
  const ids = [meta.cls_token_id, ...chars.map(c => meta.vocab[c] ?? unk), meta.sep_token_id];
  const N = ids.length;
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, N]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(N).fill(1n), [1, N])
  };
  const out = await g2p.run(feeds);
  const C = out.consonant_logits, V = out.vowel_logits, S = out.stress_logits;
  const nc = C.dims[2], nv = V.dims[2], ns = S.dims[2];
  // stress: per whitespace word, the char token with max stress logit (class 1)
  const stressed = new Set(); let best = -1, bestV = -Infinity;
  for (let i = 0; i <= chars.length; i++) {
    const c = chars[i];
    if (c === undefined || /\s/.test(c)) { if (best >= 0) stressed.add(best); best = -1; bestV = -Infinity; continue; }
    const tok = i + 1, v = S.data[tok * ns + 1];
    if (v > bestV) { bestV = v; best = tok; }
  }
  let res = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], tok = i + 1;
    if (!isHeb(ch)) { if (ch !== "'" && ch !== '"') res += ch; continue; }
    let cid = argmax(C.data, tok * nc, nc);
    const allowed = meta.letter_consonant_constraints[ch];
    if (allowed && !allowed.includes(cid)) cid = allowed.reduce((a, b) => (C.data[tok * nc + b] > C.data[tok * nc + a] ? b : a), allowed[0]);
    let cons = meta.consonant_vocab[cid] ?? '∅';
    if (meta.geresh_map[ch] && chars[i + 1] === "'") cons = meta.geresh_map[ch];
    const vow = meta.vowel_vocab[argmax(V.data, tok * nv, nv)] ?? '∅';
    const st = stressed.has(tok);
    const next = chars[i + 1];
    const wordFinal = next === undefined || !/\p{L}/u.test(next);
    if (ch === 'ח' && wordFinal && vow === 'a') res += (st ? STRESS : '') + 'aχ';
    else res += (cons !== '∅' ? cons : '') + (st ? STRESS : '') + (vow !== '∅' ? vow : '');
  }
  return res;
}

// ---------------- Piper ----------------
async function synth(text, rate = 1) {
  const ipa = await phonemize(text);
  const m = cfg.phoneme_id_map, pad = m['_'][0];
  const ids = [m['^'][0]];
  for (const c of Array.from(ipa.normalize('NFD'))) { const id = m[c]; if (id) { ids.push(...id, pad); } }
  ids.push(m['$'][0]);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / rate, inf.noise_w ?? 0.8]), [3])
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(cfg.speaker_id_map?.noa ?? 0)]), [1]);
  const out = await voice.run(feeds);
  const pcm = Float32Array.from(out[voice.outputNames[0]].data);
  return { pcm, ipa, sampleRate: cfg.audio.sample_rate };
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      initP ||= init(); await initP;
      postMessage({ type: 'ready' });
    } else if (data.type === 'synth') {
      initP ||= init(); await initP;
      const t0 = performance.now();
      const r = await synth(data.text, data.rate);
      postMessage({ type: 'audio', id: data.id, ...r, ms: performance.now() - t0 }, [r.pcm.buffer]);
    } else if (data.type === 'phonemize') {
      initP ||= init(); await initP;
      postMessage({ type: 'ipa', id: data.id, ipa: await phonemize(data.text) });
    }
  } catch (e) {
    postMessage({ type: 'error', id: data.id, message: String(e?.message || e) });
  }
};
