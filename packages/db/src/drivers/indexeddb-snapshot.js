//@ts-check
/** Atomic, versioned SQLite snapshots. IndexedDB is storage, never an OPFS VFS. */
import { DbRuntimeError, sqliteResultError } from '../errors.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { adaptOo1Database } from './wasm-oo1.js';

/** @param {any} factory @param {string} name @returns {Promise<any>} */
export function openSnapshotStorage(factory, name) {
  return new Promise((resolve, reject) => {
    if (typeof factory?.open !== 'function') { reject(new Error('IndexedDB is unavailable')); return; }
    const request = factory.open(name, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore('snapshots'); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('the IndexedDB snapshot database upgrade is blocked')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const transact = (key, write, bytes, expected) => new Promise((yes, no) => {
        const tx = db.transaction('snapshots', write ? 'readwrite' : 'readonly');
        const store = tx.objectStore('snapshots');
        let result;
        let failure;
        const read = store.get(key);
        read.onsuccess = () => {
          try {
            const old = read.result;
            if (!write) { result = old ?? null; return; }
            if ((old?.revision ?? 0) !== expected) {
              failure = new Error('the durable snapshot changed in another connection');
              tx.abort();
              return;
            }
            result = expected + 1;
            if (bytes === null) store.delete(key);
            else store.put({ revision: result, bytes }, key);
          }
          catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => yes(result);
        tx.onabort = () => no(failure ?? tx.error ?? new Error('the snapshot transaction was aborted'));
      });
      resolve({
        read: (key) => transact(key, false),
        write: (key, bytes, revision) => transact(key, true, bytes, revision),
        remove: async (key) => { const old = await transact(key, false); return transact(key, true, null, old?.revision ?? 0); },
        close: () => db.close(),
      });
    };
  });
}

/** Build an async binding over a synchronous wasm handle plus atomic storage.
 * @param {any} sqlite3
 * @param {{ openStorage: () => Promise<any>, maxBytes?: number }} options
 * @returns {any}
 */
export function snapshotHandle(sqlite3, options) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('snapshot maxBytes must be a positive integer');
  return {
    synchronous: false,
    declares: { sessions: true, userFunctions: true, deterministicIndexableFunctions: true },
    open: async (path, openOptions = {}) => {
      const memory = path === ':memory:' || path === '';
      const storage = memory ? null : await options.openStorage();
      let db;
      try {
        const saved = await storage?.read(path);
        if (saved != null && (!Number.isSafeInteger(saved.revision) || saved.revision < 1
          || !(saved.bytes instanceof Uint8Array) || saved.bytes.length < 1 || saved.bytes.length > maxBytes))
          throw new DbRuntimeError('JD2094', 'the persisted SQLite snapshot is invalid or exceeds its declared byte bound');
        let revision = saved?.revision ?? 0;
        db = new sqlite3.oo1.DB(':memory:');
        const { capi, wasm } = sqlite3;
        if (saved?.bytes?.length > 0) {
          if (!(saved.bytes instanceof Uint8Array) || saved.bytes.length > maxBytes)
            throw new DbRuntimeError('JD2094', 'the persisted SQLite snapshot exceeds its declared byte bound');
          const pointer = wasm.allocFromTypedArray(saved.bytes);
          const rc = capi.sqlite3_deserialize(db.pointer, 'main', pointer,
            BigInt(saved.bytes.length), BigInt(saved.bytes.length),
            capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
          if (rc !== 0) { wasm.dealloc(pointer); throw sqliteResultError(rc, 'snapshot deserialize'); }
        }
        if (openOptions.readOnly === true) db.exec(sqliteDialect.pragma.set('query_only', 1));
        const raw = adaptOo1Database(sqlite3, db);
        let poisoned = null;
        const requireUsable = () => { if (poisoned !== null) throw poisoned; };
        const persist = async () => {
          if (storage === null || openOptions.readOnly === true || !capi.sqlite3_get_autocommit(db.pointer)) return;
          try {
            const pages = db.selectValue(sqliteDialect.introspect.pragma('page_count'));
            const pageSize = db.selectValue(sqliteDialect.introspect.pragma('page_size'));
            if (pages * pageSize > maxBytes) throw new Error(`snapshot exceeds ${maxBytes} bytes`);
            const bytes = capi.sqlite3_js_db_export(db.pointer);
            if (bytes.length > maxBytes) throw new Error(`snapshot exceeds ${maxBytes} bytes`);
            revision = await storage.write(path, bytes, revision);
          }
          catch (cause) {
            poisoned = Object.assign(new DbRuntimeError('JD2094',
              'the durable snapshot was not committed; this connection is invalid; reopen to read the last committed version',
              { cause }), { retryable: false, class: 'persistence' });
            throw poisoned;
          }
        };
        return {
          ...raw,
          exec: async (sql) => { requireUsable(); raw.exec(sql); await persist(); },
          prepare: (sql) => {
            requireUsable();
            const statement = raw.prepare(sql);
            const invoke = (member, params) => {
              requireUsable();
              const value = statement[member](params);
              return statement.readOnly ? value : persist().then(() => value);
            };
            return {
              run: (params = []) => invoke('run', params),
              get: (params = []) => invoke('get', params),
              all: (params = []) => invoke('all', params),
              iterate: (params = []) => {
                requireUsable();
                const iterator = statement.iterate(params);
                return {
                  next: async () => { requireUsable(); const step = iterator.next(); if (!statement.readOnly) await persist(); return step; },
                  return: async () => { const step = iterator.return(); if (!statement.readOnly && poisoned === null) await persist(); return step; },
                };
              },
            };
          },
          close: () => { try { raw.close(); } finally { storage?.close(); } },
        };
      }
      catch (error) { db?.close(); storage?.close(); throw error; }
    },
  };
}

/** IndexedDB durability via bounded atomic snapshots, with async acknowledgements.
 * @param {any} sqlite3
 * @param {{ name?: string, indexedDB?: any, maxBytes?: number }} [options]
 * @returns {any} an injected wasm handle
 */
export function indexedDbSnapshotHandle(sqlite3, options = {}) {
  return snapshotHandle(sqlite3, { maxBytes: options.maxBytes,
    openStorage: () => openSnapshotStorage(options.indexedDB ?? globalThis.indexedDB,
      options.name ?? 'jaren-sqlite-snapshots') });
}
