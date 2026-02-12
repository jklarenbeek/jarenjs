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

export function getStringLength(str, useGrapheme = false) {
  if (!useGrapheme) {
    return str.length;
  }
  // Fast-path: check ASCII inline to avoid function call overhead
  const len = str.length;
  for (let i = 0; i < len; i++) {
    if (str.charCodeAt(i) > 127) {
      // Non-ASCII found - use grapheme counting
      let count = i;
      for (const _ of getSegmenter().segment(str.slice(i))) count++;
      return count;
    }
  }
  return len;
}
