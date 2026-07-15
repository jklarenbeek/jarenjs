// I-Regexp: An Interoperable Regular Expression Format
// https://www.rfc-editor.org/rfc/rfc9485.html
//
// A complete RFC 9485 validator and translator to ECMAScript RegExp,
// used by the JSONPath engine (json/path.js) for the match()/search()
// function extensions of RFC 9535.

import {
  isDigitCode,
} from '../scan.js';

// single-character escapes allowed by RFC 9485: \( \) \* \+ \- \. \? \[ \\ \] \^ \n \r \t \{ \| \}
const IREGEXP_SINGLE_ESC = '()*+-.?[\\]^nrt{|}';

// Unicode general categories allowed in \p{...} / \P{...} (RFC 9485):
// the key is the major category, the value the allowed subcategory letters
const IREGEXP_CATEGORIES = {
  L: 'lmotu',
  M: 'cen',
  N: 'dlo',
  P: 'cdefios',
  Z: 'lps',
  S: 'ckmo',
  C: 'cfno',
};

/**
 * Validate an I-Regexp (RFC 9485) against its complete ABNF grammar and
 * translate it to an equivalent ECMAScript pattern (RFC 9485 section 5.3):
 *
 * - unescaped dots outside character classes become [^\n\r]
 * - '\-' outside a character class becomes '-' (not a valid ECMAScript
 *   escape under the 'u' flag)
 * - unescaped '^' and '$' (grammatically NormalChars) pass through
 *   unchanged: the RFC's own ECMAScript/PCRE/RE2/Ruby conversions
 *   (sections 5.3/5.4) leave them alone, which gives them anchor
 *   semantics, and the official JSONPath compliance test suite expects
 *   exactly that; write '\^' for a literal caret and '[$]' for a
 *   literal dollar ('\$' is not a valid I-Regexp escape)
 *
 * I-Regexp deliberately excludes lookaround, backreferences, lazy
 * quantifiers, multi-character escapes (\d \s \w), and inline flags; per
 * RFC 9535 sections 2.4.6/2.4.7 a nonconforming pattern makes
 * match()/search() yield LogicalFalse, so this returns null for them.
 *
 * @param {string} pattern - The I-Regexp pattern
 * @returns {string|null} The ECMAScript pattern source, or null when invalid
 */
export function translateIRegexp(pattern) {
  const n = pattern.length;
  let i = 0;
  let out = '';

  // reads the code point at i; -1 marks a lone surrogate (not a
  // Unicode scalar value, so never valid in an I-Regexp)
  function codePoint() {
    const c = pattern.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDFFF) {
      if (c >= 0xDC00 || i + 1 >= n)
        return -1;
      const d = pattern.charCodeAt(i + 1);
      return (d >= 0xDC00 && d <= 0xDFFF) ? pattern.codePointAt(i) : -1;
    }
    return c;
  }

  function emitCodePoint(cp) {
    const width = cp > 0xFFFF ? 2 : 1;
    out += pattern.slice(i, i + width);
    i += width;
  }

  // NormalChar = %x00-27 / "," / "-" / %x2F-3E / %x40-5A / %x5E-7A / %x7E-D7FF / %xE000-10FFFF
  function isNormalChar(cp) {
    return cp <= 0x27
      || cp === 0x2C || cp === 0x2D
      || (cp >= 0x2F && cp <= 0x3E)
      || (cp >= 0x40 && cp <= 0x5A)
      || (cp >= 0x5E && cp <= 0x7A)
      || cp >= 0x7E; // codePoint() already excluded surrogates
  }

  // CCchar = %x00-2C / %x2E-5A / %x5E-D7FF / %xE000-10FFFF (or SingleCharEsc)
  function isCCchar(cp) {
    return cp !== 0x2D && cp !== 0x5B && cp !== 0x5C && cp !== 0x5D;
  }

  // "\" already consumed; SingleCharEsc / catEsc / complEsc
  function parseEscape(inClass) {
    if (i >= n)
      return false;
    const ch = pattern[i];
    if (ch === 'p' || ch === 'P') {
      i++;
      if (pattern[i] !== '{')
        return false;
      i++;
      const sub = IREGEXP_CATEGORIES[pattern[i]];
      if (sub === undefined)
        return false;
      let prop = pattern[i];
      i++;
      if (pattern[i] !== '}') {
        if (i >= n || !sub.includes(pattern[i]))
          return false;
        prop += pattern[i];
        i++;
        if (pattern[i] !== '}')
          return false;
      }
      i++;
      out += '\\' + ch + '{' + prop + '}';
      return true;
    }
    if (!IREGEXP_SINGLE_ESC.includes(ch))
      return false;
    // '\-' is a valid I-Regexp escape but not a valid ECMAScript 'u'
    // escape outside a character class
    out += (ch === '-' && !inClass) ? '-' : '\\' + ch;
    i++;
    return true;
  }

  // CCE1 = ( CCchar [ "-" CCchar ] ) / charClassEsc
  function parseCCE1() {
    let rangeStart = false; // \p{...} cannot start a range
    if (pattern.charCodeAt(i) === 0x5C) { // backslash
      i++;
      const isCat = pattern[i] === 'p' || pattern[i] === 'P';
      if (!parseEscape(true))
        return false;
      rangeStart = !isCat;
    }
    else {
      const cp = codePoint();
      if (cp < 0 || !isCCchar(cp))
        return false;
      emitCodePoint(cp);
      rangeStart = true;
    }
    // optional range: "-" CCchar (a trailing "-]" belongs to the class)
    if (rangeStart && pattern[i] === '-' && i + 1 < n && pattern[i + 1] !== ']') {
      out += '-';
      i++;
      if (pattern.charCodeAt(i) === 0x5C) {
        i++;
        return pattern[i] !== 'p' && pattern[i] !== 'P' && parseEscape(true);
      }
      const cp = codePoint();
      if (cp < 0 || !isCCchar(cp))
        return false;
      emitCodePoint(cp);
    }
    return true;
  }

  // charClassExpr = "[" [ "^" ] ( "-" / CCE1 ) *CCE1 [ "-" ] "]"
  // (with the extra RFC 9485 restriction that "[^]" is not allowed)
  function parseCharClassExpr() {
    out += '[';
    i++; // consume '['
    if (pattern[i] === '^') {
      out += '^';
      i++;
    }
    if (pattern[i] === '-') {
      out += '\\-';
      i++;
    }
    else if (i >= n || pattern[i] === ']' || !parseCCE1()) {
      return false;
    }
    for (;;) {
      if (i >= n)
        return false;
      const ch = pattern[i];
      if (ch === ']') {
        out += ']';
        i++;
        return true;
      }
      if (ch === '-') { // only valid as the trailing "-]"
        if (pattern[i + 1] !== ']')
          return false;
        out += '\\-]';
        i += 2;
        return true;
      }
      if (!parseCCE1())
        return false;
    }
  }

  // atom = NormalChar / charClass / ( "(" i-regexp ")" )
  function parseAtom() {
    const ch = pattern[i];
    if (ch === '(') {
      out += '(';
      i++;
      if (!parseAlternation())
        return false;
      if (pattern[i] !== ')')
        return false;
      out += ')';
      i++;
      return true;
    }
    if (ch === '.') { // matches any character except \n and \r
      out += '[^\\n\\r]';
      i++;
      return true;
    }
    if (ch === '\\') {
      i++;
      return parseEscape(false);
    }
    if (ch === '[')
      return parseCharClassExpr();
    const cp = codePoint();
    if (cp < 0 || !isNormalChar(cp))
      return false;
    emitCodePoint(cp);
    return true;
  }

  // piece = atom [ quantifier ]
  function parsePiece() {
    if (!parseAtom())
      return false;
    const ch = pattern[i];
    if (ch === '*' || ch === '+' || ch === '?') {
      out += ch;
      i++;
    }
    else if (ch === '{') { // range-quantifier = "{" QuantExact [ "," [ QuantExact ] ] "}"
      let j = i + 1;
      const first = j;
      while (j < n && isDigitCode(pattern.charCodeAt(j)))
        j++;
      if (j === first)
        return false;
      if (pattern[j] === ',') {
        j++;
        while (j < n && isDigitCode(pattern.charCodeAt(j)))
          j++;
      }
      if (pattern[j] !== '}')
        return false;
      out += pattern.slice(i, j + 1);
      i = j + 1;
    }
    return true;
  }

  // branch = *piece
  function parseBranch() {
    while (i < n) {
      const ch = pattern[i];
      if (ch === '|' || ch === ')')
        return true;
      if (!parsePiece())
        return false;
    }
    return true;
  }

  // i-regexp = branch *( "|" branch )
  function parseAlternation() {
    if (!parseBranch())
      return false;
    while (pattern[i] === '|') {
      out += '|';
      i++;
      if (!parseBranch())
        return false;
    }
    return true;
  }

  return (parseAlternation() && i === n) ? out : null;
}

/**
 * Compile an I-Regexp into an ECMAScript RegExp.
 * @param {string} pattern - The I-Regexp pattern
 * @param {boolean} [fullMatch=false] - Anchor the whole pattern (match() semantics, true) or leave it free (search() semantics, false)
 * @returns {RegExp|null} null when the pattern is not a valid I-Regexp
 */
export function compileIRegexp(pattern, fullMatch = false) {
  const translated = translateIRegexp(pattern);
  if (translated === null)
    return null;
  try {
    return new RegExp(fullMatch ? `^(?:${translated})$` : translated, 'u');
  }
  catch {
    return null;
  }
}

/**
 * Validates a pattern against the complete I-Regexp (RFC 9485) grammar.
 * @param {string} pattern - The I-Regexp pattern to validate
 * @returns {boolean} True when the pattern is a valid I-Regexp
 */
export function isValidIRegexp(pattern) {
  return typeof pattern === 'string' && translateIRegexp(pattern) !== null;
}
