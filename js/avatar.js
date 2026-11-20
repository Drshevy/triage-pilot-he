// AvatarProvider abstraction.
//
// The prototype ships PlaceholderAvatar (static generated portrait + CSS speaking animation + browser TTS).
// A real-time generative avatar (HeyGen Streaming, D-ID Agents, Simli, Tavus…) can be swapped in by
// implementing the same interface — see StreamingAvatarProvider below and README "Swap points".

/** @interface */
export class AvatarProvider {
  /** Render into a container element. */ mount(_el) { throw new Error('not implemented'); }
  /** Speak text; resolves when finished (or skipped). */ async speak(_text) { throw new Error('not implemented'); }
  /** 'idle' | 'speaking' | 'listening' | 'alert' */ setState(_s) { throw new Error('not implemented'); }
  stop() {}
  destroy() {}
}

export class PlaceholderAvatar extends AvatarProvider {
  constructor({ imageUrl, name = 'נועה', ttsEnabled = true } = {}) {
    super(); this.imageUrl = imageUrl; this.name = name; this.ttsEnabled = ttsEnabled; this.voice = null;
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices().filter(v => /^he|^iw/i.test(v.lang));
        // Prefer on-device voices (localService) so question text is not sent to a cloud TTS.
        this.voice = vs.find(v => v.localService) || vs[0] || null;
      };
      pick(); speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }
  mount(el) {
    this.el = el;
    el.innerHTML = `
      <div class="avatar" data-state="idle">
        <div class="avatar-ring"></div>
        <img src="${this.imageUrl}" alt="אווטאר של ${this.name}, עוזרת טריאז' דיגיטלית (תמונה ממוחשבת)" class="avatar-img">
        <div class="avatar-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <span class="avatar-state" aria-live="polite"></span>
      </div>`;
    this.root = el.querySelector('.avatar');
    this.stateEl = el.querySelector('.avatar-state');
  }
  setState(s) {
    if (!this.root) return;
    this.root.dataset.state = s;
    this.stateEl.textContent = { idle: '', speaking: 'מדברת…', listening: 'מקשיבה…', alert: 'התרעה' }[s] || '';
  }
  stop() { try { speechSynthesis.cancel(); } catch {} this.setState('idle'); }
  async speak(text) {
    this.setState('speaking');
    const est = Math.min(20000, 900 + text.length * 65);
    if (!this.ttsEnabled || !('speechSynthesis' in window)) {
      await new Promise(r => setTimeout(r, this.ttsEnabled ? est : 450));
      this.setState('idle'); return;
    }
    await new Promise(resolve => {
      let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'he-IL'; if (this.voice) u.voice = this.voice;
        u.rate = 0.97; u.pitch = 1.0;
        u.onend = finish; u.onerror = finish;
        speechSynthesis.speak(u);
      } catch { finish(); }
      setTimeout(finish, est + 2500); // safety net: some browsers never fire onend
    });
    this.setState('idle');
  }
}

/**
 * Skeleton for a streaming generative avatar. Not functional in the prototype (no keys, no network).
 * Typical integration:
 *   1. Your backend creates a session with the vendor (API key stays server-side) and returns
 *      WebRTC/LiveKit credentials or an SDP offer.
 *   2. mount(): attach the remote MediaStream to a <video> element.
 *   3. speak(text): send text to the vendor's "repeat"/"talk" endpoint (lip-synced TTS server-side) and
 *      resolve on the vendor's "speech ended" event.
 *   4. setState(): map to idle/listening animations if the SDK supports it.
 * Patient video/audio must NOT be sent to the avatar vendor; only the AI's own text is.
 */
export class StreamingAvatarProvider extends AvatarProvider {
  constructor(opts) { super(); this.opts = opts; }
  mount(el) { el.innerHTML = '<video autoplay playsinline class="avatar-stream"></video>'; }
  async speak() { throw new Error('StreamingAvatarProvider not configured in the prototype'); }
  setState() {}
}
