//@ts-check
/**
 * @file `createJsonStateValidator()`: the state stays JSON in time
 * proportional to what a transition changed. The cost is asserted by
 * counting the nodes the check visits — every state node is a counting
 * Proxy — never by timing.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createJsonStateValidator } from '@jarenjs/app';
import { applyJSONPatch } from '@jarenjs/json/patch';

/**
 * A state whose every object and array counts the reads made of it.
 * @param {any} value
 * @param {{ n: number }} visits
 * @returns {any}
 */
function counted(value, visits) {
  if (value === null || typeof value !== 'object') return value;
  const target = Array.isArray(value) ? value.map((item) => counted(item, visits))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, counted(item, visits)]));
  return new Proxy(target, {
    get(t, key, receiver) { visits.n++; return Reflect.get(t, key, receiver); },
    ownKeys(t) { visits.n++; return Reflect.ownKeys(t); },
  });
}

/** A state of `size` rows. @param {number} size */
const rows = (size) => ({ title: 'list', rows: Array.from({ length: size }, (_, i) => ({ id: i, name: `row ${i}` })) });

/**
 * Apply one patch to a counted state and count what the validator visits.
 * @param {number} size
 * @param {any[]} patch
 */
function visitsFor(size, patch) {
  const visits = { n: 0 };
  const { doc, changes } = applyJSONPatch(counted(rows(size), visits), patch, { changes: true });
  visits.n = 0;
  const verdict = createJsonStateValidator()(doc, { changes });
  return { verdict, visits: visits.n, changes };
}

describe('createJsonStateValidator — what changed, not how large the state is', () => {
  it('a one-field replace visits the same nodes over 100 rows and over 10,000', () => {
    const patch = [{ op: 'replace', path: '/rows/7/name', value: 'renamed' }];
    const small = visitsFor(100, patch);
    const large = visitsFor(10_000, patch);
    assert.strictEqual(small.verdict, true);
    assert.strictEqual(large.verdict, true);
    assert.deepStrictEqual(large.changes, ['/rows/7/name']);
    assert.strictEqual(large.visits, small.visits);
    assert.ok(large.visits < 10, `${large.visits} visits`);
  });

  it('an append visits the appended row and its path, whatever the length', () => {
    const patch = [{ op: 'add', path: '/rows/-', value: { id: -1, name: 'new' } }];
    const small = visitsFor(100, patch);
    const large = visitsFor(10_000, patch);
    assert.deepStrictEqual(large.changes, ['/rows/10000']);
    assert.strictEqual(large.visits, small.visits);
    assert.ok(large.visits < 10, `${large.visits} visits`);
  });

  it('an insert or a removal that shifts the array checks the whole array — the stated limit', () => {
    for (const patch of [[{ op: 'add', path: '/rows/3', value: { id: -1, name: 'in' } }], [{ op: 'remove', path: '/rows/3' }]]) {
      const large = visitsFor(10_000, patch);
      assert.strictEqual(large.verdict, true);
      assert.deepStrictEqual(large.changes, ['/rows']);
      assert.ok(large.visits >= 10_000, `${large.visits} visits for ${patch[0].op}`);
    }
  });

  it('null changes, and a root write, check the whole state; a removed location passes', () => {
    const validate = createJsonStateValidator();
    assert.strictEqual(validate({ a: [1, 'x'] }, { changes: null }), true);
    assert.strictEqual(validate({ a: [1, 'x'] }), true, 'the boot context');
    // the detail names where the offending value sits, under the location checked
    assert.deepStrictEqual(validate({ a: new Map() }, { changes: null }),
      { valid: false, errors: [{ instancePath: '/a', message: 'is not a JSON value' }] });
    assert.deepStrictEqual(validate({ a: NaN }, { changes: [''] }),
      { valid: false, errors: [{ instancePath: '/a', message: 'is not a JSON value' }] });
    assert.strictEqual(validate({ a: {} }, { changes: ['/a/gone'] }), true);
  });

  it('the detail descends to the offending value: an insert names the item, not the array it shifted', () => {
    const validate = createJsonStateValidator();
    const rows = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const state = { rows: [rows[0], new Date(0), rows[1], rows[2]] };
    assert.deepStrictEqual(validate(state, { changes: ['/rows'] }),
      { valid: false, errors: [{ instancePath: '/rows/1', message: 'is not a JSON value' }] });
    assert.deepStrictEqual(validate({ a: { 'b/c': [1, { d: undefined }] } }, { changes: null }).errors[0].instancePath,
      '/a/b~1c/1/d', 'every segment encoded');
    const loop = /** @type {any} */ ({ x: { y: {} } });
    loop.x.y.back = loop.x;
    assert.deepStrictEqual(validate({ loop }, { changes: ['/loop'] }).errors[0].instancePath, '/loop/x/y/back',
      'a cycle is named where it closes');
  });

  it('a Date entering the state through a patch is caught at the pointer it was written to', () => {
    /** @type {any[]} */
    const reported = [];
    const app = createApp({
      state: { at: null, n: 0 },
      view: [{ match: '$', body: ['p', {}, 'x'] }],
      actions: {
        stamp: { patch: [{ op: 'replace', path: '/at', value: '$payload' }] },
        bump: { patch: [{ op: 'replace', path: '/n', value: 1 }] },
      },
    }, { validateState: createJsonStateValidator(), onError: (/** @type {any} */ error) => reported.push(error) });
    app.dispatch('stamp', new Date(0));
    app.dispatch('bump');
    app.dispatch('stamp', '1970-01-01T00:00:00.000Z');
    assert.deepStrictEqual(reported.map((error) => [error.code, error.detail]),
      [['JA2005', [{ instancePath: '/at', message: 'is not a JSON value' }]]]);
    assert.deepStrictEqual(app.getState(), { at: '1970-01-01T00:00:00.000Z', n: 1 });
    app.destroy();
  });
});
