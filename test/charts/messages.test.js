//@ts-check
/**
 * @file The charts engine speaks the reader's language: the one word it
 * adds to a definition — the mark of a series that reads the right axis,
 * in its legend entry and its hover text — renders through the host's
 * compiled catalog (`messages`) on every path that draws it (a compile,
 * the component, and an incremental session that redraws an evicted
 * series), and without a catalog it is the English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { compileChart, createChartSession, chartsMessagesEn, chartsText } from '@jarenjs/charts';
import { createChartComponent } from '@jarenjs/charts/component';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { createJsonxStreamReader } from '@jarenjs/josl';
import { renderToString } from '@jarenjs/view';
import { chartRenderer } from '../../packages/website/src/boundaries/charts.js';

const IDS = Object.keys(chartsMessagesEn);
const reached = new Set();
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, (/** @type {any} */ p) => { reached.add(id); return `${p.name} ⟦${id}⟧`; }])));

const config = { type: 'line', y2: { series: ['eth'], label: 'eth' } };
const data = { series: [{ name: 'btc', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }, { name: 'eth', points: [{ x: 0, y: 5 }, { x: 1, y: 3 }] }] };

/** A session over a stream that evicts, and the frames it draws. */
function frames(/** @type {any} */ messages) {
  const adapter = createStreamAdapter('line', { recordBoundary: 'document', xField: 'x', yField: 'y', seriesField: 's', changes: true, maxPoints: 3 });
  const session = createChartSession(config, adapter, { messages });
  const out = [];
  for (const batch of [[{ x: 0, s: 'btc', y: 81600 }, { x: 1, s: 'btc', y: 81700 }, { x: 0, s: 'eth', y: 2510 }, { x: 0, s: 'eth', y: 2500 }, { x: 1, s: 'eth', y: 2520 }],
    [{ x: 1, s: 'eth', y: 2505 }]]) {
    for (const m of batch) {
      const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
      reader.feed(JSON.stringify(m)); reader.end(); adapter.endDocument();
    }
    const result = session.tick();
    const svg = renderToString(result.vnode);
    assert.equal(svg, renderToString(compileChart(config, adapter.getData(), { messages }).toVnode()), `${result.mode} frame diverged`);
    out.push({ mode: result.mode, svg });
  }
  return out;
}

describe('charts messages', () => {
  it('renders the right-axis mark through the catalog on every path', () => {
    const svgs = [
      compileChart(config, data, { messages: PSEUDO }).toSvgString(),
      renderToString(createChartComponent({ messages: PSEUDO }).view(config, data)),
      ...frames(PSEUDO).map((f) => f.svg),
    ];
    // the site's play renderer hands the run's catalog on
    svgs.push(renderToString(chartRenderer(JSON.stringify({ ...config, ...data }), { format: 'json' }, { messages: PSEUDO }).vnode));
    for (const svg of svgs) {
      assert.ok(!svg.includes('(right axis)'), 'no English mark');
      assert.match(svg, /<title>eth ⟦charts\/series\/right-axis⟧<\/title>/);
      assert.match(svg, /class="chart-tick">eth ⟦charts\/series\/right-axis⟧</);
    }
    assert.deepEqual(frames(PSEUDO).map((f) => f.mode), ['rebuilt', 'incremental'], 'the session redraws an evicted series');
    assert.deepEqual(IDS.filter((id) => !reached.has(id)), []);
  });

  it('keeps the English without a catalog', () => {
    for (const svg of [compileChart(config, data).toSvgString(), ...frames(undefined).map((f) => f.svg)]) {
      assert.match(svg, /<title>eth \(right axis\)<\/title>/);
      assert.match(svg, /class="chart-tick">eth \(right axis\)</);
    }
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    const id = 'charts/series/right-axis';
    assert.equal(chartsText(compileMessageCatalog({ [id]: () => { throw new Error('x'); } }))(id, { name: 'a' }), 'a (right axis)');
    assert.equal(chartsText(/** @type {any} */ ({ [id]: () => 1 }))(id, { name: 'a' }), 'a (right axis)');
    assert.equal(chartsText()('charts/unknown'), 'charts/unknown');
  });

  it('uses every id of its catalog in the source', () => {
    const source = readFileSync(new URL('../../components/charts/src/types/line.js', import.meta.url), 'utf8');
    for (const id of IDS) assert.ok(source.includes(`'${id}'`), `${id} is used`);
  });
});
