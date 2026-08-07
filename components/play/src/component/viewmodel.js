//@ts-check
/**
 * @file `playViewModel(state)` — the playground's pure derivation. From
 * the `state.play` slice it derives the example rail (the picker, grouped
 * by engine — the "file-picker of sorts"), the active engine's source
 * editors, the dataset switcher, the data editors, and the run result for
 * the stage. Pure: nothing here is stored back in state.
 */
import { ENGINES, EXAMPLES } from '../index.js';

const formatMs = (ms) => (typeof ms !== 'number' ? '—' : ms < 0.01 ? '<0.01 ms' : `${ms.toFixed(2)} ms`);

/**
 * Shape one panel for the view: kind flags for the `$if` dispatch plus the
 * per-kind content (a `table` becomes column/cell records the JSLT can walk).
 */
function shapePanel(p) {
  const kind = p.kind;
  const base = {
    id: p.id, label: p.label ?? p.id, kind,
    isCode: kind === 'code', isView: kind === 'view', isTable: kind === 'table', isNote: kind === 'note',
  };
  if (kind === 'view') return { ...base, vnode: p.vnode ?? null };
  if (kind === 'note') return { ...base, text: p.text ?? '', noteClass: `jplay-note ${p.tone ?? 'info'}` };
  if (kind === 'table') return {
    ...base,
    columns: (p.columns ?? []).map((label) => ({ label: String(label) })),
    rows: (p.rows ?? []).map((cells) => ({ cells: (cells ?? []).map((text) => ({ text: String(text) })) })),
  };
  return { ...base, text: p.text ?? '' }; // code
}

/**
 * Derive the run result for the stage. `panels` becomes a tab strip (when
 * >1) plus the single ACTIVE panel body. The active panel is the one the
 * host asked for (`state.play.panel`) when it still exists in this result,
 * else the first — so a fresh result with different screens never strands
 * the view on a tab that is gone.
 */
function deriveResult(r, wantedId) {
  const panels = Array.isArray(r.panels) ? r.panels : [];
  const activeId = panels.some((p) => p.id === wantedId) ? wantedId : (panels[0]?.id ?? null);
  const active = panels.find((p) => p.id === activeId) ?? null;
  return {
    ran: true,
    ok: r.ok === true,
    error: r.error ? { code: r.error.code ?? '', message: r.error.message ?? '' } : null,
    timing: r.timing ? `compiled ${formatMs(r.timing.compileMs)} · ran ${formatMs(r.timing.runMs)}` : null,
    tabbed: panels.length > 1,
    tabs: panels.map((p) => ({ id: p.id, label: p.label ?? p.id, active: p.id === activeId })),
    activePanel: active ? shapePanel(active) : null,
  };
}

/**
 * @param {{ play?: any }} state
 * @returns {any}
 */
export function playViewModel(state) {
  const s = state.play ?? {};
  const engineId = s.engine ?? EXAMPLES[0]?.engine ?? '';
  const engine = ENGINES[engineId] ?? null;

  // the rail: examples grouped by engine (a folder per engine)
  const groups = new Map();
  for (const ex of EXAMPLES) {
    if (!groups.has(ex.engine)) groups.set(ex.engine, []);
    groups.get(ex.engine).push(ex);
  }
  const rail = [...groups.entries()].map(([id, exs]) => ({
    engine: id,
    label: ENGINES[id]?.label ?? id,
    active: id === engineId,
    examples: exs.map((ex) => ({ id: ex.id, label: ex.label, active: ex.id === s.exampleId })),
  }));

  const sourcePanes = (engine?.sourcePanes ?? []).map((p) => ({
    key: p.key, label: p.label, control: p.control ?? 'code', value: s.source?.[p.key] ?? '',
  }));
  const dataPanes = (engine?.dataPanes ?? []).map((p) => ({
    key: p.key, label: p.label, value: s.data?.[p.key] ?? '',
  }));

  // option panes: live mode selects (josl dialect, csv repair/headers/…);
  // the selected value is the host config override or the pane's default
  const config = s.config ?? {};
  const optionPanes = (engine?.optionPanes ?? []).map((p) => ({
    key: p.key, label: p.label,
    choices: p.choices.map((c) => ({ value: c.value, label: c.label, selected: (config[p.key] ?? p.default) === c.value })),
  }));

  const active = EXAMPLES.find((e) => e.id === s.exampleId) ?? null;
  const datasetIndex = s.datasetIndex ?? 0;
  const datasets = (active?.datasets ?? []).map((ds, i) => ({ index: i, label: ds.label, active: i === datasetIndex }));

  const r = s.result ?? null;
  const result = r === null ? { ran: false } : deriveResult(r, s.panel);

  // the IDE half (PLAY_04): the saveable-session chrome
  const names = Array.isArray(s.names) ? s.names : [];
  const ratio = typeof s.ratio === 'number' ? s.ratio : 0.5;

  // the generated-form half (PLAY_05b): the validate engine's data pane can
  // swap the JSON textarea for a schema-generated form. The form tree itself
  // (`dataForm`) is host-supplied (it needs @jarenjs/forms) — the package only
  // decides WHEN to show it.
  const hasForm = engineId === 'validate';
  const dataView = s.dataView === 'form' ? 'form' : 'json';

  return {
    engine: { id: engineId, label: engine?.label ?? engineId, lead: engine?.lead ?? '' },
    active: active ? { id: active.id, label: active.label } : null,
    rail,
    optionPanes,
    sourcePanes,
    dataPanes,
    datasets,
    hasSwitcher: datasets.length >= 2,
    result,
    // IDE chrome: the session name, the saved list, the last share status,
    // and the editor|result split (the shared splitter reads `ratio`)
    name: s.name ?? '',
    names: names.map((n) => ({ name: n, active: n === s.name })),
    hasSaved: names.length > 0,
    shared: s.shared ?? null,
    ratio,
    ratioPct: String(Math.round(ratio * 100)),
    // the form/JSON toggle (validate only); `showForm` gates the form seam
    hasForm,
    dataView,
    showForm: hasForm && dataView === 'form',
  };
}
