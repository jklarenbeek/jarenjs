//@ts-check
/**
 * @file The spatial family on the fluent surface (LINQ-FORMAT.md §4).
 *
 * Two things are proven here and neither is decoration. The chain emits
 * the query document a hand-writer would have written — which is what
 * makes `@jarenjs/db`'s pushdown reachable from the surface its own
 * README calls the usual way to write a query — and the chain returns
 * the right answer in memory, so the emission is not merely
 * well-formed.
 */

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import * as assert from 'node:assert';

import { from } from '@jarenjs/linq';

const REGION = {
  type: 'Polygon',
  coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]],
};
const PLACES = [
  { name: 'Amsterdam', location: [4.9041, 52.3676] },
  { name: 'Paris', location: [2.3522, 48.8566] },
  { name: 'Utrecht', location: [5.1214, 52.0907] },
];

/** Capture one predicate's emitted `$where`. @param {any} fn */
const emitted = (fn) => from([]).where(fn).toDocument().$where;

describe('the spatial family emits §8.14', () => {
  it('emits the measurement and predicate operators', () => {
    assert.deepStrictEqual(emitted((p) => p.g.bbox().exists()), { $exists: { $bbox: '$it.g' } });
    assert.deepStrictEqual(emitted((p) => p.g.geoArea().gt(0)), { $gt: [{ $area: '$it.g' }, 0] });
    assert.deepStrictEqual(emitted((p) => p.g.geoLength().gt(0)), { $gt: [{ $length: '$it.g' }, 0] });
    assert.deepStrictEqual(emitted((p) => p.g.centroid().exists()), { $exists: { $centroid: '$it.g' } });
    assert.deepStrictEqual(emitted((p) => p.a.distance(p.b).lt(100)),
      { $lt: [{ $distance: ['$it.a', '$it.b'] }, 100] });
    assert.deepStrictEqual(emitted((p) => p.a.bboxIntersects(p.b)),
      { '$bbox-intersects': ['$it.a', '$it.b'] });
  });

  it('emits the conversion family', () => {
    assert.deepStrictEqual(emitted((p) => p.w.geoParse().exists()),
      { $exists: { '$geo-parse': '$it.w' } });
    assert.deepStrictEqual(emitted((p) => p.g.geoText().exists()),
      { $exists: { '$geo-text': '$it.g' } });
    assert.deepStrictEqual(emitted((p) => p.c.geohashBounds().exists()),
      { $exists: { '$geohash-bounds': '$it.c' } });
    assert.deepStrictEqual(emitted((p) => p.c.geohashNeighbours().exists()),
      { $exists: { '$geohash-neighbours': '$it.c' } });
    assert.deepStrictEqual(emitted((p) => p.g.geoSimplify(0.01).exists()),
      { $exists: { '$geo-simplify': ['$it.g', 0.01] } });
  });

  it('emits geohash with an optional precision, like substring', () => {
    assert.deepStrictEqual(emitted((p) => p.g.geohash().eq('u173zqmrf')),
      { $eq: [{ $geohash: '$it.g' }, 'u173zqmrf'] });
    assert.deepStrictEqual(emitted((p) => p.g.geohash(5).eq('u173z')),
      { $eq: [{ $geohash: ['$it.g', 5] }, 'u173z'] });
  });

  it('keeps length as $string-length — two operators, two methods', () => {
    // §8.14's $length is a geodesic measurement and §8.7's is a string
    // count; renaming the shipped one for symmetry would break a
    // surface for a cosmetic gain, so the spatial pair is prefixed
    assert.deepStrictEqual(emitted((p) => p.name.length().gt(3)),
      { $gt: [{ '$string-length': '$it.name' }, 3] });
    assert.deepStrictEqual(emitted((p) => p.route.geoLength().gt(3)),
      { $gt: [{ $length: '$it.route' }, 3] });
  });
});

describe('the spatial family runs', () => {
  it('filters by containment and projects — document and answer', () => {
    const query = from(PLACES).where((p) => p.location.within(REGION)).select((p) => p.name);
    assert.deepStrictEqual(query.toDocument(), {
      $for: { it: '$[*]' },
      $where: { $within: ['$it.location', { $const: REGION }] },
      $return: '$it.name',
    });
    assert.deepStrictEqual(query.toArray(), ['Amsterdam']);
  });

  it('takes a parameterized region as an external', () => {
    // the shape a spatial index is probed with: the polygon is bound at
    // call time rather than baked into the document, so one compiled
    // query serves every region
    const query = from(PLACES)
      .params({ region: REGION })
      .where((p, params) => p.location.within(params.region))
      .select((p) => p.name);
    assert.deepStrictEqual(query.toDocument(), {
      $for: { it: '$[*]' },
      $where: { $within: ['$it.location', '$region'] },
      $return: '$it.name',
    });
    assert.deepStrictEqual(query.toArray(), ['Amsterdam']);
  });

  it('orders by distance and buckets by cell', () => {
    assert.deepStrictEqual(
      from(PLACES).orderBy((p) => p.location.distance([4.9041, 52.3676])).select((p) => p.name).toArray(),
      ['Amsterdam', 'Utrecht', 'Paris']);
    assert.deepStrictEqual(
      from(PLACES).select((p) => p.location.geohash(3)).toArray(),
      ['u17', 'u09', 'u17']);
  });

  it('converts in both directions', () => {
    const rows = [{ shape: 'POLYGON ((4 52, 5 52, 5 53, 4 53, 4 52))' }];
    assert.deepStrictEqual(
      from(rows).select((r) => r.shape.geoParse().bbox()).toArray(),
      [[4, 52, 5, 53]]);
    assert.deepStrictEqual(
      from(PLACES).select((p) => p.location.geoText()).toArray(),
      ['POINT (4.9041 52.3676)', 'POINT (2.3522 48.8566)', 'POINT (5.1214 52.0907)']);
  });

  it('reads a member that shares a method name through get()', () => {
    // every METHODS name shadows a data member of the same name, which
    // is what `get(name)` exists for — and `at` is exactly the member
    // name a position tends to have
    const rows = [{ at: [4.9041, 52.3676] }, { at: [2.3522, 48.8566] }];
    assert.deepStrictEqual(
      from(rows).where((r) => r.get('at').within(REGION)).select((r) => r.get('at').geohash(5)).toArray(),
      ['u173z']);
  });
});

describe('the spatial surface is documented exactly once, in LINQ-FORMAT §4', () => {
  // the same shape as the operator/§8 membership gate one package over:
  // the methods the source spells and the row the format publishes must
  // name the same set, so a sixth spatial method cannot land in one
  // place — and every method maps to a §8.14 operator the query format
  // publishes, so the surface cannot name an operator that does not exist
  const source = readFileSync(new URL('../../packages/linq/src/expression.js', import.meta.url), 'utf8');
  const format = readFileSync(new URL('../../packages/linq/docs/LINQ-FORMAT.md', import.meta.url), 'utf8');
  const query = readFileSync(new URL('../../packages/json/docs/QUERY-FORMAT.md', import.meta.url), 'utf8');

  const spatialOperators = new Set([...query.slice(query.indexOf('### 8.14'), query.indexOf('## 9'))
    .matchAll(/^\| `(\$[a-z-]+)` \|/gm)].map((m) => m[1]));

  /** Every METHODS member that emits an operator, from the source. */
  const emitted = new Map([...source.matchAll(/\b(\w+): (?:unary|binary)\('(\$[a-z-]+)'\)/g)]
    .map((m) => [m[1], m[2]]));
  emitted.set('geohash', '$geohash'); // the optional-arity method is hand-written
  const spatialMethods = [...emitted].filter(([, op]) => spatialOperators.has(op)).map(([name]) => name);

  /** Every method the source hand-writes (`name(record, …)`), spatial or not. */
  const handWritten = new Set([...source.matchAll(/^ {2}(\w+)\(record[,)]/gm)].map((m) => m[1]));

  /** The method names §4's spatial row publishes — every backticked
   * bare identifier that is a METHODS member (the row may name a
   * non-spatial method as an analogy, `substring`, and that is fine). */
  const row = format.split('\n').find((line) => line.startsWith('| spatial family (§8.14) |'));
  const tokens = [...(row ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1])
    .filter((token) => !token.includes('$') && !token.includes('.') && !token.includes('{'))
    .flatMap((token) => token.split(/\s+/))
    .map((token) => token.replace(/\(.*\)$/, ''))
    .filter((token) => /^[a-zA-Z]+$/.test(token));
  const documented = [...new Set(tokens)];

  it('names the same methods in the source and in the format row', () => {
    assert.ok(row !== undefined, 'LINQ-FORMAT §4 has the spatial row');
    const unknown = documented.filter((name) => !emitted.has(name) && !handWritten.has(name));
    assert.deepStrictEqual(unknown, [], 'the row names a method the source does not have');
    const spatialDocumented = documented.filter((name) => spatialMethods.includes(name));
    assert.deepStrictEqual(spatialDocumented.sort(), [...spatialMethods].sort(),
      'the spatial methods the source spells and the ones §4 publishes differ');
    assert.strictEqual(spatialMethods.length, spatialOperators.size,
      'one method per §8.14 operator, and every operator has one');
  });

  it('every spatial method emits an operator §8.14 publishes', () => {
    for (const name of spatialMethods) {
      assert.ok(spatialOperators.has(/** @type {string} */ (emitted.get(name))), `${name} emits an unpublished operator`);
    }
    assert.deepStrictEqual([...spatialOperators].filter((op) => ![...emitted.values()].includes(op)), [],
      'a §8.14 operator with no method on the fluent surface');
  });
});
