//@ts-check
/**
 * @file The scratch COMPONENT, headless: the pure view-model derivation
 * (rail grouped by engine, source/data editors, the dataset switcher, the
 * result) and the JSLT view rendering a real vnode over it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createScratchComponent, scratchViewModel, scratchRules, scratchModes,
} from '@jarenjs/scratch/component';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const state = (over = {}) => ({
  scratch: {
    engine: 'path', exampleId: 'path-shapes',
    source: { selector: '$..name' }, datasetIndex: 1,
    data: { data: '{"people":[{"name":"Ada"},{"name":"Alan"}]}' },
    result: { ok: true, output: '["Ada","Alan"]', timing: { compileMs: 0.1, runMs: 0.2 }, error: null },
    ...over,
  },
});

/** Render the scratch shell over a view model (headless — no DOM). */
function renderScratch(vm) {
  const sheet = {
    $jslt: '0.1',
    modes: scratchModes,
    rules: [{ match: '$', body: { $apply: ['$.ui.scratch', 'scratch'] } }, ...scratchRules],
  };
  return compileJsltStylesheet(sheet)({ ui: { scratch: vm } });
}

describe('scratchViewModel', () => {
  it('derives the rail grouped by engine, the editors, the switcher and the result', () => {
    const vm = scratchViewModel(state());
    const pathGroup = vm.rail.find((g) => g.engine === 'path');
    assert.ok(pathGroup && pathGroup.label === 'JSONPath', 'a JSONPath group');
    assert.ok(pathGroup.examples.some((e) => e.id === 'path-shapes' && e.active), 'the active example');
    assert.deepStrictEqual(vm.sourcePanes.map((p) => p.key), ['selector']);
    assert.strictEqual(vm.sourcePanes[0].value, '$..name');
    assert.deepStrictEqual(vm.dataPanes.map((p) => p.key), ['data']);
    assert.strictEqual(vm.datasets.length, 3, 'path-shapes has three datasets');
    assert.strictEqual(vm.hasSwitcher, true);
    assert.ok(vm.datasets[1].active);
    assert.strictEqual(vm.result.ran, true);
    assert.strictEqual(vm.result.ok, true);
    assert.match(vm.result.timing, /compiled/);
  });

  it('a single-dataset example hides the switcher', () => {
    const vm = scratchViewModel(state({ exampleId: 'path-authors', datasetIndex: 0 }));
    assert.strictEqual(vm.hasSwitcher, false);
  });
});

describe('the scratch JSLT view renders headlessly', () => {
  it('produces a vnode with the rail, the editors, the switcher and the result', () => {
    const out = JSON.stringify(renderScratch(scratchViewModel(state())));
    assert.match(out, /jscratch/);
    assert.match(out, /scratch\/example/);   // a rail example button
    assert.match(out, /scratch\/source/);    // the source editor
    assert.match(out, /scratch\/data/);      // the data editor
    assert.match(out, /scratch\/dataset/);   // the switcher (path-shapes has 3 datasets)
    assert.match(out, /Ada/);                // the run result on the stage
  });
});

describe('the component surface', () => {
  it('createScratchComponent composes the view, derivation and engine surface', () => {
    const c = createScratchComponent();
    assert.strictEqual(c.mode, 'scratch');
    assert.ok(Array.isArray(c.rules));
    assert.ok(c.engineIds().includes('query'));
    assert.strictEqual(typeof c.runExample, 'function');
    assert.strictEqual(c.viewModel(state()).engine.label, 'JSONPath');
  });
});
