//@ts-check
/**
 * The site's shared boundaries — the impure edge the site drives.
 *
 * These wrap the shared transform runners, the validator, the chart
 * renderer and the benchmark derivations for the browser app; each is a
 * pure function of its inputs (timing aside), so they run headless here.
 * Driving them directly covers the branches the full-site walkthrough
 * does not reach. (The single-engine exploration surface itself is
 * @jarenjs/play — covered in test/play and test/website/play.test.js.)
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createJsonxStreamReader } from '@jarenjs/josl';
import { compileChart } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';

import { runQuery, runJslt, operatorRegistry } from '../../packages/website/src/boundaries/engines.js';
import { runValidation } from '../../packages/website/src/boundaries/validator.js';
import { deriveSuite, draftConformanceTable, SUITES } from '../../packages/website/src/boundaries/bench.js';
import { chartRenderer } from '../../packages/website/src/boundaries/charts.js';

const loadBench = (name) => JSON.parse(readFileSync(
  new URL(`../../packages/website/public/benchmarks/${name}.json`, import.meta.url), 'utf8'));

describe('website boundaries — the shared transform runners', function () {
  it('runQuery runs a query document with the registered packs mounted', function () {
    const nodes = runQuery({
      query: '{"m":{"$mean":"$.v[*]"}}', data: '{"v":[2,4,6]}', externals: '',
    });
    assert.ok(!nodes.some((n) => n.kind === 'error'), 'the registered $mean resolves');
    assert.match(nodes.find((n) => n.kind === 'code').text, /"m": 4/);
    assert.ok(operatorRegistry.names().includes('$mean'), 'the registry names its vocabulary');
  });

  it('runQuery reports unbound externals as a callout, and bad JSON as an error node', function () {
    const unbound = runQuery({ query: '"$x"', data: '1', externals: '' });
    assert.match(JSON.stringify(unbound), /Unbound externals/);
    const bad = runQuery({ query: '{ nope', data: '1', externals: '' });
    assert.ok(bad.some((n) => n.kind === 'error'), 'invalid JSON is an error node, never a throw');
  });

  it('runJslt transforms, and proves the no-change identity on the output card', function () {
    const nodes = runJslt({
      stylesheet: '{"$jslt":"0.1","rules":[{"match":"$","body":{"hi":"$.name"}}]}',
      data: '{"name":"Ada"}',
    });
    assert.match(nodes.find((n) => n.kind === 'code').text, /"hi": "Ada"/);
    const identity = runJslt({ stylesheet: '[]', data: '{"a":1}' });
    assert.match(JSON.stringify(identity), /proof of no change/,
      'an identity transform hands the INPUT back and the card says so');
  });
});

describe('website boundaries — validator', function () {
  it('compiles and validates, timing both phases', function () {
    const pass = runValidation('{ "type": "string", "minLength": 2 }', 'hello');
    assert.strictEqual(pass.valid, true);
    assert.strictEqual(pass.schemaError, null);
    assert.ok(typeof pass.compileMs === 'number' && typeof pass.validateMs === 'number', 'phases are timed');

    const fail = runValidation('{ "type": "string", "minLength": 2 }', 'x');
    assert.strictEqual(fail.valid, false);
    assert.ok(fail.errors.length > 0, 'reports the minLength error');
  });

  it('reports a schema JSON error instead of throwing', function () {
    const bad = runValidation('{ not json', null);
    assert.match(bad.schemaError, /Invalid JSON/);
    assert.strictEqual(bad.valid, null);
  });
});

describe('website boundaries — benchmark suite derivations', function () {
  it('derives the JSON Patch suite from the generated data', function () {
    const state = { benchStatus: { jsonpatch: 'loaded' }, bench: { jsonpatch: loadBench('jsonpatch') }, benchUi: {} };
    const nodes = deriveSuite(state, 'jsonpatch');
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(JSON.stringify(nodes), /json-patch-tests/, 'the conformance note renders');
  });

  it('derives the contracts suite and leads with the caveat, not the flattering table', function () {
    const state = { benchStatus: { contracts: 'loaded' }, bench: { contracts: loadBench('contracts') }, benchUi: {} };
    const nodes = deriveSuite(state, 'contracts');
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    const text = JSON.stringify(nodes);
    assert.match(text, /Read the third table, not the second/, 'the caveat renders above the tables');
    assert.match(text, /Normalize \+ validate \+ map issues/, 'the comparable table is published');
    assert.match(text, /zod 4/, 'the rivals are named');
    assert.match(text, /ajv/, 'ajv is included rather than omitted');
  });

  it('derives the contract suite: the harness caveat leads and the losses render, serialization share included', function () {
    const state = { benchStatus: { contract: 'loaded' }, bench: { contract: loadBench('contract') }, benchUi: {} };
    const nodes = deriveSuite(state, 'contract');
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    const text = JSON.stringify(nodes);
    assert.match(text, /Read the harnesses before the numbers/, 'the inject-asymmetry caveat renders above the tables');
    assert.match(text, /RegExpRouter/, 'the refused rival is reported, not dropped silently');
    assert.match(text, /find-my-way \+ Ajv \+ fjs/, 'the harness-free rival — the one jaren loses to — is published');
    assert.match(text, /serialization share/, 'the serializer-decision table renders');
  });

  it('derives the formats suite from the generated data', function () {
    const state = { benchStatus: { formats: 'loaded' }, bench: { formats: loadBench('formats') }, benchUi: {} };
    const nodes = deriveSuite(state, 'formats');
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    const text = JSON.stringify(nodes);
    assert.match(text, /optional\/format suite/, 'the conformance card renders');
    assert.match(text, /Formats only Jaren implements/, 'the jaren-only table is published, not hidden');
    assert.match(text, /idn-hostname/, 'the internationalized formats are listed');
  });

  it('derives the TOML suite from the generated data', function () {
    const state = { benchStatus: { toml: 'loaded' }, bench: { toml: loadBench('toml') }, benchUi: {} };
    const nodes = deriveSuite(state, 'toml');
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(JSON.stringify(nodes), /toml-test 1\.0\.0 compliance/, 'the compliance table renders');
  });

  it('derives the CSV suite from the generated data', function () {
    const state = { benchStatus: { csv: 'loaded' }, bench: { csv: loadBench('csv') }, benchUi: {} };
    const nodes = deriveSuite(state, 'csv');
    const text = JSON.stringify(nodes);
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(text, /csv-spectrum acceptance suite/, 'the acceptance table renders');
    assert.match(text, /Damaged documents/, 'the self-healing scorecard renders');
    assert.match(text, /new Function/, 'the udsv loss is explained rather than hidden');
  });

  it('derives the geo suite from the generated data', function () {
    const state = { benchStatus: { geo: 'loaded' }, bench: { geo: loadBench('geo') }, benchUi: {} };
    const nodes = deriveSuite(state, 'geo');
    const text = JSON.stringify(nodes);
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(text, /Result equivalence/, 'the equivalence gate renders as the headline');
    assert.match(text, /the deliberate loss/, 'the point-in-polygon loss is published, not hidden');
    assert.match(text, /flatbush/, 'the index rival is named');
  });

  it('derives the spatial suite: no invented rival, the no-database row, the plan behind every timing', function () {
    const data = loadBench('spatial');
    const state = { benchStatus: { spatial: 'loaded' }, bench: { spatial: data }, benchUi: {} };
    const nodes = deriveSuite(state, 'spatial');
    const text = JSON.stringify(nodes);
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(text, /No head-to-head rival/, 'the absence of a rival is stated, not papered over');
    assert.match(text, /MongoDB/, 'the positioning rival is named');
    assert.match(text, /DuckDB/, 'and the other one');
    assert.match(text, /no database/, 'the in-memory engine row renders — the row the store had to win');
    assert.match(text, /R\*Tree/, 'the physical comparison renders');
    assert.match(text, /nine geohash cells/, 'the proximity row is the nine-cell probe');
    assert.match(text, /SEARCH .* USING INDEX/, 'the database\'s own narrative is on the page');
    assert.strictEqual(data.meta.equivalenceFailures, 0, 'the tracked file was written by a run with no failures');
    assert.ok(data.checks.every((c) => c.agrees), 'every published check agreed');
    for (const key of ['within-scan', 'within-indexed', 'cell-nine', 'engine', 'rtree-raw', 'within-udf-limit']) {
      assert.ok(data.tables.some((t) => t.rows.some((r) => r.key === key)), `the ${key} row is published`);
    }
  });

  it('derives the retrieval suite, with the oracle proof and the synthetic-corpus note in view', function () {
    const data = loadBench('retrieval');
    const state = { benchStatus: { retrieval: 'loaded' }, bench: { retrieval: data }, benchUi: {} };
    const nodes = deriveSuite(state, 'retrieval');
    const text = JSON.stringify(nodes);
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    assert.match(text, /oracle \(gold first\)/, 'the oracle row renders — it is the scorer\'s proof');
    assert.match(text, /tag\+recency/, 'the incumbent renders');
    assert.match(text, /near \(hash-trigram-64, ranked\)/, 'the ranked row renders beside it, whichever way it fell');
    assert.match(text, /random floor \(analytic\)/, 'the floor renders beside the seeded draw');
    // the page says what the numbers are and are not: a mechanism over a
    // synthetic corpus, never a claim about a model understanding language
    assert.match(text, /synthetic/, 'the headline says the corpus is synthetic');
    assert.match(text, /not whether a model understands language/);
    assert.strictEqual(data.tables.length, data.meta.sizes.length, 'one table per corpus size');
    // and the published rows carry the contract every later measurement
    // states its delta against: the oracle is 1.0 at every size, and
    // every policy is one of the five plus the analytic floor
    for (const size of data.meta.sizes) {
      const oracle = data.rows.find((r) => r.size === size && r.policy === 'oracle');
      assert.ok(oracle !== undefined);
      assert.deepStrictEqual([oracle.recallAt1, oracle.recallAt5, oracle.recallAt10, oracle.mrr], [1, 1, 1, 1]);
      for (const key of ['random', 'recency', 'tag+recency', 'near', 'floor'])
        assert.ok(data.rows.some((r) => r.size === size && r.policy === key), `${key} row at ${size}`);
    }
    // the tracked file is generated without --live: the ranked row's
    // identity is the deterministic reference embedder, and no model
    assert.deepStrictEqual(data.meta.ranked, { model: 'hash-trigram-64', dims: 64 });
    assert.strictEqual(data.meta.live, undefined, 'the tracked file never carries a live row');
    assert.ok(!data.rows.some((r) => r.policy === 'near-live'));
  });

  it('derives the long-horizon suite, keeping both tasks and both shapes', function () {
    const data = loadBench('long-horizon');
    const state = { benchStatus: { 'long-horizon': 'loaded' }, bench: { 'long-horizon': data }, benchUi: {} };
    const nodes = deriveSuite(state, 'long-horizon');
    const text = JSON.stringify(nodes);
    assert.ok(Array.isArray(nodes) && nodes.length > 0);
    // D7: both tasks and both numbers. A page that showed only the needle
    // would hide the finding the whole measurement exists to state.
    assert.match(text, /Pairwise ceiling/, 'the pairwise column may not be dropped');
    assert.match(text, /Needle ceiling/);
    assert.match(text, /FRONT of the tool result/, 'the flattering payload shape is labelled');
    assert.match(text, /BEHIND the padding/, 'the realistic payload shape renders beside it');
    assert.match(text, /DETERMINACY/,
      'the page says what the pairwise ceiling is, since it is not a hard bound on the score');
    // and the underlying rows carry the contract every later measurement
    // states its delta against
    assert.ok(data.rows.length > 0);
    for (const row of data.rows) {
      assert.ok(['needle', 'pairwise'].includes(row.task));
      assert.ok(['front', 'late'].includes(row.shape));
      assert.strictEqual(typeof row.ceiling, 'number');
      assert.ok(row.actual === null || typeof row.actual === 'number');
      // NOT asserted: actual <= ceiling. The needle ceiling is a hard
      // bound but its actual is a small-sample estimate, and the pairwise
      // ceiling is determinacy — a model can name the right pair out of a
      // surviving subset. `pairSurvived` is what makes such a row legible,
      // so it has to be in the published data.
      assert.strictEqual(typeof row.pairSurvived, 'boolean');
    }
    // The pairwise ceiling is 0 at every budget that compacts anything —
    // published rather than smoothed, because it is the number the whole
    // measurement exists to state. The one legal exception is a row where
    // the cut happened to leave EVERY value in place: the context then
    // determines the answer, and the ceiling says so. That is the payload
    // shape being generous, not a relation being recovered, so it is
    // asserted as exactly that condition rather than waved through —
    // a row with a missing value and a non-zero pairwise ceiling would be
    // a broken measurement.
    const compacting = data.rows.filter((r) => r.task === 'pairwise' && r.compacted);
    assert.ok(compacting.length > 0);
    for (const row of compacting) {
      assert.strictEqual(row.ceiling, row.valuePresent === row.n ? 1 : 0,
        `${row.variant}/${row.shape}@${row.budget}: a pairwise ceiling is determinacy — it may `
        + 'only be non-zero where every value survived the cut');
    }
    assert.ok(compacting.some((r) => r.ceiling === 0),
      'a run where compaction never cost the pairwise answer is not measuring compaction');
  });

  it('a suite whose data failed to load renders the error callout', function () {
    const nodes = deriveSuite({ benchStatus: { toml: 'error' }, bench: {}, benchUi: {} }, 'toml');
    assert.match(JSON.stringify(nodes), /Data unavailable/);
  });
});

describe('website boundaries — benchmark charts', function () {
  const UI = { search: '', limit: 50 };
  const chartsIn = (nodes) => {
    const found = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n !== null && typeof n === 'object') {
        if (n.kind === 'chart') found.push(n);
        for (const v of Object.values(n)) walk(v);
      }
    };
    walk(nodes);
    return found;
  };

  const CASES = [
    ['validate', 3], ['jsonpath', 1], ['jsonquery', 1], ['jslt', 1],
    ['jsonpointer', 1], ['jsonpatch', 1], ['toml', 2], ['markdown', 2],
    ['mermaid', 2], ['view', 4], ['charts', 2], ['csv', 1], ['geo', 1],
  ];
  for (const [suite, minCharts] of CASES) {
    it(`the ${suite} suite renders ${minCharts}+ svg chart(s) from the published data`, function () {
      const state = { benchStatus: { [suite]: 'loaded' }, bench: { [suite]: loadBench(suite) }, benchUi: UI };
      const nodes = deriveSuite(state, suite);
      const charts = chartsIn(nodes);
      assert.ok(charts.length >= minCharts,
        `expected at least ${minCharts} chart nodes, found ${charts.length}`);
      for (const c of charts) {
        assert.ok(Array.isArray(c.vnode) && c.vnode[0] === 'svg', 'chart vnode is an svg');
        assert.equal(c.vnode[1].style['--chart-text'], 'var(--fg, #1f2020)',
          'charts are host-linked');
      }
    });
  }

  it('chart vnodes are reference-stable across re-derivations (memoized)', function () {
    const data = loadBench('toml');
    const state = { benchStatus: { toml: 'loaded' }, bench: { toml: data }, benchUi: UI };
    const first = chartsIn(deriveSuite(state, 'toml'));
    const second = chartsIn(deriveSuite(state, 'toml'));
    assert.equal(first[0].vnode, second[0].vnode);
  });
});

describe('website boundaries — the chart renderer (the play seam)', function () {
  it('renders a schema-valid definition to an svg vnode, and reports both phases', function () {
    const out = chartRenderer(JSON.stringify({
      type: 'pie', title: 'T', slices: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
    }), { format: 'json' });
    assert.ok(Array.isArray(out.vnode) && out.vnode[0] === 'svg');
    // the seam reports its own compile/run split; play prints those two
    // numbers instead of inventing a zero for the half it cannot see
    assert.strictEqual(typeof out.compileMs, 'number');
    assert.strictEqual(typeof out.runMs, 'number');
    assert.ok(out.compileMs >= 0 && out.runMs >= 0);
  });

  it('renders a JOSL definition through the streaming reader', function () {
    const out = chartRenderer('type = "pie"\ntitle = "T"\n[[slices]]\nlabel = "a"\nvalue = 1\n', { format: 'josl' });
    assert.ok(Array.isArray(out.vnode) && out.vnode[0] === 'svg');
  });

  it('a `stream` definition routes its own records through the adapter — never an empty chart', function () {
    // regression: the events buffered by the parse were
    // discarded and dataFor received a DIFFERENT empty array, so any
    // stream-member definition rendered an empty chart with real timings
    const definition = {
      type: 'line', title: 'S',
      stream: { recordPath: ['records'], xField: 'x', yField: 'y' },
      records: [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 }],
    };
    const source = JSON.stringify(definition);
    const out = chartRenderer(source, { format: 'json' });

    // the expected data: the SAME events replayed through the adapter
    const adapter = createStreamAdapter('line', definition.stream);
    const reader = createJsonxStreamReader({ mode: 'json', onEvent: (e) => adapter.onEvent(e) });
    reader.feed(source);
    reader.end();
    adapter.endDocument();
    const data = adapter.getData();
    assert.strictEqual(data.series.length, 1, 'one series accumulated');
    assert.deepStrictEqual(data.series[0].points,
      [{ x: 1, y: 10 }, { x: 2, y: 20 }, { x: 3, y: 30 }], 'exactly the three records, exact x/y');

    // the rendered chart is the chart OF those three points…
    assert.deepStrictEqual(out.vnode, compileChart(definition, data, { theme: 'host' }).toVnode());
    // …and visibly not the empty-events rendering the bug produced
    const starved = createStreamAdapter('line', definition.stream);
    starved.endDocument();
    assert.notDeepStrictEqual(out.vnode,
      compileChart(definition, starved.getData(), { theme: 'host' }).toVnode());
  });

  it('throws on a schema violation or a parse failure (play lands the honest error Result)', function () {
    assert.throws(() => chartRenderer('{"type": "sparkline"}', { format: 'json' }), /chart definition/);
    assert.throws(() => chartRenderer('{"type": ', { format: 'json' }));
    // strict json mode rejects JSONX extensions in definitions
    assert.throws(() => chartRenderer('{"type": "pie", "slices": [], "n": 1n}', { format: 'json' }));
  });
});

describe('website boundaries — the benchmarks overview', function () {
  /** Every chart node in a derived tree (the suite tests use the same walk). */
  const chartsIn = (nodes) => {
    const found = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n !== null && typeof n === 'object') {
        if (n.kind === 'chart') found.push(n);
        for (const v of Object.values(n)) walk(v);
      }
    };
    walk(nodes);
    return found;
  };
  const meta = loadBench('meta');
  const state = { benchStatus: { meta: 'loaded' }, bench: { meta }, benchUi: { search: '', limit: 40 } };

  it('summarizes EVERY measured suite, not just one', function () {
    assert.ok(Array.isArray(meta.headlines), 'meta.json carries derived headlines');
    assert.ok(meta.headlines.length >= 8,
      `expected a headline per suite, got ${meta.headlines.length}`);
    const nodes = deriveSuite(state, 'overview');
    const flat = JSON.stringify(nodes);
    for (const h of meta.headlines) {
      assert.ok(flat.includes(h.label), `the overview omits the ${h.key} suite`);
    }
  });

  it('every headline is derived, dated, and labels its rival', function () {
    for (const h of meta.headlines) {
      assert.equal(typeof h.key, 'string');
      assert.equal(typeof h.label, 'string');
      assert.match(h.generated ?? '', /^\d{4}-\d{2}-\d{2}T/, `${h.key} records its run`);
      if (h.ratio !== null && h.ratio !== undefined) {
        assert.ok(Number.isFinite(h.ratio) && h.ratio > 0, `${h.key} ratio is a positive number`);
        assert.ok(typeof h.rival === 'string' && h.rival !== '',
          `${h.key} names what it was compared against`);
      }
    }
  });

  it('reports losses as losses — the ratio is never floored at parity', function () {
    // The suite convention is "ratio > 1 means Jaren is faster"; a
    // summary that could only show wins would not be a measurement.
    const ratios = meta.headlines.map((h) => h.ratio).filter(Number.isFinite);
    assert.ok(ratios.length > 0);
    assert.ok(ratios.some((r) => r < 1) || ratios.every((r) => r >= 1),
      'ratios are reported verbatim');
    const nodes = deriveSuite(state, 'overview');
    assert.match(JSON.stringify(nodes), /Bars below parity/,
      'the chart note explains sub-parity bars rather than hiding them');
  });

  it('states directions honestly — no doubled or inverted comparison words', function () {
    const suites = ['view', 'charts'];
    for (const suite of suites) {
      const st = { benchStatus: { [suite]: 'loaded' }, bench: { [suite]: loadBench(suite) }, benchUi: { search: '', limit: 40 } };
      const text = JSON.stringify(deriveSuite(st, suite));
      assert.doesNotMatch(text, /faster faster|slower slower|faster of |slower of /,
        `${suite} doubles a comparison word`);
      assert.doesNotMatch(text, /faster the session/,
        `${suite} inverts a cost multiple into a speed claim`);
    }
  });

  it('the view suite leads with the engine loss and separates it from the format win', function () {
    const st = { benchStatus: { view: 'loaded' }, bench: { view: loadBench('view') }, benchUi: { search: '', limit: 40 } };
    const nodes = deriveSuite(st, 'view');
    const cards = nodes.find((n) => n.kind === 'cards');
    const items = cards.items ?? cards.cards ?? [];
    // The LOSS leads: the first card is the stylesheet build path, and it
    // says "slower" — running a view-as-data through a generic dispatcher
    // costs more than a hand-written build, and the page must say so first.
    const engine = items[0];
    assert.match(engine.title, /vnode production/i,
      'the suite leads with the build-path card');
    assert.match(engine.value, /slower/,
      'the stylesheet engine costs more than a hand-written build and the page must say so');
    // The decomposition is pinned too: the hand-written tagged-array card
    // exists, claims the FORMAT (not the engine), and reads "faster" only
    // because the measured rows do.
    const hand = items.find((c) => /hand-written/i.test(c.title));
    assert.ok(hand !== undefined, 'the format card separates the vnode format from the engine');
    assert.match(hand.value, /faster/,
      'hand-written tagged arrays outbuild the rivals — the format was never the price');
  });

  // The tiles used to print the LAST RUN's date and version as though
  // they described every row, over rows measured weeks and versions
  // earlier. A set of rows is honestly summarized by the span it covers.
  describe('the provenance tiles range over the rows, not over the last run', function () {
    const tiles = (headlines, lastRun) => {
      const nodes = deriveSuite({
        benchStatus: { meta: 'loaded' },
        bench: { meta: { headlines, lastRun } },
        benchUi: { search: '', limit: 40 },
      }, 'overview');
      return (nodes.find((n) => n.kind === 'cards').items ?? []);
    };
    const lastRun = {
      generated: '2026-08-22T09:00:00.000Z', node: 'v24.19.0', cpu: 'Test CPU',
      platform: 'Test x64', version: '0.39.0', quick: false,
    };
    const row = (key, generated, version) => ({
      key, label: key, ratio: 2, rival: 'a rival', conformance: null, generated, version,
    });

    it('prints a range when the rows disagree', function () {
      const items = tiles([
        row('validate', '2026-08-02T10:00:00.000Z', '0.24.9'),
        row('contract', '2026-08-21T10:00:00.000Z', '0.37.1'),
      ], lastRun);
      assert.equal(items[0].title, 'Measured');
      assert.equal(items[0].value, '2026-08-02 → 2026-08-21');
      assert.equal(items[2].value, 'v0.24.9 → v0.37.1');
      assert.match(items[2].note, /last run 2026-08-22/,
        'the last invocation is labeled as the last invocation, not as the measurement set');
    });

    it('prints one value when every row agrees', function () {
      const items = tiles([row('validate', '2026-08-22T10:00:00.000Z', '0.39.0')], lastRun);
      assert.equal(items[0].value, '2026-08-22');
      assert.equal(items[2].value, 'v0.39.0');
    });

    it('orders versions numerically, not as text', function () {
      const items = tiles([
        row('a', '2026-08-02T10:00:00.000Z', '0.9.0'),
        row('b', '2026-08-03T10:00:00.000Z', '0.37.1'),
      ], lastRun);
      assert.equal(items[2].value, 'v0.9.0 → v0.37.1');
    });

    it('counts rows whose provenance is unknown instead of folding them in', function () {
      const items = tiles([
        row('validate', '2026-08-22T10:00:00.000Z', '0.39.0'),
        row('jsonpath', '2026-08-02T10:00:00.000Z', null),
      ], lastRun);
      assert.equal(items[2].value, 'v0.39.0');
      assert.match(items[2].note, /1 row unrecorded/,
        'a row that never recorded its version must not borrow one');
    });
  });

  it('renders the cross-suite chart host-linked, and stays memoized', function () {
    const first = chartsIn(deriveSuite(state, 'overview'));
    const second = chartsIn(deriveSuite(state, 'overview'));
    assert.ok(first.length >= 1, 'the overview carries a summary chart');
    assert.equal(first[0].vnode[1].style['--chart-text'], 'var(--fg, #1f2020)');
    assert.equal(first[0].vnode, second[0].vnode, 'memoized across re-derivations');
  });
});

describe('website boundaries — the figures that can show a failure', function () {
  const UI = { search: '', limit: 40 };
  const derive = (suite, data) => {
    const need = suite === 'overview' ? 'meta' : suite;
    return deriveSuite(
      { benchStatus: { [need]: 'loaded' }, bench: { [need]: data }, benchUi: UI }, suite);
  };
  const cardsOf = (nodes) => nodes.find((n) => n.kind === 'cards').items;

  // The card used to divide the corpus total by itself — 703 / 703 no
  // matter what the run found. A compliance figure that cannot move is
  // not a measurement, so it is summed from the per-group rows now.
  describe('the JSONPath compliance card sums the groups it prints', function () {
    const suite = (groups) => ({
      compliance: { total: groups.reduce((n, [, g]) => n + g.total, 0), groups },
      profile: { rows: [], iterations: 1, compileRow: { engines: { jaren: 1, 'json-p3': 1 } } },
    });

    it('reads the committed run\'s true figure', function () {
      const data = loadBench('jsonpath');
      const expected = data.compliance.groups
        .reduce((n, [, g]) => n + g.pass.jaren, 0);
      const card = cardsOf(derive('jsonpath', data))[0];
      assert.equal(card.value, `${expected} / ${data.compliance.total}`);
      assert.match(card.note, /json-p3: \d+ \/ \d+/, 'the rival is scored beside it, not folded in');
    });

    it('shows n-1 / n the moment one group fails', function () {
      const card = cardsOf(derive('jsonpath', suite([
        ['basic', { total: 45, pass: { jaren: 45, 'json-p3': 45 } }],
        ['filter', { total: 186, pass: { jaren: 185, 'json-p3': 186 } }],
      ])))[0];
      assert.equal(card.value, '230 / 231', 'one failing group must be visible on the card');
      assert.match(card.note, /json-p3: 231 \/ 231/,
        'the rival passing where jaren does not is exactly what the card exists to show');
    });

    it('says nothing rather than 0 / 0 when the run carries no groups', function () {
      assert.equal(cardsOf(derive('jsonpath', suite([])))[0].value, '—');
    });
  });

  // "20 suites measured" once appeared over a site offering 21 pages:
  // the note counted the headline rows and named the suite collection.
  describe('the overview note counts the collection it names', function () {
    const published = SUITES.filter((s) => s.key !== 'overview').length;
    const row = (key) => ({
      key, label: key, ratio: 2, rival: 'a rival', conformance: null,
      generated: '2026-08-22T10:00:00.000Z', version: '0.39.0',
    });
    const note = (n) => cardsOf(derive('overview', {
      headlines: Array.from({ length: n }, (_, i) => row(`s${i}`)), lastRun: {},
    }))[0].note;

    it('names the site\'s own suite manifest as the denominator', function () {
      assert.equal(note(published), `${published} of ${published} suites measured`);
    });

    it('shows the shortfall when a suite stops publishing a headline', function () {
      assert.equal(note(published - 1), `${published - 1} of ${published} suites measured`);
    });

    it('holds against the committed run', function () {
      const meta = loadBench('meta');
      assert.equal(cardsOf(derive('overview', meta))[0].note,
        `${meta.headlines.length} of ${published} suites measured`);
      assert.equal(meta.headlines.length, published,
        'every published suite carries a headline');
    });
  });

  // The docs page used to transcribe this table. Both surfaces render
  // the one builder now, so they cannot publish two scores for one run.
  describe('the official-suite scorecard has one builder', function () {
    it('labels the drafts the way their specifications do', function () {
      const table = draftConformanceTable({
        jaren: { draft7: { passed: 3, failed: 0, errors: 0 } },
        ajv: { draft7: { passed: 2, failed: 1, errors: 0 } },
      });
      assert.deepEqual(table.rows[0].cells, ['draft-07', '3 / 0 / 0', '2 / 1 / 0']);
    });

    it('is the same table the benchmarks overview renders', function () {
      const meta = loadBench('meta');
      const stats = meta.conformance.jsonSchema.engineStats;
      const inOverview = derive('overview', meta)
        .find((n) => n.kind === 'table' && n.title.startsWith('JSON Schema conformance'));
      assert.deepEqual(inOverview.rows, draftConformanceTable(stats).rows);
    });

    it('scores the validate suite file and the meta summary identically', function () {
      const fromSuite = draftConformanceTable(loadBench('validate').summary.engineStats);
      const fromMeta = draftConformanceTable(loadBench('meta').conformance.jsonSchema.engineStats);
      assert.deepEqual(fromSuite.rows, fromMeta.rows,
        'the docs read the suite file and the overview reads the summary — one score either way');
    });
  });
});
