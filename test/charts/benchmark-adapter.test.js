//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  ratioDistributionBars, ratioScatter, conformanceBars,
  profileBars, matrixBars, passCountBars, querySpreadBars, resultTableBars,
} from '@jarenjs/charts/transforms/benchmark-adapter';
import { compileChart } from '@jarenjs/charts';

// Vendored slices of the real published benchmark data
// (packages/website/public/benchmarks/*.json, run of 2026-07-20).

const VALIDATE_RESULTS = [
  { suite: '/type.json', draft: 'draft7', description: 'integer type matches integers', isSuccessTest: true, jarenTime: 0.011, ajvTime: 0.245, ratio: 22.2 },
  { suite: '/type.json', draft: 'draft7', description: 'string type matches strings', isSuccessTest: true, jarenTime: 0.02, ajvTime: 0.06, ratio: 3.0 },
  { suite: '/format.json', draft: 'draft2020-12', description: 'email format', isSuccessTest: true, jarenTime: 0.05, ajvTime: 0.06, ratio: 1.2 },
  { suite: '/ref.json', draft: 'draft2019-09', description: 'remote ref', isSuccessTest: true, jarenTime: 0.09, ajvTime: 0.07, ratio: 0.78 },
  { suite: '/big.json', draft: 'draft7', description: 'huge allOf', isSuccessTest: true, jarenTime: 0.4, ajvTime: 0.1, ratio: 0.25 },
  { suite: '/opt.json', draft: 'draft7', description: 'not-success', isSuccessTest: false, jarenTime: 0.1, ajvTime: 0.1, ratio: 1 },
  { suite: '/null.json', draft: 'draft7', description: 'no ratio', isSuccessTest: true, jarenTime: 0.1, ajvTime: 0, ratio: null },
];

const BUCKETS = [
  { label: '> 10× faster', test: (r) => r > 10, tone: 'win' },
  { label: '2–10× faster', test: (r) => r > 2, tone: 'win' },
  { label: '1–2× faster', test: (r) => r >= 1, tone: 'win' },
  { label: '1–2× slower', test: (r) => r >= 0.5, tone: 'loss' },
  { label: '> 2× slower', test: (r) => r < 0.5, tone: 'loss' },
];

const ENGINE_STATS = {
  jaren: {
    draft7: { passed: 1120, failed: 0, errors: 0 },
    'draft2019-09': { passed: 1180, failed: 0, errors: 0 },
    'draft2020-12': { passed: 1230, failed: 0, errors: 0 },
  },
  ajv: {
    draft7: { passed: 1090, failed: 24, errors: 6 },
    'draft2019-09': { passed: 1150, failed: 20, errors: 10 },
    'draft2020-12': { passed: 1201, failed: 19, errors: 10 },
  },
};

const JSONPATH_ROWS = [
  { name: 'basic, root', selector: '$', engines: { jaren: 94.46, 'json-p3': 706.2 } },
  { name: 'filter, exists', selector: '$[?@.a]', engines: { jaren: 1200, 'json-p3': 9800 } },
  { name: 'slice', selector: '$[1:3]', engines: { jaren: 300, 'json-p3': 600 } },
  { name: 'broken', selector: '$x', engines: { jaren: 0, 'json-p3': 100 } },
];

const MATRIX_ROWS = [
  { scenario: 'singular', title: 'singular access', document: 'bookstore', engines: { jaren: 478, fontoxpath: 11580, jsonata: 8387 } },
  { scenario: 'join', title: 'join', document: 'bookstore', engines: { jaren: 1200, fontoxpath: 40000, jsonata: 22000 } },
];

const TOML_COMPLIANCE = {
  jaren: { pass: 694, total: 694 },
  'smol-toml': { pass: 672, total: 694 },
  '@iarna/toml': { pass: 648, total: 694 },
  toml: { pass: 684, total: 694 },
};

const PROFILE_ROWS = [
  { name: 'records-1k (~90KB)', results: { jaren: 10.65, 'smol-toml': 5.629, '@iarna/toml': 12.06, toml: 38.38 } },
  { name: 'deep-nesting', results: { jaren: 2.1, 'smol-toml': 1.9, '@iarna/toml': 4.4, toml: 12.2 } },
];

const PATCH_TABLE = {
  key: 'patch',
  title: 'JSON Patch (RFC 6902) apply',
  columns: ['jaren compiled', 'jaren mutate', 'jaren one-shot', 'naive'],
  rows: [
    { name: 'small update (4 ops, small doc)', ops: 4, results: [697, 701.4, 1520, 2400] },
    { name: 'medium (12 ops)', ops: 12, results: [2100, 2200, 4900, 9100] },
  ],
};

/** Every adapter output must compile without throwing. */
function compiles(pair) {
  const compiled = compileChart(pair.config, pair.data);
  assert.equal(compiled.toSvgString().startsWith('<svg'), true);
  return compiled;
}

describe('benchmark adapters', function () {
  it('ratioDistributionBars buckets success-only ratios with tones', function () {
    const pair = ratioDistributionBars(
      VALIDATE_RESULTS.filter((r) => r.ratio !== null && r.isSuccessTest),
      BUCKETS, 'Ratio distribution');
    assert.deepEqual(pair.data.series[0].values, [1, 1, 1, 1, 1]);
    assert.deepEqual(pair.data.series[0].tones, ['win', 'win', 'win', 'loss', 'loss']);
    assert.equal(pair.config.orient, 'h');
    compiles(pair);
  });

  it('ratioScatter ranks fastest first with parity reference', function () {
    const pair = ratioScatter(
      VALIDATE_RESULTS.filter((r) => r.ratio !== null && r.isSuccessTest), 'Cloud');
    assert.equal(pair.data.points.length, 5);
    assert.equal(pair.data.points[0].y, 22.2);
    assert.equal(pair.data.points[0].tone, 'win');
    assert.equal(pair.data.points[4].y, 0.25);
    assert.equal(pair.data.points[4].tone, 'loss');
    assert.equal(pair.config.refY, 1);
    assert.equal(pair.config.yLog, true);
    compiles(pair);
  });

  it('conformanceBars turns engineStats into grouped passed counts', function () {
    const pair = conformanceBars(ENGINE_STATS, 'Conformance');
    assert.deepEqual(pair.data.categories, ['draft7', 'draft2019-09', 'draft2020-12']);
    assert.deepEqual(pair.data.series.map((s) => s.name), ['jaren', 'ajv']);
    assert.deepEqual(pair.data.series[0].values, [1120, 1180, 1230]);
    compiles(pair);
  });

  it('querySpreadBars ranks by spread, drops broken rows, keeps top-N', function () {
    const pair = querySpreadBars(JSONPATH_ROWS, 'json-p3', 2, 'Spreads');
    assert.deepEqual(pair.data.categories, ['filter, exists', 'basic, root']);
    assert.deepEqual(pair.data.series[0].values, [1200, 94.46]);
    assert.equal(pair.config.log, true);
    assert.equal(pair.config.orient, 'h');
    compiles(pair);
  });

  it('matrixBars unions engine keys with jaren first', function () {
    const pair = matrixBars(MATRIX_ROWS, { title: 'Matrix' });
    assert.deepEqual(pair.data.series.map((s) => s.name), ['jaren', 'fontoxpath', 'jsonata']);
    assert.deepEqual(pair.data.categories, ['singular', 'join']);
    assert.equal(pair.config.log, true);
    compiles(pair);
  });

  it('passCountBars highlights the named engine', function () {
    const pair = passCountBars(TOML_COMPLIANCE, { title: 'toml-test', highlight: 'jaren' });
    assert.deepEqual(pair.data.series[0].values, [694, 672, 648, 684]);
    assert.deepEqual(pair.data.series[0].tones, ['win', null, null, null]);
    compiles(pair);
  });

  it('profileBars maps {name, results} rows onto engine series', function () {
    const pair = profileBars(PROFILE_ROWS, ['jaren', 'smol-toml', '@iarna/toml', 'toml'],
      { title: 'Parse', valLabel: 'ms/op' });
    assert.deepEqual(pair.data.categories, ['records-1k (~90KB)', 'deep-nesting']);
    assert.deepEqual(pair.data.series[3].values, [38.38, 12.2]);
    compiles(pair);
  });

  it('resultTableBars maps a column-per-engine table', function () {
    const pair = resultTableBars(PATCH_TABLE, { log: true });
    assert.equal(pair.config.title, 'JSON Patch (RFC 6902) apply');
    assert.deepEqual(pair.data.series.map((s) => s.name), PATCH_TABLE.columns);
    assert.deepEqual(pair.data.series[0].values, [697, 2100]);
    compiles(pair);
  });
});
