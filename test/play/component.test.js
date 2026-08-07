//@ts-check
/**
 * @file The play COMPONENT, headless: the pure view-model derivation
 * (rail grouped by engine, source/data editors, the dataset switcher, the
 * result) and the JSLT view rendering a real vnode over it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createPlayComponent, playViewModel, playRules, playModes,
} from '@jarenjs/play/component';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const state = (over = {}) => ({
  play: {
    engine: 'path', exampleId: 'path-shapes',
    source: { selector: '$..name' }, datasetIndex: 1,
    data: { data: '{"people":[{"name":"Ada"},{"name":"Alan"}]}' },
    result: { ok: true, panels: [{ id: 'out', label: 'Output', kind: 'code', text: '["Ada","Alan"]' }], timing: { compileMs: 0.1, runMs: 0.2 }, error: null },
    ...over,
  },
});

/** Render the play shell over a view model (headless — no DOM). */
function renderPlay(vm) {
  const sheet = {
    $jslt: '0.1',
    modes: playModes,
    rules: [{ match: '$', body: { $apply: ['$.ui.play', 'play'] } }, ...playRules],
  };
  return compileJsltStylesheet(sheet)({ ui: { play: vm } });
}

describe('playViewModel', () => {
  it('derives the rail grouped by engine, the editors, the switcher and the result', () => {
    const vm = playViewModel(state());
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
    const vm = playViewModel(state({ exampleId: 'path-authors', datasetIndex: 0 }));
    assert.strictEqual(vm.hasSwitcher, false);
  });

  it('derives option panes with the selected value (a source-only engine)', () => {
    const vm = playViewModel(state({
      engine: 'josl', exampleId: 'josl-toml', source: { text: 'x = 1\n' },
      data: {}, config: { mode: 'toml' },
    }));
    assert.deepStrictEqual(vm.optionPanes.map((p) => p.key), ['mode']);
    const selected = vm.optionPanes[0].choices.find((c) => c.selected);
    assert.strictEqual(selected.value, 'toml', 'the config override drives the selected option');
    assert.strictEqual(vm.dataPanes.length, 0, 'a source-only engine has no data pane');
    assert.strictEqual(vm.datasets.length, 0);
  });

  it('falls back to the pane default when config is empty', () => {
    const vm = playViewModel(state({ engine: 'josl', source: { text: '' }, data: {}, config: {} }));
    assert.strictEqual(vm.optionPanes[0].choices.find((c) => c.selected).value, 'josl', 'the default');
  });

  it('a single-panel result is not tabbed; the active panel is that one panel', () => {
    const vm = playViewModel(state());
    assert.strictEqual(vm.result.tabbed, false, 'one panel → no tab strip');
    assert.strictEqual(vm.result.tabs.length, 1);
    assert.strictEqual(vm.result.activePanel.isCode, true);
    assert.strictEqual(vm.result.activePanel.text, '["Ada","Alan"]');
  });

  it('shapes a visual result as a single view panel (a vnode, no code)', () => {
    const vm = playViewModel(state({
      result: { ok: true, panels: [{ id: 'preview', label: 'Preview', kind: 'view', vnode: ['svg', {}, 'x'] }], timing: { compileMs: 0.1, runMs: 0 }, error: null },
    }));
    assert.strictEqual(vm.result.activePanel.isView, true);
    assert.strictEqual(vm.result.activePanel.isCode, false);
    assert.deepStrictEqual(vm.result.activePanel.vnode, ['svg', {}, 'x']);
  });

  it('a multi-panel result is tabbed; the active panel follows state.play.panel, else the first', () => {
    const panels = [
      { id: 'summary', label: 'Summary', kind: 'note', tone: 'warn', text: 'two repairs' },
      { id: 'rows', label: 'Rows (2)', kind: 'table', depth: 'deep', columns: ['a', 'b'], rows: [['1', '2']] },
      { id: 'roundtrip', label: 'CSV round-trip', kind: 'code', depth: 'deep', text: 'a,b\r\n1,2\r\n' },
    ];
    const result = { ok: true, panels, timing: { compileMs: 0.1, runMs: 0.1 }, error: null };
    // default: no panel chosen → the first (the summary note) is active
    const first = playViewModel(state({ result, panel: null }));
    assert.strictEqual(first.result.tabbed, true);
    assert.deepStrictEqual(first.result.tabs.map((t) => t.id), ['summary', 'rows', 'roundtrip']);
    assert.strictEqual(first.result.activePanel.id, 'summary');
    assert.strictEqual(first.result.activePanel.isNote, true);
    assert.strictEqual(first.result.activePanel.noteClass, 'jplay-note warn');
    // choosing the table tab makes it active, with column/cell records
    const onTable = playViewModel(state({ result, panel: 'rows' }));
    assert.strictEqual(onTable.result.activePanel.id, 'rows');
    assert.strictEqual(onTable.result.activePanel.isTable, true);
    assert.deepStrictEqual(onTable.result.activePanel.columns, [{ label: 'a' }, { label: 'b' }]);
    assert.deepStrictEqual(onTable.result.activePanel.rows, [{ cells: [{ text: '1' }, { text: '2' }] }]);
    // a STALE panel id (the screen is gone) falls back to the first
    const stale = playViewModel(state({ result, panel: 'does-not-exist' }));
    assert.strictEqual(stale.result.activePanel.id, 'summary');
    assert.strictEqual(stale.result.tabs.find((t) => t.active).id, 'summary');
  });
});

describe('the play JSLT view renders headlessly', () => {
  it('produces a vnode with the rail, the editors, the switcher and the result', () => {
    const out = JSON.stringify(renderPlay(playViewModel(state())));
    assert.match(out, /jplay/);
    assert.match(out, /play\/example/);   // a rail example button
    assert.match(out, /play\/source/);    // the source editor
    assert.match(out, /play\/data/);      // the data editor
    assert.match(out, /play\/dataset/);   // the switcher (path-shapes has 3 datasets)
    assert.match(out, /Ada/);                // the run result on the stage
  });

  it('splices a rendered vnode for a visual engine, with no code block or tabs', () => {
    const out = JSON.stringify(renderPlay(playViewModel(state({
      engine: 'markdown', exampleId: 'md-tour', source: { source: '# Hi' }, data: {},
      result: { ok: true, panels: [{ id: 'preview', label: 'Preview', kind: 'view', vnode: ['div', { class: 'md-preview' }, 'Hi'] }], timing: { compileMs: 0.1, runMs: 0 }, error: null },
    }))));
    assert.match(out, /jplay-view/, 'the rendered-view container');
    assert.match(out, /md-preview/, 'the host vnode was spliced in verbatim');
    assert.doesNotMatch(out, /code-block/, 'no code block for a visual result');
    assert.doesNotMatch(out, /jplay-tabs/, 'a single panel shows no tab strip');
  });

  it('renders a tab strip + the active panel body for a multi-panel (CSV) result', () => {
    const panels = [
      { id: 'summary', label: 'Summary', kind: 'note', tone: 'warn', text: 'one repair' },
      { id: 'rows', label: 'Rows (1)', kind: 'table', depth: 'deep', columns: ['a', 'b'], rows: [['1', '2']] },
      { id: 'roundtrip', label: 'CSV round-trip', kind: 'code', depth: 'deep', text: 'a,b\r\n1,2\r\n' },
    ];
    const result = { ok: true, panels, timing: { compileMs: 0.1, runMs: 0.1 }, error: null };
    const first = JSON.stringify(renderPlay(playViewModel(state({ engine: 'csv', result, panel: null }))));
    assert.match(first, /jplay-tabs/, 'the tab strip renders');
    assert.match(first, /play\/panel/, 'each tab dispatches play/panel');
    assert.match(first, /jplay-note warn/, 'the active summary note renders by kind');
    assert.doesNotMatch(first, /jplay-table/, 'the inactive table body is not rendered');
    // switch to the table tab: the <table> renders, the note does not
    const onTable = JSON.stringify(renderPlay(playViewModel(state({ engine: 'csv', result, panel: 'rows' }))));
    assert.match(onTable, /jplay-table/, 'the table body renders when its tab is active');
    assert.match(onTable, /<th>|"th"/, 'with header cells');
  });

  it('renders an option select for a source-only engine (josl)', () => {
    const out = JSON.stringify(renderPlay(playViewModel(state({
      engine: 'josl', exampleId: 'josl-toml', source: { text: 'x = 1\n' }, data: {}, config: { mode: 'toml' },
    }))));
    assert.match(out, /play\/option/);    // the mode select dispatches play/option
    assert.match(out, /select/);             // it is a <select>
    assert.doesNotMatch(out, /play\/data"/); // no data editor for a source-only engine
  });
});

describe('the component surface', () => {
  it('createPlayComponent composes the view, derivation and engine surface', () => {
    const c = createPlayComponent();
    assert.strictEqual(c.mode, 'play');
    assert.ok(Array.isArray(c.rules));
    assert.ok(c.engineIds().includes('query'));
    assert.strictEqual(typeof c.runExample, 'function');
    assert.strictEqual(c.viewModel(state()).engine.label, 'JSONPath');
  });
});
