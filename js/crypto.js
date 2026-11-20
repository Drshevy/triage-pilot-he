// Encryption at rest with WebCrypto.
//
// Envelope scheme:
//  * KEK (key-encryption key), one per device/browser profile:
//      - 'device'   mode: random AES-GCM-256 key generated as NON-EXTRACTABLE and stored as a CryptoKey
//                         object in IndexedDB (the raw bytes can never be read by JS).
//      - 'passcode' mode: derived with PBKDF2-SHA-256 (310,000 iterations, random 16-byte salt) from a passcode;
//                         never stored — must be re-entered after reload.
//  * DEK (data-encryption key), one per case: random AES-GCM-256, stored only WRAPPED by the KEK.
//    All case JSON and every blob (session video, clips, uploads) are encrypted with the case DEK,
//    each with a fresh 96-bit IV.
//  * Deleting a case deletes its wrapped DEK (crypto-shredding) as well as its ciphertext.
import { idbGet, idbPut, idbDel } from './idb.js';

const subtle = crypto.subtle;
const PBKDF2_ITER = 310000;
const enc = new TextEncoder(), dec = new TextDecoder();
const iv12 = () => crypto.getRandomValues(new Uint8Array(12));

export class CryptoVault {
  constructor() { this.kek = null; this.mode = 'device'; this.dekCache = new Map(); }

  isAvailable() { return !!(window.isSecureContext && subtle); }

  async init(mode) {
    this.mode = mode || 'device';
    this.kek = null; this.dekCache.clear();
    if (this.mode === 'device') this.kek = await this._deviceKek();
    return !!this.kek;
  }
  isUnlocked() { return !!this.kek; }

  async _deviceKek() {
    const rec = await idbGet('keys', 'device-kek');
    if (rec?.key) return rec.key;
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
    await idbPut('keys', { id: 'device-kek', key, created: Date.now() });
    return key;
  }

  async _derive(passcode, salt) {
    const base = await subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
  }
  async hasPasscode() { return !!(await idbGet('keys', 'pass-salt')); }

  /** Unlock (or first-time set) passcode mode. Returns false on wrong passcode. */
  async unlockPasscode(passcode) {
    let saltRec = await idbGet('keys', 'pass-salt');
    if (!saltRec) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await this._derive(passcode, salt);
      const iv = iv12();
      const check = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('triage-ok'));
      await idbPut('keys', { id: 'pass-salt', salt, iv, check, iterations: PBKDF2_ITER });
      this.kek = key; this.mode = 'passcode'; return true;
    }
    const key = await this._derive(passcode, saltRec.salt);
    try {
      const out = await subtle.decrypt({ name: 'AES-GCM', iv: saltRec.iv }, key, saltRec.check);
      if (dec.decode(out) !== 'triage-ok') return false;
    } catch { return false; }
    this.kek = key; this.mode = 'passcode'; return true;
  }

  /** Re-wrap every case DEK from the current KEK to a new KEK (used when switching modes). */
  async rewrapAll(caseRecords, newKek) {
    for (const rec of caseRecords) {
      const dekX = await subtle.unwrapKey('raw', rec.wrappedKey.data, this.kek, { name: 'AES-GCM', iv: rec.wrappedKey.iv },
        { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
      const iv = iv12();
      rec.wrappedKey = { iv, data: await subtle.wrapKey('raw', dekX, newKek, { name: 'AES-GCM', iv }) };
      await idbPut('cases', rec);
    }
    this.kek = newKek; this.dekCache.clear();
  }
  async deriveNewPasscodeKek(passcode) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await this._derive(passcode, salt);
    const iv = iv12();
    const check = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('triage-ok'));
    return { key, saltRec: { id: 'pass-salt', salt, iv, check, iterations: PBKDF2_ITER } };
  }
  async newDeviceKek() {
    await idbDel('keys', 'device-kek');
    return this._deviceKek();
  }

  /** Create a fresh DEK; returns { dek (non-extractable), wrappedKey }. */
  async newDek() {
    if (!this.kek) throw new Error('vault locked');
    const tmp = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = iv12();
    const wrappedKey = { iv, data: await subtle.wrapKey('raw', tmp, this.kek, { name: 'AES-GCM', iv }) };
    const dek = await this._unwrap(wrappedKey); // keep only a non-extractable copy in memory
    return { dek, wrappedKey };
  }
  async _unwrap(wrappedKey) {
    return subtle.unwrapKey('raw', wrappedKey.data, this.kek, { name: 'AES-GCM', iv: wrappedKey.iv },
      { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async dekFor(caseId, wrappedKey) {
    if (this.dekCache.has(caseId)) return this.dekCache.get(caseId);
    if (!this.kek) throw new Error('vault locked');
    const dek = await this._unwrap(wrappedKey);
    this.dekCache.set(caseId, dek);
    return dek;
  }
  forget(caseId) { this.dekCache.delete(caseId); }

  async encryptBytes(dek, buf) { const iv = iv12(); return { iv, data: await subtle.encrypt({ name: 'AES-GCM', iv }, dek, buf) }; }
  async decryptBytes(dek, box) { return subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, dek, box.data); }
  async encryptJSON(dek, obj) { return this.encryptBytes(dek, enc.encode(JSON.stringify(obj))); }
  async decryptJSON(dek, box) { return JSON.parse(dec.decode(await this.decryptBytes(dek, box))); }
}
