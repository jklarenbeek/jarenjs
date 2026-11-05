//@ts-check
/**
 * @file A member named like a method of the capture (`day`, `at`, `count`,
 * `eq`) is the METHOD on the proxy, and `get(name)` reads the member
 * (QUERY-PEN.md §3). Reading a member off such a method read, without its
 * call — `r.day.eq(p.day)` over rows whose model declares `day` — is
 * `JL0108` at the read, naming the call and `get('day')`; it was a plain
 * `TypeError: r.day.eq is not a function`, in memory and over a store
 * entity alike. Embedding the method read as a value stays `JL0005` and
 * converting it to a primitive `JL0108`. The method called, `get()`, the
 * function's own members (`call`, `apply`, `bind`), a member named like an
 * array method and every other member answer as they did.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { from, fromAsync, LinqBuildError } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const ROWS = [
  { day: '2026-10-30', at: '2026-10-30T10:00:00Z', n: 5, keys: ['a'] },
  { day: '2026-10-31', at: '2026-10-31T12:30:00Z', n: 7, keys: [] },
];

/** The refusal of a member read off a method read. @param {string} name @param {string} step */
const offMethod = (name, step) => `JL0108: .${name} is a method of a captured expression, read here without its call, `
  + `so ${step} is read off the function and not off a value — call it as .${name}(…), or read a document `
  + `member of that name with get('${name}')`;

/** @param {string} code @param {string} message */
const refusal = (code, message) => (/** @type {any} */ e) => e instanceof LinqBuildError
  && e.code === code && e.message === message;

/** The common column names a method of the capture takes. */
const SHADOWED = ['day', 'month', 'year', 'hours', 'minutes', 'seconds', 'week', 'quarter', 'weekday', 'offset',
  'epoch', 'datetime', 'count', 'sum', 'min', 'max', 'avg', 'length', 'at', 'in', 'concat', 'replace', 'upper',
  'lower', 'distance', 'within', 'matches', 'contains', 'exists', 'similarity'];

describe('a member read off a method read is a coded refusal naming get()', () => {
  it('r.day.eq(p.day) in memory is JL0108 at the read, and get(\'day\') answers the row', () => {
    const chain = from(ROWS).params({ day: '2026-10-30' });
    assert.throws(() => chain.where((/** @type {any} */ r, /** @type {any} */ p) => r.day.eq(p.day)),
      refusal('JL0108', offMethod('day', '.eq')));
    assert.deepStrictEqual(chain.where((/** @type {any} */ r, /** @type {any} */ p) => r.get('day').eq(p.day))
      .select((/** @type {any} */ r) => r.n).toArray(), [5]);
  });

  it('every common column name a method takes is refused by name, its step spelled as written', () => {
    for (const name of SHADOWED) {
      assert.throws(() => from(ROWS).where((/** @type {any} */ r) => r[name].eq(1)),
        refusal('JL0108', offMethod(name, '.eq')), name);
    }
    assert.throws(() => from(ROWS).select((/** @type {any} */ r) => r.at.day()),
      refusal('JL0108', offMethod('at', '.day')));
    assert.throws(() => from(ROWS).select((/** @type {any} */ r) => r.count['odd key']),
      refusal('JL0108', offMethod('count', '["odd key"]')));
    assert.throws(() => from(ROWS).select((/** @type {any} */ r) => r.n.add.foo),
      refusal('JL0108', offMethod('add', '.foo')));
  });

  it('over a store entity whose model declares day, from the entity set and from the client handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-shadowed-'));
    const path = join(dir, 'a.sqlite');
    const seed = await nodeDriver().open(path);
    seed.exec("CREATE TABLE usage_days(day TEXT PRIMARY KEY, tokens INTEGER NOT NULL); INSERT INTO usage_days VALUES ('2026-10-30', 5), ('2026-10-31', 7)");
    seed.close();
    const model = { $model: '0.1', entities: { usage_days: {
      schema: { type: 'object', properties: { day: { type: 'string', 'x-entity': { key: true } }, tokens: { type: 'integer' } } },
      physical: { table: 'usage_days', columns: { day: { name: 'day', codec: 'text', null: 'reject' },
        tokens: { name: 'tokens', codec: 'integer', null: 'reject' } } } } } };
    const store = await openStore(model, { driver: nodeDriver(), path, adopt: true });
    try {
      const set = store.entity('usage_days');
      assert.throws(() => fromAsync(set).params({ day: '2026-10-30' })
        .where((/** @type {any} */ r, /** @type {any} */ p) => r.day.eq(p.day)), refusal('JL0108', offMethod('day', '.eq')));
      assert.deepStrictEqual(await fromAsync(set).params({ day: '2026-10-30' })
        .where((/** @type {any} */ r, /** @type {any} */ p) => r.get('day').eq(p.day)).toArray(), [{ day: '2026-10-30', tokens: 5 }]);
    }
    finally { await store.close(); }
    const client = await open(model, { driver: nodeDriver(), path, adopt: true, validator: null });
    try {
      const days = /** @type {any} */ (client.entities).usage_days;
      assert.throws(() => days.where((/** @type {any} */ r) => r.day.eq('2026-10-31')), refusal('JL0108', offMethod('day', '.eq')));
      assert.deepStrictEqual(await days.where((/** @type {any} */ r) => r.get('day').eq('2026-10-31')).toArray(),
        [{ day: '2026-10-31', tokens: 7 }]);
    }
    finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the shapes that answered keep their answers', () => {
  it('the method called, on the row and on a member, and get() before a method', () => {
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.day()).toDocument(),
      { $for: { it: ['$[*]'] }, $return: { $day: '$it' } });
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.get('at').day()).toArray(), [30, 31]);
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.get('day').upper().length()).toArray(), [10, 10]);
    assert.deepStrictEqual(from(ROWS).where((/** @type {any} */ r) => r.n.add(1).gt(6)).select((/** @type {any} */ r) => r.n).toArray(), [7]);
  });

  it('call, apply and bind still call a method read', () => {
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.n.add.call(null, 1)).toArray(), [6, 8]);
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.n.add.apply(null, [2])).toArray(), [7, 9]);
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.n.add.bind(null, 3)()).toArray(), [8, 10]);
    from(ROWS).select((/** @type {any} */ r) => {
      assert.strictEqual(typeof r.day, 'function');
      return r.n;
    }).toDocument();
  });

  it("a method read's other own members are refused, not embedded as the function's", () => {
    for (const [key, read] of /** @type {[string, (r: any) => any][]} */ ([
      ['length', (r) => ({ len: r.day.length })],
      ['name', (r) => ({ named: r.day.name })],
      ['toString', (r) => ({ text: r.day.toString() })],
      ['constructor', (r) => r.count.constructor],
    ])) {
      assert.throws(() => from(ROWS).select(read).toDocument(), (error) => error.code === 'JL0108'
        && error.message.includes(`so .${key} is read off the function and not off a value`), key);
    }
    // the member that was meant is get()'s to read
    assert.deepStrictEqual(from(ROWS).select((/** @type {any} */ r) => r.get('day').length()).toArray(), [10, 10]);
  });

  it('embedding a method read is JL0005 and converting it JL0108, as before', () => {
    assert.throws(() => from(ROWS).select((/** @type {any} */ r) => ({ d: r.day })),
      refusal('JL0005', 'JL0005: a captured expression cannot embed a function value'));
    assert.throws(() => from(ROWS).where((/** @type {any} */ r) => r.n.eq(r.count)),
      refusal('JL0005', 'JL0005: a captured expression cannot embed a function value'));
    assert.throws(() => from(ROWS).where((/** @type {any} */ r) => r.day > 1),
      refusal('JL0108', 'JL0108: .day is a method of a captured expression, read here without its call, so it is a '
        + 'function and not the value — ==, +, a template literal, String() and < would act on the function itself; '
        + "call it as .day(…), or read a document member of that name with get('day')"));
  });

  it('a member named like an array method is still that member', () => {
    assert.deepStrictEqual(from(ROWS).where((/** @type {any} */ r) => r.keys.all().eq('a')).select((/** @type {any} */ r) => r.n).toArray(), [5]);
  });
});
