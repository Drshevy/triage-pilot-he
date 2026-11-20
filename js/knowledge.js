// KnowledgeProvider / LLMProvider swap points.
//
// The prototype makes NO network calls. NullKnowledgeProvider marks items as "needs up-to-date check"
// instead of pretending to look anything up.
//
// To plug in real knowledge later (behind your own backend, never directly from the browser with PHI):
//   class GuidelineRetrievalProvider extends KnowledgeProvider {
//     async check(items, ctx) {
//       // POST de-identified query terms (no name/ID/free text) to https://<your-il-backend>/knowledge/check
//       // backend → PubMed E-utilities / licensed guideline APIs (e.g. NICE syndication, UpToDate API)
//       // returns [{ itemId, status: 'current'|'outdated'|'conflict', evidence: [{title, url, date}] }]
//     }
//   }
//   class MedicalLLMProvider extends LLMProvider {
//     async complete(messages, { schema }) { /* call your hosted medical LLM; validate JSON against schema */ }
//   }
// Any LLM output must still pass engine.validate() and map to ruleset ids before reaching a clinician.

/** @interface */
export class KnowledgeProvider {
  /** @returns {Promise<Array<{itemId:string, status:'current'|'outdated'|'conflict'|'needs-check', reason:string, evidence?:any[]}>>} */
  async check(_items, _ctx) { throw new Error('not implemented'); }
  get name() { return 'abstract'; }
}
/** @interface */
export class LLMProvider {
  async complete(_messages, _opts) { throw new Error('not implemented'); }
}

export class NullKnowledgeProvider extends KnowledgeProvider {
  get name() { return 'none (offline prototype)'; }
  async check(items, ctx = {}) {
    const out = [];
    for (const it of items) {
      let reason = null;
      if (it.kind === 'treatment') reason = 'שיקולי טיפול — חובה לאמת מול הנחיה עדכנית';
      else if (it.source === 'LOCAL') reason = 'כלל מקומי של הפיילוט — לא מבוסס על הנחיה מאומתת';
      else if (ctx.category === 'general') reason = 'קטגוריה כללית — מומלץ לבדוק מידע עדכני';
      else if (it.kind === 'lab-unknown') reason = 'בדיקה ללא טווח ייחוס בטבלה';
      if (reason) out.push({ itemId: it.id, text: it.text, status: 'needs-check', reason });
    }
    return out;
  }
}
