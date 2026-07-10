//@ts-check

import {
  isStringType,
  isObjectOfClass,
} from './index.js';

export function isStringEmpty(data) {
  return typeof data === 'string' && !data;
}

export function isStringWhiteSpace(data) {
  return data == null || /^\s*$/.test(data);
}

export function isStringUpperCase(str) {
  return str === str.toUpperCase();
}

export function isStringLowerCase(str) {
  return str === str.toLowerCase();
}

export function isRegExpType(data) {
  return isObjectOfClass(data, RegExp);
}

export function isStringRegExp(str) {
  try {
    return createRegExp(str) != null;
  }
  // eslint-disable-next-line no-unused-vars
  catch (e) {
    return false;
  }
}

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

  throw new Error(`Unknown Regular Expression Pattern Type: ${pattern}`);
}

let segmenterCache = null;
export function getSegmenter() {
  if (segmenterCache === null) {
    segmenterCache = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  }
  return segmenterCache;
}

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
const COMPLEX_GRAPHEME_REGEX = /[\r\p{M}\p{Join_Control}\p{Emoji_Modifier}\p{Regional_Indicator}\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\uFE00-\uFE0F\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF\u{110BD}\u{110CD}\u{E0000}-\u{E007F}]/u;

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
      let count = i;
      for (let j = i; j < len; j++) {
        const c = str.charCodeAt(j);
        if (c >= 0xD800 && c <= 0xDBFF) j++;
        count++;
      }
      return count;
    }
  }
  return len;
}
