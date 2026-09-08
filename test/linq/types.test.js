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
import * as fs from 'node:fs';

import { from } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import { JarenValidator } from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { importSubpaths } from '../../scripts/lib/exports.js';

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

  it('ofType over a schema-pen builder narrows to Infer<> of the builder (the runtime twin)', () => {
    // the type gate pins `from(rows).ofType(Strict)` as Sequence<{ kind: string }>;
    // here the same builder's document does the filtering
    const Strict = s.object({ kind: s.string() });
    const compileTypeTest = createTypeTestCompiler(new JarenValidator());
    const rows = [{ kind: 'a' }, { kind: 1 }, { kind: 'b', extra: true }];
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType(Strict).toArray(), [{ kind: 'a' }]);
    assert.deepStrictEqual(from(rows, { compileTypeTest }).ofType(Strict.schema).toArray(), [{ kind: 'a' }]);
  });
});

describe('a provider keeps its item type through the phantom (the runtime twin)', () => {
  it('a rooted provider answers the rows the chain typed; its root rides in the document', () => {
    const provider = {
      root: '$.User[*]',
      execute: (document) => (Array.isArray(document) ? ['ada@x'] : undefined),
    };
    const emails = from(provider).select((u) => u.email);
    assert.deepStrictEqual(emails.toArray(), ['ada@x']);
    assert.deepStrictEqual(emails.toDocument(), { $for: { it: '$.User[*]' }, $return: '$it.email' });
  });

  it('a relation member types as the related row (emit\'s optional member), and explain().hops lists the hop', () => {
    // the type gate pins `p.author.email` as StringExpr and `u.posts.all().count()`
    // as NumberExpr over the generated entity shapes; here the same
    // members navigate at runtime and the hop is reported
    const posts = {
      root: '$.Post[*]',
      relations: { author: { to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' } },
      execute: (document) => (Array.isArray(document) ? [{ title: 'p1', by: 'ada@x' }] : undefined),
    };
    const chain = from(posts).select((p) => ({ title: p.title, by: p.author.email }));
    assert.deepStrictEqual(chain.toArray(), [{ title: 'p1', by: 'ada@x' }]);
    assert.deepStrictEqual(chain.explain().hops, [{ member: 'author', kind: 'oneToOne', binding: 'r1' }]);
  });

  it('explain().bindings carries the values params() bound, on both surfaces', async () => {
    // the type gate pins `bindings` as Record<string, unknown> on Explanation
    // and AsyncExplanation; here the values are what a provider receives
    const { fromAsync } = await import('@jarenjs/linq');
    const bound = from(USERS).params({ min: 21, who: 'ada' }).where((u, p) => u.age.gt(p.min));
    assert.deepStrictEqual(bound.explain().bindings, { min: 21, who: 'ada' });
    assert.deepStrictEqual(bound.explain().externals, ['min'], 'externals names what the document reads');
    assert.deepStrictEqual(from(USERS).explain().bindings, {});
    assert.deepStrictEqual(fromAsync(USERS).params({ min: 21 }).explain().bindings, { min: 21 });
    assert.deepStrictEqual(fromAsync(USERS).explain().bindings, {});
  });
});

describe('the declared export set and the runtime export set are one set', () => {
  // The two sets drifted in three pens at once because nothing held them
  // equal: a name the `.d.ts` exports as a VALUE and the module does not
  // is an import that type-checks and throws at run time; a name the
  // module exports and the declaration omits is a class a `strict`
  // consumer cannot reach. Both directions are asserted per pen, so a
  // failure names the pen and the names.
  const PENS = ['schema', 'model', 'jslt', 'migration', 'db', 'contract', 'flow', 'app', 'forms', 'charts', 'project', 'jtlt', 'messages', 'ai'];

  // The forms a `.d.ts` uses to export a VALUE. `export type`, `export
  // interface`, `export type { … }` and a type-only re-export are
  // deliberately absent: those are exactly what the repaired surface
  // uses for a name that has no runtime class.
  const VALUE_EXPORT = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

  const declaredValuesOf = (pen) => {
    const source = fs.readFileSync(new URL(`../../packages/linq/types/${pen}.d.ts`, import.meta.url), 'utf8');
    // a Set: an overloaded `export function` writes its name once per signature
    return [...new Set([...source.matchAll(VALUE_EXPORT)].map((m) => m[1]))].sort();
  };

  it('the pen family covers every subpath the package publishes beside the chain', () => {
    // A new pen must not arrive unnoticed: the list above is what the
    // suite below iterates, and this holds it to the package's own map.
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../../packages/linq/package.json', import.meta.url), 'utf8'));
    // the one manifest census (scripts/lib/exports.js), not a second reading of `exports`
    const published = importSubpaths(manifest)
      .filter((subpath) => subpath !== '@jarenjs/linq')
      .map((subpath) => subpath.slice('@jarenjs/linq/'.length)).sort();
    assert.deepStrictEqual(published, [...PENS].sort());
  });

  for (const pen of PENS) {
    it(`@jarenjs/linq/${pen}: every declared value is exported and every export is declared`, async () => {
      const runtime = Object.keys(await import(`@jarenjs/linq/${pen}`)).sort();
      const declared = declaredValuesOf(pen);
      // Assert what was checked: a matcher that stops matching finds
      // nothing, and a floor is what tells the reader it still matches.
      assert.ok(declared.length > 0, `types/${pen}.d.ts declares at least one value export`);
      assert.ok(runtime.length > 0, `@jarenjs/linq/${pen} exports at least one name`);
      assert.deepStrictEqual(declared, runtime,
        `types/${pen}.d.ts value exports vs @jarenjs/linq/${pen} runtime exports — `
        + `declared-only: [${declared.filter((n) => !runtime.includes(n))}]; `
        + `runtime-only: [${runtime.filter((n) => !declared.includes(n))}]`);
    });
  }
});
