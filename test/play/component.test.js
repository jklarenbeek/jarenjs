//@ts-check
/**
 * @file The play COMPONENT, headless: the pure view-model derivation
 * (rail grouped by engine, source/data editors, the dataset switcher, the
 * result) and the JSLT view rendering a real vnode over it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createPlayComponent, playViewModel, playRules, playModes, runExample,
} from '@jarenjs/play/component';
import { compileJsltStylesheet, createJsltRegistry, mathPack } from '@jarenjs/json/jslt';

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

  it('derives the phone pane (editor by default; only known values pass)', () => {
    assert.strictEqual(playViewModel(state()).mobilePane, 'editor');
    assert.strictEqual(playViewModel(state({ mobilePane: 'result' })).mobilePane, 'result');
    assert.strictEqual(playViewModel(state({ mobilePane: 'examples' })).mobilePane, 'examples');
    assert.strictEqual(playViewModel(state({ mobilePane: 'bogus' })).mobilePane, 'editor');
  });

  it('exposes the validate form/JSON toggle (hasForm/dataView/showForm)', () => {
    assert.strictEqual(playViewModel(state({ engine: 'path' })).hasForm, false, 'non-validate has no toggle');
    const json = playViewModel(state({ engine: 'validate', dataView: 'json' }));
    assert.strictEqual(json.hasForm, true);
    assert.strictEqual(json.showForm, false, 'JSON mode does not show the form seam');
    const form = playViewModel(state({ engine: 'validate', dataView: 'form' }));
    assert.strictEqual(form.showForm, true, 'form mode shows the form seam');
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

  it('the SIMPLE panels drive the tab strip; the active one follows state.play.panel, else the first', () => {
    const panels = [
      { id: 'summary', label: 'Summary', kind: 'note', tone: 'warn', text: 'two repairs' },
      { id: 'verdict', label: 'Verdict', kind: 'note', tone: 'ok', text: 'fine' },
      { id: 'rows', label: 'Rows (2)', kind: 'table', depth: 'deep', columns: ['a', 'b'], rows: [['1', '2']] },
    ];
    const result = { ok: true, panels, timing: { compileMs: 0.1, runMs: 0.1 }, error: null };
    // default: no panel chosen → the first SIMPLE panel is active; the deep
    // table is NOT a tab in the calm strip
    const first = playViewModel(state({ result, panel: null }));
    assert.strictEqual(first.result.tabbed, true);
    assert.deepStrictEqual(first.result.tabs.map((t) => t.id), ['summary', 'verdict']);
    assert.strictEqual(first.result.activePanel.id, 'summary');
    assert.strictEqual(first.result.activePanel.isNote, true);
    assert.strictEqual(first.result.activePanel.noteClass, 'jplay-note warn');
    // choosing the second tab makes it active
    const second = playViewModel(state({ result, panel: 'verdict' }));
    assert.strictEqual(second.result.activePanel.id, 'verdict');
    // a STALE panel id (the screen is gone) falls back to the first
    const stale = playViewModel(state({ result, panel: 'does-not-exist' }));
    assert.strictEqual(stale.result.activePanel.id, 'summary');
    assert.strictEqual(stale.result.tabs.find((t) => t.active).id, 'summary');
  });

  it('deep panels hide behind the depth toggle; deepPick selects among several', () => {
    const panels = [
      { id: 'summary', label: 'Summary', kind: 'note', tone: 'ok', text: 'clean' },
      { id: 'rows', label: 'Rows (1)', kind: 'table', depth: 'deep', columns: ['a', 'b'], rows: [['1', '2']] },
      { id: 'roundtrip', label: 'CSV round-trip', kind: 'code', depth: 'deep', text: 'a,b\r\n1,2\r\n' },
    ];
    const result = { ok: true, panels, timing: { compileMs: 0.1, runMs: 0.1 }, error: null };
    // default: calm — the deep panels exist but do not render
    const calm = playViewModel(state({ result }));
    assert.strictEqual(calm.result.hasDeep, true, 'the affordance is offered');
    assert.strictEqual(calm.result.deepOn, false, 'but the drill-down is closed');
    assert.strictEqual(calm.result.deepNext, true, 'the toggle would open it');
    assert.strictEqual(calm.result.deepPanel, null, 'no deep panel body when closed');
    assert.strictEqual(calm.result.tabbed, false, 'one simple panel → no calm tab strip');
    // toggled on: the first deep panel is active, its own tab row derives
    const open = playViewModel(state({ result, deep: true }));
    assert.strictEqual(open.result.deepOn, true);
    assert.strictEqual(open.result.deepNext, false, 'the toggle would close it');
    assert.strictEqual(open.result.deepTabbed, true);
    assert.deepStrictEqual(open.result.deepTabs.map((t) => t.id), ['rows', 'roundtrip']);
    assert.strictEqual(open.result.deepPanel.id, 'rows');
    assert.strictEqual(open.result.deepPanel.isTable, true);
    assert.deepStrictEqual(open.result.deepPanel.columns, [{ label: 'a' }, { label: 'b' }]);
    assert.deepStrictEqual(open.result.deepPanel.rows, [{ cells: [{ text: '1' }, { text: '2' }] }]);
    // deepPick selects among several; a stale pick falls back to the first
    const picked = playViewModel(state({ result, deep: true, deepPick: 'roundtrip' }));
    assert.strictEqual(picked.result.deepPanel.id, 'roundtrip');
    assert.strictEqual(picked.result.deepPanel.isCode, true);
    const stale = playViewModel(state({ result, deep: true, deepPick: 'gone' }));
    assert.strictEqual(stale.result.deepPanel.id, 'rows');
  });

  it('a result with no deep panels offers no affordance; a cards panel shapes its items', () => {
    const plain = playViewModel(state());
    assert.strictEqual(plain.result.hasDeep, false, 'a single code panel has nothing to drill into');
    const result = {
      ok: true, timing: { compileMs: 0.1, runMs: 0.1 }, error: null,
      panels: [
        { id: 'out', label: 'Output', kind: 'code', text: '[]' },
        { id: 'how', label: 'How it matched', kind: 'cards', depth: 'deep',
          items: [{ title: 'Matches', value: '2' }, { title: 'Run', value: '0.1 ms', note: 'per run' }] },
      ],
    };
    const vm = playViewModel(state({ result, deep: true }));
    assert.strictEqual(vm.result.deepPanel.isCards, true);
    assert.deepStrictEqual(vm.result.deepPanel.items[0], { title: 'Matches', value: '2', note: '' });
    assert.deepStrictEqual(vm.result.deepPanel.items[1], { title: 'Run', value: '0.1 ms', note: 'per run' });
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
    // the phone pane switcher renders (CSS shows it below the breakpoint)
    assert.match(out, /jplay-mobilebar/);
    assert.match(out, /play\/mobile-pane/);
    assert.match(out, /"data-pane":"editor"/, 'the root carries the active pane for the CSS');
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

  it('renders the calm note + the depth toggle for a CSV result; the drill-down opens its own tab row', () => {
    const panels = [
      { id: 'summary', label: 'Summary', kind: 'note', tone: 'warn', text: 'one repair' },
      { id: 'rows', label: 'Rows (1)', kind: 'table', depth: 'deep', columns: ['a', 'b'], rows: [['1', '2']] },
      { id: 'roundtrip', label: 'CSV round-trip', kind: 'code', depth: 'deep', text: 'a,b\r\n1,2\r\n' },
    ];
    const result = { ok: true, panels, timing: { compileMs: 0.1, runMs: 0.1 }, error: null };
    const calm = JSON.stringify(renderPlay(playViewModel(state({ engine: 'csv', result, panel: null }))));
    assert.match(calm, /jplay-note warn/, 'the summary note renders by kind');
    assert.doesNotMatch(calm, /jplay-tabs/, 'one simple panel → no calm tab strip');
    assert.match(calm, /jplay-deep-toggle/, 'the quiet Explain affordance renders beneath the answer');
    assert.match(calm, /play\/deep/, 'the affordance dispatches the depth toggle');
    assert.doesNotMatch(calm, /jplay-table/, 'the deep table body stays hidden while calm');
    // toggled on: the deep tab row + the active deep panel render, the simple
    // answer stays in the tree (the phone swap is CSS, not structure)
    const open = JSON.stringify(renderPlay(playViewModel(state({ engine: 'csv', result, deep: true }))));
    assert.match(open, /jplay-result deep-on/, 'the open drill-down marks the result container');
    assert.match(open, /jplay-deep-tabs/, 'several deep panels → their own tab row');
    assert.match(open, /play\/deep-pick/, 'each deep tab dispatches the pick');
    assert.match(open, /jplay-deep-back/, 'the ← back affordance for the phone swap');
    assert.match(open, /jplay-table/, 'the first deep panel (the table) renders');
    assert.match(open, /jplay-note warn/, 'the simple answer is still in the tree beside it');
    // picking the round-trip: the code panel renders instead of the table
    const picked = JSON.stringify(renderPlay(playViewModel(state({ engine: 'csv', result, deep: true, deepPick: 'roundtrip' }))));
    assert.match(picked, /code-block/, 'the picked deep code panel renders');
    assert.doesNotMatch(picked, /jplay-table/, 'the unpicked deep table does not');
  });

  it('renders a cards drill-down as stat cards', () => {
    const result = {
      ok: true, timing: { compileMs: 0.1, runMs: 0.1 }, error: null,
      panels: [
        { id: 'out', label: 'Output', kind: 'code', text: '["A"]' },
        { id: 'how', label: 'How it matched', kind: 'cards', depth: 'deep',
          items: [{ title: 'Matches', value: '1' }, { title: 'Compile', value: '0.1 ms' }] },
      ],
    };
    const open = JSON.stringify(renderPlay(playViewModel(state({ result, deep: true }))));
    assert.match(open, /jplay-cards/, 'the cards row renders');
    assert.match(open, /jplay-card-title/, 'each card has its title');
    assert.match(open, /Matches/, 'with the stat name');
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

describe('the factory seams are defaults, not decoration', () => {
  // Configuring a seam at the factory and having it ignored at run time is
  // the trap this pins: a host that registers its operator packs here must
  // not watch $mean go missing when the engine runs.
  // the real registry, so the test proves the actual seam contract
  // (`.toOptions()` → `{ extensions, functions }`) rather than a guess
  const OPERATORS = createJsltRegistry().use(mathPack);

  it('a factory renderer reaches a visual engine with no per-call options', function () {
    const bare = createPlayComponent();
    const withSeam = createPlayComponent({
      renderers: { markdown: () => ({ vnode: ['p', {}, 'rendered'] }) },
    });
    assert.strictEqual(bare.runExample('markdown', { source: '# hi' }, {}).error?.code,
      'PLAY_NO_RENDERER', 'without the seam the engine refuses honestly');
    assert.strictEqual(withSeam.runExample('markdown', { source: '# hi' }, {}).ok, true,
      'the factory renderer is used with no per-call options');
  });

  it('a per-call option still wins over the factory default', function () {
    const component = createPlayComponent({
      renderers: { markdown: () => ({ vnode: ['p', {}, 'factory'] }) },
    });
    const result = component.runExample('markdown', { source: '# hi' }, {}, {
      renderers: { markdown: () => ({ vnode: ['p', {}, 'per-call'] }) },
    });
    assert.strictEqual(result.ok, true);
    assert.match(JSON.stringify(result.panels), /per-call/, 'the call-site renderer won');
  });

  it('factory operators reach the query engine', function () {
    const component = createPlayComponent({ operators: OPERATORS });
    const result = component.runExample('query',
      { query: '{"n":{"$sqrt":"$.n"}}', externals: '' }, { data: '{"n":49}' });
    assert.strictEqual(result.ok, true, 'the registered operator compiled');
    assert.match(JSON.stringify(result.panels), /7/, 'and ran');
  });
});

describe('timings are measured, never fabricated', () => {
  // The stage used to print "ran 0ms" for every visual engine, which told
  // the reader rendering was free. A phase that was not measured, or does
  // not exist, must now say nothing at all.
  it('a renderer reporting its phases gets both printed', function () {
    const component = createPlayComponent({
      renderers: { markdown: () => ({ vnode: ['p', {}, 'x'], compileMs: 1.5, runMs: 2.5 }) },
    });
    const result = component.runExample('markdown', { source: '# hi' }, {});
    assert.deepStrictEqual(result.timing, { compileMs: 1.5, runMs: 2.5 });
    const vm = playViewModel({ play: { engine: 'markdown', result } });
    assert.match(vm.result.timing, /compiled .* · ran /);
  });

  it('a renderer reporting nothing attributes the wall clock to the RUN, not a compile', function () {
    const component = createPlayComponent({
      renderers: { markdown: () => ['p', {}, 'x'] },
    });
    const { timing } = component.runExample('markdown', { source: '# hi' }, {});
    assert.strictEqual(timing.compileMs, null, 'no compile figure is invented');
    assert.strictEqual(typeof timing.runMs, 'number', 'the measured total is the run');
  });

  it('an engine with no compile step reports null, and the line omits it', function () {
    const { timing } = runExample('patch',
      { patch: '{"b":2}' }, { data: '{"a":1}' }, { config: { mode: 'merge' } });
    assert.strictEqual(timing.compileMs, null, 'a merge patch compiles nothing');
    assert.strictEqual(typeof timing.runMs, 'number');
    const vm = playViewModel({ play: { engine: 'patch', result: { ok: true, timing, panels: [], error: null } } });
    assert.ok(!vm.result.timing.includes('compiled'), 'no compile clause');
    assert.match(vm.result.timing, /^ran /);
  });
});
