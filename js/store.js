// 端末内保存（IndexedDB）。画像・物件・周辺データのキャッシュを保存する。
// 保存先はこの端末のブラウザだけで、外部には送信しない。失敗しても動作は継続する。
const DB = 'walk-room';
const VERSION = 2;

let dbp = null;
export function idb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('IndexedDB blocked')); };
  });
  return dbp;
}

function tx(store, mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k)).catch(() => null);
export const kvPut = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)).catch(() => null);
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k)).catch(() => null);

export const listProjects = () => tx('projects', 'readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''))).catch(() => []);
export const getProject = (id) => tx('projects', 'readonly', (s) => s.get(id)).catch(() => null);
export function putProject(p) {
  p.updatedAt = new Date().toISOString();
  return tx('projects', 'readwrite', (s) => s.put(p));
}
export async function deleteProject(p) {
  for (const im of p.images || []) await tx('images', 'readwrite', (s) => s.delete(im.id)).catch(() => null);
  return tx('projects', 'readwrite', (s) => s.delete(p.id));
}
export const putImage = (rec) => tx('images', 'readwrite', (s) => s.put(rec));
export const getImage = (id) => tx('images', 'readonly', (s) => s.get(id)).catch(() => null);
export const deleteImage = (id) => tx('images', 'readwrite', (s) => s.delete(id)).catch(() => null);

// 画像を縮小して保存（重ね合わせ確認用。Claude には元の写真を利用者が添付する）
export async function imageFromFile(file, maxSide = 2200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めません（HEIC などは「互換性優先」で保存した写真を選んでください）')); i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
    return { blob: blob || file, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
