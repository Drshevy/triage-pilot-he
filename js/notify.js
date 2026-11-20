// NotificationProvider: in the prototype, alerts reach open dashboards in the same browser via
// BroadcastChannel. In production replace with a backend push (e.g. secure pager/SMS/EHR inbox) — never
// put PHI in SMS/email bodies; send a link to the authenticated dashboard instead.
const ch = 'BroadcastChannel' in window ? new BroadcastChannel('triage-alerts') : null;
export const Notifier = {
  notifyAlert(caseId, alert) { ch?.postMessage({ type: 'alert', caseId, ruleId: alert.id, label: alert.label, at: Date.now() }); },
  notifyCase(caseId) { ch?.postMessage({ type: 'case', caseId, at: Date.now() }); },
  onMessage(fn) { if (ch) ch.onmessage = e => fn(e.data); }
};
