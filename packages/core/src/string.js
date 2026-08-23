//@ts-check

import {
  isStringType,
  isObjectOfClass,
} from './index.js';

/**
 * @param {string | null | undefined} data
 * @returns {boolean}
 */
export function isStringEmpty(data) {
  return typeof data === 'string' && !data;
}

/**
 * @param {string | null | undefined} data
 * @returns {boolean}
 */
export function isStringWhiteSpace(data) {
  return data == null || /^\s*$/.test(data);
}

/**
 * @param {string} str
 * @returns {boolean}
 */
export function isStringUpperCase(str) {
  return str === str.toUpperCase();
}

/**
 * @param {string} str
 * @returns {boolean}
 */
export function isStringLowerCase(str) {
  return str === str.toLowerCase();
}

/**
 * @param {unknown} data
 * @returns {data is RegExp}
 */
export function isRegExpType(data) {
  return isObjectOfClass(data, RegExp);
}


/**
 * @param {string | RegExp | null | undefined } data
 * @returns {boolean}
 */
export function isStringRegExp(data) {
  try {
    return createRegExp(data) != null;
  }
  // eslint-disable-next-line no-unused-vars
  catch (e) {
    return false;
  }
}

/**
 * @param {string | RegExp | null | undefined } pattern
 * @returns {RegExp | undefined}
 */
export function createRegExp(pattern) {
  if (pattern == null)
    return undefined;

  if (isRegExpType(pattern))
    return pattern;

  if (isStringType(pattern)) {
    if (pattern[0] === '/') {
      const e = pattern.lastIndexOf('/');
      if (e >= 0) {
        const r = pattern.substring(1, e);
        const g = pattern.substring(e + 1);
        // Add unicode flag if not already present
        return g.includes('u') ? new RegExp(r, g) : new RegExp(r, g + 'u');
      }
    }
    else
      return new RegExp(pattern, 'u');
  }
  // TODO: should we return false instead?
  throw new Error(`Unknown Regular Expression Pattern Type: ${pattern}`);
}

/**
 * @type {Intl.Segmenter | null}
 */
let segmenterCache = null;
export function getSegmenter() {
  if (segmenterCache === null) {
    segmenterCache = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  }
  return segmenterCache;
}

/**
 * @param {string} str
 * @returns {boolean}
 */
export function isAsciiString(str) {
  const len = str.length;
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) > 127) return false;
  }
  return true;
}

// Characters that can merge with neighbours into a multi-codepoint grapheme
// cluster: CR (CRLF), combining marks, ZWJ/ZWNJ, variation selectors,
// emoji modifiers, regional indicators (flags), conjoining Hangul jamo,
// prepended concatenation marks and tag characters. When none of these are
// present, grapheme count equals code point count and the (expensive)
// Intl.Segmenter can be skipped.
// (U+0600-0605, 06DD, 070F, 0890, 0891, 08E2, 110BD, 110CD are the
// Prepended_Concatenation_Mark set, which V8 does not expose as \p{...})
// eslint-disable-next-line no-misleading-character-class -- intentional grapheme-cluster detector: this char class deliberately mixes combining marks, join-controls, emoji modifiers, regional indicators and prepended concatenation marks to fast-path the Intl.Segmenter skip.
const COMPLEX_GRAPHEME_REGEX = /[\r\p{M}\p{Join_Control}\p{Emoji_Modifier}\p{Regional_Indicator}\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\uFE00-\uFE0F\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF\u{110BD}\u{110CD}\u{E0000}-\u{E007F}]/u;

/**
 * @param {string} str
 * @param {boolean} [useGrapheme=false]
 * @returns {number}
 */
export function getStringLength(str, useGrapheme = false) {
  if (!useGrapheme) {
    return str.length;
  }
  // Fast-path: check ASCII inline to avoid function call overhead
  const len = str.length;
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) > 127) {
      // Non-ASCII found - use grapheme counting.
      // Segment the whole string: a cluster may span the ASCII boundary
      // (e.g. 'e' followed by a combining accent).
      if (COMPLEX_GRAPHEME_REGEX.test(str)) {
        let count = 0;
        for (const _ of getSegmenter().segment(str)) count++;
        return count;
      }
      // No cluster-forming characters: count code points (surrogate aware)
      return countCodePoints(str);
    }
  }
  return len;
}

/**
 * Count occurrences of a UTF-16 code unit in a slice of a string.
 * @param {string} str - The string to scan
 * @param {number} code - The char code to count
 * @param {number} [start] - Inclusive start offset (defaults to 0)
 * @param {number} [end] - Exclusive end offset (defaults to full length)
 * @returns {number} Number of occurrences in [start, end)
 */
export function countCharCode(str, code, start = 0, end = str.length) {
  let n = 0;
  for (let i = start; i < end; ++i)
    if (str.charCodeAt(i) === code)
      n++;
  return n;
}

/**
 * Count the Unicode code points of a string (surrogate-pair aware;
 * a lone surrogate counts as one code point).
 * @param {string} str
 * @returns {number}
 */
export function countCodePoints(str) {
  const slen = str.length;
  let count = 0;
  for (let i = 0; i < slen; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < slen) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF)
        i++;
    }
    count++;
  }
  return count;
}

/**
 * Decode a string into its Unicode code points (surrogate-pair aware).
 *
 * `Array.from(str).map(c => c.codePointAt(0))` computes the same thing
 * but allocates a string per character on the way; this reads the code
 * units directly. An unpaired surrogate is kept as its own code point
 * rather than replaced, so the result round-trips through
 * {@link fromCodePoints} and a caller validating text can see the lone
 * surrogate and reject it.
 *
 * @param {string} str - The string to decode
 * @returns {number[]} The code points, in order
 */
export function toCodePoints(str) {
  const slen = str.length;
  const out = [];
  for (let i = 0; i < slen; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < slen) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) {
        out.push((c - 0xD800) * 0x400 + (d - 0xDC00) + 0x10000);
        i++;
        continue;
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * Fewer code points than this and appending one at a time beats
 * spreading the array into `String.fromCodePoint`, whose argument-list
 * setup then costs more than the concatenations it saves. Measured
 * crossover; the two are within a few percent either side of it.
 */
const CODE_POINT_SPREAD_MIN = 8;

/** Code points per spread, so a large array cannot overflow the stack. */
const CODE_POINT_SPREAD_CHUNK = 4096;

/**
 * Build a string from Unicode code points - the inverse of
 * {@link toCodePoints}.
 *
 * @param {number[]} codePoints - The code points to encode
 * @returns {string} The resulting string
 */
export function fromCodePoints(codePoints) {
  const len = codePoints.length;
  if (len < CODE_POINT_SPREAD_MIN) {
    let out = '';
    for (let i = 0; i < len; i++)
      out += String.fromCodePoint(codePoints[i]);
    return out;
  }
  if (len <= CODE_POINT_SPREAD_CHUNK)
    return String.fromCodePoint(...codePoints);

  let out = '';
  for (let i = 0; i < len; i += CODE_POINT_SPREAD_CHUNK)
    out += String.fromCodePoint(...codePoints.slice(i, i + CODE_POINT_SPREAD_CHUNK));
  return out;
}

/**
 * Compare two strings by Unicode scalar values (code points), per
 * RFC 9535 section 2.3.5.2.2. This differs from JavaScript's native
 * `<`, which compares UTF-16 code units and orders surrogate pairs
 * (U+10000 and up) below unpaired BMP characters in U+E000-U+FFFF.
 * When one string is a prefix of the other, the shorter sorts first.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 when a < b, 0 when equal, 1 when a > b
 */
export function compareCodePoints(a, b) {
  const alen = a.length;
  const blen = b.length;
  const m = alen < blen ? alen : blen;
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i))
    i++;
  if (i === m)
    return alen === blen ? 0 : (alen < blen ? -1 : 1);
  // differing code units at i can never decode to equal code points
  return a.codePointAt(i) < b.codePointAt(i) ? -1 : 1;
}

/**
 * The exclusive upper bound of the strings beginning with `prefix`: the
 * smallest string that sorts above every one of them. For a
 * well-formed `value`, `value` begins with `prefix` **iff**
 * `prefix <= value < codePointPrefixSuccessor(prefix)` under
 * {@link compareCodePoints} — which is what lets a caller spell a
 * prefix test as a half-open range, the form an ordered index can seek
 * rather than test row by row.
 *
 * Null when there is no such string, and the caller then has no range
 * to offer: the empty prefix (every string begins with it) and a
 * prefix of nothing but U+10FFFF (nothing sorts above it).
 *
 * The bound never lands in the surrogate range, because it has to be a
 * string the caller can hand on — to a comparator, a database
 * parameter, a serializer. No well-formed string sorts inside that
 * range, so stepping over it leaves the equivalence above intact.
 *
 * @param {string} prefix - The prefix to bound
 * @returns {string | null} The exclusive upper bound, or null when none exists
 */
export function codePointPrefixSuccessor(prefix) {
  const points = toCodePoints(prefix);
  // the last code point that can still be incremented: U+10FFFF cannot,
  // so it drops off and the carry moves left
  let i = points.length - 1;
  while (i >= 0 && points[i] === 0x10FFFF)
    i--;
  if (i < 0)
    return null;
  const next = points[i] + 1;
  points.length = i + 1;
  points[i] = next >= 0xD800 && next <= 0xDFFF ? 0xE000 : next;
  return fromCodePoints(points);
}

/** FNV-1a 32-bit offset basis — the seed a fresh hash starts from. */
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;

/**
 * FNV-1a 32-bit hash of a string, as an unsigned 32-bit number. Not
 * cryptographic — a stable, fast content fingerprint.
 *
 * Pass `seed` to continue an existing hash, which is what lets a caller
 * fold a chunk stream or walk a tree without concatenating the pieces
 * first: `fnv1a(b, fnv1a(a))` equals `fnv1a(a + b)`. Callers that just want
 * a fingerprint string should use {@link hashContent} instead, so the whole
 * suite agrees on one encoding.
 *
 * @param {string} str
 * @param {number} [seed] running hash to continue, unsigned 32-bit
 * @returns {number} unsigned 32-bit hash
 */
export function fnv1a(str, seed = FNV1A_OFFSET_BASIS) {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned base-36 string
 * (at most 7 chars). Not cryptographic — a stable, fast content
 * fingerprint for cache keys and reconciliation keys. The suite's single
 * content-hash primitive: equal content produces the same fingerprint
 * (and therefore the same vnode `key`/memo key) everywhere downstream, so
 * do NOT invent a second hash — {@link fnv1a} is the one mixing step.
 *
 * @param {string} str
 * @returns {string}
 */
export function hashContent(str) {
  return fnv1a(str).toString(36);
}

/**
 * Convert a camelCase identifier to kebab-case by inserting a hyphen
 * before each ASCII uppercase letter and lower-casing it
 * (`fontFamily` → `font-family`). Leaves already-hyphenated or
 * all-lowercase input unchanged.
 *
 * @param {string} s
 * @returns {string}
 */
export function kebabCase(s) {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** One code point that a slug keeps: a letter, a digit, or a combining
 * mark (which belongs to the letter in front of it). Everything else
 * outside ASCII is punctuation, a symbol or an emoji, and is dropped. */
const SLUG_KEEP = /[\p{L}\p{N}\p{M}]/u;

/**
 * Convert heading text into a URL fragment the way GitHub does, so one
 * committed document anchors identically on GitHub, in an editor preview
 * and in a renderer that uses this: lower-case, drop punctuation and
 * symbols, and turn each whitespace character into a hyphen.
 *
 * `-` and `_` survive, as do non-ASCII letters and digits
 * (`Ünicode Wörks` → `ünicode-wörks`); a `§` or an em dash does not,
 * because it is a symbol rather than a letter. Text that reduces to
 * nothing (`***`) yields `''` — what an empty slug means is the caller's
 * decision, not this function's.
 *
 * This is the suite's ONLY slug implementation: a second one would drift
 * from the first and break the promise above. Whitespace is converted one
 * character at a time, not per run, because that is what GitHub does and
 * the resulting `--` is part of the fragment a reader may already have
 * bookmarked.
 *
 * @example
 * slugify('Hello, World!');   // 'hello-world'
 * slugify('§ 3.1 — Setup');   // '-31--setup'
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      if (code >= 0x61 && code <= 0x7a) out += text[i]; // a-z
      else if (code >= 0x41 && code <= 0x5a) out += String.fromCharCode(code + 32); // A-Z
      else if (code >= 0x30 && code <= 0x39) out += text[i]; // 0-9
      else if (code === 0x2d || code === 0x5f) out += text[i]; // - _
      else if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) out += '-';
      continue;
    }
    // Outside ASCII a slug decision needs the whole code point, so an
    // astral pair is read (and skipped over) as one character.
    const point = /** @type {number} */ (text.codePointAt(i));
    const char = String.fromCodePoint(point);
    if (point > 0xffff) i++;
    if (SLUG_KEEP.test(char)) out += char.toLowerCase();
  }
  return out;
}
