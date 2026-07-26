//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { compileChart } from '@jarenjs/charts';
import { createStreamReader, createJsonxStreamReader } from '@jarenjs/josl';
import { applyJSONPatch } from '@jarenjs/json/patch';

const LINE_SPEC = {
  recordPath: ['run'],
  xField: 'i',
  yField: 'ops',
  seriesField: 'suite',
  maxPoints: 100,
};

const RECORDS = [
  { i: 1, suite: 'a', ops: 10 },
  { i: 2, suite: 'a', ops: 12 },
  { i: 1, suite: 'b', ops: 30 },
  { i: 2, suite: 'b', ops: 28 },
];

const JSON_DOC = JSON.stringify({ type: 'line', run: RECORDS });
const JOSL_DOC = [
  'type = "line"',
  '',
  ...RECORDS.flatMap((r) => [
    '[[run]]',
    `i = ${r.i}`,
    `suite = "${r.suite}"`,
    `ops = ${r.ops}`,
    '',
  ]),
].join('\n');

const EXPECTED = {
  series: [
    { name: 'a', points: [{ x: 1, y: 10 }, { x: 2, y: 12 }] },
    { name: 'b', points: [{ x: 1, y: 30 }, { x: 2, y: 28 }] },
  ],
};

function throughJson(doc, spec = LINE_SPEC, type = 'line') {
  const adapter = createStreamAdapter(type, spec);
  const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
  reader.feed(doc);
  reader.end();
  adapter.endDocument();
  return adapter;
}

function throughJosl(doc, spec = LINE_SPEC, type = 'line') {
  const adapter = createStreamAdapter(type, spec);
  const reader = createStreamReader({ onEvent: adapter.onEvent });
  reader.feed(doc);
  reader.end();
  adapter.endDocument();
  return adapter;
}

describe('stream adapter — path boundary', function () {
  it('assembles records from JSON reader events', function () {
    assert.deepEqual(throughJson(JSON_DOC).getData(), EXPECTED);
  });

  it('assembles the same data from JOSL reader events (source-agnostic)', function () {
    assert.deepEqual(throughJosl(JOSL_DOC).getData(), EXPECTED);
  });

  it('both syntaxes produce byte-identical chart SVG', function () {
    const config = { type: 'line', title: 'Same' };
    const a = compileChart(config, throughJson(JSON_DOC).getData()).toSvgString();
    const b = compileChart(config, throughJosl(JOSL_DOC).getData()).toSvgString();
    assert.equal(a, b);
  });

  it('chunk splits at every boundary match the full-parse transform', function () {
    for (const [doc, make] of [[JSON_DOC, createJsonxStreamReader], [JOSL_DOC, createStreamReader]]) {
      const readerOptions = make === createJsonxStreamReader ? { mode: 'json' } : {};
      for (let split = 1; split < doc.length; split += 7) {
        const adapter = createStreamAdapter('line', LINE_SPEC);
        const reader = make({ ...readerOptions, onEvent: adapter.onEvent });
        reader.feed(doc.slice(0, split));
        reader.feed(doc.slice(split));
        reader.end();
        adapter.endDocument();
        assert.deepEqual(adapter.getData(), EXPECTED, `split ${split}`);
      }
    }
  });

  it('excludes records missing x or y', function () {
    const doc = JSON.stringify({
      run: [{ i: 1, suite: 'a', ops: 10 }, { suite: 'a', ops: 99 }, { i: 3, suite: 'a' }],
    });
    const data = throughJson(doc).getData();
    assert.deepEqual(data.series[0].points, [{ x: 1, y: 10 }]);
  });

  it('ignores nested containers inside a record', function () {
    const doc = JSON.stringify({
      run: [{ i: 1, suite: 'a', ops: 10, meta: { i: 999, deep: [1, 2] } }],
    });
    const data = throughJson(doc).getData();
    assert.deepEqual(data.series[0].points, [{ x: 1, y: 10 }]);
  });

  it('evicts beyond maxPoints with a moving window', function () {
    const spec = { ...LINE_SPEC, seriesField: undefined, maxPoints: 5 };
    const adapter = createStreamAdapter('line', spec);
    const records = Array.from({ length: 20 }, (_, i) => ({ i, ops: i * 10 }));
    const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
    reader.feed(JSON.stringify({ run: records }));
    reader.end();
    adapter.endDocument();
    const points = adapter.getData().series[0].points;
    assert.equal(points.length, 5);
    assert.deepEqual(points[0], { x: 15, y: 150 });
    assert.deepEqual(points[4], { x: 19, y: 190 });
  });

  it('reset() clears everything', function () {
    const adapter = throughJson(JSON_DOC);
    adapter.reset();
    assert.deepEqual(adapter.getData(), { series: [] });
  });

  it('getData() returns a fresh object per call (identity-keyed memos)', function () {
    const adapter = throughJson(JSON_DOC);
    assert.notEqual(adapter.getData(), adapter.getData());
  });

  it('rejects unknown chart types at construction', function () {
    assert.throws(() => createStreamAdapter('pie', {}), TypeError);
  });
});

describe('stream adapter — document boundary', function () {
  it('each completed document is one record (the WebSocket shape)', function () {
    const spec = { recordBoundary: 'document', xField: 'E', yField: 'c', seriesField: 's', maxPoints: 10 };
    const adapter = createStreamAdapter('line', spec);
    const messages = [
      { s: 'BTC', E: 1000, c: '100.5' },
      { s: 'BTC', E: 2000, c: '101.0' },
      { s: 'ETH', E: 2000, c: '20.25' },
    ];
    for (const message of messages) {
      const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
      reader.feed(JSON.stringify(message));
      reader.end();
      adapter.endDocument();
    }
    assert.deepEqual(adapter.getData(), {
      series: [
        { name: 'BTC', points: [{ x: 1000, y: 100.5 }, { x: 2000, y: 101 }] },
        { name: 'ETH', points: [{ x: 2000, y: 20.25 }] },
      ],
    });
  });

  it('a malformed document contributes nothing after reset-per-message handling', function () {
    const spec = { recordBoundary: 'document', xField: 'E', yField: 'c', maxPoints: 10 };
    const adapter = createStreamAdapter('line', spec);
    const good = () => {
      const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
      reader.feed('{"E": 1, "c": 5}');
      reader.end();
      adapter.endDocument();
    };
    good();
    assert.throws(() => {
      const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
      reader.feed('{"E": 2, "c": '); // truncated message
      reader.end();
    });
    adapter.endDocument(); // the boundary flushes the partial — x without y drops it
    good();
    const points = adapter.getData().series[0].points;
    assert.deepEqual(points.map((p) => p.x), [1, 1]);
  });
});

describe('stream adapter — bar counts', function () {
  it('counts categories live', function () {
    const spec = { recordPath: ['run'], xField: 'bucket' };
    const doc = JSON.stringify({ run: [
      { bucket: 'win' }, { bucket: 'win' }, { bucket: 'loss' }, { bucket: 'win' },
    ] });
    const adapter = throughJson(doc, spec, 'bar');
    assert.deepEqual(adapter.getData(), {
      categories: ['win', 'loss'],
      series: [{ name: 'count', values: [3, 1] }],
    });
  });

  it('sums a value field when yField is set', function () {
    const spec = { recordPath: ['run'], xField: 'suite', yField: 'ms' };
    const doc = JSON.stringify({ run: [
      { suite: 'a', ms: 2 }, { suite: 'b', ms: 5 }, { suite: 'a', ms: 3 },
    ] });
    const adapter = throughJson(doc, spec, 'bar');
    assert.deepEqual(adapter.getData(), {
      categories: ['a', 'b'],
      series: [{ name: 'ms', values: [5, 5] }],
    });
  });
});

describe('stream adapter — heatmap matrix', function () {
  const SPEC = { recordPath: ['run'], xField: 'size', seriesField: 'scenario' };

  it('counts records under two grouping keys, rows and columns in arrival order', function () {
    const doc = JSON.stringify({ run: [
      { size: '4', scenario: 'singular' },
      { size: '100', scenario: 'singular' },
      { size: '4', scenario: 'join' },
      { size: '4', scenario: 'singular' },
    ] });
    assert.deepEqual(throughJson(doc, SPEC, 'heatmap').getData(), {
      xLabels: ['4', '100'],
      yLabels: ['singular', 'join'],
      values: [[2, 1], [1, null]], // the join×100 cell was never measured
    });
  });

  it('sums a value field when yField is set', function () {
    const doc = JSON.stringify({ run: [
      { size: 'a', scenario: 'r', ms: 2 },
      { size: 'a', scenario: 'r', ms: 3 },
    ] });
    assert.deepEqual(throughJson(doc, { ...SPEC, yField: 'ms' }, 'heatmap').getData().values, [[5]]);
  });

  it('an unmeasured cell renders as the surface, not as a zero', function () {
    const doc = JSON.stringify({ run: [{ size: 'a', scenario: 'r' }, { size: 'b', scenario: 's' }] });
    const svg = compileChart({ type: 'heatmap' }, throughJson(doc, SPEC, 'heatmap').getData()).toSvgString();
    assert.equal((svg.match(/chart-heat-cell/g) ?? []).length, 2);
    assert.ok(!svg.includes('NaN'));
  });
});

describe('stream adapter — gauge reading', function () {
  const SPEC = { recordPath: ['run'], yField: 'temp' };

  it('keeps the latest reading and nothing else', function () {
    const doc = JSON.stringify({ run: [{ temp: 20 }, { temp: 21.5 }, { temp: '22.5' }] });
    assert.deepEqual(throughJson(doc, SPEC, 'gauge').getData(), { value: 22.5 });
  });

  it('a missing or unparsable reading leaves the last one standing', function () {
    const doc = JSON.stringify({ run: [{ temp: 20 }, { other: 1 }, { temp: 'warm' }] });
    assert.deepEqual(throughJson(doc, SPEC, 'gauge').getData(), { value: 20 });
  });

  it('no reading yet is null, not zero', function () {
    const adapter = createStreamAdapter('gauge', SPEC);
    assert.deepEqual(adapter.getData(), { value: null });
    assert.equal(compileChart({ type: 'gauge' }, adapter.getData()).ast.frac, 0);
  });
});

describe('stream adapter — change reporting (takeChanges)', function () {
  /** Feed one JSON document per message (document boundary). */
  function feedDoc(adapter, message) {
    const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
    reader.feed(JSON.stringify(message));
    reader.end();
    adapter.endDocument();
  }

  /** The replay contract: prev + takeChanges() batch === next getData(). */
  function assertReplay(adapter, feed) {
    let prev = adapter.getData();
    for (const step of feed) {
      step();
      const batch = adapter.takeChanges();
      prev = applyJSONPatch(prev, batch);
      assert.deepEqual(prev, adapter.getData());
    }
  }

  it('line: appends, new series and eviction replay to the snapshot', function () {
    const adapter = createStreamAdapter('line', {
      recordBoundary: 'document', xField: 'i', yField: 'ops',
      seriesField: 'suite', maxPoints: 3, changes: true,
    });
    const messages = [
      { i: 1, suite: 'a', ops: 10 },
      { i: 2, suite: 'a', ops: 12 },
      { i: 1, suite: 'b', ops: 30 },
      { i: 3, suite: 'a', ops: 14 },
      { i: 4, suite: 'a', ops: 16 }, // evicts a's head (maxPoints 3)
      { i: 5, suite: 'a', ops: 18 },
    ];
    assertReplay(adapter, messages.map((m) => () => feedDoc(adapter, m)));
    assert.equal(adapter.getData().series[0].points.length, 3);
  });

  it('bar: new categories and count updates replay to the snapshot', function () {
    const adapter = createStreamAdapter('bar', {
      recordBoundary: 'document', xField: 'bucket', changes: true,
    });
    assertReplay(adapter, [
      () => feedDoc(adapter, { bucket: 'win' }),
      () => feedDoc(adapter, { bucket: 'loss' }),
      () => feedDoc(adapter, { bucket: 'win' }),
    ]);
    assert.deepEqual(adapter.getData().series[0].values, [2, 1]);
  });

  it('heatmap: new rows, new columns and cell updates replay to the snapshot', function () {
    const adapter = createStreamAdapter('heatmap', {
      recordBoundary: 'document', xField: 'size', seriesField: 'scenario', changes: true,
    });
    assertReplay(adapter, [
      () => feedDoc(adapter, { size: '4', scenario: 'singular' }),
      () => feedDoc(adapter, { size: '100', scenario: 'singular' }), // widens the row
      () => feedDoc(adapter, { size: '4', scenario: 'join' }), // a whole new row
      () => feedDoc(adapter, { size: '4', scenario: 'singular' }), // one cell
    ]);
    assert.deepEqual(adapter.getData().values, [[2, 1], [1, null]]);
  });

  it('gauge: every reading replays as one replace', function () {
    const adapter = createStreamAdapter('gauge', {
      recordBoundary: 'document', yField: 'temp', changes: true,
    });
    assertReplay(adapter, [
      () => feedDoc(adapter, { temp: 20 }),
      () => feedDoc(adapter, { temp: 21 }),
      () => feedDoc(adapter, { other: 9 }), // no reading, no op
    ]);
    assert.deepEqual(adapter.takeChanges(), []);
    assert.deepEqual(adapter.getData(), { value: 21 });
  });

  it('candlestick: add, keyed upsert and eviction replay to the snapshot', function () {
    const adapter = createStreamAdapter('candlestick', {
      recordBoundary: 'document', xField: 't', maxPoints: 3, changes: true,
    });
    const k = (t, close) => ({ t, open: 100, high: 110, low: 95, close });
    assertReplay(adapter, [
      () => feedDoc(adapter, k(1000, 101)),
      () => feedDoc(adapter, k(1000, 102)), // upsert, replaces in place
      () => feedDoc(adapter, k(2000, 103)),
      () => feedDoc(adapter, k(3000, 104)),
      () => feedDoc(adapter, k(4000, 105)), // evicts t=1000
      () => feedDoc(adapter, k(2000, 106)), // upsert at shifted position
    ]);
    assert.deepEqual(adapter.getData().candles.map((c) => c.t), [2000, 3000, 4000]);
    assert.equal(adapter.getData().candles[0].close, 106);
  });

  it('an upsert op replaces at the candle\'s stable snapshot position', function () {
    const adapter = createStreamAdapter('candlestick', {
      recordBoundary: 'document', xField: 't', changes: true,
    });
    const k = (t, close) => ({ t, open: 1, high: 2, low: 0.5, close });
    feedDoc(adapter, k(1000, 1));
    feedDoc(adapter, k(2000, 1));
    adapter.takeChanges();
    feedDoc(adapter, k(1000, 1.5)); // not the newest — position 0
    const batch = adapter.takeChanges();
    assert.equal(batch.length, 1);
    assert.equal(batch[0].op, 'replace');
    assert.equal(batch[0].path, '/candles/0');
  });

  it('takeChanges() drains: a second call returns [], no events means []', function () {
    const adapter = createStreamAdapter('line', {
      recordBoundary: 'document', xField: 'i', yField: 'v', changes: true,
    });
    assert.deepEqual(adapter.takeChanges(), []);
    feedDoc(adapter, { i: 1, v: 2 });
    assert.ok(adapter.takeChanges().length > 0);
    assert.deepEqual(adapter.takeChanges(), []);
  });

  it('reset() buffers one whole-document replace that supersedes prior ops', function () {
    const adapter = createStreamAdapter('line', {
      recordBoundary: 'document', xField: 'i', yField: 'v', changes: true,
    });
    const before = adapter.getData();
    feedDoc(adapter, { i: 1, v: 2 }); // never collected
    adapter.reset();
    const batch = adapter.takeChanges();
    assert.equal(batch.length, 1);
    assert.deepEqual(batch[0], { op: 'replace', path: '', value: { series: [] } });
    assert.deepEqual(applyJSONPatch(before, batch), adapter.getData());
  });

  it('an aborted document contributes no ops', function () {
    const adapter = createStreamAdapter('line', {
      recordBoundary: 'document', xField: 'i', yField: 'v', changes: true,
    });
    const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
    reader.feed('{"i": 9, "v": ');
    adapter.abortDocument();
    assert.deepEqual(adapter.takeChanges(), []);
  });

  it('without { changes: true } takeChanges() throws and nothing buffers', function () {
    const adapter = createStreamAdapter('line', {
      recordBoundary: 'document', xField: 'i', yField: 'v',
    });
    feedDoc(adapter, { i: 1, v: 2 });
    assert.throws(() => adapter.takeChanges(), /changes: true/);
  });
});
