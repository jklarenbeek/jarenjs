//@ts-check
/**
 * @file The vector family on the fluent surface (LINQ-FORMAT.md §4).
 *
 * Two things are proven here and neither is decoration. The chain emits
 * the query document a hand-writer would have written — the `$orderby`
 * on a `$similarity` key plus `$subsequence` that QUERY-FORMAT §8.15
 * publishes as the k-nearest recipe — and the chain returns the right
 * rows in memory, so the emission is not merely well-formed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { from } from '@jarenjs/linq';
import { sectionOf } from '../format-sections.js';

const MEMORIES = [
  { id: 'a', text: 'alpha', embedding: [1, 0] },
  { id: 'b', text: 'beta', embedding: [0, 1] },
  { id: 'c', text: 'gamma' },
  { id: 'd', text: 'delta', embedding: [0.9, 0.1] },
  { id: 'e', text: 'epsilon', embedding: [1, 0] },
];
const QUERY = [1, 0];

/** Capture one predicate's emitted `$where`. @param {any} fn */
const emitted = (fn) => from([]).where(fn).toDocument().$where;

describe('the vector family emits §8.15', () => {
  it('emits the one operator, with the operand embedded or bound', () => {
    assert.deepStrictEqual(emitted((m) => m.embedding.similarity([1, 0]).gt(0.5)),
      { $gt: [{ $similarity: ['$it.embedding', { $const: [1, 0] }] }, 0.5] });
    assert.deepStrictEqual(
      from([]).params({ query: QUERY })
        .where((m, p) => m.embedding.similarity(p.query).gt(0.5)).toDocument().$where,
      { $gt: [{ $similarity: ['$it.embedding', '$query'] }, 0.5] });
  });

  it('reads a member named similarity through get() — the method shadows it', () => {
    // every METHODS name shadows a data member of the same name, and a
    // stored score called `similarity` is the bite with the worst
    // error: `m.similarity` is the METHOD, so calling it as a member is
    // a plain TypeError about a function, not a coded build error
    assert.deepStrictEqual(
      emitted((m) => m.get('similarity').similarity([1, 0]).gt(0.5)),
      { $gt: [{ $similarity: ["$it['similarity']", { $const: [1, 0] }] }, 0.5] });
    assert.throws(() => from([]).where((m) => m.similarity.similarity([1, 0]).gt(0.5)),
      TypeError);
  });

  it('emits the published k-nearest recipe, not a knn method', () => {
    const query = from(MEMORIES).params({ query: QUERY })
      .orderByDescending((m, p) => m.embedding.similarity(p.query), { empty: 'least' })
      .thenBy((m) => m.id)
      .take(2)
      .select((m) => m.id);
    assert.deepStrictEqual(query.toDocument(), {
      $for: { it: {
        $subsequence: [{
          $for: { it: '$[*]' },
          $orderby: [
            { $key: { $similarity: ['$it.embedding', '$query'] }, $dir: 'desc', $empty: 'least' },
            { $key: '$it.id' },
          ],
          $return: '$it',
        }, 0, 2],
      } },
      $return: '$it.id',
    });
    assert.deepStrictEqual(query.toArray(), ['a', 'e']);
  });
});

describe('the vector family runs', () => {
  it('ranks by meaning, ties by identity, un-embedded last', () => {
    const ranked = from(MEMORIES).params({ query: QUERY })
      .orderByDescending((m, p) => m.embedding.similarity(p.query), { empty: 'least' })
      .thenBy((m) => m.id)
      .select((m) => m.id);
    // a and e tie at 1 and break by id; c has no vector at all and b's
    // is orthogonal — 'least' under a descending sort puts the empty
    // key last, which is where a row that cannot be scored belongs
    assert.deepStrictEqual(ranked.toArray(), ['a', 'e', 'd', 'b', 'c']);
    // the input order does not decide the tie: stability is only about
    // the input, and identical scores are what near-duplicates produce
    assert.deepStrictEqual(
      from([...MEMORIES].reverse()).params({ query: QUERY })
        .orderByDescending((m, p) => m.embedding.similarity(p.query), { empty: 'least' })
        .thenBy((m) => m.id)
        .select((m) => m.id).toArray(),
      ['a', 'e', 'd', 'b', 'c']);
  });

  it('filters by a threshold, and the unvectored drop out for free', () => {
    assert.deepStrictEqual(
      from(MEMORIES).params({ query: QUERY })
        .where((m, p) => m.embedding.similarity(p.query).gt(0.8))
        .select((m) => m.id).toArray(),
      ['a', 'd', 'e']);
  });
});

describe('the vector surface is documented exactly once, in LINQ-FORMAT §4', () => {
  // the same membership gate the spatial family has: the methods the
  // source spells and the row the format publishes must name the same
  // set, and every one maps to a §8.15 operator the query format
  // publishes — so the surface cannot name an operator that does not
  // exist, and a second vector method cannot land in one place only
  const source = readFileSync(new URL('../../packages/linq/src/expression.js', import.meta.url), 'utf8');
  const format = readFileSync(new URL('../../packages/linq/docs/LINQ-FORMAT.md', import.meta.url), 'utf8');
  const query = readFileSync(new URL('../../packages/json/docs/QUERY-FORMAT.md', import.meta.url), 'utf8');

  const section = sectionOf(query, '### 8.15');
  const operators = new Set([...section
    .matchAll(/^\| `(\$[a-z-]+)` \|/gm)].map((m) => m[1]));

  /** Every METHODS member that emits an operator, from the source. */
  const emitted = new Map([...source.matchAll(/\b(\w+): (?:unary|binary)\('(\$[a-z-]+)'\)/g)]
    .map((m) => [m[1], m[2]]));
  const methods = [...emitted].filter(([, op]) => operators.has(op)).map(([name]) => name);

  it('publishes one method per §8.15 operator, and no more', () => {
    assert.ok(section.length > 0, 'QUERY-FORMAT has a §8.15');
    assert.deepStrictEqual([...operators], ['$similarity'],
      'the vector family is one operator and one metric — a second one needs a '
      + 'measured reason, and this row is where it would have to be argued');
    assert.deepStrictEqual(methods, ['similarity']);
    const row = format.split('\n').find((line) => line.startsWith('| vector family (§8.15) |'));
    assert.ok(row !== undefined, 'LINQ-FORMAT §4 has the vector row');
    for (const name of methods)
      assert.ok(row.includes(`\`${name}(`), `§4's row does not name ${name}`);
    // and the row says what the surface deliberately does NOT have
    assert.ok(/no `?knn`? method/i.test(row), "§4's row does not record that there is no knn method");
  });
});
