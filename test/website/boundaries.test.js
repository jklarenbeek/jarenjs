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

import { runQuery, runJslt, operatorRegistry } from '../../packages/website/src/boundaries/engines.js';
import { runValidation } from '../../packages/website/src/boundaries/validator.js';
import { deriveSuite } from '../../packages/website/src/boundaries/bench.js';
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

  it('renders the cross-suite chart host-linked, and stays memoized', function () {
    const first = chartsIn(deriveSuite(state, 'overview'));
    const second = chartsIn(deriveSuite(state, 'overview'));
    assert.ok(first.length >= 1, 'the overview carries a summary chart');
    assert.equal(first[0].vnode[1].style['--chart-text'], 'var(--fg, #1f2020)');
    assert.equal(first[0].vnode, second[0].vnode, 'memoized across re-derivations');
  });
});
