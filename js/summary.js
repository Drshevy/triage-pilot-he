import { buildAnamnesis, anamnesisText } from './anamnesis.js';
// Builds the clinician-facing summary (not a diagnosis) and renders it in Hebrew.
import { computeUrgency, rankDifferentials, considerations, redFlagStatus, validate } from './engine.js';
import { esc, fmtDate, fmtDur } from './util.js';

export async function buildSummary(rules, c, knowledge) {
  const facts = c.facts; const answered = new Set(c.answered || []);
  const urgency = computeUrgency(rules, facts, (c.alerts || []));
  const differentials = rankDifferentials(rules, facts);
  const cons = considerations(rules, facts);
  const redFlags = redFlagStatus(rules, facts, answered);
  const items = [
    ...cons.treatment.map(x => ({ ...x, kind: 'treatment' })),
    ...differentials.map(x => ({ ...x, text: x.name, kind: 'differential' })),
    ...cons.workup.map(x => ({ ...x, kind: 'workup' })),
    ...cons.imaging.map(x => ({ ...x, kind: 'imaging' })),
    ...(c.uploads || []).flatMap(u => (u.parsed?.unrecognized || []).map((l, i) => ({ id: `${u.id}-U${i}`, text: l, kind: 'lab-unknown' })))
  ];
  const knowledgeChecks = await knowledge.check(items, { category: facts.category });
  const outcome = { urgency, differentials, considerations: cons, redFlags };
  const validation = validate(rules, c, outcome, knowledgeChecks);
  const cat = rules.categories[facts.category || 'general'];
  return { ...outcome, validation, category: facts.category || 'general', categoryLabel: cat.label, specialty: cat.specialty, knowledgeProvider: knowledge.name, generatedAt: Date.now() };
}

const URG_CLASS = { emergency: 'u-emergency', 'same-day': 'u-sameday', 'within-days': 'u-days', routine: 'u-routine' };
export const urgencyBadge = (level, label) => `<span class="badge ${URG_CLASS[level] || ''}">${esc(label || level)}</span>`;
const SEX = { male: 'זכר', female: 'נקבה', other: 'אחר' };
const STATUS_LBL = { low: 'נמוך', high: 'גבוה', normal: 'תקין', critical: 'קריטי', abnormal: 'חריג' };
const REC_LBL = { recent: '≤30 יום', months: '1–6 חודשים', old: 'מעל 6 חודשים', unknown: 'תאריך לא זוהה' };
const REL_LBL = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };
const src = (rules, s) => `<span class="cite" title="${esc(rules.sources[s] || 'מקור לא ידוע')}">[${esc(s)}]</span>`;

function anamnesisHTML(a) {
  const nn = v => (v == null ? '<span class="muted">לא נשאל</span>' : esc(v));
  return `<table class="qa anamnesis" id="anamnesis"><tbody>
    <tr><th scope="row">מחלה נוכחית (HPI)</th><td><ul class="hpi">${a.hpi.map(([k, v]) => `<li><b>${esc(k)}:</b> ${nn(v)}</li>`).join('')}</ul></td></tr>
    <tr><th scope="row">סקירת מערכות (ROS)</th><td>${a.ros ? `תסמינים נלווים: ${esc(a.ros.positive)}` : nn(null)}</td></tr>
    <tr><th scope="row">מחלות רקע</th><td>${nn(a.pmh)}</td></tr><tr><th scope="row">תרופות</th><td>${nn(a.meds)}</td></tr><tr><th scope="row">רגישויות</th><td>${nn(a.allergies)}</td></tr>
    <tr><th scope="row">היסטוריה חברתית</th><td>${a.social.length ? a.social.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ') : nn(null)}</td></tr>
    <tr><th scope="row">היסטוריה משפחתית</th><td>${a.family == null ? '<span class="muted">לא רלוונטי לתלונה / לא נשאל</span>' : esc(a.family)}</td></tr>
    ${a.corrections ? `<tr><th scope="row">תיקונים</th><td>המטופל/ת תיקן/ה ${a.corrections} תשובות במהלך השיחה</td></tr>` : ''}
    ${a.patientQuestions.length ? `<tr><th scope="row">שאלות המטופל/ת</th><td>${a.patientQuestions.map(q => esc(q.text || q)).join(' · ')}</td></tr>` : ''}
  </tbody></table>`;
}
export function renderSummary(rules, c, { staff = false } = {}) {
  const s = c.summary; if (!s) return '<p>אין סיכום עדיין.</p>';
  const v = s.validation; const p = c.patient;
  const qa = (c.answered || []).filter(id => c.questions?.[id]).map(id => `<tr><th scope="row">${esc(c.questions[id])}</th><td>${esc(c.labels?.[id] ?? '')}</td></tr>`).join('');
  const rf = s.redFlags.map(r => `<li class="rf rf-${r.status}"><span class="rf-dot"></span>${esc(r.label)} — <b>${{ positive: 'חיובי ⚠', negative: 'נשלל', 'not-assessed': 'לא נבדק' }[r.status]}</b> ${src(rules, r.source)} <code>${esc(r.id)}</code></li>`).join('');
  const clips = (c.media?.clips || []).map(cl => cl.status === 'ok'
    ? `<li>✅ צילום "${esc(cl.label)}" — צורף (${fmtDur(cl.duration)}) ${staff ? `<div class="media-slot" data-blob="${esc(cl.blobId)}" data-kind="video"></div>` : ''}</li>`
    : `<li class="failed">❌ <b>העברת מידע נכשלה</b> — צילום "${esc(cl.label)}": ${esc(cl.reason)} <small>(${fmtDate(cl.at)})</small></li>`).join('') || '<li>לא נדרש צילום</li>';
  const sv = c.media?.sessionVideo;
  const video = sv ? `<p>🎥 הקלטת השיחה: ${fmtDur(sv.duration)}</p>${staff ? `<div class="media-slot" data-blob="${esc(sv.blobId)}" data-kind="video"></div>` : ''}`
    : `<p class="failed">🎥 אין הקלטת וידאו: ${esc(c.media?.sessionVideoError || 'לא זמין')}</p>`;
  const alerts = (c.alerts || []).map(a => `<li class="failed">🚨 ${esc(a.label)} — הנחיה: ${a.action === '1201' ? 'ער"ן 1201 / 101' : '101'} <small>${fmtDate(a.at)}</small> ${a.overridden ? '<b>(המטופל/ת דיווח/ה שסומן בטעות והמשיך/ה)</b>' : ''} <code>${esc(a.id)}</code></li>`).join('');
  const labs = renderLabs(c, staff);
  const dd = s.differentials.map((d, i) => `<li><b>${i + 1}. ${esc(d.name)}</b> <span class="muted">משקל יחסי ${d.weight}%</span> ${src(rules, d.source)} <code>${esc(d.id)}</code>${d.why.length ? `<br><small class="muted">על סמך: ${esc(d.why.join(', '))}</small>` : ''}</li>`).join('');
  const list = arr => arr.map(x => `<li>${esc(x.text)} ${src(rules, x.source)} <code>${esc(x.id)}</code></li>`).join('');
  const kc = v.knowledgeChecks.map(k => `<li>🔄 <b>needs up-to-date check:</b> ${esc(k.text)} — <span class="muted">${esc(k.reason)}</span></li>`).join('');
  const asmt = c.assessment ? `<section class="assessment-section"><h3>הערכה ראשונית שנמסרה למטופל/ת (AI)</h3>
    <p class="muted" style="font-size:13px">${esc(c.assessment.disclaimer)} השיחה נוהלה ${c.voiceMode ? 'בקול (מצב שיחה קולית)' : 'בהקלדה/בחירה'}${p.preferredName ? `; פנייה בשם "${esc(p.preferredName)}"` : ''}.</p>
    <p><b>אבחנה משוערת:</b> ${esc(c.assessment.dx.map(d => d.name).join(' · ') || '—')} ${c.assessment.dx.map(d => `<code>${esc(d.id)}</code>`).join(' ')}</p>
    <p><b>טיפול משוער:</b> ${esc([...c.assessment.treatment.map(t => t.text), c.assessment.advice].join('; '))}</p></section>` : '';
  return `
  <article class="summary" dir="rtl">
    <header class="summary-head">
      <div>
        <h2>סיכום טריאז' לעיון הרופא/ה</h2>
        <p class="muted">אל: ${esc(p.doctorName ? 'ד"ר ' + p.doctorName : 'הרופא/ה המטפל/ת')} ${p.doctorEmail ? `&lt;${esc(p.doctorEmail)}&gt;` : ''} · נוצר ${fmtDate(s.generatedAt)}</p>
      </div>
      <div class="summary-badges">
        ${urgencyBadge(s.urgency.level, s.urgency.label)}
        <span class="badge b-review">דורש בדיקת קלינאי</span>
        <span class="badge b-conf b-conf-${v.level}">ביטחון ${Math.round(v.confidence * 100)}% (${{ high: 'גבוה', medium: 'בינוני', low: 'נמוך' }[v.level]})</span>
        ${v.lowConfidence ? '<span class="badge b-low">מקרה חסר / ביטחון נמוך</span>' : ''}
      </div>
    </header>
    ${asmt}
    <p class="disclaimer">⚠️ זהו סיכום שנוצר אוטומטית במסגרת פיילוט. <b>אינו אבחנה רפואית</b> ואינו מחליף שיקול דעת קליני. כל ההמלצות הן נקודות לשיקול בלבד, ממופות לכללים בסט כללים זמני (${esc(v.rulesetVersion)}) שטרם אושר קלינית.</p>

    <section><h3>פרטי המטופל/ת</h3>
      <dl class="kv"><dt>שם</dt><dd>${esc(p.name)}</dd><dt>גיל</dt><dd>${esc(p.age)}</dd><dt>מין</dt><dd>${esc(SEX[p.sex] || p.sex)}</dd><dt>תחילת שיחה</dt><dd>${fmtDate(c.createdAt)}</dd><dt>סטטוס</dt><dd>${esc({ completed: 'הושלם', 'emergency-closed': 'הופסק — חירום', 'in-progress': 'בתהליך', 'ended-early': 'הסתיים מוקדם', abandoned: 'נזנח' }[c.status] || c.status)}</dd></dl>
    </section>

    <section><h3>רמת דחיפות (טריאז')</h3>
      <p>${urgencyBadge(s.urgency.level, s.urgency.label)} — כלל מכריע: <code>${esc(s.urgency.decidingRule)}</code></p>
      <ul class="cites">${s.urgency.matched.map(m => `<li>${esc(m.label)} → ${esc(m.level)} ${src(rules, m.source)} <code>${esc(m.id)}</code></li>`).join('')}</ul>
      ${alerts ? `<h4>התרעות חירום</h4><ul>${alerts}</ul>` : ''}
    </section>

    <section><h3>תלונה עיקרית ואנמנזה</h3>
      <p><b>תלונה:</b> ${esc(c.facts.complaint_text || s.categoryLabel)} · <b>תחום:</b> ${esc(s.categoryLabel)} (${esc(s.specialty)})</p>
      ${anamnesisHTML(buildAnamnesis(c, rules))}
      <details><summary>כל השאלות והתשובות (${(c.answered || []).length})</summary><table class="qa"><tbody>${qa}</tbody></table></details>
    </section>

    <section><h3>דגלים אדומים שנבדקו</h3><ul class="rf-list">${rf}</ul></section>

    <section><h3>מדיה</h3>${video}<ul>${clips}</ul></section>

    ${labs}

    <section><h3>אבחנה מבדלת לשיקול (לא אבחנה)</h3><ol class="plain">${dd || '<li>אין</li>'}</ol></section>
    <section><h3>בירור מוצע</h3><ul>${list(s.considerations.workup)}</ul>
      <h4>הדמיה (בסגנון ACR Appropriateness)</h4><ul>${list(s.considerations.imaging)}</ul>
      <h4>שיקולי טיפול לרופא/ה</h4><ul>${list(s.considerations.treatment)}</ul></section>

    <section><h3>פריטים הדורשים בדיקה מול מידע עדכני</h3>
      <p class="muted">ספק ידע: ${esc(s.knowledgeProvider)} — לא בוצע חיפוש חי בספרות בפרוטוטייפ.</p>
      <ul>${kc || '<li>אין</li>'}</ul></section>

    <section class="validation"><h3>שכבת אימות קליני</h3>
      <dl class="kv"><dt>גרסת סט כללים</dt><dd>${esc(v.rulesetVersion)}</dd><dt>סטטוס</dt><dd>${esc(v.rulesetStatus)}</dd><dt>שלמות שאלון</dt><dd>${v.completeness}%</dd><dt>ביטחון</dt><dd>${Math.round(v.confidence * 100)}%</dd><dt>דורש בדיקת קלינאי</dt><dd>כן</dd></dl>
      ${v.flags.length ? `<ul class="flags">${v.flags.map(f => `<li>🚩 ${esc(f)}</li>`).join('')}</ul>` : ''}
    </section>
  </article>`;
}

export function renderLabs(c, staff) {
  const ups = c.uploads || [];
  if (!ups.length && !c.facts.labs_ask) return '';
  const body = ups.map(u => {
    const p = u.parsed;
    if (!p) return `<div class="lab-doc"><h4>📄 ${esc(u.name)}</h4><p class="failed">עיבוד נכשל: ${esc(u.error || 'לא ידוע')} — <b>יש לעיין במקור</b></p>${staff ? `<button class="btn btn-sm" data-action="view-original" data-blob="${esc(u.blobId)}" data-type="${esc(u.type)}">הצג מקור</button>` : ''}</div>`;
    const rows = p.results.map(r => `<tr class="st-${r.status}">
      <td>${esc(r.name)}<br><small class="muted">${esc(r.panel)}</small></td>
      <td><bdi dir="ltr"><b>${r.qualitative ? esc(r.qualitative) : esc((r.comparator || '') + r.value)}</b> ${esc(r.unit || '')}</bdi> ${r.flag ? `<span class="flag">${esc(r.flag)}</span>` : ''}</td>
      <td>${r.ref ? `<bdi dir="ltr">${esc(r.ref.low)}–${r.ref.high === Infinity ? '∞' : esc(r.ref.high)}</bdi> <small class="muted">(${r.refSource === 'report' ? 'מהדו"ח' : 'טבלה'})</small>` : '—'}</td>
      <td>${esc(STATUS_LBL[r.status] || r.status)}</td>
      <td>${esc(r.date || '—')}<br><small class="muted">${esc(REC_LBL[r.recency])}</small></td>
      <td>${esc(REL_LBL[r.relevance])}</td>
      <td><small>${r.notes.map(esc).join('<br>')}</small></td></tr>`).join('');
    const im = p.imaging ? `<div class="imaging"><b>הדמיה:</b> ${esc(p.imaging.modalities.join(', '))} · תאריך: ${esc(p.imaging.date || 'לא זוהה')}<br>
      <b>Impression / סיכום:</b> ${esc(p.imaging.impression || 'לא זוהה')}<br>
      <b>ממצאי מפתח (לפי מילות מפתח):</b> ${p.imaging.findings.map(f => `<span class="chip-s ${f.significant ? 'sig' : ''}">${esc(f.label)}</span>`).join(' ') || '—'}</div>` : '';
    return `<div class="lab-doc">
      <h4>📄 ${esc(u.name)} <small class="muted">(${esc({ 'pdf-text': 'PDF טקסט', 'pdf-ocr': 'PDF סרוק + OCR', ocr: 'OCR תמונה' }[p.method])})</small></h4>
      <p><span class="badge b-conf b-conf-${p.confidence >= 0.85 ? 'high' : p.confidence >= 0.6 ? 'medium' : 'low'}">ביטחון פענוח ${Math.round(p.confidence * 100)}%</span>
      ${p.verifyOriginal ? '<span class="badge b-low">יש לאמת מול המסמך המקורי</span>' : ''}
      <span class="muted">תאריך מסמך: ${esc(p.docDate || 'לא זוהה')} · הסכמה להעלאה: ${fmtDate(u.consentAt)}</span>
      ${staff ? ` <button class="btn btn-sm" data-action="view-original" data-blob="${esc(u.blobId)}" data-type="${esc(u.type)}">הצג מקור</button>` : ''}</p>
      ${rows ? `<div class="table-wrap"><table class="labs"><thead><tr><th>בדיקה</th><th>ערך</th><th>טווח</th><th>פירוש</th><th>תאריך / עדכניות</th><th>רלוונטיות</th><th>הערות</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">לא זוהו ערכי מעבדה.</p>'}
      ${im}
      ${p.unrecognized.length ? `<details><summary>${p.unrecognized.length} שורות שלא זוהו (needs up-to-date check / אימות)</summary><ul>${p.unrecognized.map(l => `<li><code>${esc(l)}</code></li>`).join('')}</ul></details>` : ''}
    </div>`;
  }).join('');
  return `<section class="labs-section"><h3>בדיקות מעבדה והדמיה שצורפו</h3>
    <p class="muted">פוענח אוטומטית במכשיר (pdf.js / Tesseract OCR). פירוש מול טבלת ייחוס זמנית; טווח הייחוס של המעבדה גובר. רלוונטיות מדורגת לפי התלונה ועדכניות התוצאה.</p>
    ${body || '<p>המטופל/ת ציין/ה שאין תוצאות לצרף.</p>'}</section>`;
}

export function summaryText(rules, c) {
  const s = c.summary, p = c.patient;
  const L = [];
  L.push(`סיכום טריאז' (פיילוט — אינו אבחנה) | אל: ד"ר ${p.doctorName || ''} <${p.doctorEmail || ''}>`);
  L.push(`מטופל/ת: ${p.name}, גיל ${p.age}, ${SEX[p.sex] || p.sex} | ${fmtDate(c.createdAt)}`);
  L.push(`דחיפות: ${s.urgency.label} (כלל ${s.urgency.decidingRule}) | ביטחון ${Math.round(s.validation.confidence * 100)}% | דורש בדיקת קלינאי`);
  L.push(`תלונה: ${c.facts.complaint_text} | תחום: ${s.categoryLabel}`);
  L.push(anamnesisText(buildAnamnesis(c, rules)));
  for (const id of c.answered || []) if (c.questions?.[id]) L.push(`- ${c.questions[id]} → ${c.labels[id]}`);
  L.push('דגלים אדומים: ' + s.redFlags.filter(r => r.status !== 'not-assessed').map(r => `${r.label}: ${r.status}`).join('; '));
  for (const cl of c.media?.clips || []) L.push(cl.status === 'ok' ? `צילום ${cl.label}: צורף` : `צילום ${cl.label}: העברת מידע נכשלה (${cl.reason})`);
  for (const u of c.uploads || []) for (const r of u.parsed?.results || []) L.push(`מעבדה ${r.name}: ${r.qualitative || r.value} ${r.unit || ''} [${r.status}] ${r.date || ''}`);
  L.push('אבחנה מבדלת לשיקול: ' + s.differentials.map(d => d.name).join(' > '));
  if (c.assessment) L.push('הערכה ראשונית שנמסרה למטופל/ת (AI, לא אבחנה): ' + c.assessment.text.replace(/\n/g, ' | '));
  L.push(`סט כללים ${s.validation.rulesetVersion} — טרם אושר קלינית.`);
  return L.join('\n');
}
