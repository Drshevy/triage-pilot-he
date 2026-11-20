// Hebrew free-text understanding for the conversational triage dialogue (deterministic, on-device).
//  • clause-aware negation ("אין לי קוצר נשימה, אבל יש חום" → breath:false, fever:true)
//  • name extraction from greetings, onset / severity / temperature, history, meds, allergies, documents
//  • a lexicon mapping patient phrases → the same fact ids used by rules.json (so red flags, urgency and
//    differential ranking stay deterministic and auditable).
// Pilot quality: keyword/regex based, not a medical NLP model. Everything it infers is labelled "(מתוך דבריך)".

const NEG = ['לא', 'אין', 'בלי', 'ללא', 'אינו', 'אינה', 'אינני', 'איני', 'שום', 'אף', 'מעולם', 'no', 'not', 'without', "don't", 'denies'];
const CLAUSE_SPLIT = /[,.;!?\n]|\s(?:אבל|אך|אולם|רק ש|but)\s/;
const PREFIX = '(?:^|[\\s"\'(\\-]|(?<=[\\s"\'(\\-])[ובלמהשכ]{1,3})';

export const norm = s => String(s || '').replace(/[\u0591-\u05C7]/g, '').replace(/[״”“]/g, '"').replace(/[׳’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** All match positions of `kw` in `t`. Short Hebrew words must sit on a word start (optionally after ו/ב/ל/מ/ה/ש/כ). */
function positions(t, kw) {
  kw = norm(kw); const out = [];
  if (!kw) return out;
  if (kw.length <= 3 && /[\u05d0-\u05ea]/.test(kw)) {
    const re = new RegExp(`(?:^|[\\s"'(\\-])(?:[ובלמהשכ]{0,2})${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,.;!?"')\\-])`, 'g');
    let m; while ((m = re.exec(t))) out.push(m.index + m[0].length - kw.length);
    return out;
  }
  let i = t.indexOf(kw); while (i >= 0) { out.push(i); i = t.indexOf(kw, i + 1); }
  return out;
}
/** Is the match at `idx` negated within its clause (negator among the ≤4 preceding words)? */
export function isNegated(t, idx) {
  let start = 0; const before = t.slice(0, idx);
  const m = [...before.matchAll(new RegExp(CLAUSE_SPLIT.source, 'g'))]; if (m.length) { const l = m[m.length - 1]; start = l.index + l[0].length; }
  const words = before.slice(start).trim().split(/\s+/).filter(Boolean).slice(-4);
  return words.some(w => NEG.includes(w.replace(/^[ו]/, '')) || NEG.includes(w));
}
/** Find keyword hits → { found, negated, pos } (positive mention wins over a negated one). */
export function mention(text, kws) {
  const t = norm(text); let pos = Infinity, neg = false, any = false;
  for (const k of kws) for (const i of positions(t, k)) {
    any = true; const n = isNegated(t, i);
    if (!n) return { found: true, negated: false, pos: i };
    neg = true; pos = Math.min(pos, i);
  }
  return { found: any, negated: neg, pos };
}

// ---------------------------------------------------------------- lexicon (patient phrases → facts)
export const LEXICON = {
  chest_radiation: ['מקרין', 'מקרינה', 'מתפשט ליד', 'ליד שמאל', 'לכתף', 'ללסת', 'radiat'],
  chest_sweat: ['הזעה', 'מזיע', 'מזיעה', 'זיעה קרה', 'בחילה', 'סחרחורת'],
  chest_sob: ['קוצר נשימה', 'קשה לי לנשום', 'קשה לנשום', 'מתנשף', 'מתנשפת', 'חסר לי אוויר', 'short of breath'],
  chest_exertion: ['במאמץ', 'כשאני הולך', 'כשאני הולכת', 'במדרגות', 'בהליכה', 'exertion'],
  chest_pleuritic: ['נשימה עמוקה', 'כשאני נושם', 'כשאני נושמת', 'בלחיצה על החזה'],
  breath_speech: ['לסיים משפט', 'גם במנוחה', 'במנוחה'],
  breath_cyanosis: ['כחולות', 'כחולים', 'שפתיים כחולות', 'אפורות'],
  breath_fever: ['חום', 'כיח', 'ליחה', 'fever'],
  breath_wheeze: ['צפצופים', 'צפצוף', 'אסתמה', 'אסטמה', 'copd', 'wheez'],
  abd_blood: ['הקאתי דם', 'מקיא דם', 'מקיאה דם', 'דם בהקאה', 'צואה שחורה', 'דם בצואה', 'צואה דמית'],
  abd_fever: ['חום', 'fever'],
  abd_vomit: ['הקאות', 'מקיא', 'מקיאה', 'הקאתי', 'לא מצליח לשתות', 'לא מצליחה לשתות', 'vomit'],
  fever_neck: ['צוואר נוקשה', 'נוקשות בצוואר', 'נוקשות צוואר', 'stiff neck'],
  fever_rash_nonblanch: ['לא נעלמת בלחיצה', 'שלא נעלמת'],
  skin_spread: ['מתפשט', 'מתפשטת', 'מתרחב', 'מתרחבת', 'spreading'],
  skin_throat: ['נפיחות בשפתיים', 'נפיחות בלשון', 'נפיחות בגרון', 'שפתיים נפוחות', 'קושי בנשימה', 'קשה לנשום'],
  skin_new_exposure: ['תרופה חדשה', 'התחלתי תרופה', 'התחלתי לקחת', 'קרם חדש', 'סבון חדש', 'אנטיביוטיקה', 'חומר חדש', 'אכלתי משהו'],
  skin_mole_change: ['שומה', 'mole'],
  injury_bleeding: ['דימום חזק', 'לא מפסיק לדמם', 'לא מפסיקה לדמם', 'מדמם הרבה'],
  injury_weight: ['לדרוך', 'להזיז', 'דורך', 'דורכת'],
  injury_deform: ['עקום', 'עיוות', 'מעוות', 'זווית לא טבעית'],
  injury_head: ['מכה בראש', 'נחבטתי בראש', 'קיבלתי מכה בראש'],
  injury_tetanus: ['טטנוס', 'tetanus'],
  swell_unilateral: ['רגל אחת', 'ברגל ימין', 'ברגל שמאל', 'רק ברגל', 'בשוק'],
  swell_cold: ['קרה וחיוורת', 'קר וחיוור', 'חיוורת וקרה'],
  swell_joint: ['במפרק', 'בברך', 'בקרסול', 'בבוהן'],
  swell_bilateral: ['שתי הרגליים', 'שתי הרגלים', 'בשתי הרגליים'],
  neuro_sudden: ['הכי חזק שהיה', 'הכי חזק שהיה לי', 'בבת אחת', 'תוך שניות', 'worst headache'],
  neuro_pattern: ['כמו תמיד', 'כמו בעבר', 'מוכר לי', 'יש לי מיגרנות', 'שוב מיגרנה'],
  neuro_visual: ['רגישות לאור', 'טשטוש', 'הבהובים', 'הפרעות ראייה'],
  endo_glucose: ['סוכר גבוה', 'סוכר נמוך', 'היפו', 'סוכר מעל 300'],
  endo_polyuria: ['צמא', 'צמאה', 'משתין הרבה', 'משתינה הרבה', 'השתנה מרובה'],
  endo_thyroid: ['רעד', 'דפיקות לב'],
  uro_dysuria: ['צריבה', 'שורף', 'תכיפות', 'burning'],
  uro_fever_flank: ['כאב במותן', 'במותן', 'בגב בצד'],
  uro_colic: ['כאב גלי', 'בגלים', 'למפשעה', 'אבנים בכליות'],
  uro_testis: ['אשך', 'באשך'],
  msk_neuro: ['חולשה ברגליים', 'אי שליטה', 'בריחת שתן', 'נימול במפשעה'],
  msk_morning: ['נוקשות בוקר', 'נוקשות בבוקר'],
  msk_trauma: ['אחרי מאמץ', 'הרמתי', 'אחרי שהרמתי', 'תנועה לא נכונה'],
  ent_drool: ['לא מצליח לבלוע', 'לא מצליחה לבלוע', 'ריור', 'קול חנוק'],
  ent_ear: ['כאב אוזן', 'באוזן', 'הפרשה מהאוזן'],
  ent_sinus: ['גודש', 'סינוסים', 'אף סתום'],
  eye_loss: ['לא רואה', 'ירידה בראייה', 'וילון', 'איבדתי ראייה'],
  eye_redpain: ['עין אדומה', 'כאב בעין', 'רגישות חזקה לאור'],
  eye_discharge: ['הפרשה דביקה', 'דביק', 'מופרשת'],
  gyn_bleeding: ['דימום וגינלי', 'מדממת', 'דימום חריג'],
  gyn_pain: ['כאב באגן', 'בטן תחתונה', 'בבטן התחתונה'],
  psych_selfharm: ['לפגוע בעצמי', 'להתאבד', 'לשים קץ', 'רוצה למות'],
  psych_function: ['לא מתפקד', 'לא מתפקדת', 'לא מצליח לעבוד', 'לא מצליחה לעבוד', 'לא יוצא מהמיטה', 'לא יוצאת מהמיטה'],
  psych_panic: ['התקפי חרדה', 'התקף חרדה', 'התקף פאניקה', 'התקפי פאניקה'],
  onc_active: ['כימותרפיה', 'כימו', 'טיפול ביולוגי', 'טיפול אונקולוגי'],
  onc_fever: ['חום', 'fever'],
  onc_weight: ['ירידה במשקל', 'ירדתי במשקל'],
  onc_lump: ['גוש', 'lump'],
  heme_anticoag: ['קומדין', 'אליקוויס', 'קסרלטו', 'פרדקסה', 'מדלל', 'מדללי דם', 'קלקסן'],
  heme_bruise: ['חבורות', 'נקודות אדומות'],
  heme_fatigue: ['עייפות', 'חיוור', 'חיוורון'],
  gen_fatigue: ['עייפות', 'עייף', 'עייפה', 'חולשה', 'אין תיאבון', 'ירידה בתיאבון'],
  gen_worse: ['מחמיר', 'מחמירה', 'הולך ומחמיר', 'יותר גרוע'],
  pregnant: ['בהריון', 'הריון', 'pregnant'],
  peds_lethargic: ['ישנוני', 'ישנונית', 'קשה להעיר', 'מסרב לשתות', 'מסרבת לשתות'],
  peds_wet: ['חיתולים רטובים', 'עשה פיפי', 'עשתה פיפי']
};
// facts whose negation is not meaningful from free text (avoid "לא" in other clauses flipping them)
const POSITIVE_ONLY = new Set(['psych_function']);

export const MULTI_LEX = {
  rf_general: { loc: ['התעלפתי', 'איבדתי הכרה', 'התעלפות'], seizure: ['פרכוס', 'פרכסתי'], bleeding: ['דימום חזק'], throat: ['נפיחות בגרון', 'נפיחות בלשון', 'קושי לבלוע'], confusion: ['בלבול', 'מבולבל', 'מבולבלת'] },
  history: { heart: ['מחלת לב', 'צנתור', 'התקף לב', 'אוטם', 'אי ספיקת לב', 'בעיות לב'], htn: ['לחץ דם'], diabetes: ['סוכרת', 'diabetes'], lung: ['אסתמה', 'אסטמה', 'copd', 'מחלת ריאות'], kidney: ['מחלת כליות', 'דיאליזה', 'אי ספיקת כליות'], immuno: ['דיכוי חיסוני', 'סטרואידים', 'השתלה'], cancer: ['סרטן', 'גידול', 'אונקולוגי'] },
  fever_source: { resp: ['שיעול', 'משתעל', 'משתעלת', 'נזלת', 'כאב גרון', 'בגרון'], uti: ['צריבה', 'בשתן'], ear: ['אוזן'], skin: ['פצע', 'אודם בעור', 'פריחה'] },
  neuro_fast: { face: ['פה עקום', 'הפה עקום', 'צניחת פנים', 'פנים נפולות'], arm: ['חולשה ביד', 'יד חלשה', 'צד אחד חלש'], speech: ['קושי לדבר', 'דיבור משובש', 'לא מצליח לדבר', 'לא מצליחה לדבר'] },
  preg_warning: { bleeding: ['דימום'], pain: ['כאב בטן חזק'], headache_vision: ['טשטוש ראייה'], fluid: ['ירידת מים'], no_movement: ['פחות תנועות', 'ירידה בתנועות'] }
};
export const CHOICE_LEX = {
  abd_location: { rlq: ['ימין למטה', 'צד ימין למטה', 'ימני תחתון', 'למטה מימין'], ruq: ['ימין למעלה', 'מתחת לצלעות מימין', 'למעלה מימין'], epi: ['בפי הבטן', 'למעלה באמצע', 'באמצע למעלה', 'בטן עליונה', 'בבטן העליונה'], llq: ['שמאל למטה', 'למטה משמאל'], diffuse: ['בכל הבטן', 'כל הבטן', 'מפושט'] },
  onset: { hour: ['לפני שעה', 'חצי שעה', 'לפני כמה דקות', 'ממש עכשיו', 'השעה האחרונה'], today: ['היום', 'הבוקר', 'מהבוקר', 'מאז הבוקר', 'הערב', 'הצהריים', 'לפני כמה שעות', 'שעתיים', 'שלוש שעות'], days: ['אתמול', 'מאתמול', 'יומיים', 'שלושה ימים', 'שלוש ימים', 'כמה ימים', 'שלשום'], week: ['שבוע', 'שבועיים', 'עשרה ימים'], month: ['חודש', 'חודשים', 'שנה', 'שנים', 'הרבה זמן', 'תקופה ארוכה'] },
  fever_temp: {}
};
const HEB_NUM = { 'אפס': 0, 'אחת': 1, 'אחד': 1, 'שתיים': 2, 'שתים': 2, 'שניים': 2, 'שנים': 2, 'שתי': 2, 'שלוש': 3, 'שלושה': 3, 'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5, 'שש': 6, 'שישה': 6, 'שבע': 7, 'שבעה': 7, 'שמונה': 8, 'תשע': 9, 'תשעה': 9, 'עשר': 10, 'עשרה': 10 };
const YES_W = ['כן', 'בטח', 'נכון', 'אכן', 'יש', 'כמובן', 'בהחלט', 'קצת', 'מעט', 'yes', 'yeah', 'yep'];
const NO_W = ['לא', 'אין', 'ממש לא', 'בכלל לא', 'שום', 'no', 'nope', 'nah', 'אף פעם'];
const UNKNOWN = ['לא יודע', 'לא יודעת', 'לא בטוח', 'לא בטוחה', 'אין לי מושג', 'לא זוכר', 'לא זוכרת', 'not sure', "don't know"];
const GREET = ['שלום', 'היי', 'הי', 'הלו', 'אהלן', 'בוקר טוב', 'ערב טוב', 'צהריים טובים', 'לילה טוב', 'מה נשמע', 'מה שלומך', 'נעים מאוד', 'hi', 'hello', 'hey'];
const NOT_NAME = new Set(['אני', 'זה', 'זאת', 'זו', 'את', 'אתה', 'הכל', 'בסדר', 'לא', 'כן', 'פה', 'כאן', 'רוצה', 'מרגיש', 'מרגישה', 'צריך', 'צריכה', 'חולה', 'הולך', 'הולכת', 'יש', 'אין', 'טוב', 'בטוב', 'עייף', 'עייפה', 'כואב', 'כואבת', 'מתקשר', 'מתקשרת', 'פונה', 'אחד', 'אחת', 'שלום', 'תודה', 'נועה', 'המטופל', 'המטופלת', 'אמא', 'אבא', 'בן', 'בת', 'מודאג', 'מודאגת', 'מבוגר', 'ממש', 'קצת', 'רק', 'גם', 'אבל', 'חושב', 'חושבת', 'שואל', 'שואלת', 'בעצם']);

/** Extract a first name from a greeting answer. Returns null if the patient only said hello. */
export function extractName(text) {
  const raw = String(text || '').replace(/[\u0591-\u05C7]/g, '').trim();
  const m = raw.match(/(?:קוראים לי|שמי|השם שלי(?: הוא| זה)?|my name is|i am|i'm|this is)\s+([A-Za-z\u05d0-\u05ea'"\-]+)/i);
  const ok = w => w && w.length >= 2 && !NOT_NAME.has(w) && !GREET.includes(w) && !/\d/.test(w);
  if (m && ok(m[1])) return cap(m[1]);
  let rest = norm(raw);
  for (const g of GREET.sort((a, b) => b.length - a.length)) rest = rest.replace(new RegExp(`(^|\\s)${g}(?=\\s|$|[,.!])`, 'g'), ' ');
  rest = rest.replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const am = rest.match(/^(?:אני|זה|זאת|זו)\s+([\u05d0-\u05eaa-z'"\-]+)/);
  if (am && ok(am[1]) && rest.split(' ').length <= 4) return cap(am[1]);
  const words = rest.split(' ').filter(Boolean);
  if (words.length >= 1 && words.length <= 2 && ok(words[0])) return cap(words[0]);
  return null;
}
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
export const isGreetingOnly = text => !extractName(text) && GREET.some(g => norm(text).includes(g));

export function parseYesNo(text) {
  const t = norm(text);
  if (!t) return undefined;
  if (UNKNOWN.some(u => t.includes(u))) return 'unknown';
  const first = t.replace(/^[,.\s]+/, '');
  if (NO_W.some(n => first === n || first.startsWith(n + ' ') || first.startsWith(n + ','))) return false;
  if (YES_W.some(y => first === y || first.startsWith(y + ' ') || first.startsWith(y + ','))) return true;
  return undefined;
}
export function parseNumber(text) {
  const t = norm(text);
  const d = t.match(/(\d+(?:[.,]\d+)?)/); if (d) return parseFloat(d[1].replace(',', '.'));
  for (const w of t.split(/[\s,.]+/)) { const base = w.replace(/^[ובל]/, ''); if (w in HEB_NUM) return HEB_NUM[w]; if (base in HEB_NUM) return HEB_NUM[base]; }
  return undefined;
}
export function parseSeverity(text) {
  const t = norm(text);
  const m = t.match(/(\d{1,2})\s*(?:\/|מתוך|מ-?|out of)\s*10/); if (m) return Math.min(10, +m[1]);
  if (/^\s*\d{1,2}\s*$/.test(t)) return Math.min(10, +t);
  if (/(?:^|\s)(?:דרגה|רמה|בערך|כמו)\s/.test(t) || t.split(' ').length <= 3) { const n = parseNumber(t); if (n !== undefined && n <= 10) return Math.round(n); }
  if (/(בלתי נסבל|הכי חזק|נורא|איום|מטורף|לא יכול לסבול|לא יכולה לסבול)/.test(t)) return 9;
  if (/(חזק מאוד|מאוד חזק|ממש חזק|כואב מאוד|מאוד כואב)/.test(t)) return 8;
  if (/(?:^|\s)חזק(?:ה)?(?=$|\s|[,.])/.test(t)) return 7;
  if (/(בינוני|בינונית|נסבל|נסבלת)/.test(t)) return 5;
  if (/(קל|קלה|קצת|מעט|לא נורא|חלש|חלשה)(?=$|\s|[,.])/.test(t)) return 3;
  return undefined;
}
export function parseTemperature(text) {
  const t = norm(text); if (/(לא מדדתי|לא נמדד|לא מדדנו|אין מדחום)/.test(t)) return 'unknown';
  const m = t.match(/(3[5-9]|4[0-2])(?:[.,](\d))?/); if (!m) return undefined;
  const v = parseFloat(m[1] + '.' + (m[2] || '0'));
  return v >= 39 ? 'high' : v >= 38 ? 'mid' : 'low';
}
function pickChoice(text, lex) {
  let best = null, pos = Infinity;
  for (const [v, kws] of Object.entries(lex)) { const r = mention(text, kws); if (r.found && !r.negated && r.pos < pos) { best = v; pos = r.pos; } }
  return best;
}
function pickMulti(text, lex) {
  const out = []; for (const [v, kws] of Object.entries(lex)) { const r = mention(text, kws); if (r.found && !r.negated) out.push(v); }
  return out;
}
const DOCS = ['בדיקות דם', 'בדיקת דם', 'תוצאות', 'צילום רנטגן', 'צילום חזה', 'צילום', 'סי טי', 'ct', 'אולטרסאונד', 'אולטרה סאונד', 'mri', 'אם אר איי', 'בדיקת שתן', 'מכתב שחרור', 'סיכום מחלה', 'אק"ג', 'אקג', 'מסמכים'];

/**
 * Extract facts from free text. `ctx`: { category, categories (rules.categories), patient }.
 * Returns { facts: {id: value}, evidence: {id: phrase}, docs:boolean|undefined }.
 */
export function extractFacts(text, ctx = {}) {
  const facts = {}, evidence = {};
  const t = norm(text);
  if (!t) return { facts, evidence };
  const cat = ctx.categories?.[ctx.category];
  const allowed = new Set([...(cat?.questions || []).map(q => q.id), 'gen_fatigue', 'gen_worse', 'pregnant', 'peds_lethargic', 'peds_wet']);
  if (ctx.patient && !(ctx.patient.sex === 'female' && ctx.patient.age >= 12 && ctx.patient.age <= 55)) allowed.delete('pregnant');
  if (ctx.patient && !(ctx.patient.age < 16)) { allowed.delete('peds_lethargic'); allowed.delete('peds_wet'); }
  for (const id of allowed) {
    const kws = LEXICON[id]; if (!kws) continue;
    const r = mention(t, kws);
    if (!r.found) continue;
    if (r.negated && POSITIVE_ONLY.has(id)) continue;
    facts[id] = !r.negated; evidence[id] = snippet(t, r.pos);
  }
  // injury_weight: "can bear weight" is the positive form, so "לא יכול לדרוך" → false (handled by negation above).
  for (const [id, lex] of Object.entries(MULTI_LEX)) {
    if (id === 'fever_source' && ctx.category !== 'fever') continue;
    if (id === 'neuro_fast' && ctx.category !== 'neuro') continue;
    if (id === 'preg_warning') continue;
    const v = pickMulti(t, lex);
    if (v.length) { facts[id] = v; evidence[id] = v.join(', '); }
    else if (id === 'history' && /(אין לי מחלות|בלי מחלות|בריא לגמרי|בריאה לגמרי|אין מחלות רקע|ללא מחלות רקע)/.test(t)) { facts.history = []; evidence.history = 'אין מחלות רקע'; }
  }
  if (ctx.category === 'abdominal') { const v = pickChoice(t, CHOICE_LEX.abd_location); if (v) { facts.abd_location = v; evidence.abd_location = v; } }
  const on = pickChoice(t, CHOICE_LEX.onset); if (on) { facts.onset = on; evidence.onset = on; }
  const sev = parseSeverity(t); if (sev !== undefined && /(כאב|כואב|חזק|נסבל|מתוך|\/10|קל|בינוני|נורא)/.test(t)) { facts.severity = sev; evidence.severity = String(sev); }
  if (ctx.category === 'fever' || /חום/.test(t)) { const temp = parseTemperature(t); if (temp && temp !== 'unknown') { facts.fever_temp = temp; evidence.fever_temp = temp; } }
  // medications / allergies
  const meds = t.match(/(?:אני )?(?:לוקח|לוקחת|נוטל|נוטלת|מקבל|מקבלת)\s+(?!תרופות? )([^,.;]{2,40})/);
  if (meds && !/(?:לא|אין)\s+(?:לוקח|לוקחת|נוטל|נוטלת)/.test(t)) { facts.meds = meds[1].trim(); evidence.meds = meds[1].trim(); }
  if (/(?:לא|אין לי|בלי)\s+(?:לוקח|לוקחת|נוטל|נוטלת)?\s*תרופות/.test(t)) { facts.meds = 'אין'; evidence.meds = 'אין תרופות קבועות'; }
  const al = t.match(/אלרגי(?:ת|ה)?\s+ל([^,.;]{2,30})/);
  if (al && !isNegated(t, al.index)) { facts.allergies = al[1].trim(); evidence.allergies = al[1].trim(); }
  if (/(אין לי אלרגיות|ללא אלרגיות|בלי אלרגיות|לא אלרגי)/.test(t)) { facts.allergies = 'אין'; evidence.allergies = 'אין אלרגיות'; }
  const d = mention(t, DOCS); const docs = d.found ? !d.negated : undefined;
  return { facts, evidence, docs };
}
const snippet = (t, i) => t.slice(Math.max(0, i - 12), Math.min(t.length, i + 28)).trim();

/** Category classification (negation-aware; ties → earliest mention). */
export function classify(text, categories) {
  const t = norm(text).replace(/(^|\s)(אף|שום)\s+(פעם|אחד|אחת|דבר)/g, '$1לא $3'); let best = null, bestN = 0, bestPos = Infinity;
  for (const [id, c] of Object.entries(categories)) {
    let n = 0, pos = Infinity;
    for (const k of c.keywords || []) for (const i of positions(t, k)) { if (isNegated(t, i)) continue; n++; pos = Math.min(pos, i); }
    if (n > bestN || (n === bestN && n > 0 && pos < bestPos)) { best = id; bestN = n; bestPos = pos; }
  }
  return best;
}
export function parseChoice(text, q) {
  const lex = CHOICE_LEX[q.id];
  if (q.id === 'fever_temp') { const v = parseTemperature(text); if (v) return v; }
  if (lex) { const v = pickChoice(text, lex); if (v) return v; }
  const t = norm(text);
  const hit = (q.options || []).find(o => t.includes(norm(o.label)) || norm(o.label).includes(t) && t.length > 2);
  return hit?.v;
}
export function parseMulti(text, q) {
  const t = norm(text);
  if (/(אף אחד|כלום|אין|לא|שום דבר|none)(?=$|\s|[,.])/.test(t) && !(MULTI_LEX[q.id] && pickMulti(t, MULTI_LEX[q.id]).length)) return [];
  const v = new Set(MULTI_LEX[q.id] ? pickMulti(t, MULTI_LEX[q.id]) : []);
  (q.options || []).forEach(o => { if (o.v !== 'none' && t.includes(norm(o.label))) v.add(o.v); });
  return [...v];
}
