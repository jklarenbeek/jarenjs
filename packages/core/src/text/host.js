//@ts-check
import {
  domainToASCII,
  punycodeEncode,
  punycodeDecode,
} from './punycode.js';

import {
  toCodePoints,
} from '../string.js';

import {
  checkContextualRules,
  checkDigitMixing,
  isCombiningMark,
  isValidIdnChar
} from './i18n.js';



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

/**
 * Whether the ACE (Punycode) form of a hostname is well formed: one or
 * more labels of 1 to 63 letters, digits and hyphens, with no hyphen at
 * either end of a label. The `xn--` prefix needs no special case - it is
 * letters and hyphens like any other label body.
 *
 * @param {string} ace - A hostname already in its ACE form
 * @returns {boolean} True when every label is well formed
 */
function isValidAceForm(ace) {
  const end = ace.length;
  if (end === 0) return false;
  let start = 0;
  for (let i = 0; i <= end; i++) {
    if (i < end && ace.charCodeAt(i) !== 0x2E) continue; // '.'
    const len = i - start;
    if (len === 0 || len > 63) return false;
    if (ace.charCodeAt(start) === 0x2D || ace.charCodeAt(i - 1) === 0x2D) return false; // '-'
    for (let k = start; k < i; k++) {
      const c = ace.charCodeAt(k);
      if ((c < 0x61 || c > 0x7A) // a-z
        && (c < 0x41 || c > 0x5A) // A-Z
        && (c < 0x30 || c > 0x39) // 0-9
        && c !== 0x2D) return false;
    }
    start = i + 1;
  }
  return true;
}

// The encoded body of an ACE (xn--) label: alphanumerics and hyphens only
const CONST_REGEXP_ACE_BODY = /^[a-zA-Z0-9-]+$/;

/**
 * Whether the label carries the ACE prefix, in any case. Compared by
 * character code because this runs per label and a `toLowerCase()` would
 * allocate a copy of every one of them just to read four characters.
 * @param {string} label - A hostname label
 * @returns {boolean} True when the label starts with `xn--`
 */
function startsWithAcePrefix(label) {
  return label.length >= 4
    && (label.charCodeAt(0) | 0x20) === 0x78 // 'x'
    && (label.charCodeAt(1) | 0x20) === 0x6E // 'n'
    && label.charCodeAt(2) === 0x2D // '-'
    && label.charCodeAt(3) === 0x2D;
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
    // Check for xn-- prefix (case insensitive) - check at position 0 or after a dot
    if ((code === 120 || code === 88) && // 'x' or 'X'
        i + 3 < str.length &&
        (str.charCodeAt(i + 1) === 110 || str.charCodeAt(i + 1) === 78) && // 'n' or 'N'
        str.charCodeAt(i + 2) === 45 && str.charCodeAt(i + 3) === 45) { // '--'
      // Only count as ACE prefix if it's at start or after a dot
      if (i === 0 || str.charCodeAt(i - 1) === 46) { // dot = 46
        hasAcePrefix = true;
      }
    }
  }

  // An ASCII-only hostname without an ACE prefix has no U-label to
  // decode and no label to encode, so it is already its own ACE form.
  if (isAsciiOnly && !hasAcePrefix) {
    return isValidAceForm(str);
  }

  // Split into labels
  const labels = str.split('.');

  // Must have at least one label
  if (labels.length === 0) {
    return false;
  }

  // U+3002, U+FF0E and U+FF61 are IDNA label separators, and "@" splits
  // off a local part: a domain-wide conversion cuts labels at all four
  // where the split on "." above does not. Absent them, the labels
  // walked here ARE the labels that conversion would see, so the ACE
  // form comes out of this same walk - one encode per U-label, and none
  // of the second split, per-label regex test and intermediate array
  // that converting the whole string again costs. The lookups are worth
  // their own pass only on this branch, so they stay off the ASCII one.
  const buildAce = !isAsciiOnly
    && str.indexOf('。') < 0
    && str.indexOf('．') < 0
    && str.indexOf('｡') < 0
    && str.indexOf('@') < 0;
  let punycode = isAsciiOnly ? str : '';

  for (let li = 0; li < labels.length; li++) {
    const label = labels[li];
    if (buildAce && li > 0) {
      punycode += '.';
    }

    // Empty label check (trailing dot)
    if (label.length === 0) {
      continue;
    }

    // Label length check (max 63 bytes for Punycode, but check raw first)
    if (label.length > 63) {
      return false;
    }

    // Check for ACE prefix (xn--)
    const isAce = startsWithAcePrefix(label);

    // For ACE labels, decode first then validate the decoded form
    let decodedLabel = label;
    if (isAce) {
      // ACE labels must have at least one character after xn--
      if (label.length < 5) {
        return false; // xn-- with nothing after
      }

      // The encoded part allows only alphanumerics and hyphens
      if (!CONST_REGEXP_ACE_BODY.test(label.slice(4))) {
        return false;
      }

      // Decode once; the decoded form drives the remaining label rules.
      // The body is pure LDH (checked above), so decoding the label
      // directly equals toUnicode's domain-wise mapping without its
      // split/join passes. Punycode only recognizes an all-lowercase
      // 'xn--' prefix; other casings keep the label undecoded and the
      // '--' rule below rejects them.
      if (label.startsWith('xn--')) {
        try {
          decodedLabel = punycodeDecode(label.slice(4).toLowerCase());
        } catch (_e) {
          return false;
        }
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
      const decodedStartsWithACE = startsWithAcePrefix(decodedLabel);
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
    const codes = toCodePoints(decodedLabel);
    let labelNonAscii = false;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] > 127) {
        labelNonAscii = true;
        break;
      }
    }

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
    if (!checkContextualRules(codes)) {
      return false;
    }

    // Check digit mixing
    if (!checkDigitMixing(codes)) {
      return false;
    }

    if (buildAce) {
      // An ACE label is already ASCII and stays as written; a U-label
      // becomes its Punycode. An overflowing label cannot be encoded, so
      // it is not a hostname.
      if (isAce || !labelNonAscii) {
        punycode += label;
      }
      else {
        try {
          punycode += 'xn--' + punycodeEncode(label);
        }
        catch (_e) {
          return false;
        }
      }
    }
  }

  if (!isAsciiOnly && !buildAce) {
    // A separator the label split did not see gives the ACE form a
    // different label structure than the walk above, so only the
    // domain-wide conversion gets it right.
    try {
      punycode = domainToASCII(str);
    }
    catch (_e) {
      return false;
    }
  }

  return isValidAceForm(punycode);
}
//#endregion

//#region URI Template Tests
// uri-template: https://tools.ietf.org/html/rfc6570
// eslint-disable-next-line no-control-regex
const CONST_REGEXP_URITEMPLATE = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
export function isValidUriTemplate(str) {
  return CONST_REGEXP_URITEMPLATE.test(str);
}
//#endregion

//#region URI and IRI Tests
// RFC 3986 URIs and RFC 3987 IRIs, scanned by character code. They are
// one grammar: an IRI is a URI with `iunreserved` widening `unreserved`
// by the `ucschar` ranges and `iprivate` admitted in the query. So the
// scanners below are shared, each shaped like the ABNF production it is
// named after, and each returns the index it stopped at - never a slice,
// so a whole identifier is decided without allocating.

/** Which non-ASCII characters a production admits. */
const UCS_NONE = 0; // RFC 3986: none, the grammar is ASCII
const UCS_CHAR = 1; // RFC 3987 iunreserved: ucschar
const UCS_PRIVATE = 2; // RFC 3987 iquery: ucschar and iprivate

// ASCII character classes of the RFC 3986/3987 core rules, one bit each.
const CH_UNRESERVED = 1; // ALPHA / DIGIT / "-" / "." / "_" / "~"
const CH_SUBDELIM = 2; // "!" "$" "&" "'" "(" ")" "*" "+" "," ";" "="
const CH_HEXDIG = 4;
const CH_ALPHA = 8;
const CH_DIGIT = 16;
const CH_SCHEME = 32; // ALPHA / DIGIT / "+" / "-" / "."
// The four run productions differ only in whether ":" and "@" are in the
// set. Giving each its own bit costs a byte per character and takes the
// difference out of the scanning loop, where it would otherwise be two
// comparisons on every character of every IRI.
const CH_PCHAR = 64; // iunreserved / sub-delims / ":" / "@"
const CH_USERINFO = 128; // ipchar without "@"
const CH_REGNAME = 256; // ipchar without ":" or "@"
const CH_SEGNC = 512; // ipchar without ":" - isegment-nz-nc
const CH_QUERY = 1024; // ipchar / "/" / "?" - also the ifragment set

const IRI_ASCII = new Uint16Array(128);
for (let c = 0; c < 128; c++) {
  const alpha = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
  const digit = c >= 0x30 && c <= 0x39;
  let f = 0;
  if (alpha) f |= CH_ALPHA;
  if (digit) f |= CH_DIGIT;
  // - . _ ~
  if (alpha || digit || c === 0x2D || c === 0x2E || c === 0x5F || c === 0x7E) f |= CH_UNRESERVED;
  if (digit || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) f |= CH_HEXDIG;
  // + - .
  if (alpha || digit || c === 0x2B || c === 0x2D || c === 0x2E) f |= CH_SCHEME;
  // ! $ then the contiguous & ' ( ) * + , then ; =
  if (c === 0x21 || c === 0x24 || (c >= 0x26 && c <= 0x2C) || c === 0x3B || c === 0x3D) f |= CH_SUBDELIM;
  const shared = (f & (CH_UNRESERVED | CH_SUBDELIM)) !== 0;
  if (shared) f |= CH_REGNAME;
  if (shared || c === 0x3A) f |= CH_USERINFO; // ':'
  if (shared || c === 0x40) f |= CH_SEGNC; // '@'
  if (shared || c === 0x3A || c === 0x40) f |= CH_PCHAR;
  if ((f & CH_PCHAR) || c === 0x2F || c === 0x3F) f |= CH_QUERY; // '/' '?'
  IRI_ASCII[c] = f;
}

/**
 * Whether the code point is an RFC 3987 `ucschar` - the non-ASCII half of
 * `iunreserved`. Private-use areas are deliberately absent: they are
 * `iprivate`, which only the query admits.
 * @param {number} cp - A Unicode code point
 * @returns {boolean} True for a ucschar
 */
function isUcsChar(cp) {
  if (cp < 0xA0) return false;
  if (cp <= 0xD7FF) return true;
  if (cp < 0xF900) return false;
  if (cp <= 0xFDCF) return true;
  if (cp < 0xFDF0) return false;
  if (cp <= 0xFFFD) return true;
  if (cp < 0x10000) return false;
  const plane = cp >>> 16;
  if (plane > 0x0E) return false;
  const low = cp & 0xFFFF;
  // The supplementary ranges run to xFFFD in every plane, and plane 14
  // starts at xE1000 rather than at its plane boundary.
  return low <= 0xFFFD && (plane !== 0x0E || low >= 0x1000);
}

/**
 * Whether the code point is an RFC 3987 `iprivate`.
 * @param {number} cp - A Unicode code point
 * @returns {boolean} True for an iprivate code point
 */
function isIPrivate(cp) {
  return (cp >= 0xE000 && cp <= 0xF8FF)
    || (cp >= 0xF0000 && cp <= 0xFFFFD)
    || (cp >= 0x100000 && cp <= 0x10FFFD);
}

/**
 * The code point at `i`, or -1 for an unpaired surrogate. An unpaired
 * surrogate is not a character, so no production can accept it.
 * @param {string} str - The string being scanned
 * @param {number} i - The index to read
 * @param {number} end - One past the last readable index
 * @returns {number} The code point, or -1
 */
function codePointAtStrict(str, i, end) {
  const c = str.charCodeAt(i);
  if (c < 0xD800 || c > 0xDFFF) return c;
  if (c > 0xDBFF || i + 1 >= end) return -1;
  const lo = str.charCodeAt(i + 1);
  if (lo < 0xDC00 || lo > 0xDFFF) return -1;
  return ((c - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
}

/**
 * Consume the longest run of characters admitted by an IRI production,
 * plus percent-encoded triplets and the non-ASCII ranges. Every run
 * production is a CH_* class, so one scanner covers them all.
 *
 * @param {string} str - The string being scanned
 * @param {number} i - Where to start
 * @param {number} end - One past the last readable index
 * @param {number} mask - The CH_* class the production admits
 * @param {number} unicode - Which UCS_* set of non-ASCII characters the
 *   production admits
 * @returns {number} The index one past the run
 */
function scanRun(str, i, end, mask, unicode) {
  while (i < end) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      if (IRI_ASCII[c] & mask) {
        i++;
        continue;
      }
      if (c !== 0x25) return i; // '%' - pct-encoded = "%" HEXDIG HEXDIG
      if (i + 2 >= end) return i;
      const h1 = str.charCodeAt(i + 1);
      const h2 = str.charCodeAt(i + 2);
      if (h1 > 0x7F || h2 > 0x7F) return i;
      if (!(IRI_ASCII[h1] & CH_HEXDIG) || !(IRI_ASCII[h2] & CH_HEXDIG)) return i;
      i += 3;
      continue;
    }
    if (unicode === UCS_NONE) return i; // RFC 3986 is ASCII throughout
    // One contiguous range holds the bulk of ucschar; only the tail of
    // the BMP and the supplementary planes need a decoded code point.
    if (c >= 0xA0 && c <= 0xD7FF) {
      i++;
      continue;
    }
    const cp = codePointAtStrict(str, i, end);
    if (cp < 0) return i;
    if (!isUcsChar(cp) && !(unicode === UCS_PRIVATE && isIPrivate(cp))) return i;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return i;
}

/**
 * scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
 * @param {string} str - The string being scanned
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the ":", or -1 when absent
 */
function scanScheme(str, end) {
  if (end === 0) return -1;
  const c = str.charCodeAt(0);
  if (c > 0x7F || !(IRI_ASCII[c] & CH_ALPHA)) return -1;
  let i = 1;
  while (i < end) {
    const d = str.charCodeAt(i);
    if (d > 0x7F || !(IRI_ASCII[d] & CH_SCHEME)) break;
    i++;
  }
  return i < end && str.charCodeAt(i) === 0x3A ? i + 1 : -1; // ':'
}

/**
 * IPvFuture = "v" 1*HEXDIG "." 1*( unreserved / sub-delims / ":" )
 * @param {string} inner - The text between the IP-literal brackets
 * @returns {boolean} True for a well-formed IPvFuture
 */
function isIPvFuture(inner) {
  const n = inner.length;
  let i = 1; // the caller matched the leading "v"
  const start = i;
  while (i < n) {
    const c = inner.charCodeAt(i);
    if (c > 0x7F || !(IRI_ASCII[c] & CH_HEXDIG)) break;
    i++;
  }
  if (i === start || i >= n || inner.charCodeAt(i) !== 0x2E) return false; // '.'
  if (++i >= n) return false;
  for (; i < n; i++) {
    const c = inner.charCodeAt(i);
    if (c > 0x7F) return false;
    if (!(IRI_ASCII[c] & (CH_UNRESERVED | CH_SUBDELIM)) && c !== 0x3A) return false;
  }
  return true;
}

/**
 * IP-literal = "[" ( IPv6address / IPvFuture ) "]"
 * @param {string} str - The string being scanned
 * @param {number} i - The index of the "["
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the "]", or -1
 */
function scanIPLiteral(str, i, end) {
  let j = i + 1;
  while (j < end && str.charCodeAt(j) !== 0x5D) j++; // ']'
  if (j >= end || j === i + 1) return -1;
  // The bracketed forms are rare enough that reusing the IPv6 tester -
  // the one the ipv6 format already answers with - beats a second
  // address grammar that would have to be kept in step with it.
  const inner = str.slice(i + 1, j);
  const c = inner.charCodeAt(0);
  const ok = (c === 0x76 || c === 0x56) ? isIPvFuture(inner) : isValidIPv6(inner); // 'v' 'V'
  return ok ? j + 1 : -1;
}

/**
 * ihost = IP-literal / IPv4address / ireg-name. Every IPv4address is
 * also an ireg-name, so the alternation needs no separate dotted-quad
 * pass: the grammar admits "999.999.999.999" as a registered name.
 * @param {string} str - The string being scanned
 * @param {number} i - Where the host starts
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the host, or -1
 */
function scanHost(str, i, end, unicode) {
  if (i < end && str.charCodeAt(i) === 0x5B) return scanIPLiteral(str, i, end); // '['
  return scanRun(str, i, end, CH_REGNAME, unicode);
}

/**
 * iauthority = [ iuserinfo "@" ] ihost [ ":" port ]
 * @param {string} str - The string being scanned
 * @param {number} i - Where the authority starts (just past "//")
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the authority, or -1
 */
function scanAuthority(str, i, end, unicode) {
  // An IP-literal host cannot be preceded by a bracket-free userinfo run,
  // so take it before anything else.
  if (i < end && str.charCodeAt(i) === 0x5B) { // '['
    const afterHost = scanIPLiteral(str, i, end);
    return afterHost < 0 ? -1 : scanPort(str, afterHost, end);
  }

  // iuserinfo admits ":" but not "@", so one run of the wider set either
  // stops at the "@" that ends a userinfo, or has already covered the
  // host and its port. Deciding afterwards is what keeps the common
  // authority - which has no userinfo - down to a single pass.
  const stop = scanRun(str, i, end, CH_USERINFO, unicode);
  if (stop < end && str.charCodeAt(stop) === 0x40) {
    const afterHost = scanHost(str, stop + 1, end, unicode);
    return afterHost < 0 ? -1 : scanPort(str, afterHost, end);
  }

  // No userinfo: an ireg-name admits no colon, so the first colon in the
  // run opens the port and everything after it must be a digit.
  for (let k = i; k < stop; k++) {
    if (str.charCodeAt(k) === 0x3A) {
      return scanPort(str, k, end) === stop ? stop : -1;
    }
  }
  return stop;
}

/**
 * [ ":" port ], where port = *DIGIT.
 * @param {string} str - The string being scanned
 * @param {number} i - The index just past the host
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the port
 */
function scanPort(str, i, end) {
  if (i >= end || str.charCodeAt(i) !== 0x3A) return i; // ':'
  i++;
  while (i < end) {
    const c = str.charCodeAt(i);
    if (c > 0x7F || !(IRI_ASCII[c] & CH_DIGIT)) break;
    i++;
  }
  return i;
}

/**
 * ipath-abempty = *( "/" isegment ). Also covers ipath-absolute, whose
 * only extra restriction - no leading "//" - the caller has already
 * settled by taking that case as an authority.
 * @param {string} str - The string being scanned
 * @param {number} i - Where the path starts
 * @param {number} end - One past the last readable index
 * @returns {number} The index one past the path
 */
function scanPathAbempty(str, i, end, unicode) {
  while (i < end && str.charCodeAt(i) === 0x2F) { // '/'
    i = scanRun(str, i + 1, end, CH_PCHAR, unicode);
  }
  return i;
}

/**
 * Scan a whole URI, IRI or reference of either.
 * @param {string} str - The candidate
 * @param {boolean} allowRelative - Whether a missing scheme is allowed
 * @param {number} unicode - UCS_NONE for RFC 3986, UCS_CHAR for RFC 3987
 * @returns {boolean} True when the whole string is the production
 */
function scanIdentifier(str, allowRelative, unicode) {
  const end = str.length;
  let i = 0;

  const afterScheme = scanScheme(str, end);
  const hasScheme = afterScheme >= 0;
  if (hasScheme) i = afterScheme;
  else if (!allowRelative) return false;

  if (i + 1 < end && str.charCodeAt(i) === 0x2F && str.charCodeAt(i + 1) === 0x2F) {
    const a = scanAuthority(str, i + 2, end, unicode);
    if (a < 0) return false;
    i = scanPathAbempty(str, a, end, unicode);
  }
  else if (i < end && str.charCodeAt(i) === 0x2F) {
    i = scanPathAbempty(str, i, end, unicode); // ipath-absolute
  }
  else {
    // ipath-rootless with a scheme, ipath-noscheme without: a scheme-less
    // reference may not put a colon in its first segment, or the segment
    // would read as a scheme.
    const seg = scanRun(str, i, end, hasScheme ? CH_PCHAR : CH_SEGNC, unicode);
    i = seg === i ? i : scanPathAbempty(str, seg, end, unicode);
  }

  if (i < end && str.charCodeAt(i) === 0x3F) { // '?'
    // Only the query admits iprivate, and only in an IRI.
    i = scanRun(str, i + 1, end, CH_QUERY, unicode === UCS_CHAR ? UCS_PRIVATE : unicode);
  }
  if (i < end && str.charCodeAt(i) === 0x23) { // '#'
    i = scanRun(str, i + 1, end, CH_QUERY, unicode);
  }
  return i === end;
}

/**
 * Validate an absolute URI (RFC 3986 section 3) - a scheme followed by a
 * hierarchical part, with an optional query and fragment.
 * @param {string} str - The candidate URI
 * @returns {boolean} True for a well-formed URI
 */
export function isValidUri(str) {
  return scanIdentifier(str, false, UCS_NONE);
}

/**
 * Validate a URI reference (RFC 3986 section 4.1) - a URI or a relative
 * reference resolved against a base.
 * @param {string} str - The candidate URI reference
 * @returns {boolean} True for a well-formed URI reference
 */
export function isValidUriRef(str) {
  return scanIdentifier(str, true, UCS_NONE);
}

/**
 * Validate an absolute IRI (RFC 3987 section 2.2) - a URI whose
 * unreserved characters extend into the `ucschar` ranges.
 * @param {string} str - The candidate IRI
 * @returns {boolean} True for a well-formed IRI
 */
export function isValidIRI(str) {
  return scanIdentifier(str, false, UCS_CHAR);
}

/**
 * Validate an IRI reference (RFC 3987 section 2.2) - an IRI or a
 * relative reference resolved against a base.
 * @param {string} str - The candidate IRI reference
 * @returns {boolean} True for a well-formed IRI reference
 */
export function isValidIRIRef(str) {
  return scanIdentifier(str, true, UCS_CHAR);
}

/**
 * Validate a URL: a URI carrying one of the web schemes and an
 * authority. The grammar is RFC 3986's - a URL is a narrower thing than
 * a URI, not a looser one - so `http://x/a|b` is no more a URL than it
 * is a URI, while `http://localhost:8080` and `http://127.0.0.1/` are
 * both perfectly good ones.
 *
 * @param {string} str - The candidate URL
 * @returns {boolean} True for a well-formed http or https URL
 */
export function isValidUrl(str) {
  if ((str.charCodeAt(0) | 0x20) !== 0x68 // 'h'
    || (str.charCodeAt(1) | 0x20) !== 0x74 // 't'
    || (str.charCodeAt(2) | 0x20) !== 0x74 // 't'
    || (str.charCodeAt(3) | 0x20) !== 0x70) return false; // 'p'
  let i = 4;
  if ((str.charCodeAt(i) | 0x20) === 0x73) i++; // 's'
  if (str.charCodeAt(i) !== 0x3A // ':'
    || str.charCodeAt(i + 1) !== 0x2F // '/'
    || str.charCodeAt(i + 2) !== 0x2F) return false;
  // "http://" alone names no resource.
  if (str.length <= i + 3) return false;
  return scanIdentifier(str, false, UCS_NONE);
}

//#endregion
