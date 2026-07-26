import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidISBN10,
  isValidISBN13,
  isValidCountryAlpha2,
  isValidIBAN,
} from '@jarenjs/core/text/misc';

describe('isValidISBN10', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidISBN10 === 'function');
    const result = isValidISBN10('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should handle various inputs', () => {
    // Just verify it doesn't throw
    assert.doesNotThrow(() => isValidISBN10(''));
    assert.doesNotThrow(() => isValidISBN10('ISBN 0-306-40615-2'));
    assert.doesNotThrow(() => isValidISBN10('123456789X'));
  });
});

describe('isValidISBN13', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidISBN13 === 'function');
    const result = isValidISBN13('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should handle various inputs', () => {
    assert.doesNotThrow(() => isValidISBN13(''));
    assert.doesNotThrow(() => isValidISBN13('ISBN 978-0-306-40615-7'));
    assert.doesNotThrow(() => isValidISBN13('9780306406157'));
  });
});

describe('isValidCountryAlpha2', () => {
  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidCountryAlpha2 === 'function');
    const result = isValidCountryAlpha2('US');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should accept assigned alpha-2 codes', () => {
    for (const code of ['US', 'GB', 'DE', 'NL', 'AF', 'ZW', 'SS', 'CW', 'BQ', 'SX', 'TL', 'ME', 'RS']) {
      assert.isTrue(isValidCountryAlpha2(code), `${code} is assigned`);
    }
  });

  it('should accept XK for Kosovo', () => {
    // Not an ISO assignment: XK is user-assigned, but the EU institutions
    // and the IBAN registry both use it, so the table carries it.
    assert.isTrue(isValidCountryAlpha2('XK'));
  });

  it('should reject unassigned codes', () => {
    for (const code of ['XX', 'ZZ', 'QQ', 'AN']) {
      assert.isFalse(isValidCountryAlpha2(code), `${code} is not assigned`);
    }
  });

  it('should match the whole string, not a prefix', () => {
    // An unanchored alternation accepts anything that merely STARTS with
    // an assigned code, which silently turns this format into "the first
    // two letters name a country".
    assert.isFalse(isValidCountryAlpha2('USA'), 'a three-letter code is not alpha-2');
    assert.isFalse(isValidCountryAlpha2('GBP'), 'a currency code is not a country code');
    assert.isFalse(isValidCountryAlpha2('AFGHANISTAN'), 'a country name is not a country code');
    assert.isFalse(isValidCountryAlpha2('NL '), 'no trailing space');
    assert.isFalse(isValidCountryAlpha2('U'), 'too short');
    assert.isFalse(isValidCountryAlpha2(''), 'empty');
  });

  it('should accept lowercase', () => {
    assert.isTrue(isValidCountryAlpha2('us'));
    assert.isTrue(isValidCountryAlpha2('nL'));
  });
});

describe('isValidIBAN', () => {
  // One example per country, from the ISO 13616 registry published by
  // SWIFT. These are the oracle for the length table and the check
  // digits at once: a wrong registered length fails the length test, a
  // wrong MOD 97-10 fails the checksum.
  const REGISTRY_EXAMPLES = [
    'AD1200012030200359100100', 'AE070331234567890123456', 'AL47212110090000000235698741',
    'AT611904300234573201', 'AZ21NABZ00000000137010001944', 'BA391290079401028494',
    'BE68539007547034', 'BG80BNBG96611020345678', 'BH67BMAG00001299123456',
    'BI4210000100010000332045181', 'BR1800360305000010009795493C1', 'BY13NBRB3600900000002Z00AB00',
    'CH9300762011623852957', 'CR05015202001026284066', 'CY17002001280000001200527600',
    'CZ6508000000192000145399', 'DE89370400440532013000', 'DJ2100010000000154000100186',
    'DK5000400440116243', 'DO28BAGR00000001212453611324', 'EE382200221020145685',
    'EG380019000500000000263180002', 'ES9121000418450200051332', 'FI2112345600000785',
    'FO6264600001631634', 'FR1420041010050500013M02606', 'GB29NWBK60161331926819',
    'GE29NB0000000101904917', 'GI75NWBK000000007099453', 'GL8964710001000206',
    'GR1601101250000000012300695', 'GT82TRAJ01020000001210029690', 'HR1210010051863000160',
    'HU42117730161111101800000000', 'IE29AIBK93115212345678', 'IL620108000000099999999',
    'IQ98NBIQ850123456789012', 'IS140159260076545510730339', 'IT60X0542811101000000123456',
    'JO94CBJO0010000000000131000302', 'KW81CBKU0000000000001234560101', 'KZ86125KZT5004100100',
    'LB62099900000001001901229114', 'LC55HEMM000100010012001200023015', 'LI21088100002324013AA',
    'LT121000011101001000', 'LU280019400644750000', 'LV80BANK0000435195001',
    'LY83002048000020100120361', 'MC5811222000010123456789030', 'MD24AG000225100013104168',
    'ME25505000012345678951', 'MK07250120000058984', 'MR1300020001010000123456753',
    'MT84MALT011000012345MTLCAST001S', 'MU17BOMM0101101030300200000MUR', 'NL91ABNA0417164300',
    'NO9386011117947', 'PK36SCBL0000001123456702', 'PL61109010140000071219812874',
    'PS92PALS000000000400123456702', 'PT50000201231234567890154', 'QA58DOHB00001234567890ABCDEFG',
    'RO49AAAA1B31007593840000', 'RS35260005601001611379', 'RU0304452522540817810538091310419',
    'SA0380000000608010167519', 'SC18SSCB11010000000000001497USD', 'SE4550000000058398257466',
    'SI56263300012039086', 'SK3112000000198742637541', 'SM86U0322509800000000270100',
    'ST23000200000289355710148', 'SV62CENR00000000000000700025', 'TL380080012345678910157',
    'TN5910006035183598478831', 'TR330006100519786457841326', 'UA213223130000026007233566001',
    'VA59001123000012345678', 'VG96VPVG0000012345678901', 'XK051212012345678906',
  ];

  it('should be a function that returns boolean', () => {
    assert.isTrue(typeof isValidIBAN === 'function');
    const result = isValidIBAN('test');
    assert.isTrue(typeof result === 'boolean');
  });

  it('should accept every ISO 13616 registry example', () => {
    for (const iban of REGISTRY_EXAMPLES) {
      assert.isTrue(isValidIBAN(iban), `${iban} is a registry example`);
    }
  });

  it('should accept the ISO 13616-2 print format', () => {
    assert.isTrue(isValidIBAN('NL91 ABNA 0417 1643 00'));
    assert.isTrue(isValidIBAN('GB29 NWBK 6016 1331 9268 19'));
    assert.isTrue(isValidIBAN('NO93 8601 1117 947'), 'a last group shorter than four');
    assert.isTrue(isValidIBAN('BE68 5390 0754 7034'), 'a last group of exactly four');
  });

  it('should reject stray or misplaced separators', () => {
    assert.isFalse(isValidIBAN('NL91A BNA0417164300'), 'a space off the group boundary');
    assert.isFalse(isValidIBAN('NL91  ABNA0417164300'), 'a doubled space');
    assert.isFalse(isValidIBAN('NL91-ABNA-0417-1643-00'), 'hyphens are not the print format');
    assert.isFalse(isValidIBAN('NL91 ABNA 0417 1643 00 '), 'a trailing space');
  });

  it('should reject a wrong MOD 97-10 check', () => {
    // The digit-transposition class of typo the check digits exist for.
    assert.isFalse(isValidIBAN('NL91ABNA0417164301'));
    assert.isFalse(isValidIBAN('DE89370400440532013001'));
    assert.isFalse(isValidIBAN('GB29NWBK60161331926818'));
    assert.isFalse(isValidIBAN('NL19ABNA0417164300'), 'transposed check digits');
  });

  it("should reject a length the country's registry entry does not allow", () => {
    assert.isFalse(isValidIBAN('NL91ABNA04171643001'), 'one character too long');
    assert.isFalse(isValidIBAN('NL91ABNA041716430'), 'one character too short');
  });

  it('should reject a country with no IBAN standard', () => {
    assert.isFalse(isValidIBAN('US64SVBKUS6S3300958879'), 'the US has no IBAN');
    assert.isFalse(isValidIBAN('ZZ91ABNA0417164300'), 'unassigned country code');
  });

  it('should reject a malformed prefix', () => {
    assert.isFalse(isValidIBAN('NLAAABNA0417164300'), 'letters where the check digits belong');
    assert.isFalse(isValidIBAN('1291ABNA0417164300'), 'digits where the country code belongs');
    assert.isFalse(isValidIBAN('NL91ABNA04171643@0'), 'a non-alphanumeric in the body');
  });

  it('should reject strings that are not IBAN-shaped at all', () => {
    assert.isFalse(isValidIBAN(''));
    assert.isFalse(isValidIBAN('NL91'));
    assert.isFalse(isValidIBAN('test'));
    assert.isFalse(isValidIBAN('X'.repeat(64)));
  });

  it('should accept lowercase', () => {
    assert.isTrue(isValidIBAN('nl91abna0417164300'));
    assert.isTrue(isValidIBAN('nl91 abna 0417 1643 00'));
  });
});
