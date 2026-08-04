//@ts-check
/**
 * @file Every documented JL code is raised by at least one test
 * (LINQ-FORMAT.md §9), on the suite's coded contract.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromDocument, LinqBuildError, LinqRuntimeError, LINQ_CODES } from '@jarenjs/linq';
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
  });

  it('JL0005 — invalid build-time uses', () => {
    assert.throws(() => from([]).thenBy((u) => u.n).toDocument(), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).skip(-1), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).take(1.5), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).where('not a function'), (e) => e.code === 'JL0005');
    assert.throws(() => from([]).concat('nope'), (e) => e.code === 'JL0005');
  });

  it('JL0006 — the recorded unsupported operator', () => {
    assert.throws(() => from([]).zip(), (e) => e.code === 'JL0006' && /zip/.test(e.message));
  });

  it('JL2001/JL2002/JL2003 — the terminal codes by name', () => {
    assert.throws(() => from([]).first(), (e) => e instanceof LinqRuntimeError && e.code === 'JL2001');
    assert.throws(() => from([1, 2]).single(), (e) => e.code === 'JL2002');
    assert.throws(() => from([1]).elementAt(5), (e) => e.code === 'JL2003');
  });

  it('LINQ_CODES is frozen and covers exactly the raised codes', () => {
    assert.strictEqual(Object.isFrozen(LINQ_CODES), true);
    assert.deepStrictEqual(Object.keys(LINQ_CODES).sort(), [
      'JL0001', 'JL0002', 'JL0003', 'JL0004', 'JL0005', 'JL0006',
      'JL2001', 'JL2002', 'JL2003',
    ]);
  });

  it('engine errors from a hand-written document pass through unwrapped', () => {
    const q = fromDocument([], { $frobnicate: 1 });
    assert.throws(() => q.toArray(),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0002',
      'the engine already carries its own code and docPath');
  });
});
