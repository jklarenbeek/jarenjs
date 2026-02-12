//@ts-check
import {
  toASCII,
  toUnicode,
} from './punycode.js';

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
// Fast path regex for simple ASCII-only IRIs
// Only matches common, unambiguous cases to avoid false positives
const CONST_REGEXP_ASCII_IRI = /^(?:[a-z][a-z0-9+\-.]*:)\/\/[^\s:]+(:\d+)?(\/[^\s]*)?$/i;

export function isValidIRI(str) {
  // Fast path: check if string is ASCII-only and doesn't contain complex patterns
  // If so, use a much simpler regex that's ~10x faster
  let isAsciiOnly = true;
  let hasSquareBracket = false;
  let colonCount = 0;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 127) {
      isAsciiOnly = false;
      break;
    }
    if (code === 91 || code === 93) { // '[' or ']'
      hasSquareBracket = true;
    }
    if (code === 58) { // ':'
      colonCount++;
    }
  }

  // Use fast path only for simple ASCII-only IRIs:
  // - No Unicode characters
  // - No square brackets (IPv6 literals)
  // - At most 2 colons (for scheme and optional port, not IPv6)
  if (isAsciiOnly && !hasSquareBracket && colonCount <= 2) {
    return CONST_REGEXP_ASCII_IRI.test(str);
  }

  // Fall back to full IRI regex for complex strings
  return CONST_REGEXP_ABSOLUTE_IRI.test(str);
}

export function isValidIRIRef(str) {
  return isValidUriRef(str);
}
//#endregion
