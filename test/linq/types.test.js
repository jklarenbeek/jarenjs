//@ts-check
/**
 * @file The RUNTIME TWINS of the typed surface's claims (the anti-drift
 * rule of the typed-surface order): every type-level statement in
 * `packages/linq/types/index.d.ts` — and its compile-level pins in
 * `test/consumer/types.ts` — has the same behaviour asserted here at
 * runtime, so the declarations and the implementation are proven by
 * the same fixtures and cannot drift apart silently.
 *
 * The five captured compiler messages for the common mistakes
 * (verbatim `tsc` output against the shipped declarations, strict,
 * skipLibCheck false — each is one readable line, no simplification
 * was needed):
 *
 *   u.age.gt('x')
 *     → error TS2345: Argument of type 'string' is not assignable to
 *       parameter of type 'number | NumberExpr'.
 *   u.emial
 *     → error TS2339: Property 'emial' does not exist on type
 *       'ObjectExpr<U>'.
 *   u.age.upper()
 *     → error TS2339: Property 'upper' does not exist on type
 *       'NumberExpr'.
 *   u.name.year()   (a plain, unbranded string)
 *     → error TS2339: Property 'year' does not exist on type
 *       'StringExpr'.
 *   p.b   (undeclared parameter)
 *     → error TS2339: Property 'b' does not exist on type
 *       'ParamsExpr<{ a: number; }>'.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';

const USERS = [
  { id: 1, name: 'ada', age: 36, active: true, created: '2020-05-01T00:00:00Z', tags: ['dev'] },
  { id: 2, name: 'kid', age: 8, active: false, created: '2024-01-01T00:00:00Z', tags: [] },
];

describe('runtime twins of the type-level claims', () => {
  it('select narrows: the projected shape is exactly what toArray yields', () => {
    const rows = from(USERS).select((u) => ({ id: u.id, label: u.name.upper() })).toArray();
    assert.deepStrictEqual(rows, [{ id: 1, label: 'ADA' }, { id: 2, label: 'KID' }]);
  });

  it('firstOrDefault is optional (undefined on empty); single is not (throws)', () => {
    assert.strictEqual(from([]).firstOrDefault(), undefined);
    assert.throws(() => from([]).single(), (e) => e.code === 'JL2001');
    assert.strictEqual(from([7]).single(), 7);
  });

  it('groupBy yields { key, items } with a null key for the empty grouping key', () => {
    const groups = from(USERS).groupBy((u) => u.tags.at(0)).toArray();
    assert.deepStrictEqual(groups.map((g) => g.key), ['dev', null]);
    assert.strictEqual(Array.isArray(groups[0].items), true);
  });

  it('min/max follow the operand family: strings yield a string, numbers a number', () => {
    assert.strictEqual(from(USERS).select((u) => u.name).min(), 'ada');
    assert.strictEqual(typeof from(USERS).select((u) => u.age).min(), 'number');
  });

  it('count is a number; sum of nothing is 0', () => {
    assert.strictEqual(from(USERS).count(), 2);
    assert.strictEqual(from([]).sum(), 0);
  });

  it('the DateTime brand is type-level only: the runtime value is a plain string', () => {
    // `created` is annotated DateTime in the typed block; here it is
    // just a string, and the date operators work on its VALUE
    const years = from(USERS).select((u) => u.created.year()).toArray();
    assert.deepStrictEqual(years, [2020, 2024]);
    assert.strictEqual(typeof USERS[0].created, 'string');
  });

  it('params flow through the second callback argument at runtime too', () => {
    const rows = from(USERS).params({ minAge: 21 })
      .where((u, p) => u.age.ge(p.minAge)).toArray();
    assert.deepStrictEqual(rows.map((u) => u.id), [1]);
  });

  it('a fanned array aggregates (the all().count() twin)', () => {
    const withTags = from(USERS).where((u) => u.tags.all().count().gt(0)).toArray();
    assert.deepStrictEqual(withTags.map((u) => u.id), [1]);
  });

  it('defaultIfEmpty widens the element with its fallback', () => {
    assert.deepStrictEqual(from([]).defaultIfEmpty(null).toArray(), [null]);
  });

  it('ofType is caller-asserted narrowing: the runtime filters, the type is what the caller says', () => {
    // without the hook the claim is refused (JL0003), never silently
    // widened — the honest-unknown default of the typed surface
    assert.throws(() => from([1, 'a']).ofType({ type: 'number' }).toArray(),
      (e) => e.code === 'JL0003');
  });
});
