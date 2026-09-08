//@ts-check
import { sqliteResultError } from '../errors.js';
/** Session C bindings are isolated from oo1 statements and Store capture. */

/** Probe the live API and own every session allocated for one database.
 * @param {any} sqlite3 @param {any} db
 * @returns {{ session?: (table?: string) => any, reason: string | null, close: () => void }}
 */
export function wasmSessions(sqlite3, db) {
  const { capi, wasm } = sqlite3;
  const sessions = new Set();
  const close = () => { for (const session of sessions) session.close(); };
  const api = ['sqlite3session_create', 'sqlite3session_attach', 'sqlite3session_changeset', 'sqlite3session_delete', 'sqlite3_free'];
  if (api.some((name) => typeof capi?.[name] !== 'function')
    || ['allocPtr', 'dealloc', 'peekPtr', 'peek', 'heap8u'].some((name) => typeof wasm?.[name] !== 'function'))
    return { reason: 'the loaded wasm binding lacks the session or memory APIs', close };
  const check = (rc) => {
    if (rc !== 0) throw sqliteResultError(rc, 'SQLite session API');
  };
  const create = (table = undefined) => {
    const output = wasm.allocPtr();
    let pointer = 0;
    try {
      const rc = capi.sqlite3session_create(db.pointer, 'main', output);
      pointer = wasm.peekPtr(output);
      check(rc);
      if (!pointer) throw new Error('SQLite session create returned a null handle');
      check(capi.sqlite3session_attach(pointer, table ?? null));
    }
    catch (error) { if (pointer) capi.sqlite3session_delete(pointer); throw error; }
    finally { wasm.dealloc(output); }
    let closed = false;
    const session = {
      changeset() {
        if (closed) throw new Error('the SQLite session is closed');
        const [lengthPointer, dataPointer] = wasm.allocPtr(2);
        let data = 0;
        try {
          const rc = capi.sqlite3session_changeset(pointer, lengthPointer, dataPointer);
          data = wasm.peekPtr(dataPointer);
          check(rc);
          const length = wasm.peek(lengthPointer, 'i32');
          return wasm.heap8u().slice(data, data + length);
        }
        finally {
          if (data) capi.sqlite3_free(data);
          wasm.dealloc(lengthPointer);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        sessions.delete(session);
        capi.sqlite3session_delete(pointer);
      },
    };
    sessions.add(session);
    return session;
  };
  try {
    const probe = create();
    try { probe.changeset(); }
    finally { probe.close(); }
    return { session: create, reason: null, close };
  }
  catch (error) { close(); return { reason: `the disposable session probe failed: ${error.message}`, close }; }
}
