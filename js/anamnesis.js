// Structured anamnesis (family-medicine format) built from the case facts/labels:
// CC → HPI (onset, location, duration/timing, character, aggravating, relieving, severity, associated) → ROS →
// PMH → medications → allergies → social → family. Items never asked are shown as "לא נשאל" so gaps are visible.
const ONSET = { hour: 'בשעה האחרונה', today: 'היום', days: '1–3 ימים', week: 'כשבוע', month: 'מעל חודש' };
export function buildAnamnesis(c, rules) {
  const f = c.facts || {}, L = c.labels || {}, asked = new Set(c.answered || []);
  const val = (id, fmt) => asked.has(id) || f[id] !== undefined ? (fmt ? fmt(f[id]) : clean(L[id] ?? f[id])) : null;
  const clean = v => (v === undefined || v === null || v === '' ? null : String(v).replace(/\s*\(מתוך דבריך:.*\)$/, ''));
  const rosQ = c.questions?.ros || '';
  const hpi = [
    ['התחלה', val('onset', v => ONSET[v] || clean(L.onset))], ['מיקום', val('hpi_location') ?? val('abd_location')],
    ['מהלך / משך', val('hpi_timing')], ['אופי', val('hpi_character')], ['מחמיר', val('hpi_aggravating')], ['מקל', val('hpi_relieving')],
    ['עוצמה', val('severity', v => (v === 'unknown' ? 'לא ידוע' : `${v}/10`))],
    ['תלונות נוספות', (f.secondary_categories || []).length ? f.secondary_categories.map(k => rules?.categories?.[k]?.label || k).join(', ') : null]
  ];
  const ros = asked.has('ros') ? { positive: clean(L.ros) && f.ros?.length ? clean(L.ros) : 'ללא', asked: rosQ } : null;
  const sections = {
    cc: f.complaint_text || '', hpi,
    ros,
    pmh: val('history'), meds: val('meds'), allergies: val('allergies'),
    social: [['עישון', val('soc_smoking')], ['אלכוהול', val('soc_alcohol')]].filter(x => x[1]),
    family: val('fam_hx'),
    corrections: (f.corrections || []).length, unknowns: Object.entries(f).filter(([, v]) => v === 'unknown').map(([k]) => k),
    patientQuestions: f.patient_questions || []
  };
  return sections;
}
export function anamnesisText(a) {
  const nn = v => v ?? 'לא נשאל';
  return [
    `תלונה עיקרית: ${a.cc}`,
    `מחלה נוכחית: ${a.hpi.map(([k, v]) => `${k}: ${nn(v)}`).join('; ')}`,
    `סקירת מערכות: ${a.ros ? a.ros.positive : 'לא נשאל'}`,
    `רקע: ${nn(a.pmh)} | תרופות: ${nn(a.meds)} | רגישויות: ${nn(a.allergies)}`,
    `חברתי: ${a.social.map(([k, v]) => `${k}: ${v}`).join('; ') || 'לא נשאל'} | משפחתי: ${a.family ?? 'לא רלוונטי / לא נשאל'}`
  ].join('\n');
}
