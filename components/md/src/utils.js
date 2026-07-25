//@ts-check
/**
 * @file Small shared helpers for the md package.
 *
 * The content hash is the package's identity primitive — block vnode
 * keys, the document `meta.hash`, and the mermaid SVG cache are all keyed
 * by it — so md re-exports the suite's single `hashContent` from
 * `@jarenjs/core` rather than carrying its own copy; equal content hits
 * O(1) fast paths everywhere downstream. `fnv1a` is that same mixing
 * step, exposed for the two callers that fold a hash incrementally (the
 * streaming parser's chunks, the structural block-key walk) and so must
 * seed it themselves from `FNV1A_OFFSET_BASIS`. The remaining helpers
 * are md's own allocation-light scanner utilities.
 */

export { hashContent, fnv1a, FNV1A_OFFSET_BASIS } from '@jarenjs/core/string';

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
