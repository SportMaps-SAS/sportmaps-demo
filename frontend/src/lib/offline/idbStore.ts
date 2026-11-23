/**
 * Almacén clave-valor mínimo sobre IndexedDB para el modo offline.
 *
 *  · Sin dependencias. Nunca lanza: sin IndexedDB (modo privado, bloqueado, pruebas) cae a
 *    memoria y la app sigue como si no hubiera copia local.
 *  · Una sola base (`sportmaps-offline`) y un solo almacén (`kv`).
 *  · Las claves llevan el usuario (`rq:{userId}`): nada se lee entre cuentas.
 */

const DB_NAME = 'sportmaps-offline';
const STORE = 'kv';

const memoria = new Map<string, unknown>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function abrir(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Otra pestaña pidió subir la versión o borrar la base: se suelta la conexión.
        db.onversionchange = () => { try { db.close(); } catch { /* ya cerrada */ } dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function pedir<T>(db: IDBDatabase, modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, modo);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result as T | undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await abrir();
  if (!db) return memoria.get(key) as T | undefined;
  return pedir<T>(db, 'readonly', (s) => s.get(key));
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await abrir();
  if (!db) { memoria.set(key, value); return; }
  await pedir(db, 'readwrite', (s) => s.put(value, key));
}

export async function idbDel(key: string): Promise<void> {
  memoria.delete(key);
  const db = await abrir();
  if (!db) return;
  await pedir(db, 'readwrite', (s) => s.delete(key));
}

/** Borra TODAS las claves que empiezan por `prefix` (cierre de sesión / cambio de usuario). */
export async function idbDelPrefix(prefix: string): Promise<void> {
  for (const k of [...memoria.keys()]) if (k.startsWith(prefix)) memoria.delete(k);
  const db = await abrir();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (typeof c.key === 'string' && c.key.startsWith(prefix)) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Solo para pruebas: reinicia el estado interno del módulo. */
export function __reiniciarIdbParaPruebas(): void {
  memoria.clear();
  dbPromise = null;
}
