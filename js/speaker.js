// Speaker: speaks Hebrew text and drives a viseme sink. Two audio engines + a silent fallback:
//   * 'native' — the device's own Hebrew voice via speechSynthesis (iPhone/iPad/Mac: Carmit; Android: Google he-IL;
//      Windows: Microsoft Asaf/Hila/Avri if installed). Lip-sync: text timeline, re-anchored on 'boundary' events,
//      estimated timeline when a voice fires none (iOS).
//   * 'neural' — on-device Piper "noa" voice (js/neural-tts.js, WASM, served from this site) for devices with no
//      Hebrew voice (most Linux/ChromeOS/Chrome-on-Windows without a Hebrew pack). Played through ONE reusable <audio>
//      element (audible with the iPhone silent switch on); lip-sync = text visemes scaled by the real audio's
//      loudness envelope at audio.currentTime.
//   * 'none' — captions only; the mouth follows the estimated timeline.
// Autoplay rules: Speaker.unlock() MUST be called synchronously inside a user gesture (first tap, "start", "test sound").
// It primes speechSynthesis with a near-silent utterance and plays a silent WAV on the shared <audio> element.
import { buildTimeline, wordAtChar, weightsAt } from './visemes.js';
import { neural, loadNeural, neuralSupported, synthesize, encodeWav, energyEnvelope, silentWav, onNeuralStatus } from './neural-tts.js';

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hasSS = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

/** Split into sentence-sized chunks (Chrome cuts long utterances; neural synth streams sentence by sentence). */
export function chunkText(text, max = 160) {
  const parts = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…:])\s+/);
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (out.length && (out[out.length - 1].length + p.length + 1) <= max && out[out.length - 1].length < 40) out[out.length - 1] += ' ' + p;
    else if (p.length <= max) out.push(p);
    else { let cur = ''; for (const w of p.split(/(?<=,)\s+|\s+/)) { if ((cur + ' ' + w).length > max && cur) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } if (cur) out.push(cur); }
  }
  return out.length ? out : [String(text)];
}

let SHARED = null;

export class Speaker extends EventTarget {
  /** One Speaker per page: the unlock + engine choice must survive avatar re-mounts. */
  static shared(opts = {}) {
    if (!SHARED) SHARED = new Speaker(opts);
    else { if ('ttsEnabled' in opts) SHARED.ttsEnabled = opts.ttsEnabled; if (opts.engine) SHARED.setPreference(opts.engine); }
    return SHARED;
  }
  constructor({ ttsEnabled = true, rate = 0.97, engine = 'auto' } = {}) {
    super();
    this.ttsEnabled = ttsEnabled; this.rate = rate; this.pref = engine; this.voice = null; this.active = null;
    this.engine = 'pending'; this.unlocked = false; this.nativeOk = null; this.nativeFails = 0;
    this.stats = { utterances: 0, boundaryEvents: 0, resyncs: 0, lastMode: null, visemeChanges: 0, engineUsed: null, played: 0 };
    this.audio = document.createElement('audio');
    this.audio.setAttribute('playsinline', ''); this.audio.preload = 'auto'; this.audio.className = 'tts-audio'; this.audio.hidden = true;
    (document.body || document.documentElement).appendChild(this.audio);
    this.voicesReady = new Promise(res => {
      if (!hasSS()) return res();
      const pick = () => { this._pickVoice(); if (this.voice) res(); };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', () => { pick(); this._decide(); });
      setTimeout(res, isIOS() ? 1500 : 1200);
    }).then(() => this._decide());
    onNeuralStatus(() => this._emit());
    // Prime audio on the first gesture anywhere on the page (belt and braces; buttons also call unlock()).
    const once = () => this.unlock();
    ['touchend', 'click', 'keydown'].forEach(t => document.addEventListener(t, once, { capture: true, passive: true }));
    this._removeOnce = () => ['touchend', 'click', 'keydown'].forEach(t => document.removeEventListener(t, once, { capture: true }));
  }
  _pickVoice() {
    const vs = speechSynthesis.getVoices().filter(v => /^(he|iw)([-_]|$)/i.test(v.lang));
    const score = v => (v.localService ? 4 : 0) + (/carmit/i.test(v.name) ? 3 : 0) + (/enhanced|premium|natural/i.test(v.name) ? 1 : 0) + (v.default ? 1 : 0);
    this.voice = vs.sort((a, b) => score(b) - score(a))[0] || null;
    this.voices = vs;
  }
  setPreference(p) { this.pref = p || 'auto'; this._decide(); }
  _decide() {
    const prev = this.engine;
    const canNeural = neuralSupported();
    if (!this.ttsEnabled || this.pref === 'none') this.engine = 'none';
    else if (this.pref === 'neural' && canNeural) this.engine = 'neural';
    else if (this.pref === 'native' && hasSS()) this.engine = 'native';
    else if (this.voice && this.nativeOk !== false) this.engine = 'native';
    else if (hasSS() && isIOS() && this.nativeOk !== false) this.engine = 'native';  // iOS: Carmit is built in even if getVoices() is late
    else if (canNeural) this.engine = 'neural';
    else if (hasSS()) this.engine = 'native';
    else this.engine = 'none';
    if (this.engine === 'neural' && neural.state === 'idle') loadNeural().catch(() => {});
    if (prev !== this.engine) this._emit();
    return this.engine;
  }
  _emit() { this.dispatchEvent(new CustomEvent('status', { detail: this.status() })); }
  /** Hebrew, user-facing description of the active voice engine. */
  status() {
    const e = this.engine;
    let label;
    if (e === 'native') label = this.voice ? `קול מובנה של המכשיר: ${this.voice.name.replace(/\s*\(.*\)$/, '')}` : 'קול מובנה של המכשיר (עברית)';
    else if (e === 'neural') {
      if (neural.state === 'loading') label = `טוען קול עברי מקומי (נועה)… ${Math.round(neural.progress * 100)}%`;
      else if (neural.state === 'error') label = 'הקול המקומי לא נטען, ולכן הטקסט מוצג ככתוביות בלבד';
      else label = 'קול עברי נוירוני מקומי: נועה (Piper, פועל במכשיר)';
    } else if (e === 'none') label = this.ttsEnabled ? 'אין קול זמין, ולכן הטקסט מוצג ככתוביות' : 'הקול כבוי';
    else label = 'בודק קולות זמינים…';
    return { engine: e, label, voice: this.voice?.name || null, neural: { ...neural }, unlocked: this.unlocked, ios: isIOS() };
  }
  /** Call synchronously inside a user gesture. Safe to call repeatedly. */
  unlock() {
    if (this.unlocked) return;
    try {
      if (hasSS()) {
        speechSynthesis.resume?.();
        const u = new SpeechSynthesisUtterance('.'); u.lang = 'he-IL'; u.volume = 0.01; u.rate = 1.5;
        if (this.voice) u.voice = this.voice;
        speechSynthesis.speak(u);
      }
    } catch {}
    try {
      if (!this._silentUrl) this._silentUrl = URL.createObjectURL(silentWav());
      this.audio.src = this._silentUrl; this.audio.muted = false;
      const p = this.audio.play();
      if (p?.then) p.then(() => { this.unlocked = true; this._removeOnce?.(); this._emit(); }).catch(() => {});
    } catch {}
  }
  cancel() {
    const a = this.active; this.active = null;
    if (a) { a.cancelled = true; a.finish?.(); }
    try { if (hasSS() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch {}
    try { this.audio.pause(); } catch {}
  }
  /**
   * Speak text; resolves when finished or cancelled.
   * @param {string} text
   * @param {{onFrame:(weights:object, info?:{energy:number})=>void, onStart?:()=>void, onEnd?:()=>void, onWord?:(i:number)=>void}} sink
   */
  async speak(text, sink = { onFrame() {} }) {
    this.cancel();
    const run = { cancelled: false, finish: null };
    this.active = run; this.stats.utterances++;
    await Promise.race([this.voicesReady, new Promise(r => setTimeout(r, 1600))]);
    if (run.cancelled) return;
    const engine = this.ttsEnabled ? this._decide() : 'none';
    this.stats.engineUsed = engine;
    sink.onStart?.();
    const chunks = chunkText(text);
    let prefetch = null, offset = 0;
    const outer = sink;
    for (let i = 0; i < chunks.length && !run.cancelled; i++) {
      const off = offset; offset += chunks[i].split(/\s+/).filter(Boolean).length;
      sink = { ...outer, onWord: wi => outer.onWord?.(off + wi) };          // word index across the whole text (visual sync)
      if (engine === 'neural') {
        const cur = prefetch || this._synth(chunks[i]);
        prefetch = i + 1 < chunks.length ? this._synth(chunks[i + 1]) : null;
        await this._playNeural(chunks[i], cur, run, sink);
      } else if (engine === 'native') {
        const ok = await this._playNative(chunks[i], run, sink);
        if (ok === 'failed' && !run.cancelled && neuralSupported() && this.pref !== 'native') {
          // Device voice never started (no Hebrew voice / blocked) → switch to the on-device neural voice from now on.
          this.nativeOk = false; this._decide(); this.stats.engineUsed = 'neural';
          for (let j = i; j < chunks.length && !run.cancelled; j++) await this._playNeural(chunks[j], this._synth(chunks[j]), run, sink);
          break;
        }
      } else await this._playEstimate(chunks[i], run, sink);
    }
    sink = outer; sink.onFrame({}, { energy: 0 }); sink.onEnd?.();
    if (this.active === run) this.active = null;
  }
  _synth(text) { return loadNeural().then(() => synthesize(text, this.rate)); }

  /** Drive frames from a timeline + clock until done() says stop. */
  _drive(tl, run, sink, clock, done, energyAt) {
    return new Promise(resolve => {
      let lastTop = null, lastWord = -1, raf = 0;
      const stop = () => { cancelAnimationFrame(raf); clearInterval(iv); resolve(); };
      run.finish = stop;
      const tick = () => {
        if (run.cancelled) return stop();
        const t = clock();
        let w = weightsAt(tl, t);
        const e = energyAt ? energyAt() : null;
        if (e != null) { const k = Math.min(1, e * 1.25); const o = {}; for (const v in w) o[v] = w[v] * k; w = o; }
        const top = Object.keys(w).sort((a, b) => w[b] - w[a])[0] || null;
        if (top !== lastTop) { this.stats.visemeChanges++; lastTop = top; }
        const wi = tl.words.findIndex(x => t >= x.start && t < x.end);
        if (wi >= 0 && wi !== lastWord) { lastWord = wi; sink.onWord?.(wi); }
        sink.onFrame(w, { energy: e ?? (top ? 0.6 : 0) });
        if (done(t)) return stop();
      };
      // rAF for smoothness + interval so the clock keeps running in background tabs/tests
      const loop = () => { tick(); if (!run.cancelled) raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      const iv = setInterval(tick, 100);
    });
  }

  async _playEstimate(text, run, sink) {
    const tl = buildTimeline(text, { rate: this.rate }); const t0 = performance.now();
    this.stats.lastMode = 'estimate';
    await this._drive(tl, run, sink, () => performance.now() - t0, t => t > tl.total + 120);
  }

  _playNative(text, run, sink) {
    const tl = buildTimeline(text, { rate: this.rate });
    return new Promise(resolve => {
      let anchor = performance.now(), started = false, ended = false, failed = false;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.voice?.lang || 'he-IL'; if (this.voice) u.voice = this.voice; u.rate = this.rate; u.volume = 1;
      u.onstart = () => { started = true; anchor = performance.now(); this.nativeOk = true; this.stats.played++; this.stats.lastMode = 'tts'; };
      u.onboundary = e => {
        if (e.name && e.name !== 'word') return;
        this.stats.boundaryEvents++; this.stats.lastMode = 'tts+boundary';
        const wi = wordAtChar(tl, e.charIndex || 0), predicted = performance.now() - anchor;
        if (Math.abs(predicted - tl.words[wi].start) > 40) { anchor = performance.now() - tl.words[wi].start; this.stats.resyncs++; }
      };
      u.onend = () => { ended = true; };
      u.onerror = e => { if (!started && !['interrupted', 'canceled'].includes(e.error)) failed = true; ended = true; };
      try { speechSynthesis.resume?.(); speechSynthesis.speak(u); } catch { failed = true; ended = true; }
      const startWait = setTimeout(() => { if (!started && !run.cancelled) { failed = true; ended = true; try { speechSynthesis.cancel(); } catch {} } }, 2500);
      const safety = performance.now() + tl.total * 2.5 + 8000;
      this._drive(tl, run, sink, () => (started ? performance.now() - anchor : -1),
        () => failed || ended || performance.now() > safety)
        .then(() => {
          clearTimeout(startWait);
          if (failed && !started) { this.nativeFails++; this.stats.lastMode = 'tts did not start'; resolve('failed'); }
          else resolve('ok');
        });
    });
  }

  async _playNeural(text, synthP, run, sink) {
    let r;
    try { r = await synthP; } catch (e) {
      this.stats.lastMode = 'neural error: ' + e.message; this._emit();
      return this._playEstimate(text, run, sink);
    }
    if (run.cancelled) return;
    const url = URL.createObjectURL(encodeWav(r.pcm, r.sampleRate));
    const { env, hopMs } = energyEnvelope(r.pcm, r.sampleRate);
    const durMs = r.pcm.length / r.sampleRate * 1000;
    const tl = buildTimeline(text, { rate: this.rate });
    const scale = tl.total / Math.max(1, durMs - 60);
    const a = this.audio;
    a.src = url; a.currentTime = 0;
    let playing = false, ended = false;
    a.onended = () => { ended = true; }; a.onerror = () => { ended = true; };
    try { await a.play(); playing = true; this.stats.played++; this.stats.lastMode = 'neural+energy'; }
    catch (e) {
      // Autoplay blocked (no gesture yet) → silent estimate + tell the UI so it can show the "tap to enable sound" hint.
      this.stats.lastMode = 'neural blocked: ' + e.name; this.dispatchEvent(new CustomEvent('blocked'));
      URL.revokeObjectURL(url); return this._playEstimate(text, run, sink);
    }
    const t0 = performance.now();
    await this._drive(tl, run, sink,
      () => a.currentTime * 1000 * scale,
      () => ended || a.ended || performance.now() - t0 > durMs + 3000,
      () => env[Math.min(env.length - 1, Math.floor(a.currentTime * 1000 / hopMs))] || 0);
    if (run.cancelled) { try { a.pause(); } catch {} }
    URL.revokeObjectURL(url);
  }
}
