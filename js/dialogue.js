// DialogueProvider abstraction + deterministic rule-based implementation.
//
// Swap point: an LLMDialogueProvider can implement the same interface (start/answer/getState) and use
// an LLMProvider (see knowledge.js) to phrase questions conversationally — but the *facts* it extracts
// must use the same fact ids so that red-flag detection, urgency and validation (engine.js) keep working
// deterministically. Red-flag rules run on every answer regardless of provider.
import { evalCond, detectRedFlags, factsIn } from './engine.js';
import { extractFacts, extractName, classify as nluClassify, parseYesNo, parseChoice, parseMulti, parseSeverity, parseNumber, norm, mention } from './nlu.js';

/** @interface */
export class DialogueProvider {
  /** @returns {Promise<Turn>} */ async start(_ctx) { throw new Error('not implemented'); }
  /** @returns {Promise<{turn: Turn, newAlerts: any[]}>} */ async answer(_input) { throw new Error('not implemented'); }
  getState() { throw new Error('not implemented'); }
}

const YES = ['כן', 'yes', 'נכון', 'בטח', 'יש'], NO = ['לא', 'no', 'אין', 'ממש לא'];

export class RuleBasedDialogue extends DialogueProvider {
  constructor(rules, patient) {
    super();
    this.rules = rules;
    this.facts = { age: Number(patient.age), sex: patient.sex, _text: '' };
    this.answered = [];
    this.labels = {};          // id -> human answer label
    this.questions = {};       // id -> question text (for summary)
    this.alertedIds = new Set();
  }
  getState() { return { facts: this.facts, answered: this.answered, labels: this.labels, questions: this.questions, required: this.required() }; }

  core() {
    const cats = Object.entries(this.rules.categories).map(([v, c]) => ({ v, label: c.label }));
    return {
      complaint: { id: 'complaint', type: 'complaint', text: 'איך אפשר לעזור? תאר/י במילים שלך מה מטריד אותך, או בחר/י נושא מהרשימה.', options: cats },
      category_pick: { id: 'category_pick', type: 'choice', text: 'כדי לכוון את השאלות — איזה נושא הכי מתאים לתלונה?', options: cats },
      onset: { id: 'onset', type: 'choice', text: 'מתי זה התחיל?', options: [ { v: 'hour', label: 'בשעה האחרונה' }, { v: 'today', label: 'היום' }, { v: 'days', label: '1–3 ימים' }, { v: 'week', label: 'כשבוע' }, { v: 'month', label: 'יותר מחודש' } ] },
      severity: { id: 'severity', type: 'scale', text: 'בסולם מ-0 עד 10, כמה זה חזק או מטריד כרגע? (0 = בכלל לא, 10 = הכי חזק שאפשר)' },
      history: { id: 'history', type: 'multi', text: 'האם יש לך מחלות רקע? אפשר לבחור כמה.', options: [ { v: 'heart', label: 'מחלת לב' }, { v: 'htn', label: 'יתר לחץ דם' }, { v: 'diabetes', label: 'סוכרת' }, { v: 'lung', label: 'אסתמה / ריאות' }, { v: 'kidney', label: 'מחלת כליות' }, { v: 'immuno', label: 'דיכוי חיסוני' }, { v: 'cancer', label: 'מחלה אונקולוגית' }, { v: 'none', label: 'אין' } ] },
      meds: { id: 'meds', type: 'text', text: 'אילו תרופות את/ה נוטל/ת באופן קבוע? (אפשר לכתוב "אין")' },
      allergies: { id: 'allergies', type: 'text', text: 'האם יש לך אלרגיות לתרופות או למזון? (אפשר לכתוב "אין")' },
      labs_ask: { id: 'labs_ask', type: 'yesno', text: 'האם יש לך תוצאות בדיקות דם, שתן או הדמיה (צילום, CT, אולטרסאונד) — עדכניות או ישנות — שתרצה/י לצרף?' },
      labs_upload: { id: 'labs_upload', type: 'upload', text: 'אפשר להעלות קובץ PDF או צילום מסך של התוצאות. לפני כל העלאה אבקש את הסכמתך. הקובץ מעובד רק במכשיר הזה ומוצפן.', when: { f: 'labs_ask', eq: true } },
      closing: { id: 'closing', type: 'text', optional: true, text: 'לפני שנסיים — יש עוד משהו שחשוב שהרופא/ה שלך יידע/תדע?' }
    };
  }

  plan() {
    const C = this.core(), f = this.facts, R = this.rules;
    const out = [C.complaint];
    if (f.category_method === 'pending') out.push(C.category_pick);
    if (!f.category || f.category_method === 'pending') return out;
    out.push(C.onset, C.severity);
    const cat = R.categories[f.category];
    out.push(...cat.questions);
    if (f.age < 16) out.push(...R.pediatricQuestions);
    if (f.sex === 'female' && f.age >= 12 && f.age <= 55) out.push(...R.pregnancyQuestions);
    out.push(R.generalRedFlagQuestion);
    if (cat.film) out.push({ id: 'film', type: 'film', text: R.filming.prompts[f.category] || 'אנא צלם/י את האזור הרלוונטי.' });
    out.push(C.history, C.meds, C.allergies, C.labs_ask, C.labs_upload, C.closing);
    return out;
  }
  required() { return this.plan().filter(q => !q.optional && q.type !== 'upload' && q.id !== 'category_pick' && evalCond(q.when, this.facts)).map(q => q.id); }

  next() {
    return this.plan().find(q => !this.answered.includes(q.id) && evalCond(q.when, this.facts)) || null;
  }
  turnFor(q, prefix = '') {
    if (!q) return { say: 'תודה רבה. סיימנו את השאלות. אני מכינה עכשיו סיכום עבור הרופא/ה שלך.', question: null, done: true };
    this.questions[q.id] = q.text;
    return { say: (prefix ? prefix + ' ' : '') + q.text, question: q, done: false };
  }
  async start() {
    const intro = 'שלום, אני נועה, עוזרת טריאז\' דיגיטלית. אני לא רופאה ואני לא נותנת אבחנה — אני אשאל כמה שאלות ואכין סיכום לרופא/ה שלך. במצב חירום יש לחייג 101.';
    return this.turnFor(this.next(), intro);
  }

  classify(text) {
    // Most keyword hits wins; ties go to the category mentioned first in the patient's words.
    const t = String(text || '').toLowerCase(); let best = null, bestN = 0, bestPos = Infinity;
    for (const [id, c] of Object.entries(this.rules.categories)) {
      const hits = c.keywords.map(k => t.indexOf(k.toLowerCase())).filter(i => i >= 0);
      const n = hits.length, pos = n ? Math.min(...hits) : Infinity;
      if (n > bestN || (n === bestN && n > 0 && pos < bestPos)) { best = id; bestN = n; bestPos = pos; }
    }
    return best;
  }

  /** input: { value?, text? } — value from UI controls, text from typing/speech. */
  async answer(input) {
    const q = this.next();
    if (!q) return { turn: this.turnFor(null), newAlerts: [] };
    let { value, text } = input;
    if (text) this.facts._text += ' ' + text;
    let label = '';
    const opts = q.options || [];
    switch (q.type) {
      case 'complaint': {
        if (value) { this.facts.category = value; this.facts.category_method = 'chip'; label = opts.find(o => o.v === value)?.label || value; this.facts.complaint_text = label; }
        else {
          this.facts.complaint_text = text; label = text;
          const c = this.classify(text);
          if (c) { this.facts.category = c; this.facts.category_method = 'keyword'; }
          else { this.facts.category_method = 'pending'; }
        }
        break;
      }
      case 'choice': {
        if (value === undefined && text) value = opts.find(o => text.includes(o.label))?.v;
        if (value === undefined) return this._retry(q);
        label = opts.find(o => o.v === value)?.label || value;
        if (q.id === 'category_pick') { this.facts.category = value; this.facts.category_method = value === 'general' ? 'fallback' : 'chip'; }
        else this.facts[q.id] = value;
        break;
      }
      case 'yesno': {
        if (value === undefined && text) {
          const t = text.trim().toLowerCase();
          if (YES.some(y => t.startsWith(y))) value = true; else if (NO.some(n => t.startsWith(n))) value = false;
        }
        if (value === undefined) return this._retry(q);
        this.facts[q.id] = value; label = value ? 'כן' : 'לא';
        break;
      }
      case 'multi': {
        if (!Array.isArray(value) && text) value = opts.filter(o => text.includes(o.label)).map(o => o.v);
        value = (value || []).filter(v => v !== 'none');
        this.facts[q.id] = value;
        label = value.length ? value.map(v => opts.find(o => o.v === v)?.label || v).join(', ') : 'אף אחד';
        break;
      }
      case 'scale': {
        if (value === undefined && text) { const m = String(text).match(/\d+/); if (m) value = Math.min(10, Number(m[0])); }
        if (value === undefined) return this._retry(q);
        this.facts[q.id] = Number(value); label = `${value}/10`;
        break;
      }
      case 'film': this.facts.film = value; label = value === 'ok' ? 'צולם וצורף' : `צילום לא הועבר (${input.reason || 'לא צוין'})`; break;
      case 'upload': this.facts.labs_upload = value; label = `${input.count || 0} קבצים הועלו`; break;
      default: this.facts[q.id] = text || ''; label = text || '—';
    }
    this.answered.push(q.id); this.labels[q.id] = label;
    const all = detectRedFlags(this.rules, this.facts);
    const newAlerts = all.filter(a => !this.alertedIds.has(a.id));
    newAlerts.forEach(a => this.alertedIds.add(a.id));
    const ack = q.type === 'complaint' && this.facts.category && this.facts.category_method !== 'pending'
      ? `הבנתי, נתמקד ב${this.rules.categories[this.facts.category].label}.` : 'תודה.';
    return { turn: this.turnFor(this.next(), ack), newAlerts, label };
  }
  _retry(q) { return { turn: { say: 'לא הצלחתי להבין את התשובה. ' + q.text, question: q, done: false }, newAlerts: [], retry: true }; }
}

// ================================================================================================
// ConversationalDialogue (default): a natural spoken/typed conversation driven by the same rules.json.
//  * Greeting: Noa introduces herself; the patient answers with a name (or just "hello"); the name is used from then on.
//  * "איך אפשר לעזור?" → free text, parsed by nlu.js (negation-aware) into facts; anything already said is never asked.
//  * One follow-up at a time, picked by expected information gain over the differential distribution, plus weight
//    for red-flag (safety) and urgency facts — those are always asked. Low-value questions are skipped.
//  * The avatar decides itself when to ask for filming (visual complaints) and for labs/imaging/documents
//    (category-relevant or systemic picture), explaining why.
//  * Red-flag rules run on every utterance (deterministic, engine.js).
//  * Closing: "אבחנה משוערת + טיפול משוער" (assessment.js), framed as a preliminary AI assessment to confirm with a doctor.
const MAX_FOLLOWUPS = 10, IG_MIN = 0.15;
const VISUAL = ['פריחה', 'פצע', 'נפיחות', 'נפוח', 'נפוחה', 'אדמומיות', 'אדום', 'אדומה', 'שטף דם', 'כוויה', 'חבורה', 'גרד', 'שלפוחית', 'עקיצה', 'כתם'];
const LAB_WHY = {
  chest: 'בדיקות דם או אק"ג', breathing: 'צילום חזה או בדיקות דם', abdominal: 'בדיקות דם, שתן או אולטרסאונד', fever: 'ספירת דם, CRP או בדיקת שתן',
  urinary: 'בדיקת שתן או תרבית', endocrine: 'בדיקות סוכר, HbA1c או בלוטת התריס', heme: 'ספירת דם', oncology: 'בדיקות דם או הדמיה',
  swelling: 'אולטרסאונד או בדיקות דם', injury: 'צילום רנטגן', obgyn: 'בדיקת הריון או אולטרסאונד', neuro: 'CT או MRI'
};
const LAB_CATS = new Set(Object.keys(LAB_WHY));
const ACKS = ['הבנתי.', 'תודה.', 'אוקיי, רשמתי.', 'תודה, זה עוזר לי להבין.', 'בסדר גמור.', 'תודה על הפירוט.'];
const H = p => p.reduce((s, x) => (x > 0 ? s - x * Math.log2(x) : s), 0);

export class ConversationalDialogue extends DialogueProvider {
  constructor(rules, patient) {
    super();
    this.rules = rules; this.patient = patient;
    this.facts = { age: Number(patient.age), sex: patient.sex, _text: '' };
    this.answered = []; this.labels = {}; this.questions = {}; this.alertedIds = new Set(); this.alerts = [];
    this.asked = []; this.retries = {}; this.turnNo = 0; this.ackI = 0; this.followups = 0; this.inferred = [];
    this.name = String(patient.name || '').trim().split(/\s+/)[0] || ''; this.nameSource = 'intake';
    this.greeted = false; this.docs = undefined; this.cur = null;
  }
  g(m, f) { return this.patient.sex === 'female' ? f : m; }
  getState() { return { facts: this.facts, answered: this.answered, labels: this.labels, questions: this.questions, required: this.required(), name: this.name, nameSource: this.nameSource, asked: [...this.asked], inferred: [...this.inferred] }; }

  // ---------- catalog ----------
  core() {
    const cats = Object.entries(this.rules.categories).map(([v, c]) => ({ v, label: c.label })), g = this.g.bind(this);
    return {
      greet: { id: 'greet', type: 'text', text: `שלום! אני נועה, עוזרת טריאז' דיגיטלית. אני לא רופאה ואני לא נותנת אבחנה סופית: אשאל כמה שאלות ואכין סיכום לרופא או לרופאה שלך. במצב חירום חייגו 101. איך קוראים ${g('לך', 'לך')}?`, placeholder: 'לדוגמה: שלום, קוראים לי…' },
      complaint: { id: 'complaint', type: 'complaint', text: `איך אפשר לעזור? ${g('ספר', 'ספרי')} לי במילים שלך מה מטריד אותך.`, options: cats },
      complaint_more: { id: 'complaint_more', type: 'text', text: `אני רוצה לוודא שהבנתי. ${g('תוכל', 'תוכלי')} לתאר קצת יותר: איפה זה, ומה בדיוק ${g('אתה מרגיש', 'את מרגישה')}?` },
      category_pick: { id: 'category_pick', type: 'choice', text: 'כדי לכוון את השאלות: איזה נושא הכי מתאים?', options: cats },
      onset: { id: 'onset', type: 'choice', text: 'מתי זה התחיל?', options: [{ v: 'hour', label: 'בשעה האחרונה' }, { v: 'today', label: 'היום' }, { v: 'days', label: '1–3 ימים' }, { v: 'week', label: 'כשבוע' }, { v: 'month', label: 'יותר מחודש' }] },
      severity: { id: 'severity', type: 'scale', text: 'בסולם מאפס עד עשר, כמה זה חזק או מטריד כרגע?' },
      history: { id: 'history', type: 'multi', text: `יש לך מחלות רקע, כמו מחלת לב, לחץ דם, סוכרת או אסתמה?`, options: [{ v: 'heart', label: 'מחלת לב' }, { v: 'htn', label: 'יתר לחץ דם' }, { v: 'diabetes', label: 'סוכרת' }, { v: 'lung', label: 'אסתמה / ריאות' }, { v: 'kidney', label: 'מחלת כליות' }, { v: 'immuno', label: 'דיכוי חיסוני' }, { v: 'cancer', label: 'מחלה אונקולוגית' }, { v: 'none', label: 'אין' }] },
      meds: { id: 'meds', type: 'text', text: `אילו תרופות ${g('אתה לוקח', 'את לוקחת')} באופן קבוע? אפשר להגיד "אין".` },
      allergies: { id: 'allergies', type: 'text', text: 'יש לך אלרגיה לתרופות או למזון?' },
      closing: { id: 'closing', type: 'text', optional: true, text: `לפני שנסיים: יש עוד משהו שחשוב ${g('שהרופא שלך', 'שהרופא שלך')} יידע?` }
    };
  }
  catQuestions() {
    const R = this.rules, f = this.facts, cat = R.categories[f.category];
    if (!cat) return [];
    const C = this.core(), out = [C.onset, C.severity, ...cat.questions];
    if (f.age < 16) out.push(...R.pediatricQuestions);
    if (f.sex === 'female' && f.age >= 12 && f.age <= 55) out.push(...R.pregnancyQuestions);
    out.push(R.generalRedFlagQuestion);
    return out;
  }
  findQ(id) { return [...Object.values(this.core()), ...this.catQuestions(), ...Object.values(this.rules.categories).flatMap(c => c.questions)].find(q => q.id === id); }
  /** Facts that feed red-flag / urgency rules applicable to the current category → must be asked. */
  safetyFacts() {
    const cat = this.facts.category, out = new Map();
    const applies = w => { const fs = factsIn(w); if (!fs.has('category')) return true; const s = JSON.stringify(w); return s.includes(`"eq":"${cat}"`) || s.includes(`"${cat}"`); };
    for (const rf of this.rules.redFlags) if (applies(rf.when)) for (const f of factsIn(rf.when)) if (f !== 'category') out.set(f, Math.max(out.get(f) || 0, 2));
    for (const r of this.rules.urgencyRules || []) if (applies(r.when)) for (const f of factsIn(r.when)) if (f !== 'category' && !out.has(f)) out.set(f, 0.5);
    out.set('rf_general', 2); if (out.has('preg_warning')) out.set('preg_warning', 2);
    if (['abdominal', 'obgyn'].includes(cat)) out.set('pregnant', 2);
    return out;
  }
  dist(facts) {
    const cat = this.rules.categories[facts.category]; if (!cat) return [1];
    const sc = cat.differentials.map(d => Math.max(0, d.base + d.boost.reduce((s, b) => s + (evalCond(b.when, facts) ? b.w : 0), 0)));
    const t = sc.reduce((a, b) => a + b, 0) || 1; return sc.map(x => x / t);
  }
  outcomes(q) {
    if (q.type === 'yesno') return [true, false];
    if (q.type === 'choice') return (q.options || []).map(o => o.v);
    if (q.type === 'scale') return [2, 5, 8];
    if (q.type === 'multi') return [[], ...(q.options || []).filter(o => o.v !== 'none').map(o => [o.v])];
    return [];
  }
  infoGain(q) {
    const o = this.outcomes(q); if (!o.length) return 0;
    const h0 = H(this.dist(this.facts));
    const e = o.reduce((s, v) => s + H(this.dist({ ...this.facts, [q.id]: v })), 0) / o.length;
    return Math.max(0, h0 - e);
  }
  scoreQ(q, safety) { const ig = this.infoGain(q); const sf = safety.get(q.id) || 0; return { ig, score: ig + sf + (q.id === 'onset' || q.id === 'severity' ? 0.9 : 0), must: sf >= 0.5 || q.id === 'onset' || q.id === 'severity' }; }

  isOpen(id) { return !this.answered.includes(id); }
  /** Pick the next question (or null when done). */
  next() {
    const f = this.facts, C = this.core();
    if (!this.greeted) return C.greet;
    if (!f.category) {
      if (this.isOpen('complaint')) return C.complaint;
      if (f.category_method === 'pending' && this.isOpen('complaint_more')) return C.complaint_more;
      return C.category_pick;
    }
    // clinical follow-ups by value
    const safety = this.safetyFacts();
    const pool = this.catQuestions().filter(q => this.isOpen(q.id) && evalCond(q.when, f));
    if (pool.length && this.followups < MAX_FOLLOWUPS + safety.size) {
      const scored = pool.map(q => ({ q, ...this.scoreQ(q, safety) })).sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best.must || (best.ig >= IG_MIN && this.followups < MAX_FOLLOWUPS)) return { ...best.q, _ig: +best.ig.toFixed(3), _why: best.must ? 'safety/urgency' : 'information-gain' };
    }
    // filming (avatar-initiated): category requires it or the patient described something visible
    const cat = this.rules.categories[f.category];
    const visual = cat.film || VISUAL.some(w => { const r = mention(f._text, [w]); return r.found && !r.negated; });
    if (visual && this.isOpen('film')) {
      const prompt = this.rules.filming.prompts[f.category] || `אם אפשר, ${this.g('צלם', 'צלמי')} את האזור שמטריד אותך, באור טוב.`;
      return { id: 'film', type: 'film', initiated: 'film', text: prompt, say: `כדי שהרופא או הרופאה יוכלו לראות את זה בעצמם, אני רוצה לבקש ממך לצלם. ${prompt}` };
    }
    for (const id of ['history', 'meds', 'allergies']) if (this.isOpen(id)) return C[id];
    // labs / imaging / documents (avatar-initiated)
    if (this.isOpen('labs_upload')) {
      const why = LAB_WHY[f.category] || 'בדיקות דם או הדמיה';
      const systemic = /חום/.test(f._text) || Number(f.severity) >= 7 || f.age >= 65 || f.fever_temp === 'high' || f.fever_temp === 'mid';
      if (this.docs === true || f.labs_ask === true) return { id: 'labs_upload', type: 'upload', initiated: 'labs', text: `אפשר להעלות קובץ PDF או צילום מסך של התוצאות (${why}). לפני כל העלאה אבקש את הסכמתך; הקובץ מעובד רק במכשיר הזה ומוצפן.`, say: `${this.docs === true && this.isOpen('labs_ask') ? 'הזכרת שיש לך תוצאות. ' : ''}${g2(this, 'אשמח', 'אשמח')} אם ${this.g('תעלה', 'תעלי')} אותן עכשיו, כדי שהרופא יראה את התמונה המלאה. אפשר קובץ PDF או צילום מסך.` };
      if (this.isOpen('labs_ask') && this.docs !== false && (LAB_CATS.has(f.category) || systemic)) return { id: 'labs_ask', type: 'yesno', initiated: 'labs', text: `במצב כזה, ${why} יכולים לעזור לרופא מאוד. יש לך תוצאות של בדיקות כאלה, או של בדיקות דם או הדמיה אחרות, גם ישנות, ${this.g('שתרצה', 'שתרצי')} לצרף?` };
    }
    if (this.isOpen('closing')) return C.closing;
    return null;
  }
  required() {
    const base = this.asked.filter(id => { const q = this.findQ(id); return q && !q.optional && q.type !== 'upload' && !['greet', 'category_pick', 'complaint_more'].includes(id); });
    const safety = this.safetyFacts();
    const must = this.catQuestions().filter(q => safety.has(q.id) && evalCond(q.when, this.facts)).map(q => q.id);
    return [...new Set([...base, ...must, ...this.answered.filter(id => this.inferred.includes(id))])];
  }

  // ---------- turns ----------
  turnFor(q, prefix = '') {
    this.cur = q; this.turnNo++;
    if (!q) {
      const n = this.name ? `, ${this.name}` : '';
      return { say: `${prefix ? prefix + ' ' : ''}תודה רבה${n}. סיימנו את השאלות. אני מכינה עכשיו הערכה ראשונית וסיכום לרופא או לרופאה שלך.`, question: null, done: true };
    }
    this.questions[q.id] = q.text;
    if (!this.asked.includes(q.id)) this.asked.push(q.id);
    const body = q.say || q.text;
    return { say: (prefix ? prefix + ' ' : '') + body, question: q, done: false, initiated: q.initiated || null };
  }
  async start() { return this.turnFor(this.next()); }
  ack(q, value, extra) {
    const f = this.facts, n = this.name;
    const useName = n && (this.turnNo % 3 === 0);
    let a;
    if (q.id === 'severity' && Number(value) >= 7) a = `זה נשמע ממש לא נעים${n ? ', ' + n : ''}, ואני מצטערת ${this.g('שאתה עובר', 'שאת עוברת')} את זה.`;
    else if (q.type === 'yesno' && value === true && this.safetyFacts().get(q.id) >= 2) a = 'תודה שסיפרת לי, זה חשוב.';
    else if (q.id === 'film' && value === 'ok') a = 'תודה, הצילום התקבל.';
    else if (q.id === 'labs_upload') a = value === 'uploaded' ? 'תודה, קיבלתי את המסמכים ופענחתי אותם במכשיר.' : 'בסדר, אפשר גם בלי.';
    else a = (useName ? n + ', ' : '') + ACKS[this.ackI++ % ACKS.length];
    if (extra?.length) a += ` שמתי לב שכבר ${this.g('סיפרת', 'סיפרת')} לי על ${extra.slice(0, 3).join(', ')}, אז לא אשאל על זה שוב.`;
    return a;
  }
  /** Fill facts the patient already volunteered in free text (never re-ask). Returns human labels of new facts. */
  absorb(text, exceptId) {
    const out = [];
    if (!text) return out;
    const { facts, evidence, docs } = extractFacts(text, { category: this.facts.category, categories: this.rules.categories, patient: { sex: this.patient.sex, age: Number(this.patient.age) } });
    if (docs !== undefined && this.docs === undefined) this.docs = docs;
    for (const [id, v] of Object.entries(facts)) {
      if (id === exceptId || !this.isOpen(id)) continue;
      const q = this.findQ(id); if (!q) continue;
      this.facts[id] = v; this.answered.push(id); this.inferred.push(id);
      const human = q.type === 'yesno' ? (v ? 'כן' : 'לא') : q.type === 'scale' ? `${v}/10` : Array.isArray(v) ? (v.map(x => q.options?.find(o => o.v === x)?.label || x).join(', ') || 'אף אחד') : (q.options?.find(o => o.v === v)?.label || String(v));
      this.labels[id] = `${human} (מתוך דבריך: "${evidence[id] || ''}")`; this.questions[id] = q.text;
      out.push(shortTopic(q, v));
    }
    return out;
  }

  /** input: { value?, text? } — value from UI controls, text from typing/speech. */
  async answer(input) {
    const q = this.cur || this.next();
    if (!q) return { turn: this.turnFor(null), newAlerts: [] };
    let { value, text } = input; text = text != null ? String(text) : '';
    if (text) this.facts._text += ' ' + text;
    let label = '', extra = [];
    const opts = q.options || [];
    const retry = () => {
      this.retries[q.id] = (this.retries[q.id] || 0) + 1;
      if (this.retries[q.id] <= 1) return { turn: { say: `סליחה, לא בטוחה שהבנתי. ${q.type === 'yesno' ? `${this.g('תוכל', 'תוכלי')} לענות כן או לא? ` : ''}${q.say || q.text}`, question: q, done: false }, newAlerts: [], retry: true };
      return null;   // second miss → record as unknown and move on (never loop)
    };
    switch (q.type) {
      case 'text': {
        if (q.id === 'greet') {
          const nm = extractName(text); if (nm) { this.name = nm; this.nameSource = 'patient'; }
          this.greeted = true; label = this.name || '—';
          const c = nluClassify(text, this.rules.categories);
          if (c) { this.facts.category = c; this.facts.category_method = 'keyword'; this.facts.complaint_text = text; this.answered.push('complaint'); this.labels.complaint = text; this.questions.complaint = this.core().complaint.text; extra = this.absorb(text); }
          break;
        }
        if (q.id === 'complaint_more') {
          const c = nluClassify(this.facts.complaint_text + ' ' + text, this.rules.categories);
          this.facts.complaint_text = (this.facts.complaint_text + '. ' + text).trim();
          if (c) { this.facts.category = c; this.facts.category_method = 'keyword'; extra = this.absorb(this.facts.complaint_text); }
          label = text; break;
        }
        this.facts[q.id] = text || ''; label = text || '—';
        extra = this.absorb(text, q.id); break;
      }
      case 'complaint': {
        if (value) { this.facts.category = value; this.facts.category_method = 'chip'; label = opts.find(o => o.v === value)?.label || value; this.facts.complaint_text = label; }
        else {
          this.facts.complaint_text = text; label = text;
          const c = nluClassify(text, this.rules.categories);
          if (c) { this.facts.category = c; this.facts.category_method = 'keyword'; extra = this.absorb(text); }
          else this.facts.category_method = 'pending';
        }
        break;
      }
      case 'choice': {
        if (value === undefined && text) value = parseChoice(text, q);
        if (value === undefined) { const r = retry(); if (r) return r; this.facts[q.id] = 'unknown'; label = 'לא ידוע'; break; }
        label = opts.find(o => o.v === value)?.label || value;
        if (q.id === 'category_pick') { this.facts.category = value; this.facts.category_method = value === 'general' ? 'fallback' : 'chip'; extra = this.absorb(this.facts.complaint_text || ''); }
        else this.facts[q.id] = value;
        if (text) extra = extra.concat(this.absorb(text, q.id));
        break;
      }
      case 'yesno': {
        if (value === undefined && text) {
          value = parseYesNo(text);
          if (value === undefined) { const fx = extractFacts(text, { category: this.facts.category, categories: this.rules.categories }).facts; if (q.id in fx) value = fx[q.id]; }
        }
        if (value === undefined) { const r = retry(); if (r) return r; value = 'unknown'; }
        this.facts[q.id] = value; label = value === 'unknown' ? 'לא ידוע' : value ? 'כן' : 'לא';
        if (text) extra = this.absorb(text, q.id);
        break;
      }
      case 'multi': {
        if (!Array.isArray(value) && text) value = parseMulti(text, q);
        value = (value || []).filter(v => v !== 'none');
        this.facts[q.id] = value;
        label = value.length ? value.map(v => opts.find(o => o.v === v)?.label || v).join(', ') : 'אף אחד';
        if (text) extra = this.absorb(text, q.id);
        break;
      }
      case 'scale': {
        if (value === undefined && text) { value = parseSeverity(text); if (value === undefined) { const n = parseNumber(text); if (n !== undefined && n <= 10) value = Math.round(n); } }
        if (value === undefined) { const r = retry(); if (r) return r; this.facts[q.id] = 'unknown'; label = 'לא ידוע'; break; }
        this.facts[q.id] = Number(value); label = `${value}/10`;
        if (text) extra = this.absorb(text, q.id);
        break;
      }
      case 'film': this.facts.film = value; label = value === 'ok' ? 'צולם וצורף' : `צילום לא הועבר (${input.reason || 'לא צוין'})`; break;
      case 'upload': this.facts.labs_upload = value; label = `${input.count || 0} קבצים הועלו`; break;
      default: this.facts[q.id] = text || ''; label = text || '—';
    }
    if (q.id !== 'greet' || true) { if (!this.answered.includes(q.id)) this.answered.push(q.id); this.labels[q.id] = label; }
    if (['category_pick', 'complaint', 'complaint_more'].includes(q.id) === false && !['greet', 'film', 'labs_ask', 'labs_upload', 'history', 'meds', 'allergies', 'closing'].includes(q.id)) this.followups++;
    // red flags on every utterance
    const all = detectRedFlags(this.rules, this.facts);
    const newAlerts = all.filter(a => !this.alertedIds.has(a.id));
    newAlerts.forEach(a => { this.alertedIds.add(a.id); this.alerts.push(a); });
    let prefix;
    if (q.id === 'greet') prefix = this.nameSource === 'patient' ? `נעים מאוד, ${this.name}!` : (this.name ? `שלום ${this.name}, נעים מאוד!` : 'נעים מאוד!');
    else if ((q.type === 'complaint' || q.id === 'complaint_more' || q.id === 'category_pick') && this.facts.category && this.facts.category_method !== 'pending')
      prefix = `הבנתי${this.name ? ', ' + this.name : ''}. נתמקד ב${this.rules.categories[this.facts.category].label}.`;
    else if (q.type === 'complaint' && this.facts.category_method === 'pending') prefix = 'תודה שסיפרת.';
    else prefix = this.ack(q, value);
    if (extra.length && q.id !== 'greet') prefix += ` שמתי לב שכבר סיפרת לי על ${extra.slice(0, 3).join(', ')}, אז לא אשאל על זה שוב.`;
    if (q.id === 'greet' && this.facts.category) prefix += ` הבנתי שמדובר ב${this.rules.categories[this.facts.category].label}.`;
    return { turn: this.turnFor(this.next(), prefix), newAlerts, label, extra };
  }
}
const g2 = (d, m, f) => d.g(m, f);
function shortTopic(q, v) {
  const map = { onset: 'מתי זה התחיל', severity: 'עוצמת הכאב', history: 'מחלות הרקע', meds: 'התרופות', allergies: 'האלרגיות', fever_temp: 'גובה החום', abd_location: 'מיקום הכאב', fever_source: 'מקור החום', abd_fever: 'החום', abd_vomit: 'ההקאות', pregnant: 'הריון' };
  if (map[q.id]) return map[q.id];
  return q.text.replace(/^האם\s+/, '').replace(/^(יש|היה|היו|קרה)\s+(לך\s+)?/, '').replace(/\?.*$/, '').split(/[,(/]/)[0].trim().slice(0, 36);
}
