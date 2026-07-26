const CONST_REGPEXP_ISBN10 = /^(?:ISBN(?:-10)?:? *((?=\d{1,5}([ -]?)\d{1,7}\2?\d{1,6}\2?\d)(?:\d\2*){9}[\dX]))$/i;
export function isValidISBN10(str) {
  return CONST_REGPEXP_ISBN10.test(str);
}

const CONST_REGEXP_ISBN13 = /^(?:ISBN(?:-13)?:? *(97(?:8|9)([ -]?)(?=\d{1,5}\2?\d{1,7}\2?\d{1,6}\2?\d)(?:\d\2*){9}\d))$/i;
export function isValidISBN13(str) {
  return CONST_REGEXP_ISBN13.test(str);
}

// The 249 officially assigned ISO 3166-1 alpha-2 codes plus XK, the
// user-assigned code the EU institutions and the IBAN registry use for
// Kosovo. Matching is case-insensitive, like the other host/identifier
// testers here, even though ISO 3166-1 writes alpha-2 codes uppercase.
const CONST_REGEXP_COUNTRY_ALPHA2 = /^(?:AF|AX|AL|DZ|AS|AD|AO|AI|AQ|AG|AR|AM|AW|AU|AT|AZ|BS|BH|BD|BB|BY|BE|BZ|BJ|BM|BT|BO|BQ|BA|BW|BV|BR|IO|BN|BG|BF|BI|KH|CM|CA|CV|KY|CF|TD|CL|CN|CX|CC|CO|KM|CG|CD|CK|CR|CI|HR|CU|CW|CY|CZ|DK|DJ|DM|DO|EC|EG|SV|GQ|ER|EE|ET|FK|FO|FJ|FI|FR|GF|PF|TF|GA|GM|GE|DE|GH|GI|GR|GL|GD|GP|GU|GT|GG|GN|GW|GY|HT|HM|VA|HN|HK|HU|IS|IN|ID|IR|IQ|IE|IM|IL|IT|JM|JP|JE|JO|KZ|KE|KI|KP|KR|KW|KG|LA|LV|LB|LS|LR|LY|LI|LT|LU|MO|MK|MG|MW|MY|MV|ML|MT|MH|MQ|MR|MU|YT|MX|FM|MD|MC|MN|ME|MS|MA|MZ|MM|NA|NR|NP|NL|NC|NZ|NI|NE|NG|NU|NF|MP|NO|OM|PK|PW|PS|PA|PG|PY|PE|PH|PN|PL|PT|PR|QA|RE|RO|RU|RW|BL|SH|KN|LC|MF|PM|VC|WS|SM|ST|SA|SN|RS|SC|SL|SG|SX|SK|SI|SB|SO|ZA|GS|SS|ES|LK|SD|SR|SJ|SZ|SE|CH|SY|TW|TJ|TZ|TH|TL|TG|TK|TO|TT|TN|TR|TM|TC|TV|UG|UA|AE|GB|US|UM|UY|UZ|VU|VE|VN|VG|VI|WF|EH|YE|ZM|ZW|XK)$/i;
export function isValidCountryAlpha2(str) {
  return CONST_REGEXP_COUNTRY_ALPHA2.test(str);
}

/**
 * Total length of the electronic-format IBAN per country, from the ISO
 * 13616 registry maintained by SWIFT. A country absent from the registry
 * has no IBAN standard to be well-formed against, so its codes are
 * rejected rather than length-checked loosely - which is what makes the
 * length half of this test meaningful at all.
 */
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22,
  MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/**
 * Validate an International Bank Account Number (ISO 13616).
 *
 * Three independent things have to hold, and a string that satisfies only
 * the first two is the common counterfeit: the country's registered
 * length, the alphanumeric body shape, and the ISO 7064 MOD 97-10 check
 * digits. Both written forms are accepted - the compact electronic format
 * (`NL91ABNA0417164300`) and the ISO 13616-2 print format, which groups
 * into fours with single spaces (`NL91 ABNA 0417 1643 00`). Lowercase is
 * accepted for the same reason the other testers here accept it.
 *
 * @param {string} str - The candidate IBAN
 * @returns {boolean} True when the string is a well-formed IBAN
 */
export function isValidIBAN(str) {
  const len = str.length;
  if (len < 15 || len > 34 + 8) return false;

  // The print format puts a single space after every fourth character, so
  // the compact length determines the spaced length exactly. Deciding the
  // written form up front turns the compact position -> source index map
  // into arithmetic, and keeps the whole test allocation-free.
  const spaced = str.charCodeAt(4) === 0x20;
  const n = spaced ? len - ((len / 5) | 0) : len;
  if (n < 15 || n > 34) return false;
  if (spaced && len !== n + ((n - 1) / 4 | 0)) return false;

  // Country code and check digits: two letters then two digits.
  const c0 = str.charCodeAt(0) & ~0x20; // uppercase the ASCII letter
  const c1 = str.charCodeAt(1) & ~0x20;
  if (c0 < 0x41 || c0 > 0x5A || c1 < 0x41 || c1 > 0x5A) return false;
  const registered = IBAN_LENGTHS[String.fromCharCode(c0, c1)];
  if (registered !== n) return false;

  // ISO 7064 MOD 97-10 over the rearranged string: the body (compact
  // positions 4..n-1) followed by the country code and check digits, with
  // letters expanded to their two-digit values A=10 .. Z=35. A running
  // remainder keeps every intermediate under 9735, so this stays exact in
  // a Number without a BigInt or an intermediate string.
  let rem = 0;
  for (let p = 0; p < n; p++) {
    const q = p + 4 < n ? p + 4 : p + 4 - n;
    const i = spaced ? q + ((q / 4) | 0) : q;
    const code = str.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) {
      rem = (rem * 10 + (code - 0x30)) % 97;
    }
    else {
      const upper = code & ~0x20; // uppercase the ASCII letter
      if (upper < 0x41 || upper > 0x5A) return false;
      if (q === 2 || q === 3) return false; // the check digits must be digits
      rem = (rem * 100 + (upper - 55)) % 97;
    }
  }
  return rem === 1;
}
