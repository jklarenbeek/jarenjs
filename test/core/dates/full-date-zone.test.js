//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateOnlyRFC3339,
  isDateTimeRFC3339,
  getEpochOfDateOnlyRFC3339,
} from '@jarenjs/core/dates';
import { formatTesters, dateTimeFormats } from '@jarenjs/formats';
import { JarenValidator } from '@jarenjs/validate';
import { queryJson } from '@jarenjs/json/query';

describe('an RFC 3339 full-date carries no zone', () => {
  const zoned = ['2024-02-29Z', '2024-02-29z', '9999-12-31Z', '0000-01-01z'];
  const half = ['2024-02-29ZT12:00:00Z', '2024-02-29z 12:00:00Z', '2024-02-29zt12:00:00z'];

  it('refuses a zone after the date, on its own and inside a date-time', () => {
    for (const text of zoned) assert.equal(isDateOnlyRFC3339(text), false, text);
    for (const text of half) assert.equal(isDateTimeRFC3339(text), false, text);
    assert.equal(isDateOnlyRFC3339('2024-02-29'), true);
    assert.equal(isDateTimeRFC3339('2024-02-29T12:00:00Z'), true);
    assert.equal(isDateTimeRFC3339('2024-02-29 12:00:00z'), true);
    assert.equal(getEpochOfDateOnlyRFC3339('2024-02-29Z', 'none'), 'none');
    assert.equal(getEpochOfDateOnlyRFC3339('2024-02-29'), 1709164800000);
  });

  it('says the same through the date and date-time formats, tester and compiled', () => {
    const compile = (/** @type {string} */ format) =>
      new JarenValidator({ formatAssertion: true }).addFormats(dateTimeFormats).compile({ format });
    const date = compile('date');
    const dateTime = compile('date-time');
    for (const text of zoned) {
      assert.equal(formatTesters.date(text), false, text);
      assert.equal(date(text), false, text);
    }
    for (const text of half) {
      assert.equal(formatTesters['date-time'](text), false, text);
      assert.equal(dateTime(text), false, text);
    }
    assert.equal(date('2024-02-29'), true);
    assert.equal(dateTime('2024-02-29T12:00:00Z'), true);
  });

  it('is not a date to the query engine either', () => {
    assert.equal(queryJson({ '$is-date': '2024-02-29Z' }, null), false);
    assert.equal(queryJson({ '$is-datetime': '2024-02-29ZT12:00:00Z' }, null), false);
    assert.equal(queryJson({ '$is-date': '2024-02-29' }, null), true);
  });
});
