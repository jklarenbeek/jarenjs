//@ts-check
/**
 * @file The spatial operators answer a malformed collection member as the
 * geometry module reads it, as nothing: `$area` and `$length` 0, `$within`
 * false, `$bbox` and `$centroid` empty, never an uncoded `TypeError`. A
 * screened spatial join over such a region answers as the scan it replaces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery } from '@jarenjs/json/query';

const SQUARE = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
const MALFORMED = [
  { type: 'FeatureCollection', features: {} },
  { type: 'GeometryCollection', geometries: 5 },
  { type: 'MultiPolygon', coordinates: {} },
];

/** @param {any} doc @param {any} data */
const outcome = (doc, data) => {
  try {
    return { value: compileJsonQuery(doc)(data) };
  }
  catch (error) {
    return { name: error.name, code: error.code ?? 'uncoded' };
  }
};

describe('a spatial operator over a malformed collection member', () => {
  for (const g of MALFORMED) {
    it(`answers ${JSON.stringify(g)} as nothing`, () => {
      assert.deepStrictEqual(outcome({ $area: '$.g' }, { g }), { value: 0 });
      assert.deepStrictEqual(outcome({ $length: '$.g' }, { g }), { value: 0 });
      assert.deepStrictEqual(outcome({ $within: [[1, 1], '$.g'] }, { g }), { value: false });
      assert.deepStrictEqual(outcome({ $bbox: '$.g' }, { g }), { value: undefined });
      assert.deepStrictEqual(outcome({ $centroid: '$.g' }, { g }), { value: undefined });
    });
  }

  it('a screened join answers as the scan', () => {
    const doc = { $for: { p: '$.points[*]', r: '$.regions[*]' }, $where: { $within: ['$p.at', '$r.geom'] }, $return: '$r.id' };
    const data = {
      points: [{ at: [1, 1] }, { at: [5, 5] }],
      regions: [{ id: 'a', geom: SQUARE }, ...MALFORMED.map((geom, i) => ({ id: `m${i}`, geom }))],
    };
    // the scan is the same phrase with a $let, which the planner never screens
    assert.deepStrictEqual(outcome({ ...doc, $let: { _z: 1 } }, data), { value: 'a' });
    assert.deepStrictEqual(outcome(doc, data), { value: 'a' });
  });
});

describe('a spatial operator over a ring holding a position that does not read as numbers', () => {
  const SQUARE4 = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const OUTER = { type: 'Polygon', coordinates: [[[-8, -8], [8, -8], [8, 8], [-8, 8], [-8, -8]]] };
  const area = (/** @type {any} */ g) => outcome({ $area: '$.g' }, { g }).value;
  const length = (/** @type {any} */ g) => outcome({ $length: '$.g' }, { g }).value;

  // the last five read as numbers to arithmetic, and are no pair either
  for (const bad of [5, {}, 'ab', true, [1], '12', { 0: 1, 1: 2 }, [null, null], [true, 0], ['1', '2']]) {
    it(`reads ${JSON.stringify(bad)} as a ring with no positions`, () => {
      const fence = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], bad, [4, 4], [0, 4], [0, 0]]] };
      for (const at of [[2, 2], [6, 2], [1, 1]])
        assert.deepStrictEqual(outcome({ $within: [at, '$.g'] }, { g: fence }), { value: false }, JSON.stringify(at));
      assert.deepStrictEqual(outcome({ $area: '$.g' }, { g: fence }), { value: 0 });
      assert.deepStrictEqual(outcome({ $length: '$.g' }, { g: fence }), { value: 0 });
      // as a hole it removes nothing from the measures, and its polygon contains nothing
      const holed = { type: 'Polygon', coordinates: [OUTER.coordinates[0], fence.coordinates[0]] };
      for (const at of [[2, 2], [-5, 2]])
        assert.deepStrictEqual(outcome({ $within: [at, '$.g'] }, { g: holed }), { value: false }, JSON.stringify(at));
      assert.equal(area(holed), area(OUTER));
      assert.equal(length(holed), length(OUTER));
    });
  }

  it('a screened join answers as the scan, and the point outside the fence is not in it', () => {
    const doc = { $for: { p: '$.points[*]', r: '$.regions[*]' }, $where: { $within: ['$p.at', '$r.geom'] }, $return: '$p.id' };
    const data = {
      points: [{ id: 'in', at: [2, 2] }, { id: 'out', at: [6, 2] }],
      regions: [{ geom: { type: 'Polygon', coordinates: [[...SQUARE4.slice(0, 2), 5, ...SQUARE4.slice(2)]] } }],
    };
    assert.deepStrictEqual(outcome({ ...doc, $let: { _z: 1 } }, data), { value: undefined });
    assert.deepStrictEqual(outcome(doc, data), { value: undefined });
  });

  it('a screened join over a fence with a malformed hole answers as the scan, and finds nothing in it', () => {
    const doc = { $for: { p: '$.points[*]', r: '$.regions[*]' }, $where: { $within: ['$p.at', '$r.geom'] }, $return: '$p.id' };
    const holed = { type: 'Polygon', coordinates: [OUTER.coordinates[0], [[0, 0], [4, 0], 5, [4, 4], [0, 4], [0, 0]]] };
    const missing = { type: 'Polygon', coordinates: [OUTER.coordinates[0], [[0, 0], [4, 0], null, [4, 4], [0, 4], [0, 0]]] };
    const data = {
      points: [{ id: 'hole', at: [2, 2] }, { id: 'ring', at: [-5, 2] }, { id: 'square', at: [20, 20] }],
      regions: [{ geom: holed }, { geom: missing }, { geom: { type: 'Polygon', coordinates: [[[19, 19], [21, 19], [21, 21], [19, 21], [19, 19]]] } }],
    };
    assert.deepStrictEqual(outcome({ ...doc, $let: { _z: 1 } }, data), { value: 'square' });
    assert.deepStrictEqual(outcome(doc, data), { value: 'square' });
    // the box test reads the boxes alone, as documented
    assert.deepStrictEqual(outcome({ '$bbox-intersects': ['$.a', '$.b'] }, { a: holed, b: [2, 2] }), { value: true });
  });

  it('a non-finite coordinate stays empty and false', () => {
    const g = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [NaN, 0], [4, 4], [0, 0]]] };
    assert.deepStrictEqual(outcome({ $area: '$.g' }, { g }), { value: undefined });
    assert.deepStrictEqual(outcome({ $length: '$.g' }, { g }), { value: undefined });
    assert.deepStrictEqual(outcome({ $within: [[2, 2], '$.g'] }, { g }), { value: false });
  });
});
