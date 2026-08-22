//@ts-check
/**
 * @file The benchmark generator's honesty rules.
 *
 * `benchmark/website-data.js` assembles the files the website's
 * Benchmarks page reads, and a partial run is its normal mode — the
 * suites are slow and are re-measured a few at a time. Everything here
 * guards the seam that makes partial runs safe: an invocation that
 * cannot be attributed is refused, a sub-run that did not happen carries
 * the previous data forward instead of deleting it, and every published
 * row records the run that measured IT rather than the run that last
 * touched the file.
 *
 * The derivations themselves are guarded too: a figure published in two
 * places is computed by one builder, because the same 456 JSONPath rows
 * were once published as both 23.1x and 8.8x.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { buildHeadlines, carryHeadlines, mergeToml, parseArgs, SUITE_ORDER } from '../../benchmark/website-data.js';
import { geoMeanRatio, ratioSummary } from '../../benchmark/derive.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const bench = (name) => JSON.parse(readFileSync(join(ROOT, 'packages/website/public/benchmarks', `${name}.json`), 'utf8'));

/** Run the generator's argv parser in a child; returns { status, stderr }. */
function invoke(...args) {
  try {
    execFileSync(process.execPath, ['benchmark/website-data.js', ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { status: 0, stderr: '' };
  }
  catch (err) {
    const e = /** @type {any} */ (err);
    return { status: e.status, stderr: String(e.stderr ?? '') };
  }
}

describe('the generator refuses an invocation it could not attribute', () => {
  it('refuses --quick with --skip, in one line', () => {
    const { status, stderr } = invoke('--quick', '--skip', 'validate');
    assert.strictEqual(status, 2);
    assert.strictEqual(stderr.trim().split('\n').length, 1, 'the refusal is one line');
    assert.match(stderr, /--quick cannot be combined with --skip/);
  });

  // Every one of these used to be accepted: `abc` became NaN and reached
  // meta.json as null, `--iterations --quick` ate the next flag, and a
  // bare `--skip` threw a raw TypeError at the reader.
  for (const [label, args] of [
    ['a non-numeric count', ['--iterations', 'abc']],
    ['a bare --iterations', ['--iterations']],
    ['a count that swallowed the next flag', ['--iterations', '--quick']],
    ['a zero count', ['--iterations', '0']],
    ['a bare --skip', ['--skip']],
  ]) {
    it(`refuses ${label} with exit 2`, () => {
      const { status, stderr } = invoke(...args);
      assert.strictEqual(status, 2, `expected exit 2 for ${args.join(' ')}`);
      assert.match(stderr, /needs a (value|positive integer)/);
      assert.doesNotMatch(stderr, /TypeError|Cannot read/, 'the refusal is a message, not a stack');
    });
  }

  it('accepts a well-formed count and skip list', () => {
    const options = parseArgs(['node', 'website-data.js', '--iterations', '25', '--skip', 'validate, jslt']);
    assert.strictEqual(options.iterations, 25);
    assert.deepStrictEqual([...options.skip], ['validate', 'jslt']);
  });
});

describe('a sub-run that did not happen carries forward', () => {
  const toml = { compliance: { jaren: { pass: 694, total: 694 } }, profile: { parse: [] } };
  const previous = { ...toml, stream: { message: [{ label: 'x', ns: 1 }] } };

  it('keeps the previous streaming rows when the sub-run is skipped', () => {
    const merged = mergeToml(toml, null, previous);
    assert.deepStrictEqual(merged.stream, previous.stream,
      'a skipped jsonx-stream must not delete rows the site still renders');
  });

  it('prefers a fresh streaming block over the carried one', () => {
    const fresh = { message: [{ label: 'y', ns: 2 }] };
    assert.deepStrictEqual(mergeToml(toml, fresh, previous).stream, fresh);
  });

  it('writes no stream member when neither run has one', () => {
    assert.ok(!('stream' in mergeToml(toml, null, { ...toml })));
  });

  it('carries nothing when the toml run itself failed', () => {
    assert.strictEqual(mergeToml(null, null, previous), null);
  });
});

describe('every headline row carries the run that measured IT', () => {
  const lastRun = { generated: '2026-09-01T00:00:00.000Z', node: 'v24.19.0', version: '0.40.0', quick: false };
  const fresh = [{ key: 'validate', label: 'JSON Schema', ratio: 2 }];
  const previous = [
    { key: 'validate', label: 'JSON Schema', ratio: 9, generated: '2026-01-01T00:00:00.000Z' },
    { key: 'jsonpath', label: 'JSONPath', ratio: 8.8, generated: '2026-08-02T00:00:00.000Z' },
    { key: 'flow', label: 'Flow', ratio: 5, generated: '2026-08-02T00:00:00.000Z', node: 'v22.22.2', version: '0.30.0', quick: true },
  ];
  const rows = carryHeadlines(fresh, previous, lastRun);
  const at = (key) => rows.find((r) => r.key === key);

  it('stamps this run only on the rows this run measured', () => {
    assert.deepStrictEqual(
      { ...at('validate') },
      { key: 'validate', label: 'JSON Schema', ratio: 2, ...lastRun });
  });

  it('never re-stamps a carried row — that is the lie it exists to stop', () => {
    assert.strictEqual(at('jsonpath').generated, '2026-08-02T00:00:00.000Z');
    assert.strictEqual(at('jsonpath').ratio, 8.8, 'a carried row keeps its own measurement');
  });

  it('publishes unknown provenance as unknown, not as this run', () => {
    const row = at('jsonpath');
    assert.strictEqual(row.node, null);
    assert.strictEqual(row.version, null);
    assert.strictEqual(row.quick, null, 'a carried row must not inherit this run\'s iteration mode');
  });

  it('keeps a carried row\'s own provenance when it has one', () => {
    assert.strictEqual(at('flow').node, 'v22.22.2');
    assert.strictEqual(at('flow').version, '0.30.0');
    assert.strictEqual(at('flow').quick, true);
  });

  it('is idempotent — carrying the same rows twice changes nothing', () => {
    assert.deepStrictEqual(carryHeadlines(fresh, previous, lastRun), rows);
    assert.deepStrictEqual(carryHeadlines([], rows, lastRun), rows);
  });
});

describe('one derivation per figure', () => {
  const rows = bench('jsonpath').profile.rows;

  it('summarizes the ratio and the two timings over ONE row set', () => {
    const s = ratioSummary(rows, 'jaren', 'json-p3');
    assert.strictEqual(s.rows, rows.length);
    // the published pair cannot disagree: the ratio IS rival/mine
    assert.ok(Math.abs(s.ratio - s.rival / s.mine) < 1e-9);
  });

  it('is the geometric mean, not the ratio of arithmetic means', () => {
    const mean = (engine) => rows.reduce((a, r) => a + r.engines[engine], 0) / rows.length;
    const arithmetic = mean('json-p3') / mean('jaren');
    const geometric = geoMeanRatio(rows, 'jaren', 'json-p3');
    assert.ok(geometric < arithmetic / 2,
      'the arithmetic ratio is dominated by the slowest rows — 23.1x against 8.8x here');
  });

  it('is the figure the published overview row carries', () => {
    const headline = bench('meta').headlines.find((h) => h.key === 'jsonpath');
    assert.ok(Math.abs(headline.ratio - geoMeanRatio(rows, 'jaren', 'json-p3')) < 1e-9,
      'the site headline and the docs figure are one derivation');
  });

  it('answers null rather than a number when no row is comparable', () => {
    assert.strictEqual(geoMeanRatio([], 'jaren', 'json-p3'), null);
    assert.strictEqual(geoMeanRatio([{ engines: { jaren: 0, 'json-p3': 5 } }], 'jaren', 'json-p3'), null);
  });
});

describe('the published meta.json describes its measurements honestly', () => {
  const meta = bench('meta');

  it('summarizes every published suite', () => {
    assert.strictEqual(meta.headlines.length, SUITE_ORDER.length);
    assert.deepStrictEqual(meta.headlines.map((h) => h.key), [...SUITE_ORDER]);
  });

  it('describes the last invocation as the last invocation', () => {
    assert.ok(meta.lastRun !== undefined, 'meta.json records the run that wrote it');
    for (const field of ['generated', 'node', 'cpu', 'platform', 'version', 'quick']) {
      assert.ok(field in meta.lastRun, `lastRun records ${field}`);
      assert.ok(!(field in meta), `no top-level '${field}' may describe the measurement set`);
    }
  });

  it('gives every row its own provenance', () => {
    for (const h of meta.headlines) {
      for (const field of ['generated', 'node', 'version', 'quick']) {
        assert.ok(field in h, `the ${h.key} row records ${field}`);
      }
      assert.ok(h.generated === null || /^\d{4}-\d{2}-\d{2}T/.test(h.generated),
        `the ${h.key} row's date is a stamp or an honest null`);
    }
  });

  // The two-run check, in the form that survives a measurement: the
  // derivation is deterministic, so re-deriving every published row from
  // the file the site serves must reproduce it exactly. Only the
  // provenance differs — it records WHEN a row was measured, which is the
  // one thing a re-derivation cannot invent.
  it('re-derives every published row from its committed file, byte for byte', () => {
    for (const key of SUITE_ORDER) {
      const rows = buildHeadlines({ [key]: bench(key) }, meta);
      assert.strictEqual(rows.length, 1, `${key} derives exactly one headline row`);
      const published = { ...meta.headlines.find((h) => h.key === key) };
      for (const field of ['generated', 'node', 'version', 'quick']) delete published[field];
      assert.deepStrictEqual(rows[0], published,
        `the published ${key} row does not recompute from ${key}.json`);
    }
  });

  it('publishes the JSON Schema conformance count over the tests Jaren ran', () => {
    const stats = meta.conformance.jsonSchema.engineStats.jaren;
    const validate = bench('validate').summary.byDraft;
    for (const [draft, s] of Object.entries(stats)) {
      assert.strictEqual(s.passed + s.failed + s.errors, validate[draft].totalTests,
        `${draft}: every test is counted somewhere — a test the rival could not compile is not dropped`);
    }
    const row = meta.headlines.find((h) => h.key === 'validate');
    const passed = Object.values(stats).reduce((n, s) => n + s.passed, 0);
    const total = Object.values(stats).reduce((n, s) => n + s.passed + s.failed + s.errors, 0);
    assert.strictEqual(row.conformance, `${passed} / ${total}`);
  });
});
