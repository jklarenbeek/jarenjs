//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamConsumer } from '../../packages/contract/src/stream/client.js';

/** @param {number | null} lastSeq */
function observe(lastSeq) {
  /** @type {unknown[][]} */
  const events = [];
  const consumer = createStreamConsumer({
    route: { id: 'feed', validateOutput: () => true, details: 'full', errors: {}, retryOn: new Set() },
    catalog: null,
    meta: { op: 'feed', attempt: null, trace: null, revision: null, etag: null, notModified: false },
    callbacks: {
      onSnapshot: (_, info) => events.push(['snapshot', info.seq]),
      onPatch: (emission) => events.push(['patch', emission.seq]),
      onError: (outcome) => events.push(['error', outcome.ok ? null : outcome.error.code]),
    },
    finish: () => { events.push(['finish']); },
    lastSeq,
  });
  return { consumer, events };
}

describe('stream consumer sequence lifecycle', () => {
  it('accepts an initial zero snapshot when fresh or when replay falls back to a new snapshot', () => {
    for (const cursor of [null, 9]) {
      const { consumer, events } = observe(cursor);
      consumer.snapshot(0, { value: {} });
      consumer.patch(1, { patch: [], seq: 1 });
      assert.deepStrictEqual(events, [['snapshot', 0], ['patch', 1]]);
      assert.strictEqual(consumer.lastSeq(), 1);
      assert.strictEqual(consumer.finished(), false);
    }
  });

  it('terminates once when a zero snapshot would rewind a delivered patch', () => {
    for (const cursor of [null, 3]) {
      const { consumer, events } = observe(cursor);
      consumer.patch(5, { patch: [], seq: 5 });
      consumer.snapshot(0, { value: {} });
      consumer.patch(1, { patch: [], seq: 1 });
      consumer.snapshot(0, { value: {} });
      assert.deepStrictEqual(events, [['patch', 5], ['finish'], ['error', 'JC2092']]);
      assert.strictEqual(consumer.lastSeq(), 5);
      assert.strictEqual(consumer.finished(), true);
    }
  });

  it('rejects a second zero seed while preserving a reset at the current cursor', () => {
    const { consumer, events } = observe(null);
    consumer.snapshot(0, { value: {} });
    consumer.snapshot(0, { value: {} });
    assert.deepStrictEqual(events, [['snapshot', 0], ['finish'], ['error', 'JC2092']]);

    const resumed = observe(5);
    resumed.consumer.snapshot(5, { value: {}, reset: true });
    resumed.consumer.patch(6, { patch: [], seq: 6 });
    assert.deepStrictEqual(resumed.events, [['snapshot', 5], ['patch', 6]]);
    assert.strictEqual(resumed.consumer.lastSeq(), 6);
  });
});
