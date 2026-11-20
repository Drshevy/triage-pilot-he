// LLMDialogueProvider — STUB ONLY. Not selected anywhere; makes no network calls.
// Waits for the user's explicit approval, a chosen vendor and a server-side API key.
//
// Contract (same as DialogueProvider in dialogue.js, so app.js needs no change — swap ctx.makeDialogue):
//   start({patient})            → Turn  { say, question:{id,type,text,options?}, done?, status?, quiet?, initiated? }
//   answer({text}|{value})      → { turn: Turn, newAlerts: Alert[] }
//   getState()                  → { facts, answered, labels, questions, required, name, ... }
// Rules that stay deterministic regardless of the LLM:
//   • The LLM may only PHRASE questions and PROPOSE facts; facts must use the rule-pack fact ids (rules.json).
//   • Every answer is re-parsed by nlu.extractFacts and red flags/urgency are computed by engine.js on the merged facts.
//     newAlerts come from detectRedFlags, never from the model. An emergency always pre-empts the model.
//   • Free-speech intents (repeat / hold / end / correction / "I don't know") should keep using nlu.detectIntent first.
//   • The model must never state a diagnosis or treatment to the patient (buildAssessment stays rule-based, staff-facing).
// Integration sketch: browser → YOUR backend (holds the key; strips identifiers: no name/ID/phone) → LLM vendor.
// Privacy: patient free text leaves the device → cross-border transfer review, DPA, retention/training opt-out,
// Amendment 13 duties, consent text update, CSP connect-src change. Prefer Israeli/EU hosting.
import { DialogueProvider, ConversationalDialogue } from './dialogue.js';

export class LLMDialogueProvider extends DialogueProvider {
  constructor(rules, patient, { endpoint = null, apiKeyRef = null } = {}) {
    super();
    this.endpoint = endpoint; this.apiKeyRef = apiKeyRef;
    this.fallback = new ConversationalDialogue(rules, patient);     // deterministic core the LLM would wrap
  }
  get configured() { return false; }
  _notConfigured() { throw new Error('LLMDialogueProvider not configured: needs the user\'s approval + a server-side API key'); }
  async start() { this._notConfigured(); }
  async answer() { this._notConfigured(); }
  getState() { return this.fallback.getState(); }
}
