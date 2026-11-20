// Speech-to-text wrapper (Web Speech API). NOTE: in Chrome, webkitSpeechRecognition streams audio to the
// browser vendor's cloud service. It is therefore OFF by default (Settings) and the UI warns the patient.
export class SpeechInput {
  static isSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  listen({ onInterim } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    return new Promise((resolve, reject) => {
      const r = new SR(); this.r = r;
      r.lang = 'he-IL'; r.interimResults = true; r.maxAlternatives = 1; r.continuous = false;
      let final = '';
      r.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        onInterim?.(final + interim);
      };
      r.onerror = e => reject(new Error(e.error || 'speech error'));
      r.onend = () => resolve(final.trim());
      r.start();
    });
  }
  stop() { try { this.r?.stop(); } catch {} }
}
