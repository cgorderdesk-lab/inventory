/* 極簡 IndexedDB 封裝 */
const DB_NAME = 'inventory_db';
const DB_VERSION = 1;
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('products')) {
        const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        s.createIndex('barcode', 'barcode', { unique: false });
        s.createIndex('sku', 'sku', { unique: false });
      }
      if (!db.objectStoreNames.contains('counts')) {
        const s = db.createObjectStore('counts', { keyPath: 'id', autoIncrement: true });
        s.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function _wrap(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const DB = {
  put:   (s, v) => _wrap(s, 'readwrite', st => st.put(v)),
  get:   (s, k) => _wrap(s, 'readonly',  st => st.get(k)),
  all:   (s)    => _wrap(s, 'readonly',  st => st.getAll()),
  byIndex: (s, idx, v) => openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(s, 'readonly');
    const req = tx.objectStore(s).index(idx).getAll(v);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })),
  del:   (s, k) => _wrap(s, 'readwrite', st => st.delete(k)),
  clear: (s)    => _wrap(s, 'readwrite', st => st.clear())
};