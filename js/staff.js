// Staff area: PIN gate, dashboard (priority queue), case view + review, pilot analytics, settings.
import { $, $$, esc, toast, fmtDate, fmtDur, saveSettings, getSettings } from './util.js';
import { ctx, modal, confirmDialog, wipeAllFlow } from './app.js';
import { renderSummary, urgencyBadge } from './summary.js';
import { sortByPriority, route } from './routing.js';
import { Notifier } from './notify.js';
import { idbPut, idbDel } from './idb.js';
import { loadDemoData } from './demo.js';

const main = () => $('#main');
const authed = () => sessionStorage.getItem('triage.staff') === '1';
const urls = [];
const blobURL = b => { const u = URL.createObjectURL(b); urls.push(u); return u; };
const revokeAll = () => { while (urls.length) URL.revokeObjectURL(urls.pop()); };
const LV = Object.fromEntries([['emergency', 'חירום'], ['same-day', 'באותו יום'], ['within-days', 'תוך ימים'], ['routine', 'שגרתי']]);

export async function renderStaff(page, arg) {
  revokeAll();
  if (!authed()) return renderPin(page === 'staff' ? 'dashboard' : page, arg);
  const nav = `<nav class="row" aria-label="ניווט צוות" style="margin-bottom:10px">
    <a class="btn btn-sm ${page === 'dashboard' || page === 'staff' ? 'btn-primary' : ''}" href="#/dashboard">תור מקרים</a>
    <a class="btn btn-sm ${page === 'analytics' ? 'btn-primary' : ''}" href="#/analytics">אנליטיקה</a>
    <a class="btn btn-sm ${page === 'settings' ? 'btn-primary' : ''}" href="#/settings">הגדרות</a>
    <span class="grow"></span><button class="btn btn-sm btn-ghost" id="lock">יציאה</button></nav>`;
  main().innerHTML = nav + '<div id="staff-body"></div>';
  $('#lock').onclick = () => { sessionStorage.removeItem('triage.staff'); location.hash = '#/'; };
  Notifier.onMessage(m => {
    if (m.type === 'alert') { toast('🚨 התרעת חירום חדשה: ' + m.label, 'error'); if (location.hash.startsWith('#/dashboard')) renderDashboard(); }
    else if (m.type === 'case' && location.hash.startsWith('#/dashboard')) renderDashboard();
  });
  if (page === 'case') return renderCase(arg);
  if (page === 'analytics') return renderAnalytics();
  if (page === 'settings') return renderSettings();
  return renderDashboard();
}

function renderPin(next, arg) {
  main().innerHTML = `<form class="card" id="pinf" style="max-width:380px;margin:30px auto">
    <h2>כניסת צוות</h2><p class="muted">דשבורד הפיילוט. קוד ברירת מחדל: 1234 (ניתן לשינוי בהגדרות).</p>
    <div class="field"><label for="pin">קוד PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="off"></div>
    <button class="btn btn-primary" type="submit" id="pin-go">כניסה</button> <a class="btn btn-ghost" href="#/">חזרה</a></form>`;
  $('#pin').focus();
  $('#pinf').onsubmit = e => {
    e.preventDefault();
    if ($('#pin').value === ctx.settings.staffPin) { sessionStorage.setItem('triage.staff', '1'); location.hash = `#/${next}${arg ? '/' + arg : ''}`; if (location.hash === `#/${next}`) renderStaff(next, arg); }
    else toast('קוד שגוי', 'error');
  };
}

let filter = 'all';
async function renderDashboard() {
  const all = sortByPriority((await ctx.storage.listCases()).filter(c => !c._undecryptable));
  const list = all.filter(c => filter === 'all' ? true : filter === 'unreviewed' ? !c.review?.reviewed : c.routing?.queue === filter);
  const activeAlerts = all.filter(c => c.alerts?.length && !c.review?.reviewed);
  const body = $('#staff-body');
  body.innerHTML = `
    <div class="dash-head"><h1>תור מקרים</h1>
      <div class="row"><button class="btn btn-sm" id="demo">טעינת נתוני הדגמה (5 מקרים)</button></div></div>
    ${activeAlerts.length ? `<div class="alert-banner" role="alert">🚨 ${activeAlerts.length} התרעות חירום פתוחות — מוצגות בראש התור</div>` : ''}
    <div class="tabs" role="group" aria-label="סינון">
      ${[['all', 'הכל'], ['doctor', 'תור רופא/ה מטפל/ת'], ['secondary', 'טריאז\' משני'], ['unreviewed', 'טרם נבדקו']].map(([k, l]) => `<button class="btn btn-sm" data-f="${k}" aria-pressed="${filter === k}">${l} (${k === 'all' ? all.length : k === 'unreviewed' ? all.filter(c => !c.review?.reviewed).length : all.filter(c => c.routing?.queue === k).length})</button>`).join('')}
    </div>
    <div class="case-list">${list.map(row).join('') || '<div class="card muted">אין מקרים. אפשר לטעון נתוני הדגמה.</div>'}</div>
    <p class="muted" style="font-size:13px;margin-top:10px">מיון: התרעות חירום ← רמת דחיפות ← ותק (הוותיק ראשון). מקרים שנבדקו יורדים לתחתית.</p>`;
  $$('[data-f]', body).forEach(b => b.onclick = () => { filter = b.dataset.f; renderDashboard(); });
  $$('.case-row', body).forEach(b => b.onclick = () => { location.hash = `#/case/${b.dataset.id}`; });
  $('#demo').onclick = async () => { await loadDemoData(ctx); toast('נטענו 5 מקרי הדגמה', 'ok'); renderDashboard(); };
}
function row(c) {
  const s = c.summary; const lv = s?.urgency.level || 'none';
  return `<button class="case-row lv-${lv} ${c.review?.reviewed ? 'reviewed' : ''}" data-id="${esc(c.id)}">
    <span class="stripe"></span>
    <span><b>${c.alerts?.length ? '🚨 ' : ''}${esc(c.patient?.name)}</b> · ${esc(c.patient?.age)} · ${esc(s?.categoryLabel || c.facts?.complaint_text || '—')} ${c.demo ? '<span class="badge b-review">הדגמה</span>' : ''}<br>
      <small class="muted">${fmtDate(c.createdAt)} · ${c.routing?.queue === 'secondary' ? 'טריאז\' משני' : c.routing?.queue === 'doctor' ? 'רופא/ה מטפל/ת' : 'בתהליך'} · ${esc({ completed: 'הושלם', 'emergency-closed': 'חירום', 'ended-early': 'הסתיים מוקדם', 'in-progress': 'בתהליך' }[c.status] || c.status)}${s ? ` · ביטחון ${Math.round(s.validation.confidence * 100)}%` : ''}${(c.media?.clips || []).some(x => x.status === 'failed') ? ' · ❌ צילום נכשל' : ''}${c.uploads?.length ? ` · 📄 ${c.uploads.length}` : ''}</small></span>
    <span>${s ? urgencyBadge(lv, LV[lv]) : '<span class="badge">בתהליך</span>'}${c.review?.reviewed ? `<br><small>${c.review.verdict === 'agree' ? '✔ הסכמה' : c.review.verdict === 'disagree' ? '✖ אי-הסכמה' : 'נבדק'}</small>` : ''}</span></button>`;
}

async function renderCase(id) {
  const c = await ctx.storage.getCase(id);
  const body = $('#staff-body');
  if (!c) { body.innerHTML = '<div class="card">המקרה לא נמצא.</div>'; return; }
  const r = c.review || {};
  body.innerHTML = `<div class="row" style="margin-bottom:8px"><a class="btn btn-sm" href="#/dashboard">→ חזרה לתור</a><span class="grow"></span><button class="btn btn-sm btn-danger" id="del-case">מחיקת המקרה</button></div>
    <div class="card review-panel" id="review">
      <h3 style="margin-top:0">בדיקת רופא/ה</h3>
      ${c.summary ? `<p>דחיפות לפי ה-AI: ${urgencyBadge(c.summary.urgency.level, c.summary.urgency.label)} · ניתוב: ${esc(c.routing?.reason || '')}</p>` : '<p>אין סיכום (שיחה בתהליך).</p>'}
      <div class="row">
        <label class="toggle"><input type="radio" name="verdict" value="agree" ${r.verdict === 'agree' ? 'checked' : ''}> מסכים/ה לדחיפות</label>
        <label class="toggle"><input type="radio" name="verdict" value="disagree" ${r.verdict === 'disagree' ? 'checked' : ''}> לא מסכים/ה</label>
        <select id="doc-urg" aria-label="דחיפות לפי הרופא/ה" ${r.verdict === 'disagree' ? '' : 'disabled'} style="max-width:200px">${Object.entries(LV).map(([k, l]) => `<option value="${k}" ${r.doctorUrgency === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-top:8px"><label for="doc-note">הערת רופא/ה</label><textarea id="doc-note">${esc(r.note || '')}</textarea></div>
      <div class="row"><button class="btn btn-primary" id="save-review">${r.reviewed ? 'עדכון בדיקה' : 'סימון כנבדק'}</button>${r.reviewed ? `<span class="muted">נבדק ${fmtDate(r.at)}</span>` : ''}</div>
    </div>
    <div class="card" id="case-summary">${c.summary ? renderSummary(ctx.rules, c, { staff: true }) : '<p>השיחה עדיין בתהליך.</p>'}</div>
    <div class="card"><h3>תמליל השיחה</h3><div class="chat" style="max-height:none">${(c.transcript || []).map(m => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('')}</div></div>`;
  $$('input[name=verdict]').forEach(x => x.onchange = () => { $('#doc-urg').disabled = $('input[name=verdict]:checked').value !== 'disagree'; });
  $('#save-review').onclick = async () => {
    const v = $('input[name=verdict]:checked')?.value || null;
    c.review = { reviewed: true, verdict: v, doctorUrgency: v === 'disagree' ? $('#doc-urg').value : c.summary?.urgency.level, aiUrgency: c.summary?.urgency.level, note: $('#doc-note').value, at: Date.now() };
    await ctx.storage.saveCase(c); toast('הבדיקה נשמרה', 'ok'); renderCase(id);
  };
  $('#del-case').onclick = async () => {
    if (!(await confirmDialog('למחוק לצמיתות את המקרה, כולל וידאו, צילומים, מסמכים ומפתח ההצפנה שלו?', 'מחק', true))) return;
    await ctx.storage.deleteCase(id); toast('המקרה נמחק', 'ok'); location.hash = '#/dashboard';
  };
  // hydrate media (decrypt on demand)
  for (const slot of $$('.media-slot', body)) {
    const b = slot.dataset.blob && await ctx.storage.getBlob(c.id, slot.dataset.blob);
    if (!b) { slot.innerHTML = '<small class="muted">(אין קובץ מדיה — מקרה הדגמה או שנמחק)</small>'; continue; }
    slot.innerHTML = `<video controls playsinline preload="metadata" src="${blobURL(b)}"></video>`;
  }
  $$('[data-action=view-original]', body).forEach(btn => btn.onclick = async () => {
    const b = await ctx.storage.getBlob(c.id, btn.dataset.blob);
    if (!b) return toast('הקובץ המקורי אינו זמין', 'error');
    const u = blobURL(b); const isPdf = /pdf/.test(b.type);
    const m = modal(`<div class="row"><h3 class="grow" style="margin:0">מסמך מקורי</h3><a class="btn btn-sm" href="${u}" download="original${isPdf ? '.pdf' : '.png'}">הורדה</a><button class="btn btn-sm" id="close-orig">סגירה</button></div>
      ${isPdf ? `<iframe src="${u}" title="מסמך מקורי"></iframe>` : `<img src="${u}" alt="מסמך מקורי שהועלה">`}`);
    $('#close-orig').onclick = m.close;
  });
}

// ---------------- analytics ----------------
function bars(data, { h = 160, suffix = '', max } = {}) {
  const w = 320, pad = 26, top = 18, bw = (w - pad) / Math.max(1, data.length);
  const M = max || Math.max(1, ...data.map(d => d.value));
  return `<svg viewBox="0 ${-top} ${w} ${h + 34 + top}" role="img" aria-label="${esc(data.map(d => `${d.label}: ${d.value}${suffix}`).join(', '))}" style="width:100%">
    ${data.map((d, i) => { const bh = (d.value / M) * h; const x = w - pad / 2 - (i + 1) * bw + 4; return `<rect x="${x}" y="${h - bh + 4}" width="${bw - 8}" height="${bh}" rx="4" fill="${d.color || '#14b8a6'}"></rect><text x="${x + (bw - 8) / 2}" y="${h - bh}" font-size="11" text-anchor="middle" fill="#0f172a">${d.value}${suffix}</text><text x="${x + (bw - 8) / 2}" y="${h + 20}" font-size="10" text-anchor="middle" fill="#64748b">${esc(d.label)}</text>`; }).join('')}
    <line x1="0" y1="${h + 4}" x2="${w}" y2="${h + 4}" stroke="#e2e8f0"></line></svg>`;
}
export function computeAnalytics(cases) {
  const n = cases.length;
  const completed = cases.filter(c => ['completed', 'emergency-closed'].includes(c.status)).length;
  const alerts = cases.filter(c => c.alerts?.length).length;
  const clips = cases.flatMap(c => c.media?.clips || []);
  const clipsOk = clips.filter(x => x.status === 'ok').length;
  const verdicts = cases.filter(c => c.review?.verdict);
  const agree = verdicts.filter(c => c.review.verdict === 'agree').length;
  const uploads = cases.flatMap(c => c.uploads || []);
  const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
  return { n, completed, completionRate: pct(completed, n), alerts, alertRate: pct(alerts, n), clips: clips.length, clipsOk, filmingRate: pct(clipsOk, clips.length), reviewed: cases.filter(c => c.review?.reviewed).length, verdicts: verdicts.length, agree, agreementRate: pct(agree, verdicts.length), uploads: uploads.length, uploadsParsed: uploads.filter(u => u.parsed?.results?.length || u.parsed?.imaging).length };
}
async function renderAnalytics() {
  const cases = (await ctx.storage.listCases()).filter(c => !c._undecryptable);
  const a = computeAnalytics(cases);
  const days = Array.from({ length: 10 }, (_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (9 - i)); return d; });
  const perDay = days.map(d => ({ label: `${d.getDate()}/${d.getMonth() + 1}`, value: cases.filter(c => { const x = new Date(c.createdAt); x.setHours(0, 0, 0, 0); return +x === +d; }).length }));
  const urg = ['emergency', 'same-day', 'within-days', 'routine'].map((k, i) => ({ label: LV[k], value: cases.filter(c => c.summary?.urgency.level === k).length, color: ['#dc2626', '#f97316', '#f59e0b', '#16a34a'][i] }));
  const cats = Object.entries(cases.reduce((m, c) => { const k = c.summary?.categoryLabel; if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value]) => ({ label: label.split('/')[0].trim().split(' ').slice(0, 2).join(' ').slice(0, 9), value, color: '#0f766e' }));
  const rates = [{ label: 'השלמה', value: a.completionRate }, { label: 'התרעות', value: a.alertRate, color: '#dc2626' }, { label: 'צילום הצליח', value: a.filmingRate, color: '#2563eb' }, { label: 'הסכמת רופא-AI', value: a.agreementRate, color: '#16a34a' }];
  $('#staff-body').innerHTML = `<h1>אנליטיקת פיילוט</h1>
    <div class="kpis" id="kpis">
      <div class="kpi"><b>${a.n}</b><span>שיחות</span></div>
      <div class="kpi"><b>${a.completionRate}%</b><span>שיעור השלמה (${a.completed}/${a.n})</span></div>
      <div class="kpi"><b>${a.alertRate}%</b><span>שיעור התרעות חירום (${a.alerts})</span></div>
      <div class="kpi"><b>${a.filmingRate}%</b><span>הצלחת צילום (${a.clipsOk}/${a.clips})</span></div>
      <div class="kpi"><b>${a.agreementRate}%</b><span>הסכמת רופא–AI (${a.agree}/${a.verdicts})</span></div>
    </div>
    <div class="charts">
      <div class="card"><h3>מדדי פיילוט (%)</h3>${bars(rates, { suffix: '%', max: 100 })}</div>
      <div class="card"><h3>שיחות ב-10 הימים האחרונים</h3>${bars(perDay)}</div>
      <div class="card"><h3>התפלגות דחיפות</h3>${bars(urg)}</div>
      <div class="card"><h3>לפי תחום</h3>${bars(cats.length ? cats : [{ label: '—', value: 0 }])}</div>
    </div>
    <div class="card"><h3>הערות להערכת הפיילוט</h3><ul>
      <li>מסמכים שהועלו: ${a.uploads}, פוענחו עם ממצאים: ${a.uploadsParsed}.</li>
      <li>מקרים שנבדקו על ידי רופא/ה: ${a.reviewed}. הסכמה מחושבת רק על מקרים עם הכרעה (מסכים/לא מסכים).</li>
      <li>הנתונים מחושבים מקומית מהמכשיר הזה בלבד; לפיילוט רב-אתרי נדרש backend (ראו README).</li></ul></div>`;
}

// ---------------- settings ----------------
async function renderSettings() {
  const s = ctx.settings;
  $('#staff-body').innerHTML = `<h1>הגדרות</h1>
  <form class="card" id="set-form">
    <h3>ניתוב עדיפויות</h3>
    ${[['by-urgency', 'לפי דחיפות: חירום/באותו יום → טריאז\' משני, השאר → רופא/ה מטפל/ת'], ['doctor', 'הכל לתור הרופא/ה המטפל/ת (בראש התור לפי דחיפות)'], ['secondary', 'הכל לטריאז\' משני']].map(([v, l]) => `<label class="check"><input type="radio" name="routing" value="${v}" ${s.routingMode === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}
    <p class="muted" style="font-size:14px">התרעות חירום תמיד בראש כל תור.</p>
    <h3>חוויית מטופל</h3>
    <label class="check"><input type="checkbox" id="s-preview" ${s.selfPreview ? 'checked' : ''}><span>הצגת תצוגה עצמית כברירת מחדל (המטופל/ת יכול/ה לשנות)</span></label>
    <label class="check"><input type="checkbox" id="s-tts" ${s.tts ? 'checked' : ''}><span>קול לאווטאר (Web Speech, he-IL). מועדף קול מקומי במכשיר.</span></label>
    <label class="check"><input type="checkbox" id="s-stt" ${s.voiceInput ? 'checked' : ''}><span>קלט קולי (זיהוי דיבור). <b>אזהרה:</b> ב-Chrome השמע נשלח לשרתי Google — כבוי כברירת מחדל מטעמי פרטיות.</span></label>
    <div class="field"><label for="s-clip">אורך צילום מקסימלי (שניות)</label><input id="s-clip" type="number" min="5" max="30" value="${s.clipSeconds}"></div>
    <h3>אבטחה</h3>
    <div class="field"><label for="s-pin">PIN צוות</label><input id="s-pin" type="text" inputmode="numeric" value="${esc(s.staffPin)}"></div>
    <button class="btn btn-primary" type="submit" id="save-settings">שמירה</button>
  </form>
  <div class="card"><h3>הצפנה במנוחה</h3>
    <p>מצב נוכחי: <b>${s.encryptionMode === 'passcode' ? 'קוד גישה (PBKDF2)' : 'מפתח מכשיר לא-ניתן-לייצוא'}</b>. כל המידע (שיחה, וידאו, צילומים, מסמכים) מוצפן ב-AES-GCM-256 עם מפתח ייחודי לכל מקרה.</p>
    ${s.encryptionMode === 'passcode' ? '<button class="btn" id="to-device">מעבר למפתח מכשיר</button>' : '<div class="row"><input id="new-pc" type="password" placeholder="קוד גישה חדש (8+ תווים)" style="max-width:260px" autocomplete="new-password"><button class="btn" id="to-pass">הצפנה בקוד גישה</button></div>'}
  </div>
  <div class="card"><h3>נתונים</h3><div class="row"><button class="btn" id="demo2">טעינת נתוני הדגמה</button><button class="btn btn-danger" id="wipe2">מחיקת כל הנתונים והמפתחות</button></div></div>`;
  $('#set-form').onsubmit = e => {
    e.preventDefault();
    Object.assign(s, { routingMode: $('input[name=routing]:checked').value, selfPreview: $('#s-preview').checked, tts: $('#s-tts').checked, voiceInput: $('#s-stt').checked, clipSeconds: Math.max(5, Math.min(30, +$('#s-clip').value || 12)), staffPin: $('#s-pin').value.trim() || '1234' });
    saveSettings(s); toast('ההגדרות נשמרו', 'ok');
  };
  $('#demo2').onclick = async () => { await loadDemoData(ctx); toast('נטענו 5 מקרי הדגמה', 'ok'); };
  $('#wipe2').onclick = wipeAllFlow;
  $('#to-pass')?.addEventListener('click', async () => {
    const pc = $('#new-pc').value; if (pc.length < 8) return toast('קוד גישה של 8 תווים לפחות', 'error');
    const v = ctx.storage.vault; const { key, saltRec } = await v.deriveNewPasscodeKek(pc);
    await v.rewrapAll(await ctx.storage.rawCaseRecords(), key);
    await idbPut('keys', saltRec); await idbDel('keys', 'device-kek');
    s.encryptionMode = 'passcode'; v.mode = 'passcode'; saveSettings(s); toast('הנתונים מוצפנים כעת בקוד גישה', 'ok'); renderSettings();
  });
  $('#to-device')?.addEventListener('click', async () => {
    const v = ctx.storage.vault; await idbDel('keys', 'device-kek');
    const newKek = await v._deviceKek();
    await v.rewrapAll(await ctx.storage.rawCaseRecords(), newKek);
    await idbDel('keys', 'pass-salt'); s.encryptionMode = 'device'; v.mode = 'device'; saveSettings(s); toast('עבר למפתח מכשיר', 'ok'); renderSettings();
  });
}
