// App shell: router, patient flow (onboarding → consent → AI session → summary), staff routes.
import { $, $$, esc, uid, toast, fmtDur, getSettings, loadRules } from './util.js';
import { EncryptedIndexedDBStorage } from './storage.js';
import { createAvatar } from './avatar.js';
import { ConversationalDialogue } from './dialogue.js';
import { VoiceController } from './voice.js';
import { Speaker, isIOS } from './speaker.js';
import { buildAssessment } from './assessment.js';
import { voiceParam } from './avatar.js';
import { MediaSession } from './media.js';
import { SpeechInput } from './speech.js';
import { NullKnowledgeProvider } from './knowledge.js';
import { buildSummary, renderSummary, summaryText } from './summary.js';
import { route } from './routing.js';
import { Notifier } from './notify.js';
import { parseFile } from './labs.js';
import * as Staff from './staff.js';

// ---- swap points: replace these instances to change provider ----
export const ctx = {
  settings: getSettings(),
  storage: new EncryptedIndexedDBStorage(),     // StorageProvider
  knowledge: new NullKnowledgeProvider(),       // KnowledgeProvider
  makeAvatar: s => createAvatar(s),             // AvatarProvider (animated portrait default; 3D TalkingHead opt-in)
  makeDialogue: (rules, patient) => new ConversationalDialogue(rules, patient),                    // DialogueProvider (free-text conversation)
  rules: null
};
window.__triage = ctx; // for debugging/tests only

const main = () => $('#main');
let draft = null;          // patient details between onboarding and consent (memory only)
let S = null;              // active session state
let doneAvatar = null;     // avatar speaking the closing assessment on the done page
export const speaker = () => Speaker.shared({ ttsEnabled: ctx.settings.tts, engine: voiceParam() || ctx.settings.ttsEngine || 'auto' });

export function modal(html, { onClose } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back" role="dialog" aria-modal="true"><div class="modal">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; onClose?.(); };
  root.querySelector('.modal-back').addEventListener('click', e => { if (e.target.classList.contains('modal-back')) close(); });
  root.querySelector('[autofocus], button, a, input')?.focus();
  return { root: root.querySelector('.modal'), close };
}
export function confirmDialog(text, okLabel = 'אישור', danger = false) {
  return new Promise(res => {
    const m = modal(`<p>${text}</p><div class="row"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel)}</button><button class="btn" data-cancel>ביטול</button></div>`, { onClose: () => res(false) });
    m.root.querySelector('[data-ok]').onclick = () => { $('#modal-root').innerHTML = ''; res(true); };
    m.root.querySelector('[data-cancel]').onclick = () => { $('#modal-root').innerHTML = ''; res(false); };
  });
}

// ---------------- boot ----------------
async function boot() {
  ctx.rules = await loadRules();
  if (!window.isSecureContext || !crypto.subtle) {
    main().innerHTML = `<div class="card notice-red notice"><h2>נדרש חיבור מאובטח (HTTPS)</h2><p>האפליקציה מצפינה נתונים ומשתמשת במצלמה, ולכן חייבת לרוץ ב-HTTPS או ב-localhost.</p></div>`;
    return;
  }
  await ctx.storage.init(ctx.settings);
  window.addEventListener('hashchange', render);
  render();
}

export async function render() {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  if (S && page !== 'session') await endSessionSilently();
  if (doneAvatar) { try { doneAvatar.stop(); doneAvatar.destroy?.(); } catch {} doneAvatar = null; }
  $('#modal-root').innerHTML = '';
  if (!ctx.storage.isUnlocked()) return renderUnlock();
  window.scrollTo(0, 0);
  switch (page) {
    case '': case 'home': return renderHome();
    case 'intake': return renderIntake();
    case 'consent': return draft ? renderConsent() : (location.hash = '#/intake');
    case 'session': return draft ? startSession() : (location.hash = '#/intake');
    case 'done': return renderDone(arg);
    case 'staff': case 'dashboard': case 'case': case 'analytics': case 'settings':
      return Staff.renderStaff(page, arg);
    default: location.hash = '#/';
  }
}

function renderUnlock() {
  main().innerHTML = `<div class="card" style="max-width:420px;margin:30px auto">
    <h2>🔒 הנתונים מוצפנים בקוד גישה</h2><p class="muted">הזינו את קוד הגישה של המכשיר כדי לפענח את הנתונים המקומיים.</p>
    <div class="field"><label for="pc">קוד גישה</label><input id="pc" type="password" autocomplete="current-password"></div>
    <button class="btn btn-primary" id="unlock">פתיחה</button> <button class="btn btn-ghost" id="wipe">שכחתי — מחק הכל</button></div>`;
  $('#unlock').onclick = async () => {
    const ok = await ctx.storage.vault.unlockPasscode($('#pc').value);
    if (ok) render(); else toast('קוד שגוי', 'error');
  };
  $('#wipe').onclick = () => wipeAllFlow();
}

export async function wipeAllFlow() {
  if (!(await confirmDialog('פעולה זו תמחק לצמיתות את כל הנתונים במכשיר זה: שיחות, הקלטות וידאו, צילומים, מסמכים שהועלו ומפתחות ההצפנה. לא ניתן לשחזר.', 'מחק הכל לצמיתות', true))) return;
  await ctx.storage.wipeAll();
  ctx.settings = getSettings();
  await ctx.storage.init(ctx.settings);
  toast('כל הנתונים והמפתחות נמחקו מהמכשיר', 'ok');
  location.hash = '#/'; render();
}

// ---------------- patient pages ----------------
function renderHome() {
  main().innerHTML = `
  <section class="card hero">
    <img src="assets/doctor.jpg" alt="אווטאר ממוחשב של נועה, עוזרת טריאז' דיגיטלית">
    <div>
      <h1>טריאז' דיגיטלי עם נועה</h1>
      <p>שיחה קצרה עם עוזרת דיגיטלית שתשאל על התסמינים שלך ותכין <b>סיכום לרופא/ה המטפל/ת שלך</b>, עם המלצה לרמת דחיפות. לא קשור לאף קופת חולים.</p>
      <p class="notice">⚠️ <b>זהו אב-טיפוס לפיילוט.</b> הוא אינו מכשיר רפואי, אינו מאבחן ואינו מחליף רופא. <b>במצב חירום חייגו 101.</b> במצוקה נפשית: ער"ן 1201.</p>
      <div class="row"><a class="btn btn-primary" href="#/intake" id="start">התחלת שיחה</a><a class="btn" href="#/staff">כניסת צוות (דשבורד)</a></div>
    </div>
  </section>
  <section class="card"><h3>פרטיות</h3>
    <p class="muted">כל המידע נשמר <b>רק במכשיר הזה</b>, מוצפן (AES-GCM). אין שליחה לשרתים חיצוניים. ניתן למחוק הכל בכל רגע.</p>
    <button class="btn btn-danger" id="wipe-all">מחק את כל המידע שלי</button></section>
  <section class="card credits"><h3>קול וזיהוי דיבור</h3>
    <p class="muted" style="font-size:14px">נועה מדברת בקול העברי המובנה במכשיר (באייפון: Carmit). אם אין במכשיר קול עברי, נטען <b>קול נוירוני שפועל במכשיר עצמו</b>, בלי שליחת טקסט לשרת. זיהוי דיבור (במצב שיחה קולית) מתבצע על ידי הדפדפן: ב-Chrome השמע נשלח ל-Google.</p>
    <p class="muted" style="font-size:12px" lang="en" dir="ltr">Credits: Piper Hebrew voice "noa" © thewh1teagle, CC BY 4.0 · renikud Hebrew G2P © M. Melichov, Y. Kolani, M. Alper, CC BY 4.0 · ONNX Runtime Web © Microsoft, MIT · see vendor/tts/LICENSES.txt</p></section>`;
  $('#wipe-all').onclick = wipeAllFlow;
}

function renderIntake() {
  const d = draft || {};
  main().innerHTML = `<form class="card" id="intake" novalidate>
    <h2>פרטים לפני השיחה</h2><p class="muted">נאסף רק המידע הנחוץ לסיכום עבור הרופא/ה שלך.</p>
    <div class="grid2">
      <div class="field"><label for="name">שם מלא</label><input id="name" type="text" required autocomplete="name" value="${esc(d.name || '')}"></div>
      <div class="field"><label for="age">גיל</label><input id="age" type="number" min="0" max="120" required inputmode="numeric" value="${esc(d.age ?? '')}"></div>
      <div class="field"><label for="sex">מין</label><select id="sex" required><option value="">בחר/י</option><option value="female" ${d.sex === 'female' ? 'selected' : ''}>נקבה</option><option value="male" ${d.sex === 'male' ? 'selected' : ''}>זכר</option><option value="other" ${d.sex === 'other' ? 'selected' : ''}>אחר / מעדיפ/ה לא לציין</option></select></div>
      <div class="field"><label for="dname">שם הרופא/ה המטפל/ת</label><input id="dname" type="text" required value="${esc(d.doctorName || '')}"></div>
      <div class="field"><label for="demail">אימייל הרופא/ה</label><input id="demail" type="email" required value="${esc(d.doctorEmail || '')}"></div>
    </div>
    <p class="muted" style="font-size:14px">אין צורך במספר ת.ז. (צמצום מידע).</p>
    <div id="err" class="failed" role="alert"></div>
    <div class="row"><button class="btn btn-primary" type="submit" id="to-consent">המשך</button><a class="btn btn-ghost" href="#/">חזרה</a></div></form>`;
  $('#intake').onsubmit = e => {
    e.preventDefault();
    const v = { name: $('#name').value.trim(), age: $('#age').value, sex: $('#sex').value, doctorName: $('#dname').value.trim(), doctorEmail: $('#demail').value.trim() };
    const err = [];
    if (!v.name) err.push('שם'); if (v.age === '' || +v.age < 0 || +v.age > 120) err.push('גיל'); if (!v.sex) err.push('מין');
    if (!v.doctorName) err.push('שם רופא/ה'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.doctorEmail)) err.push('אימייל רופא/ה תקין');
    if (err.length) { $('#err').textContent = 'נא למלא: ' + err.join(', '); return; }
    draft = { ...v, age: Number(v.age) }; location.hash = '#/consent';
  };
}

// ---------------- voice engine status + "test sound" ----------------
const soundUI = () => `<div class="voice-engine"><span class="ve-label" id="ve-label">בודק קולות…</span><button type="button" class="btn btn-sm" id="test-sound">🔊 בדיקת קול</button></div>
  <div class="voice-hint" id="voice-hint" hidden>🔇 לא שומעים? ${isIOS() ? 'באייפון: ודאו שמתג השקט שבצד המכשיר <b>כבוי</b> (לא כתום) והגבירו את עוצמת הקול.' : 'הגבירו את עוצמת הקול במכשיר ובדקו שהלשונית אינה מושתקת.'} אחר כך לחצו שוב על "בדיקת קול".</div>`;
function wireSoundUI(sayVia) {
  const sp = speaker(); const lab = $('#ve-label'), hint = $('#voice-hint');
  const upd = () => { const l = $('#ve-label'); if (l) l.textContent = '🔈 ' + sp.status().label; };
  upd(); sp.addEventListener('status', upd); sp.voicesReady.then(upd);
  sp.addEventListener('blocked', () => { const h = $('#voice-hint'); if (h) h.hidden = false; });
  $('#test-sound')?.addEventListener('click', () => {
    sp.unlock();                                         // inside the tap: primes speechSynthesis + the <audio> element
    const text = 'שלום, אני נועה. אם שומעים אותי, הקול עובד.';
    (sayVia ? sayVia(text) : sp.speak(text, { onFrame() {} })).then(upd);
    if (isIOS() && hint) setTimeout(() => { if (hint) hint.hidden = false; }, 2500);
    log?.('test-sound', { engine: sp.engine });
  });
}

function renderConsent() {
  main().innerHTML = `<form class="card" id="consent">
    <h2>הסכמה מדעת</h2>
    <p class="notice notice-red">🚑 <b>השירות אינו מיועד למצבי חירום.</b> אם יש כאב חזה חזק, קושי בנשימה, סימני שבץ, דימום חזק או מחשבות לפגוע בעצמך — <a href="tel:101"><b>חייגו 101</b></a> (במצוקה נפשית: <a href="tel:1201">ער"ן 1201</a>).</p>
    <label class="check"><input type="checkbox" name="c" id="c-video"><span><b>הקלטת וידאו:</b> השיחה כולה תוקלט בווידאו ובשמע לצורך עיון הרופא/ה. ייתכן שאתבקש/תתבקשי לצלם אזור בגוף. אפשר להסתיר את התצוגה העצמית; ההקלטה תימשך.</span></label>
    <label class="check"><input type="checkbox" name="c" id="c-data"><span><b>שימוש במידע:</b> התשובות, ההקלטות והמסמכים יישמרו מוצפנים במכשיר זה בלבד וישמשו להכנת סיכום לרופא/ה שציינתי ולהערכת הפיילוט (נתונים מצטברים). ניתן למחוק בכל עת.</span></label>
    <label class="check"><input type="checkbox" name="c" id="c-emerg"><span><b>לא לחירום:</b> הבנתי שזה אינו שירות חירום ושבמצב חירום יש לחייג 101.</span></label>
    <label class="check"><input type="checkbox" name="c" id="c-ai"><span><b>בינה מלאכותית, לא רופא/ה:</b> הבנתי שנועה היא עוזרת דיגיטלית (אווטאר ממוחשב), שאינה מאבחנת ואינה נותנת טיפול, ושהסיכום ייבדק על ידי רופא/ה.</span></label>
    <fieldset class="voice-consent"><legend>אופציונלי</legend>
    <label class="check"><input type="checkbox" id="c-voice" ${VoiceController.isSupported() ? '' : 'disabled'}><span><b>📞 שיחה קולית (כמו שיחת טלפון):</b> נועה מדברת ומקשיבה, ואין צורך להקליד. <b>שימו לב:</b> בדפדפן Chrome הדיבור שלך נשלח לשרתי Google לצורך זיהוי דיבור; ב-Safari נעשה העיבוד ע״י Apple, במכשיר או בשרתי Apple. ההקלטה של השיחה עצמה נשמרת רק במכשיר, מוצפנת.</span></label>
    ${VoiceController.isSupported() ? '' : '<p class="muted" id="voice-unsupported">זיהוי דיבור אינו נתמך בדפדפן הזה, ולכן השיחה תתנהל בהקלדה. נועה עדיין תדבר בקול.</p>'}
    ${soundUI()}</fieldset>
    <div class="row" style="margin-top:8px"><button class="btn btn-primary" type="submit" id="agree" disabled>אני מסכים/ה — התחלת שיחה</button><a class="btn btn-ghost" href="#/intake">חזרה</a></div></form>`;
  const boxes = $$('input[name=c]');
  boxes.forEach(b => b.onchange = () => { $('#agree').disabled = !boxes.every(x => x.checked); });
  wireSoundUI();
  $('#consent').onsubmit = e => {
    e.preventDefault();
    speaker().unlock();                                   // user gesture → unlock audio before the session starts speaking
    const voice = !!$('#c-voice')?.checked;
    draft.consent = { video: true, data: true, emergency: true, ai: true, voice, at: Date.now(), version: 'consent-v2' };
    draft.voiceMode = voice; location.hash = '#/session';
  };
}

// ---------------- AI session ----------------
async function startSession() {
  const settings = ctx.settings, rules = ctx.rules;
  const c = {
    id: uid('case-'), createdAt: Date.now(), status: 'in-progress',
    patient: { name: draft.name, age: draft.age, sex: draft.sex, doctorName: draft.doctorName, doctorEmail: draft.doctorEmail },
    consent: draft.consent, facts: {}, answered: [], labels: {}, questions: {}, transcript: [], alerts: [],
    media: { sessionVideo: null, clips: [] }, uploads: [], audit: [{ at: Date.now(), event: 'session-start' }]
  };
  S = { c, dialogue: ctx.makeDialogue(rules, draft), media: new MediaSession(), avatar: ctx.makeAvatar(settings), busy: false, preview: settings.selfPreview, speech: null,
        voiceMode: !!draft.voiceMode && VoiceController.isSupported(), voice: null };
  c.voiceMode = S.voiceMode;
  main().innerHTML = `
  <div class="session">
    <aside class="card side">
      <div id="avatar-host"></div>
      <div class="avatar-name">נועה</div><div class="avatar-sub">עוזרת טריאז' דיגיטלית · אווטאר ממוחשב</div>
      ${soundUI()}
      <div class="caption" id="caption" aria-live="polite"></div>
      <div class="selfview ${S.preview ? '' : 'hidden-preview'}" id="selfview"><span class="rec" id="rec" hidden>מקליט <span id="rec-t">0:00</span></span><video id="preview" muted playsinline autoplay></video></div>
      <div class="row" style="margin-top:8px;justify-content:space-between">
        <label class="toggle"><input type="checkbox" id="toggle-preview" ${S.preview ? 'checked' : ''}> הצג את התמונה שלי</label>
        <label class="toggle"><input type="checkbox" id="toggle-tts" ${settings.tts ? 'checked' : ''}> קול</label>
      </div>
      <p class="muted" id="media-status" style="font-size:13px"></p>
    </aside>
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2>שיחת טריאז'</h2><button class="btn btn-ghost btn-sm" id="end-early">סיום מוקדם</button></div>
      <div class="chat" id="chat" role="log" aria-live="polite"></div>
      ${S.voiceMode ? `<div class="voice-panel" id="voice-panel">
        <div class="voice-status" id="voice-status" aria-live="polite">מוכנים? לחצו כדי להתחיל לדבר עם נועה</div>
        <div class="interim" id="interim" aria-live="polite"></div>
        <div class="voice-bar">
          <button class="btn btn-primary voice-call-start" id="voice-start">📞 התחלת שיחה קולית</button>
          <div class="mic-level" id="mic-level" title="עוצמת מיקרופון" aria-hidden="true"><i></i></div>
          <button class="btn" id="voice-bargein" hidden>✋ להפסיק ולדבר</button>
          <button class="btn" id="voice-repeat" hidden>🔁 חזרה על השאלה</button>
          <button class="btn" id="voice-pause" hidden aria-pressed="false">⏸️ השהיה</button>
        </div></div>
      <details class="type-fallback" id="type-fallback"><summary>מעדיפ/ה להקליד או לבחור תשובה?</summary><div class="answer" id="answer"></div></details>` : '<div class="answer" id="answer"></div>'}
    </section>
  </div>`;
  S.avatar.mount($('#avatar-host'));
  wireSoundUI(t => S.avatar.speak(t));
  $('#toggle-preview').onchange = e => { S.preview = e.target.checked; $('#selfview').classList.toggle('hidden-preview', !S.preview); log('preview-' + (S.preview ? 'on' : 'off')); };
  $('#toggle-tts').onchange = e => { S.avatar.ttsEnabled = e.target.checked; if (!e.target.checked) S.avatar.stop(); };
  $('#end-early').onclick = async () => { if (await confirmDialog('לסיים את השיחה עכשיו? הסיכום יסומן כחלקי.', 'סיום')) finish('ended-early'); };

  const ok = await S.media.start();
  if (ok) {
    $('#preview').srcObject = S.media.stream; $('#rec').hidden = false;
    S.recTimer = setInterval(() => { const el = $('#rec-t'); if (el) el.textContent = fmtDur((Date.now() - S.media.startedAt) / 1000); }, 1000);
    $('#media-status').textContent = 'השיחה מוקלטת ונשמרת מוצפנת במכשיר.';
  } else {
    c.media.sessionVideoError = S.media.error; $('#media-status').textContent = '⚠️ ' + S.media.error + ' — השיחה תימשך ללא וידאו.';
    $('#selfview').hidden = true;
  }
  await ctx.storage.saveCase(c);
  const first = await S.dialogue.start();
  if (S.voiceMode) {
    renderAnswer(first.question);
    addMsg('ai', first.say); $('#caption').textContent = first.say;
    await new Promise(res => { $('#voice-start').onclick = () => { speaker().unlock(); startVoice(); res(); }; });
    if (!S) return;
    S.turnTok = (S.turnTok || 0) + 1; return speakThenListen(first, S.turnTok);
  }
  showTurn(first);
}

// ---------------- voice (phone-call) mode ----------------
function startVoice() {
  const v = S.voice = new VoiceController({ stream: S.media.stream, silenceMs: ctx.settings.voiceSilenceMs || 1500, bargeIn: ctx.settings.voiceBargeIn !== false });
  v.start(); log('voice-start');
  $('#voice-start').hidden = true; ['#voice-bargein', '#voice-repeat', '#voice-pause'].forEach(id => { $(id).hidden = false; });
  const status = { listening: '🎙️ מקשיבה… אפשר לדבר', hearing: '🎙️ שומעת…', thinking: '💭 רגע…', speaking: '🗣️ נועה מדברת', paused: '⏸️ מושהה', idle: '', error: '⚠️ אין גישה למיקרופון לזיהוי דיבור, אפשר להקליד' };
  v.addEventListener('state', e => {
    const st = e.detail.state; const el = $('#voice-status'); if (el) el.textContent = status[st] ?? '';
    if (st === 'listening' && S?.avatar.state !== 'alert') S.avatar.setState('listening');
    if (st === 'error') { const d = $('#type-fallback'); if (d) d.open = true; }
  });
  v.addEventListener('interim', e => { const el = $('#interim'); if (el) el.textContent = e.detail.text; const t = $('#typed'); if (t) t.value = e.detail.text; });
  v.addEventListener('level', e => { const i = $('#mic-level i'); if (i) i.style.width = `${Math.round(e.detail.level * 100)}%`; });
  v.addEventListener('nospeech', () => { const el = $('#voice-status'); if (el) el.textContent = '🎙️ לא שמעתי. אפשר לדבר, או ללחוץ "חזרה על השאלה"'; });
  v.addEventListener('bargein', () => { if (!S) return; log('voice-barge-in'); S.turnTok++; S.avatar.stop(); v.listen(); });
  v.addEventListener('final', e => { const el = $('#interim'); if (el) el.textContent = ''; voiceAnswer(e.detail.text); });
  $('#voice-bargein').onclick = () => v.bargeIn();
  $('#voice-repeat').onclick = () => { if (!S?.lastTurn) return; v.stopListening(); S.turnTok++; speakThenListen({ ...S.lastTurn, say: S.lastTurn.question?.say || S.lastTurn.question?.text || S.lastTurn.say }, S.turnTok); };
  $('#voice-pause').onclick = e => {
    const b = e.currentTarget, paused = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(paused)); b.textContent = paused ? '▶️ המשך' : '⏸️ השהיה';
    if (paused) { S.turnTok++; S.avatar.stop(); v.pause(); log('voice-pause'); }
    else { v.resume(); v.listen(); log('voice-resume'); }
  };
}
function speakThenListen(turn, tok) {
  S.lastTurn = turn;
  S.voice?.setSpeaking(true);
  return S.avatar.speak(turn.say).then(() => {
    if (!S || S.turnTok !== tok) return;
    S.voice?.setSpeaking(false);
    if (turn.done || S.avatar.state === 'alert' || document.getElementById('emergency')) return;
    S.avatar.setState('listening');
    if (S.voice && !S.voice.paused && !S.recordingClip) S.voice.listen();
  });
}
/** Route a spoken answer to the current question (film/upload need special handling). */
function voiceAnswer(text) {
  if (!S || S.busy) return;
  const q = S.q; const t = text.trim();
  const yes = /^(כן|בטח|אוקיי|אוקי|בסדר|יאללה|אפשר|מוכן|מוכנה|נכון)/.test(t), no = /(^לא|אין|לא יכול|לא יכולה|לא רוצה|סיימתי|המשך|דלג)/.test(t);
  if (q?.type === 'film') {
    if (no) { const reason = /(לא נוח|מתבייש|מתביישת)/.test(t) ? 'לא נוח לי לצלם את האזור' : /(מצלמה)/.test(t) ? 'המצלמה לא עובדת / אין מצלמה' : 'האזור לא נגיש לצילום'; return $$('#cant-reasons .chip').find(b => b.dataset.r === reason)?.click() || $('#film-cant')?.click(); }
    if (yes && $('#film-start')) { S.recordingClip = true; $('#film-start').click(); return S.avatar.speak('מצלמת. כשתסיימ' + (S.c.patient.sex === 'female' ? 'י' : '') + ', אפשר לומר "סיימתי" או ללחוץ עצירה.').then(() => S?.voice?.listen()); }
    return speakThenListen({ say: 'אפשר לומר "כן" כדי להתחיל לצלם, או "לא יכול לצלם".', question: q }, ++S.turnTok);
  }
  if (S.recordingClip) { if (/(סיימתי|עצור|זהו|די)/.test(t)) $('#film-stop')?.click(); else S.voice?.listen(); return; }
  if (q?.type === 'upload') {
    if (no || /סיימתי/.test(t)) return $('#up-done')?.click();
    return speakThenListen({ say: 'כדי לבחור קובץ צריך ללחוץ על הכפתור "העלאת קובץ" במסך. כשתסיימ' + (S.c.patient.sex === 'female' ? 'י' : '') + ', אמרו "סיימתי".', question: q }, ++S.turnTok);
  }
  if (q?.type === 'multi' && no) return submit({ value: [], text: t }, t);
  submit({ text: t }, t);
}

function log(event, extra = {}) { S?.c.audit.push({ at: Date.now(), event, ...extra }); }
function addMsg(role, text) {
  S.c.transcript.push({ role, text, at: Date.now() });
  const el = document.createElement('div'); el.className = `msg ${role}`; el.textContent = text;
  $('#chat').appendChild(el); el.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
function syncFromDialogue() {
  const st = S.dialogue.getState();
  Object.assign(S.c, { facts: { ...st.facts }, answered: [...st.answered], labels: { ...st.labels }, questions: { ...st.questions }, requiredQuestions: st.required });
}

function showTurn(turn) {
  addMsg('ai', turn.say);
  $('#caption').textContent = turn.say;
  const tok = S.turnTok = (S.turnTok || 0) + 1;
  if (turn.initiated) log('avatar-request', { kind: turn.initiated, qid: turn.question?.id });
  if (S.voice) speakThenListen(turn, tok);
  else S.avatar.speak(turn.say).then(() => { if (S && S.turnTok === tok && !turn.done && S.avatar.state !== 'alert') S.avatar.setState('listening'); });
  if (turn.done) { $('#answer').innerHTML = '<p class="muted">מכינה הערכה ראשונית וסיכום…</p>'; return finish('completed'); }
  renderAnswer(turn.question);
}

function renderAnswer(q) {
  const A = $('#answer'); S.q = q;
  A.dataset.qid = q.id; A.dataset.qtype = q.type; A.dataset.turn = String((+A.dataset.turn || 0) + 1);
  S.speechOK = !S.voiceMode && ctx.settings.voiceInput && SpeechInput.isSupported();
  const typed = (ph = 'הקלד/י תשובה…') => `<div class="typed"><input type="text" id="typed" placeholder="${ph}" aria-label="תשובה בכתב">${S.speechOK ? '<button class="btn mic" id="mic" aria-pressed="false" title="הקלטה קולית">🎤</button>' : ''}<button class="btn btn-primary" id="send">שליחה</button></div>`;
  let html = '';
  if (q.type === 'complaint') html = `${typed('לדוגמה: כואב לי בחזה מאז הבוקר')}<p class="muted" style="margin:8px 0 4px">או בחר/י נושא:</p><div class="chips">${q.options.map(o => `<button class="chip" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('')}</div>`;
  else if (q.type === 'yesno') html = `<div class="chips"><button class="chip" data-v="yes" id="ans-yes">כן</button><button class="chip" data-v="no" id="ans-no">לא</button></div>${typed()}`;
  else if (q.type === 'choice') html = `<div class="chips">${q.options.map(o => `<button class="chip" data-v="${esc(o.v)}">${esc(o.label)}</button>`).join('')}</div>`;
  else if (q.type === 'multi') html = `<div class="chips" role="group">${q.options.map(o => `<button class="chip" data-m="${esc(o.v)}" aria-pressed="false">${esc(o.label)}</button>`).join('')}</div><button class="btn btn-primary" id="multi-done">אישור</button>`;
  else if (q.type === 'scale') html = `<div class="scale" role="group" aria-label="סולם 0 עד 10">${Array.from({ length: 11 }, (_, i) => `<button data-s="${i}" aria-label="${i}">${i}</button>`).join('')}</div>`;
  else if (q.type === 'text') html = `${typed(q.placeholder || (q.optional ? 'אפשר לדלג' : 'הקלד/י…'))}${q.optional ? '<button class="btn btn-ghost" id="skip">אין, אפשר לסיים</button>' : ''}`;
  else if (q.type === 'film') return renderFilm(q);
  else if (q.type === 'upload') return renderUpload(q);
  A.innerHTML = html;
  if (S.speechOK) html && A.insertAdjacentHTML('beforeend', '<p class="muted" style="font-size:12px">🎤 זיהוי דיבור בדפדפן עשוי לשלוח שמע לשרתי ספק הדפדפן.</p>');
  $$('.chip[data-v]', A).forEach(b => b.onclick = () => {
    const v = b.dataset.v; const val = q.type === 'yesno' ? v === 'yes' : v;
    submit({ value: val }, b.textContent);
  });
  $$('.chip[data-m]', A).forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    if (b.dataset.m === 'none' && on) $$('.chip[data-m]', A).forEach(x => x.setAttribute('aria-pressed', 'false'));
    else if (on) $('.chip[data-m="none"]', A)?.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-pressed', on);
  });
  $('#multi-done', A)?.addEventListener('click', () => {
    const sel = $$('.chip[data-m][aria-pressed=true]', A);
    submit({ value: sel.map(x => x.dataset.m) }, sel.map(x => x.textContent).join(', ') || 'אף אחד');
  });
  $$('[data-s]', A).forEach(b => b.onclick = () => submit({ value: Number(b.dataset.s) }, `${b.dataset.s}/10`));
  const send = () => { const t = $('#typed').value.trim(); if (!t && !q.optional) return $('#typed').focus(); submit({ text: t || 'אין' }, t || 'אין'); };
  $('#send', A)?.addEventListener('click', send);
  $('#typed', A)?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#skip', A)?.addEventListener('click', () => submit({ text: '' }, 'אין'));
  $('#mic', A)?.addEventListener('click', async e => {
    const btn = e.currentTarget; S.speech = new SpeechInput(); btn.setAttribute('aria-pressed', 'true'); S.avatar.setState('listening');
    try { const t = await S.speech.listen({ onInterim: x => { $('#typed').value = x; } }); if (t) $('#typed').value = t; }
    catch (err) { toast('זיהוי דיבור נכשל: ' + err.message, 'error'); }
    btn.setAttribute('aria-pressed', 'false'); S.avatar.setState('listening');
  });
  (A.querySelector('#typed') || A.querySelector('button'))?.focus({ preventScroll: true });
}

async function submit(input, shownText) {
  if (S.busy) return; S.busy = true; S.voice?.stopListening();
  $$('#answer button, #answer input').forEach(x => x.disabled = true);
  addMsg('patient', shownText);
  const res = await S.dialogue.answer(input);
  syncFromDialogue();
  await ctx.storage.saveCase(S.c);
  S.busy = false;
  if (res.newAlerts.length) return triggerAlert(res.newAlerts, res.turn);
  showTurn(res.turn);
}

// ---------------- urgent alert ----------------
async function triggerAlert(alerts, resumeTurn) {
  const c = S.c;
  for (const a of alerts) { c.alerts.push({ ...a, at: Date.now(), overridden: false }); Notifier.notifyAlert(c.id, a); }
  log('alert', { ids: alerts.map(a => a.id) });
  c.summary = await buildSummary(ctx.rules, c, ctx.knowledge);
  c.routing = route(c, ctx.settings);
  await ctx.storage.saveCase(c);
  const mental = alerts.some(a => a.action === '1201');
  const msg = mental
    ? 'אני מודאגת לשלומך. חשוב לדבר עם מישהו עכשיו. אפשר להתקשר לער"ן בטלפון 1201, ואם יש סכנה מיידית — לחייג 101.'
    : 'זה עלול להיות מצב חירום. יש לחייג עכשיו 101 למגן דוד אדום. אל תנהג/י בעצמך.';
  const ov = document.createElement('div');
  ov.className = 'emergency'; ov.setAttribute('role', 'alertdialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'em-title'); ov.id = 'emergency';
  ov.innerHTML = `<img src="assets/doctor.jpg" alt="">
    <h1 id="em-title">${mental ? 'אנחנו כאן בשבילך — פנה/י לעזרה עכשיו' : '🚨 חייגו 101 עכשיו'}</h1>
    <div class="reason">${alerts.map(a => esc(a.label)).join('<br>')}</div>
    ${mental ? '<a class="big-call" href="tel:1201" id="call-1201">📞 ער"ן 1201</a><a class="eran" href="tel:101">סכנה מיידית? 101</a>' : '<a class="big-call" href="tel:101" id="call-101">📞 חייג/י 101</a><a class="eran" href="tel:1201">מצוקה נפשית: ער"ן 1201</a>'}
    <p>${esc(msg)}</p>
    <p style="font-size:14px">ההתרעה נרשמה ונשלחה בעדיפות עליונה לדשבורד הצוות.</p>
    <div class="row" style="justify-content:center"><button class="btn" id="em-finish">פניתי לעזרה — סיום השיחה</button><button class="btn" id="em-override">סימנתי בטעות — חזרה לשיחה</button></div>`;
  document.body.appendChild(ov);
  ov.querySelector('.big-call').focus();
  S.avatar.setState('alert');
  $('#caption').textContent = msg;
  S.avatar.speak(msg).then(() => S?.avatar.setState('alert'));
  $('#em-finish').onclick = () => { ov.remove(); finish('emergency-closed'); };
  $('#em-override').onclick = async () => {
    if (!(await confirmDialog('האם את/ה בטוח/ה שזה לא מצב חירום? אם יש ספק — חייג/י 101.', 'כן, להמשיך בשיחה'))) return;
    c.alerts.forEach(a => { if (alerts.some(x => x.id === a.id)) a.overridden = true; });
    log('alert-override'); ov.remove(); S.avatar.setState('listening');
    await ctx.storage.saveCase(c);
    showTurn(resumeTurn);
  };
}

// ---------------- filming ----------------
function renderFilm(q) {
  const A = $('#answer'); const max = ctx.settings.clipSeconds || 12;
  const cat = ctx.rules.categories[S.c.facts.category];
  const label = cat?.label || 'אזור';
  const camOK = !!S.media.stream;
  A.innerHTML = `<div class="film-box">
    <p><b>📹 בקשת צילום:</b> ${esc(q.text)}</p>
    ${camOK ? `<p class="muted" style="font-size:14px">עד ${max} שניות. במהלך הצילום התצוגה תוצג כדי שתוכל/י לכוון.</p>` : `<p class="failed">המצלמה אינה זמינה: ${esc(S.c.media.sessionVideoError || '')}</p>`}
    <div class="progress" hidden id="clip-prog"><i></i></div>
    <div class="row">
      ${camOK ? `<button class="btn btn-primary" id="film-start">התחלת צילום</button><button class="btn" id="film-stop" hidden>עצירה ושליחה</button>` : ''}
      <button class="btn" id="film-cant">אני לא יכול/ה לצלם את זה</button>
    </div>
    <div id="cant-reasons" hidden><p>מה הסיבה?</p><div class="chips">
      ${['המצלמה לא עובדת / אין מצלמה', 'האזור לא נגיש לצילום', 'לא נוח לי לצלם את האזור', 'אין תאורה / איכות לא מספקת', 'אחר'].map(r => `<button class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div></div>
  </div>`;
  const fail = async (reason) => {
    const clip = { id: uid('clip-'), label, prompt: q.text, status: 'failed', reason, at: Date.now() };
    S.c.media.clips.push(clip); log('filming-failed', { reason });
    addMsg('sys', `העברת מידע נכשלה: ${reason}`);
    await submit({ value: 'failed', reason }, `לא צולם — ${reason}`);
  };
  $('#film-cant').onclick = () => { $('#cant-reasons').hidden = false; $('#cant-reasons .chip').focus(); };
  $$('#cant-reasons .chip').forEach(b => b.onclick = () => fail(b.dataset.r));
  $('#film-start')?.addEventListener('click', () => {
    const wasHidden = !S.preview; $('#selfview').classList.remove('hidden-preview');
    $('#film-start').hidden = true; $('#film-stop').hidden = false; $('#clip-prog').hidden = false; $('#film-cant').disabled = true;
    let ctl;
    try { ctl = S.media.recordClip(max, s => { const i = $('#clip-prog i'); if (i) i.style.width = `${Math.min(100, s / max * 100)}%`; }); }
    catch (e) { return fail('שגיאת הקלטה: ' + e.message); }
    $('#film-stop').onclick = () => ctl.stop();
    ctl.done.finally(() => { if (S) S.recordingClip = false; });
    ctl.done.then(async ({ blob, duration }) => {
      if (wasHidden) $('#selfview').classList.add('hidden-preview');
      const clip = { id: uid('clip-'), label, prompt: q.text, status: 'ok', blobId: uid('b-'), duration, mime: blob.type, size: blob.size, at: Date.now() };
      await ctx.storage.saveBlob(S.c.id, clip.blobId, blob, { kind: 'clip' });
      S.c.media.clips.push(clip); log('filming-ok');
      await submit({ value: 'ok' }, `📹 צילום נשלח (${fmtDur(duration)})`);
    }).catch(e => { if (wasHidden) $('#selfview').classList.add('hidden-preview'); fail('ההקלטה נכשלה: ' + (e.message || e)); });
  });
}

// ---------------- lab / imaging uploads ----------------
function renderUpload(q) {
  const A = $('#answer');
  A.innerHTML = `<div class="upload-box">
    <p><b>📄 העלאת תוצאות:</b> ${esc(q.text)}</p>
    <ul id="up-list"></ul>
    <div class="progress" hidden id="up-prog"><i style="width:100%;opacity:.5"></i></div><p class="muted" id="up-status" aria-live="polite"></p>
    <input type="file" id="up-input" accept="application/pdf,image/*" class="visually-hidden" aria-label="בחירת קובץ">
    <div class="row"><button class="btn btn-primary" id="up-add">העלאת קובץ (PDF / תמונה)</button><button class="btn" id="up-done">סיימתי — המשך</button></div></div>`;
  const list = $('#up-list');
  const refresh = () => { list.innerHTML = S.c.uploads.map(u => `<li>${esc(u.name)} — ${u.parsed ? `זוהו ${u.parsed.results.length} בדיקות${u.parsed.imaging ? ' + דו"ח הדמיה' : ''} (ביטחון ${Math.round(u.parsed.confidence * 100)}%)` : u.error ? 'עיבוד נכשל — המקור יצורף לרופא/ה' : 'בעיבוד…'}</li>`).join(''); };
  refresh();
  const input = $('#up-input');
  $('#up-add').onclick = () => {
    const m = modal(`<h3>הסכמה להעלאת מסמך</h3>
      <p>אני מסכים/ה להעלות את הקובץ שאבחר. הקובץ <b>יעובד במכשיר זה בלבד</b> (ללא שליחה לשרת), <b>יוצפן</b> וישמר, ויצורף לסיכום עבור ד"ר ${esc(S.c.patient.doctorName)}.</p>
      <p class="muted">צמצום מידע: אם אפשר, העלה/י רק את העמודים הרלוונטיים והסתר/י פרטים מזהים שאינם נחוצים (כמו מספר ת.ז.).</p>
      <div class="row"><button class="btn btn-primary" id="up-consent">מסכים/ה — בחירת קובץ</button><button class="btn" id="up-cancel">ביטול</button></div>`);
    $('#up-consent').onclick = () => { S.pendingConsent = Date.now(); log('upload-consent'); m.close(); input.click(); };
    $('#up-cancel').onclick = () => { log('upload-consent-declined'); m.close(); };
  };
  input.onchange = async () => {
    const file = input.files[0]; input.value = '';
    if (!file || !S.pendingConsent) return;
    if (file.size > 15 * 1024 * 1024) return toast('הקובץ גדול מדי (מקסימום 15MB)', 'error');
    const u = { id: uid('up-'), name: file.name, type: file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/png'), size: file.size, consentAt: S.pendingConsent, blobId: uid('b-') };
    S.pendingConsent = null;
    S.c.uploads.push(u); refresh();
    await ctx.storage.saveCase(S.c);
    await ctx.storage.saveBlob(S.c.id, u.blobId, file, { kind: 'upload' });
    $('#up-prog').hidden = false; $('#up-add').disabled = $('#up-done').disabled = true;
    try {
      u.parsed = await parseFile(file, { category: S.c.facts.category, sex: S.c.patient.sex, onProgress: t => { const el = $('#up-status'); if (el) el.textContent = t; } });
      addMsg('sys', `מסמך "${file.name}" פוענח במכשיר: ${u.parsed.results.length} ערכים${u.parsed.imaging ? ', דו"ח הדמיה' : ''}.`);
    } catch (e) { u.error = e.message || String(e); addMsg('sys', `לא הצלחתי לפענח את "${file.name}" — המסמך המקורי יצורף לרופא/ה.`); }
    $('#up-prog').hidden = true; $('#up-status').textContent = ''; $('#up-add').disabled = $('#up-done').disabled = false;
    await ctx.storage.saveCase(S.c); refresh();
  };
  $('#up-done').onclick = () => submit({ value: S.c.uploads.length ? 'uploaded' : 'none', count: S.c.uploads.length }, S.c.uploads.length ? `צירפתי ${S.c.uploads.length} מסמכים` : 'לא צירפתי מסמכים');
}

// ---------------- finish ----------------
async function finish(status, nav = true) {
  if (!S || S.finishing) return; S.finishing = true;
  const c = S.c; clearInterval(S.recTimer);
  syncFromDialogue();
  try {
    const v = await S.media.stop();
    if (v?.blob?.size) { const blobId = uid('b-'); await ctx.storage.saveBlob(c.id, blobId, v.blob, { kind: 'session' }); c.media.sessionVideo = { blobId, duration: v.duration, mime: v.blob.type, size: v.blob.size }; }
  } catch (e) { c.media.sessionVideoError = 'שמירת הווידאו נכשלה: ' + e.message; }
  c.status = status; c.endedAt = Date.now(); log('session-end', { status });
  S.voice?.destroy();
  if (status === 'completed' || status === 'ended-early') {
    const st = S.dialogue.getState?.() || {};
    c.patient.preferredName = st.name || null;
    if (c.facts.category) {
      c.assessment = buildAssessment(ctx.rules, c.facts, c.alerts.filter(a => !a.overridden), st.name || '');
      c.transcript.push({ role: 'ai', text: c.assessment.text, at: Date.now(), kind: 'assessment' });
    }
  }
  c.summary = await buildSummary(ctx.rules, c, ctx.knowledge);
  c.routing = route(c, ctx.settings);
  await ctx.storage.saveCase(c);
  Notifier.notifyCase(c.id);
  S.avatar.stop(); S.avatar.destroy?.(); S = null; draft = null;
  if (nav) location.hash = `#/done/${c.id}`;
}
async function endSessionSilently() {
  // Navigating away mid-session: keep what we have, mark as ended early.
  if (S && !S.finishing) { const s = S; document.getElementById('emergency')?.remove(); await finish('ended-early', false).catch(() => {}); if (S === s) S = null; }
}

async function renderDone(id) {
  const c = await ctx.storage.getCase(id);
  if (!c) { main().innerHTML = '<div class="card">השיחה לא נמצאה (ייתכן שנמחקה).</div>'; return; }
  main().innerHTML = `<div class="card">
    <h2>✅ תודה, ${esc(c.patient.preferredName || c.patient.name)}</h2>
    <p>הסיכום הועבר ל<b>${c.routing.queue === 'doctor' ? 'תור הרופא/ה המטפל/ת' : 'תור טריאז\' משני'}</b>. ${esc(c.routing.reason)}</p>
    ${c.summary.urgency.rank <= 1 ? '<p class="notice notice-red">🚨 על סמך התשובות — <a href="tel:101"><b>חייג/י 101</b></a> ואל תחכה/י לתשובת הרופא/ה.</p>' : c.summary.urgency.rank === 2 ? '<p class="notice">מומלץ לפנות לבדיקה עוד היום. אם המצב מחמיר — 101.</p>' : '<p class="muted">אם המצב מחמיר — פנה/י לרופא/ה או חייג/י 101.</p>'}
    <p class="muted" style="font-size:14px">בפרוטוטייפ השליחה לרופא/ה מדומה: הסיכום נשמר מוצפן במכשיר ומופיע בדשבורד הצוות. אין שליחת אימייל.</p>
    <div class="row"><button class="btn" id="dl">הורדת הסיכום (טקסט)</button><button class="btn btn-danger" id="del">מחק את השיחה הזו</button><a class="btn btn-ghost" href="#/">דף הבית</a></div></div>
    ${c.assessment ? `<div class="card assessment-card" id="assessment">
      <div class="done-avatar-row"><div id="done-avatar"></div></div>
      <h3>🩺 הערכה ראשונית של נועה</h3>
      <p class="ai-disclaimer">⚠️ ${esc(c.assessment.disclaimer)}</p>
      <p><b>אבחנה משוערת:</b> <span id="as-dx">${esc(c.assessment.dx.length ? c.assessment.dx.map((d, i) => i ? d.name : `${d.name}`).join(' · ') : 'לא ניתן לקבוע על סמך המידע שנאסף')}</span></p>
      <p><b>טיפול משוער:</b> <span id="as-tx">${esc([...c.assessment.treatment.map(t => t.text), c.assessment.advice].join('; '))}</span></p>
      <p class="muted" style="font-size:13px">מבוסס על כללי הטריאז' (${esc(c.assessment.dx.map(d => d.id).join(', '))}); ייבדק על ידי רופא/ה.</p>
      <button class="btn btn-sm" id="as-replay">🔊 השמעה חוזרת</button> ${soundUI()}</div>` : ''}
    <div class="card" id="summary-card">${renderSummary(ctx.rules, c)}</div>`;
  if (c.assessment) {
    doneAvatar = ctx.makeAvatar(ctx.settings); doneAvatar.mount($('#done-avatar'));
    const say = () => doneAvatar?.speak(c.assessment.say);
    wireSoundUI(t => doneAvatar.speak(t));
    $('#as-replay').onclick = () => { speaker().unlock(); say(); };
    if (c.status === 'completed' && Date.now() - c.endedAt < 60000) say();
  }
  $('#dl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([summaryText(ctx.rules, c)], { type: 'text/plain;charset=utf-8' })); a.download = `triage-summary-${c.id.slice(-6)}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  $('#del').onclick = async () => { if (await confirmDialog('למחוק לצמיתות את השיחה, ההקלטות והמסמכים שלה?', 'מחק', true)) { await ctx.storage.deleteCase(c.id); toast('השיחה נמחקה', 'ok'); location.hash = '#/'; } };
}

boot().catch(e => { console.error(e); main().innerHTML = `<div class="card failed">שגיאה בטעינה: ${esc(e.message)}</div>`; });
