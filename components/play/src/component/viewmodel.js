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
  const result = r === null ? { ran: false } : {
    ran: true,
    ok: r.ok === true,
    // a visual engine (markdown/mermaid/charts) yields a `view` vnode and no
    // text; a text engine yields `output` and no view — guard each with a bool
    output: r.output ?? '',
    hasText: (r.output ?? '') !== '',
    view: r.view ?? null,
    hasView: r.view != null,
    error: r.error ? { code: r.error.code ?? '', message: r.error.message ?? '' } : null,
    timing: r.timing ? `compiled ${formatMs(r.timing.compileMs)} · ran ${formatMs(r.timing.runMs)}` : null,
  };

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
  };
}
