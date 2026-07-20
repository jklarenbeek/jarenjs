//@ts-check
/**
 * @file Small shared helpers for the mermaid engine.
 *
 * `hashContent` is the suite's single content-fingerprint primitive and is
 * re-exported from `@jarenjs/core` (not re-implemented here) so a diagram's
 * fingerprint is identical across the suite: the same source produces the
 * same vnode `key`, `meta.hash` and memo key whether it flows through the
 * Markdown engine or this one.
 */

export { hashContent } from '@jarenjs/core/string';

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
