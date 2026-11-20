// Hebrew (and basic Latin) text → approximate phonemes → Oculus visemes → timed timeline.
//
// Browser speechSynthesis audio cannot be analysed, so lip-sync is driven from the TEXT:
//  1. Each word is converted to a viseme sequence. Unpointed Hebrew has few written vowels, so implicit vowels are
//     inserted between consonant clusters (alternating a/e — the most frequent Hebrew vowels). If niqqud is present it
//     is used directly. Matres lectionis (ו/י/א/ע/ה) are mapped to vowels by position.
//  2. Durations are estimated from a speech rate (≈14 Hebrew letters/s at rate 1) and punctuation pauses.
//  3. speaker.js plays the timeline and RESYNCS on every speechSynthesis 'boundary' event (word charIndex), falling back
//     to the pure estimate when a voice fires no boundary events (common on mobile).
// Oculus viseme set: sil PP FF TH DD kk CH SS nn RR aa E I O U

export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'];
const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U']);
// Peak weight per viseme (how wide/strong the mouth shape is)
const WEIGHT = { PP: 1, FF: 0.8, TH: 0.6, DD: 0.6, kk: 0.55, CH: 0.75, SS: 0.65, nn: 0.55, RR: 0.55, aa: 0.95, E: 0.75, I: 0.65, O: 0.85, U: 0.8 };
// Relative durations (vowels are longer than consonants; plosives short)
const DUR = { PP: 0.75, FF: 0.9, TH: 0.85, DD: 0.65, kk: 0.7, CH: 0.95, SS: 0.95, nn: 0.75, RR: 0.7, aa: 1.25, E: 1.1, I: 1.05, O: 1.2, U: 1.15 };

const HEB = {
  'ב': w => (w.i === 0 ? 'PP' : 'FF'), 'ג': 'kk', 'ד': 'DD', 'ז': 'SS', 'ח': 'kk', 'ט': 'DD', 'כ': w => (w.i === 0 ? 'kk' : 'kk'), 'ך': 'kk',
  'ל': 'nn', 'מ': 'PP', 'ם': 'PP', 'נ': 'nn', 'ן': 'nn', 'ס': 'SS', 'פ': w => (w.i === 0 ? 'PP' : 'FF'), 'ף': 'FF', 'צ': 'SS', 'ץ': 'SS',
  'ק': 'kk', 'ר': 'RR', 'ש': 'CH', 'ת': 'DD'
};
const NIQQUD = { '\u05B7': 'aa', '\u05B8': 'aa', '\u05B2': 'aa', '\u05B3': 'O', '\u05B6': 'E', '\u05B5': 'E', '\u05B1': 'E', '\u05B4': 'I', '\u05B9': 'O', '\u05BA': 'O', '\u05BB': 'U' };
const LATIN = { a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I', b: 'PP', p: 'PP', m: 'PP', f: 'FF', v: 'FF', w: 'U', t: 'DD', d: 'DD', n: 'nn', l: 'nn', k: 'kk', g: 'kk', c: 'kk', q: 'kk', x: 'kk', h: 'kk', j: 'CH', s: 'SS', z: 'SS', r: 'RR' };
const DIGIT = ['E', 'SS', 'aa'];

const isHebLetter = c => c >= '\u05D0' && c <= '\u05EA';
const isNiqqud = c => c >= '\u0591' && c <= '\u05C7';

/** Visemes for a single word (array of viseme ids). */
export function wordToVisemes(word) {
  const out = []; const chars = [...word];
  const letters = chars.filter(isHebLetter);
  if (letters.length) {
    let li = -1; let implicit = 0;
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k]; if (!isHebLetter(c)) continue;
      li++;
      const next = chars.slice(k + 1).find(x => !isNiqqud(x) || NIQQUD[x]);
      const pointedVowel = chars.slice(k + 1).filter(isNiqqud).length ? chars.slice(k + 1, k + 4).find(x => NIQQUD[x]) : null;
      const first = li === 0, last = li === letters.length - 1;
      const w = { i: li, last };
      if (c === 'ו') {
        if (chars[k + 1] === '\u05BC' && !first) { out.push('U'); continue; }   // shuruk
        if (first) { out.push('FF', 'E'); continue; }                            // conjunction "ve-"
        out.push(li % 2 ? 'O' : 'U'); continue;                                  // mater lectionis
      }
      if (c === 'י') { out.push(first ? 'I' : 'I'); continue; }
      if (c === 'א' || c === 'ע') { out.push(pointedVowel ? NIQQUD[pointedVowel] : (last ? 'aa' : 'aa')); continue; }
      if (c === 'ה') { if (last) out.push('aa'); else { out.push('kk'); if (!pointedVowel) out.push('aa'); } continue; }
      const m = HEB[c]; const v = typeof m === 'function' ? m(w) : m;
      if (v) out.push(v);
      if (pointedVowel) out.push(NIQQUD[pointedVowel]);
      else if (!last && next && isHebLetter(next) && !'ויאעה'.includes(next)) out.push(implicit++ % 2 ? 'E' : 'aa'); // implicit vowel
      else if (last && !VOWELS.has(out[out.length - 1]) && letters.length === 1) out.push('E');
    }
    return out.filter((v, i) => v !== out[i - 1]);
  }
  for (const ch of word.toLowerCase()) {
    if (LATIN[ch]) out.push(LATIN[ch]);
    else if (/[0-9]/.test(ch)) out.push(...DIGIT);
  }
  // collapse duplicate consecutive visemes
  return out.filter((v, i) => v !== out[i - 1]);
}

/**
 * Build a timeline. Returns { words:[{text,charStart,start,end}], segs:[{v,w,start,end}], total } in ms.
 * rate: speechSynthesis rate (1 = normal). cps: letters per second at rate 1.
 */
export function buildTimeline(text, { rate = 1, cps = 14 } = {}) {
  const words = []; const segs = []; let t = 0;
  const re = /\S+/g; let m;
  const msPerLetter = 1000 / (cps * rate);
  while ((m = re.exec(text))) {
    const raw = m[0];
    const clean = raw.replace(/[.,!?;:"'()\[\]{}–—\-…״׳]/g, '');
    const vis = clean ? wordToVisemes(clean) : [];
    const letters = [...clean].filter(c => !isNiqqud(c)).length;
    const wordDur = Math.max(140, letters * msPerLetter);
    const totalW = vis.reduce((s, v) => s + (DUR[v] || 1), 0) || 1;
    const start = t;
    for (const v of vis) {
      const d = wordDur * (DUR[v] || 1) / totalW;
      segs.push({ v, w: WEIGHT[v] || 0.6, start: t, end: t + d });
      t += d;
    }
    words.push({ text: raw, charStart: m.index, start, end: t });
    // inter-word gap + punctuation pauses
    if (/[.!?…]$/.test(raw)) t += 380 / rate; else if (/[,;:–—]$/.test(raw)) t += 220 / rate; else t += 35 / rate;
  }
  return { words, segs, total: t };
}

/** Find the word index for a speechSynthesis boundary charIndex. */
export function wordAtChar(tl, charIndex) {
  let idx = 0;
  for (let i = 0; i < tl.words.length; i++) if (tl.words[i].charStart <= charIndex) idx = i; else break;
  return idx;
}

/** Viseme weights at time t (ms) with short attack/release crossfades. Returns {visemeId: weight}. */
export function weightsAt(tl, t) {
  const out = {};
  // binary search the active segment
  let lo = 0, hi = tl.segs.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const s = tl.segs[mid]; if (t < s.start) hi = mid - 1; else if (t >= s.end) lo = mid + 1; else { idx = mid; break; } }
  if (idx < 0) return out;
  const s = tl.segs[idx]; const len = s.end - s.start;
  const ramp = Math.min(45, len / 2);
  const a = Math.min(1, (t - s.start) / ramp), r = Math.min(1, (s.end - t) / ramp);
  out[s.v] = s.w * Math.min(a, 1) * (0.55 + 0.45 * Math.min(r, 1));
  // co-articulation: blend in the neighbour near the boundaries
  const prev = tl.segs[idx - 1], next = tl.segs[idx + 1];
  if (prev && prev.end >= s.start - 1 && a < 1) out[prev.v] = (out[prev.v] || 0) + prev.w * (1 - a) * 0.6;
  if (next && next.start <= s.end + 1 && r < 1) out[next.v] = (out[next.v] || 0) + next.w * (1 - r) * 0.35;
  return out;
}

/** Overall "mouth openness" 0..1 for simple 2D fallbacks. */
export function opennessOf(weights) {
  const open = { aa: 1, O: 0.85, E: 0.65, U: 0.5, I: 0.45, CH: 0.35, SS: 0.25, DD: 0.3, kk: 0.35, nn: 0.25, RR: 0.35, TH: 0.3, FF: 0.15, PP: 0 };
  let o = 0; for (const [v, w] of Object.entries(weights)) o = Math.max(o, (open[v] ?? 0.2) * w);
  return Math.min(1, o);
}
export function roundnessOf(weights) { return Math.min(1, (weights.O || 0) + (weights.U || 0)); }
