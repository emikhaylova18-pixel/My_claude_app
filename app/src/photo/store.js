// Хранилище в браузере (IndexedDB): туда помещается фото целиком, в отличие от localStorage.
// Если браузер не даёт доступ (приватный режим), редактор просто работает без автосохранения.

const DB_NAME = 'studio';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) { reject(new Error('нет IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const idbGet = (key) => run('readonly', (s) => s.get(key)).catch(() => undefined);
export const idbSet = (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => true, () => false);
export const idbDel = (key) => run('readwrite', (s) => s.delete(key)).then(() => true, () => false);
