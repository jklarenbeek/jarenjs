//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', '..', 'components', 'charts', 'schemas', 'chart-definition.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** Every fixture config the charts tests use, validated (dogfooding). */
const FIXTURES = [
  { type: 'pie', title: 'Pets', slices: [{ label: 'Dogs', value: 3 }, { label: 'Cats', value: 1 }] },
  { type: 'pie', slices: [{ label: 'x', value: 1 }] },
  { type: 'pie', title: null, slices: [] },
  { type: 'pie', title: 'Memo' },
  { type: 'pie', donut: true, slices: [{ label: 'a', value: 1 }] },
  { type: 'pie', donut: 0.4, slices: [{ label: 'a', value: 1 }] },
  { type: 'radar', max: 10, axes: ['a', 'b', 'c'], series: [{ name: 's', values: [1, null, 3] }] },
  { type: 'gauge', value: 87.4, min: 0, max: 100, unit: '%', tone: 'win' },
  {
    type: 'boxplot', valLabel: 'ms', boxes: [
      { label: 'raw', values: [1, 2, 3] },
      { label: 'summary', min: 1, q1: 2, med: 3, q3: 4, max: 5, outliers: [9] },
    ],
  },
  {
    type: 'heatmap', log: true, xLabels: ['x1'], yLabels: ['y1', 'y2'],
    values: [[1], [null]],
  },
  { type: 'treemap', aspect: 1.6, items: [{ label: 'a', value: 2 }] },
  { type: 'streamgraph', xs: [0, 1], series: [{ name: 'a', values: [1, 2] }] },
  {
    type: 'sankey', nodes: ['a', { name: 'b' }],
    links: [{ source: 'a', target: 1, value: 3 }],
  },
  {
    type: 'map', value: 'pop', label: 'name', log: true, simplify: false,
    features: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'a', pop: 10 },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }],
    },
    points: [{ at: [4.9, 52.37, 12], label: 'Amsterdam', value: 900 }],
  },
  { type: 'map', features: [], simplify: 0.001, aspect: 2 },
];

describe('the chart-definition JSON Schema', function () {
  const validate = new JarenValidator().compile(schema);

  it('accepts every fixture config', function () {
    for (const config of FIXTURES) {
      assert.equal(validate(config), true,
        `schema rejected ${JSON.stringify(config)}`);
    }
  });

  it('rejects an unknown type and malformed slices', function () {
    assert.equal(validate({ type: 'sparkline' }), false);
    assert.equal(validate({}), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a' }] }), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a', value: -1 }] }), false);
  });

  it('rejects malformed new-type documents', function () {
    // a numeric donut must be a fraction strictly inside (0, 1)
    assert.equal(validate({ type: 'pie', donut: 1.5, slices: [] }), false);
    assert.equal(validate({ type: 'radar', max: 0 }), false);
    assert.equal(validate({ type: 'gauge', value: 'high' }), false);
    // a box needs raw values or the full five-number summary
    assert.equal(validate({ type: 'boxplot', boxes: [{ label: 'x' }] }), false);
    assert.equal(validate({ type: 'boxplot', boxes: [{ label: 'x', min: 1, q1: 2 }] }), false);
    assert.equal(validate({ type: 'heatmap', values: [[1], 'row'] }), false);
    assert.equal(validate({ type: 'treemap', items: [{ label: 'a', value: 0 }] }), false);
    assert.equal(validate({ type: 'streamgraph', xs: ['monday'] }), false);
    assert.equal(validate({ type: 'sankey', links: [{ source: 'a', target: 'b' }] }), false);
    assert.equal(validate({ type: 'sankey', links: [{ source: 'a', target: 'b', value: 0 }] }), false);
    // a marker needs a position, and the position has to be on the planet
    assert.equal(validate({ type: 'map', points: [{ label: 'nowhere' }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [4.9] }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [4.9, 91] }] }), false);
    assert.equal(validate({ type: 'map', points: [{ at: [181, 52] }] }), false);
    assert.equal(validate({ type: 'map', simplify: -1 }), false);
  });
});
