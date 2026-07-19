//@ts-check
/**
 * @file Pie grammar → pie AST. `pie [showData]` then `"label" : value`
 * rows, with an optional `title …`.
 */

import { stripQuotes } from './flowchart.js';

/** `"label" : 42` (label may be unquoted). */
const RE_SLICE = /^(".*?"|[^:]+?)\s*:\s*([0-9]*\.?[0-9]+)\s*$/;

/**
 * @param {string[]} lines
 * @param {number} lineOffset
 * @param {string} header
 * @returns {object}
 */
export function parsePie(lines, lineOffset, header) {
  const showData = /\bshowData\b/.test(header);
  let title = null;
  const slices = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '') continue;
    if (line.startsWith('title ')) { title = line.slice('title '.length).trim(); continue; }
    const m = RE_SLICE.exec(line);
    if (m !== null) {
      slices.push({ label: stripQuotes(m[1].trim()), value: Number(m[2]) });
    }
  }
  return { title, showData, slices };
}
