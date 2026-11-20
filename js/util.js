// Small shared helpers (no dependencies).
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape any untrusted string before inserting into HTML. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const uid = (p = '') => p + (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
let _rules, _labs;
export async function loadRules() {
  if (!_rules) _rules = await (await fetch('rules/rules.json', { cache: 'no-store' })).json();
  return _rules;
}
export async function loadLabRanges() {
  if (!_labs) _labs = await (await fetch('rules/lab-ranges.json', { cache: 'no-store' })).json();
  return _labs;
}
export function toast(msg, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`; t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

const SETTINGS_KEY = 'triage.settings';
export const DEFAULT_SETTINGS = {
  routingMode: 'by-urgency',   // 'doctor' | 'secondary' | 'by-urgency'
  staffPin: '1234',
  selfPreview: true,
  tts: true,
  ttsEngine: 'auto',           // 'auto' (device Hebrew voice → on-device neural fallback) | 'native' | 'neural' | 'none'
  avatarMode: 'auto',          // 'auto' = animated photo portrait | '3d' (TalkingHead, opt-in)
  voiceSilenceMs: 1500,        // voice mode: silence before auto-submit
  voiceBargeIn: true,          // voice mode: talking over the avatar interrupts it
  voiceInput: false,           // off by default: browser STT may send audio to the browser vendor's cloud
  encryptionMode: 'device',    // 'device' | 'passcode'
  clipSeconds: 12
};
export function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
