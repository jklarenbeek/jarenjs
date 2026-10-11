//@ts-check
/**
 * @file `$date-format` over a value without the half a pattern token reads is
 * `JQ2001`, as `$year` and `$hours` are; and `$date-diff` counts a month as
 * whole only once the clock has reached it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compileJsonQuery, queryJson } from '@jarenjs/json/query';

/** @param {any} query @param {any} data */
const run = (query, data) => queryJson(query, data);

describe('$date-format — a value without the half a token reads', () => {
  it('refuses a year of a full-time and an hour of a full-date', () => {
    assert.throws(() => run({ '$date-format': ['$.at', 'yyyy-MM-dd'] }, { at: '12:30:15Z' }),
      (error) => /** @type {any} */ (error).code === 'JQ2001' && /carries no date component/.test(/** @type {any} */ (error).message));
    assert.throws(() => run({ '$date-format': ['$.at', 'HH:mm'] }, { at: '2024-03-05' }),
      (error) => /** @type {any} */ (error).code === 'JQ2001' && /carries no time component/.test(/** @type {any} */ (error).message));
  });

  it('refuses the same through a computed pattern', () => {
    assert.throws(() => run({ '$date-format': ['$.at', '$.p'] }, { at: '12:30:15Z', p: 'dd' }),
      (error) => /** @type {any} */ (error).code === 'JQ2001');
  });

  it('formats each form with a pattern it can fill', () => {
    assert.strictEqual(run({ '$date-format': ['$.at', 'yyyy/MM/dd'] }, { at: '2024-03-05' }), '2024/03/05');
    assert.strictEqual(run({ '$date-format': ['$.at', 'HH.mm'] }, { at: '12:30:15Z' }), '12.30');
    assert.strictEqual(run({ '$date-format': ['$.at', 'yyyy HH'] }, { at: '2024-03-05T07:00:00Z' }), '2024 07');
  });

  it('still compiles a literal pattern once', () => {
    assert.doesNotThrow(() => compileJsonQuery({ '$date-format': ['$.at', 'yyyy'] }));
  });
});

describe('$date-diff — months with a clock', () => {
  it('counts a month only once its instant is reached', () => {
    const at = { a: '2024-01-15T12:00:00Z', b: '2024-02-15T10:00:00Z', c: '2024-02-15T12:00:00Z' };
    assert.strictEqual(run({ '$date-diff': ['$.a', '$.b', 'month'] }, at), 0);
    assert.strictEqual(run({ '$date-diff': ['$.a', '$.c', 'month'] }, at), 1);
    assert.strictEqual(run({ '$date-diff': ['$.b', '$.a', 'month'] }, at), 0);
    assert.strictEqual(run({ '$date-diff': ['$.a', '$.b', 'year'] }, at), 0);
  });
});
