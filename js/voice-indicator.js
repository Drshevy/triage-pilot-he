// VoiceIndicatorProvider — the default "assistant presence": no face, no animation work. A calm circle that
// pulses with Noa's speech energy, shows listening/thinking states, and forwards word timing so the visual panel
// can sync on-screen content to what she is saying. Same AvatarProvider contract (mount/speak/setState/stop).
import { AvatarProvider } from './avatar.js';

const LABEL = { idle: '', speaking: 'נועה מדברת', listening: 'מקשיבה', alert: 'התרעה' };
export class VoiceIndicatorProvider extends AvatarProvider {
  constructor({ speaker }) { super(); this.speaker = speaker; this.kind = 'indicator'; this.state = 'idle'; window.__avatar = this; }
  set ttsEnabled(v) { this.speaker.ttsEnabled = v; this.speaker._decide?.(); }
  mount(el) {
    el.innerHTML = `<div class="vind" data-state="idle" role="img" aria-label="נועה, עוזרת קולית דיגיטלית">
      <div class="vind-ring"></div><div class="vind-core">נ</div><span class="vind-label" aria-live="polite"></span></div>`;
    this.root = el.firstElementChild; this.ring = this.root.querySelector('.vind-ring'); this.lab = this.root.querySelector('.vind-label');
  }
  setState(s) { this.state = s; if (this.root) { this.root.dataset.state = s; this.lab.textContent = LABEL[s] || ''; } }
  /** hooks.onWord(i) fires as each word is spoken (boundary events or timing estimate). */
  async speak(text, hooks = {}) {
    const tok = this._tok = (this._tok || 0) + 1, keepAlert = this.state === 'alert';
    this.setState(keepAlert ? 'alert' : 'speaking');
    await this.speaker.speak(text, {
      onFrame: (_w, info) => { if (this.ring) this.ring.style.transform = `scale(${1 + Math.min(1, info?.energy || 0) * 0.35})`; },
      onWord: i => hooks.onWord?.(i),
      onEnd: () => hooks.onEnd?.()
    });
    if (this.ring) this.ring.style.transform = '';
    if (tok === this._tok && !keepAlert && this.state !== 'alert') this.setState('idle');
  }
  stop() { this.speaker.cancel(); if (this.state !== 'alert') this.setState('idle'); }
  destroy() {}
}
