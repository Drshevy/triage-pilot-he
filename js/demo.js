// "Load demo data": 5 synthetic cases produced by running the real dialogue engine with scripted answers,
// so summaries, urgency, differentials and validation are genuine engine output. Clearly marked demo.
import { RuleBasedDialogue } from './dialogue.js';
import { buildSummary } from './summary.js';
import { route } from './routing.js';
import { extract, interpret, extractImaging } from './labs.js';
import { uid, loadLabRanges } from './util.js';

const DAY = 86400000;
const SCENARIOS = [
  { patient: { name: 'משה לוי (הדגמה)', age: 62, sex: 'male', doctorName: 'רונית כהן', doctorEmail: 'dr.cohen@example.org' }, daysAgo: 0.05,
    answers: { complaint: { text: 'לחץ חזק בחזה מאז הבוקר' }, onset: 'today', severity: 8, chest_radiation: true, chest_sweat: true }, stopOnAlert: true,
    lab: { name: 'בדיקות_דם_קודמות.png', lines: ['מעבדה מרכזית — תוצאות בדיקות', 'Date: 02/11/2026', 'Troponin 38 ng/L 0-14 H', 'Hemoglobin 13.9 g/dL 13.5-17.5', 'Potassium 4.4 mmol/L 3.5-5.1', 'LDL Cholesterol 168 mg/dL 0-130 H', 'HbA1c 6.4 % 4.0-5.6 H'] } },
  { patient: { name: 'נועה ברק (הדגמה)', age: 34, sex: 'female', doctorName: 'אבי מזרחי', doctorEmail: 'avi.m@example.org' }, daysAgo: 1.2,
    answers: { complaint: { text: 'פריחה מגרדת בידיים' }, onset: 'days', severity: 4, skin_new_exposure: true, pregnant: false, film: 'ok', history: [], meds: 'אמוקסיצילין התחלתי לפני 3 ימים', allergies: 'אין', labs_ask: false, closing: '' },
    review: { verdict: 'disagree', doctorUrgency: 'same-day', note: 'תפרחת תרופתית — לראות היום, להפסיק אנטיביוטיקה.' } },
  { patient: { name: 'יואב שמש (הדגמה)', age: 6, sex: 'male', doctorName: 'דנה פרץ', doctorEmail: 'dana.p@example.org' }, daysAgo: 2.4,
    answers: { complaint: 'fever', onset: 'days', severity: 6, fever_temp: 'high', fever_neck: false, fever_rash_nonblanch: false, fever_source: ['ear'], peds_lethargic: false, peds_wet: true, history: [], meds: 'אקמול', allergies: 'אין', labs_ask: false, closing: '' },
    review: { verdict: 'agree', note: 'לראות היום — חשד לדלקת אוזן.' } },
  { patient: { name: 'אבי רוזן (הדגמה)', age: 45, sex: 'male', doctorName: 'רונית כהן', doctorEmail: 'dr.cohen@example.org' }, daysAgo: 3.6,
    answers: { complaint: { text: 'נפלתי ונקעתי את הקרסול' }, onset: 'today', severity: 7, injury_bleeding: false, injury_weight: false, injury_deform: false, injury_head: false, injury_tetanus: true, film: 'failed', filmReason: 'האזור לא נגיש לצילום', history: ['htn'], meds: 'אמלודיפין', allergies: 'פניצילין', labs_ask: false, closing: '' } },
  { patient: { name: 'שירה טל (הדגמה)', age: 29, sex: 'female', doctorName: 'אבי מזרחי', doctorEmail: 'avi.m@example.org' }, daysAgo: 5.1,
    answers: { complaint: 'psych', onset: 'month', severity: 8, psych_selfharm: true }, stopOnAlert: true,
    review: { verdict: 'agree', note: 'נוצר קשר טלפוני, הופנתה למרכז לבריאות הנפש.' } }
];

function canvasImage(lines) {
  const c = document.createElement('canvas'); c.width = 900; c.height = 60 + lines.length * 46;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#111'; g.font = '28px Rubik, Arial'; g.direction = 'ltr';
  lines.forEach((l, i) => g.fillText(l, 30, 60 + i * 46));
  return new Promise(r => c.toBlob(r, 'image/png'));
}
function valueFor(q, A, sex) {
  if (q.id in A) return A[q.id];
  if (q.type === 'yesno') return false; if (q.type === 'multi') return []; if (q.type === 'scale') return 3;
  if (q.type === 'choice') return q.options[0].v; if (q.type === 'upload') return 'none'; if (q.type === 'film') return 'ok'; return 'אין';
}

export async function loadDemoData(ctx) {
  const rules = ctx.rules, table = await loadLabRanges();
  for (const sc of SCENARIOS) {
    const d = new RuleBasedDialogue(rules, sc.patient);
    const c = { id: uid('case-'), demo: true, createdAt: Date.now() - sc.daysAgo * DAY, status: 'completed', patient: sc.patient, consent: { video: true, data: true, emergency: true, ai: true, at: Date.now(), version: 'consent-v1' },
      transcript: [], alerts: [], media: { sessionVideo: null, sessionVideoError: 'מקרה הדגמה — ללא וידאו', clips: [] }, uploads: [], audit: [] };
    let turn = await d.start(); c.transcript.push({ role: 'ai', text: turn.say });
    let guard = 0;
    while (!turn.done && guard++ < 60) {
      const q = turn.question; const raw = valueFor(q, sc.answers, sc.patient.sex);
      const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
      if (q.type === 'film') {
        const ok = raw === 'ok';
        c.media.clips.push({ id: uid('clip-'), label: rules.categories[d.facts.category].label, prompt: q.text, status: ok ? 'ok' : 'failed', reason: ok ? null : sc.answers.filmReason, blobId: null, duration: 9, at: c.createdAt });
        input.reason = sc.answers.filmReason;
      }
      if (q.type === 'upload') input.count = 0;
      const res = await d.answer(input);
      c.transcript.push({ role: 'patient', text: res.label || '' });
      if (res.newAlerts.length) {
        res.newAlerts.forEach(a => c.alerts.push({ ...a, at: c.createdAt + 60000, overridden: false }));
        if (sc.stopOnAlert) { c.status = 'emergency-closed'; c.transcript.push({ role: 'sys', text: 'התרעת חירום — הוצג מסך 101' }); break; }
      }
      turn = res.turn; c.transcript.push({ role: 'ai', text: turn.say });
    }
    const st = d.getState();
    Object.assign(c, { facts: st.facts, answered: st.answered, labels: st.labels, questions: st.questions, requiredQuestions: st.required });
    await ctx.storage.saveCase(c);
    if (sc.lab) {
      const blob = await canvasImage(sc.lab.lines);
      const text = sc.lab.lines.join('\n'); const ex = extract(text, table);
      const u = { id: uid('up-'), name: sc.lab.name, type: 'image/png', size: blob.size, consentAt: c.createdAt, blobId: uid('b-'),
        parsed: { method: 'ocr', confidence: 0.82, docDate: ex.docDate, docType: 'lab', results: interpret(ex.results, table, { category: c.facts.category, sex: sc.patient.sex }), unrecognized: ex.unrecognized, imaging: extractImaging(text, table), verifyOriginal: true, textPreview: text, rangesVersion: table.version } };
      await ctx.storage.saveBlob(c.id, u.blobId, blob, { kind: 'upload' });
      c.uploads.push(u); c.facts.labs_ask = true;
    }
    c.summary = await buildSummary(rules, c, ctx.knowledge);
    c.summary.generatedAt = c.createdAt + 5 * 60000;
    c.routing = route(c, ctx.settings);
    if (sc.review) c.review = { reviewed: true, verdict: sc.review.verdict, aiUrgency: c.summary.urgency.level, doctorUrgency: sc.review.doctorUrgency || c.summary.urgency.level, note: sc.review.note, at: c.createdAt + 3600000 };
    await ctx.storage.saveCase(c);
  }
}
