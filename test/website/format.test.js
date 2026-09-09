//@ts-check
/** Projection memo failures must never become another input's result. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { memo1 } from '../../packages/website/src/lib/format.js';

describe('website projection memo', () => {
  it('does not cache failures under the previous successful result', () => {
    const error = new Error('invalid projection');
    let fail = true;
    let calls = 0;
    const memo = memo1((value) => {
      calls++;
      if (value === 'bad' && fail) throw error;
      return { value };
    });
    const good = memo('good');
    assert.throws(() => memo('bad'), (value) => value === error);
    assert.throws(() => memo('bad'), (value) => value === error);
    assert.strictEqual(calls, 3);
    assert.strictEqual(memo('good'), good);
    assert.strictEqual(calls, 3);
    fail = false;
    const recovered = memo('bad');
    assert.deepStrictEqual(recovered, { value: 'bad' });
    assert.strictEqual(memo('bad'), recovered);
    assert.strictEqual(calls, 4);
  });

  it('retries the first input after an initial failure', () => {
    const error = new Error('not ready');
    let calls = 0;
    const memo = memo1((value) => {
      calls++;
      if (calls === 1) throw error;
      return { value };
    });
    assert.throws(() => memo('first'), (value) => value === error);
    const recovered = memo('first');
    assert.deepStrictEqual(recovered, { value: 'first' });
    assert.strictEqual(memo('first'), recovered);
    assert.strictEqual(calls, 2);
  });
});
