import * as assert from 'node:assert';

export function isTrue(val, msg) {
    assert.strictEqual(val, true, msg);
};

export function isFalse(val, msg) {
  assert.strictEqual(val, false, msg);
};

export function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
}

export const throws = assert.throws;
