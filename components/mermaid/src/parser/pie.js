//@ts-check
/**
 * @file Pie grammar → pie AST. `pie [showData] [title …]` then
 * `"label" : value` rows, with an optional `title …` row; the title may
 * stand on the header line (`pie title Pets`, Mermaid's own docs example)
 * or on its own, and a later one replaces an earlier one. A `%%` comment
 * ends a title and may follow a slice's value, as Mermaid reads them.
 */

import { stripQuotes } from './flowchart.js';

/** `"label" : 42` (label may be unquoted), a `%%` comment after it ignored. */
const RE_SLICE = /^(".*?"|[^:]+?)\s*:\s*([0-9]*\.?[0-9]+)\s*(?:%%.*)?$/;

/** The header's `title` keyword, after `pie` and any `showData`. */
const RE_HEADER_TITLE = /[\t ]title(?:[\t ]|$)/;

/** A `title` statement and its text, on the header line or its own. */
const RE_TITLE = /^title(?:[\t ]+(.*))?$/;

/**
 * A title statement's text, up to a `%%` comment (quoted or not, as
 * Mermaid reads it): a blank one reads as no title.
 * @param {RegExpExecArray} m a {@link RE_TITLE} match
 * @returns {string|null}
 */
const titleText = (m) => m[1]?.split('%%', 1)[0].trim() || null;

/**
 * @param {string[]} lines
 * @param {number} lineOffset
 * @param {string} header
 * @returns {object}
 */
export function parsePie(lines, lineOffset, header) {
  // `showData` is read only before the title: `pie title Pets showData` is
  // titled "Pets showData", as Mermaid reads it
  const at = RE_HEADER_TITLE.exec(header);
  const showData = /\bshowData\b/.test(at === null ? header : header.slice(0, at.index));
  const inHeader = at === null ? null : RE_TITLE.exec(header.slice(at.index + 1));
  let title = inHeader === null ? null : titleText(inHeader);
  const slices = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '') continue;
    const own = RE_TITLE.exec(line);
    if (own !== null) { title = titleText(own); continue; }
    const m = RE_SLICE.exec(line);
    if (m !== null) {
      slices.push({ label: stripQuotes(m[1].trim()), value: Number(m[2]) });
    }
  }
  return { title, showData, slices };
}
