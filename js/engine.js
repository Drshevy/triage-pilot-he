// Deterministic rule engine: condition evaluation, red-flag detection, urgency, differential ranking,
// and the clinical-validation layer. Every output item carries the ruleset id + source it came from.

export function evalCond(c, facts) {
  if (!c) return true;
  if (c.all) return c.all.every(x => evalCond(x, facts));
  if (c.any) return c.any.some(x => evalCond(x, facts));
  if (c.not) return !evalCond(c.not, facts);
  const v = facts[c.f];
  if ('eq' in c) return v === c.eq;
  if ('in' in c) return c.in.includes(v);
  if ('hasAny' in c) return Array.isArray(v) && v.some(x => c.hasAny.includes(x));
  if (v === undefined || v === null || v === '') return false;
  if ('gte' in c) return Number(v) >= c.gte;
  if ('gt' in c) return Number(v) > c.gt;
  if ('lte' in c) return Number(v) <= c.lte;
  if ('lt' in c) return Number(v) < c.lt;
  return false;
}
export function factsIn(c, out = new Set()) {
  if (!c) return out;
  (c.all || c.any || []).forEach(x => factsIn(x, out));
  if (c.not) factsIn(c.not, out);
  if (c.f) out.add(c.f);
  return out;
}
const norm = s => String(s || '').toLowerCase();

/** Run every red-flag rule against the current facts + all free text. Returns triggered rules. */
export function detectRedFlags(rules, facts) {
  const text = norm(facts._text);
  return rules.redFlags.filter(rf => {
    const byFacts = evalCond(rf.when, facts);
    const byText = (rf.text || []).some(k => text.includes(norm(k)));
    return byFacts || byText;
  }).map(rf => ({ id: rf.id, label: rf.label, action: rf.action, source: rf.source, byText: !evalCond(rf.when, facts) }));
}

export function redFlagStatus(rules, facts, answered) {
  const triggered = new Set(detectRedFlags(rules, facts).map(r => r.id));
  return rules.redFlags.map(rf => {
    const needed = [...factsIn(rf.when)].filter(f => f !== 'category');
    const asked = needed.filter(f => answered.has(f));
    let status = 'not-assessed';
    if (triggered.has(rf.id)) status = 'positive';
    else if (asked.length > 0) status = 'negative';
    return { id: rf.id, label: rf.label, status, source: rf.source };
  });
}

export function computeUrgency(rules, facts, alerts) {
  const levels = Object.fromEntries(rules.urgencyLevels.map(l => [l.id, l]));
  const matched = [];
  for (const a of alerts || []) matched.push({ id: a.id, label: a.label, level: 'emergency', source: a.source, kind: 'red-flag' });
  for (const r of rules.urgencyRules) if (evalCond(r.when, facts)) matched.push({ id: r.id, label: r.label, level: r.level, source: r.source, kind: 'urgency' });
  if (!matched.length) matched.push({ ...rules.defaultUrgency, kind: 'default' });
  const best = matched.reduce((a, b) => (levels[b.level].rank < levels[a.level].rank ? b : a));
  return { level: best.level, rank: levels[best.level].rank, label: levels[best.level].label, decidingRule: best.id, matched };
}

export function rankDifferentials(rules, facts) {
  const cat = rules.categories[facts.category || 'general'];
  if (!cat) return [];
  const scored = cat.differentials.map(d => {
    let score = d.base; const why = [];
    for (const b of d.boost) if (evalCond(b.when, facts)) { score += b.w; why.push([...factsIn(b.when)].join('+')); }
    return { id: d.id, name: d.name, score, source: d.source, why };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
  const total = scored.reduce((s, d) => s + d.score, 0) || 1;
  return scored.map(d => ({ ...d, weight: Math.round((d.score / total) * 100) }));
}

export function considerations(rules, facts) {
  const cat = rules.categories[facts.category || 'general'];
  const map = (arr, kind) => (arr || []).map((x, i) => ({ id: `${facts.category}-${kind}-${i + 1}`, text: x.text, source: x.source }));
  const out = { workup: map(cat.workup, 'W'), imaging: map(cat.imaging, 'I'), treatment: map(cat.treatment, 'T') };
  if (Number(facts.age) < 16) out.workup.push({ id: 'PEDS-1', text: rules.pediatricNotes.text, source: rules.pediatricNotes.source });
  return out;
}

/**
 * Clinical validation layer: verifies each recommendation cites an existing rule + source, scores confidence
 * from completeness / classification certainty / media / labs, and builds the "requires clinician review" flags.
 */
export function validate(rules, caseObj, outcome, knowledgeChecks = []) {
  const f = caseObj.facts; const flags = [];
  const sources = rules.sources;
  const cited = [...outcome.urgency.matched, ...outcome.differentials, ...outcome.considerations.workup, ...outcome.considerations.imaging, ...outcome.considerations.treatment];
  const uncited = cited.filter(x => !x.source || !sources[x.source]);
  if (uncited.length) flags.push(`${uncited.length} פריטים ללא מקור מאומת בסט הכללים`);

  const required = caseObj.requiredQuestions || [];
  const answered = required.filter(q => caseObj.answered?.includes(q));
  const completeness = required.length ? answered.length / required.length : 0;
  if (completeness < 0.9) flags.push(`שאלון לא הושלם (${Math.round(completeness * 100)}%)`);

  const catCert = f.category_method === 'chip' ? 1 : f.category_method === 'keyword' ? 0.85 : 0.55;
  if (catCert < 0.6) flags.push('סיווג התלונה אינו ודאי (קטגוריה כללית)');

  const failedMedia = (caseObj.media?.clips || []).filter(c => c.status === 'failed').length;
  if (failedMedia) flags.push(`${failedMedia} בקשות צילום נכשלו — העברת מידע חזותי לא הושלמה`);
  if (!caseObj.media?.sessionVideo) flags.push('אין הקלטת וידאו של השיחה');

  const labVerify = (caseObj.uploads || []).filter(u => u.parsed?.verifyOriginal).length;
  if (labVerify) flags.push(`${labVerify} מסמכי מעבדה/הדמיה דורשים אימות מול המקור`);

  const top = outcome.differentials;
  const margin = top.length > 1 ? (top[0].score - top[1].score) / Math.max(1, top[0].score) : 1;
  if (top.length > 1 && margin < 0.2) flags.push('אבחנה מבדלת לא מובחנת — שתי אפשרויות מובילות קרובות');
  if (caseObj.alerts?.length) flags.push('הופעל התרעת חירום — נדרש מעקב');
  if (caseObj.alerts?.some(a => a.overridden)) flags.push('המטופל/ת דיווח/ה שההתרעה סומנה בטעות והמשיך/ה — לבדיקה');
  if (caseObj.status === 'emergency-closed') flags.push('השיחה הופסקה בשל חירום — מידע חלקי');

  let confidence = 0.35 * completeness + 0.25 * catCert + 0.15 * (failedMedia ? 0.4 : 1) + 0.15 * Math.min(1, 0.5 + margin) + 0.10 * (labVerify ? 0.6 : 1);
  if (caseObj.status === 'emergency-closed') confidence = Math.min(confidence, 0.55);
  confidence = Math.round(confidence * 100) / 100;
  const level = confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';
  if (level === 'low') flags.push('רמת ביטחון נמוכה');

  return {
    rulesetVersion: rules.version, rulesetStatus: rules.status, confidence, level,
    requiresReview: true, // always true in the pilot (ruleset not clinically signed off)
    lowConfidence: level === 'low' || completeness < 0.9,
    completeness: Math.round(completeness * 100), flags, uncited: uncited.map(x => x.id), knowledgeChecks
  };
}
