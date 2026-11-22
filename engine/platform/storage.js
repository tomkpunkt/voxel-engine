// Spielstände in IndexedDB (Rückfall: localStorage). Werte sind JSON-taugliche Objekte.
const DB = 'voxel-engine', STORE = 'saves';

function open() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('kein IndexedDB'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE), q = fn(s);
    t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error);
  });
}
/** Speichern unter einem Namen. Liefert die Größe in Byte (als JSON). */
export async function saveGame(name, data) {
  const json = JSON.stringify({ ...data, savedAt: Date.now() });
  try { await tx('readwrite', s => s.put(json, name)); } catch (e) { localStorage.setItem(DB + ':' + name, json); }
  return json.length;
}
export async function loadGame(name) {
  let json = null;
  try { json = await tx('readonly', s => s.get(name)); } catch (e) { /* */ }
  if (!json) json = typeof localStorage !== 'undefined' ? localStorage.getItem(DB + ':' + name) : null;
  return json ? JSON.parse(json) : null;
}
export async function deleteGame(name) {
  try { await tx('readwrite', s => s.delete(name)); } catch (e) { /* */ }
  if (typeof localStorage !== 'undefined') localStorage.removeItem(DB + ':' + name);
}
