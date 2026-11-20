// DialogueProvider abstraction + deterministic rule-based implementation.
//
// Swap point: an LLMDialogueProvider can implement the same interface (start/answer/getState) and use
// an LLMProvider (see knowledge.js) to phrase questions conversationally — but the *facts* it extracts
// must use the same fact ids so that red-flag detection, urgency and validation (engine.js) keep working
// deterministically. Red-flag rules run on every answer regardless of provider.
import { evalCond, detectRedFlags } from './engine.js';

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
      complaint: { id: 'complaint', type: 'complaint', text: 'במה אוכל לעזור היום? תאר/י במילים שלך מה מטריד אותך, או בחר/י נושא מהרשימה.', options: cats },
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
