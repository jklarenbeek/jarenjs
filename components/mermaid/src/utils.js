//@ts-check
/**
 * @file Small shared helpers for the mermaid engine.
 *
 * Dependency-free and allocation-light. `hashContent` is copied
 * byte-for-byte from `@jarenjs/md` (`components/md/src/utils.js:19-26`)
 * so a diagram's content fingerprint is identical across the suite:
 * the same source produces the same vnode `key`, `meta.hash` and memo
 * key whether it flows through the Markdown engine or this one. Do NOT
 * invent a second hash — equal content must hit the same O(1) fast path
 * everywhere downstream.
 */

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned base-36
 * string (at most 7 chars). Not cryptographic — a stable, fast content
 * fingerprint for cache keys and reconciliation keys.
 *
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

/**
 * Split a source string into lines, dropping a single trailing newline
 * and normalizing CRLF/CR to LF first. Comment/blank stripping is the
 * caller's job (each diarect handles its own comment marker).
 * @param {string} source
 * @returns {string[]}
 */
export function toLines(source) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const end = normalized.endsWith('\n') ? normalized.length - 1 : normalized.length;
  return normalized.slice(0, end).split('\n');
}

/**
 * Is the code point ASCII whitespace (space or tab)?
 * @param {number} c
 * @returns {boolean}
 */
export function isSpaceCode(c) {
  return c === 0x20 || c === 0x09;
}

/**
 * Trim ASCII whitespace from both ends without allocating when the
 * string is already trimmed.
 * @param {string} s
 * @returns {string}
 */
export function trim(s) {
  return s.trim();
}
