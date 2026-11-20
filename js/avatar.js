// AvatarProvider abstraction + implementations.
//
//  * Avatar3DProvider (default when WebGL is available): realistic 3D head (CC0 MPFB/MakeHuman model with ARKit +
//    Oculus viseme blendshapes) rendered by TalkingHead/three.js — vendored locally, lazy-loaded, poster image while
//    loading. TalkingHead supplies idle breathing, micro head movement, blinks, saccades, eye contact and moods; this
//    file drives lip-sync visemes from the Hebrew text timeline (speaker.js / visemes.js) via the morph "realtime"
//    channel, plus listening / empathetic / concerned expressions.
//  * PortraitAvatarProvider (fallback when WebGL is unavailable or the model fails to load): 2.5D photo portrait with a
//    canvas jaw/mouth warp driven by the same viseme timeline.
//  * StreamingAvatarProvider: documented stub for photoreal paid streaming avatars (HeyGen / Simli / D-ID). Not active.
import { Speaker } from './speaker.js';
import { VISEMES, opennessOf, roundnessOf } from './visemes.js';

const abs = p => new URL(p, document.baseURI).href;
const VISEME_GAIN = 0.8;                              // conversational (not exaggerated) mouth shapes
const STATE_LABEL = { idle: '', speaking: 'מדברת…', listening: 'מקשיבה…', alert: 'התרעה' };

/** @interface */
export class AvatarProvider {
  /** Render into a container element. */ mount(_el) { throw new Error('not implemented'); }
  /** Speak text (TTS + lip-sync); resolves when finished. */ async speak(_text) { throw new Error('not implemented'); }
  /** 'idle' | 'speaking' | 'listening' | 'alert' */ setState(_s) { throw new Error('not implemented'); }
  set ttsEnabled(_v) {}
  stop() {}
  destroy() {}
}

export function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); }
  catch { return false; }
}
export const isMobile = () => matchMedia('(pointer: coarse)').matches || innerWidth < 768;

/** Factory used by app.js. settings.avatarMode: 'auto' | '3d' | 'portrait'. URL ?avatar=portrait forces fallback. */
export function createAvatar(settings) {
  const speaker = new Speaker({ ttsEnabled: settings.tts });
  const forced = new URLSearchParams(location.search).get('avatar');
  const mode = forced || settings.avatarMode || 'auto';
  if (mode !== 'portrait' && hasWebGL()) return new Avatar3DProvider({ speaker });
  return new PortraitAvatarProvider({ speaker, reason: mode === 'portrait' ? 'הוגדר מצב תמונה' : 'WebGL אינו זמין' });
}

// ------------------------------------------------------------------------------------------------
export class Avatar3DProvider extends AvatarProvider {
  constructor({ speaker }) {
    super(); this.speaker = speaker; this.kind = '3d'; this.state = 'idle'; this.cur = {}; this.frames = 0; this.fps = 0; this.loaded = false;
    window.__avatar = this; // diagnostics hook (tests)
  }
  set ttsEnabled(v) { this.speaker.ttsEnabled = v; }
  mount(el) {
    this.el = el;
    el.innerHTML = `
      <div class="avatar avatar-3d" data-state="idle" data-kind="3d">
        <img class="avatar-poster" src="assets/avatar/poster.jpg" alt="אווטאר תלת-ממדי של נועה, עוזרת טריאז' דיגיטלית (דמות ממוחשבת)">
        <div class="avatar-3d-host" aria-hidden="true"></div>
        <div class="avatar-loading" role="status">טוען אווטאר…</div>
        <span class="avatar-state" aria-live="polite"></span>
      </div>`;
    this.root = el.querySelector('.avatar'); this.stateEl = el.querySelector('.avatar-state');
    this.ready = this._load().catch(err => this._fallback(err));
    return this.ready;
  }
  async _load() {
    const { TalkingHead } = await import('../vendor/talkinghead/talkinghead.bundle.mjs');
    const dpr = window.devicePixelRatio || 1;
    const mobile = isMobile();
    const targetDpr = mobile ? 1.25 : 2;                        // cap effective pixel ratio (perf on phones)
    this.pixelRatio = Math.min(dpr, targetDpr);
    const host = this.el.querySelector('.avatar-3d-host');
    const head = new TalkingHead(host, {
      lipsyncModules: [], cameraView: 'head', cameraDistance: 0.5, cameraY: -0.05,
      cameraRotateEnable: false, cameraPanEnable: false, cameraZoomEnable: false,
      modelFPS: 30, modelPixelRatio: this.pixelRatio / dpr,
      lightAmbientIntensity: 0.5, lightDirectIntensity: 6, lightDirectColor: 0xffe4cc, lightSpotIntensity: 0,
      avatarMood: 'neutral', avatarIdleEyeContact: 0.6, avatarIdleHeadMove: 0.45, avatarSpeakingEyeContact: 0.85, avatarSpeakingHeadMove: 0.5
    });
    this.head = head;
    // Calm "clinician" mood: seated/straight posture (no hip/side sways that push the head out of a head-shot),
    // small head/body micro-movements, breathing, saccades, blinks, soft micro-expressions, gentle resting smile.
    head.animMoods.clinician = {
      baseline: { mouthSmile: 0.14, eyesLookDown: 0.04 },
      speech: { deltaRate: 0, deltaPitch: 0, deltaVolume: 0 },
      anims: [
        { name: 'breathing', delay: 1500, dt: [1300, 500, 1100], vs: { chestInhale: [0.45, 0.45, 0] } },
        { name: 'pose', alt: [{ delay: [5000, 30000], vs: { pose: ['straight'] } }] },
        { name: 'head',
          idle: { delay: [0, 1000], dt: [[400, 4000]], vs: { bodyRotateX: [[-0.03, 0.06]], bodyRotateY: [[-0.09, 0.09]], bodyRotateZ: [[-0.04, 0.04]] } },
          speaking: { dt: [[0, 1000, 0]], vs: { bodyRotateX: [[-0.03, 0.08, 1, 2]], bodyRotateY: [[-0.06, 0.06]], bodyRotateZ: [[-0.05, 0.05]] } } },
        head.animTemplateEyes,
        head.animTemplateBlink,
        { name: 'mouth', delay: [1500, 6000], dt: [[100, 500], [100, 4000, 2]], vs: { mouthRollLower: [[0, 0.15, 2]], mouthPucker: [[0, 0.12]], mouthSmile: [[0, 0.15, 3]] } },
        { name: 'misc', delay: [200, 5000], dt: [[100, 500], [1000, 5000, 2]], vs: { eyeSquintLeft: [[0, 0.2, 2]], eyeSquintRight: [[0, 0.2, 2]], browInnerUp: [[0, 0.2, 2]], browOuterUpLeft: [[0, 0.15, 2]], browOuterUpRight: [[0, 0.15, 2]] } }
      ]
    };
    head.poseName = 'straight';
    await head.showAvatar({ url: abs('assets/avatar/doctor-avatar.glb'), body: 'F', avatarMood: 'clinician', lipsyncLang: 'en' },
      ev => { if (ev.lengthComputable) { const l = this.el.querySelector('.avatar-loading'); if (l) l.textContent = `טוען אווטאר… ${Math.round(ev.loaded / ev.total * 100)}%`; } });
    this._frameHead();
    this._frameTimers = [setTimeout(() => this._frameHead(), 1300), setTimeout(() => this._frameHead(), 3500)]; // after pose settles
    head.renderer.toneMappingExposure = 0.75;
    head.scene.environmentIntensity = 0.35;
    head.armature.traverse(n => {
      if (!n.isMesh) return;
      [].concat(n.material).forEach(m => {
        if (/body/i.test(m.name)) m.roughness = 0.6;
        // No ambient occlusion inside the mouth → tongue/teeth look over-lit when the jaw opens. Fake the cavity shading.
        if (/tongue/i.test(m.name)) { m.color.multiplyScalar(0.28); m.roughness = 0.8; }
        if (/teeth/i.test(m.name)) { m.color.multiplyScalar(0.92); }
      });
    });
    // FPS meter (counts real renders)
    const r = head.renderer, orig = r.render.bind(r);
    r.render = (...a) => { this.frames++; return orig(...a); };
    this._fpsTimer = setInterval(() => { this.fps = this.frames / 2; this.frames = 0; }, 2000);
    this._vis = () => (document.hidden ? head.stop() : head.start());
    document.addEventListener('visibilitychange', this._vis);
    this.loaded = true;
    this.root.classList.add('is-loaded');
    this._expr(this.state);
  }
  /** Centre the camera between the eyes (the MPFB rig's settled pose is off x=0 and below TalkingHead's default). */
  _frameHead() {
    const h = this.head; if (!h) return;
    const L = h.armature.getObjectByName('LeftEye'), R = h.armature.getObjectByName('RightEye'), H = h.armature.getObjectByName('Head');
    if (!H) return;
    h.armature.updateMatrixWorld(true);
    const p = (L && R) ? L.getWorldPosition(L.position.clone()).add(R.getWorldPosition(R.position.clone())).multiplyScalar(0.5)
                       : H.getWorldPosition(H.position.clone()).add({ x: 0, y: 0.08, z: 0 });
    const t = Math.tan(h.camera.fov * Math.PI / 360), z = 0.5 + 2;          // cameraDistance + 'head' view offset
    const targetY = p.y - 0.03;                                            // eyes slightly above centre
    const cameraX = -p.x / (t * z);
    const cameraY = 1 - (targetY - 4 * h.avatarHeight / 5) / (t * z);
    h.setView('head', { cameraX, cameraY, cameraDistance: 0.5 });
    this.framing = { eyeX: +p.x.toFixed(3), eyeY: +p.y.toFixed(3), cameraX, cameraY };
  }
  _fallback(err) {
    console.warn('3D avatar unavailable, using portrait fallback:', err?.message || err);
    this.destroy();
    const p = new PortraitAvatarProvider({ speaker: this.speaker, reason: 'טעינת התלת-ממד נכשלה' });
    // Delegate everything to the fallback from now on.
    Object.setPrototypeOf(this, PortraitAvatarProvider.prototype);
    Object.assign(this, p);
    window.__avatar = this;
    return this.mount(this.el);
  }
  _rt(mt, v) { const o = this.head?.mtAvatar?.[mt]; if (o) { o.realtime = v; o.needsUpdate = true; } }
  _expr(state) {
    const h = this.head; if (!h || !this.loaded) return;   // applied again on load
    // Expressions layered on TalkingHead's idle animation. null releases the channel back to TalkingHead.
    const set = (o) => Object.entries(o).forEach(([k, v]) => this._rt(k, v));
    if (state === 'listening') { set({ headRotateZ: 0.07, headRotateX: 0.03, browInnerUp: 0.18, mouthSmileLeft: 0.18, mouthSmileRight: 0.18 }); h.makeEyeContact?.(6000); }
    else if (state === 'alert') { set({ headRotateZ: null, headRotateX: 0.02, browInnerUp: 0.5, mouthSmileLeft: 0, mouthSmileRight: 0, mouthFrownLeft: 0.12, mouthFrownRight: 0.12 }); h.lookAtCamera?.(4000); }
    else if (state === 'speaking') { set({ headRotateZ: null, headRotateX: null, browInnerUp: 0.08, mouthSmileLeft: 0.12, mouthSmileRight: 0.12, mouthFrownLeft: null, mouthFrownRight: null }); h.makeEyeContact?.(3000); }
    else { set({ headRotateZ: null, headRotateX: null, browInnerUp: null, mouthSmileLeft: 0.22, mouthSmileRight: 0.22, mouthFrownLeft: null, mouthFrownRight: null }); } // gentle resting smile
  }
  setState(s) {
    this.state = s;
    if (this.root) { this.root.dataset.state = s; this.stateEl.textContent = STATE_LABEL[s] || ''; }
    this._expr(s);
  }
  _applyVisemes(target) {
    const now = performance.now(); const dt = Math.min(100, now - (this._lt || now)); this._lt = now;
    const k = Math.min(1, dt / 45);                       // ~45 ms smoothing
    for (const v of VISEMES) {
      if (v === 'sil') continue;
      const tv = (target[v] || 0) * VISEME_GAIN; const c = this.cur[v] || 0; const n = c + (tv - c) * k;
      this.cur[v] = n < 0.005 ? 0 : n;
      this._rt('viseme_' + v, this.cur[v]);
    }
    this.lastWeights = target;
  }
  async speak(text) {
    if (this.ready) await Promise.race([this.ready, new Promise(r => setTimeout(r, 50))]); // don't block on loading
    const tok = this._tok = (this._tok || 0) + 1;
    const keepAlert = this.state === 'alert';
    this.setState(keepAlert ? 'alert' : 'speaking');
    if (this.head) this.head.isSpeaking = true;
    await this.speaker.speak(text, {
      onFrame: w => { if (this.head) this._applyVisemes(w); },
      onEnd: () => {}
    });
    if (tok !== this._tok) return;                         // superseded by a newer utterance
    // smooth close, then release visemes to TalkingHead
    const t0 = performance.now();
    await new Promise(res => { const step = () => { this._applyVisemes({}); if (performance.now() - t0 < 160) requestAnimationFrame(step); else res(); }; step(); });
    if (tok !== this._tok) return;
    VISEMES.forEach(v => v !== 'sil' && this._rt('viseme_' + v, null));
    if (this.head) this.head.isSpeaking = false;
    if (!keepAlert && this.state !== 'alert') this.setState('idle');
  }
  stop() { this.speaker.cancel(); if (this.state !== 'alert') this.setState('idle'); }
  destroy() {
    clearInterval(this._fpsTimer); (this._frameTimers || []).forEach(clearTimeout); document.removeEventListener('visibilitychange', this._vis || (() => {}));
    try { this.head?.stop(); this.head?.renderer?.dispose(); this.head?.renderer?.forceContextLoss?.(); } catch {}
    this.head = null;
  }
}

// ------------------------------------------------------------------------------------------------
// 2.5D portrait fallback: the generated photo with a canvas jaw-drop / mouth-interior warp driven by visemes.
const FACE = { cx: 260, lipY: 220, halfW: 33, chinY: 284 }; // in the 512×512 assets/doctor.jpg
export class PortraitAvatarProvider extends AvatarProvider {
  constructor({ speaker, reason = '' }) {
    super(); this.speaker = speaker; this.kind = 'portrait'; this.reason = reason; this.state = 'idle'; this.open = 0; this.round = 0;
    window.__avatar = this;
  }
  set ttsEnabled(v) { this.speaker.ttsEnabled = v; }
  mount(el) {
    this.el = el;
    el.innerHTML = `
      <div class="avatar avatar-portrait" data-state="idle" data-kind="portrait">
        <div class="avatar-ring"></div>
        <canvas class="avatar-img" width="512" height="512" role="img" aria-label="אווטאר של נועה, עוזרת טריאז' דיגיטלית (תמונה ממוחשבת)"></canvas>
        <span class="avatar-state" aria-live="polite"></span>
      </div>`;
    this.root = el.querySelector('.avatar'); this.stateEl = el.querySelector('.avatar-state');
    this.canvas = el.querySelector('canvas'); this.g = this.canvas.getContext('2d');
    this.off = document.createElement('canvas'); this.off.width = this.off.height = 512; this.og = this.off.getContext('2d');
    this.img = new Image(); this.img.src = 'assets/doctor.jpg';
    this.ready = this.img.decode().then(() => { this.loaded = true; this.draw(0, 0); }).catch(() => {});
    return this.ready;
  }
  draw(open, round) {
    const { g, og, img } = this; if (!this.loaded) return;
    const { cx, lipY, halfW, chinY } = FACE;
    g.clearRect(0, 0, 512, 512); g.drawImage(img, 0, 0, 512, 512);
    if (open < 0.02) return;
    const d = open * 10;                                     // jaw drop in px
    const rx = halfW * (0.92 - 0.38 * round), ry = 1.2 + open * 7;
    // mouth interior + hint of upper teeth
    g.fillStyle = '#3b1519'; g.beginPath(); g.ellipse(cx, lipY + d * 0.4, rx, ry, 0, 0, Math.PI * 2); g.fill();
    if (open > 0.35) { g.fillStyle = 'rgba(236,228,222,.85)'; g.beginPath(); g.ellipse(cx, lipY + d * 0.4 - ry * 0.55, rx * 0.72, ry * 0.32, 0, 0, Math.PI * 2); g.fill(); }
    // lower face (lower lip → chin) shifted down, feathered so it blends into the original
    og.clearRect(0, 0, 512, 512);
    const top = lipY + 1, h = chinY + 26 - top;
    og.drawImage(img, cx - 80, top, 160, h, cx - 80 + (round * 0.5), top + d, 160 - round, h);
    og.globalCompositeOperation = 'destination-in';
    const gr = og.createRadialGradient(cx, lipY + 26, 20, cx, lipY + 26, 78);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.7, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    og.fillStyle = gr; og.fillRect(0, 0, 512, 512); og.globalCompositeOperation = 'source-over';
    g.drawImage(this.off, 0, 0);
  }
  setState(s) { this.state = s; if (this.root) { this.root.dataset.state = s; this.stateEl.textContent = STATE_LABEL[s] || ''; } }
  async speak(text) {
    const tok = this._tok = (this._tok || 0) + 1;
    const keepAlert = this.state === 'alert';
    this.setState(keepAlert ? 'alert' : 'speaking');
    await this.speaker.speak(text, {
      onFrame: w => {
        const k = 0.45; this.open += (opennessOf(w) - this.open) * k; this.round += (roundnessOf(w) - this.round) * k;
        this.lastWeights = w; this.draw(this.open, this.round);
      }
    });
    if (tok !== this._tok) return;
    this.open = this.round = 0; this.draw(0, 0);
    if (!keepAlert && this.state !== 'alert') this.setState('idle');
  }
  stop() { this.speaker.cancel(); this.draw(0, 0); if (this.state !== 'alert') this.setState('idle'); }
}

// ------------------------------------------------------------------------------------------------
/**
 * StreamingAvatarProvider — STUB for photoreal, paid, real-time avatars (HeyGen Interactive/Streaming Avatar,
 * Simli, D-ID Agents/Streams, Tavus). Not used by the prototype; it would violate the no-third-party CSP.
 *
 * Integration sketch:
 *   1. Your backend (holding the vendor API key) creates a streaming session and returns WebRTC/LiveKit credentials
 *      or an SDP offer. Never ship the key to the browser.
 *   2. mount(el): create <video autoplay playsinline>, establish the WebRTC peer connection, attach the remote stream.
 *   3. speak(text): POST the AI's text to the vendor "talk/repeat" endpoint (lip-synced TTS rendered server-side);
 *      resolve on the vendor's "avatar_stop_talking"/"speech ended" event.
 *   4. setState(): map to the vendor's idle/listening loop if supported.
 *   5. CSP: add the vendor's API + TURN/WebRTC hosts to connect-src / media-src.
 *
 * Privacy implications (must be assessed before use):
 *   - The AI's question text (and therefore implicitly the clinical context) leaves the device and is processed by a
 *     third party, typically outside Israel → cross-border transfer, DPA/sub-processor review, Amendment 13 duties.
 *   - Send ONLY the AI's own text. Never stream the patient's camera/microphone or free-text answers to the vendor.
 *   - Check the vendor's retention, model-training opt-out, regional hosting and logging; prefer self-hosted or
 *     Israeli/EU-hosted options; disclose in the consent screen.
 */
export class StreamingAvatarProvider extends AvatarProvider {
  constructor(opts) { super(); this.opts = opts; this.kind = 'streaming'; }
  mount(el) { el.innerHTML = '<video autoplay playsinline class="avatar-stream"></video><p class="muted">Streaming avatar not configured</p>'; }
  async speak() { throw new Error('StreamingAvatarProvider not configured in the prototype'); }
  setState() {}
}
