import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  geohashEncode, geohashDecode, geohashBounds, geohashCellSize, geohashNeighbours,
  haversineDistance, bboxContains,
} from '@jarenjs/core/geo';

describe('geohash', () => {
  it('should encode known positions', () => {
    // Amsterdam; the well-known prefix for the western Netherlands is u17
    assert.strictEqual(geohashEncode(4.9041, 52.3676, 5), 'u173z');
    assert.strictEqual(geohashEncode(4.9041, 52.3676, 3), 'u17');
    // the null island, and the poles, are all representable
    assert.strictEqual(geohashEncode(0, 0, 1), 's');
    assert.strictEqual(geohashEncode(-180, -90, 1), '0');
    assert.strictEqual(geohashEncode(180, 90, 1), 'z');
  });

  it('should nest: a shorter hash is a prefix of a longer one', () => {
    // this is the property the whole integration rests on — proximity
    // becomes a string prefix test, so no new query vocabulary is needed
    const full = geohashEncode(4.9041, 52.3676, 9);
    for (let p = 1; p < 9; p++) {
      assert.strictEqual(geohashEncode(4.9041, 52.3676, p), full.slice(0, p), `precision ${p}`);
    }
  });

  it('should decode to within the cell it names', () => {
    for (const [lon, lat] of [[4.9041, 52.3676], [-122.4194, 37.7749], [0, 0], [151.2093, -33.8688]]) {
      const hash = geohashEncode(lon, lat, 9);
      const box = geohashBounds(hash);
      assert.strictEqual(bboxContains(box, lon, lat), true, `${hash} should contain its own input`);
      const back = geohashDecode(hash);
      // precision 9 is metre-scale; the centre is within a few metres
      assert.ok(haversineDistance(lon, lat, back[0], back[1]) < 5,
        `decode of ${hash} landed too far from the input`);
    }
  });

  it('should lose precision predictably, never claiming a point', () => {
    // a hash names a cell, so the decoded centre moves as precision drops
    const exact = [4.9041, 52.3676];
    let previous = 0;
    for (const p of [3, 5, 7, 9]) {
      const back = geohashDecode(geohashEncode(exact[0], exact[1], p));
      const error = haversineDistance(exact[0], exact[1], back[0], back[1]);
      if (previous !== 0)
        assert.ok(error < previous, `precision ${p} should be tighter than the last`);
      previous = error;
    }
  });

  it('should report cell sizes that halve alternately', () => {
    assert.deepStrictEqual(geohashCellSize(1), [45, 45]);
    const [lon5, lat5] = geohashCellSize(5);
    const [lon6, lat6] = geohashCellSize(6);
    assert.ok(lon6 <= lon5 && lat6 <= lat5, 'more characters is never a bigger cell');
    assert.strictEqual(geohashCellSize(0), null);
    assert.strictEqual(geohashCellSize(99), null);
  });

  it('should reject characters outside the base-32 alphabet', () => {
    // a, i, l and o are deliberately absent, to avoid transcription errors
    for (const bad of ['a', 'i', 'l', 'o', 'u17a', 'U17']) {
      assert.strictEqual(geohashBounds(bad), null, bad);
      assert.strictEqual(geohashDecode(bad), null, bad);
    }
    assert.strictEqual(geohashBounds(''), null);
    assert.strictEqual(geohashBounds(42), null);
  });

  it('should give the surrounding cells, which is what makes a prefix search safe', () => {
    // two points metres apart can sit in different cells, so a proximity
    // query has to test the neighbourhood rather than the single cell
    const cells = geohashNeighbours('u173z');
    assert.strictEqual(cells.length, 9, 'the cell plus its eight neighbours');
    assert.ok(cells.includes('u173z'), 'including itself');
    assert.strictEqual(new Set(cells).size, 9, 'all distinct');
    for (const c of cells)
      assert.strictEqual(c.length, 5, 'neighbours keep the precision');
  });

  it('should omit cells past a pole and wrap at the antimeridian', () => {
    const north = geohashNeighbours(geohashEncode(0, 90, 3));
    assert.ok(north.length < 9, 'there is nothing north of the north pole');
    // at the antimeridian the eastern neighbours wrap round rather than vanish
    const edge = geohashNeighbours(geohashEncode(179.9, 0, 3));
    assert.strictEqual(edge.length, 9);
    assert.deepStrictEqual(geohashNeighbours('!'), [], 'an invalid hash has no neighbours');
  });
});
