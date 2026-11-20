// Hands-free voice loop ("phone call" mode).
//  • Continuous listening: recognition is restarted seamlessly whenever it ends — iOS Safari's webkitSpeechRecognition
//    stops after every result (it ignores `continuous`), Chrome stops after silence/timeouts. Partial results are
//    accumulated across restarts, so a sentence with pauses stays one answer.
//  • End of turn = no new recognition results for `silenceMs` AND the mic energy VAD reports silence for `vadHangMs`
//    (so a slow speaker who pauses mid-sentence isn't cut off). Without a mic stream, results-timing alone is used.
//  • Barge-in: while Noa is talking, a mic-energy VAD with an adaptive (echo-aware) threshold detects the patient
//    talking → 'bargein' → the app stops TTS and starts listening. Recognition is NOT run while Noa talks, so her own
//    voice is never transcribed.
//  • Long silence → 'longsilence' (the app re-prompts gently).
// PRIVACY: Chrome's recognizer streams audio to Google; Safari to Apple (on-device or server). Disclosed at consent.
// The VAD taps the already-open MediaRecorder stream (no second getUserMedia; coexists with the session recording).

let sharedCtx = null;
export class VoiceController extends EventTarget {
  static isSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  /** Call synchronously inside the user's first tap (iOS): creates/resumes the AudioContext used by the VAD. */
  static unlock() {
    try { const AC = window.AudioContext || window.webkitAudioContext; if (!sharedCtx && AC) sharedCtx = new AC(); sharedCtx?.resume?.(); } catch {}
    return sharedCtx;
  }
  constructor({ stream = null, silenceMs = 1300, vadHangMs = 600, longSilenceMs = 12000, bargeIn = true, lang = 'he-IL' } = {}) {
    super();
    Object.assign(this, { stream, silenceMs, vadHangMs, longSilenceMs, bargeInEnabled: bargeIn, lang });
    this.state = 'idle'; this.want = false; this.paused = false; this.speaking = false;
    this.level = 0; this.noise = 0.02; this.echo = 0; this.lastVoiceAt = 0; this.final = ''; this.interim = '';
    this.stats = { finals: 0, restarts: 0, bargeIns: 0, interims: 0, longSilences: 0, vadHolds: 0, starts: 0 };
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _set(s) { if (this.state !== s) { this.state = s; this._emit('state', { state: s }); } }
  get hasVAD() { return !!this.an; }

  start() {
    const ctx = VoiceController.unlock();
    if (ctx && this.stream?.getAudioTracks().length && !this.an) {
      try {
        const src = ctx.createMediaStreamSource(this.stream); this.an = ctx.createAnalyser(); this.an.fftSize = 1024;
        src.connect(this.an); this.buf = new Float32Array(this.an.fftSize); this._vad();
      } catch { this.an = null; }
    }
    this._clock = setInterval(() => this._tick(), 100);
  }
  // ---------------- VAD ----------------
  _vad() {
    let loud = 0, last = performance.now();
    const step = () => {
      if (!this.an) return;
      this.an.getFloatTimeDomainData(this.buf);
      let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      const lvl = Math.min(1, Math.sqrt(s / this.buf.length) * 3); this.level = lvl;
      const now = performance.now(), dt = Math.min(100, now - last); last = now;
      const voiceThr = Math.max(0.06, this.noise * 2 + 0.04);
      const isVoice = lvl > voiceThr;
      if (isVoice) this.lastVoiceAt = now; else this.noise = this.noise * 0.99 + lvl * 0.01;   // noise floor tracks quiet frames
      this._emit('level', { level: lvl, voice: isVoice });
      if (this.speaking && this.bargeInEnabled && !this.paused) {
        // echo-aware threshold: Noa's own voice leaking into the mic raises the baseline
        this.echo = this.echo * 0.97 + lvl * 0.03;
        const thr = Math.max(0.18, this.echo * 2.2 + 0.06, voiceThr * 1.5);
        const sinceStart = now - this.speakStart;
        loud = sinceStart > 300 && lvl > thr ? loud + dt : Math.max(0, loud - dt * 1.5);
        if (loud > 280) { loud = 0; this.bargeIn('vad'); }
      } else loud = 0;
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
  /** Noa is talking: recognition is off, VAD watches for barge-in. */
  setSpeaking(v) {
    this.speaking = v;
    if (v) { this.stopListening(true); this.speakStart = performance.now(); this.echo = this.noise; this._set('speaking'); }
  }
  bargeIn(source = 'manual') { if (!this.speaking && source === 'vad') return; this.stats.bargeIns++; this.speaking = false; this._emit('bargein', { source }); }

  // ---------------- recognition loop ----------------
  /** Start a listening turn. opts.patient → longer silence allowance (after "רגע"). */
  listen(opts = {}) {
    if (this.paused) return;
    this.want = true; this.speaking = false; this.final = ''; this.interim = '';
    this.turnStart = performance.now(); this.lastResultAt = 0; this.lastPrompt = performance.now();
    this.longSilenceMs_ = opts.patient ? this.longSilenceMs * 2 : this.longSilenceMs;
    this._startRec();
  }
  _startRec() {
    if (!this.want || this.paused) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    try { this.r && (this.r.onend = null, this.r.abort()); } catch {}
    const r = new SR(); this.r = r; this.stats.starts++;
    r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    let segFinal = '';                                       // finals of THIS recognition session
    r.onstart = () => { if (this.r === r) this._set(this.final ? 'hearing' : 'listening'); };
    r.onresult = e => {
      if (this.r !== r) return;
      let interim = '', fin = '';
      for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript.trim(); if (e.results[i].isFinal) fin += (fin ? ' ' : '') + t; else interim += (interim ? ' ' : '') + t; }
      if (fin !== segFinal) { const add = fin.slice(segFinal.length).trim(); if (add) this.final = (this.final ? this.final + ' ' : '') + add; segFinal = fin; }
      this.interim = interim; this.lastResultAt = performance.now();
      const shown = (this.final + ' ' + interim).trim();
      if (shown) { this.stats.interims++; this._emit('interim', { text: shown }); this._set('hearing'); }
    };
    r.onerror = e => {
      if (this.r !== r) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { this.want = false; this._set('error'); this._emit('error', { error: e.error }); }
      // 'no-speech' / 'aborted' / 'network' → onend restarts
    };
    r.onend = () => {
      if (this.r !== r) return;
      if (this.interim) { this.final = (this.final ? this.final + ' ' : '') + this.interim; this.interim = ''; }   // iOS: keep the tail
      if (this.want && !this.paused) { this.stats.restarts++; setTimeout(() => this._startRec(), 60); }          // seamless restart
    };
    try { r.start(); } catch { setTimeout(() => this._startRec(), 300); }
  }
  _tick() {
    if (!this.want || this.paused) return;
    const now = performance.now(), text = (this.final + ' ' + this.interim).trim();
    if (text) {
      const quietResults = now - this.lastResultAt >= this.silenceMs;
      const quietMic = !this.hasVAD || now - this.lastVoiceAt >= this.vadHangMs;
      if (quietResults && (quietMic || now - this.lastResultAt > 6000)) return this._submit();
      if (quietResults && !quietMic) this.stats.vadHolds++;          // still talking (energy) → keep the turn open
    } else if (now - Math.max(this.lastPrompt, this.lastVoiceAt || 0) > this.longSilenceMs_) {
      this.lastPrompt = now; this.stats.longSilences++; this._emit('longsilence', { count: this.stats.longSilences });
    }
  }
  _submit() {
    const text = (this.final + ' ' + this.interim).trim();
    if (!text) return;
    this.want = false; this.final = ''; this.interim = '';
    try { this.r && (this.r.onend = null, this.r.abort()); } catch {}
    this.stats.finals++; this._set('thinking');
    this._emit('final', { text });
  }
  stopListening(silent = false) {
    this.want = false; try { this.r && (this.r.onend = null, this.r.abort()); } catch {}
    if (!silent && this.state !== 'speaking') this._set('idle');
  }
  pause() { this.paused = true; this.stopListening(); this._set('paused'); }
  resume() { this.paused = false; this._set('idle'); }
  destroy() { this.stopListening(); clearInterval(this._clock); cancelAnimationFrame(this._raf); this.an = null; }
}
