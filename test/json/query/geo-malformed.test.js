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
