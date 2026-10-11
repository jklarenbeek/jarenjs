//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { queryJson } from '@jarenjs/json/query';

// RFC 3339 spells the years 0000-9999. A shift or truncation that leaves
// them is refused, never rendered as another date or as a bare time.

const refused = (doc) => assert.throws(() => queryJson(doc, null), (e) => /** @type {any} */ (e).code === 'JQ2001', JSON.stringify(doc));

describe('calendar results outside the years 0000-9999', function () {
  it('refuses a shift past the last day', function () {
    refused({ '$date-add': ['9999-12-31', 1, 'day'] });
    refused({ '$date-add': ['9999-06-01', 1, 'year'] });
    refused({ '$date-add': ['9999-12-01', 'P1M'] });
    refused({ '$date-add': ['9999-12-31T23:59:59.999Z', 1, 'millisecond'] });
    refused({ '$date-add': ['9999-12-31T23:59:59+05:00', 'PT1S'] });
    refused({ '$date-add': ['2026-01-31', 1e9, 'year'] });
  });

  it('refuses a shift before year 0000 instead of answering year 0001 or a time', function () {
    refused({ '$date-sub': ['0000-01-01', 1, 'day'] });
    refused({ '$date-sub': ['0000-01-01', 1, 'year'] });
    refused({ '$date-sub': ['0000-01-01', 1, 'month'] });
    refused({ '$date-sub': ['0000-01-01T00:00:00Z', 1, 'millisecond'] });
  });

  it('refuses a truncation whose boundary leaves the range', function () {
    refused({ '$end-of': ['9999-12-31', 'week'] });
    refused({ '$start-of': ['0000-01-01', 'week'] });
  });

  it('still answers at and inside the edges', function () {
    assert.strictEqual(queryJson({ '$date-add': ['9999-12-30', 1, 'day'] }, null), '9999-12-31');
    assert.strictEqual(queryJson({ '$date-sub': ['0000-01-02', 1, 'day'] }, null), '0000-01-01');
    assert.strictEqual(queryJson({ '$end-of': ['9999-12-31', 'year'] }, null), '9999-12-31');
    assert.strictEqual(queryJson({ '$start-of': ['0000-06-15', 'year'] }, null), '0000-01-01');
    assert.strictEqual(queryJson({ '$date-add': ['0000-01-01T00:00:00Z', 'P1D'] }, null), '0000-01-02T00:00:00Z');
  });

  it('keeps the clock of a time-only value wrapping inside its day', function () {
    assert.strictEqual(queryJson({ '$date-sub': ['00:00:00Z', 1, 'second'] }, null), '23:59:59Z');
    assert.strictEqual(queryJson({ '$date-add': ['23:30:00Z', 1, 'hour'] }, null), '00:30:00Z');
  });
});
