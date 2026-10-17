import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

// xs:date, xs:dateTime and xs:time onto the engine's RFC 3339 strings: a
// value is admitted where its text sorts in time order and is the XSD
// canonical form (no timezone on a date; UTC and no fraction on a
// dateTime or a time; the years 0000 to 9999), and refused by name
// everywhere else.

describe('XQuery front-end xs:date, xs:dateTime and xs:time', () => {
  describe('literal operands fold to the canonical text', () => {
    it('should fold a date without a timezone, white space trimmed, a leap day checked', () => {
      assert.deepStrictEqual(validated('xs:date("2000-01-01")'), { '$const': '2000-01-01' });
      assert.deepStrictEqual(validated('xs:date(" 2000-02-29 ")'), { '$const': '2000-02-29' });
      assert.deepStrictEqual(validated('xs:date("0000-01-01")'), { '$const': '0000-01-01' });
      assert.deepStrictEqual(validated('xs:date("9999-12-31")'), { '$const': '9999-12-31' });
    });

    it('should fold a UTC dateTime and time, +00:00 and -00:00 written Z', () => {
      assert.deepStrictEqual(validated('xs:dateTime("2000-01-01T12:30:05Z")'), { '$const': '2000-01-01T12:30:05Z' });
      assert.deepStrictEqual(validated('xs:dateTime("2000-01-01T12:30:05+00:00")'), { '$const': '2000-01-01T12:30:05Z' });
      assert.deepStrictEqual(validated('xs:dateTime("2000-01-01T12:30:05-00:00")'), { '$const': '2000-01-01T12:30:05Z' });
      assert.deepStrictEqual(validated('xs:time("23:59:59Z")'), { '$const': '23:59:59Z' });
      assert.deepStrictEqual(validated('xs:time("00:00:00+00:00")'), { '$const': '00:00:00Z' });
    });

    it('should drop a fraction of zeros and write 24:00:00 as midnight of the next day', () => {
      assert.deepStrictEqual(validated('xs:dateTime("2000-01-01T12:00:00.000Z")'), { '$const': '2000-01-01T12:00:00Z' });
      assert.deepStrictEqual(validated('xs:time("12:00:00.0Z")'), { '$const': '12:00:00Z' });
      assert.deepStrictEqual(validated('xs:dateTime("1999-12-31T24:00:00Z")'), { '$const': '2000-01-01T00:00:00Z' });
      assert.deepStrictEqual(validated('xs:dateTime("2000-02-28T24:00:00.00Z")'), { '$const': '2000-02-29T00:00:00Z' });
      assert.deepStrictEqual(validated('xs:time("24:00:00Z")'), { '$const': '00:00:00Z' });
    });

    it('should give the empty sequence for the empty sequence', () => {
      assert.deepStrictEqual(values('xs:date(())'), []);
      assert.deepStrictEqual(values('xs:time(())'), []);
      assert.deepStrictEqual(values('() cast as xs:dateTime?'), []);
    });

    it('should fail a text outside the lexical space when the cast runs (FORG0001)', () => {
      for (const text of ['2001-02-29', '2004-13-01', '+2004-08-01', '02004-08-01', '2002-02-15T24:01:00Z',
        '2002-02-15T21:01:60Z', '1999-12-01T23:59:12-15:00', '24:00:00.001Z', 'true', ''])
        for (const type of ['date', 'dateTime', 'time'])
          failsAtRun(`xs:${type}("${text}")`, {}, 'err:FORG0001');
      assert.deepStrictEqual(values('if (false()) then xs:date("x") else 1'), [1]);
    });

    it('should fail a number or a boolean, which XQuery does not cast to a date (XPTY0004)', () => {
      failsAtRun('xs:date(1)', {}, 'err:XPTY0004');
      failsAtRun('xs:time(true())', {}, 'err:XPTY0004');
      failsAtRun('2000 cast as xs:dateTime', {}, 'err:XPTY0004');
      assert.deepStrictEqual(values('1 castable as xs:date'), [false]);
    });
  });

  describe('a value outside the domain is refused by name', () => {
    it('should refuse a date with a timezone and a year RFC 3339 does not spell', () => {
      failsWith('xs:date("2000-01-01Z")', "unsupported construct 'xs:date with a timezone'", 0);
      failsWith('xs:date("2000-01-01+05:00")', "unsupported construct 'xs:date with a timezone'", 0);
      failsWith('xs:date("10000-01-01")', "unsupported construct 'xs:date outside the years 0000 to 9999'", 0);
      failsWith('xs:date("-0001-01-01")', "unsupported construct 'xs:date outside the years 0000 to 9999'", 0);
    });

    it('should refuse a dateTime or time without a timezone, in another one, or with a fraction', () => {
      failsWith('xs:dateTime("2000-01-01T12:00:00")', "unsupported construct 'xs:dateTime without a timezone'", 0);
      failsWith('xs:dateTime("2000-01-01T12:00:00-05:00")', "unsupported construct 'xs:dateTime with a timezone other than Z'", 0);
      failsWith('xs:dateTime("2000-01-01T12:00:00.5Z")', "unsupported construct 'xs:dateTime with a fraction of a second'", 0);
      failsWith('xs:time("12:00:00")', "unsupported construct 'xs:time without a timezone'", 0);
      failsWith('xs:time("12:00:00+14:00")', "unsupported construct 'xs:time with a timezone other than Z'", 0);
      failsWith('xs:dateTime("9999-12-31T24:00:00Z")', "unsupported construct 'xs:dateTime outside the years 0000 to 9999'", 0);
    });

    it('should read a string literal as a string, whatever date it spells (FORG0001)', () => {
      failsAtRun('xs:date("2000-01-01T00:00:00Z")', {}, 'err:FORG0001');
      failsAtRun('xs:time("2000-01-01T00:00:00Z")', {}, 'err:FORG0001');
      failsAtRun('"2000-01-01" cast as xs:dateTime', {}, 'err:FORG0001');
      assert.deepStrictEqual(values('"2000-01-01T00:00:00Z" castable as xs:date'), [false]);
    });

    it('should cast a date value of another type as XQuery does, refusing a result outside the domain', () => {
      assert.deepStrictEqual(values('xs:time(xs:dateTime("2000-01-01T12:30:00Z"))'), ['12:30:00Z']);
      assert.deepStrictEqual(values('let $d := xs:dateTime("2000-01-01T12:30:00Z") return xs:time($d)'), ['12:30:00Z']);
      assert.deepStrictEqual(values('let $d := xs:date("2000-01-01") return $d cast as xs:date'), ['2000-01-01']);
      // a dateTime's date keeps its timezone, a date's dateTime has none
      failsWith('xs:date(xs:dateTime("2000-01-01T00:00:00Z"))', "unsupported construct 'xs:date with a timezone'", 0);
      failsWith('xs:dateTime(xs:date("2000-01-01"))', "unsupported construct 'xs:dateTime without a timezone'", 0);
      failsWith('let $d := xs:date("2000-01-01") return xs:dateTime($d)', "unsupported construct 'xs:dateTime without a timezone'", 39);
      // XQuery casts neither a date to a time nor a time to a date (XPTY0004)
      failsAtRun('xs:time(xs:date("2000-01-01"))', {}, 'err:XPTY0004');
      assert.deepStrictEqual(values('let $t := xs:time("12:00:00Z") return $t castable as xs:date'), [false]);
      assert.deepStrictEqual(values('let $t := xs:time(()) return xs:date($t)'), []);
    });

    it('should refuse a literal in cast as and castable as at the cast', () => {
      failsWith('"2000-01-01Z" cast as xs:date', "unsupported construct 'xs:date with a timezone'", 14);
      failsWith('"12:00:00" castable as xs:time', "unsupported construct 'xs:time without a timezone'", 11);
    });
  });

  describe('a computed operand is read when the query runs', () => {
    it('should read a text in the domain', () => {
      assert.deepStrictEqual(values('xs:date($s)', { s: ' 2024-02-29 ' }), ['2024-02-29']);
      assert.deepStrictEqual(values('xs:dateTime($s)', { s: '2024-02-29T23:59:59Z' }), ['2024-02-29T23:59:59Z']);
      assert.deepStrictEqual(values('xs:time($s)', { s: '00:00:00Z' }), ['00:00:00Z']);
    });

    it('should have no value for a text in no date shape or not on the calendar', () => {
      assert.deepStrictEqual(values('$s castable as xs:date', { s: 'x' }), [false]);
      assert.deepStrictEqual(values('$s castable as xs:date', { s: '2001-02-29' }), [false]);
      assert.deepStrictEqual(values('$s castable as xs:time', { s: 'noon' }), [false]);
      assert.deepStrictEqual(values('$s castable as xs:dateTime', { s: 5 }), [false]);
      failsAtRun('xs:date($s)', { s: '2001-02-29' }, 'err:FORG0001');
      failsAtRun('xs:date($s)', { s: null }, 'err:XPTY0004');
    });

    it('should read the texts a literal folds as the literal reads them', () => {
      for (const [type, text, canonical] of [['dateTime', '2007-01-01T10:00:00+00:00', '2007-01-01T10:00:00Z'],
        ['dateTime', '2007-01-01T10:00:00-00:00', '2007-01-01T10:00:00Z'], ['dateTime', '2007-01-01T10:00:00.000Z', '2007-01-01T10:00:00Z'],
        ['dateTime', '2007-12-31T24:00:00Z', '2008-01-01T00:00:00Z'], ['dateTime', ' 2007-12-31T24:00:00.0+00:00 ', '2008-01-01T00:00:00Z'],
        ['time', '24:00:00Z', '00:00:00Z'], ['time', '24:00:00.000-00:00', '00:00:00Z'], ['time', '10:00:00+00:00', '10:00:00Z']]) {
        assert.deepStrictEqual(values(`xs:${type}("${text}")`), [canonical]);
        assert.deepStrictEqual(values(`xs:${type}($s)`, { s: text }), [canonical]);
        assert.deepStrictEqual(values(`$s castable as xs:${type}`, { s: text }), [true]);
      }
      // a day the calendar does not have is no value, a year past 9999 is refused
      failsAtRun('xs:dateTime($s)', { s: '2007-02-29T24:00:00Z' }, 'err:FORG0001');
      failsAtRun('xs:dateTime($s)', { s: '9999-12-31T24:00:00Z' }, 'unsupported');
    });

    it('should raise for a text of the type the domain refuses, never answer false', () => {
      // a leap second is a time XSD does not read, refused rather than told
      // apart from one the domain refuses
      for (const [type, text] of [['time', '23:59:60Z'], ['date', '2000-01-01Z'],
        ['dateTime', '2000-01-01T00:00:00+01:00'], ['dateTime', '2000-01-01T00:00:00.5Z'], ['time', '12:00:00'],
        ['date', '10000-01-01']]) {
        failsAtRun(`xs:${type}($s)`, { s: text }, 'unsupported');
        failsAtRun(`$s castable as xs:${type}`, { s: text }, 'unsupported');
      }
    });

    it('should read a computed string in another date shape as no value, and refuse it when it may be a date value', () => {
      assert.deepStrictEqual(values('$s castable as xs:date', { s: '2000-01-01T00:00:00Z' }), [false]);
      assert.deepStrictEqual(values('$s castable as xs:dateTime', { s: '2000-01-01' }), [false]);
      // an item of a sequence that holds a dateTime value and a string
      failsAtRun('for $v in (xs:dateTime("2000-01-01T00:00:00Z"), $s) return $v castable as xs:date', { s: '2000-01-01T00:00:00Z' },
        'unsupported');
    });

    it('should not capture, or be captured by, the names a user chose', () => {
      assert.deepStrictEqual(values('let $xs_text := "2000-01-01" return xs:date($xs_text)'), ['2000-01-01']);
      assert.deepStrictEqual(values('let $xs_arg := "12:00:00Z" return xs:time($xs_arg)'), ['12:00:00Z']);
      assert.deepStrictEqual(values('let $xs_value := "10:00:00+00:00" return xs:time($xs_value)'), ['10:00:00Z']);
      assert.deepStrictEqual(values('let $xs_day := "2000-01-01T24:00:00Z" return xs:dateTime($xs_day)'), ['2000-01-02T00:00:00Z']);
    });
  });

  describe('the values compare in time order and print as XQuery prints them', () => {
    it('should order dates, dateTimes and times the way XQuery does', () => {
      assert.deepStrictEqual(values('xs:date("2004-07-13") gt xs:date("2004-07-12")'), [true]);
      assert.deepStrictEqual(values('xs:date("0999-12-31") lt xs:date("1000-01-01")'), [true]);
      assert.deepStrictEqual(values('xs:dateTime("1999-12-31T24:00:00Z") eq xs:dateTime("2000-01-01T00:00:00Z")'), [true]);
      assert.deepStrictEqual(values('xs:dateTime("2000-01-01T09:59:59Z") lt xs:dateTime("2000-01-01T10:00:00Z")'), [true]);
      assert.deepStrictEqual(values('xs:time("08:03:35Z") lt xs:time("23:59:59Z")'), [true]);
      assert.deepStrictEqual(values('xs:time("00:00:00Z") eq xs:time("24:00:00Z")'), [true]);
    });

    it('should cast to xs:string as the canonical text, and back to the same value', () => {
      assert.deepStrictEqual(values('string(xs:dateTime("2000-01-01T12:00:00+00:00"))'), ['2000-01-01T12:00:00Z']);
      assert.deepStrictEqual(values('xs:date("1999-05-31") cast as xs:string'), ['1999-05-31']);
      assert.deepStrictEqual(values('xs:date(xs:date("1999-05-31"))'), ['1999-05-31']);
      assert.deepStrictEqual(values('xs:string("13:20:00Z") castable as xs:time'), [true]);
    });

    it('should not cast a date to a number or a boolean (XPTY0004)', () => {
      failsAtRun('xs:date("1999-05-31") cast as xs:integer', {}, 'err:XPTY0004');
      failsAtRun('xs:date("1999-05-31") cast as xs:boolean', {}, 'err:XPTY0004');
      assert.deepStrictEqual(values('xs:date("1999-05-31") castable as xs:double'), [false]);
    });
  });
});
