import * as assert from 'node:assert';

export function isTrue(val, msg) {
    assert.strictEqual(val, true, msg);
};

export function isFalse(val, msg) {
  assert.strictEqual(val, false, msg);
};

export const throws = assert.throws;
