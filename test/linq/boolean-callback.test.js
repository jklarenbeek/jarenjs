//@ts-check
/**
 * @file A captured callback that read its argument and answered a plain
 * JavaScript boolean is refused with `JL0109`, in every pen: `===`,
 * `!==`, `!`, `typeof` and `== null` test the capture proxy, never the
 * value, so the document would otherwise hold that constant. A callback
 * that read nothing answers a deliberate constant and stays legal, and
 * nested captures keep their own reads. The shapes the rule cannot see —
 * a comparison of the bare argument, a boolean a pen helper consumes, a
 * boolean nested in a returned object or array — are pinned to what they
 * capture, so the passages that describe them (QUERY-PEN §3 and §14.10)
 * cannot drift.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, LinqBuildError } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import * as f from '@jarenjs/linq/forms';
import * as m from '@jarenjs/linq/model';
import { on } from '@jarenjs/linq/flow';
import { action, sub, when, transition, replace } from '@jarenjs/linq/app';
import { body } from '@jarenjs/linq/jslt';
import { query } from '@jarenjs/linq/jtlt';
import { defineMigration } from '@jarenjs/linq/migration';

const rows = [{ a: null, k: 1 }, { a: 1, k: 2 }];

/**
 * The refusal: `JL0109`, naming the boolean the callback answered, the
 * spellings that work and the deliberate constant.
 * @param {boolean} value
 */
const refused = (value) => (/** @type {any} */ e) => e instanceof LinqBuildError
  && e.code === 'JL0109' && e.message.includes(`answered the JavaScript boolean ${value} —`)
  && /\.eq\(null\)/.test(e.message) && /\.not\(\)/.test(e.message) && /\(\) => true/.test(e.message);

/**
 * Each spelling, the thunk that captures it, and the boolean it answers.
 * @param {[string, () => unknown, boolean][]} cases
 */
function assertRefused(cases) {
  for (const [label, build, value] of cases) assert.throws(build, refused(value), label);
}

describe('JL0109 — a callback that read its argument and answered a JavaScript boolean', () => {
  it('the chain refuses every spelling that tests the proxy, naming the constant it answered', () => {
    assertRefused([
      ['x.a === null', () => from(rows).where((/** @type {any} */ x) => x.a === null).toDocument(), false],
      ['x.a !== 1', () => from(rows).where((/** @type {any} */ x) => x.a !== 1).toDocument(), true],
      ['x.a == null', () => from(rows).where((/** @type {any} */ x) => x.a == null).toDocument(), false],
      ['!x.a', () => from(rows).where((/** @type {any} */ x) => !x.a).toDocument(), false],
      ['typeof x.a', () => from(rows).where((/** @type {any} */ x) => typeof x.a === 'object').toDocument(), true],
      ['a declared parameter', () => from(rows).params({ k: 1 })
        .where((/** @type {any} */ x, /** @type {any} */ p) => p.k === 1).toDocument(), false],
      ['an orderBy key', () => from(rows).orderBy((/** @type {any} */ x) => x.a === null).toDocument(), false],
      ['?: answering literals', () => from(rows)
        .where((/** @type {any} */ x) => (x.a.eq(1) ? true : false)).toDocument(), true],
      ['Boolean()', () => from(rows).where((/** @type {any} */ x) => Boolean(x.a)).toDocument(), true],
      ['the asynchronous surface', () => fromAsync(rows).where((/** @type {any} */ x) => x.a === null).toDocument(), false],
      ['a nested capture', () => from(rows).select((/** @type {any} */ u) => ({
        n: from(rows).where((/** @type {any} */ v) => v.k === 1).count(), id: u.k })).toDocument(), false],
    ]);
  });

  it('every pen refuses it: an external, a forms context, a guard, an action, a body, a default, an index, an assertion', () => {
    const model = m.defineModel({ entities: { User: m.object({ id: m.string().key().uuid(), handle: m.string().optional() }) } });
    assertRefused([
      ['schema check() over an external', () => s.string().check((_v, /** @type {any} */ e) => e.root === null).schema, false],
      ['schema check() over the value', () => s.string().check((/** @type {any} */ v) => v.length === 0).schema, false],
      ['forms rule over the context root', () => f.string().form({ visible: (/** @type {any} */ c) => c.root === null }).schema, false],
      ['forms rule over an external', () => f.string().form({ assert: (/** @type {any} */ c) => c.value !== '' }).schema, true],
      ['flow guard', () => on('a', 'go').when((/** @type {any} */ st) => st.payload.n === 3).to('a'), false],
      ['app action', () => action((/** @type {any} */ st) => st.count === 0), false],
      ['app subscription', () => sub('room', { when: (/** @type {any} */ st) => st.online === true }), false],
      ['JSLT body', () => body((/** @type {any} */ v) => v.a === null), false],
      ['JSLT body over an external', () => body((_v, /** @type {any} */ x) => x.path === ''), false],
      ['JTLT query', () => query((/** @type {any} */ v) => v.get('n') === 1), false],
      ['model compute()', () => m.string().compute((/** @type {any} */ d) => d.first === null), false],
      ['model index where', () => m.index((/** @type {any} */ d) => d.get('at'),
        { where: (/** @type {any} */ d) => d.get('at') === 'x' }), false],
      ['migration assertion', () => defineMigration({ id: 'm', from: model, to: model })
        .assert('User', (/** @type {any} */ u) => u.handle === null), false],
    ]);
  });

  it('a callback that read nothing answers a deliberate constant, and the spellings that work are unchanged', () => {
    assert.strictEqual(from(rows).where(() => true).toDocument().$where, true);
    assert.strictEqual(from(rows).where((/** @type {any} */ _x) => true).toDocument().$where, true);
    assert.strictEqual(s.string().check(() => true).schema.$query, true);
    // a Symbol-keyed read is the machinery's, never the callback's
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => {
      void x[Symbol.iterator];
      return true;
    }).toDocument().$where, true);
    assert.deepStrictEqual(from(rows).where((/** @type {any} */ x) => x.a.eq(null)).toDocument().$where,
      { $eq: ['$it.a', null] });
    assert.deepStrictEqual(from(rows).where((/** @type {any} */ x) => x.a.eq(null)).toArray(), [{ a: null, k: 1 }]);
  });

  it('nested captures keep their own reads', () => {
    // the inner capture read its argument; the outer read nothing and answers a constant
    assert.strictEqual(from(rows).where(() => from(rows).where((/** @type {any} */ v) => v.k.eq(1)).count() > 0)
      .toDocument().$where, true);
    // the outer read its argument; the inner answers a deliberate constant
    assert.deepStrictEqual(from(rows).select((/** @type {any} */ u) => ({ id: u.k, n: from(rows).where(() => true).count() }))
      .toArray(), [{ id: 1, n: 2 }, { id: 2, n: 2 }]);
    assert.deepStrictEqual(from(rows).select((/** @type {any} */ _u) => ({
      n: from(rows).where((/** @type {any} */ v) => v.k.eq(1)).count() })).toDocument().$return, { $const: { n: 1 } });
  });

  it('the shapes it cannot see capture what they always captured', () => {
    // a comparison of the BARE argument reads nothing: indistinguishable from () => true
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x != null).toDocument().$where, true);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x === undefined).toDocument().$where, false);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => !x).toDocument().$where, false);
    assert.strictEqual(s.string().check((/** @type {any} */ x) => x != null).schema.$query, true);
    // && answers a proxy, not a boolean
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x.a && x.b).toDocument().$where, '$it.b');
    // a boolean a pen helper consumes is an operand, not the callback's answer
    assert.deepStrictEqual(from(rows).where((/** @type {any} */ x) => x.a.eq(1).and(x.b === null)).toDocument().$where,
      { $and: [{ $eq: ['$it.a', 1] }, false] });
    assert.deepStrictEqual(action((_st, /** @type {any} */ x) => when(x.payload === null,
      transition({ patch: [replace((/** @type {any} */ c) => c.n, 1)] }))).document,
    { $if: [false, { patch: [{ op: 'replace', path: '/n', value: 1 }] }] });
    // a boolean nested in a returned object or array is a literal member
    assert.deepStrictEqual(from(rows).select((/** @type {any} */ x) => ({ f: x.a === null })).toDocument().$return,
      { $const: { f: false } });
    assert.deepStrictEqual(from(rows).select((/** @type {any} */ x) => [x.a === null]).toArray(), [[false], [false]]);
  });
});
