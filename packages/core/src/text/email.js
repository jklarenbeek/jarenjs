import {
  isValidIPv4,
  isValidIPv6,
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

function isValidEmailDomain(domain) {
  // RFC 5321 address literal: [IPv4] or [IPv6:...]
  if (domain.charCodeAt(0) === 0x5b /* [ */) {
    if (domain.charCodeAt(domain.length - 1) !== 0x5d /* ] */) return false;
    const literal = domain.slice(1, -1);
    if (literal.slice(0, 5).toLowerCase() === 'ipv6:')
      return isValidIPv6(literal.slice(5));
    return isValidIPv4(literal);
  }
  return CONST_REGEXP_EMAIL_DOMAIN.test(domain);
}

export function isValidEmail(str) {
  // Fast path: dot-atom local part with a regular domain
  if (CONST_REGEXP_EMAIL_FAST.test(str)) return true;

  // Slow path (RFC 5321): quoted-string local part and/or address literal
  if (str.charCodeAt(0) === 0x22 /* " */) {
    // Find the end of the quoted string, honoring quoted-pairs
    let i = 1;
    for (; i < str.length; ++i) {
      const c = str.charCodeAt(i);
      if (c === 0x5c /* \ */) { i++; continue; }
      if (c === 0x22 /* " */) break;
    }
    if (i >= str.length || str.charCodeAt(i + 1) !== 0x40 /* @ */) return false;
    return CONST_REGEXP_EMAIL_QUOTED_LOCAL.test(str.slice(0, i + 1))
      && isValidEmailDomain(str.slice(i + 2));
  }

  const at = str.lastIndexOf('@');
  if (at <= 0) return false;
  return CONST_REGEXP_EMAIL_LOCAL.test(str.slice(0, at))
    && isValidEmailDomain(str.slice(at + 1));
}

const CONST_REGEXP_IDNEMAIL = /^[^@]+@[^@]+\.[^@]+$/;
export function isValidIdnEmail(str) {
  return CONST_REGEXP_IDNEMAIL.test(str);
}
