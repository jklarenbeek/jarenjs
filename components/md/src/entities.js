//@ts-check
/**
 * @file Markdown's character references: named ones read from the HTML
 * standard's table, which `@jarenjs/core/text/entities` holds (CommonMark's
 * "entity and numeric character references" section defers to it, all of
 * it), decimal and hexadecimal ones computed.
 */

import { namedEntities } from '@jarenjs/core/text/entities';

/** A character reference: named, decimal or hexadecimal. */
const RE_ENTITY = /^&(?:#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[a-zA-Z][a-zA-Z0-9]{1,31};)/;

/**
 * Decode one character reference at `pos` (`&...;`). Returns null when it
 * is not a valid reference — an `&` that starts nothing is ordinary text,
 * which is why this reports rather than throws.
 * @param {string} src
 * @param {number} pos
 * @returns {{ value: string, end: number } | null}
 */
export function scanEntity(src, pos) {
  const m = RE_ENTITY.exec(pos === 0 ? src : src.slice(pos));
  if (m === null) return null;
  const body = m[0].slice(1, -1);
  if (body.charCodeAt(0) === 0x23 /* # */) {
    const cp = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    // U+0000 and out-of-range code points are the replacement character,
    // never a thrown error: a document may contain anything
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10FFFF)
      return { value: '\uFFFD', end: pos + m[0].length };
    return { value: String.fromCodePoint(cp), end: pos + m[0].length };
  }
  const named = namedEntities().get(body);
  return named === undefined ? null : { value: named, end: pos + m[0].length };
}

/**
 * Resolve backslash escapes and character references in a run of text.
 *
 * CommonMark processes both in the three places that are NOT inline
 * content — link destinations, link titles and fence info strings — so
 * they share this one pass rather than each re-deriving it.
 * @param {string} text
 * @returns {string}
 */
export function decodeReferences(text) {
  if (text.indexOf('\\') === -1 && text.indexOf('&') === -1) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x5C /* \\ */ && i + 1 < text.length && isEscapable(text.charCodeAt(i + 1))) {
      out += text[i + 1];
      i += 2;
      continue;
    }
    if (code === 0x26 /* & */) {
      const entity = scanEntity(text, i);
      if (entity !== null) {
        out += entity.value;
        i = entity.end;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** ASCII punctuation — the only characters a backslash may escape. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ESCAPABLE[ch.charCodeAt(0)] = 1;

function isEscapable(code) {
  return code < 128 && ESCAPABLE[code] === 1;
}
