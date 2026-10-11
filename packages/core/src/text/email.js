import {
  isValidIPv4,
  isValidIPv6,
  isValidIdnHostname,
} from './host.js';

// email (sources from json validator):
// http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
// http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'willful violation')
const CONST_REGEXP_EMAIL_FAST = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// RFC 5321 slow-path pieces: quoted-string local part (qtext / quoted-pair),
// dot-atom local part and dot-atom domain.
const CONST_REGEXP_EMAIL_QUOTED_LOCAL = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
const CONST_REGEXP_EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const CONST_REGEXP_EMAIL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// RFC 6531 widens the same grammar to UTF-8: every code point from U+0080
// up (surrogates excluded) is an atext or qtext character.
const CONST_REGEXP_IDNEMAIL_QUOTED_LOCAL = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e\u{80}-\u{d7ff}\u{e000}-\u{10ffff}]|\\[\x20-\x7e\u{80}-\u{d7ff}\u{e000}-\u{10ffff}])*"$/u;
const CONST_REGEXP_IDNEMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~\u{80}-\u{d7ff}\u{e000}-\u{10ffff}-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~\u{80}-\u{d7ff}\u{e000}-\u{10ffff}-]+)*$/iu;

// RFC 5321 address literal: [IPv4] or [IPv6:...]; any other domain goes to
// `isHostname`, which decides what a dotted domain may be.
function isValidEmailDomainWith(domain, isHostname) {
  if (domain.charCodeAt(0) === 0x5b /* [ */) {
    if (domain.charCodeAt(domain.length - 1) !== 0x5d /* ] */) return false;
    const literal = domain.slice(1, -1);
    if (literal.slice(0, 5).toLowerCase() === 'ipv6:')
      return isValidIPv6(literal.slice(5));
    return isValidIPv4(literal);
  }
  return isHostname(domain);
}

const isValidEmailDomain = (domain) =>
  isValidEmailDomainWith(domain, (name) => CONST_REGEXP_EMAIL_DOMAIN.test(name));

// A dotted domain whose labels are IDN labels: at least one inner dot, no
// leading or trailing dot, and `isValidIdnHostname` for the rest.
const isValidIdnEmailDomain = (domain) =>
  isValidEmailDomainWith(domain, (name) =>
    name.indexOf('.') > 0
    && name.charCodeAt(name.length - 1) !== 0x2e
    && isValidIdnHostname(name));

// The address grammar shared by `email` and `idn-email`: a quoted-string or
// dot-atom local part, `@`, and a domain, each judged by the caller's rules.
function isValidMailbox(str, localRe, quotedLocalRe, isDomain) {
  if (str.charCodeAt(0) === 0x22 /* " */) {
    // Find the end of the quoted string, honoring quoted-pairs
    let i = 1;
    for (; i < str.length; ++i) {
      const c = str.charCodeAt(i);
      if (c === 0x5c /* \ */) { i++; continue; }
      if (c === 0x22 /* " */) break;
    }
    if (i >= str.length || str.charCodeAt(i + 1) !== 0x40 /* @ */) return false;
    return quotedLocalRe.test(str.slice(0, i + 1))
      && isDomain(str.slice(i + 2));
  }

  const at = str.lastIndexOf('@');
  if (at <= 0) return false;
  return localRe.test(str.slice(0, at))
    && isDomain(str.slice(at + 1));
}

export function isValidEmail(str) {
  // Fast path: dot-atom local part with a regular domain
  if (CONST_REGEXP_EMAIL_FAST.test(str)) return true;

  // Slow path (RFC 5321): quoted-string local part and/or address literal
  return isValidMailbox(str, CONST_REGEXP_EMAIL_LOCAL, CONST_REGEXP_EMAIL_QUOTED_LOCAL, isValidEmailDomain);
}

/**
 * Tests an internationalized address (RFC 6531): the `email` grammar with
 * non-ASCII text allowed in the local part and IDN labels in the domain.
 * Whitespace, control characters and empty labels are refused as in `email`.
 * @param {string} str - The candidate address
 * @returns {boolean} True for a well-formed internationalized address
 * @example
 * isValidIdnEmail('실례@실례.테스트'); // true
 * isValidIdnEmail('a b@c.d'); // false
 */
export function isValidIdnEmail(str) {
  return typeof str === 'string'
    && isValidMailbox(str, CONST_REGEXP_IDNEMAIL_LOCAL, CONST_REGEXP_IDNEMAIL_QUOTED_LOCAL, isValidIdnEmailDomain);
}
