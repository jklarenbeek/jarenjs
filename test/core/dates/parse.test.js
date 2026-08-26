import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  compileDateParser,
  compileDateFormat,
  formatRFC3339Parts,
  parseRFC3339Parts,
  epochOfRFC3339Parts,
  partsFromEpoch,
} from '@jarenjs/core/dates';

const EN = {
  months: ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  meridiem: ['AM', 'PM'],
};

/** The date half of a parts record, as the contract spells it. */
const DATE_ONLY = { hours: -1, minutes: -1, seconds: -1, offset: null };

describe('compileDateParser: the supported token surface', () => {
  it('should read every numeric token at its documented width', () => {
    assert.deepStrictEqual(compileDateParser('yyyy')('2026'),
      { year: 2026, month: 1, day: 1, ...DATE_ONLY });
    assert.deepStrictEqual(compileDateParser('yyyy-MM-dd')('2026-07-27'),
      { year: 2026, month: 7, day: 27, ...DATE_ONLY });
    assert.deepStrictEqual(compileDateParser('y-M-d')('2026-7-2'),
      { year: 2026, month: 7, day: 2, ...DATE_ONLY });
    assert.deepStrictEqual(compileDateParser('HH:mm:ss')('23:59:58'),
      { year: -1, month: -1, day: -1, hours: 23, minutes: 59, seconds: 58, offset: null });
    assert.deepStrictEqual(compileDateParser('H:m:s')('3:4:5'),
      { year: -1, month: -1, day: -1, hours: 3, minutes: 4, seconds: 5, offset: null });
  });

  it('should read fractional seconds as SSS and S', () => {
    assert.strictEqual(compileDateParser('ss.SSS')('05.250').seconds, 5.25);
    assert.strictEqual(compileDateParser('ss.S')('05.2').seconds, 5.2);
  });

  it('should read a negative and a short year through y', () => {
    assert.strictEqual(compileDateParser('y')('-44').year, -44);
    assert.strictEqual(compileDateParser('y')('7').year, 7);
  });

  it('should read yy on the documented POSIX pivot', () => {
    assert.strictEqual(compileDateParser('yy')('68').year, 2068);
    assert.strictEqual(compileDateParser('yy')('69').year, 1969);
    assert.strictEqual(compileDateParser('yy')('99').year, 1999);
    assert.strictEqual(compileDateParser('yy')('00').year, 2000);
  });

  it('should read month and meridiem names through the provider', () => {
    const wide = compileDateParser('d MMMM yyyy', EN);
    assert.deepStrictEqual(wide('27 July 2026'),
      { year: 2026, month: 7, day: 27, ...DATE_ONLY });
    const short = compileDateParser('dd-MMM-yyyy', EN);
    assert.strictEqual(short('06-Jan-2014').month, 1);
    assert.strictEqual(short('06-Sep-2014').month, 9);
    const clock = compileDateParser('hh:mm a', EN);
    assert.strictEqual(clock('01:30 PM').hours, 13);
    assert.strictEqual(clock('12:30 AM').hours, 0);
    assert.strictEqual(clock('12:30 PM').hours, 12);
  });

  it('should read h/hh with no meridiem as the morning', () => {
    assert.strictEqual(compileDateParser('hh:mm')('12:30').hours, 0);
    assert.strictEqual(compileDateParser('hh:mm')('01:30').hours, 1);
  });

  it('should read the three offset spellings each token writes', () => {
    // an offset is not a value on its own, so each one is read beside a clock
    const xxx = compileDateParser('HH:mmXXX');
    assert.strictEqual(xxx('00:00+02:00').offset, 120);
    assert.strictEqual(xxx('00:00Z').offset, 0);
    assert.strictEqual(xxx('00:00-05:30').offset, -330);
    const xx = compileDateParser('HH:mmXX');
    assert.strictEqual(xx('00:00+0200').offset, 120);
    assert.strictEqual(xx('00:00Z').offset, 0);
    assert.strictEqual(xx('00:00+02:00'), null, 'XX writes no colon');
    const x = compileDateParser('HH:mmX');
    assert.strictEqual(x('00:00+02:00').offset, 120);
    // `X` never WRITES a Z, so it does not read one either
    assert.strictEqual(x('00:00Z'), null);
  });

  it('should honour quoted literals and a doubled quote', () => {
    const p = compileDateParser("yyyy'T'MM");
    assert.strictEqual(p('2026T07').month, 7);
    assert.strictEqual(p('2026X07'), null);
    assert.strictEqual(compileDateParser("yyyy''MM")("2026'07").month, 7);
  });
});

describe('compileDateParser: strictness', () => {
  it('should require full consumption', () => {
    const p = compileDateParser('yyyy-MM-dd');
    assert.strictEqual(p('2026-01-02T03:04'), null);
    assert.strictEqual(p('2026-01-02 '), null);
    assert.strictEqual(p(' 2026-01-02'), null);
    assert.strictEqual(p('2026-01-0'), null);
  });

  it('should refuse impossible civil dates rather than rolling them forward', () => {
    const p = compileDateParser('yyyy-MM-dd');
    assert.strictEqual(p('2014-02-31'), null);
    assert.strictEqual(p('2026-02-29'), null, '2026 is not a leap year');
    assert.strictEqual(p('2024-02-29').day, 29, '2024 is');
    assert.strictEqual(p('2000-02-29').day, 29, 'and so is 2000');
    assert.strictEqual(p('1900-02-29'), null, 'but 1900 is not');
    assert.strictEqual(p('2026-13-01'), null);
    assert.strictEqual(p('2026-00-01'), null);
    assert.strictEqual(p('2026-01-00'), null);
  });

  it('should refuse impossible clock values', () => {
    const p = compileDateParser('HH:mm:ss');
    assert.strictEqual(p('24:00:00'), null);
    assert.strictEqual(p('23:60:00'), null);
    assert.strictEqual(p('23:59:60'), null, 'no leap second through a pattern');
    assert.strictEqual(compileDateParser('hh a', EN)('13 PM'), null);
    assert.strictEqual(compileDateParser('hh a', EN)('00 AM'), null);
    assert.strictEqual(compileDateParser('HH:mmXXX')('00:00+24:00'), null);
    assert.strictEqual(compileDateParser('HH:mmXXX')('00:00+00:60'), null);
  });

  it('should hold a fixed-width token to its width', () => {
    assert.strictEqual(compileDateParser('MM')('7'), null);
    assert.strictEqual(compileDateParser('MM')('007'), null);
    assert.strictEqual(compileDateParser('M')('007'), null);
    assert.strictEqual(compileDateParser('yyyy')('202'), null);
    assert.strictEqual(compileDateParser('SSS')('25'), null);
  });

  it('should return null rather than throw for non-string input', () => {
    const p = compileDateParser('yyyy-MM-dd');
    for (const bad of [null, undefined, 42, {}, []])
      assert.strictEqual(p(bad), null);
  });

  it('should refuse a derived token at compile time, naming it', () => {
    for (const token of ['EEEE', 'EEE', 'E', 'DDD', 'D', 'ww', 'w', 'Q']) {
      assert.throws(() => compileDateParser(`yyyy ${token}`), (err) =>
        err instanceof TypeError && err.message.includes(`'${token}'`), token);
    }
  });

  it('should refuse a name token with no provider, and an empty pattern', () => {
    assert.throws(() => compileDateParser('MMMM'), /months.*provider/s);
    assert.throws(() => compileDateParser('a'), /meridiem.*provider/s);
    assert.throws(() => compileDateParser('MMM', { months: EN.months }), /monthsShort/);
    assert.throws(() => compileDateParser('--/--'), /reads no date or time field/);
    assert.throws(() => compileDateParser(''), /reads no date or time field/);
    assert.throws(() => compileDateParser('XXX'), /reads no date or time field/,
      'an offset alone is not a value');
    assert.throws(() => compileDateParser("yyyy'unterminated"), /unterminated/);
    assert.throws(() => compileDateParser(42), /must be a string/);
  });
});

describe('compileDateParser is the inverse of compileDateFormat', () => {
  const PATTERNS = [
    'yyyy-MM-dd', 'dd-MM-yyyy', 'yy/MM/dd', 'y-M-d',
    "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ssXXX",
    'HH:mm', 'HH:mm:ss.SSS', 'd MMMM yyyy', 'dd-MMM-yyyy hh:mm a',
  ];

  it('should round-trip text through parse and format for every pattern', () => {
    for (const pattern of PATTERNS) {
      const write = compileDateFormat(pattern, EN);
      const read = compileDateParser(pattern, EN);
      // a deterministic sweep of instants, no clock involved
      for (let i = 0; i < 500; i++) {
        const at = Date.UTC(1970, 0, 1) + i * 86_400_137;
        const text = write(partsFromEpoch(at));
        const back = read(text);
        assert.notStrictEqual(back, null, `${pattern} could not read '${text}'`);
        assert.strictEqual(write(back), text, `${pattern} round trip of '${text}'`);
      }
    }
  });

  it('should agree with parseRFC3339Parts on the RFC 3339 shapes', () => {
    const date = compileDateParser('yyyy-MM-dd');
    const stamp = compileDateParser("yyyy-MM-dd'T'HH:mm:ssXXX");
    for (const value of ['2026-07-27', '0001-01-01', '1969-12-31']) {
      assert.deepStrictEqual(date(value), parseRFC3339Parts(value), value);
      assert.strictEqual(formatRFC3339Parts(date(value)), value, value);
    }
    for (const value of [
      '2026-07-27T14:30:05Z', '2026-07-27T14:30:05+02:00', '1969-12-31T23:59:59-05:30',
    ]) {
      assert.deepStrictEqual(stamp(value), parseRFC3339Parts(value), value);
      assert.strictEqual(epochOfRFC3339Parts(stamp(value)),
        epochOfRFC3339Parts(parseRFC3339Parts(value)), value);
    }
  });

  it('should place a pre-1970 date on the same instant the epoch helper does', () => {
    const read = compileDateParser('dd-MM-yyyy');
    const parts = read('06-01-1914');
    assert.strictEqual(epochOfRFC3339Parts(parts), Date.UTC(1914, 0, 6));
  });
});

describe('compileDateParser: compiled once, allocation-light', () => {
  it('should build no reader per call', () => {
    // the compile is the only place a pattern is scanned: two parsers
    // compiled from the same pattern are independent closures, and one
    // parser called twice must not differ from itself
    const p = compileDateParser('yyyy-MM-dd');
    const a = p('2026-07-27');
    const b = p('2026-07-27');
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b, 'each call returns its own record');
  });
});
