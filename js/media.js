// Session video recording + short filming clips (getUserMedia + MediaRecorder).
function pickMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
  return c.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}
export class MediaSession {
  constructor() { this.stream = null; this.rec = null; this.chunks = []; this.startedAt = 0; this.error = null; }
  static isSupported() { return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); }
  async start() {
    if (!MediaSession.isSupported()) { this.error = 'הדפדפן אינו תומך בהקלטת וידאו (נדרש HTTPS ודפדפן עדכני)'; return false; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: true });
    } catch (e) {
      this.error = e.name === 'NotAllowedError' ? 'לא ניתנה הרשאה למצלמה/מיקרופון' : `שגיאת מצלמה: ${e.name || e.message}`;
      return false;
    }
    this.mime = pickMime();
    this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, videoBitsPerSecond: 600000 } : undefined);
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
    this.startedAt = Date.now();
    return true;
  }
  async stop() {
    if (!this.rec) return null;
    const done = new Promise(r => { this.rec.onstop = r; });
    if (this.rec.state !== 'inactive') this.rec.stop();
    await done;
    const blob = new Blob(this.chunks, { type: this.rec.mimeType || 'video/webm' });
    const duration = (Date.now() - this.startedAt) / 1000;
    this.stream?.getTracks().forEach(t => t.stop());
    this.rec = null;
    return { blob, duration };
  }
  /** Record a short clip from the same stream. Returns { stop(), done: Promise<{blob,duration}> }. */
  recordClip(maxSec, onTick) {
    if (!this.stream) throw new Error('המצלמה אינה פעילה');
    const chunks = []; const r = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const t0 = Date.now(); let timer;
    const done = new Promise((resolve, reject) => {
      r.ondataavailable = e => e.data.size && chunks.push(e.data);
      r.onstop = () => { clearInterval(timer); const blob = new Blob(chunks, { type: r.mimeType || 'video/webm' }); blob.size ? resolve({ blob, duration: (Date.now() - t0) / 1000 }) : reject(new Error('הקליפ ריק')); };
      r.onerror = e => { clearInterval(timer); reject(e.error || new Error('שגיאת הקלטה')); };
    });
    r.start(500);
    timer = setInterval(() => { const s = (Date.now() - t0) / 1000; onTick?.(s); if (s >= maxSec && r.state === 'recording') r.stop(); }, 250);
    return { stop: () => r.state === 'recording' && r.stop(), done };
  }
}
