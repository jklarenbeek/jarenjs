//@ts-check
/**
 * The OS's own database: `os.model.json` opened by `@jarenjs/db` over
 * whatever SQLite driver the host hands in — sqlite-wasm on OPFS in the
 * browser's worker (`db-worker.js`), `node:sqlite` in the tests — and
 * served through `store.contract.json`, so the page reaches it exactly
 * as it reaches every other operation: validated JSON across a port.
 *
 * Three collections, each a document the user would want back:
 *
 *   - `artworks`     — kept artworks: tape, heads, program, merits;
 *   - `constitution` — every amendment and how it ended;
 *   - `sessions`     — the running OS, saved as it goes, so a reload (or
 *                      an offline cold start) picks up where it stopped.
 *
 * `createMemoryStore` answers the same handlers from plain maps, for a
 * browser that cannot start the worker at all; it says so in its mode.
 */

import { openStore } from '@jarenjs/db';
import { JarenValidator } from '@jarenjs/validate';
import model from '../documents/os.model.json' with { type: 'json' };

/** The newest kept artworks the gallery lists. */
const LIST_LIMIT = 48;

/** The query the gallery list runs: newest first, summaries only. */
const LIST_QUERY = [{
  $for: { a: '$[*]' },
  $orderby: { $key: '$a.at', $dir: 'desc' },
  $return: { id: '$a.id', title: '$a.title', at: '$a.at', harmony: '$a.harmony', tick: '$a.tick' },
}];

/** The constitution, oldest session first. */
const AMENDMENTS_QUERY = [{
  $for: { a: '$[*]' },
  $orderby: [{ $key: '$a.session' }, '$a.id'],
  $return: '$a',
}];

/**
 * Open the OS database.
 * @param {{ driver: any, path?: string, mode?: string, detail?: string }} options
 */
export async function openOsStore(options) {
  const validator = new JarenValidator({ collectErrors: true });
  const store = await openStore(model, {
    driver: options.driver,
    path: options.path ?? ':memory:',
    compileSchema: (/** @type {any} */ schema) => validator.compile(schema),
  });
  return { store, handlers: storeHandlers(store, options.mode ?? 'sqlite', options.detail ?? '') };
}

/**
 * The store contract's handlers over an open `@jarenjs/db` store.
 * @param {any} store @param {string} mode @param {string} detail
 */
export function storeHandlers(store, mode, detail) {
  const artworks = store.collection('artworks');
  const constitution = store.collection('constitution');
  const sessions = store.collection('sessions');
  return {
    'store.info': () => ({ mode, detail }),
    'artwork.put': async (/** @type {any} */ input) => ({ id: String(await artworks.put(input.artwork)) }),
    'artwork.list': async () => asList(await artworks.execute(LIST_QUERY)).slice(0, LIST_LIMIT),
    'artwork.get': async (/** @type {any} */ input) => (await artworks.get(input.id)) ?? null,
    'amendment.put': async (/** @type {any} */ input) => ({ id: String(await constitution.put(input.amendment)) }),
    'amendment.list': async () => asList(await constitution.execute(AMENDMENTS_QUERY)),
    'session.put': async (/** @type {any} */ input) => {
      const at = new Date().toISOString();
      await sessions.put({ id: 'current', at, state: input.state });
      return { at };
    },
    'session.get': async () => (await sessions.get('current')) ?? null,
  };
}

/** A query result as a list, whatever its cardinality (the engine answers
 * a single row as the row itself). @param {any} value @returns {any[]} */
function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The same handlers over plain maps — the last resort when no worker
 * starts. Nothing survives a reload, and the mode says so.
 */
export function createMemoryStore() {
  /** @type {Map<string, any>} */ const artworks = new Map();
  /** @type {Map<string, any>} */ const amendments = new Map();
  /** @type {any} */ let session = null;
  return {
    'store.info': () => ({ mode: 'memory', detail: 'this browser could not start the database worker; nothing is kept after a reload' }),
    'artwork.put': (/** @type {any} */ input) => { artworks.set(input.artwork.id, structuredClone(input.artwork)); return { id: input.artwork.id }; },
    'artwork.list': () => [...artworks.values()]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, LIST_LIMIT)
      .map((a) => ({ id: a.id, title: a.title, at: a.at, harmony: a.harmony, tick: a.tick })),
    'artwork.get': (/** @type {any} */ input) => artworks.get(input.id) ?? null,
    'amendment.put': (/** @type {any} */ input) => { amendments.set(input.amendment.id, structuredClone(input.amendment)); return { id: input.amendment.id }; },
    'amendment.list': () => [...amendments.values()].sort((a, b) => a.session - b.session),
    'session.put': (/** @type {any} */ input) => { const at = new Date().toISOString(); session = { id: 'current', at, state: structuredClone(input.state) }; return { at }; },
    'session.get': () => session,
  };
}
