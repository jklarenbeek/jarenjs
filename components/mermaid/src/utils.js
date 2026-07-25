//@ts-check
/**
 * @file Small shared helpers for the mermaid engine.
 *
 * `hashContent` and `coord` are re-exported rather than re-implemented, so
 * this package agrees with the rest of the suite by construction:
 * `hashContent` is the one content fingerprint (the same source produces
 * the same vnode `key`, `meta.hash` and memo key whether it flows through
 * the Markdown engine or this one), and `coord` is the one SVG coordinate
 * quantization, so a layout pass emits geometry at exactly the precision
 * the renderer would round it to — which is what keeps the golden JSON and
 * the SVG it renders to byte-stable instead of carrying float noise.
 */

export { hashContent } from '@jarenjs/core/string';
export { coord } from '@jarenjs/view/helpers';

/**
 * The first whitespace-delimited token of a line: everything up to the
 * first space or tab (the whole line when there is neither). The
 * grammars are line-oriented and keyword-led, so this is how both the
 * type dispatcher and the sequence parser read a line's keyword —
 * no allocation beyond the returned slice.
 * @param {string} line
 * @returns {string}
 */
export function firstToken(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) !== 0x20 && line.charCodeAt(i) !== 0x09) i++;
  return line.slice(0, i);
}

/**
 * Split a source string into lines, dropping a single trailing newline
 * and normalizing CRLF/CR to LF first. Comment/blank stripping is the
 * caller's job (each dialect handles its own comment marker).
 * @param {string} source
 * @returns {string[]}
 */
export function toLines(source) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const end = normalized.endsWith('\n') ? normalized.length - 1 : normalized.length;
  return normalized.slice(0, end).split('\n');
}
