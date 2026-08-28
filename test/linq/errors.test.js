//@ts-check
/**
 * @file Every documented JL code is raised by at least one test
 * (QUERY-PEN.md §9), on the suite's coded contract.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromDocument, createPushQueue, LinqBuildError, LinqRuntimeError, LINQ_CODES } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fixtureModel } from './model-corpus.js';
import { JsonQueryCompileError } from '@jarenjs/json/query';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { JarenValidator } from '@jarenjs/validate';

describe('every JL code fires', () => {
  it('JL0001 — a useless source, at from() time', () => {
    assert.throws(() => from(42), (e) => e instanceof LinqBuildError && e.code === 'JL0001');
    assert.throws(() => from(null), (e) => e.code === 'JL0001');
  });

  it('JL0002 — an escaped proxy', () => {
    let stolen;
    from([]).where((u) => { stolen = u; return u.n.gt(0); });
    assert.throws(() => from([]).where(() => stolen.gt(1)), (e) => e.code === 'JL0002');
  });

  it('JL0003 — ofType/cast without compileTypeTest, fix named in the message', () => {
    assert.throws(() => from([1, 'a']).ofType({ type: 'number' }).toArray(),
      (e) => e instanceof LinqBuildError && e.code === 'JL0003'
        && /compileTypeTest/.test(e.message)
        && /createTypeTestCompiler/.test(e.message));
  });

  it('…and ofType/cast WORK with the hook injected', () => {
    const compileTypeTest = createTypeTestCompiler(new JarenValidator());
    const mixed = [1, 'a', 2, null];
    assert.deepStrictEqual(
      from(mixed, { compileTypeTest }).ofType({ type: 'number' }).toArray(),
      [1, 2]);
    assert.throws(
      () => from(mixed, { compileTypeTest }).cast({ type: 'number' }).toArray(),
      (e) => e.code === 'JQ2008', 'cast asserts per item with the engine code');
  });

  it('JL0004 — undeclared and reserved parameters', () => {
    assert.throws(() => from([]).where((u, p) => u.n.eq(p.limit)),
      (e) => e.code === 'JL0004' && /\.params\(/.test(e.message));
    assert.throws(() => from([]).params({ it: 1 }),
      (e) => e.code === 'JL0004' && /reserved/.test(e.message));
    assert.throws(() => from([]).params({ 'bad name': 1 }), (e) => e.code === 'JL0004');
    // a binding that is not query data would compare against nothing
    assert.throws(() => from([]).params({ d: new Date(0) }),
      (e) => e.code === 'JL0004' && /Date instance/.test(e.message) && /ISO string/.test(e.message));
    assert.throws(() => from([]).params({ n: NaN }), (e) => e.code === 'JL0004');
    // one name, two values, one document
    const rows = from([{ k: 1 }]);
    assert.throws(() => rows.params({ k: 1 }).concat(rows.params({ k: 2 })),
      (e) => e.code === 'JL0004' && /different values/.test(e.message));
  });

  it('JL0005 — invalid build-time uses', () => {
    assert.throws(() => from([]).thenBy((u) => u.n).toDocument(), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).skip(-1), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).take(1.5), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).where('not a function'), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).concat('nope'), (e) => e.code === 'JL0005');
    // a constant array crosses the same JSON boundary a captured constant does
    assert.throws(() => from([1]).concat([new Date(0)]),
      (e) => e.code === 'JL0005' && /Date instance/.test(e.message));
    assert.throws(() => from([1]).concat([NaN]), (e) => e.code === 'JL0005');
  });

  it('JL0107 — the client names a member of the wrong relation kind, the fix named', async () => {
    const client = await open(fixtureModel, { driver: nodeDriver() });
    assert.throws(() => client.entities.User.include((u) => u.email),
      (e) => e instanceof LinqBuildError && e.code === 'JL0107' && /'posts', 'labels'/.test(e.message));
    assert.throws(() => client.entities.User.link('u1', 'posts', 1),
      (e) => e.code === 'JL0107' && /oneToMany/.test(e.message) && /foreign key/.test(e.message));
    assert.throws(() => client.entities.Post.unlink(1, 'author', 'u1'),
      (e) => e.code === 'JL0107' && /oneToOne/.test(e.message));
    await client.close();
  });

  it('JL0006 — the recorded unsupported operator', () => {
    assert.throws(() => from([]).zip(), (e) => e.code === 'JL0006' && /zip/.test(e.message));
  });

  it('JL0101 — a pen received a value it cannot spell', () => {
    // not JSON: the constant rule of QUERY-PEN §5, applied to defaults and literals
    assert.throws(() => s.literal(new Date(0)), (e) => e instanceof LinqBuildError && e.code === 'JL0101' && /Date instance/.test(e.message));
    assert.throws(() => s.string().default(() => 'x'), (e) => e.code === 'JL0101' && /function/.test(e.message));
    assert.throws(() => s.enumOf([1, NaN]), (e) => e.code === 'JL0101');
    assert.throws(() => s.number().default(-0), (e) => e.code === 'JL0101');
    assert.throws(() => s.string().example(Symbol('s')), (e) => e.code === 'JL0101');
    assert.throws(() => s.string().meta({ 'x-big': 1n }), (e) => e.code === 'JL0101');
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => s.from(cycle), (e) => e.code === 'JL0101');
    // not what the keyword takes
    assert.throws(() => s.string().min('x'), (e) => e.code === 'JL0101' && /non-negative integer/.test(e.message));
    assert.throws(() => s.number().multipleOf(0), (e) => e.code === 'JL0101');
    assert.throws(() => s.object({ a: 'string' }), (e) => e.code === 'JL0101' && /from\(\)/.test(e.message));
    assert.throws(() => s.named('bad name', s.string()), (e) => e.code === 'JL0101');
    assert.throws(() => s.lazy('nope'), (e) => e.code === 'JL0101');
    assert.throws(() => s.enumOf([]), (e) => e.code === 'JL0101');
  });

  it('JL0102 — a construct the format cannot carry, with the fix in the message', () => {
    // a coercion the normalizer would never run
    assert.throws(() => s.string().coerce().nullable(), (e) => e.code === 'JL0102' && /nullable/.test(e.message));
    assert.throws(() => s.string().nullable().coerce(), (e) => e.code === 'JL0102');
    assert.throws(() => s.object({}).coerce(), (e) => e.code === 'JL0102' && /scalar/.test(e.message));
    assert.throws(() => s.number().trim(), (e) => e.code === 'JL0102' && /string/.test(e.message));
    // a default in a branch the normalizer never descends
    assert.throws(() => s.union([s.string().default('x'), s.number()]).schema,
      (e) => e.code === 'JL0102' && /never runs/.test(e.message) && e.docPath === '/anyOf/0');
    assert.throws(() => s.array(s.string()).contains(s.string().trim()).schema, (e) => e.code === 'JL0102');
    assert.throws(() => s.when(s.string()).then(s.string().coerce()).schema, (e) => e.code === 'JL0102');
    // closed objects under allOf accept neither's members
    assert.throws(() => s.intersection([s.object({ a: s.string() }), s.object({ b: s.string() })]).schema,
      (e) => e.code === 'JL0102' && /extend\(\)/.test(e.message));
    // false carries nothing
    assert.throws(() => s.never().describe('x'), (e) => e.code === 'JL0102');
    assert.throws(() => s.never().check(() => true), (e) => e.code === 'JL0102');
    // a draft the pen does not write; a discriminated union without its tag
    assert.throws(() => s.document(s.string(), { draft: 'draft-07' }), (e) => e.code === 'JL0102');
    assert.throws(() => s.discriminated('k', [s.string()]), (e) => e.code === 'JL0102');
  });

  it('JL0103 — definitions: a collision, a dangling ref, an unnamed recursion', () => {
    const A = s.named('T', s.string());
    const B = s.named('T', s.number());
    assert.throws(() => s.object({ a: A, b: B }).schema, (e) => e.code === 'JL0103' && /'T'/.test(e.message));
    assert.throws(() => s.object({ a: s.ref('Missing') }).schema, (e) => e.code === 'JL0103' && /Missing/.test(e.message));
    assert.throws(() => s.array(s.lazy(() => s.string())).schema, (e) => e.code === 'JL0103' && /NAMED/.test(e.message));
    assert.throws(() => s.array(s.lazy(() => 42)).schema, (e) => e.code === 'JL0103');
    // the same builder under one name, reached twice, is one definition
    assert.deepStrictEqual(Object.keys(s.object({ a: A, b: A }).schema.$defs), ['T']);
  });

  it('JL0104 — a pen-owned keyword through meta(), or a check() external that is not root/path', () => {
    assert.throws(() => s.object({}).meta({ type: 'x' }), (e) => e.code === 'JL0104' && /'type'/.test(e.message));
    assert.throws(() => s.string().meta({ $ref: '#' }), (e) => e.code === 'JL0104');
    assert.throws(() => s.string().meta({ 'x-coerce': true }), (e) => e.code === 'JL0104');
    assert.throws(() => s.object({}).check((o, x) => x.foo.eq(1)), (e) => e.code === 'JL0104' && /'foo'/.test(e.message));
    // an annotation the pen does not own passes through
    assert.deepStrictEqual(s.string().meta({ deprecated: true, $comment: 'c' }).schema,
      { type: 'string', deprecated: true, $comment: 'c' });
  });

  it('JL0105 — a relation hop that cannot lower: the many-to-many member, at build time', () => {
    const users = {
      root: '$.User[*]',
      relations: { labels: { to: 'Label', kind: 'manyToMany', joinTable: 'Label_User', targetKey: 'name' } },
      execute: () => [],
    };
    assert.throws(() => from(users).where((u) => u.labels.all().exists()),
      (e) => e instanceof LinqBuildError && e.code === 'JL0105'
        && /Label_User/.test(e.message) && /load\(\{ include/.test(e.message));
  });

  it('JL2001/JL2002/JL2003 — the terminal codes by name', () => {
    assert.throws(() => from([]).first(), (e) => e instanceof LinqRuntimeError && e.code === 'JL2001');
    assert.throws(() => from([1, 2]).single(), (e) => e.code === 'JL2002');
    assert.throws(() => from([1]).elementAt(5), (e) => e.code === 'JL2003');
    // an asynchronous provider cannot back a synchronous terminal: the
    // promise used to be returned under the value's type, so `count()`
    // handed back a Promise typed `number` and `first()` read undefined
    assert.throws(() => from({ execute: async () => [[1]] }).toArray(),
      (e) => e instanceof LinqRuntimeError && e.code === 'JL2004');
  });

  it('JL2005 — a push queue fed after it ended (a runtime condition, not a build one)', () => {
    const queue = createPushQueue();
    queue.end();
    assert.throws(() => queue.feed(1),
      (e) => e instanceof LinqRuntimeError && e.code === 'JL2005' && /closed/.test(e.message));
  });

  it('LINQ_CODES is frozen and covers exactly the raised codes', () => {
    assert.strictEqual(Object.isFrozen(LINQ_CODES), true);
    assert.deepStrictEqual(Object.keys(LINQ_CODES).sort(), [
      'JL0001', 'JL0002', 'JL0003', 'JL0004', 'JL0005', 'JL0006', 'JL0007',
      'JL0101', 'JL0102', 'JL0103', 'JL0104', 'JL0105', 'JL0106', 'JL0107',
      'JL2001', 'JL2002', 'JL2003', 'JL2004', 'JL2005', 'JL2006',
    ]);
  });

  it('engine errors from a hand-written document pass through unwrapped', () => {
    const q = fromDocument([], { $frobnicate: 1 });
    assert.throws(() => q.toArray(),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0002',
      'the engine already carries its own code and docPath');
  });
});
