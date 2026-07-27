//@ts-check
/**
 * The streaming map: whole Features off the reader, projected and
 * simplified on arrival, so drawing a FeatureCollection needs memory
 * proportional to the drawn detail rather than the source detail. The
 * assertions pin the three claims that make it honest: retention is the
 * reduced set only (the reader's root keeps nothing), the reduction is
 * real on dense data, and the refit-on-growth pass coarsens early
 * features when a later one moves the extent.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { compileChart } from '@jarenjs/charts';
import { createJsonxStreamReader } from '@jarenjs/josl';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { positionsOf } from '@jarenjs/core/geo';

/** A closed ring of `n` vertices around a centre. */
function denseRing(cx, cy, radius, n) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  ring.push([...ring[0]]);
  return ring;
}

function feature(name, pop, geometry) {
  return { type: 'Feature', properties: { name, pop }, geometry };
}

function collectionText(features) {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

/** Stream `text` into a map adapter in `chunkSize` slices. */
function stream(text, spec, chunkSize = 997) {
  const adapter = createStreamAdapter('map', spec);
  const reader = createJsonxStreamReader({
    mode: 'json',
    detach: ['features', '*'],
    onEvent: adapter.onEvent,
  });
  for (let i = 0; i < text.length; i += chunkSize)
    reader.feed(text.slice(i, i + chunkSize));
  const root = reader.end();
  adapter.endDocument();
  return { adapter, root };
}

describe('map stream accumulator', () => {
  const DENSE = feature('dense', 12, {
    type: 'Polygon', coordinates: [denseRing(4.9, 52.4, 0.4, 500)],
  });
  const NEIGHBOUR = feature('neighbour', 7, {
    type: 'Polygon', coordinates: [denseRing(5.9, 52.2, 0.3, 200)],
  });
  const CITY = feature('city', 3, { type: 'Point', coordinates: [4.9, 52.37] });
  const ROAD = feature('road', null, {
    type: 'LineString',
    coordinates: Array.from({ length: 300 }, (_, i) => [4.5 + i * 0.003, 52.1 + i * 0.001]),
  });

  it('should keep only the reduced features while the reader keeps none', () => {
    const text = collectionText([DENSE, NEIGHBOUR, CITY, ROAD]);
    const { adapter, root } = stream(text, { valueField: 'pop' });

    assert.deepEqual(root, { type: 'FeatureCollection', features: [] });

    const data = adapter.getData();
    assert.equal(data.features.length, 4);
    const road = data.features.find((f) => f.geometry.type === 'LineString');
    assert.ok(road.geometry.coordinates.length >= 2, 'the line survives, reduced');
    const sourceVertices = 501 + 201 + 1 + 300;
    const keptVertices = positionsOf({ type: 'FeatureCollection', features: data.features }).length;
    assert.ok(keptVertices < sourceVertices / 2,
      `kept ${keptVertices} of ${sourceVertices} — the dense rings should reduce`);

    // the kept rings are still valid GeoJSON rings
    for (const f of data.features) {
      if (f.geometry.type !== 'Polygon') continue;
      for (const ring of f.geometry.coordinates) {
        assert.ok(ring.length >= 4);
        assert.deepEqual(ring[0], ring[ring.length - 1], 'ring stays closed');
      }
    }
  });

  it('should draw the accumulated snapshot as a shaded map', () => {
    const text = collectionText([DENSE, NEIGHBOUR, CITY]);
    const { adapter } = stream(text, { valueField: 'pop' });
    const svg = compileChart(
      { type: 'map', title: 'Streamed', value: 'pop' },
      adapter.getData()).toSvgString();
    assert.ok(!svg.includes('NaN'));
    assert.ok(svg.includes('Streamed'));
    assert.ok(svg.includes('chart-map-area'));
    assert.ok(svg.includes('chart-map-dot'));
  });

  it('should give the same snapshot at every chunk size', () => {
    const text = collectionText([DENSE, NEIGHBOUR, CITY]);
    const base = stream(text, { valueField: 'pop' }, text.length).adapter.getData();
    for (const size of [1, 7, 64, 4096]) {
      const other = stream(text, { valueField: 'pop' }, size).adapter.getData();
      assert.deepEqual(other, base, `snapshot at chunk ${size}`);
    }
  });

  it('should coarsen early features when a later one grows the extent', () => {
    // alone, the dense ring spans the whole extent and keeps its detail
    const alone = stream(collectionText([DENSE]), {}).adapter.getData();
    const fine = positionsOf(alone.features[0]).length;

    // a feature on the other side of the world grows the extent ~200x,
    // so the ring becomes a speck and its kept detail must shrink
    const FAR = feature('far', 1, { type: 'Point', coordinates: [120, -30] });
    const grown = stream(collectionText([DENSE, FAR]), {}).adapter.getData();
    const coarse = positionsOf(grown.features[0]).length;

    assert.ok(coarse < fine, `refit should coarsen: ${coarse} < ${fine}`);
    assert.ok(coarse >= 4, 'but never below a valid ring');
  });

  it('should replay its change feed to the snapshot', () => {
    const text = collectionText([DENSE, NEIGHBOUR, CITY]);
    const adapter = createStreamAdapter('map', { valueField: 'pop', changes: true });
    const reader = createJsonxStreamReader({
      mode: 'json',
      detach: ['features', '*'],
      onEvent: adapter.onEvent,
    });
    let snapshot = adapter.getData();
    for (let i = 0; i < text.length; i += 97) {
      reader.feed(text.slice(i, i + 97));
      snapshot = applyJSONPatch(snapshot, adapter.takeChanges());
    }
    reader.end();
    adapter.endDocument();
    snapshot = applyJSONPatch(snapshot, adapter.takeChanges());
    assert.deepEqual(snapshot, adapter.getData());
  });

  it('should reject document mode', () => {
    assert.throws(() => createStreamAdapter('map', { recordBoundary: 'document' }),
      /path.*mode/);
  });

  it('should keep every vertex with simplify disabled', () => {
    const text = collectionText([DENSE]);
    const { adapter } = stream(text, { simplify: false });
    assert.equal(positionsOf(adapter.getData().features[0]).length, 501);
  });
});
