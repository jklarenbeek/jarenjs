//@ts-check
/**
 * @file `$instant` and `$wall` (QUERY-FORMAT §8.13): the two keys a calendar
 * value (`@jarenjs/core/calendar`) compares by. `$instant` is the epoch a utc
 * value names, or a zoned value resolved under the policy its second operand
 * names in the compilation's zone provider; a date, floating or date-range
 * value names none. `$wall` is a floating or zoned value's wall clock in its
 * one spelling, so `10:00` and `10:00:00.000` are one key and the key's
 * code-point order is the clock's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery, queryJson } from '@jarenjs/json/query';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { from } from '@jarenjs/linq';

const zoneProvider = createIntlZoneProvider({ revision: 'test' });
/** @param {any} query @param {any} doc @param {any} [options] */
const run = (query, doc, options) => compileJsonQuery(query, options)(doc);
/** @param {() => unknown} fn @param {string} code @param {RegExp} [message] */
const raises = (fn, code, message) => assert.throws(fn, (/** @type {any} */ e) => {
  assert.equal(e.code, code, e.message);
  if (message !== undefined) assert.match(e.message, message);
  return true;
});
const utc = (instant) => ({ kind: 'utc', instant });
const floating = (date, time) => ({ kind: 'floating', date, time });
const zoned = (date, time, zone) => ({ kind: 'zoned', date, time, zone });

describe('$instant', () => {
  it('answers the epoch a utc value names, every spelling of one instant alike', () => {
    for (const instant of ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.0Z', '2026-01-01T00:00:00.00Z', '2026-01-01T00:00:00.000Z'])
      assert.equal(run({ $instant: ['$.v'] }, { v: utc(instant) }), Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(run({ $instant: ['$.v'] }, { v: utc('0000-01-01T00:00:00Z') }), -62167219200000);
    assert.equal(run({ $instant: ['$.v'] }, { v: utc('9999-12-31T23:59:59.999Z') }), 253402300799999);
  });

  it('orders a utc member by its instant, where its text orders `.5Z` before `Z`', () => {
    const rows = [{ id: 'late', v: utc('2026-01-01T00:00:00.5Z') }, { id: 'early', v: utc('2026-01-01T00:00:00Z') }];
    assert.deepEqual(queryJson({ $for: { r: '$[*]' }, $orderby: '$r.v.instant', $return: '$r.id' }, rows), ['late', 'early']);
    assert.deepEqual(queryJson({ $for: { r: '$[*]' }, $orderby: { $instant: ['$r.v'] }, $return: '$r.id' }, rows), ['early', 'late']);
  });

  it('resolves a zoned value under its policy, in the zone provider', () => {
    const fold = { v: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') };
    assert.equal(run({ $instant: ['$.v', 'rfc5545'] }, fold, { zoneProvider }), Date.parse('2026-10-25T00:30:00Z'));
    assert.equal(run({ $instant: ['$.v', 'later'] }, fold, { zoneProvider }), Date.parse('2026-10-25T01:30:00Z'));
    raises(() => run({ $instant: ['$.v', 'reject'] }, fold, { zoneProvider }), 'JQ2001', /resolves to no instant under 'reject' \(JY0003\)/);
    const gap = { v: zoned('2026-03-29', '02:30', 'Europe/Amsterdam') };
    raises(() => run({ $instant: ['$.v', 'reject'] }, gap, { zoneProvider }), 'JQ2001', /JY0002/);
    assert.equal(run({ $instant: ['$.v', 'rfc5545'] }, gap, { zoneProvider }), Date.parse('2026-03-29T01:30:00Z'));
  });

  it('refuses a zoned value with no policy, no provider or a zone the provider does not know', () => {
    const doc = { v: zoned('2026-07-01', '10:00', 'Europe/Amsterdam') };
    raises(() => run({ $instant: ['$.v'] }, doc, { zoneProvider }), 'JQ2001', /under a policy/);
    raises(() => run({ $instant: ['$.v', 'rfc5545'] }, doc), 'JQ2001', /needs a time-zone provider/);
    raises(() => run({ $instant: ['$.v', 'rfc5545'] }, { v: zoned('2026-07-01', '10:00', 'Nowhere/City') }, { zoneProvider }), 'JQ2001', /JY0001/);
  });

  it('refuses a policy no resolution has, when the query compiles', () => {
    raises(() => compileJsonQuery({ $instant: ['$.v', 'earlier'] }), 'JQ0003', /'rfc5545', 'later' or 'reject'/);
    raises(() => compileJsonQuery({ $instant: ['$.v', 'later', 'x'] }), 'JQ0003');
    raises(() => compileJsonQuery({ $instant: '$.v' }), 'JQ0003');
  });

  it('names no instant for a date, floating or date-range value, and refuses what is no calendar value', () => {
    for (const v of [{ kind: 'date', date: '2026-07-01' }, floating('2026-07-01', '10:00'), { kind: 'date-range', start: '2026-07-01', end: '2026-07-02' }])
      raises(() => run({ $instant: ['$.v'] }, { v }), 'JQ2001', new RegExp(`of kind utc, zoned, got ${v.kind}`));
    raises(() => run({ $instant: ['$.v'] }, { v: '2026-01-01T00:00:00Z' }), 'JQ2001', /got a string/);
    raises(() => run({ $instant: ['$.v'] }, { v: utc('2026-01-01T00:00:00.1234Z') }), 'JQ2001', /JY0010/);
    raises(() => run({ $instant: ['$.v'] }, { v: { ...utc('2026-01-01T00:00:00Z'), extra: 1 } }), 'JQ2001', /refused by the calendar/);
    assert.equal(run({ $instant: ['$.missing'] }, {}), undefined);
  });
});

describe('$wall', () => {
  it('spells every admitted time of one wall clock as one key', () => {
    for (const time of ['10:00', '10:00:00', '10:00:00.0', '10:00:00.00', '10:00:00.000'])
      assert.equal(run({ $wall: '$.v' }, { v: floating('2026-07-01', time) }), '2026-07-01T10:00:00.000');
    assert.equal(run({ $wall: '$.v' }, { v: floating('2026-07-01', '09:59:59.5') }), '2026-07-01T09:59:59.500');
    assert.equal(run({ $wall: '$.v' }, { v: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') }), '2026-10-25T02:30:00.000');
  });

  it('compares wall clocks by value, where the time member compares by spelling', () => {
    const rows = [{ id: 'a', v: floating('2026-07-01', '10:00') }, { id: 'b', v: floating('2026-07-01', '10:00:00') }];
    assert.deepEqual(queryJson({ $for: { r: '$[*]' }, $where: { $lt: ['$r.v.time', '10:00:00'] }, $return: '$r.id' }, rows), 'a');
    assert.equal(queryJson({ $for: { r: '$[*]' }, $where: { $lt: [{ $wall: '$r.v' }, '2026-07-01T10:00:00.000'] }, $return: '$r.id' }, rows), undefined);
    assert.deepEqual(queryJson({ $for: { r: '$[*]' }, $where: { $eq: [{ $wall: '$r.v' }, '2026-07-01T10:00:00.000'] }, $return: '$r.id' }, rows), ['a', 'b']);
  });

  it('refuses a value with no wall clock', () => {
    raises(() => run({ $wall: '$.v' }, { v: utc('2026-01-01T00:00:00Z') }), 'JQ2001', /of kind floating, zoned, got utc/);
    raises(() => run({ $wall: '$.v' }, { v: floating('2026-07-01', '24:00') }), 'JQ2001', /JY0008/);
  });
});

describe('the chain spells both', () => {
  it('instantOf and wallClock', () => {
    const rows = [{ id: 'a', on: utc('2026-01-01T00:00:00.5Z'), f: floating('2026-07-01', '10:00') },
      { id: 'b', on: utc('2026-01-01T00:00:00Z'), f: floating('2026-07-01', '09:00:00.000') }];
    assert.deepEqual(from(rows).orderBy((r) => r.on.instantOf()).select((r) => r.id).toArray(), ['b', 'a']);
    assert.deepEqual(from(rows).orderBy((r) => r.f.wallClock()).select((r) => r.f.wallClock()).toArray(),
      ['2026-07-01T09:00:00.000', '2026-07-01T10:00:00.000']);
    const z = [{ id: 'z', on: zoned('2026-10-25', '02:30', 'Europe/Amsterdam') }];
    assert.deepEqual(from(z, { zoneProvider }).select((r) => r.on.instantOf('later')).toArray(), [Date.parse('2026-10-25T01:30:00Z')]);
  });
});
