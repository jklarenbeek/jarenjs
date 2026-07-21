//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { compileChart } from '@jarenjs/charts';
import { createStreamReader, createJsonxStreamReader } from '@jarenjs/josl';

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
