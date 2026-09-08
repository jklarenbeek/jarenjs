//@ts-check
/**
 * @file A tiny persisted document store plus a share-link codec — the
 * save / load / delete / list + share primitives an IDE-style surface (the
 * studio, the play playground) needs, with the storage backend injected by
 * the host so the package stays free of `localStorage`.
 *
 * `createDocStore` is a keyed CRUD over an injected `storage` ({ read, write }):
 * the store is one JSON object `{ [key]: { name → value } }`, read once at
 * creation and written back on every mutation. `encodeShare` / `decodeShare`
 * turn a small snapshot into a Unicode-safe base64url token and back —
 * forgivingly: a corrupt token decodes to `null`, never a throw.
 */

import { setObjectMember } from '@jarenjs/core/object';

/**
 * @param {Object} opts
 * @param {{ read: () => any, write: (store: any) => void }} opts.storage
 *   the host persistence adapter (localStorage in the browser, an in-memory
 *   object in tests)
 * @param {string} [opts.key='experiments'] - the store's collection key
 * @returns {{
 *   save: (name: string, value: any) => void,
 *   load: (name: string) => any,
 *   remove: (name: string) => void,
 *   names: () => string[],
 *   all: () => Record<string, any>,
 * }}
 */
export function createDocStore({ storage, key = 'experiments' }) {
  // read once; keep the SAME object reference for every write-back
  const store = storage.read() ?? {};
  if (!Object.hasOwn(store, key) || store[key] == null) setObjectMember(store, key, {});
  return {
    save(name, value) { setObjectMember(store[key], name, value); storage.write(store); },
    load(name) { return Object.hasOwn(store[key], name) ? store[key][name] : undefined; },
    remove(name) { delete store[key][name]; storage.write(store); },
    names() { return Object.keys(store[key]).sort(); },
    all() { return store[key]; },
  };
}

/**
 * Encode a snapshot as a base64url token: Unicode-safe (TextEncoder),
 * portable between browser and Node.
 * @param {any} snapshot
 * @returns {string} the base64url token
 */
export function encodeShare(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url token back to its snapshot, forgivingly.
 * @param {string} token
 * @returns {any} the snapshot object, or `null` when the token is unusable
 */
export function decodeShare(token) {
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const snapshot = JSON.parse(new TextDecoder().decode(bytes));
    return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
  }
  catch {
    return null;
  }
}
