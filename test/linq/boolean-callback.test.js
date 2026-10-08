//@ts-check
/**
 * @file A captured callback that read its argument and answered a plain
 * JavaScript boolean is refused with `JL0109`, in every pen: `===`,
 * `!==`, `!`, `typeof` and `== null` test the capture proxy, never the
 * value, so the document would otherwise hold that constant. A callback
 * that read nothing answers a deliberate constant and stays legal, and
 * nested captures keep their own reads. Destructuring a parameter is a
 * read, so the optional-filter idiom is refused and its way out — the
 * callback chosen outside the callback, or a read only inside the branch
 * that uses it — is pinned in every pen. The shapes the rule cannot see —
 * a test of the bare argument, a boolean a pen helper consumes, a boolean
 * nested in a returned object or array — are pinned to what they
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
import { json, query } from '@jarenjs/linq/jtlt';
import { defineMigration } from '@jarenjs/linq/migration';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fixtureModel } from './model-corpus.js';

const rows = [{ a: null, k: 1, name: 'x' }, { a: 1, k: 2, name: 'y' }];

/** The flow pen's transition record, keyed off the builder. */
const TRANSITION = Symbol.for('@jarenjs/linq/flow-transition');

/**
 * The refusal: `JL0109`, naming the boolean the callback answered, the
 * spellings that work, and that destructuring a parameter is a read with
 * the two ways out of the optional-filter idiom.
 * @param {boolean} value
 */
const refused = (value) => (/** @type {any} */ e) => e instanceof LinqBuildError
  && e.code === 'JL0109' && e.message.includes(`answered the JavaScript boolean ${value} —`)
  && /\.eq\(null\)/.test(e.message) && /\.not\(\)/.test(e.message)
  && /destructuring a parameter or reading a member before choosing the answer is a read/.test(e.message)
  && e.message.includes('q.name ? ({ name }) => name.eq(q.name) : () => true')
  && /read only inside the branch that uses the value/.test(e.message);

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

  it('every other capture site refuses it, where it wrote a constant or raised the pen\'s own code', async () => {
    assertRefused([
      ['app patch path', () => action(() => transition({ patch: [replace((/** @type {any} */ c) => c.n === null, 1)] })), false],
      ['model index key path', () => m.index((/** @type {any} */ d) => d.at === undefined), false],
      ['model collection key', () => m.collection(m.object({ id: m.string() }),
        { key: (/** @type {any} */ d) => d.id === null }), false],
      ['model expressionIndex argument', () => m.expressionIndex({ call: 'lower',
        args: [(/** @type {any} */ d) => d.name === null] }), false],
      ['model composite index part', () => m.index([(/** @type {any} */ d) => d.a, (/** @type {any} */ d) => d.b === null]), false],
      ['app subscription key', () => sub('room', { for: (/** @type {any} */ st) => st.rooms,
        key: (_st, /** @type {any} */ x) => x.item === null }), false],
      ['JTLT json()', () => json((/** @type {any} */ v) => v.items === null), false],
    ]);
    const client = await open(fixtureModel, { driver: nodeDriver() });
    try {
      assertRefused([
        ['client include() pick', () => client.entities.User.include((/** @type {any} */ u) => u.posts === null), false],
        ['client Graph.where()', () => client.entities.User.include((/** @type {any} */ u) => u.posts)
          .where((/** @type {any} */ u) => u.email === null), false],
      ]);
    }
    finally {
      await client.close();
    }
  });

  it('destructuring a parameter is a read: the optional-filter idiom is refused, naming its way out', () => {
    const q = /** @type {{ name?: string, on?: boolean }} */ ({});
    assertRefused([
      ['a destructured item', () => from(rows)
        .where((/** @type {any} */ { name }) => (q.name ? name.eq(q.name) : true)).toDocument(), true],
      ['a member hoisted into a local', () => from(rows).where((/** @type {any} */ x) => {
        const n = x.name;
        return q.name ? n.eq(q.name) : true;
      }).toDocument(), true],
      ['destructured parameters', () => from(rows).params({ k: 1 })
        .where((/** @type {any} */ x, /** @type {any} */ { k }) => (q.on ? x.k.eq(k) : true)).toDocument(), true],
      ['schema check() destructuring its externals', () => s.number()
        .check((/** @type {any} */ v, /** @type {any} */ { root }) => (q.on ? v.lt(root.limit) : true)).schema, true],
      ['flow guard destructuring its scope', () => on('a', 'go')
        .when((/** @type {any} */ { payload }) => (q.on ? payload.n.eq(3) : true)).to('a'), true],
      ['app subscription destructuring its state', () => sub('room',
        { when: (/** @type {any} */ { online }) => (q.on ? online.eq(true) : true) }), true],
    ]);
  });

  it('its way out writes the filter or the constant in every pen: the callback chosen outside, or a read only in the branch', () => {
    for (const [q, where, check, guard, room] of /** @type {[any, any, any, any, any][]} */ ([
      [{}, true, true, true, true],
      [{ name: 'x', on: true }, { $eq: ['$it.name', 'x'] }, { $lt: ['$', '$root.limit'] },
        { $eq: ['$.payload.n', 3] }, { $eq: ['$.online', true] }],
    ])) {
      const label = q.on ? 'on' : 'off';
      // the callback chosen outside the callback
      assert.deepStrictEqual(from(rows).where(q.name ? (/** @type {any} */ { name }) => name.eq(q.name) : () => true)
        .toDocument().$where, where, `where ${label}`);
      assert.deepStrictEqual(s.number()
        .check(q.on ? (/** @type {any} */ v, /** @type {any} */ { root }) => v.lt(root.limit) : () => true)
        .schema.$query, check, `check() ${label}`);
      assert.deepStrictEqual(on('a', 'go').when(q.on ? (/** @type {any} */ { payload }) => payload.n.eq(3) : () => true)
        .to('a')[TRANSITION].guard, guard, `guard ${label}`);
      assert.deepStrictEqual(sub('room', { when: q.on ? (/** @type {any} */ { online }) => online.eq(true) : () => true }),
        { run: 'room', when: room }, `subscription ${label}`);
      // a read only inside the branch that uses the value
      assert.deepStrictEqual(from(rows).where((/** @type {any} */ x) => (q.name ? x.name.eq(q.name) : true))
        .toDocument().$where, where, `where ${label}, read in the branch`);
      assert.deepStrictEqual(s.number()
        .check((/** @type {any} */ v, /** @type {any} */ e) => (q.on ? v.lt(e.root.limit) : true))
        .schema.$query, check, `check() ${label}, read in the branch`);
      assert.deepStrictEqual(on('a', 'go').when((/** @type {any} */ st) => (q.on ? st.payload.n.eq(3) : true))
        .to('a')[TRANSITION].guard, guard, `guard ${label}, read in the branch`);
      assert.deepStrictEqual(sub('room', { when: (/** @type {any} */ st) => (q.on ? st.online.eq(true) : true) }),
        { run: 'room', when: room }, `subscription ${label}, read in the branch`);
    }
  });

  it('a refusal leaves the capture stack clean, and a read lands in the capture that owns the proxy', () => {
    // a refused capture, then a deliberate constant
    assert.throws(() => from(rows).where((/** @type {any} */ x) => x.a === null).toDocument(), refused(false));
    assert.strictEqual(from(rows).where(() => true).toDocument().$where, true);
    // an inner refusal, caught inside an outer capture that read nothing
    assert.strictEqual(from(rows).where(() => {
      assert.throws(() => from(rows).where((/** @type {any} */ v) => v.k === 1).toDocument(), refused(false));
      return true;
    }).toDocument().$where, true);
    // a pen's externals and a form rule's context kept past their capture read into no later one
    /** @type {any} */
    let externals;
    s.number().check((/** @type {any} */ v, /** @type {any} */ e) => {
      externals = e;
      return v.gt(0);
    });
    assert.strictEqual(from(rows).where(() => {
      void externals.root;
      return true;
    }).toDocument().$where, true);
    /** @type {any} */
    let context;
    f.string().form({ visible: (/** @type {any} */ c) => {
      context = c;
      return c.root.a.eq(1);
    } });
    assert.strictEqual(from(rows).where(() => {
      void context.root;
      return true;
    }).toDocument().$where, true);
    // an enclosing proxy's member, refused inside a nested capture, is no read of the enclosing one
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => {
      assert.throws(() => from(rows).where((/** @type {any} */ v) => v.k.eq(x.k)).toDocument(),
        (/** @type {any} */ e) => e.code === 'JL0002');
      return true;
    }).toDocument().$where, true);
  });

  it('comparing members is a read; only an identity test of the bare argument reads nothing', () => {
    assert.throws(() => from(rows).where((/** @type {any} */ u) => u.a === u.b).toDocument(), refused(false));
    assert.strictEqual(from(rows).where((/** @type {any} */ u) => u === rows[0]).toDocument().$where, false);
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
    assert.deepStrictEqual(from(rows).where((/** @type {any} */ x) => x.a.eq(null)).toArray(), [{ a: null, k: 1, name: 'x' }]);
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
    // a test of the BARE argument reads no member: it answers what it answers for any object,
    // indistinguishable from () => true or () => false
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x != null).toDocument().$where, true);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x == null).toDocument().$where, false);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x === undefined).toDocument().$where, false);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => !x).toDocument().$where, false);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => 'a' in x).toDocument().$where, false);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => typeof x === 'object').toDocument().$where, true);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => x instanceof Object).toDocument().$where, true);
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => Array.isArray(x)).toDocument().$where, false);
    // Object.keys lists the capture's own untrapped record, which no read reports
    assert.strictEqual(from(rows).where((/** @type {any} */ x) => Object.keys(x).length > 0).toDocument().$where, true);
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
