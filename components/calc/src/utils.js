//@ts-check
/**
 * @file Small shared helpers for the calc engine.
 *
 * `hashContent` is copied byte-for-byte from `@jarenjs/md`
 * (`components/md/src/utils.js`) and `@jarenjs/mermaid` so a content
 * fingerprint is identical across the suite: equal content hits the same
 * O(1) fast path (vnode `key`, memo key) everywhere downstream. Do NOT
 * invent a second hash.
 */

/**
 * FNV-1a 32-bit hash of a string, unsigned base-36 (≤ 7 chars). Not
 * cryptographic — a stable, fast content fingerprint for cache and
 * reconciliation keys.
 * @param {string} str
 * @returns {string}
 */
export function hashContent(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
