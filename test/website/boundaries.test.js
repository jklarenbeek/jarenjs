//@ts-check
/**
 * The playground/benchmark boundaries — the impure edge the site drives.
 *
 * These wrap the engines, the validator and the benchmark derivations for
 * the browser app; each is a pure function of its inputs (timing aside),
 * so they run headless here. Driving them directly covers the engine and
 * suite branches the full-site walkthrough does not reach.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { runEngine, ENGINE_EXAMPLES } from '../../packages/website/src/boundaries/engines.js';
import { runValidation } from '../../packages/website/src/boundaries/validator.js';
import { deriveSuite } from '../../packages/website/src/boundaries/bench.js';
import { chartsSync, chartsReplayActive } from '../../packages/website/src/boundaries/charts.js';
import { renderToString } from '@jarenjs/view';

const loadBench = (name) => JSON.parse(readFileSync(
  new URL(`../../packages/website/public/benchmarks/${name}.json`, import.meta.url), 'utf8'));

describe('website boundaries — engines', function () {
  it('runs the mermaid engine: cards, rendered SVG and the AST round-trip', function () {
    const nodes = runEngine('mermaid', { source: 'flowchart TD\n  A --> B' });
    assert.ok(Array.isArray(nodes) && nodes.length > 0, 'returns a node list');
    const html = JSON.stringify(nodes);
    assert.match(html, /Diagram/, 'shows the diagram-type card');
    assert.match(html, /flowchart/, 'reports the parsed diagram type');
  });

  it('runs the mermaid engine on a state diagram: derives the workflow projection', function () {
    const nodes = runEngine('mermaid', { source: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Done\n  Done --> [*]' });
    const html = JSON.stringify(nodes);
    assert.match(html, /Derived workflow/, 'the state → workflow JSLT projection renders');
  });

  it('every jtlt example runs to text output without an error node', function () {
    for (const example of ENGINE_EXAMPLES.jtlt) {
      const nodes = runEngine('jtlt', example.inputs);
      assert.ok(!nodes.some((n) => n.kind === 'error'),
        `'${example.label}' runs clean`);
      assert.ok(nodes.some((n) => n.kind === 'code' && n.title === 'Output'),
        `'${example.label}' emits an Output block`);
    }
  });

  it('the DDL examples render dialect-correct SQL from one shared document', function () {
    const example = (label) => ENGINE_EXAMPLES.jtlt.find((e) => e.label === label).inputs;

    const sqlite = runEngine('jtlt', example('SQL DDL — SQLite'))
      .find((n) => n.title === 'Output').text;
    assert.match(sqlite, /CREATE TABLE customers \(/);
    assert.match(sqlite, /^ {2}id INTEGER,$/m, 'schema-matched type rule fired');
    assert.match(sqlite, /^ {2}email TEXT NOT NULL UNIQUE,$/m);
    assert.match(sqlite, /^ {2}customer_id INTEGER NOT NULL REFERENCES customers \(id\),$/m);
    assert.match(sqlite, /^ {2}PRIMARY KEY \(id\)$/m, 'the pk filter selector fired');

    const pg = runEngine('jtlt', example('SQL DDL — PostgreSQL'))
      .find((n) => n.title === 'Output').text;
    assert.match(pg, /^ {2}id integer GENERATED ALWAYS AS IDENTITY,$/m,
      'the priority-1 pk override beats the plain int rule');
    assert.match(pg, /^ {2}email varchar\(254\) NOT NULL UNIQUE,$/m,
      'maxLength dispatches to varchar(n) via $concat');
    assert.match(pg, /^ {2}placed_at timestamptz NOT NULL,$/m);
    assert.match(pg, /^ {2}total numeric\(12,2\) NOT NULL,$/m);
  });

  it('the xml output method escapes visibly and shows the text comparison', function () {
    const example = ENGINE_EXAMPLES.jtlt.find((e) => e.label.startsWith('XML')).inputs;
    const nodes = runEngine('jtlt', example);
    const output = nodes.find((n) => n.title === 'Output');
    assert.match(output.text, /Q&amp;A/, 'interpolated data is escaped');
    assert.match(output.text, /<b>escaped attribute, raw body<\/b>/, '$raw passes markup through');
    assert.match(output.badge, /output "xml"/, 'the badge names the method');
    const comparison = nodes.find((n) => n.kind === 'details' && /escaped/.test(n.summary ?? ''));
    assert.ok(comparison, 'the xml run shows what escaping changed');
    assert.match(JSON.stringify(comparison), /Q&A/, 'the text rendering shows the unescaped data');

    // a text-method template gets no escaping panel
    const markdown = ENGINE_EXAMPLES.jtlt.find((e) => e.label === 'Markdown book list').inputs;
    const textNodes = runEngine('jtlt', markdown);
    assert.ok(!textNodes.some((n) => /escap/i.test(JSON.stringify(n))),
      'text output carries no escaping panel');

    // xml over data with nothing to escape says so instead of implying
    // a difference that is not there
    const clean = runEngine('jtlt', {
      template: JSON.stringify({
        $jtlt: '0.1', output: 'xml',
        rules: [{ match: '$', body: ['<v>', '$.v', '</v>'] }],
      }),
      data: JSON.stringify({ v: 'plain' }),
    });
    const note = clean.find((n) => n.kind === 'callout');
    assert.ok(note, 'the identical-render case gets a callout');
    assert.match(note.text, /render this document identically/);
  });

  it('an unknown engine returns a callout, not a crash', function () {
    const nodes = runEngine('nonesuch', {});
    assert.match(JSON.stringify(nodes), /Unknown engine/);
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
    ['mermaid', 2], ['view', 4], ['charts', 2],
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

describe('website boundaries — charts engine', function () {
  const example = (label) => {
    const found = ENGINE_EXAMPLES.charts.find((e) => e.label.startsWith(label));
    assert.ok(found, `example '${label}' exists`);
    return found.inputs;
  };

  it('runs a static pie definition: cards, svg chart, AST details', function () {
    const nodes = runEngine('charts', example('Static pie'));
    const chartNode = nodes.find((n) => n.kind === 'chart');
    assert.ok(chartNode, 'emits a chart node');
    assert.equal(chartNode.vnode[0], 'svg');
    assert.match(JSON.stringify(nodes), /schema-valid/);
    assert.match(JSON.stringify(nodes), /Geometry-free AST/);
  });

  it('replay examples: JOSL and strict JSON produce byte-identical SVG', function () {
    const joslNodes = runEngine('charts', example('Replay — JOSL'));
    const jsonNodes = runEngine('charts', example('Replay — same data'));
    const svg = (nodes) => renderToString(nodes.find((n) => n.kind === 'chart').vnode);
    assert.equal(svg(joslNodes), svg(jsonNodes));
  });

  it('schema violations render error nodes, never throw', function () {
    const nodes = runEngine('charts', { format: 'json', stream: 'off', source: '{"type": "sparkline"}' });
    assert.ok(nodes.every((n) => typeof n === 'object'));
    assert.match(JSON.stringify(nodes), /Schema validation failed/);
  });

  it('parse failures render error nodes, never throw', function () {
    const jsonBad = runEngine('charts', { format: 'json', stream: 'off', source: '{"type": ' });
    assert.match(JSON.stringify(jsonBad), /Parse error/);
    const joslBad = runEngine('charts', { format: 'josl', stream: 'off', source: 'type = what' });
    assert.match(JSON.stringify(joslBad), /Parse error/);
  });

  it('strict json mode rejects JSONX extensions in definitions', function () {
    const nodes = runEngine('charts', { format: 'json', stream: 'off', source: '{"type": "pie", "slices": [], "n": 1n}' });
    assert.match(JSON.stringify(nodes), /JSONX extension|Parse error/);
  });

  it('the replay controller starts and stops through the sync hook', function () {
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    const inputs = example('Replay — same data');
    chartsSync(inputs, dispatch, true);
    assert.equal(chartsReplayActive(), true, 'replay timer running');
    chartsSync(inputs, dispatch, false); // navigated away
    assert.equal(chartsReplayActive(), false, 'timer cleared on leave');
    chartsSync({ ...inputs, stream: 'off' }, dispatch, true);
    assert.equal(chartsReplayActive(), false, 'stream off keeps it stopped');
  });

  it('replay without a stream spec explains itself instead of ticking', function () {
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    chartsSync({ format: 'json', stream: 'replay', source: '{"type": "pie", "slices": []}' }, dispatch, true);
    assert.equal(chartsReplayActive(), false);
    assert.match(JSON.stringify(dispatched), /Replay needs a streaming definition/);
  });

  it('a replay tick dispatches an eng/result frame and then completes', async function () {
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    chartsSync(example('Replay — same data'), dispatch, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    chartsSync({}, dispatch, false); // ensure stopped even on slow machines
    assert.ok(dispatched.length > 0, 'frames were dispatched');
    const [action, payload] = dispatched[0];
    assert.equal(action, 'eng/result');
    assert.equal(payload.engine, 'charts');
    assert.ok(payload.result.some((n) => n.kind === 'chart'));
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

  it('the view suite reports its build path as slower, not faster', function () {
    const st = { benchStatus: { view: 'loaded' }, bench: { view: loadBench('view') }, benchUi: { search: '', limit: 40 } };
    const nodes = deriveSuite(st, 'view');
    const cards = nodes.find((n) => n.kind === 'cards');
    const build = (cards.items ?? cards.cards ?? []).find((c) => /vnode production/i.test(c.title));
    assert.ok(build !== undefined, 'the suite leads with the build-path card');
    assert.match(build.value, /slower/,
      'producing vnodes costs more than a hand-written h() and the page must say so');
  });

  it('renders the cross-suite chart host-linked, and stays memoized', function () {
    const first = chartsIn(deriveSuite(state, 'overview'));
    const second = chartsIn(deriveSuite(state, 'overview'));
    assert.ok(first.length >= 1, 'the overview carries a summary chart');
    assert.equal(first[0].vnode[1].style['--chart-text'], 'var(--fg, #1f2020)');
    assert.equal(first[0].vnode, second[0].vnode, 'memoized across re-derivations');
  });
});
