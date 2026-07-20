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

import { runEngine } from '../../packages/website/src/boundaries/engines.js';
import { runValidation } from '../../packages/website/src/boundaries/validator.js';
import { deriveSuite } from '../../packages/website/src/boundaries/bench.js';

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
