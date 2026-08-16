//@ts-check
/**
 * @file `playViewModel(state)` — the playground's pure derivation. From
 * the `state.play` slice it derives the example rail (the picker, grouped
 * by engine — the "file-picker of sorts"), the active engine's source
 * editors, the dataset switcher, the data editors, and the run result for
 * the stage. Pure: nothing here is stored back in state.
 */
import { pickAllowed } from '@jarenjs/core/array';
import { ENGINES, EXAMPLES } from '../index.js';
import { formatMs } from '../format.js';

/** The phone panes, in switcher order. */
const MOBILE_PANES = ['examples', 'editor', 'result'];

/**
 * The timing line, built only from the phases that were actually measured.
 * A `null` half means "no such phase" (patch merge has nothing to compile)
 * or "the host did not report it" — either way it is omitted rather than
 * printed as `0 ms`, which read as "rendering was free".
 */
function formatTiming(timing) {
  if (!timing) return null;
  const parts = [];
  if (typeof timing.compileMs === 'number') parts.push(`compiled ${formatMs(timing.compileMs)}`);
  if (typeof timing.runMs === 'number') parts.push(`ran ${formatMs(timing.runMs)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The location an error states, as the phrase a pane label carries — one
 * per family, in the wording the compilers' own messages use: a JSON
 * Pointer (`at /rules/3`; the root pointer `''` reads "at the root"), a
 * 0-based source offset (`at position 7`), or a 1-based line and column
 * (`at line 2, column 5`). Empty when the error states no location.
 */
function formatWhere(err) {
  if (!err) return '';
  const parts = [];
  if (typeof err.path === 'string') parts.push(`at ${err.path === '' ? 'the root' : err.path}`);
  if (typeof err.position === 'number') parts.push(`at position ${err.position}`);
  if (typeof err.line === 'number') {
    parts.push(`at line ${err.line}${typeof err.column === 'number' ? `, column ${err.column}` : ''}`);
  }
  return parts.join(', ');
}

/**
 * The error's claim on one editor pane. The pane the error names is
 * INVALID (its text is what failed — the compile, the run, or a JSON parse)
 * and carries the location phrase; a data pane is not invalid when a
 * runtime error merely failed AT a location in it (a patch op removing a
 * path the target lacks blames the op, not the target), yet that location
 * is the lesson, so the data pane carries it as `where` without the flag.
 * @returns {{ invalid: boolean, where: string }}
 */
function paneError(err, key, isData) {
  if (!err) return { invalid: false, where: '' };
  if (err.pane === key) return { invalid: true, where: formatWhere(err) };
  if (isData && typeof err.dataPath === 'string') {
    return { invalid: false, where: `at ${err.dataPath === '' ? 'the root' : err.dataPath}` };
  }
  return { invalid: false, where: '' };
}

/**
 * The stage's error line. `code` is shown as its own chip, so a message
 * that begins with that same code (the coded family composes
 * `code: reason at path`) drops the prefix rather than reading it twice;
 * `paneLabel` names the editor the error is about (the pane's LABEL, for
 * a reader), empty when no pane owns it.
 */
function deriveError(err, panes) {
  if (!err) return null;
  const code = err.code ?? '';
  const message = err.message ?? '';
  const prefix = `${code}: `;
  const text = code !== '' && message.startsWith(prefix) ? message.slice(prefix.length) : message;
  const pane = typeof err.pane === 'string' ? panes.find((p) => p.key === err.pane) : undefined;
  return { code, message, text, paneLabel: pane?.label ?? '' };
}

/**
 * Shape one panel for the view: kind flags for the `$if` dispatch plus the
 * per-kind content (a `table` becomes column/cell records the JSLT can walk).
 */
function shapePanel(p) {
  const kind = p.kind;
  const base = {
    id: p.id, label: p.label ?? p.id, kind,
    isCode: kind === 'code', isView: kind === 'view', isTable: kind === 'table',
    isNote: kind === 'note', isCards: kind === 'cards',
  };
  if (kind === 'view') return { ...base, vnode: p.vnode ?? null };
  if (kind === 'note') return { ...base, text: p.text ?? '', noteClass: `jplay-note ${p.tone ?? 'info'}` };
  if (kind === 'table') return {
    ...base,
    columns: (p.columns ?? []).map((label) => ({ label: String(label) })),
    rows: (p.rows ?? []).map((cells) => ({ cells: (cells ?? []).map((text) => ({ text: String(text) })) })),
  };
  if (kind === 'cards') return {
    ...base,
    items: (p.items ?? []).map((i) => ({ title: String(i.title), value: String(i.value), note: i.note ?? '' })),
  };
  return { ...base, text: p.text ?? '' }; // code
}

/**
 * Derive the run result for the stage. The `simple` panels are the calm
 * default: they become a tab strip (when >1) plus the single ACTIVE panel
 * body. The `deep` panels — the engine's rich explainers — stay hidden
 * until the student toggles the drill-down (`state.play.deep`); then they
 * form their OWN tab row (`deepPick` selects among several). Each active
 * panel is the one the host asked for when it still exists in this result,
 * else the first — so a fresh result with different screens never strands
 * the view on a tab that is gone.
 */
function deriveResult(r, wantedId, deepWanted, deepPick, panes) {
  const all = Array.isArray(r.panels) ? r.panels : [];
  const panels = all.filter((p) => p.depth !== 'deep');
  const deep = all.filter((p) => p.depth === 'deep');
  const activeId = panels.some((p) => p.id === wantedId) ? wantedId : (panels[0]?.id ?? null);
  const active = panels.find((p) => p.id === activeId) ?? null;
  const hasDeep = deep.length > 0;
  const deepOn = hasDeep && deepWanted === true;
  const deepId = deep.some((p) => p.id === deepPick) ? deepPick : (deep[0]?.id ?? null);
  const activeDeep = deep.find((p) => p.id === deepId) ?? null;
  return {
    ran: true,
    ok: r.ok === true,
    error: deriveError(r.error, panes),
    timing: formatTiming(r.timing),
    tabbed: panels.length > 1,
    tabs: panels.map((p) => ({ id: p.id, label: p.label ?? p.id, active: p.id === activeId })),
    activePanel: active ? shapePanel(active) : null,
    // the drill-deeper half: the affordance, its state, and the deep screens
    hasDeep,
    deepOn,
    deepNext: !deepOn,
    deepLabel: deepOn ? 'Explain ▾' : 'Explain ▸',
    deepTabbed: deep.length > 1,
    deepTabs: deep.map((p) => ({ id: p.id, label: p.label ?? p.id, active: p.id === deepId })),
    deepPanel: deepOn && activeDeep ? shapePanel(activeDeep) : null,
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

  // the editors, each carrying the last error's claim on it (an invalid
  // flag + a location phrase) so the pane the learner has to fix says so
  const err = s.result?.error ?? null;
  const sourcePanes = (engine?.sourcePanes ?? []).map((p) => ({
    key: p.key, label: p.label, control: p.control ?? 'code', value: s.source?.[p.key] ?? '',
    ...paneError(err, p.key, false),
  }));
  const dataPanes = (engine?.dataPanes ?? []).map((p) => ({
    key: p.key, label: p.label, value: s.data?.[p.key] ?? '',
    ...paneError(err, p.key, true),
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
  const result = r === null ? { ran: false } : deriveResult(r, s.panel, s.deep, s.deepPick, [...sourcePanes, ...dataPanes]);

  // the IDE half: the saveable-session chrome
  const names = Array.isArray(s.names) ? s.names : [];
  const ratio = typeof s.ratio === 'number' ? s.ratio : 0.5;

  // the generated-form half: the validate engine's data pane can
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
    // the record this session is bound to, and whether the title has been
    // edited away from it. Without this the two save buttons look
    // identical: the hint is what tells the reader that Save lands on the
    // record they opened and Save As lands on the name they just typed.
    savedName: s.savedName ?? null,
    renamed: s.savedName != null && (s.name ?? '') !== s.savedName,
    shared: s.shared ?? null,
    ratio,
    ratioPct: String(Math.round(ratio * 100)),
    // the form/JSON toggle (validate only); `showForm` gates the form seam
    hasForm,
    dataView,
    showForm: hasForm && dataView === 'form',
    // the phone layout: one pane at a time behind a segmented switcher
    // (Examples · Editor · Result); desktop ignores it (CSS)
    mobilePane: pickAllowed(s.mobilePane, MOBILE_PANES, 'editor'),
  };
}
