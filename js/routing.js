// Priority routing. Alerts always go to the top; then urgency rank; then oldest first.
export function route(caseObj, settings) {
  const rank = caseObj.summary?.urgency?.rank ?? 3;
  const alert = (caseObj.alerts || []).length > 0;
  let queue, reason;
  if (settings.routingMode === 'doctor') { queue = 'doctor'; reason = 'הגדרה: כל הסיכומים לתור הרופא/ה המטפל/ת'; }
  else if (settings.routingMode === 'secondary') { queue = 'secondary'; reason = 'הגדרה: כל הסיכומים לטריאז\' משני'; }
  else if (alert || rank <= 2) { queue = 'secondary'; reason = 'דחוף (חירום/באותו יום) → טריאז\' משני לטיפול מיידי, עם העתק לרופא/ה'; }
  else { queue = 'doctor'; reason = 'לא דחוף → תור הרופא/ה המטפל/ת'; }
  return { queue, reason, mode: settings.routingMode, priority: priorityKey(caseObj), at: Date.now() };
}
export function priorityKey(c) {
  const alert = (c.alerts || []).length > 0 ? 0 : 1;
  const rank = c.summary?.urgency?.rank ?? (c.status === 'in-progress' ? 5 : 4);
  return [alert, rank, c.createdAt];
}
export function sortByPriority(cases) {
  return [...cases].sort((a, b) => {
    const ra = a.review?.reviewed ? 1 : 0, rb = b.review?.reviewed ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ka = priorityKey(a), kb = priorityKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}
