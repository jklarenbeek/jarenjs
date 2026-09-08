//@ts-check
/** All chart kinds: exact authored JSON, public grammar, rendering and generated surface drift. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '@jarenjs/linq/charts';
import { compileChart, chartTypes } from '@jarenjs/charts';
import { JarenValidator } from '@jarenjs/validate';
import { chartPenArtifacts } from '../../scripts/generate-chart-pen.js';
import { CHART_FIELDS } from '../../packages/linq/src/charts/vocabulary.js';

const schema = JSON.parse(readFileSync(new URL('../../components/charts/schemas/chart-definition.schema.json', import.meta.url), 'utf8'));
const validate = new JarenValidator().compile(schema);
const CORPUS = [
  { type: 'pie', donut: true, slices: [{ label: 'A', value: 2 }] },
  { type: 'bar', stacked: true, log: false, orient: 'h', catLabel: 'Group', valLabel: 'Value', categories: ['a'], series: [{ name: 'S', values: [2], tone: 'win', tones: ['win'] }] },
  { type: 'line', x: 'time', log: false, markers: true, xLabel: 'Time', yLabel: 'Value', domain: { y: 'step' }, sampling: false, dateNames: {}, timeFormats: { day: 'yyyy-MM-dd' }, series: [{ name: 'S', points: [{ x: 0, y: 1 }, { x: 86400000, y: 2 }] }] },
  { type: 'scatter', xLog: false, yLog: false, refY: 2, refLabel: 'Target', xLabel: 'X', yLabel: 'Y', points: [{ x: 1, y: 2, tone: 'loss' }] },
  { type: 'candlestick', xLabel: 'Time', yLabel: 'Price', domain: { y: { min: 0, max: 10 } }, dateNames: {}, timeFormats: { day: 'yyyy-MM-dd' }, candles: [{ t: 0, open: 2, high: 4, low: 1, close: 3 }] },
  { type: 'radar', max: 10, axes: ['a', 'b', 'c'], series: [{ name: 'S', values: [1, 2, 3] }] },
  { type: 'gauge', value: 87, min: 0, max: 100, unit: '%', tone: 'win' },
  { type: 'boxplot', catLabel: 'Group', valLabel: 'Value', boxes: [{ label: 'A', min: 1, q1: 2, med: 3, q3: 4, max: 5, outliers: [8] }] },
  { type: 'heatmap', log: true, xLabel: 'X', yLabel: 'Y', xLabels: ['a'], yLabels: ['b'], values: [[1]] },
  { type: 'treemap', aspect: 1.6, items: [{ label: 'A', children: [{ label: 'B', value: 2 }] }] },
  { type: 'streamgraph', xLabel: 'Time', xs: [0, 1], series: [{ name: 'S', values: [1, 2] }] },
  { type: 'sankey', nodes: ['a', { name: 'b' }], links: [{ source: 'a', target: 1, value: 2 }] },
  { type: 'map', value: 'pop', label: 'name', log: false, aspect: 2, simplify: false, features: [], points: [{ at: [4.9, 52.37], label: 'Amsterdam', value: 2 }] },
].map((doc) => ({ ...doc, title: 'Example', stream: { recordPath: ['rows'], recordBoundary: 'path', xField: 't', yField: 'value', seriesField: 'name', maxPoints: 10 } }));

describe('chart pen', () => {
  it('counts every grammar kind, engine kind and per-kind member in the emitted corpus', () => {
    assert.equal(CORPUS.length, 13);
    assert.deepEqual(CORPUS.map((d) => d.type).sort(), [...schema.properties.type.enum].sort());
    assert.deepEqual(chartTypes().sort(), [...schema.properties.type.enum].sort());
    for (const doc of CORPUS) {
      const fields = Object.keys(doc).filter((k) => k !== 'type').sort();
      assert.deepEqual(fields, [...CHART_FIELDS[doc.type]].sort());
    }
  });
  it('derives types and known members from the target schema with emit', () => {
    const artifacts = chartPenArtifacts();
    assert.equal(readFileSync(new URL('../../packages/linq/types/charts.d.ts', import.meta.url), 'utf8'), artifacts.declarations);
    assert.equal(readFileSync(new URL('../../packages/linq/src/charts/vocabulary.js', import.meta.url), 'utf8'), artifacts.vocabulary);
  });
  for (const hand of CORPUS) {
    it(`${hand.type}: fluent byte equality, grammar and SVG equality`, () => {
      const original = c[hand.type]();
      let built = original;
      for (const [key, value] of Object.entries(hand)) if (key !== 'type') built = built[key](value);
      assert.equal(JSON.stringify(built), JSON.stringify(hand));
      assert.deepEqual(original.schema, { type: hand.type });
      assert.equal(validate(built.schema), true);
      const compiled = compileChart(built.schema);
      assert.deepEqual(compiled.ast, compileChart(hand).ast);
      assert.equal(compiled.toSvgString(), compileChart(hand).toSvgString());
      assert.match(compiled.toSvgString(), /<svg/);
      assert.equal(validate(built.title(42).schema), false);
      assert.equal(built.title('Replacement').schema.title, 'Replacement');
      assert.equal(built.schema.title, 'Example');
      assert.ok(Object.isFrozen(built.schema.stream.recordPath));
    });
  }
  it('snapshots nested data and keeps JSON extensions at the explicit raw boundary', () => {
    const slices = [{ label: 'A', value: 1 }];
    const built = c.pie({ slices });
    slices[0].value = 2;
    assert.equal(built.schema.slices[0].value, 1);
    assert.equal(Object.isFrozen(slices[0]), false);
    const hand = { type: 'pie', ['__proto__']: { custom: true } };
    assert.deepEqual(c.from(hand).schema, hand);
    assert.throws(() => c.pie({ custom: true }), { code: 'JL0101' });
    assert.throws(() => c.bar().slices([]), { code: 'JL0101' });
    assert.throws(() => c.pie(null), { code: 'JL0101' });
    assert.throws(() => c.pie({ __proto__: { title: 'lost' } }), { code: 'JL0101' });
    assert.throws(() => c.pie().title(() => 'x'), { code: 'JL0101' });
    assert.throws(() => c.from({ type: 'unknown' }).options({}), { code: 'JL0101' });
  });
});
