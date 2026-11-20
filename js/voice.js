// Voice-only "phone call" mode: continuous Hebrew speech recognition with silence auto-submit, auto-restart,
// barge-in (talk over the avatar), interim captions and a mic level meter.
// PRIVACY: Chrome's webkitSpeechRecognition streams microphone audio to Google's servers; Safari uses Apple's
// (on-device or server). The consent screen states this; voice mode is opt-in. The session's own recording stays local.
// The level meter taps the MediaRecorder stream that is already open (no second getUserMedia → coexists with recording).

export class VoiceController extends EventTarget {
  static isSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  /**
   * @param {{stream?:MediaStream, silenceMs?:number, bargeIn?:boolean, lang?:string}} opts
   * Events: 'final' {text}, 'interim' {text}, 'state' {state}, 'level' {level}, 'bargein', 'error' {error}
   */
  constructor({ stream = null, silenceMs = 1500, bargeIn = true, lang = 'he-IL' } = {}) {
    super();
    this.stream = stream; this.silenceMs = silenceMs; this.bargeInEnabled = bargeIn; this.lang = lang;
    this.state = 'idle'; this.want = false; this.paused = false; this.restarts = 0; this.noSpeech = 0; this.level = 0;
    this.speaking = false; this.stats = { finals: 0, restarts: 0, bargeIns: 0, interims: 0 };
  }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _set(s) { if (this.state !== s) { this.state = s; this._emit('state', { state: s }); } }
  /** Call inside the user's "start" tap: creates/resumes the AudioContext for the level meter. */
  start() {
    this.started = true;
    if (this.stream && this.stream.getAudioTracks().length && !this.ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC();
        const src = this.ctx.createMediaStreamSource(this.stream); this.an = this.ctx.createAnalyser(); this.an.fftSize = 512;
        src.connect(this.an); this.buf = new Uint8Array(this.an.fftSize);
        this.ctx.resume?.();
        this._meter();
      } catch (e) { this.ctx = null; }
    }
  }
  _meter() {
    let loud = 0, last = performance.now();
    const tick = () => {
      if (!this.an) return;
      this.an.getByteTimeDomainData(this.buf);
      let s = 0; for (let i = 0; i < this.buf.length; i++) { const v = (this.buf[i] - 128) / 128; s += v * v; }
      const rms = Math.sqrt(s / this.buf.length); this.level = Math.min(1, rms * 4.5);
      this._emit('level', { level: this.level });
      const now = performance.now(), dt = now - last; last = now;
      // barge-in: sustained voice (≈450 ms) while the avatar is talking (echo cancellation is on by default in getUserMedia)
      if (this.speaking && this.bargeInEnabled && !this.paused) {
        loud = this.level > 0.32 ? loud + dt : Math.max(0, loud - dt * 2);
        if (loud > 450) { loud = 0; this.bargeIn(); }
      } else loud = 0;
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
  /** The avatar is talking (enables level-based barge-in). */
  setSpeaking(v) { this.speaking = v; if (v) this._set('speaking'); }
  bargeIn() { this.stats.bargeIns++; this._emit('bargein'); }
  listen() {
    if (this.paused) return;
    this.want = true; this.speaking = false; this.final = ''; this.interim = ''; this.restarts = 0;
    this._startRec();
  }
  _startRec() {
    if (!this.want || this.paused) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    try { this.r?.abort?.(); } catch {}
    const r = new SR(); this.r = r;
    r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onstart = () => this._set('listening');
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.final += (this.final ? ' ' : '') + t.trim(); else interim += t;
      }
      this.interim = interim; this.noSpeech = 0;
      const shown = (this.final + ' ' + interim).trim();
      if (shown) { this.stats.interims++; this._emit('interim', { text: shown }); this._set('hearing'); }
      clearTimeout(this._sil);
      this._sil = setTimeout(() => this._submit(), this.silenceMs);     // silence → auto-submit
    };
    r.onerror = e => {
      if (e.error === 'no-speech') { this.noSpeech++; return; }
      if (e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.want = false; this._set('error'); this._emit('error', { error: e.error }); return;
      }
      this._emit('error', { error: e.error });
    };
    r.onend = () => {
      if (this.r !== r) return;
      if (this.want && !this.paused) {
        if ((this.final + this.interim).trim()) return this._submit();
        if (this.restarts++ < 40) { this.stats.restarts++; setTimeout(() => this._startRec(), 250); }   // auto-restart
        else { this.want = false; this._set('idle'); }
        if (this.noSpeech >= 3) this._emit('nospeech');
      }
    };
    try { r.start(); } catch (e) { setTimeout(() => this._startRec(), 400); }
  }
  _submit() {
    clearTimeout(this._sil);
    const text = (this.final + ' ' + (this.interim || '')).trim();
    if (!text || !this.want) return;
    this.want = false; this.final = ''; this.interim = '';
    try { this.r?.stop(); } catch {}
    this.stats.finals++; this._set('thinking');
    this._emit('final', { text });
  }
  stopListening() { this.want = false; clearTimeout(this._sil); try { this.r?.abort?.(); } catch {} if (this.state !== 'speaking') this._set('idle'); }
  pause() { this.paused = true; this.stopListening(); this._set('paused'); }
  resume() { this.paused = false; this._set('idle'); }
  destroy() { this.stopListening(); cancelAnimationFrame(this._raf); this.an = null; try { this.ctx?.close(); } catch {} }
}
