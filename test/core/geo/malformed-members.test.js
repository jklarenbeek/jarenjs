//@ts-check
/**
 * @file A measurement reads a malformed member as nothing, as the module
 * states for malformed input: a collection list, a multi-geometry's
 * coordinates or a polygon's rings that cannot be iterated hold no
 * members, and a ring or line that is not a list holds no positions, so
 * area and length are 0, containment false, and a value with no rings has
 * every ring closed. The well-formed members beside one still count, on
 * the host's stack and past it (inside 300 collections) alike, a ring or
 * line missing a position holds no positions, and every input that
 * answered before answers the same.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { containsPosition, geometryArea, geometryLength, ringsClosed } from '@jarenjs/core/geo';

const RING = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
const SQUARE = { type: 'Polygon', coordinates: [RING] };
const SQUARE_AREA = 49447340364.086266;
const SQUARE_LENGTH = 889425.154046261;

/** `g` inside 300 GeometryCollections, past the measurements' recursion. @param {any} g */
const deep = (g) => {
  for (let i = 0; i < 300; i++) g = { type: 'GeometryCollection', geometries: [g] };
  return g;
};

/**
 * The four measurements of `g`, at the root and inside 300 collections,
 * which must agree.
 * @param {any} g
 */
const measures = (g) => {
  const at = (/** @type {any} */ v) => ({
    area: geometryArea(v),
    length: geometryLength(v),
    inside: containsPosition(v, 1, 1),
    closed: ringsClosed(v),
  });
  const shallow = at(g);
  assert.deepStrictEqual(at(deep(g)), shallow, 'the fold past the host stack must answer as the recursion');
  return shallow;
};

const NOTHING = { area: 0, length: 0, inside: false, closed: true };

describe('a member list that cannot be iterated holds no members', () => {
  for (const list of [{}, 5, true]) {
    const label = JSON.stringify(list);
    it(`FeatureCollection features ${label}, GeometryCollection geometries ${label}`, () => {
      assert.deepStrictEqual(measures({ type: 'FeatureCollection', features: list }), NOTHING);
      assert.deepStrictEqual(measures({ type: 'GeometryCollection', geometries: list }), NOTHING);
      assert.deepStrictEqual(measures({ type: 'Feature', geometry: { type: 'GeometryCollection', geometries: list } }), NOTHING);
    });
    it(`a multi-geometry or polygon whose coordinates are ${label}`, () => {
      for (const type of ['Polygon', 'MultiPolygon', 'MultiLineString'])
        assert.deepStrictEqual(measures({ type, coordinates: list }), NOTHING, type);
      // a polygon of that MultiPolygon holds no rings either
      assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [list] }), NOTHING);
    });
  }

  it('a MultiPolygon polygon that is missing holds no rings', () => {
    assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [null] }), NOTHING);
    assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [undefined, [RING]] }),
      { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
  });

  it('counts the well-formed members beside a malformed one', () => {
    assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [{}, [RING], 5] }),
      { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
    assert.deepStrictEqual(measures({ type: 'GeometryCollection', geometries: [{ type: 'GeometryCollection', geometries: 7 }, SQUARE] }),
      { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
    assert.deepStrictEqual(measures({ type: 'FeatureCollection', features: [{ type: 'FeatureCollection', features: {} }, { type: 'Feature', geometry: SQUARE }] }),
      { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
    assert.deepStrictEqual(measures({ type: 'MultiLineString', coordinates: [5, RING] }),
      { area: 0, length: SQUARE_LENGTH, inside: false, closed: true });
  });
});

describe('a ring or line that is not a list holds no positions', () => {
  for (const ring of [null, undefined, 5, {}, true]) {
    it(`a ring ${String(ring)} is not closed and bounds nothing; a line ${String(ring)} has no length`, () => {
      assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [ring] }), { area: 0, length: 0, inside: false, closed: false });
      assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [[ring]] }), { area: 0, length: 0, inside: false, closed: false });
      assert.deepStrictEqual(measures({ type: 'MultiLineString', coordinates: [ring] }), NOTHING);
      // a malformed hole removes nothing from its polygon
      assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [RING, ring] }),
        { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: false });
    });
  }

  it('a ring or line missing a position holds no positions', () => {
    const NO_RING = { area: 0, length: 0, inside: false, closed: false };
    for (const missing of [null, undefined]) {
      assert.deepStrictEqual(measures({ type: 'LineString', coordinates: [[0, 0], missing, [1, 1]] }), NOTHING);
      assert.deepStrictEqual(measures({ type: 'MultiLineString', coordinates: [[[0, 0], missing], RING] }),
        { area: 0, length: SQUARE_LENGTH, inside: false, closed: true });
      // missing first, inside or last; closure reads only the ends, so a
      // ring missing an inner position is closed, as it was
      for (const [ring, closed] of /** @type {[any[], boolean][]} */ ([
        [[missing, [2, 0], [2, 2], [0, 0]], false],
        [[[0, 0], [2, 0], missing, [0, 0]], true],
        [[[0, 0], [2, 0], [2, 2], missing], false],
      ])) {
        assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [ring] }), { ...NO_RING, closed });
        // as a hole it removes nothing
        assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [RING, ring] }),
          { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed });
        assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [[ring], [RING]] }),
          { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed });
      }
    }
    // an array hole is a missing position
    // eslint-disable-next-line no-sparse-arrays
    assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], , [0, 0]]] }), { ...NO_RING, closed: true });
    // a frozen ring is read, not written
    const frozen = Object.freeze([null, Object.freeze([2, 0]), Object.freeze([2, 2]), Object.freeze([0, 0])]);
    assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: Object.freeze([frozen]) }), NO_RING);
  });

  it('a hole in a list of rings beside a malformed polygon is skipped as every skips it', () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[RING, , RING], 5] }), true);
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[RING, , RING], [null]] }), false);
  });

  it('a ring missing an inner position is closed beside a malformed polygon too', () => {
    const inner = [[0, 0], [2, 0], null, [2, 2], [0, 0]];
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[inner]] }), true);
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[inner], 5] }), true);
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[[null, [2, 0], [0, 0]]], 5] }), false);
  });
});

describe('the inputs that answered before answer the same', () => {
  it('reads an iterable list as for...of reads it', () => {
    assert.deepStrictEqual(measures({ type: 'FeatureCollection', features: new Set([{ type: 'Feature', geometry: SQUARE }]) }),
      { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
    assert.deepStrictEqual(measures({ type: 'FeatureCollection', features: 'abc' }), NOTHING);
  });

  it('a position that is not a pair is a NaN coordinate, and a ring of text is not closed', () => {
    for (const position of [5, {}, 'ab', true]) {
      const line = measures({ type: 'LineString', coordinates: [[0, 0], position] });
      assert.ok(Number.isNaN(line.length), String(position));
      assert.deepStrictEqual({ ...line, length: 0 }, NOTHING);
      assert.deepStrictEqual({ ...measures({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], position, [0, 0]]] }), length: 0 },
        { area: 0, length: 0, inside: false, closed: true });
    }
    // a ring of text has the characters for positions
    assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: ['abcd'] }), { area: 0, length: NaN, inside: false, closed: false });
  });

  it('a sparse polygon list skips its holes as every skips them', () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'Polygon', coordinates: [RING, , RING] }), true);
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[RING], , [RING]] }), true);
  });
});
