//@ts-check
/**
 * The assistant ledger's storage adapter, over one JSON slot.
 *
 * `@jarenjs/ai`'s `createLedger` takes a four-method async adapter
 * (`get`/`set`/`delete`/`keys`) and never imports a store — durability
 * is the host's to supply. This site already has exactly one persistence
 * idiom: a named localStorage slot read and written as JSON, degrading
 * to in-memory when storage is unavailable (private mode, quota). So the
 * adapter is built over that idiom rather than beside it: the whole
 * ledger is one record map in one slot.
 *
 * Rewriting the whole slot per write is the right trade here and not
 * laziness — a ledger is a goal, a handful of memories and the archived
 * rounds of one conversation, measured in kilobytes, and the alternative
 * (a key per record) would spread one logical thing across a namespace
 * this site would then have to sweep. A host that needs more injects
 * `@jarenjs/db` over OPFS instead; that is what the seam is for.
 *
 * The in-memory record map is authoritative for the session and the slot
 * is a mirror of it. That matters when the mirror fails: `jsonStore`
 * swallows a quota error, so a session that outgrows the browser's
 * storage keeps working — every address the conversation names still
 * resolves — and loses only the part that was never in memory to begin
 * with, which is the next visit. Durability degrades; correctness does
 * not. Nothing evicts old rounds yet (`docs/ROADMAP.md`).
 */

/** A JSON value, copied — the same isolation the in-memory adapter gives. */
const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * @param {{ read: () => any, write: (data: any) => void }} slot - a JSON
 *   slot (the site's `jsonStore`); `read` may answer null when empty or
 *   unavailable, and `write` may silently do nothing.
 * @returns {{ get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<void>,
 *   keys: (prefix?: string) => Promise<string[]> }}
 */
export function createSlotLedgerStorage(slot) {
  /** @type {Record<string, any> | null} */
  let cache = null;

  const load = () => {
    if (cache === null) {
      const raw = slot.read();
      cache = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    return cache;
  };

  return {
    get: async (key) => copy(load()[key]),
    set: async (key, value) => {
      load()[key] = copy(value);
      slot.write(cache);
    },
    delete: async (key) => {
      delete load()[key];
      slot.write(cache);
    },
    keys: async (prefix = '') => Object.keys(load())
      .filter((key) => key.startsWith(prefix))
      .sort(),
  };
}
