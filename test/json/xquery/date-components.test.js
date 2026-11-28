import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery } from '@jarenjs/json/xquery';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

// fn:year-from-date and its siblings onto the engine's lexical component
// operators, over the canonical text of the date domain; the argument is
// read by its static type.

const D = 'xs:date("2021-05-06")';
const DT = 'xs:dateTime("2021-05-06T07:08:09Z")';
const T = 'xs:time("07:08:09Z")';

/** the `{ code, message }` the query's own `$error` raises */
function raisedParams(text, externals = {}) {
  validated(text);
  try {
    compileXQuery(`[${text}]`)(null, externals);
  }
  catch (e) {
    assert.strictEqual(e.code, 'JQ2017', e.message);
    return e.params;
  }
  return assert.fail(`${text} did not raise`);
}

describe('XQuery front-end date and time component functions', () => {
  it('should read each component of a date, a dateTime and a time', () => {
    assert.deepStrictEqual(values(`year-from-date(${D})`), [2021]);
    assert.deepStrictEqual(values(`month-from-date(${D})`), [5]);
    assert.deepStrictEqual(values(`day-from-date(${D})`), [6]);
    assert.deepStrictEqual(values(`fn:year-from-dateTime(${DT})`), [2021]);
    assert.deepStrictEqual(values(`month-from-dateTime(${DT})`), [5]);
    assert.deepStrictEqual(values(`day-from-dateTime(${DT})`), [6]);
    assert.deepStrictEqual(values(`hours-from-dateTime(${DT})`), [7]);
    assert.deepStrictEqual(values(`minutes-from-dateTime(${DT})`), [8]);
    assert.deepStrictEqual(values(`seconds-from-dateTime(${DT})`), [9]);
    assert.deepStrictEqual(values(`hours-from-time(${T})`), [7]);
    assert.deepStrictEqual(values(`minutes-from-time(${T})`), [8]);
    assert.deepStrictEqual(values(`fn:seconds-from-time(${T})`), [9]);
  });

  it('should emit the engine\'s component operator over the value', () => {
    assert.deepStrictEqual(validated(`year-from-date(${D})`), { '$year': { '$const': '2021-05-06' } });
    assert.deepStrictEqual(validated(`seconds-from-dateTime(${DT})`), { '$seconds': { '$const': '2021-05-06T07:08:09Z' } });
    assert.deepStrictEqual(validated(`minutes-from-time(${T})`), { '$minutes': { '$const': '07:08:09Z' } });
    assert.deepStrictEqual(validated(`timezone-from-date(${D})`), { '$offset': { '$const': '2021-05-06' } });
  });

  it('should read the canonical value: 24:00:00 is midnight of the next day, a fraction of zeros dropped, years 0000 and 9999', () => {
    const midnight = 'xs:dateTime("1999-12-31T24:00:00Z")';
    assert.deepStrictEqual(values(`(year-from-dateTime(${midnight}), month-from-dateTime(${midnight}), day-from-dateTime(${midnight}), hours-from-dateTime(${midnight}))`),
      [2000, 1, 1, 0]);
    assert.deepStrictEqual(values('hours-from-time(xs:time("24:00:00Z"))'), [0]);
    assert.deepStrictEqual(values('seconds-from-time(xs:time("01:02:03.000Z"))'), [3]);
    assert.deepStrictEqual(values('year-from-date(xs:date("0000-01-01"))'), [0]);
    assert.deepStrictEqual(values('year-from-date(xs:date("9999-12-31"))'), [9999]);
    assert.deepStrictEqual(values('day-from-date(xs:date("2000-02-29"))'), [29]);
  });

  it('should give a date no timezone: timezone-from-date is the empty sequence', () => {
    assert.deepStrictEqual(values(`timezone-from-date(${D})`), []);
    assert.deepStrictEqual(values('count(timezone-from-date(xs:date($d)))', { d: '2021-05-06' }), [0]);
  });

  it('should read a computed value, and give the empty sequence for an empty argument', () => {
    assert.deepStrictEqual(values('year-from-date(xs:date($d))', { d: ' 2021-05-06 ' }), [2021]);
    assert.deepStrictEqual(values('hours-from-dateTime(xs:dateTime($d))', { d: '2021-05-06T23:00:00+00:00' }), [23]);
    assert.deepStrictEqual(values('year-from-date(())'), []);
    assert.deepStrictEqual(values('year-from-date(xs:date($e?*))', { e: [] }), []);
    assert.deepStrictEqual(values('hours-from-time($e?*)', { e: [] }), []);
    assert.deepStrictEqual(values(`year-from-date(${D}) + 1`), [2022]);
  });

  it('should refuse a value outside the domain as its constructor does', () => {
    failsWith('year-from-date(xs:date("2021-05-06Z"))', "unsupported construct 'xs:date with a timezone'", 15);
    failsWith('hours-from-time(xs:time("07:08:09"))', "unsupported construct 'xs:time without a timezone'", 16);
    failsWith('hours-from-dateTime(xs:dateTime("2021-05-06T07:08:09+01:00"))', "unsupported construct 'xs:dateTime with a timezone other than Z'", 20);
    failsWith('seconds-from-time(xs:time("07:08:09.5Z"))', "unsupported construct 'xs:time with a fraction of a second'", 18);
    failsAtRun('year-from-date(xs:date($d))', { d: '2021-05-06Z' }, 'unsupported');
  });

  it('should raise XQuery\'s XPTY0004 for a value of another type, where one is given', () => {
    assert.deepStrictEqual(raisedParams('year-from-date("2021-05-06")'),
      { code: 'err:XPTY0004', message: 'fn:year-from-date takes an xs:date' });
    assert.deepStrictEqual(raisedParams('hours-from-time($t)', { t: '07:08:09Z' }),
      { code: 'err:XPTY0004', message: 'fn:hours-from-time takes an xs:time' });
    assert.deepStrictEqual(raisedParams(`year-from-date(${DT})`),
      { code: 'err:XPTY0004', message: 'fn:year-from-date takes an xs:date, not an xs:dateTime' });
    assert.deepStrictEqual(raisedParams(`hours-from-dateTime(${T})`),
      { code: 'err:XPTY0004', message: 'fn:hours-from-dateTime takes an xs:dateTime, not an xs:time' });
    assert.deepStrictEqual(raisedParams(`timezone-from-date(${DT})`),
      { code: 'err:XPTY0004', message: 'fn:timezone-from-date takes an xs:date, not an xs:dateTime' });
    failsAtRun('minutes-from-time(12)', {}, 'err:XPTY0004');
    assert.deepStrictEqual(values('if (false()) then year-from-date("x") else 1'), [1]);
  });

  it('should refuse a value that may be a date by name, and the timezone of a dateTime or a time', () => {
    failsWith(`year-from-date(if ($c) then ${D} else "x")`, "unsupported construct 'fn:year-from-date of a value that may be a date'", 0);
    failsWith(`month-from-date([${D}])`, "unsupported construct 'fn:month-from-date of a value that may be a date'", 0);
    failsWith(`timezone-from-dateTime(${DT})`, "unsupported function 'timezone-from-dateTime'", 0);
    failsWith(`fn:timezone-from-time(${T})`, "unsupported function 'fn:timezone-from-time'", 0);
    failsWith('year-from-date()', "unsupported function 'year-from-date#0'", 0);
  });
});
