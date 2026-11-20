// Main-thread client for the on-device Hebrew neural TTS worker (js/tts-worker.js).
// Lazy: nothing is downloaded until load() is called (only when no device Hebrew voice exists or the user picks it).
// Assets (~113 MB, cached by the browser after the first load) are served from this site: ONNX Runtime Web (MIT),
// renikud G2P (CC BY 4.0), Piper "noa" voice (CC BY 4.0). See vendor/tts/LICENSES.txt.

let worker = null, readyP = null, seq = 0;
const pending = new Map();
const listeners = new Set();
export const neural = { state: 'idle', progress: 0, error: null, lastMs: 0 };

function emit() { listeners.forEach(f => { try { f(neural); } catch {} }); }
export function onNeuralStatus(f) { listeners.add(f); return () => listeners.delete(f); }

export function neuralSupported() {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object' && typeof BigInt64Array !== 'undefined';
}

export function loadNeural() {
  if (readyP) return readyP;
  if (!neuralSupported()) { neural.state = 'error'; neural.error = 'unsupported'; emit(); return (readyP = Promise.reject(new Error('unsupported'))); }
  neural.state = 'loading'; neural.progress = 0; emit();
  worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  const parts = {};
  readyP = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        parts[data.label] = data.share * data.loaded / data.total;
        neural.progress = Math.min(0.99, Object.values(parts).reduce((a, b) => a + b, 0)); emit();
      } else if (data.type === 'ready') { neural.state = 'ready'; neural.progress = 1; emit(); resolve(); }
      else if (data.type === 'audio' || data.type === 'ipa') { const p = pending.get(data.id); pending.delete(data.id); neural.lastMs = data.ms || 0; p?.resolve(data); }
      else if (data.type === 'error') {
        if (data.id != null && pending.has(data.id)) { const p = pending.get(data.id); pending.delete(data.id); p.reject(new Error(data.message)); }
        else { neural.state = 'error'; neural.error = data.message; emit(); reject(new Error(data.message)); }
      }
    };
    worker.onerror = e => { neural.state = 'error'; neural.error = e.message || 'worker error'; emit(); reject(new Error(neural.error)); };
    worker.postMessage({ type: 'init' });
  });
  readyP.catch(() => {});
  return readyP;
}

function call(type, payload) {
  return loadNeural().then(() => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ type, id, ...payload });
  }));
}
/** @returns {Promise<{pcm:Float32Array, sampleRate:number, ipa:string}>} */
export const synthesize = (text, rate = 1) => call('synth', { text, rate });
export const phonemizeHe = text => call('phonemize', { text }).then(d => d.ipa);

/** 16-bit PCM mono WAV (peak-normalised, short fades) → Blob for an <audio> element (plays with the iOS silent switch on). */
export function encodeWav(pcm, sampleRate) {
  let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  const g = peak > 0 ? 0.9 / peak : 1, n = pcm.length, fade = Math.min(n >> 1, Math.round(sampleRate * 0.008));
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let s = pcm[i] * g; if (i < fade) s *= i / fade; else if (i > n - fade) s *= (n - i) / fade;
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Loudness envelope (RMS per 10 ms, normalised 0..1, gently compressed) — drives the mouth from the real audio. */
export function energyEnvelope(pcm, sampleRate, hopMs = 10) {
  const hop = Math.max(1, Math.round(sampleRate * hopMs / 1000)), n = Math.ceil(pcm.length / hop);
  const env = new Float32Array(n); let max = 1e-6;
  for (let f = 0; f < n; f++) {
    let s = 0; const a = f * hop, b = Math.min(pcm.length, a + hop);
    for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
    env[f] = Math.sqrt(s / Math.max(1, b - a)); if (env[f] > max) max = env[f];
  }
  for (let f = 0; f < n; f++) { const x = env[f] / max; env[f] = x < 0.06 ? 0 : Math.min(1, Math.pow(x, 0.6) * 1.15); }
  return { env, hopMs };
}

/** Silent WAV blob (used to unlock the <audio> element inside a user gesture on iOS). */
export function silentWav(ms = 60, sampleRate = 22050) { return encodeWav(new Float32Array(Math.round(sampleRate * ms / 1000)), sampleRate); }
