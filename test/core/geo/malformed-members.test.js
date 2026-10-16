//@ts-check
/**
 * @file A measurement reads a malformed member as nothing, as the module
 * states for malformed input: a collection list, a multi-geometry's
 * coordinates or a polygon's rings that cannot be iterated hold no
 * members, and a ring or line that is not a list holds no positions, so
 * area and length are 0, containment false, and a value with no rings has
 * every ring closed. The well-formed members beside one still count, at
 * the root and inside 300 collections alike, a ring or
 * line missing a position holds no positions, and every input that
 * answered before answers the same.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { containsPosition, geometryArea, geometryLength, ringsClosed, pointInRing, pointInPolygon, isRingClosed,
  sphericalRingArea, lineLength, simplifyLine, simplifyRing, simplifyGeometry } from '@jarenjs/core/geo';

const RING = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
const SQUARE = { type: 'Polygon', coordinates: [RING] };
const SQUARE_AREA = 49447340364.086266;
const SQUARE_LENGTH = 889425.154046261;

/** `g` inside 300 GeometryCollections, which the measurements walk. @param {any} g */
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
  assert.deepStrictEqual(at(deep(g)), shallow, 'a geometry inside collections must measure as at the root');
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
      // a malformed hole removes nothing from its polygon's measures, and its polygon contains nothing
      assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [RING, ring] }),
        { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: false, closed: false });
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
        // as a hole it removes nothing from the measures, and its polygon contains nothing
        assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [RING, ring] }),
          { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: false, closed });
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

  it('a ring of text is not closed', () => {
    // a ring of text has the characters for positions, which do not read as numbers
    assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: ['abcd'] }), { area: 0, length: 0, inside: false, closed: false });
  });

  it('a sparse polygon list skips its holes as every skips them', () => {
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'Polygon', coordinates: [RING, , RING] }), true);
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(ringsClosed({ type: 'MultiPolygon', coordinates: [[RING], , [RING]] }), true);
  });
});

describe('a position that is not a pair of finite numbers holds no positions', () => {
  // the last five read as numbers to arithmetic: as (1, 2), (1, 2), (0, 0), (1, 0) and (1, 2)
  const NOT_FINITE = [5, {}, 'ab', true, [1], [], [NaN, 0], [0, Infinity], [0, 'a'], [undefined, undefined],
    '12', { 0: 1, 1: 2 }, [null, null], [true, 0], ['1', '2']];
  const SQUARE4 = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const OUTER = [[-8, -8], [8, -8], [8, 8], [-8, 8], [-8, -8]];
  const OUTER_AREA = geometryArea({ type: 'Polygon', coordinates: [OUTER] });
  const OUTER_LENGTH = geometryLength({ type: 'Polygon', coordinates: [OUTER] });
  /** `bad` placed after the `at`th position of the 4x4 square. @param {any} bad @param {number} at */
  const square = (bad, at) => [...SQUARE4.slice(0, at), bad, ...SQUARE4.slice(at)];

  it('the entry\'s fence contains nothing and measures 0', () => {
    const fence = { type: 'Polygon', coordinates: [[[0, 0], 5, [2, 2], [0, 0]]] };
    assert.equal(containsPosition(fence, 1, 1), false);
    assert.equal(geometryLength(fence), 0);
    assert.equal(geometryArea(fence), 0);
    // closure compares the ends as they read, as for a missing inner position
    assert.equal(ringsClosed(fence), true);
  });

  it('a point outside such a ring is not inside it', () => {
    // the even-odd count over the ring's edges reported (6, 2) inside
    const ring = square(5, 2);
    assert.equal(containsPosition({ type: 'Polygon', coordinates: [ring] }, 6, 2), false);
    assert.equal(pointInRing(6, 2, ring), false);
    assert.equal(pointInPolygon(6, 2, [ring]), false);
  });

  /** @param {any} v @returns {string} */
  const label = (v) => (Array.isArray(v) ? `[${v.map(label).join(', ')}]` : typeof v === 'string' ? `'${v}'` : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const bad of NOT_FINITE) {
    it(`a ring or line holding ${label(bad)} is read as one with no positions`, () => {
      for (const at of [1, 2, 3]) {
        const ring = square(bad, at);
        for (const [x, y] of [[2, 2], [1, 1], [4, 2], [0, 0], [6, 2], [-5, 2]]) {
          assert.equal(containsPosition({ type: 'Polygon', coordinates: [ring] }, x, y), false, `${at} (${x}, ${y})`);
          assert.equal(pointInRing(x, y, ring), false, `${at} (${x}, ${y})`);
        }
        assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [ring] }), { area: 0, length: 0, inside: false, closed: true });
        assert.deepStrictEqual(measures({ type: 'LineString', coordinates: ring }), NOTHING);
        // as a hole it removes nothing from the measures, as a hole missing a position
        // does, and its polygon contains no point, inside the hole or out of it
        assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [OUTER, ring] }),
          { area: OUTER_AREA, length: OUTER_LENGTH, inside: false, closed: true });
        for (const [x, y] of [[2, 2], [-5, 2], [6, 6]]) {
          assert.equal(containsPosition({ type: 'Polygon', coordinates: [OUTER, ring] }, x, y), false, `(${x}, ${y})`);
          assert.equal(pointInPolygon(x, y, [OUTER, ring]), false, `(${x}, ${y})`);
        }
        // the holes after it are read too
        assert.equal(pointInPolygon(-5, 2, [OUTER, SQUARE4, ring]), false);
        // the well-formed members beside it count
        assert.deepStrictEqual(measures({ type: 'MultiPolygon', coordinates: [[ring], [RING]] }),
          { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
        assert.deepStrictEqual(measures({ type: 'MultiLineString', coordinates: [ring, RING] }),
          { area: 0, length: SQUARE_LENGTH, inside: false, closed: true });
        assert.deepStrictEqual(measures({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: ring }, SQUARE] }),
          { area: SQUARE_AREA, length: SQUARE_LENGTH, inside: true, closed: true });
      }
    });
  }

  it('a polygon with any hole that cannot be read contains nothing', () => {
    // a hole that is no array, misses a position, is a hole in the ring list, or is too short to bound
    // eslint-disable-next-line no-sparse-arrays
    const SPARSE = [OUTER, , SQUARE4];
    for (const rings of [[OUTER, null], [OUTER, 5], [OUTER, [[0, 0], null, [1, 1], [0, 0]]], SPARSE, [OUTER, [5]], [OUTER, [[0, 0], 'ab']]]) {
      assert.equal(containsPosition({ type: 'Polygon', coordinates: rings }, -5, 2), false);
      assert.equal(containsPosition(deep({ type: 'Polygon', coordinates: rings }), -5, 2), false);
      assert.equal(containsPosition({ type: 'MultiPolygon', coordinates: [rings] }, -5, 2), false);
      // the polygon beside it still contains
      assert.equal(containsPosition({ type: 'MultiPolygon', coordinates: [rings, [SQUARE4]] }, 2, 2), true);
    }
    // a well-formed ring too short to bound anything removes nothing, as before
    assert.equal(containsPosition({ type: 'Polygon', coordinates: [OUTER, [[0, 0], [1, 1]]] }, -5, 2), true);
    assert.equal(containsPosition({ type: 'Polygon', coordinates: [OUTER, []] }, -5, 2), true);
  });

  it('a point on an edge before such a position is not inside', () => {
    // the walk meets the edge (0,0)-(4,0) first; the position after it still counts
    for (const bad of [5, [NaN, 0], null]) {
      const ring = [[0, 0], [4, 0], [4, 4], bad, [0, 4], [0, 0]];
      assert.equal(pointInRing(2, 0, ring), false, String(bad));
      assert.equal(containsPosition({ type: 'Polygon', coordinates: [ring] }, 2, 0), false, String(bad));
    }
  });

  it('an unclosed ring starting at an infinite longitude bounds no area', () => {
    const ring = [[Infinity, 0], [1, 0], [1, 1], [0, 1]];
    assert.equal(geometryArea({ type: 'Polygon', coordinates: [ring] }), 0);
    assert.deepStrictEqual(measures({ type: 'Polygon', coordinates: [OUTER, ring] }).area, OUTER_AREA);
    assert.equal(geometryArea({ type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [ring] }, SQUARE] }), SQUARE_AREA);
  });

  it('a radius that is not finite measures every ring and line as it stands', () => {
    const malformed = { type: 'Polygon', coordinates: [OUTER, square(5, 2)] };
    for (const radius of [NaN, Infinity]) {
      assert.deepStrictEqual(geometryLength(SQUARE, radius), radius === Infinity ? Infinity : NaN);
      assert.deepStrictEqual(geometryLength(malformed, radius), NaN);
      assert.equal(geometryArea(malformed, radius), 0);
    }
    assert.equal(geometryArea(SQUARE, Infinity), Infinity);
    assert.equal(geometryArea(SQUARE, NaN), 0);
    // past a missing position too, where the lines are read again one by one
    const missing = { type: 'MultiLineString', coordinates: [[[0, 0], null], [[0, 0], [1, 1]]] };
    const both = { type: 'MultiLineString', coordinates: [...missing.coordinates, [[0, 0], 5]] };
    assert.deepStrictEqual(geometryLength(missing, Infinity), Infinity);
    for (const radius of [NaN, Infinity])
      assert.deepStrictEqual(geometryLength(both, radius), NaN);
    assert.deepStrictEqual(geometryLength(missing, NaN), NaN);
    assert.equal(geometryLength(both), geometryLength({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }));
    const holed = { type: 'MultiPolygon', coordinates: [[null], [OUTER, square(5, 2)]] };
    assert.equal(geometryArea(holed), OUTER_AREA);
    // on an infinite radius the exterior less the unread hole is NaN, read as 0 as it always was
    assert.equal(geometryArea(holed, Infinity), 0);
    assert.equal(geometryArea(holed, NaN), 0);
    assert.equal(geometryArea({ type: 'MultiPolygon', coordinates: [[null], [OUTER]] }, Infinity), Infinity);
  });

  it('a position that is not a pair but reads as numbers is not measured as those numbers', () => {
    for (const [position, as] of /** @type {[any, number[]][]} */ ([['12', [1, 2]], [{ 0: 1, 1: 2 }, [1, 2]],
      [[null, null], [0, 0]], [[true, 0], [1, 0]], [['1', '2'], [1, 2]]])) {
      const read = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], position, [0, 4], [0, 0]]] };
      const pair = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], as, [0, 4], [0, 0]]] };
      assert.deepStrictEqual(measures(read), NOTHING, JSON.stringify(position));
      assert.notDeepStrictEqual(measures(pair), NOTHING, JSON.stringify(position));
      assert.equal(containsPosition(read, 0.5, 1), false, JSON.stringify(position));
    }
  });

  it('a position with an altitude is measured as its pair', () => {
    const pair = { type: 'Polygon', coordinates: [SQUARE4] };
    const high = { type: 'Polygon', coordinates: [SQUARE4.map(([x, y], i) => [x, y, i])] };
    assert.deepStrictEqual(measures(high), measures(pair));
    assert.deepStrictEqual(measures({ type: 'LineString', coordinates: high.coordinates[0] }),
      measures({ type: 'LineString', coordinates: SQUARE4 }));
    assert.equal(pointInRing(2, 2, high.coordinates[0]), true);
  });

  it('a ring whose ends are not pairs is not closed', () => {
    for (const end of [5, '12', { 0: 1, 1: 2 }, [null, null], [true, 0], ['1', '2'], [1], 'ab']) {
      const ring = [end, [1, 1], [2, 0], end];
      assert.equal(ringsClosed({ type: 'Polygon', coordinates: [ring] }), false, label(end));
      assert.equal(ringsClosed(deep({ type: 'Polygon', coordinates: [ring] })), false, label(end));
      assert.equal(isRingClosed(ring), false, label(end));
    }
    // a pair closes the ring whatever its altitudes, as before
    assert.equal(isRingClosed([[0, 0, 1], [1, 1], [2, 0], [0, 0, 2]]), true);
  });

  it('the exported ring and line helpers read a missing position as not a position, never a TypeError', () => {
    const SQ = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
    for (const missing of [null, undefined]) {
      for (const ring of [[[0, 0], [4, 0], missing, [0, 4], [0, 0]], [[0, 0], [4, 0], [4, 4], [0, 4], missing],
        [missing, [4, 0], [4, 4], [0, 4], [0, 0]]]) {
        assert.equal(pointInRing(2, 2, ring), false, label(ring));
        assert.equal(pointInRing(4, 2, ring), false, label(ring));
        assert.equal(pointInPolygon(2, 2, [ring]), false, label(ring));
        assert.equal(pointInPolygon(2, 2, [SQ, ring]), false, label(ring));
        assert.deepStrictEqual(sphericalRingArea(ring), NaN, label(ring));
        assert.deepStrictEqual(lineLength(ring), NaN, label(ring));
      }
      assert.equal(isRingClosed([missing, [4, 0], [4, 4], missing]), false);
      assert.equal(isRingClosed([[0, 0], [4, 0], [4, 4], missing]), false);
      assert.equal(isRingClosed([missing, [4, 0], [4, 4], [0, 0]]), false);
    }
    // eslint-disable-next-line no-sparse-arrays
    const hole = [[0, 0], [4, 0], , [0, 4], [0, 0]];
    assert.equal(pointInRing(2, 2, hole), false);
    assert.deepStrictEqual(sphericalRingArea(hole), NaN);
    // a ring that is not a list contains nothing, and a polygon with such a hole neither
    for (const ring of [null, undefined, 5, {}, true]) {
      assert.equal(pointInRing(2, 2, /** @type {any} */ (ring)), false, String(ring));
      assert.equal(pointInPolygon(2, 2, /** @type {any} */ ([SQ, ring])), false, String(ring));
    }
    // another error a read raises is the reader's own, and escapes as it is
    const hostile = { get 0() { throw new RangeError('read refused'); }, 1: 0, length: 2 };
    const hostileRing = [[0, 0], [4, 0], hostile, [0, 4], [0, 0]];
    for (const read of [() => pointInRing(2, 2, hostileRing), () => pointInPolygon(2, 2, [hostileRing]),
      () => sphericalRingArea(hostileRing), () => lineLength(hostileRing)])
      assert.throws(read, { name: 'RangeError', message: 'read refused' });
    // the well-formed ring answers as before
    assert.equal(pointInRing(2, 2, SQ), true);
    assert.equal(pointInPolygon(2, 2, [SQ]), true);
    assert.equal(isRingClosed(SQ), true);
  });

  it('a line or ring holding a member that is not a position of finite numbers is not simplified', () => {
    for (const bad of [null, undefined, 5, '12', [null, null], [NaN, 0], [1], { 0: 1, 1: 2 }]) {
      const line = [[0, 0], [1, 0.001], bad, [2, 0.001], [3, 0], [4, 4], [5, 5]];
      const simplified = simplifyLine(line, 0.5);
      assert.deepStrictEqual(simplified, line, label(bad));
      assert.notStrictEqual(simplified, line, 'a copy, as every unsimplified answer is');
      const ring = [[0, 0], [1, 0.001], [2, 0], [2, 2], bad, [0, 2], [0, 0]];
      assert.deepStrictEqual(simplifyRing(ring, 0.5), ring, label(bad));
      assert.deepStrictEqual(simplifyGeometry({ type: 'Polygon', coordinates: [ring] }, 0.5),
        { type: 'Polygon', coordinates: [ring] }, label(bad));
    }
    // eslint-disable-next-line no-sparse-arrays
    const hole = [[0, 0], [1, 0.001], , [3, 0]];
    assert.deepStrictEqual(simplifyLine(hole, 0.5), hole);
    // a line of positions is simplified as before
    assert.deepStrictEqual(simplifyLine([[0, 0], [1, 0.001], [2, 0]], 0.01), [[0, 0], [2, 0]]);
    assert.deepStrictEqual(simplifyLine([[0, 0, 7], [1, 0.001], [2, 0, 9]], 0.01), [[0, 0, 7], [2, 0, 9]]);
  });

  it('the ring helpers read such a position as not finite', () => {
    for (const bad of ['12', { 0: 1, 1: 2 }, [null, null], [true, 0], ['1', '2']]) {
      assert.deepStrictEqual(sphericalRingArea(square(bad, 2)), NaN, label(bad));
      assert.deepStrictEqual(sphericalRingArea([bad, ...SQUARE4.slice(1, 4), bad]), NaN, label(bad));
      // an unclosed ring is read from its first position too
      assert.deepStrictEqual(sphericalRingArea([bad, ...SQUARE4.slice(1, 4)]), NaN, label(bad));
      assert.equal(geometryArea({ type: 'Polygon', coordinates: [[bad, ...SQUARE4.slice(1, 4)]] }), 0, label(bad));
      assert.deepStrictEqual(lineLength([[0, 0], bad]), NaN, label(bad));
      assert.deepStrictEqual(lineLength([bad, [0, 0]]), NaN, label(bad));
    }
    // a line that is not a list has no length to measure, as before
    for (const line of [5, {}, [], [[0, 0]]])
      assert.equal(lineLength(/** @type {any} */ (line)), 0, label(line));
  });
});

describe('a Feature at the root measures as its geometry and as inside a collection', () => {
  const SIDE4 = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const AREA4 = 197668873521.43472;
  const LENGTH4 = 1778037.382567902;
  // area, length, containsPosition(2, 2), ringsClosed
  const cases = [
    ['a well-formed polygon', { type: 'Polygon', coordinates: [SIDE4] }, [AREA4, LENGTH4, true, true]],
    ['an unclosed ring ending at an infinite longitude', { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [Infinity, 1]]] }, [0, 0, false, false]],
    ['a hole holding a position that is not a pair', { type: 'Polygon', coordinates: [SIDE4, [[1, 1], 5, [2, 2], [1, 1]]] }, [AREA4, LENGTH4, false, true]],
    ['a line that is missing', { type: 'MultiLineString', coordinates: [null, [[0, 0], [1, 1]]] }, [0, 157249.59847404022, false, true]],
  ];
  const four = (/** @type {any} */ v) => [geometryArea(v), geometryLength(v), containsPosition(v, 2, 2), ringsClosed(v)];
  for (const [label, geometry, expected] of cases) {
    it(label, () => {
      assert.deepStrictEqual(four(geometry), expected);
      assert.deepStrictEqual(four({ type: 'Feature', properties: null, geometry }), expected);
      assert.deepStrictEqual(four({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: null, geometry }] }), expected);
      // an array is no Feature, whatever members it carries
      assert.deepStrictEqual(four(Object.assign([], { type: 'Feature', geometry })), [0, 0, false, true]);
    });
  }
});
