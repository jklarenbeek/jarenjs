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
 * seed it themselves from `FNV1A_OFFSET_BASIS`. Heading slugs come from
 * the same place for the same reason: `slugify` is a pure text→fragment
 * transform with no Markdown knowledge, so the suite keeps exactly one
 * of it. The remaining helpers are md's own allocation-light scanner
 * utilities.
 */

import { slugify } from '@jarenjs/core/string';

export { hashContent, fnv1a, FNV1A_OFFSET_BASIS, slugify } from '@jarenjs/core/string';

/**
 * The `id` for one heading, unique within one emission.
 *
 * Both emitters mint ids, so the rule lives here once: slug the text,
 * substitute `section` when nothing slug-worthy survives, number
 * repeats the way GitHub numbers them (`setup`, `setup-1`, `setup-2`)
 * and prefix the result. The COUNTER belongs to the caller — one map per
 * emission, never shared with another numbering (a block key's hash and
 * a slug share a namespace only by accident, and a collision there would
 * shift an unrelated heading's number).
 *
 * @param {string} text the heading's plain text (`textOf`)
 * @param {Map<string, number>} seen the emission's slug counter
 * @param {string} prefix prepended to the result
 * @returns {string}
 */
export function headingId(text, seen, prefix) {
  const base = slugify(text) || 'section';
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return prefix + (count === 0 ? base : base + '-' + count);
}

/**
 * The accessible name for a heading's permalink affordance — `#` alone
 * names nothing, so the link says which section it points at.
 * @param {string} text the heading's plain text (`textOf`)
 * @returns {string}
 */
export function permalinkLabel(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 'Permalink to this section' : 'Permalink to ' + trimmed;
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
