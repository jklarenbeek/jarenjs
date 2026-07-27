/**
 * The streaming-FeatureCollection story, end to end: the reader hands
 * over one feature at a time and keeps none, the geo kernel folds each
 * one into an aggregate, and the aggregate is what gets drawn.
 *
 * This is the shape that scales. Drawing a million features is not a
 * thing anyone does — you count them, bound them, or bin them, and draw
 * *that* — so the test does the same, and the assertions are about the
 * aggregate matching a whole-document parse exactly.
 */
import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { createJsonxStreamReader } from '@jarenjs/josl';
import { bboxOf, bboxUnion, geometryArea, centroidOf } from '@jarenjs/core/geo';
import { compileChart } from '@jarenjs/charts';

/** A FeatureCollection of `count` square regions, as text. */
function featureCollectionText(count) {
  const features = [];
  for (let i = 0; i < count; i++) {
    const lon = -180 + (i % 36) * 10;
    const lat = -80 + (i % 16) * 10;
    features.push({
      type: 'Feature',
      properties: { id: i, region: `r${i % 4}`, name: `region-${i}` },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon, lat], [lon + 2, lat], [lon + 2, lat + 2], [lon, lat + 2], [lon, lat],
        ]],
      },
    });
  }
  return JSON.stringify({ type: 'FeatureCollection', name: 'regions', features });
}

/**
 * Fold a streamed FeatureCollection into a fixed-size aggregate: the
 * overall bounding box, and total area per region group. Nothing that
 * grows with the feature count is kept.
 */
function aggregate(text, chunkSize) {
  const areaByRegion = new Map();
  let bbox = null;
  let seen = 0;
  let lastCentroid = null;

  const reader = createJsonxStreamReader({
    mode: 'json',
    detach: ['features', '*'],
    onEvent: (e) => {
      if (e.type !== 'object-end' || e.path.length !== 2) return;
      const feature = e.value;
      seen++;
      const box = bboxOf(feature);
      bbox = bbox === null ? box : bboxUnion(bbox, box);
      const region = feature.properties.region;
      areaByRegion.set(region, (areaByRegion.get(region) ?? 0) + geometryArea(feature));
      lastCentroid = centroidOf(feature);
      // and then the feature goes out of scope — nothing holds it
    },
  });
  for (let i = 0; i < text.length; i += chunkSize)
    reader.feed(text.slice(i, i + chunkSize));

  return { root: reader.end(), bbox, areaByRegion, seen, lastCentroid };
}

describe('streaming a FeatureCollection', () => {
  const COUNT = 240;
  const TEXT = featureCollectionText(COUNT);
  const WHOLE = JSON.parse(TEXT);

  it('should see every feature while retaining none of them', () => {
    const result = aggregate(TEXT, 997); // a chunk size that splits tokens
    assert.strictEqual(result.seen, COUNT);
    assert.strictEqual(result.root.features.length, 0);
    assert.deepStrictEqual(result.root,
      { type: 'FeatureCollection', name: 'regions', features: [] });
  });

  it('should aggregate to exactly what a whole-document parse gives', () => {
    const streamed = aggregate(TEXT, 997);
    assert.deepStrictEqual(streamed.bbox, bboxOf(WHOLE));
    for (const [region, area] of streamed.areaByRegion) {
      const expected = WHOLE.features
        .filter((f) => f.properties.region === region)
        .reduce((sum, f) => sum + geometryArea(f), 0);
      assert.strictEqual(area, expected, `area for ${region}`);
    }
    assert.deepStrictEqual(streamed.lastCentroid,
      centroidOf(WHOLE.features[COUNT - 1]));
  });

  it('should give the same aggregate at every chunk size', () => {
    const base = aggregate(TEXT, TEXT.length);
    for (const size of [1, 7, 64, 4096]) {
      const other = aggregate(TEXT, size);
      assert.deepStrictEqual(other.bbox, base.bbox, `bbox at chunk ${size}`);
      assert.strictEqual(other.seen, base.seen, `count at chunk ${size}`);
      assert.deepStrictEqual([...other.areaByRegion].sort(), [...base.areaByRegion].sort(),
        `areas at chunk ${size}`);
    }
  });

  it('should draw the aggregate, which is the point of aggregating', () => {
    const { areaByRegion } = aggregate(TEXT, 997);
    const svg = compileChart({
      type: 'bar',
      title: 'Area by region group',
      valLabel: 'm²',
      categories: [...areaByRegion.keys()],
      series: [{ name: 'area', values: [...areaByRegion.values()] }],
    }).toSvgString();
    assert.ok(!svg.includes('NaN'));
    assert.ok(svg.includes('Area by region group'));
    for (const region of areaByRegion.keys())
      assert.ok(svg.includes(region), `${region} should be a category`);
  });
});
