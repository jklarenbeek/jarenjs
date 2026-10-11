//@ts-check
/**
 * Engines are looked up by an id that arrives from a URL or saved state.
 * An id that names a member every object inherits (`constructor`,
 * `__proto__`, `toString`) used to find that member and fail with
 * `engine.run is not a function` instead of `unknown engine`. And a
 * timing that was not measured as a number prints a dash — `NaN` and
 * `Infinity` included, which printed as `NaN ms`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { runExample } from '@jarenjs/play';
import { formatMs } from '../../components/play/src/format.js';

describe('@jarenjs/play — an unknown engine id is unknown', function () {
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'nope']) {
    it(`answers "unknown engine" for ${id}`, () => {
      const result = /** @type {any} */ (runExample(id, {}, {}));
      assert.equal(result.ok, false);
      assert.deepEqual(result.error, { message: `unknown engine: ${id}` });
      assert.deepEqual(result.panels, []);
    });
  }
});

describe('@jarenjs/play — formatMs', function () {
  it('prints a dash for anything that is not a finite number', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, '3']) assert.equal(formatMs(bad), '—', String(bad));
  });

  it('prints measured durations to two decimals and a floor below that', () => {
    assert.equal(formatMs(1.234), '1.23 ms');
    assert.equal(formatMs(0), '<0.01 ms');
    assert.equal(formatMs(0.004), '<0.01 ms');
    assert.equal(formatMs(12), '12.00 ms');
  });
});
