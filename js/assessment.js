// Patient-facing closing: "אבחנה משוערת + טיפול משוער" — framed as a PRELIMINARY AI ASSESSMENT that must be
// confirmed with a doctor. Built only from the deterministic engine (ranked differentials + rule-linked treatment
// considerations + urgency), so every item still traces to a rule id and source in rules.json.
import { computeUrgency, rankDifferentials, considerations } from './engine.js';

const URG_ADVICE = {
  emergency: 'יש לחייג 101 עכשיו או לפנות למיון — לא לחכות',
  'same-day': 'מומלץ להיבדק אצל רופא/ה עוד היום',
  'within-days': 'מומלץ לקבוע בדיקה אצל הרופא/ה בימים הקרובים',
  routine: 'אפשר להמשיך במעקב אצל רופא/ת המשפחה, ולפנות מוקדם יותר אם יש החמרה'
};
const strip = s => String(s || '').replace(/\s*\([A-Za-z0-9 \-/]+\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

export function buildAssessment(rules, facts, alerts = [], name = '') {
  const dx = rankDifferentials(rules, facts).slice(0, 3);
  const cons = considerations(rules, facts);
  const urgency = computeUrgency(rules, facts, alerts);
  const treatment = cons.treatment.slice(0, 2);
  const advice = URG_ADVICE[urgency.level] || URG_ADVICE.routine;
  const lead = dx[0], others = dx.slice(1);
  const disclaimer = 'זוהי הערכה ראשונית של בינה מלאכותית — לא אבחנה רפואית. יש לאשר אותה מול רופא/ה.';
  const dxLine = lead ? `${lead.name}${others.length ? ` (אפשרויות נוספות לשקול: ${others.map(d => d.name).join(', ')})` : ''}` : 'לא ניתן לקבוע על סמך המידע שנאסף';
  const txLine = [...treatment.map(t => t.text), advice].join('; ');
  const say = [
    name ? `${name}, לפי מה שסיפרת, זו ההערכה הראשונית שלי.` : 'לפי מה שסיפרת, זו ההערכה הראשונית שלי.',
    'אני מדגישה: זו הערכה של בינה מלאכותית ולא אבחנה, וחשוב לאשר אותה עם רופא או רופאה.',
    lead ? `אבחנה משוערת: ${strip(lead.name)}${others.length ? `. אפשרויות נוספות: ${others.map(d => strip(d.name)).join(', ')}` : ''}.` : 'לא הצלחתי לגבש אבחנה משוערת מהמידע שנאסף.',
    `טיפול משוער: ${treatment.length ? strip(treatment[0].text) + '. ' : ''}${advice}.`,
    'הסיכום המלא יועבר לרופא או לרופאה שלך לבדיקה.'
  ].join(' ');
  return {
    kind: 'preliminary-ai-assessment', disclaimer, name,
    dx: dx.map(d => ({ id: d.id, name: d.name, weight: d.weight, source: d.source })),
    treatment: treatment.map(t => ({ id: t.id, text: t.text, source: t.source })),
    urgency: { level: urgency.level, label: urgency.label, rule: urgency.decidingRule }, advice,
    text: `אבחנה משוערת: ${dxLine}\nטיפול משוער: ${txLine}\n${disclaimer}`, say, generatedAt: Date.now()
  };
}
