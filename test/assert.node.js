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
export const doesNotThrow = assert.doesNotThrow;
export const strictEqual = assert.strictEqual;
export const deepStrictEqual = assert.deepStrictEqual;
export const notStrictEqual = assert.notStrictEqual;
export const ok = assert.ok;
