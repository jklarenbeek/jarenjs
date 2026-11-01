//@ts-check
/**
 * What the standard number action writes for a value a host hands over.
 * `form/number` read its value's truth, so a host that dispatched the
 * number `0` (or `-0`) cleared the control: the member was removed under
 * the default and written `null` under `cleared: 'empty'`. A number is
 * now written as itself, `0` and `-0` included, under both modes; `null`,
 * `undefined`, `''`, `false` and `NaN` still clear the control, and the
 * text an `<input type=number>` hands over is read as before.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createApp, createFormActions } from '@jarenjs/app';

/** What a member reads after the action removed it. */
const REMOVED = Symbol('removed');
/** What the member and the element keep when the action refuses the value. */
const REFUSED = Symbol('refused');

/**
 * Dispatch one value through `form/number` into the member `/age` (44)
 * and into the array element `/list/0` (7), each over a fresh app.
 * @param {'remove' | 'empty' | undefined} cleared
 * @param {unknown} value
 * @returns {{ member: unknown, element: unknown }}
 */
function hand(cleared, value) {
  /** @param {boolean} element */
  const write = (element) => {
    /** @type {any[]} */
    const errors = [];
    const app = createApp({
      state: { data: { age: 44, list: [7, 8] } },
      view: [{ match: '$', body: ['main', {}] }],
      actions: createFormActions({ cleared }),
    }, { schedule: (/** @type {() => void} */ f) => f(), onError: (/** @type {unknown} */ e) => errors.push(e) });
    app.dispatch('form/number', { pointer: element ? '/list/0' : '/age', element }, { type: 'input', target: { value } });
    const data = app.getState().data;
    if (errors.length > 0) {
      assert.deepEqual(errors.map((e) => e?.code), ['JA2002']);
      assert.deepEqual(data, { age: 44, list: [7, 8] }, 'a refused value writes nothing');
      return REFUSED;
    }
    if (element) return data.list[0];
    return Object.hasOwn(data, 'age') ? data.age : REMOVED;
  };
  return { member: write(false), element: write(true) };
}

/** @param {unknown} value */
const label = (value) => (typeof value === 'bigint' ? `${value}n`
  : Object.is(value, -0) ? '-0'
    : typeof value === 'number' && !Number.isFinite(value) ? String(value)
      : value === undefined ? 'undefined' : JSON.stringify(value));

/**
 * Every value with what it writes: [value, member under the default,
 * member under 'empty', element in both modes].
 * @type {[unknown, unknown, unknown, unknown][]}
 */
const NOW_WRITTEN = [
  [0, 0, 0, 0],
  [-0, -0, -0, -0],
];

/** @type {[unknown, unknown, unknown, unknown][]} */
const STILL_CLEARED = [null, undefined, '', false, NaN].map((value) => [value, REMOVED, null, null]);

/** @type {[unknown, unknown, unknown, unknown][]} */
const AS_BEFORE = [
  // a number other than zero, as itself
  ...[5, -5, 0.5, 1e308, 5e-324, -1.7976931348623157e308, Infinity, -Infinity].map((n) => /** @type {[unknown, unknown, unknown, unknown]} */ ([n, n, n, n])),
  [true, 1, 1, 1],
  // the text an <input type=number> hands over
  ['0', 0, 0, 0], ['-0', -0, -0, -0], ['00', 0, 0, 0], ['-00', -0, -0, -0], ['0.0', 0, 0, 0], ['0e0', 0, 0, 0],
  ['.5', 0.5, 0.5, 0.5], ['-.5', -0.5, -0.5, -0.5], ['01', 1, 1, 1], ['5', 5, 5, 5], ['1e3', 1000, 1000, 1000],
  // what still is no number: refused, nothing written
  ...['.', '5.', '-', 'e5', 'abc', ' 5', [], {}, 5n, 0n].map((value) => /** @type {[unknown, unknown, unknown, unknown]} */ ([value, REFUSED, REFUSED, REFUSED])),
];

/** @param {[unknown, unknown, unknown, unknown][]} rows */
function check(rows) {
  /** @type {string[]} */
  const wrong = [];
  for (const [value, removing, emptying, element] of rows) {
    for (const cleared of /** @type {const} */ ([undefined, 'remove', 'empty'])) {
      const got = hand(cleared, value);
      const want = { member: cleared === 'empty' ? emptying : removing, element };
      // strict deep equality tells -0 from 0
      try {
        assert.deepEqual(got, want);
      }
      catch {
        wrong.push(`${label(value)} under ${String(cleared)}: member ${label(got.member)}, element ${label(got.element)}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
}

describe('form/number — a number a host hands over', function () {
  it('writes 0 and -0 as themselves, as a member and as an element, under both modes', function () {
    check(NOW_WRITTEN);
  });

  it('still reads null, undefined, the empty text, false and NaN as a cleared control', function () {
    check(STILL_CLEARED);
  });

  it('writes every other value as before: numbers, true, and the text a number input hands over', function () {
    check(AS_BEFORE);
  });

  it('writes 0 into an absent member, and the empty text still removes it', function () {
    const app = createApp({
      state: { data: {} },
      view: [{ match: '$', body: ['main', {}] }],
      actions: createFormActions(),
    }, { schedule: (/** @type {() => void} */ f) => f() });
    app.dispatch('form/number', { pointer: '/age' }, { type: 'input', target: { value: 0 } });
    assert.deepEqual(app.getState().data, { age: 0 });
    app.dispatch('form/number', { pointer: '/age' }, { type: 'input', target: { value: '' } });
    assert.deepEqual(app.getState().data, {}, 'the empty text still removes it');
  });
});
