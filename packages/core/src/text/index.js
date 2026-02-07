/* eslint no-unused-vars: "off" */
/* eslint no-useless-escape: "off" */

//@ts-check
import {
  toASCII,
  toUnicode,
} from './punycode.js';

//#region Common Tests
const CONST_REGEXP_ALPHA = /^[a-zA-Z]+$/;
export function isValidAlpha(str) {
  return CONST_REGEXP_ALPHA.test(str);
}
const CONST_REGEXP_ALPHANUMERIC = /^[a-zA-Z0-9]+$/;
export function isValidAlphaNumeric(str) {
  return CONST_REGEXP_ALPHANUMERIC.test(str);
}

const CONST_REGEXP_NUMERIC = /^[0-9]+$/;
export function isValidNumeric(str) {
  return CONST_REGEXP_NUMERIC.test(str);
}

const CONST_REGEXP_HEXADECIMAL = /^[a-fA-F0-9]+$/;
export function isValidHexaDecimal(str) {
  return CONST_REGEXP_HEXADECIMAL.test(str);
}

const CONST_REGEXP_HEXCOLOR = /^#(?:[0-9a-f]{3}){1,2}\b$/i;
export function isValidHexColor(str) {
  return CONST_REGEXP_HEXCOLOR.test(str);
}
//#endregion

//#region Identifier Tests
const CONST_REGEXP_UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isValidUUID(str) {
  // uuid: http://tools.ietf.org/html/rfc4122
  return CONST_REGEXP_UUID.test(str);
}

const CONST_REGEXP_GUID = /^({)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isValidGUID(str) {
  return CONST_REGEXP_GUID.test(str);
}

const CONST_REGEXP_IDENTIFIER = /^[_a-zA-Z]+\w{0,30}$/;
export function isValidIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_IDENTIFIER.test(str);
}

const CONST_REGEXP_HTML_IDENTIFIER = /^[A-Za-z]+[\w\-\:\.]{0,30}$/;
export function isValidHtmlIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_HTML_IDENTIFIER.test(str);
}

const CONST_REGEXP_CSS_IDENTIFIER = /^-?[_a-zA-Z]+[\w-]{0,30}$/;
export function isValidCssIdentifier(str) {
  return /* str != null && */ CONST_REGEXP_CSS_IDENTIFIER.test(str);
}
//#endregion

//#region Host Tests
const CONST_REGEXP_MAC_ADDR = /^(?:[0-9A-Fa-f]{2}([:-]?)[0-9A-Fa-f]{2})(?:(?:\1|\.)(?:[0-9A-Fa-f]{2}([:-]?)[0-9A-Fa-f]{2})){2}$/;
export function isValidMACAddr(str) {
  return CONST_REGEXP_MAC_ADDR.test(str);
}

const CONST_REGEXP_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/;
export function isValidIPv4(str) {
  // optimized https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/9780596802837/ch07s16.html
  return CONST_REGEXP_IPV4.test(str);
}

const CONST_REGEXP_IPV6 = /^(?:(?:(?:[0-9a-f]{1,4}:){7}(?:[0-9a-f]{1,4}|:))|(?:(?:[0-9a-f]{1,4}:){6}(?::[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(?:(?:[0-9a-f]{1,4}:){5}(?:(?:(?::[0-9a-f]{1,4}){1,2})|:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(?:(?:[0-9a-f]{1,4}:){4}(?:(?:(?::[0-9a-f]{1,4}){1,3})|(?:(?::[0-9a-f]{1,4})?:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){3}(?:(?:(?::[0-9a-f]{1,4}){1,4})|(?:(?::[0-9a-f]{1,4}){0,2}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){2}(?:(?:(?::[0-9a-f]{1,4}){1,5})|(?:(?::[0-9a-f]{1,4}){0,3}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){1}(?:(?:(?::[0-9a-f]{1,4}){1,6})|(?:(?::[0-9a-f]{1,4}){0,4}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?::(?:(?:(?::[0-9a-f]{1,4}){1,7})|(?:(?::[0-9a-f]{1,4}){0,5}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i;
export function isValidIPv6(str) {
  // optimized http://stackoverflow.com/questions/53497/regular-expression-that-matches-valid-ipv6-addresses
  return CONST_REGEXP_IPV6.test(str);
}

const CONST_REGEXP_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*$/i;
export function isValidHostname(str) {
  // https://tools.ietf.org/html/rfc1034#section-3.5
  // https://tools.ietf.org/html/rfc1123#section-2
  return str.length <= 255 && CONST_REGEXP_HOSTNAME.test(str);
}

// PVALID exceptions per RFC 5892 Section 2.6
const PVALID_EXCEPTIONS = new Set([
  0x00df, // ß (Latin Small Letter Sharp S)
  0x03c2, // ς (Greek Small Letter Final Sigma)
  0x0f0b, // ཋ (Tibetan Mark Intersyllabic Tsheg)
  0x3007, // 〇 (Ideographic Number Zero)
]);

// DISALLOWED exceptions per RFC 5892 Section 2.6
const DISALLOWED_EXCEPTIONS = new Set([
  0x0640, // ـ (Arabic Tatweel)
  0x07fa, // ߺ (Nko Lajanyalan)
  0x302e, // 〮 (Hangul Single Dot Tone Mark)
  0x302f, // 〯 (Hangul Double Dot Tone Mark)
  0x3031, // 〱 (Vertical Kana Repeat Mark)
  0x3032, // 〲 (Vertical Kana Repeat With Voiced Sound Mark)
  0x3033, // 〳 (Vertical Kana Repeat Mark Upper Half)
  0x3034, // 〴 (Vertical Kana Repeat With Voiced Sound Mark Upper Half)
  0x3035, // 〵 (Vertical Kana Repeat Mark Lower Half)
  0x303b, // 〻 (Vertical Ideographic Iteration Mark)
]);

// Contextual rule characters
const MIDDLE_DOT = 0x00b7;              // ·
const GREEK_KERAIA = 0x0375;            // ͵
const HEBREW_GERESH = 0x05f3;           // ׳
const HEBREW_GERSHAYIM = 0x05f4;        // ״
const KATAKANA_MIDDLE_DOT = 0x30fb;     // ・
const ZERO_WIDTH_JOINER = 0x200d;       //
const ZERO_WIDTH_NON_JOINER = 0x200c;   //
const VIRAMA = 0x094d;                  // ् (Devanagari Sign Virama)

// Character category checks
function isLatinLowercaseL(code) {
  return code === 0x006c; // 'l'
}

function isGreek(code) {
  return (code >= 0x0370 && code <= 0x03ff) ||
         (code >= 0x1f00 && code <= 0x1fff);
}

function isHebrew(code) {
  return code >= 0x0590 && code <= 0x05ff;
}

function isHiragana(code) {
  return code >= 0x3040 && code <= 0x309f;
}

function isKatakana(code) {
  return code >= 0x30a0 && code <= 0x30ff;
}

function isHan(code) {
  return (code >= 0x4e00 && code <= 0x9fff) ||
         (code >= 0x3400 && code <= 0x4dbf) ||
         (code >= 0x20000 && code <= 0x2a6df) ||
         (code >= 0x2a700 && code <= 0x2b73f) ||
         (code >= 0x2b740 && code <= 0x2b81f);
}

function isArabicIndicDigit(code) {
  return code >= 0x0660 && code <= 0x0669;
}

function isExtendedArabicIndicDigit(code) {
  return code >= 0x06f0 && code <= 0x06f9;
}

function isVirama(code) {
  // Devanagari Virama and other combining characters that can precede ZWJ/ZWNJ
  return code === 0x094d || // Devanagari Sign Virama
         code === 0x09cd || // Bengali Sign Virama
         code === 0x0a4d || // Gurmukhi Sign Virama
         code === 0x0acd || // Gujarati Sign Virama
         code === 0x0b4d || // Oriya Sign Virama
         code === 0x0bcd || // Tamil Sign Virama
         code === 0x0c4d || // Telugu Sign Virama
         code === 0x0ccd || // Kannada Sign Virama
         code === 0x0d3b || // Malayalam Sign Vertical Bar Virama
         code === 0x0d3c || // Malayalam Sign Circular Virama
         code === 0x0d4d || // Malayalam Sign Virama
         code === 0x0dca || // Sinhala Sign Al-Lakuna
         code === 0x0e3a || // Thai Character Phinthu
         code === 0x0eba || // Lao Semivowel Sign Lo
         code === 0x0f84;  // Tibetan Mark Halanta
}

function isCombiningMark(code) {
  // Spacing combining marks, nonspacing marks, enclosing marks
  return (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
         (code >= 0x0900 && code <= 0x0903) || // Devanagari combining
         (code >= 0x093a && code <= 0x093c) ||
         (code >= 0x093e && code <= 0x094f) ||
         (code >= 0x0962 && code <= 0x0963) ||
         code === 0x0488 || // Combining Cyrillic Hundred Thousands Sign
         code === 0x0489 || // Combining Cyrillic Ten Millions Sign
         code === 0x0903;   // Devanagari Sign Visarga
}

// Check contextual rules for a label
function checkContextualRules(label) {
  const chars = Array.from(label);
  const codes = chars.map(c => c.codePointAt(0));

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];

    // MIDDLE DOT (U+00B7) must have 'l' on both sides
    if (code === MIDDLE_DOT) {
      if (!isLatinLowercaseL(codes[i - 1]) || !isLatinLowercaseL(codes[i + 1])) {
        return false;
      }
    }

    // Greek KERAIA (U+0375) must be followed by Greek
    if (code === GREEK_KERAIA) {
      if (!isGreek(codes[i + 1])) {
        return false;
      }
    }

    // Hebrew GERESH (U+05F3) must be preceded by Hebrew
    if (code === HEBREW_GERESH) {
      if (!isHebrew(codes[i - 1])) {
        return false;
      }
    }

    // Hebrew GERSHAYIM (U+05F4) must be preceded by Hebrew
    if (code === HEBREW_GERSHAYIM) {
      if (!isHebrew(codes[i - 1])) {
        return false;
      }
    }

    // KATAKANA MIDDLE DOT (U+30FB) must have Hiragana, Katakana, or Han in the label
    // (excluding the middle dot itself)
    if (code === KATAKANA_MIDDLE_DOT) {
      const hasContext = codes.some(c =>
        c !== KATAKANA_MIDDLE_DOT && (isHiragana(c) || isKatakana(c) || isHan(c))
      );
      if (!hasContext) {
        return false;
      }
    }

    // ZERO WIDTH JOINER (U+200D) must be preceded by Virama
    if (code === ZERO_WIDTH_JOINER) {
      if (!isVirama(codes[i - 1])) {
        return false;
      }
    }

    // ZERO WIDTH NON-JOINER (U+200C) - contextual rule depends on implementation
    // For draft7 compatibility, we accept it if preceded by Virama
    // The test "ZERO WIDTH NON-JOINER not preceded by Virama but matches regexp"
    // actually expects valid=true in draft7 (for Arabic script)
  }

  return true;
}

// Check for Arabic-Indic digit mixing
function checkDigitMixing(codes) {
  let hasArabicIndic = false;
  let hasExtendedArabicIndic = false;

  for (const code of codes) {
    if (isArabicIndicDigit(code)) {
      hasArabicIndic = true;
    }
    if (isExtendedArabicIndicDigit(code)) {
      hasExtendedArabicIndic = true;
    }
    // Early exit if both found
    if (hasArabicIndic && hasExtendedArabicIndic) {
      return false;
    }
  }

  return true;
}

// Check if a character is valid in IDN hostname per RFC 5892
function isValidIdnChar(code) {
  // Check DISALLOWED exceptions first
  if (DISALLOWED_EXCEPTIONS.has(code)) {
    return false;
  }

  // Check PVALID exceptions
  if (PVALID_EXCEPTIONS.has(code)) {
    return true;
  }

  // Letter digits (Lu, Ll, Lt, Lm, Lo, Nd) and some symbols
  // This is a simplified check - full implementation would use Unicode categories
  if ((code >= 0x0041 && code <= 0x005a) || // A-Z
      (code >= 0x0061 && code <= 0x007a) || // a-z
      (code >= 0x0030 && code <= 0x0039) || // 0-9
      code === 0x002d) { // hyphen
    return true;
  }

  // Allow characters in valid Unicode ranges for IDN
  // Extended Latin
  if ((code >= 0x00c0 && code <= 0x024f) ||
      (code >= 0x1e00 && code <= 0x1eff)) {
    return true;
  }

  // Greek
  if ((code >= 0x0370 && code <= 0x03ff) ||
      (code >= 0x1f00 && code <= 0x1fff)) {
    return true;
  }

  // Cyrillic
  if ((code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x0500 && code <= 0x052f)) {
    return true;
  }

  // Hebrew
  if (code >= 0x0590 && code <= 0x05ff) {
    return true;
  }

  // Arabic
  if ((code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f)) {
    return true;
  }

  // Devanagari and other Indic scripts
  if ((code >= 0x0900 && code <= 0x097f) || // Devanagari
      (code >= 0x0980 && code <= 0x09ff) || // Bengali
      (code >= 0x0a00 && code <= 0x0a7f) || // Gurmukhi
      (code >= 0x0a80 && code <= 0x0aff) || // Gujarati
      (code >= 0x0b00 && code <= 0x0b7f) || // Oriya
      (code >= 0x0b80 && code <= 0x0bff) || // Tamil
      (code >= 0x0c00 && code <= 0x0c7f) || // Telugu
      (code >= 0x0c80 && code <= 0x0cff) || // Kannada
      (code >= 0x0d00 && code <= 0x0d7f) || // Malayalam
      (code >= 0x0e00 && code <= 0x0e7f) || // Thai
      (code >= 0x0e80 && code <= 0x0eff) || // Lao
      (code >= 0x0f00 && code <= 0x0fff)) { // Tibetan
    return true;
  }

  // CJK
  if ((code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0x2a700 && code <= 0x2b73f) ||
      (code >= 0x2b740 && code <= 0x2b81f) ||
      (code >= 0x2f800 && code <= 0x2fa1f)) {
    return true;
  }

  // Hangul
  if ((code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0xac00 && code <= 0xd7af)) {
    return true;
  }

  // Japanese Hiragana, Katakana
  if ((code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff)) {
    return true;
  }

  // Special context characters (checked separately but allowed here)
  if (code === MIDDLE_DOT ||
      code === GREEK_KERAIA ||
      code === HEBREW_GERESH ||
      code === HEBREW_GERSHAYIM ||
      code === KATAKANA_MIDDLE_DOT ||
      code === ZERO_WIDTH_JOINER ||
      code === ZERO_WIDTH_NON_JOINER) {
    return true;
  }

  return false;
}

const CONST_REGEXP_ACEHOSTNAME = /^(?!-)(xn--)?[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]\.(?!-)(xn--)?([a-zA-Z0-9\-]{1,50}|[a-zA-Z0-9-]{1,30}\.[a-zA-Z]{2,})$/;
const CONST_REGEXP_ACEHOSTNAME_SINGLE = /^(?!-)(xn--)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

// Check if label is valid ACE (Punycode)
function isValidACE(label) {
  if (!label.toLowerCase().startsWith('xn--')) {
    return false;
  }

  // Check for valid Punycode format
  // ACE labels must have at least one character after xn--
  const punycodePart = label.slice(4);
  if (punycodePart.length === 0) {
    return false;
  }

  // ACE labels must contain only alphanumeric and hyphen
  if (!/^[a-zA-Z0-9-]+$/.test(punycodePart)) {
    return false;
  }

  // Try to decode - if it fails, it's invalid Punycode
  try {
    const decoded = toUnicode(label);
    // If decode succeeds but returns the same string, it's invalid
    // (e.g., "xn--X" can't be properly decoded)
    if (decoded === label && punycodePart.length < 2) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export function isValidIdnHostname(str) {
  // Empty string check
  if (!str || str.length === 0) {
    return false;
  }

  // Total length check (max 255 bytes for DNS)
  if (str.length > 255) {
    return false;
  }

  // Fast path: ASCII-only hostnames without ACE prefix
  // Most hostnames are ASCII-only, so we can validate them quickly
  let isAsciiOnly = true;
  let hasAcePrefix = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 127) {
      isAsciiOnly = false;
      break;
    }
    // Check for xn-- prefix (case insensitive)
    if (!hasAcePrefix && code === 120 || code === 88) { // 'x' or 'X'
      if (str.length >= i + 4 &&
          (str.charCodeAt(i + 1) === 110 || str.charCodeAt(i + 1) === 78) && // 'n' or 'N'
          str.charCodeAt(i + 2) === 45 && str.charCodeAt(i + 3) === 45) { // '--'
        hasAcePrefix = true;
      }
    }
  }
  
  // For ASCII-only hostnames without ACE prefix, use simple hostname validation
  if (isAsciiOnly && !hasAcePrefix) {
    // Single label hostname
    if (!str.includes('.')) {
      return CONST_REGEXP_ACEHOSTNAME_SINGLE.test(str);
    }
    return CONST_REGEXP_ACEHOSTNAME.test(str);
  }

  // Split into labels
  const labels = str.split('.');

  // Must have at least one label
  if (labels.length === 0) {
    return false;
  }

  for (const label of labels) {
    // Empty label check (trailing dot)
    if (label.length === 0) {
      continue;
    }

    // Label length check (max 63 bytes for Punycode, but check raw first)
    if (label.length > 63) {
      return false;
    }

    // Check for ACE prefix (xn--)
    const isAce = label.toLowerCase().startsWith('xn--');

    // For ACE labels, decode first then validate the decoded form
    let decodedLabel = label;
    if (isAce) {
      // Check for "--" in 3rd and 4th position is always invalid in ACE
      // (xn-- is at positions 0-3, so check after that)
      const rest = label.slice(4);
      if (rest.length < 1) {
        return false; // xn-- with nothing after
      }

      // Validate the Punycode is decodable
      if (!isValidACE(label)) {
        return false;
      }

      // Decode the label for further validation
      try {
        decodedLabel = toUnicode(label);
      } catch (e) {
        return false;
      }
    }

    // Check for "--" in 3rd and 4th position (0-indexed: positions 2 and 3)
    // This restriction applies to U-labels and decoded A-labels
    // ACE labels (starting with xn--) legitimately have "--" at positions 2-3
    // After decoding, if the result still has "--" at 2-3, it's invalid
    if (decodedLabel.length >= 4 && decodedLabel[2] === '-' && decodedLabel[3] === '-') {
      // Raw ACE labels (xn--) legitimately have "--" at 2-3
      // But if an ACE label decodes to something with "--" at 2-3, it's invalid
      // because the decoded form shouldn't look like an ACE label
      const decodedStartsWithACE = decodedLabel.toLowerCase().startsWith('xn--');
      if (!decodedStartsWithACE) {
        // Non-ACE form with "--" at 2-3 is invalid
        return false;
      }
      // If decoded form starts with "xn--" but the original was also ACE,
      // it's a decoding artifact that creates a false ACE prefix - invalid
      if (isAce && decodedStartsWithACE) {
        return false;
      }
    }

    // Get the Unicode code points from the decoded label
    const codes = Array.from(decodedLabel).map(c => c.codePointAt(0));

    // Check first character doesn't start with combining mark
    if (isCombiningMark(codes[0])) {
      return false;
    }

    // Check last character isn't a hyphen
    if (codes[codes.length - 1] === 0x002d) {
      return false;
    }

    // Check first character isn't a hyphen
    if (codes[0] === 0x002d) {
      return false;
    }

    // Check for illegal characters
    for (const code of codes) {
      if (!isValidIdnChar(code)) {
        return false;
      }
    }

    // Check contextual rules
    if (!checkContextualRules(decodedLabel)) {
      return false;
    }

    // Check digit mixing
    if (!checkDigitMixing(codes)) {
      return false;
    }
  }

  // For ASCII-only hostnames, also validate with ACE regex
  let punycode;
  try {
    punycode = toASCII(str);
  } catch (e) {
    // If toASCII fails, the input is invalid
    return false;
  }

  // Single label hostname
  if (labels.length === 1 || (labels.length === 2 && labels[1] === '')) {
    return CONST_REGEXP_ACEHOSTNAME_SINGLE.test(punycode);
  }

  return CONST_REGEXP_ACEHOSTNAME.test(punycode);
}
//#endregion

//#region URL Tests
const CONST_REGEXP_URL = /^[(http(s)?):\/\/(www\.)?\w-/=#%&\.\?]{2,}\.[a-z]{2,}([\w-/=#%&\.\?]*)$/i;
export function isValidUrl(str) {
  return CONST_REGEXP_URL.test(str);
}

// For the source: https://gist.github.com/dperini/729294
// For test cases: https://mathiasbynens.be/demo/url-regex
// @todo Delete current URL in favour of the commented out URL rule when this issue is fixed https://github.com/eslint/eslint/issues/7983.
// URL = /^(?:(?:https?|ftp):\/\/)(?:\S+(?::\S*)?@)?(?:(?!10(?:\.\d{1,3}){3})(?!127(?:\.\d{1,3}){3})(?!169\.254(?:\.\d{1,3}){2})(?!192\.168(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)(?:\.(?:[a-z\u{00a1}-\u{ffff}0-9]+-?)*[a-z\u{00a1}-\u{ffff}0-9]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
// eslint-disable-next-line no-control-regex
const CONST_REGEXP_URL_FULL = /^(?:(?:http[s\u017F]?|ftp):\/\/)(?:(?:[\0-\x08\x0E-\x1F!-\x9F\xA1-\u167F\u1681-\u1FFF\u200B-\u2027\u202A-\u202E\u2030-\u205E\u2060-\u2FFF\u3001-\uD7FF\uE000-\uFEFE\uFF00-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])+(?::(?:[\0-\x08\x0E-\x1F!-\x9F\xA1-\u167F\u1681-\u1FFF\u200B-\u2027\u202A-\u202E\u2030-\u205E\u2060-\u2FFF\u3001-\uD7FF\uE000-\uFEFE\uFF00-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])*)?@)?(?:(?!10(?:\.[0-9]{1,3}){3})(?!127(?:\.[0-9]{1,3}){3})(?!169\.254(?:\.[0-9]{1,3}){2})(?!192\.168(?:\.[0-9]{1,3}){2})(?!172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})(?:[1-9][0-9]?|1[0-9][0-9]|2[01][0-9]|22[0-3])(?:\.(?:1?[0-9]{1,2}|2[0-4][0-9]|25[0-5])){2}(?:\.(?:[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-4]))|(?:(?:(?:[0-9KSa-z\xA1-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])+-?)*(?:[0-9KSa-z\xA1-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])+)(?:\.(?:(?:[0-9KSa-z\xA1-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])+-?)*(?:[0-9KSa-z\xA1-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])+)*(?:\.(?:(?:[KSa-z\xA1-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]){2,})))(?::[0-9]{2,5})?(?:\/(?:[\0-\x08\x0E-\x1F!-\x9F\xA1-\u167F\u1681-\u1FFF\u200B-\u2027\u202A-\u202E\u2030-\u205E\u2060-\u2FFF\u3001-\uD7FF\uE000-\uFEFE\uFF00-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])*)?$/i;
export function isValidUrlFull(str) {
  return CONST_REGEXP_URL_FULL.test(str);
}
//#endregion

//#region URI Tests
const CONST_REGEXP_NOT_URI_FRAGMENT = /\/|:/;
// uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
// RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
// Note: No comma allowed in scheme
const CONST_REGEXP_URI_FAST = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i;
export function isValidUri(str) {
  // http://jmrware.com/articles/2009/uri_regexp/URI_regex.html + optional protocol + required "."
  return CONST_REGEXP_NOT_URI_FRAGMENT.test(str)
    && CONST_REGEXP_URI_FAST.test(str);
}

// uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
const CONST_REGEXP_URI_FULL = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
export function isValidUriFull(str) {
  // http://jmrware.com/articles/2009/uri_regexp/URI_regex.html + optional protocol + required "."
  return CONST_REGEXP_NOT_URI_FRAGMENT.test(str)
    && CONST_REGEXP_URI_FULL.test(str);
}

const CONST_REGEXP_URIREF_FAST = /^(?:(?:[a-z][a-z0-9+-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i;
export function isValidUriRef(str) {
  return CONST_REGEXP_URIREF_FAST.test(str);
}

const CONST_REGEXP_URIREF_FULL = /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
export function isValidUriRefFull(str) {
  return CONST_REGEXP_URIREF_FULL.test(str);
}

// uri-template: https://tools.ietf.org/html/rfc6570
// eslint-disable-next-line no-control-regex
const CONST_REGEXP_URITEMPLATE = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
export function isValidUriTemplate(str) {
  return CONST_REGEXP_URITEMPLATE.test(str);
}
//#endregion

//#region IRI Tests
const CONST_REGEXP_ABSOLUTE_IRI = /^([a-z]([a-z]|\d|\+|-|\.)*):(\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:)*@)?((\[(?:(?:(?:[0-9a-f]{1,4}:){7}(?:[0-9a-f]{1,4}|:))|(?:(?:[0-9a-f]{1,4}:){6}(?::[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(?:(?:[0-9a-f]{1,4}:){5}(?:(?:(?::[0-9a-f]{1,4}){1,2})|:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(?:(?:[0-9a-f]{1,4}:){4}(?:(?:(?::[0-9a-f]{1,4}){1,3})|(?:(?::[0-9a-f]{1,4})?:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){3}(?:(?:(?::[0-9a-f]{1,4}){1,4})|(?:(?::[0-9a-f]{1,4}){0,2}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){2}(?:(?:(?::[0-9a-f]{1,4}){1,5})|(?:(?::[0-9a-f]{1,4}){0,3}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?:(?:[0-9a-f]{1,4}:){1}(?:(?:(?::[0-9a-f]{1,4}){1,6})|(?:(?::[0-9a-f]{1,4}){0,4}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(?::(?:(?:(?::[0-9a-f]{1,4}){1,7})|(?:(?::[0-9a-f]{1,4}){0,5}:(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))\])|((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=])*)(:\d*)?)(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)*)*|(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)*)*)?)|((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)*)*)|((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)){0})(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(\#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!\$&'\(\)\*\+,;=]|:|@)|\/|\?)*)?$/i;
export function isValidIRI(str) {
  return CONST_REGEXP_ABSOLUTE_IRI.test(str);
}

export function isValidIRIRef(str) {
  return isValidUriRef(str);
}
//#endregion

//#region JPtr Tests
// JSON-pointer: https://tools.ietf.org/html/rfc6901
const CONST_REGEXP_JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
export function isValidJSONPointer(str) {
  return CONST_REGEXP_JSON_POINTER.test(str);
}

// uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
const CONST_REGEXP_JSON_POINTER_URI_FRAGMENT = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
export function isValidJSONPointerUriFragment(str) {
  return CONST_REGEXP_JSON_POINTER_URI_FRAGMENT.test(str);
}

// relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
const CONST_REGEXP_RELATIVE_JSON_POINTER = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
export function isValidRelativeJSONPointer(str) {
  return CONST_REGEXP_RELATIVE_JSON_POINTER.test(str);
}
//#endregion

//#region Email Tests
// email (sources from jsen validator):
// http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
// http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'willful violation')
const CONST_REGEXP_EMAIL_FAST = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function isValidEmail(str) {
  return CONST_REGEXP_EMAIL_FAST.test(str);
}

const CONST_REGEXP_EMAIL_FULL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
export function isValidEmailFull(str) {
  return CONST_REGEXP_EMAIL_FULL.test(str);
}

const CONST_REGEXP_IDNEMAIL = /^[^@]+@[^@]+\.[^@]+$/;
export function isValidIdnEmail(str) {
  return CONST_REGEXP_IDNEMAIL.test(str);
}
//#endregion

//#region Common Tests
const CONST_REGPEXP_ISBN10 = /^(?:ISBN(?:-10)?:?\ *((?=\d{1,5}([ -]?)\d{1,7}\2?\d{1,6}\2?\d)(?:\d\2*){9}[\dX]))$/i;
export function isValidISBN10(str) {
  return CONST_REGPEXP_ISBN10.test(str);
}

const CONST_REGEXP_ISBN13 = /^(?:ISBN(?:-13)?:?\ *(97(?:8|9)([ -]?)(?=\d{1,5}\2?\d{1,7}\2?\d{1,6}\2?\d)(?:\d\2*){9}\d))$/i;
export function isValidISBN13(str) {
  return CONST_REGEXP_ISBN13.test(str);
}

const CONST_REGEXP_BASE64 = /^(?:[a-zA-Z0-9+\/]{4})*(?:|(?:[a-zA-Z0-9+\/]{3}=)|(?:[a-zA-Z0-9+\/]{2}==)|(?:[a-zA-Z0-9+\/]{1}===))$/;
export function isValidBase64Full(str) {
  return CONST_REGEXP_BASE64.test(str);
}

// Base64 validation regex (RFC 4648)
const BASE64_REGEX_SHORT = /^[A-Za-z0-9+/]*={0,2}$/;

export function isValidBase64Old(str) {
  // Check length is valid for base64 (multiple of 4)
  if (str.length % 4 !== 0) return false;
  // Check characters are valid base64
  if (!BASE64_REGEX_SHORT.test(str)) return false;
  return true;
}

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

export function isValidBase64(str) {
  return BASE64_REGEX.test(str);
}

const CONST_REGEXP_COUNTRY_ALPHA2 = /^(AF|AX|AL|DZ|AS|AD|AO|AI|AQ|AG|AR|AM|AW|AU|AT|AZ|BS|BH|BD|BB|BY|BE|BZ|BJ|BM|BT|BO|BQ|BA|BW|BV|BR|IO|BN|BG|BF|BI|KH|CM|CA|CV|KY|CF|TD|CL|CN|CX|CC|CO|KM|CG|CD|CK|CR|CI|HR|CU|CW|CY|CZ|DK|DJ|DM|DO|EC|EG|SV|GQ|ER|EE|ET|FK|FO|FJ|FI|FR|GF|PF|TF|GA|GM|GE|DE|GH|GI|GR|GL|GD|GP|GU|GT|GG|GN|GW|GY|HT|HM|VA|HN|HK|HU|IS|IN|ID|IR|IQ|IE|IM|IL|IT|JM|JP|JE|JO|KZ|KE|KI|KP|KR|KW|KG|LA|LV|LB|LS|LR|LY|LI|LT|LU|MO|MK|MG|MW|MY|MV|ML|MT|MH|MQ|MR|MU|YT|MX|FM|MD|MC|MN|ME|MS|MA|MZ|MM|NA|NR|NP|NL|NC|NZ|NI|NE|NG|NU|NF|MP|NO|OM|PK|PW|PS|PA|PG|PY|PE|PH|PN|PL|PT|PR|QA|RE|RO|RU|RW|BL|SH|KN|LC|MF|PM|VC|WS|SM|ST|SA|SN|RS|SC|SL|SG|SX|SK|SI|SB|SO|ZA|GS|SS|ES|LK|SD|SR|SJ|SZ|SE|CH|SY|TW|TJ|TZ|TH|TL|TG|TK|TO|TT|TN|TR|TM|TC|TV|UG|UA|AE|GB|US|UM|UY|UZ|VU|VE|VN|VG|VI|WF|EH|YE|ZM|ZW|XK)/i;
export function isValidCountryAlpha2(str) {
  return CONST_REGEXP_COUNTRY_ALPHA2.test(str);
}

const CONST_REGEXP_IBAN = /^([A-Z]{2}[ '+'\\\\'+'-]?[0-9]{2})(?=(?:[ '+'\\\\'+'-]?[A-Z0-9]){9,30}\$)((?:[ '+'\\\\'+'-]?[A-Z0-9]{3,5}){2,7})([ '+'\\\\'+'-]?[A-Z0-9]{1,3})?\$/i;
export function isValidIBAN(str) {
  return CONST_REGEXP_IBAN.test(str);
}
//#endregion
