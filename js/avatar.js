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
const VISEME_GAIN = 0.58;                             // conversational (not exaggerated) mouth shapes
const CAM_DIST = 0.36;                                // closer head-and-shoulders framing
/** Damped nod spring (≈1.6 Hz, ζ≈0.6), sub-stepped for stability; impulses add velocity. p peaks ≈1 for v=0.01. */
function stepSpring(N, dt) {
  for (let left = Math.min(dt, 100); left > 0; left -= 4) {
    const h = Math.min(4, left); const a = -1e-4 * N.p - 0.012 * N.v; N.v += a * h; N.p += N.v * h;
  }
  if (!Number.isFinite(N.p) || !Number.isFinite(N.v)) { N.p = 0; N.v = 0; }
  return N.p;
}
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

/**
 * Factory used by app.js. settings.avatarMode: 'auto' | 'portrait' | '3d'. URL ?avatar=3d|portrait overrides.
 * 'auto' = the animated photo portrait: it looked more natural than the CG 3D head in side-by-side frame sequences,
 * and it is light enough for older iPhones. The 3D head is opt-in (settings → "אווטאר תלת-ממדי").
 */
export function createAvatar(settings) {
  const speaker = Speaker.shared({ ttsEnabled: settings.tts, engine: voiceParam() || settings.ttsEngine || 'auto' });
  const forced = new URLSearchParams(location.search).get('avatar');
  const mode = forced || settings.avatarMode || 'auto';
  if (mode === '3d' && hasWebGL()) return new Avatar3DProvider({ speaker });
  return new PortraitAvatarProvider({ speaker, reason: mode === '3d' ? 'WebGL אינו זמין' : '' });
}
/** ?voice=native|neural|none (diagnostics/tests). */
export const voiceParam = () => { const v = new URLSearchParams(location.search).get('voice'); return ['native', 'neural', 'none', 'auto'].includes(v) ? v : null; };

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
      lipsyncModules: [], cameraView: 'head', cameraDistance: CAM_DIST, cameraY: -0.05,
      cameraRotateEnable: false, cameraPanEnable: false, cameraZoomEnable: false,
      modelFPS: 30, modelPixelRatio: this.pixelRatio / dpr,
      lightAmbientIntensity: 0.9, lightDirectIntensity: 4.2, lightDirectColor: 0xffe4cc, lightSpotIntensity: 0,
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
    const t = Math.tan(h.camera.fov * Math.PI / 360), z = CAM_DIST + 2;          // cameraDistance + 'head' view offset
    const targetY = p.y - 0.03;                                            // eyes slightly above centre
    const cameraX = -p.x / (t * z);
    const cameraY = 1 - (targetY - 4 * h.avatarHeight / 5) / (t * z);
    h.setView('head', { cameraX, cameraY, cameraDistance: CAM_DIST });
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
    const k = 1 - Math.exp(-dt / (this._closing ? 90 : 65)); // eased co-articulation (~65 ms attack, 90 ms release)
    // nod spring + transient brow lifts (word-onset impulses from speak())
    const N = this._nod || (this._nod = { p: 0, v: 0 }); stepSpring(N, dt);
    if (this.state === 'speaking') { this._rt('headRotateX', 0.035 * N.p); if (this._browUntil) this._rt('browInnerUp', now < this._browUntil ? 0.32 : 0.08); }
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
    const words = String(text).split(/\s+/);
    await this.speaker.speak(text, {
      onFrame: w => { if (this.head) this._applyVisemes(w); },
      onWord: i => {
        const wd = words[i] || '';
        if (i === 0 || /[.!?]$/.test(wd) || Math.random() < 0.28) { const N = this._nod || (this._nod = { p: 0, v: 0 }); N.v += 0.006 + Math.random() * 0.004; }
        if (/\?$/.test(wd) || Math.random() < 0.07) this._browUntil = performance.now() + 420;
      },
      onEnd: () => {}
    });
    if (tok !== this._tok) return;                         // superseded by a newer utterance
    // smooth close, then release visemes to TalkingHead
    const t0 = performance.now();
    this._closing = true;
    await new Promise(res => { const step = () => { this._applyVisemes({}); if (performance.now() - t0 < 260) requestAnimationFrame(step); else res(); }; step(); });
    this._closing = false;
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
// 2.5D portrait (DEFAULT): the generated photo, animated on a canvas — soft eased jaw/mouth driven by visemes × audio
// energy, natural blinks (lid warp), brow lifts, nods on word onsets, breathing and micro head sway. Cheap on phones.
// Geometry measured on the 512×512 assets/doctor.jpg (the head is slightly tilted; eyes carry their own angle).
const FACE = { cx: 260, lipY: 220, halfW: 33, chinY: 284 };
const EYES = [
  { cx: 215, cy: 155, w: 30, top: -6, bot: 5, a: -0.18, brow: { x: 214, y: 137, rx: 22, ry: 8 } },
  { cx: 285, cy: 142, w: 33, top: -6, bot: 5, a: -0.19, brow: { x: 286, y: 125, rx: 24, ry: 8 } }
];
const VIEW = { zoom: 1.16, cx: 256, cy: 205 };          // frame the face closer than the raw photo
const ease = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export class PortraitAvatarProvider extends AvatarProvider {
  constructor({ speaker, reason = '' }) {
    super(); this.speaker = speaker; this.kind = 'portrait'; this.reason = reason; this.state = 'idle';
    this.open = 0; this.round = 0; this.targetOpen = 0; this.targetRound = 0; this.energy = 0;
    this.anim = { blinks: 0, nods: 0, browLifts: 0, frames: 0 };
    this.blink = { v: 0, next: performance.now() + 1800, phase: 0, t0: 0, double: false };
    this.nod = { p: 0, v: 0 }; this.brow = { v: 0, target: 0, until: 0 };
    this.reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.__avatar = this;
  }
  set ttsEnabled(v) { this.speaker.ttsEnabled = v; this.speaker._decide?.(); }
  mount(el) {
    this.el = el;
    el.innerHTML = `
      <div class="avatar avatar-portrait" data-state="idle" data-kind="portrait">
        <canvas class="avatar-img" width="512" height="512" role="img" aria-label="אווטאר של נועה, עוזרת טריאז' דיגיטלית (תמונה ממוחשבת)"></canvas>
        <span class="avatar-state" aria-live="polite"></span>
      </div>`;
    this.root = el.querySelector('.avatar'); this.stateEl = el.querySelector('.avatar-state');
    this.canvas = el.querySelector('canvas'); this.g = this.canvas.getContext('2d');
    this.off = document.createElement('canvas'); this.off.width = this.off.height = 512; this.og = this.off.getContext('2d');
    this.img = new Image(); this.img.src = 'assets/doctor.jpg';
    this.ready = this.img.decode().then(() => { this._prepEyes(); this.loaded = true; this._start(); }).catch(() => {});
    return this.ready;
  }
  /** Axis-aligned patches of each eye region (rotated by the eye's tilt) so lids can be stretched along the eye axis. */
  _prepEyes() {
    this.eyePatches = EYES.map(E => {
      const W = E.w + 20, H = 40, c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d'); x.translate(W / 2, H / 2); x.rotate(-E.a); x.drawImage(this.img, -E.cx, -E.cy);
      return { c, W, H };
    });
  }
  _start() {
    let last = performance.now();
    const loop = now => {
      if (!this.canvas?.isConnected) { this._raf = 0; return; }
      const dt = Math.min(80, now - last); last = now;
      if (!document.hidden) this._update(now, dt), this.draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  _update(now, dt) {
    this.anim.frames++;
    // mouth: critically-damped easing (no snapping); slightly faster opening than closing
    const tauO = this.targetOpen > this.open ? 55 : 85;
    this.open = ease(this.open, this.targetOpen, dt, tauO); this.round = ease(this.round, this.targetRound, dt, 90);
    // blinks: 2.5–6 s apart, ~15% double blinks, ~150 ms close-open
    const B = this.blink;
    if (!B.phase && now >= B.next) { B.phase = 1; B.t0 = now; this.anim.blinks++; }
    if (B.phase) {
      const k = (now - B.t0) / 150;
      B.v = k < 0.45 ? k / 0.45 : k < 1 ? 1 - (k - 0.45) / 0.55 : 0;
      if (k >= 1) {
        B.phase = 0; B.v = 0;
        if (!B.double && Math.random() < 0.15) { B.double = true; B.next = now + 120; }
        else { B.double = false; B.next = now + 2500 + Math.random() * 3500 * (this.state === 'listening' ? 1.3 : 1); }
      }
    }
    // nod spring (impulses come from word onsets)
    stepSpring(this.nod, dt);
    // brows: target from state + transient lifts
    const base = this.state === 'listening' ? 0.55 : this.state === 'alert' ? 0.7 : 0;
    const tgt = now < this.brow.until ? Math.max(base, this.brow.target) : base;
    this.brow.v = ease(this.brow.v, tgt, dt, 140);
  }
  _onWord(i, text) {
    if (this.reduced) return;
    // nod on roughly every 3rd word and on sentence-final words; occasional brow lift for emphasis/questions
    const w = (text || '').trim();
    if (i === 0 || /[.!?]$/.test(w) || Math.random() < 0.28) { this.nod.v += 0.006 + Math.random() * 0.004; this.anim.nods++; }
    if (/\?$/.test(w) || (i === 0 && Math.random() < 0.5) || Math.random() < 0.07) { this.brow.target = 0.6 + Math.random() * 0.3; this.brow.until = performance.now() + 380 + Math.random() * 300; this.anim.browLifts++; }
  }
  draw() {
    const { g, og, img } = this; if (!this.loaded) return;
    const now = performance.now() / 1000;
    const r = this.reduced ? 0 : 1;
    const breath = Math.sin(now * 2 * Math.PI / 4.4);
    const sway = r * (0.006 * Math.sin(now * 0.71) + 0.004 * Math.sin(now * 1.37 + 1));
    const tilt = this.state === 'listening' ? 0.022 : 0;
    const nod = this.nod.p;                                   // ~0..1
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 512, 512);
    // view transform (closer framing) × head motion around the neck pivot
    const Z = VIEW.zoom * (1 + r * 0.004 * breath);
    g.translate(256, 256); g.scale(Z, Z); g.translate(-VIEW.cx, -VIEW.cy);
    g.translate(260, 400); g.rotate(sway + tilt + r * nod * 0.012); g.translate(-260, -400);
    g.translate(r * 0.8 * Math.sin(now * 0.53), r * (0.9 * breath + nod * 2.4));
    g.drawImage(img, 0, 0, 512, 512);
    this._drawBrows(this.brow.v);
    this._drawMouth(this.open, this.round);
    this._drawLids(this.blink.v);
  }
  _drawBrows(v) {
    if (v < 0.02) return;
    const { og, img, g } = this; const lift = v * 2.2;
    for (const E of EYES) {
      const b = E.brow;
      og.setTransform(1, 0, 0, 1, 0, 0); og.clearRect(0, 0, 512, 512);
      og.drawImage(img, b.x - b.rx - 4, b.y - b.ry - 6, b.rx * 2 + 8, b.ry * 2 + 10, b.x - b.rx - 4, b.y - b.ry - 6 - lift, b.rx * 2 + 8, b.ry * 2 + 10 + lift * 0.6);
      og.globalCompositeOperation = 'destination-in';
      og.translate(b.x, b.y); og.scale(1, b.ry / b.rx);
      const gr = og.createRadialGradient(0, 0, b.rx * 0.45, 0, 0, b.rx + 6);
      gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      og.fillStyle = gr; og.fillRect(-b.rx - 8, -b.rx - 8, b.rx * 2 + 16, b.rx * 2 + 16);
      og.setTransform(1, 0, 0, 1, 0, 0); og.globalCompositeOperation = 'source-over';
      g.drawImage(this.off, 0, 0);
    }
  }
  _drawLids(v) {
    if (v < 0.03 || !this.eyePatches) return;
    const { g } = this;
    EYES.forEach((E, i) => {
      const P = this.eyePatches[i]; const h = E.bot - E.top; const hs = 6;     // skin strip above the upper lid
      g.save(); g.translate(E.cx, E.cy); g.rotate(E.a);
      g.beginPath(); g.ellipse(0, (E.top + E.bot) / 2, E.w / 2 + 1.5, h / 2 + 2.5, 0, 0, Math.PI * 2); g.clip();
      const sy = P.H / 2 + E.top - hs;
      g.drawImage(P.c, 0, sy, P.W, hs + 1, -P.W / 2, E.top - hs, P.W, hs + 1 + v * (h + 1));
      if (v > 0.45) {                                         // lash line along the lid edge
        const y = E.top + v * (h + 1) - 0.5;
        g.strokeStyle = `rgba(48,30,28,${(v - 0.45) * 1.1})`; g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(-E.w / 2 + 2, y - 0.8); g.quadraticCurveTo(0, y + 1.2, E.w / 2 - 2, y - 0.8); g.stroke();
      }
      g.restore();
    });
  }
  _drawMouth(open, round) {
    if (open < 0.015) return;
    const { g, og, img } = this; const { cx, lipY, halfW, chinY } = FACE;
    const d = open * 7;                                       // jaw drop (px) — conversational, not exaggerated
    const rx = halfW * (0.86 - 0.3 * round), ry = 0.8 + open * 5.2;
    g.fillStyle = '#4a1f22'; g.beginPath(); g.ellipse(cx, lipY + d * 0.42, rx, ry, 0, 0, Math.PI * 2); g.fill();
    if (open > 0.3) { g.fillStyle = `rgba(232,224,218,${Math.min(0.8, (open - 0.3) * 2)})`; g.beginPath(); g.ellipse(cx, lipY + d * 0.42 - ry * 0.55, rx * 0.7, ry * 0.3, 0, 0, Math.PI * 2); g.fill(); }
    og.setTransform(1, 0, 0, 1, 0, 0); og.clearRect(0, 0, 512, 512);
    const top = lipY + 1, h = chinY + 26 - top;
    og.drawImage(img, cx - 80, top, 160, h, cx - 80 + round * 0.5, top + d, 160 - round, h);
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
    const words = String(text).split(/\s+/);
    await this.speaker.speak(text, {
      onFrame: (w, info) => {
        this.lastWeights = w; this.energy = info?.energy ?? 0;
        this.targetOpen = Math.min(1, opennessOf(w) * 0.85); this.targetRound = roundnessOf(w);
      },
      onWord: i => this._onWord(i, words[i])
    });
    if (tok !== this._tok) return;
    this.targetOpen = this.targetRound = 0;
    if (!keepAlert && this.state !== 'alert') this.setState('idle');
  }
  stop() { this.speaker.cancel(); this.targetOpen = 0; if (this.state !== 'alert') this.setState('idle'); }
  destroy() { cancelAnimationFrame(this._raf); this._raf = 0; }
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
