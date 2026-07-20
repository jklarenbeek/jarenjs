//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatKey, LocalDate, LocalTime, LocalDateTime } from '@jarenjs/josl';

describe('josl formatKey', function () {
  it('emits a bare key when the identifier is safe, quotes otherwise', function () {
    assert.equal(formatKey('name'), 'name');
    assert.equal(formatKey('a b'), '"a b"');   // whitespace forces quoting
    assert.equal(formatKey('a.b'), '"a.b"');   // a dot would otherwise read as a path
  });
});

describe('josl temporal values serialize to JSON as their canonical text', function () {
  it('LocalDate / LocalTime / LocalDateTime honour JSON.stringify via toJSON', function () {
    const date = new LocalDate(1979, 5, 27);
    const time = new LocalTime(7, 32, 0, '.999');
    const dateTime = new LocalDateTime(date, time);
    assert.equal(JSON.stringify(date), '"1979-05-27"');
    assert.equal(JSON.stringify(time), '"07:32:00.999"');
    assert.equal(JSON.stringify(dateTime), '"1979-05-27T07:32:00.999"');
    // nested inside a container, too (the real serialization path)
    assert.equal(JSON.stringify({ at: dateTime }), '{"at":"1979-05-27T07:32:00.999"}');
  });
});
