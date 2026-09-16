//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestDelivery } from '@jarenjs/core/async';

it('bounds a slow callback at one in flight and one latest standalone event', async () => {
  const release = Promise.withResolvers(), seen = [];
  const owner = createLatestDelivery((value) => { seen.push(value); return seen.length === 1 ? release.promise : undefined; },
    (value) => ({ replace: value }));
  owner.notify(1);
  for (let value = 2; value <= 1000; value++) owner.notify(value);
  assert.equal(owner.pending(), 2); assert.deepEqual(seen, [1]);
  release.resolve(); await release.promise; await Promise.resolve();
  assert.deepEqual(seen, [1, { replace: 1000 }]); assert.equal(owner.pending(), 0);
  owner.close(); owner.close(); owner.notify(1001); assert.equal(seen.length, 2);
});

it('isolates rejected callbacks, suppresses delivery after close and handles synchronous reentry', async () => {
  const release = Promise.withResolvers(), seen = [];
  const owner = createLatestDelivery((value) => { seen.push(value); return release.promise; });
  owner.notify(1); owner.notify(2); owner.close();
  release.reject(new Error('observer failure')); await release.promise.catch(() => {}); await Promise.resolve();
  assert.deepEqual(seen, [1]); assert.equal(owner.pending(), 0);
  let calls = 0;
  const nested = createLatestDelivery(() => { if (++calls === 1) nested.notify('again'); throw new Error('isolated'); });
  nested.notify('first'); assert.equal(calls, 2); assert.equal(nested.pending(), 0);
  nested.close();
  assert.throws(() => createLatestDelivery(null), TypeError);
});
