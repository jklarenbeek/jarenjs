//@ts-check
/**
 * @file Small shared helpers for the md package.
 *
 * Everything here is allocation-light and dependency-free. The content
 * hash is the package's identity primitive: block vnode keys, the
 * document `meta.hash`, and the mermaid SVG cache are all keyed by it,
 * so equal content hits O(1) fast paths everywhere downstream.
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
 * Count leading space characters (U+0020 only; the scanner expands no
 * tabs here — callers pass detabbed text).
 * @param {string} line
 * @returns {number}
 */
export function countIndent(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i;
}

/**
 * Is the line blank (empty or whitespace-only)?
 * @param {string} line
 * @returns {boolean}
 */
export function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Replace tabs with spaces to the next 4-column tab stop, counting
 * columns from `startColumn`. Lines without tabs return the same
 * string reference (the common case allocates nothing).
 * @param {string} line
 * @param {number} [startColumn]
 * @returns {string}
 */
export function expandTabs(line, startColumn = 0) {
  if (line.indexOf('\t') === -1) return line;
  let out = '';
  let column = startColumn;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const width = 4 - (column % 4);
      out += '    '.slice(0, width);
      column += width;
    }
    else {
      out += ch;
      column++;
    }
  }
  return out;
}
