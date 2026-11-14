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
import { playText } from '../messages.js';

/** @typedef {(id: string, params?: Record<string, unknown>) => string} Text */

/** A descriptor's label in the reader's language: its message id rendered,
 * or the label itself for a name no language translates. @param {{ label: string, msgid?: string }} d @param {Text} t */
const labelOf = (d, t) => (typeof d.msgid === 'string' ? t(d.msgid) : d.label);

/** The phone panes, in switcher order. */
const MOBILE_PANES = ['examples', 'editor', 'result'];

/**
 * The timing line, built only from the phases that were actually measured.
 * A `null` half means "no such phase" (patch merge has nothing to compile)
 * or "the host did not report it" — either way it is omitted rather than
 * printed as `0 ms`, which read as "rendering was free".
 */
function formatTiming(timing, t) {
  if (!timing) return null;
  const parts = [];
  if (typeof timing.compileMs === 'number') parts.push(t('play/timing/compiled', { ms: formatMs(timing.compileMs) }));
  if (typeof timing.runMs === 'number') parts.push(t('play/timing/ran', { ms: formatMs(timing.runMs) }));
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The location an error states, as the phrase a pane label carries — one
 * per family, in the wording the compilers' own messages use: a JSON
 * Pointer (`at /rules/3`; the root pointer `''` reads "at the root"), a
 * 0-based source offset (`at position 7`), or a 1-based line and column
 * (`at line 2, column 5`). Empty when the error states no location.
 */
function formatWhere(err, t) {
  if (!err) return '';
  const parts = [];
  if (typeof err.path === 'string') parts.push(atPointer(err.path, t));
  if (typeof err.position === 'number') parts.push(t('play/where/position', { position: err.position }));
  if (typeof err.line === 'number') {
    parts.push(typeof err.column === 'number'
      ? t('play/where/line-column', { line: err.line, column: err.column })
      : t('play/where/line', { line: err.line }));
  }
  return parts.join(', ');
}

/** `at /rules/3`, or `at the root` for the root pointer. @param {string} pointer @param {Text} t */
const atPointer = (pointer, t) => (pointer === '' ? t('play/where/root') : t('play/where/path', { path: pointer }));

/**
 * The error's claim on one editor pane. The pane the error names is
 * INVALID (its text is what failed — the compile, the run, or a JSON parse)
 * and carries the location phrase; a data pane is not invalid when a
 * runtime error merely failed AT a location in it (a patch op removing a
 * path the target lacks blames the op, not the target), yet that location
 * is the lesson, so the data pane carries it as `where` without the flag.
 * @returns {{ invalid: boolean, where: string }}
 */
function paneError(err, key, isData, t) {
  if (!err) return { invalid: false, where: '' };
  if (err.pane === key) return { invalid: true, where: formatWhere(err, t) };
  if (isData && typeof err.dataPath === 'string') {
    return { invalid: false, where: atPointer(err.dataPath, t) };
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
function deriveResult(r, wantedId, deepWanted, deepPick, panes, t) {
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
    timing: formatTiming(r.timing, t),
    tabbed: panels.length > 1,
    tabs: panels.map((p) => ({ id: p.id, label: p.label ?? p.id, active: p.id === activeId })),
    activePanel: active ? shapePanel(active) : null,
    // the drill-deeper half: the affordance, its state, and the deep screens
    hasDeep,
    deepOn,
    deepNext: !deepOn,
    deepLabel: deepOn ? t('play/deep/close') : t('play/deep/open'),
    deepTabbed: deep.length > 1,
    deepTabs: deep.map((p) => ({ id: p.id, label: p.label ?? p.id, active: p.id === deepId })),
    deepPanel: deepOn && activeDeep ? shapePanel(activeDeep) : null,
  };
}

/**
 * The playground's chrome in the reader's language: every fixed word the
 * view shows, resolved here so the JSLT view reads `$.t.<name>` (a word
 * with a parameter is rendered with it: the save button's title names the
 * bound session).
 * @param {Text} t @param {any} s - the play slice
 * @param {boolean} renamed
 */
function chromeText(t, s, renamed) {
  return {
    new: t('play/action/new'), save: t('play/action/save'), saveAs: t('play/action/save-as'),
    download: t('play/action/download'), import: t('play/action/import'), share: t('play/action/share'),
    delete: t('play/action/delete'), load: t('play/action/load'), back: t('play/action/back'),
    saveTitle: s.savedName ? t('play/title/overwrite', { name: s.savedName }) : t('play/title/save'),
    saveAsTitle: t('play/title/save-as'), downloadTitle: t('play/title/download'),
    importTitle: t('play/title/import'), deleteTitle: t('play/title/delete'),
    placeholder: t('play/session/placeholder'), sessionName: t('play/session/name'), loadLabel: t('play/session/load'),
    bound: renamed ? t('play/session/bound', { name: s.savedName }) : '',
    panes: t('play/layout/panes'), examples: t('play/layout/examples'), editor: t('play/layout/editor'),
    result: t('play/layout/result'), exampleList: t('play/layout/example-list'), datasets: t('play/layout/datasets'),
    dataView: t('play/layout/data-view'), form: t('play/layout/form'), resize: t('play/layout/resize'),
    hint: t('play/layout/hint'),
  };
}

/**
 * @param {{ play?: any }} state
 * @param {{ messages?: Readonly<Record<string, unknown>> }} [options] -
 *   `messages`: the reader's compiled catalog (see `RunOptions.messages`);
 *   English when absent
 * @returns {any}
 */
export function playViewModel(state, options = {}) {
  const t = playText(options.messages);
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
    label: Object.hasOwn(ENGINES, id) ? labelOf(ENGINES[id], t) : id,
    active: id === engineId,
    examples: exs.map((ex) => ({ id: ex.id, label: ex.label, active: ex.id === s.exampleId })),
  }));

  // the editors, each carrying the last error's claim on it (an invalid
  // flag + a location phrase) so the pane the learner has to fix says so
  const err = s.result?.error ?? null;
  const sourcePanes = (engine?.sourcePanes ?? []).map((p) => ({
    key: p.key, label: labelOf(p, t), control: p.control ?? 'code', value: s.source?.[p.key] ?? '',
    ...paneError(err, p.key, false, t),
  }));
  const dataPanes = (engine?.dataPanes ?? []).map((p) => ({
    key: p.key, label: labelOf(p, t), value: s.data?.[p.key] ?? '',
    ...paneError(err, p.key, true, t),
  }));

  // option panes: live mode selects (josl dialect, csv repair/headers/…);
  // the selected value is the host config override or the pane's default
  const config = s.config ?? {};
  const optionPanes = (engine?.optionPanes ?? []).map((p) => ({
    key: p.key, label: labelOf(p, t),
    choices: p.choices.map((c) => ({ value: c.value, label: labelOf(c, t), selected: (config[p.key] ?? p.default) === c.value })),
  }));

  const active = EXAMPLES.find((e) => e.id === s.exampleId) ?? null;
  const datasetIndex = s.datasetIndex ?? 0;
  const datasets = (active?.datasets ?? []).map((ds, i) => ({ index: i, label: ds.label, active: i === datasetIndex }));

  const r = s.result ?? null;
  const result = r === null ? { ran: false } : deriveResult(r, s.panel, s.deep, s.deepPick, [...sourcePanes, ...dataPanes], t);

  // the IDE half: the saveable-session chrome
  const names = Array.isArray(s.names) ? s.names : [];
  const ratio = typeof s.ratio === 'number' ? s.ratio : 0.5;
  const renamed = s.savedName != null && (s.name ?? '') !== s.savedName;

  // the generated-form half: the validate engine's data pane can
  // swap the JSON textarea for a schema-generated form. The form tree itself
  // (`dataForm`) is host-supplied (it needs @jarenjs/forms) — the package only
  // decides WHEN to show it.
  const hasForm = engineId === 'validate';
  const dataView = s.dataView === 'form' ? 'form' : 'json';

  return {
    engine: { id: engineId, label: (engine === null ? undefined : labelOf(engine, t)) ?? engineId, lead: engine?.lead ?? '' },
    // the fixed words of the chrome, in the reader's language
    t: chromeText(t, s, renamed),
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
    renamed,
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
