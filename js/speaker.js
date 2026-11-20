// Speaker: plays text with speechSynthesis (he-IL) and drives a viseme sink from the text-derived timeline.
// Sync strategy:
//   * the clock starts on utterance 'start' (or immediately if TTS is off/unavailable);
//   * every 'boundary' event (word, charIndex) re-anchors the clock so the matching word starts "now";
//   * voices that never fire boundary events (many mobile voices) run on the estimated timeline;
//   * on 'end' the mouth closes; a safety timeout guarantees completion.
// Stats (boundaryEvents, resyncs, mode) are exposed for tests/diagnostics.
import { buildTimeline, wordAtChar, weightsAt } from './visemes.js';

export class Speaker {
  constructor({ ttsEnabled = true, rate = 0.97 } = {}) {
    this.ttsEnabled = ttsEnabled; this.rate = rate; this.voice = null; this.active = null;
    this.stats = { utterances: 0, boundaryEvents: 0, resyncs: 0, lastMode: null, visemeChanges: 0 };
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices().filter(v => /^(he|iw)/i.test(v.lang));
        this.voice = vs.find(v => v.localService) || vs[0] || null; // prefer on-device voices (privacy)
      };
      pick(); speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }
  cancel() {
    if (this.active) { this.active.cancelled = true; this.active.finish(); }
    try { speechSynthesis.cancel(); } catch {}
  }
  /**
   * @param {string} text
   * @param {{onFrame:(weights:object)=>void, onStart?:()=>void, onEnd?:()=>void}} sink
   */
  speak(text, sink) {
    this.cancel();
    const tl = buildTimeline(text, { rate: this.rate });
    const run = { anchor: performance.now(), ttsDone: !this.ttsEnabled, cancelled: false, raf: 0, lastTop: null };
    this.active = run; this.stats.utterances++;
    const canTTS = this.ttsEnabled && 'speechSynthesis' in window && !!this.voice;
    run.ttsDone = !canTTS;                                  // no voice → the estimated timeline alone ends the utterance
    this.stats.lastMode = canTTS ? 'tts+boundary' : 'estimate';
    return new Promise(resolve => {
      let finished = false;
      run.finish = () => {
        if (finished) return; finished = true;
        cancelAnimationFrame(run.raf); clearTimeout(run.safety);
        sink.onFrame({}); sink.onEnd?.();
        if (this.active === run) this.active = null;
        resolve();
      };
      const tick = () => {
        if (run.cancelled) return;
        const t = performance.now() - run.anchor;
        const w = weightsAt(tl, t);
        const top = Object.keys(w).sort((a, b) => w[b] - w[a])[0] || null;
        if (top !== run.lastTop) { this.stats.visemeChanges++; run.lastTop = top; }
        sink.onFrame(w);
        if (t > tl.total + 120 && run.ttsDone) return run.finish();
        // TTS still talking past our estimate: hold a soft neutral mouth until 'end'
        run.raf = requestAnimationFrame(tick);
      };
      sink.onStart?.();
      if (canTTS) {
        try {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = 'he-IL'; u.voice = this.voice; u.rate = this.rate;
          let started = false;
          u.onstart = () => { started = true; run.anchor = performance.now(); };
          u.onboundary = e => {
            if (e.name && e.name !== 'word') return;
            this.stats.boundaryEvents++;
            const wi = wordAtChar(tl, e.charIndex || 0);
            const predicted = performance.now() - run.anchor;
            if (Math.abs(predicted - tl.words[wi].start) > 40) { run.anchor = performance.now() - tl.words[wi].start; this.stats.resyncs++; }
          };
          u.onend = () => { run.ttsDone = true; if (performance.now() - run.anchor > tl.total * 0.6) run.finish(); };
          u.onerror = () => { run.ttsDone = true; this.stats.lastMode = 'estimate (tts error)'; if (!started) run.anchor = performance.now(); };
          speechSynthesis.speak(u);
          // If the engine never starts (autoplay policy, no audio device), fall back to the estimate.
          setTimeout(() => { if (!started && !run.cancelled) { run.ttsDone = true; this.stats.lastMode = 'estimate (tts did not start)'; run.anchor = performance.now(); } }, 900);
        } catch { run.ttsDone = true; }
      }
      run.safety = setTimeout(() => run.finish(), tl.total + 6000);
      run.raf = requestAnimationFrame(tick);
    });
  }
}
