// StorageProvider abstraction + encrypted IndexedDB implementation.
//
// To move to a backend later, implement the same interface (e.g. RemoteStorageProvider that
// encrypts client-side and talks to an Israeli-hosted API over TLS) and swap it in app.js.
import { idbGet, idbPut, idbDel, idbAll, idbKeysByIndex, idbDeleteDatabase } from './idb.js';
import { CryptoVault } from './crypto.js';

/** @interface */
export class StorageProvider {
  async init(_settings) { throw new Error('not implemented'); }
  async saveCase(_caseObj) { throw new Error('not implemented'); }
  async getCase(_id) { throw new Error('not implemented'); }
  async listCases() { throw new Error('not implemented'); }
  async deleteCase(_id) { throw new Error('not implemented'); }
  async saveBlob(_caseId, _blobId, _blob) { throw new Error('not implemented'); }
  async getBlob(_caseId, _blobId) { throw new Error('not implemented'); }
  async wipeAll() { throw new Error('not implemented'); }
}

/**
 * Only a minimal, non-identifying index is stored in plaintext so the dashboard can sort
 * (urgency rank, queue, alert flag, status, timestamps). Everything else — patient details,
 * transcript, answers, summary, and all media — is AES-GCM encrypted with the case DEK.
 */
export class EncryptedIndexedDBStorage extends StorageProvider {
  constructor() { super(); this.vault = new CryptoVault(); }
  async init(settings) { return this.vault.init(settings.encryptionMode); }
  isUnlocked() { return this.vault.isUnlocked(); }

  async saveCase(c) {
    let rec = await idbGet('cases', c.id);
    let dek;
    if (rec) dek = await this.vault.dekFor(c.id, rec.wrappedKey);
    else {
      const k = await this.vault.newDek();
      dek = k.dek; this.vault.dekCache.set(c.id, dek);
      rec = { id: c.id, wrappedKey: k.wrappedKey };
    }
    rec.index = {
      createdAt: c.createdAt, updatedAt: Date.now(), status: c.status, queue: c.routing?.queue || null,
      urgencyRank: c.summary?.urgency?.rank ?? null, alert: (c.alerts || []).length > 0, reviewed: !!c.review?.reviewed, demo: !!c.demo
    };
    rec.enc = await this.vault.encryptJSON(dek, c);
    await idbPut('cases', rec);
    return c;
  }
  async getCase(id) {
    const rec = await idbGet('cases', id);
    if (!rec) return null;
    const dek = await this.vault.dekFor(id, rec.wrappedKey);
    return this.vault.decryptJSON(dek, rec.enc);
  }
  async listCases() {
    const recs = await idbAll('cases');
    const out = [];
    for (const r of recs) {
      try { out.push(await this.vault.decryptJSON(await this.vault.dekFor(r.id, r.wrappedKey), r.enc)); }
      catch (e) { out.push({ id: r.id, _undecryptable: true, createdAt: r.index?.createdAt, status: r.index?.status }); }
    }
    return out;
  }
  async rawCaseRecords() { return idbAll('cases'); }
  async deleteCase(id) {
    const keys = await idbKeysByIndex('blobs', 'caseId', id);
    for (const k of keys) await idbDel('blobs', k);
    await idbDel('cases', id);    // removes the wrapped DEK → ciphertext is unrecoverable
    this.vault.forget(id);
  }
  async saveBlob(caseId, blobId, blob, meta = {}) {
    const rec = await idbGet('cases', caseId);
    if (!rec) throw new Error('case must be saved before blobs');
    const dek = await this.vault.dekFor(caseId, rec.wrappedKey);
    const box = await this.vault.encryptBytes(dek, await blob.arrayBuffer());
    await idbPut('blobs', { key: `${caseId}:${blobId}`, caseId, blobId, iv: box.iv, data: box.data, type: blob.type, size: blob.size, kind: meta.kind || 'file' });
  }
  async getBlob(caseId, blobId) {
    const b = await idbGet('blobs', `${caseId}:${blobId}`);
    if (!b) return null;
    const rec = await idbGet('cases', caseId);
    const dek = await this.vault.dekFor(caseId, rec.wrappedKey);
    const buf = await this.vault.decryptBytes(dek, b);
    return new Blob([buf], { type: b.type });
  }
  /** Patient "delete all my data": drops the whole database including all keys. */
  async wipeAll() {
    this.vault.dekCache.clear(); this.vault.kek = null;
    await idbDeleteDatabase();
    Object.keys(localStorage).filter(k => k.startsWith('triage.')).forEach(k => localStorage.removeItem(k));
    Object.keys(sessionStorage).filter(k => k.startsWith('triage.')).forEach(k => sessionStorage.removeItem(k));
    if (window.caches) { try { for (const k of await caches.keys()) await caches.delete(k); } catch {} }
  }
}
