// Minimal promise wrapper around IndexedDB.
export const DB_NAME = 'triage-pilot';
const DB_VERSION = 1;
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('cases')) db.createObjectStore('cases', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) {
        const s = db.createObjectStore('blobs', { keyPath: 'key' });
        s.createIndex('caseId', 'caseId');
      }
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function idbGet(store, key) { const db = await openDB(); return wrap(db.transaction(store).objectStore(store).get(key)); }
export async function idbPut(store, val) { const db = await openDB(); return wrap(db.transaction(store, 'readwrite').objectStore(store).put(val)); }
export async function idbDel(store, key) { const db = await openDB(); return wrap(db.transaction(store, 'readwrite').objectStore(store).delete(key)); }
export async function idbAll(store) { const db = await openDB(); return wrap(db.transaction(store).objectStore(store).getAll()); }
export async function idbKeysByIndex(store, index, value) {
  const db = await openDB(); return wrap(db.transaction(store).objectStore(store).index(index).getAllKeys(value));
}
export async function idbDeleteDatabase() {
  if (dbp) { try { (await dbp).close(); } catch {} dbp = null; }
  await new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error); r.onblocked = () => res();
  });
}
