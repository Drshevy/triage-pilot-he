// Visual panel: on-screen content the assistant shows WHILE she speaks, synced to her words.
//   bodymap — body diagram; regions light up as they are named, a pointer marks the patient's pain location;
//             in typed mode a tap on a region answers the location question.
//   scale   — 0–10 pain scale; numbers light up as they are spoken; the patient's value is marked.
//   steps   — numbered instructions; the step being spoken is highlighted.
//   frame   — camera framing guide (live preview + oval + illustration of what to film + capture progress).
// All drawings are inline SVG (no images fetched, CSP 'self').
import { esc } from './util.js';

export const REGIONS = {
  head: { label: 'ראש', words: ['ראש', 'מצח', 'רקה', 'רקות'], shape: '<circle cx="100" cy="38" r="24"/>' },
  neck: { label: 'צוואר / גרון', words: ['צוואר', 'גרון'], shape: '<rect x="90" y="62" width="20" height="14" rx="4"/>' },
  chest: { label: 'חזה', words: ['חזה', 'לב', 'צלעות'], shape: '<rect x="68" y="78" width="64" height="46" rx="10"/>' },
  abd_upper: { label: 'בטן עליונה', words: ['בטן עליונה', 'פי הבטן', 'קיבה'], shape: '<rect x="72" y="126" width="56" height="26" rx="6"/>' },
  abd_lower: { label: 'בטן תחתונה', words: ['בטן תחתונה', 'למטה בבטן', 'בטן'], shape: '<rect x="72" y="154" width="56" height="28" rx="6"/>' },
  pelvis: { label: 'אגן / מפשעה', words: ['אגן', 'מפשעה', 'שלפוחית'], shape: '<rect x="74" y="184" width="52" height="20" rx="6"/>' },
  back: { label: 'גב', words: ['גב', 'מותניים', 'כליות'], shape: '<rect x="150" y="84" width="40" height="96" rx="10" class="back"/>' },
  arm_r: { label: 'יד ימין', words: ['יד ימין', 'כתף ימין', 'זרוע ימין'], shape: '<rect x="44" y="80" width="20" height="104" rx="9"/>' },
  arm_l: { label: 'יד שמאל', words: ['יד שמאל', 'כתף שמאל', 'זרוע שמאל'], shape: '<rect x="136" y="80" width="20" height="104" rx="9"/>' },
  leg_r: { label: 'רגל ימין', words: ['רגל ימין', 'ברך ימין', 'קרסול ימין'], shape: '<rect x="76" y="206" width="22" height="104" rx="9"/>' },
  leg_l: { label: 'רגל שמאל', words: ['רגל שמאל', 'ברך שמאל', 'קרסול שמאל'], shape: '<rect x="102" y="206" width="22" height="104" rx="9"/>' },
  skin: { label: 'עור / כללי', words: ['עור', 'כל הגוף'], shape: '' }
};
const CENTER = { head: [100, 38], neck: [100, 69], chest: [100, 100], abd_upper: [100, 139], abd_lower: [100, 168], pelvis: [100, 194], back: [170, 130], arm_r: [54, 130], arm_l: [146, 130], leg_r: [87, 258], leg_l: [113, 258], skin: [100, 140] };

const ILLU = {   // "what to film" illustrations
  skin: '<svg viewBox="0 0 160 100" class="illu"><rect x="10" y="40" width="110" height="34" rx="16" fill="#f3d2b8"/><g fill="#d9534f">' + [30, 44, 52, 66, 74, 88].map((x, i) => `<circle cx="${x}" cy="${52 + (i % 3) * 6}" r="3.2"/>`).join('') + '</g><rect x="112" y="8" width="38" height="66" rx="7" fill="#1f2937"/><rect x="116" y="14" width="30" height="50" rx="3" fill="#93c5fd"/><path d="M112 40 L96 56" stroke="#0ea5e9" stroke-width="3" stroke-dasharray="4 3"/></svg>',
  injury: '<svg viewBox="0 0 160 100" class="illu"><rect x="10" y="40" width="110" height="34" rx="16" fill="#f3d2b8"/><path d="M50 50 l24 14" stroke="#b91c1c" stroke-width="5" stroke-linecap="round"/><rect x="112" y="8" width="38" height="66" rx="7" fill="#1f2937"/><rect x="116" y="14" width="30" height="50" rx="3" fill="#93c5fd"/><path d="M112 40 L80 56" stroke="#0ea5e9" stroke-width="3" stroke-dasharray="4 3"/></svg>',
  swelling: '<svg viewBox="0 0 160 100" class="illu"><path d="M14 44 h40 q16 -14 32 0 h20 v26 h-20 q-16 14 -32 0 h-40z" fill="#f3d2b8"/><path d="M58 44 q16 -14 32 0" stroke="#ef4444" stroke-width="2" fill="none"/><text x="20" y="92" font-size="10" fill="#475569">גם הצד השני להשוואה</text><rect x="112" y="8" width="38" height="66" rx="7" fill="#1f2937"/><rect x="116" y="14" width="30" height="50" rx="3" fill="#93c5fd"/></svg>'
};

const words = s => String(s).split(/\s+/).filter(Boolean);
/** Word index at which `needle` starts inside `say` (for speech sync), or -1. */
export function wordIndexOf(say, needle) {
  const i = String(say).indexOf(needle); if (i < 0) return -1;
  return words(String(say).slice(0, i)).length;
}

export class VisualPanel {
  constructor(el) { this.el = el; this.spec = null; this.cleanup = []; }
  clear() { this.cleanup.forEach(f => { try { f(); } catch {} }); this.cleanup = []; this.spec = null; this.el.hidden = true; this.el.innerHTML = ''; this.el.dataset.kind = ''; }
  /** Show spec for an utterance `say`. opts.onPick(value) — tap answers (typed mode). Returns this. */
  show(spec, say = '', opts = {}) {
    this.clear(); if (!spec) return this;
    this.spec = spec; this.say = say; this.sayWords = words(say); this.el.hidden = false; this.el.dataset.kind = spec.kind;
    const k = spec.kind;
    window.__visual = { kind: k, lit: [], step: -1, shownAt: performance.now() };
    if (k === 'bodymap') this._bodymap(spec, opts);
    else if (k === 'scale') this._scale(spec, opts);
    else if (k === 'steps') this._steps(spec);
    else if (k === 'frame') this._frame(spec);
    return this;
  }
  _title(t) { return t ? `<div class="vis-title">${esc(t)}</div>` : ''; }
  _bodymap(spec, opts) {
    const regs = spec.regions || Object.keys(REGIONS).filter(r => r !== 'skin');
    this.el.innerHTML = `${this._title(spec.title || 'איפה זה כואב?')}
      <svg viewBox="0 0 200 320" class="bodymap" role="group" aria-label="מפת גוף">
        <g class="silhouette"><circle cx="100" cy="38" r="24"/><rect x="66" y="74" width="68" height="132" rx="20"/><rect x="44" y="78" width="20" height="108" rx="9"/><rect x="136" y="78" width="20" height="108" rx="9"/><rect x="76" y="204" width="22" height="108" rx="9"/><rect x="102" y="204" width="22" height="108" rx="9"/><rect x="150" y="84" width="40" height="96" rx="10" opacity=".5"/><text x="170" y="196" font-size="9" text-anchor="middle">גב</text></g>
        ${regs.map(r => REGIONS[r]?.shape ? (opts.interactive === false ? `<g class="region" data-r="${r}" aria-label="${esc(REGIONS[r].label)}">${REGIONS[r].shape}</g>` : `<g class="region" data-r="${r}" tabindex="0" role="button" aria-label="${esc(REGIONS[r].label)}">${REGIONS[r].shape}</g>`) : '').join('')}
        <g class="pointer" hidden><circle r="9" class="pulse"/><path d="M0 -26 L0 -12 M-6 -18 L0 -11 L6 -18" stroke-width="3"/></g>
      </svg><div class="vis-caption" id="vis-caption"></div>`;
    this.el.querySelectorAll('.region').forEach(g => g.onclick = () => { this.point(g.dataset.r); opts.onPick?.(g.dataset.r); });
    if (spec.highlight) this.point(spec.highlight);
  }
  /** Pointer + highlight on a body region (the patient's location). */
  point(r) {
    const g = this.el.querySelector(`.region[data-r="${r}"]`), p = this.el.querySelector('.pointer'), c = CENTER[r];
    this.el.querySelectorAll('.region').forEach(x => x.classList.toggle('picked', x === g));
    if (p && c) { p.hidden = false; p.setAttribute('transform', `translate(${c[0]} ${c[1]})`); }
    const cap = this.el.querySelector('#vis-caption'); if (cap) cap.textContent = REGIONS[r]?.label || '';
    if (window.__visual) window.__visual.pointed = r;
  }
  _scale(spec, opts) {
    const col = i => `hsl(${120 - i * 12},70%,${i > 7 ? 45 : 50}%)`;
    this.el.innerHTML = `${this._title(spec.title || 'סולם כאב 0–10')}
      <div class="painscale" role="group" aria-label="סולם 0 עד 10">${Array.from({ length: 11 }, (_, i) => opts.interactive === false ? `<span class="ps" data-v="${i}" style="--c:${col(i)}">${i}</span>` : `<button class="ps" data-v="${i}" style="--c:${col(i)}" aria-label="${i}">${i}</button>`).join('')}</div>
      <div class="ps-legend"><span>0 · בכלל לא</span><span>5 · בינוני</span><span>10 · הכי חזק שאפשר</span></div>`;
    this.el.querySelectorAll('.ps').forEach(b => b.onclick = () => { this.mark(+b.dataset.v); opts.onPick?.(+b.dataset.v); });
    if (spec.value !== undefined) this.mark(spec.value);
  }
  mark(v) { this.el.querySelectorAll('.ps').forEach(b => b.classList.toggle('picked', +b.dataset.v === v)); if (window.__visual) window.__visual.marked = v; }
  _steps(spec) {
    this.stepAt = spec.steps.map(s => wordIndexOf(this.say, s.split(/\s+/).slice(0, 3).join(' ')));
    this.el.innerHTML = `${this._title(spec.title)}${spec.illu && ILLU[spec.illu] ? ILLU[spec.illu] : ''}<ol class="vis-steps">${spec.steps.map((s, i) => `<li data-i="${i}">${esc(s)}</li>`).join('')}</ol>`;
  }
  _frame(spec) {
    this.stepAt = (spec.steps || []).map(s => wordIndexOf(this.say, s.split(/\s+/).slice(0, 3).join(' ')));
    this.el.innerHTML = `${this._title(spec.title || 'מסגרת צילום')}
      <div class="frame-wrap"><video id="frame-video" autoplay playsinline muted></video><div class="frame-oval"></div><div class="frame-rec" hidden>● REC <span id="frame-sec"></span></div><div class="frame-msg" id="frame-msg">המצלמה תופעל אוטומטית</div></div>
      <div class="frame-side">${spec.illu && ILLU[spec.illu] ? ILLU[spec.illu] : ''}<ol class="vis-steps">${(spec.steps || []).map((s, i) => `<li data-i="${i}">${esc(s)}</li>`).join('')}</ol></div>
      <div class="progress" id="frame-prog"><i></i></div>`;
  }
  attachStream(stream) { const v = this.el.querySelector('#frame-video'); if (v && stream) { v.srcObject = stream; v.play?.().catch(() => {}); } }
  frameStatus(msg, { rec = false, sec, pct } = {}) {
    const m = this.el.querySelector('#frame-msg'); if (m) m.textContent = msg;
    const r = this.el.querySelector('.frame-rec'); if (r) r.hidden = !rec;
    if (sec !== undefined) { const s = this.el.querySelector('#frame-sec'); if (s) s.textContent = sec; }
    if (pct !== undefined) { const i = this.el.querySelector('#frame-prog i'); if (i) i.style.width = `${pct}%`; }
  }
  /** Speech sync: called with the index of the word being spoken. */
  onWord(i) {
    const s = this.spec; if (!s) return;
    const w = this.sayWords[i] || '', two = `${w} ${this.sayWords[i + 1] || ''}`;
    if (s.kind === 'bodymap') {
      for (const [r, R] of Object.entries(REGIONS)) if (R.words.some(k => two.startsWith(k) || w.replace(/^[ובהלמכש]/, '').startsWith(k))) {
        const g = this.el.querySelector(`.region[data-r="${r}"]`); if (g) { g.classList.add('lit'); setTimeout(() => g.classList.remove('lit'), 900); window.__visual?.lit.push(r); }
      }
    } else if (s.kind === 'scale') {
      const n = { 'אפס': 0, 'מאפס': 0, 'חמש': 5, 'עשר': 10, 'לעשר': 10, 'עד': null }[w.replace(/[,.?]/g, '')];
      if (n !== undefined && n !== null) { const b = this.el.querySelector(`.ps[data-v="${n}"]`); b?.classList.add('lit'); setTimeout(() => b?.classList.remove('lit'), 1200); window.__visual?.lit.push(n); }
    } else if (s.kind === 'steps' || s.kind === 'frame') {
      let cur = -1; (this.stepAt || []).forEach((at, k) => { if (at >= 0 && i >= at) cur = k; });
      if (cur >= 0 && cur !== this._cur) { this._cur = cur; this.el.querySelectorAll('.vis-steps li').forEach(li => li.classList.toggle('now', +li.dataset.i === cur)); if (window.__visual) { window.__visual.step = cur; (window.__visual.steps ||= []).push(cur); } }
    }
  }
}
