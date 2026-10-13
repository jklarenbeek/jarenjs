//@ts-check
/**
 * @file A tiny persisted document store plus a share-link codec — the
 * save / load / delete / list + share primitives an IDE-style surface (the
 * studio, the play playground) needs, with the storage backend injected by
 * the host so the package stays free of `localStorage`.
 *
 * `createDocStore` is a keyed CRUD over an injected `storage` ({ read, write }):
 * the store is one JSON object `{ [key]: { name → value } }`, read once per
 * storage adapter, shared by its collections and written back on every
 * mutation. `encodeShare` / `decodeShare`
 * turn a snapshot into a compressed, Unicode-safe base64url token and back —
 * forgivingly: a corrupt token decodes to `null`, never a throw.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { createWeakCache } from '@jarenjs/core/cache';
import { compressBytes, decompressBytes, MAX_EXPANDED_BYTES } from './share-codec.js';

/** Collection handles share their adapter's root, including unsaved fallback data. */
const storesByStorage = createWeakCache();

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
  // Read once per adapter; every collection writes the same current root.
  // A root or a collection that is not an object (a slot another program or
  // an older format wrote: `5`, `"x"`, a list) holds no documents, so it is
  // replaced instead of throwing at the first save or losing every save.
  const store = storesByStorage.getOrCreate(storage, () => {
    const root = storage.read();
    return isJsonObject(root) ? root : {};
  });
  if (!Object.hasOwn(store, key) || !isJsonObject(store[key])) setObjectMember(store, key, {});
  return {
    save(name, value) { setObjectMember(store[key], name, value); storage.write(store); },
    load(name) { return Object.hasOwn(store[key], name) ? store[key][name] : undefined; },
    remove(name) { delete store[key][name]; storage.write(store); },
    names() { return Object.keys(store[key]).sort(); },
    all() { return store[key]; },
  };
}

/** Starts a compressed token. `~` is outside the base64url alphabet, so a plain token never begins with it; the digit names the codec. */
const COMPRESSED_PREFIX = '~1';

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} token */
function fromBase64Url(token) {
  const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode a snapshot as a share token: its JSON in UTF-8 (Unicode-safe,
 * portable between browser and Node), compressed and written in the
 * base64url alphabet behind a `~1` prefix. A snapshot the compressor does not
 * shrink, or one past `MAX_EXPANDED_BYTES` that `decodeShare` would refuse to
 * expand, is written as plain base64url instead, so a token is never longer
 * than the plain one. A release before the compressed format reads only the
 * plain form; `decodeShare` reads both.
 * @param {any} snapshot
 * @returns {string} the token
 */
export function encodeShare(snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const plain = toBase64Url(bytes);
  if (bytes.length > MAX_EXPANDED_BYTES) return plain;
  const compressed = COMPRESSED_PREFIX + compressBytes(bytes);
  return compressed.length < plain.length ? compressed : plain;
}

/**
 * Decode a token written by `encodeShare`, or by an earlier release that wrote
 * plain base64url only, back to its snapshot, forgivingly.
 * @param {string} token
 * @returns {any} the snapshot object, or `null` when the token is unusable
 */
export function decodeShare(token) {
  try {
    const bytes = token.startsWith('~')
      ? (token.startsWith(COMPRESSED_PREFIX) ? decompressBytes(token.slice(COMPRESSED_PREFIX.length)) : null)
      : fromBase64Url(token);
    if (bytes === null) return null;
    const snapshot = JSON.parse(new TextDecoder().decode(bytes));
    return snapshot !== null && typeof snapshot === 'object' ? snapshot : null;
  }
  catch {
    return null;
  }
}
