// Client-side lab / imaging document parsing. Nothing leaves the device.
//  * PDF  → pdf.js text layer (vendor/pdfjs); scanned PDFs fall back to rendering + OCR.
//  * Image → Tesseract.js OCR heb+eng (vendor/tesseract, language data vendored).
// Extracts test name, value, unit, reference range, H/L flag, date; interprets against rules/lab-ranges.json;
// rates relevance to the current complaint incl. recency; extracts imaging modality/date/impression.
import { loadLabRanges } from './util.js';

const abs = p => new URL(p, document.baseURI).href;
let tesseractLoaded = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoaded) tesseractLoaded = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = abs('vendor/tesseract/tesseract.min.js');
    s.onload = res; s.onerror = () => rej(new Error('Failed to load local OCR engine')); document.head.appendChild(s);
  });
  return tesseractLoaded;
}
// Upscale (small screenshots OCR poorly), grayscale and stretch contrast before OCR.
async function preprocess(image) {
  let src = image;
  if (!(image instanceof HTMLCanvasElement)) src = await createImageBitmap(image);
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(3, Math.max(1, 2000 / w0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * scale); c.height = Math.round(h0 * scale);
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.max(0, Math.min(255, (y - 128) * 1.4 + 128));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}
async function ocr(image, onProgress) {
  await loadTesseract();
  image = await preprocess(image);
  const worker = await window.Tesseract.createWorker('heb+eng', 1, {
    workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract/'), langPath: abs('vendor/tesseract/lang'),
    workerBlobURL: false, gzip: true, cacheMethod: 'none',
    logger: m => m.status === 'recognizing text' && onProgress?.(`OCR ${Math.round(m.progress * 100)}%`)
  });
  try { const { data } = await worker.recognize(image); return { text: data.text, confidence: data.confidence }; }
  finally { await worker.terminate(); }
}
async function pdfText(buf, onProgress) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = abs('vendor/pdfjs/pdf.worker.min.mjs');
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, disableFontFace: true }).promise;
  let text = '';
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
    onProgress?.(`PDF עמוד ${p}/${doc.numPages}`);
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines = new Map();
    for (const it of tc.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: it.transform[4], s: it.str });
    }
    [...lines.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => { text += items.sort((a, b) => a.x - b.x).map(i => i.s).join(' ') + '\n'; });
  }
  return { text, doc, pdfjs };
}
async function ocrPdfPages(doc, onProgress) {
  let text = '', conf = 0, n = Math.min(doc.numPages, 3);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p); const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const r = await ocr(c, onProgress); text += r.text + '\n'; conf += r.confidence;
  }
  return { text, confidence: conf / n };
}

// ---------- extraction ----------
const UNIT_RE = /(10\^?3\/u?L|10\^?9\/L|K\/uL|x10\^?9\/L|g\/dL|g\/L|mg\/dL|mmol\/L|mIU\/L|µIU\/mL|uIU\/mL|IU\/L|U\/L|ng\/dL|ng\/mL|pg\/mL|ng\/L|mg\/L(?:\s*FEU)?|mm\/hr?|µg\/L|ug\/L|%)/i;
const RANGE_RE = /(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)/;
const num = s => Number(String(s).replace(',', '.'));
const isHeb = ch => /[\u0590-\u05FF]/.test(ch || '');
function aliasRegex(a) {
  const e = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim();
  const flags = a.trim().length <= 3 ? 'g' : 'gi';
  return new RegExp(`(^|[^A-Za-z0-9\\u0590-\\u05FF])(${e})(?=$|[^A-Za-z0-9\\u0590-\\u05FF])`, flags);
}
function findDates(s) {
  const out = []; let m;
  const push = (d, mo, y, idx) => { y = y < 100 ? 2000 + y : y; const dt = new Date(y, mo - 1, d); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= new Date().getFullYear() + 1) out.push({ date: dt, idx }); };
  const r1 = /(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/g; while ((m = r1.exec(s))) push(+m[1], +m[2], +m[3], m.index);
  const r2 = /(\d{4})-(\d{2})-(\d{2})/g; while ((m = r2.exec(s))) push(+m[3], +m[2], +m[1], m.index);
  const r3 = /(?<![\d\/.])(\d{1,2})\/(\d{1,2})\/(\d{2})(?![\d\/])/g; while ((m = r3.exec(s))) push(+m[1], +m[2], +m[3], m.index);
  return out.sort((a, b) => a.idx - b.idx);
}
const iso = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

export function extract(text, table) {
  text = text.replace(/[\u200e\u200f\u202a-\u202e]/g, '');
  // Normalize PDF/OCR spacing artefacts: "mg / L" → "mg/L", "10 ^ 3/ uL" → "10^3/uL", "D - Dimer" → "D-Dimer".
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').replace(/\s*([\/^])\s*/g, '$1').replace(/([A-Za-z])\s+-\s+([A-Za-z])/g, '$1-$2').trim()).filter(Boolean);
  const aliases = [];
  for (const t of table.tests) for (const n of t.names) aliases.push({ test: t, name: n, re: aliasRegex(n) });
  let docDate = null;
  for (const l of lines) if (/date|תאריך|collected|נלקח|reported|הופק/i.test(l)) { const d = findDates(l)[0]; if (d) { docDate = d.date; break; } }
  if (!docDate) docDate = findDates(text)[0]?.date || null;

  const results = [], unrecognized = [];
  for (const line of lines) {
    let best = null;
    for (const a of aliases) {
      a.re.lastIndex = 0; const m = a.re.exec(line);
      if (m && (!best || a.name.length > best.name.length)) best = { ...a, start: m.index + m[1].length, end: m.index + m[1].length + m[2].length };
    }
    if (!best) { if (/impression|exam date|report|התרשמות/i.test(line)) continue; if (RANGE_RE.test(line) && /[A-Za-z\u0590-\u05FF]{2,}/.test(line) && /\d/.test(line) && !findDates(line).length) unrecognized.push(line); continue; }
    const t = best.test;
    let rest = line.slice(best.end).replace(/^[\s:=\-–|]+/, '');
    const lineDate = findDates(line)[0]?.date || null;
    if (lineDate) rest = rest.replace(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})|\d{4}-\d{2}-\d{2}/g, ' ');
    const r = { testId: t.id, name: best.name, panel: t.panel, raw: line, date: iso(lineDate || docDate), dateSource: lineDate ? 'line' : docDate ? 'document' : null };
    if (t.qualitative) {
      const q = rest.match(/positive|negative|trace|חיובי|שלילי|\+{1,3}|neg|pos/i);
      if (!q) { unrecognized.push(line); continue; }
      r.qualitative = q[0]; r.value = null;
      results.push(r); continue;
    }
    const vm = rest.match(/([<>]?)\s*(\d+(?:[.,]\d+)?)/);
    if (!vm) { unrecognized.push(line); continue; }
    r.value = num(vm[2]); r.comparator = vm[1] || null;
    let after = rest.slice(vm.index + vm[0].length);
    const um = after.match(UNIT_RE); if (um) { r.unit = um[1]; after = after.replace(um[0], ' '); }
    const rm = after.match(RANGE_RE);
    if (rm) { r.refRange = { low: num(rm[1]), high: num(rm[2]) }; after = after.replace(rm[0], ' '); }
    else { const lt = after.match(/<\s*(\d+(?:[.,]\d+)?)/); const gt = after.match(/>\s*(\d+(?:[.,]\d+)?)/); if (lt) { r.refRange = { low: 0, high: num(lt[1]) }; after = after.replace(lt[0], ' '); } else if (gt) { r.refRange = { low: num(gt[1]), high: Infinity }; after = after.replace(gt[0], ' '); } }
    const fm = after.match(/(?:^|\s)(HH|LL|H|L|High|Low|גבוה|נמוך)(?=\s|$)|[*↑↓]/i);
    if (fm) { const f = (fm[1] || fm[0]).toLowerCase(); r.flag = /^(h|hh|high|גבוה|↑)$/.test(f) ? 'H' : /^(l|ll|low|נמוך|↓)$/.test(f) ? 'L' : '*'; }
    results.push(r);
  }
  return { results, unrecognized, docDate: iso(docDate) };
}

export function extractImaging(text, table) {
  const found = table.imagingModalities.filter(m => m.names.some(n => (n.trim().length <= 3 ? new RegExp(`(^|[^A-Za-z])${n.trim()}([^A-Za-z]|$)`) : new RegExp(n.trim(), 'i')).test(text)));
  if (!found.length) return null;
  const im = text.match(/(impression|conclusion|התרשמות|סיכום|מסקנה|מסקנות)\s*[:\-]?\s*([\s\S]{0,320})/i);
  const impression = im ? im[2].split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim() : null;
  const lower = text.toLowerCase(); const findings = [];
  for (const f of table.imagingFindings) {
    for (const k of f.k) {
      const i = lower.indexOf(k.toLowerCase()); if (i < 0) continue;
      const pre = lower.slice(Math.max(0, i - 45), i).split(/[.\n]/).pop(); // same sentence only
      const negated = /\bno\b|without|negative for|free of|ללא|אין|לא נמצא|לא נמצאה|לא נראה|לא הודגם|שולל/.test(pre);
      findings.push({ label: negated ? `ללא ${f.label}` : f.label, significant: f.significant && !negated, keyword: k });
      break;
    }
  }
  // Prefer a date that appears after the first modality mention (the imaging report's own date).
  let firstIdx = Infinity;
  for (const m of found) for (const n of m.names) { const i = text.toLowerCase().indexOf(n.trim().toLowerCase()); if (i >= 0 && i < firstIdx) firstIdx = i; }
  const d = findDates(text).find(x => x.idx >= firstIdx) || findDates(text)[0];
  return { modalities: found.map(m => m.id), date: iso(d?.date), impression, findings, significant: findings.some(f => f.significant) };
}

export function interpret(results, table, { category, sex }) {
  const now = Date.now();
  return results.map(r => {
    const t = table.tests.find(x => x.id === r.testId);
    const out = { ...r, notes: [] };
    if (r.date) { const days = Math.round((now - new Date(r.date).getTime()) / 86400000); out.ageDays = days; out.recency = days <= 30 ? 'recent' : days <= 180 ? 'months' : 'old'; }
    else out.recency = 'unknown';
    if (t.qualitative) {
      out.status = /pos|חיובי|\+|trace/i.test(r.qualitative) ? 'abnormal' : 'normal';
    } else {
      let ref = r.refRange, refSource = 'report';
      if (!ref) { refSource = 'table'; const s = t.sex?.[sex]; ref = s ? { low: s[0], high: s[1] } : { low: t.low, high: t.high }; }
      out.ref = ref; out.refSource = refSource;
      const v = r.value;
      out.status = v < ref.low ? 'low' : v > ref.high ? 'high' : 'normal';
      if ((t.critLow !== undefined && v <= t.critLow) || (t.critHigh !== undefined && v >= t.critHigh)) { out.status = 'critical'; out.notes.push('ערך קריטי לפי טבלת הייחוס'); }
      if (t.plausibleMax !== undefined && v > t.plausibleMax) { out.notes.push(`ערך לא סביר פיזיולוגית — ייתכן שגיאת פענוח/נקודה עשרונית${v / 10 <= t.plausibleMax ? ` (${v / 10}?)` : ''} — לאמת מול המקור`); out.implausible = true; }
      if (r.flag === 'H' && out.status === 'low' || r.flag === 'L' && out.status === 'high') out.notes.push('סתירה בין דגל הדו"ח לחישוב — לאמת מול המקור');
      if (refSource === 'table' && r.unit && t.unit && r.unit.replace(/\s/g, '').toLowerCase() !== t.unit.replace(/\s/g, '').toLowerCase()) { out.notes.push(`יחידה (${r.unit}) שונה מטבלת הייחוס (${t.unit}) — לא ניתן להשוות בביטחון`); out.unitMismatch = true; }
    }
    let score = t.relevant.includes(category) ? 2 : 0;
    if (out.status === 'critical') score += 2; else if (out.status !== 'normal') score += 1;
    score += out.recency === 'recent' ? 1 : out.recency === 'months' ? 0.5 : 0;
    out.relevance = score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low';
    return out;
  }).sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.relevance] - { high: 0, medium: 1, low: 2 }[b.relevance]));
}

/** Parse one uploaded file. Returns a structured, interpretable record. */
export async function parseFile(file, { category, sex, onProgress } = {}) {
  const table = await loadLabRanges();
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let text = '', method, baseConf;
  if (isPdf) {
    const { text: t, doc } = await pdfText(await file.arrayBuffer(), onProgress);
    if (t.replace(/\s/g, '').length > 30) { text = t; method = 'pdf-text'; baseConf = 0.95; }
    else { const r = await ocrPdfPages(doc, onProgress); text = r.text; method = 'pdf-ocr'; baseConf = r.confidence / 100; }
  } else {
    const r = await ocr(file, onProgress); text = r.text; method = 'ocr'; baseConf = r.confidence / 100;
  }
  const ex = extract(text, table);
  const results = interpret(ex.results, table, { category, sex });
  const imaging = extractImaging(text, table);
  const recognized = results.length, unrec = ex.unrecognized.length;
  const coverage = recognized + unrec ? recognized / (recognized + unrec) : 0;
  let confidence = baseConf * (0.6 + 0.4 * coverage);
  if (!recognized && !imaging) confidence *= 0.4;
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  const discrepancies = results.filter(r => r.notes.length).length;
  return {
    method, confidence, docDate: ex.docDate, docType: recognized ? (imaging?.impression ? 'lab+imaging' : 'lab') : imaging ? 'imaging' : 'unknown',
    results, unrecognized: ex.unrecognized.slice(0, 20), imaging,
    verifyOriginal: method !== 'pdf-text' || confidence < 0.85 || discrepancies > 0 || (!recognized && !imaging),
    textPreview: text.slice(0, 1500), rangesVersion: table.version
  };
}
