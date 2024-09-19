//@ts-check

import {
  isStringType,
  isObjectOfClass,
} from './index.js';

//#region String Tools
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
        return new RegExp(r, g);
      }
    }
    else
      return new RegExp(pattern);
  }

  throw new Error(`Unknown Regular Expression Pattern Type: ${pattern}`);
}
