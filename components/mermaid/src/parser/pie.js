//@ts-check
/**
 * @file Pie grammar → pie AST. `pie [showData] [title …]` then
 * `"label" : value` rows, with an optional `title …` row; the title may
 * stand on the header line (`pie title Pets`, Mermaid's own docs example)
 * or on its own, and a later one replaces an earlier one. A `%%` comment
 * ends a title and may follow a slice's value, as Mermaid reads them.
 * `accTitle` and `accDescr` lines (and an `accDescr { … }` block) are read
 * past; any other line, and a header word that is neither `showData` nor
 * `title`, is refused, as Mermaid refuses it.
 */

import { stripQuotes } from './flowchart.js';
import { decodeEntityCodes } from '../label-text.js';
import { failWith } from '../errors.js';

/**
 * `"label" : 42` (the label quoted, with `"` or `'`; the value a number of
 * zero or more as Mermaid writes one: no sign, no leading zero, no bare `.`),
 * a `%%` comment after it ignored. A label in `"…"` holds no `"`, as
 * Mermaid reads it (`"a"b" : 1` is refused; `toMermaid` writes a label
 * holding both quote kinds with the `"` as its code `#34;`), and its entity
 * codes read as the characters they draw.
 */
const RE_SLICE = /^("[^"]*"|'[^']*')\s*:\s*((?:0|[1-9][0-9]*)(?:\.[0-9]+)?)\s*(?:%%.*)?$/;

/** An accessibility line, `accTitle: …` or `accDescr: …`, which this tree does not keep. */
const RE_ACCESSIBILITY = /^acc(?:Title|Descr)\s*:/;

/** A multi-line accessible description's opener, `accDescr {`, up to its `}`. */
const RE_DESCRIPTION_BLOCK = /^accDescr\s*\{/;

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
  const words = (at === null ? header : header.slice(0, at.index)).split('%%', 1)[0].slice('pie'.length).trim();
  if (words !== '' && words !== 'showData') {
    failWith('mermaid/pie/header', { word: words.split(/\s+/).find((word) => word !== 'showData') ?? words }, lineOffset);
  }
  const showData = words === 'showData';
  const inHeader = at === null ? null : RE_TITLE.exec(header.slice(at.index + 1));
  let title = inHeader === null ? null : titleText(inHeader);
  const slices = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || RE_ACCESSIBILITY.test(line)) continue;
    if (RE_DESCRIPTION_BLOCK.test(line)) {
      // the block's text is its own, up to the line that closes it
      while (!lines[li].includes('}') && li < lines.length - 1) li++;
      continue;
    }
    const own = RE_TITLE.exec(line);
    if (own !== null) { title = titleText(own); continue; }
    const m = RE_SLICE.exec(line);
    if (m === null) failWith('mermaid/pie/line', { line }, lineOffset + li + 1);
    // an entity code is the character Mermaid draws for it (`#34;` is `"`),
    // as every renderer here draws one: the slice is drawn by an injected
    // renderer that takes the label as text
    slices.push({ label: decodeEntityCodes(stripQuotes(m[1])), value: Number(m[2]) });
  }
  return { title, showData, slices };
}
