//@ts-check
/**
 * @file The Calculator COMPONENT — part two of the package (design
 * decisions D1/D4/D10). Everything here is presentation + app glue; the
 * engine knows none of it. `createCalcComponent(options)` returns the
 * pieces the site (and a standalone `createApp`) compose into one
 * `@jarenjs/app` document:
 *
 *  - `initialState()` — the plain-JSON `$.calc` slice (immutable, COW).
 *  - `actions` — key/mode/plot/converter action query documents + the
 *    financial `@jarenjs/forms` write actions.
 *  - `mode` + `rules` — the JSLT `calculator` view (keypad, display, tape,
 *    mode menu, plot panel, financial form, converter).
 *  - `effects` / `subs` / `subEntry` — the live-rates effect + `when`-gated
 *    poll (D13); the pure conversion stays in `@jarenjs/core/convert`.
 *  - `viewModel(state)` (a.k.a. `contributeCalcViewModel`) — the derivation
 *    boundary: display string, live result, four-base views, plot vnode,
 *    forms model, converter options — none of it stored in state.
 *  - `createApp()` — a standalone app document for reuse outside the site.
 *
 * The boundary is one-way: the component imports the engine, never the
 * reverse.
 */

import { createApp as appCreateApp, createFormView, createFormActions } from '@jarenjs/app';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';

import {
  calcToVnode, evaluate, MODE_BY_ID, MODES,
  programmerEnv, defaultEnv, wordViews,
  solveTvm, convertValue, unitOptions, converterDimensions,
} from '../index.js';
import { standardMode } from '../modes/standard.js';
import { BASES, WORD_SIZES } from '../modes/programmer.js';
import { financialMode } from '../modes/financial.js';
import { converterMode } from '../modes/converter.js';
import { createRatesLayer, FALLBACK_RATES, CURRENCY_CODES } from './rates/index.js';
import { CALCULATOR_RULES } from './rules.js';
import { FINANCIAL_SCHEMA } from './schema.js';

const FIN_MODEL = buildFormModel(FINANCIAL_SCHEMA);

/**
 * Namespaced form action names so the financial panel never collides with
 * another `@jarenjs/forms` instance on the same page (e.g. the website's
 * schema playground, which also spreads `createFormActions`).
 */
export const FORM_ACTIONS = {
  input: 'calc-form/input', check: 'calc-form/check', number: 'calc-form/number',
  add: 'calc-form/add', remove: 'calc-form/remove',
};

/** The financial form's view rules (mode 'calculator'), reusable by the site. */
export const calcFormViewRules = createFormView({ root: '$.ui.calculator.financial.form', actions: FORM_ACTIONS })
  .map((rule) => ({ ...rule, mode: 'calculator' }));

/**
 * The initial `$.calc` state slice.
 * @returns {any}
 */
export function calcInitialState() {
  return {
    mode: 'standard',
    entry: '',
    ans: 0,
    memory: 0,
    angleMode: 'rad',
    base: 'DEC',
    wordBits: 32,
    signed: false,
    tape: [],
    plot: { expr: 'sin(x)', kind: '2d' },
    fin: { nper: 360, rate: 0.5, pv: 200000, pmt: 0, fv: 0, solveFor: 'pmt' },
    conv: { dimension: 'currency', from: 'USD', to: 'EUR', value: 100 },
    rates: { ...FALLBACK_RATES },
  };
}

/** The scope for evaluating the entry buffer in a given state. */
function scopeOf(calc) {
  return {
    angleMode: calc.angleMode,
    wordBits: calc.wordBits,
    signed: calc.signed,
    ans: calc.ans,
    mem: calc.memory,
    memory: calc.memory,
  };
}

/** The evaluation env for a mode. */
function envForMode(mode) {
  return mode === 'programmer' ? programmerEnv() : defaultEnv();
}

/** The `on` click binding for a keypad key `k`. */
function keyBinding(k) {
  if (k === 'clear') return { click: { action: 'calc/clear' } };
  if (k === 'back') return { click: { action: 'calc/back' } };
  if (k === 'equals') return { click: { action: 'calc/equals' } };
  return { click: { action: 'calc/key', with: { k } } };
}

/** Project a mode's keypad descriptor into render-ready rows. */
function keypadFor(mode) {
  const desc = MODE_BY_ID[mode];
  const rows = desc && desc.keypad ? desc.keypad : standardMode.keypad;
  return rows.map((row, ri) => ({
    key: 'r' + ri,
    keys: row.map((k) => ({
      key: k.label + ':' + k.k,
      label: k.label,
      cls: 'calc-key' + (k.tone ? ' calc-key-' + k.tone : '') + (k.span ? ' calc-key-span' + k.span : ''),
      on: keyBinding(k.k),
    })),
  }));
}

/**
 * The action query documents. `dataPointer` for the financial form is
 * `/calc/fin`.
 * @returns {Record<string, any>}
 */
export const calcActions = {
  'calc/key': { patch: [{ op: 'replace', path: '/calc/entry', value: { $concat: ['$.calc.entry', '$payload.k'] } }] },
  'calc/clear': { patch: [{ op: 'replace', path: '/calc/entry', value: '' }] },
  'calc/set-entry': { patch: [{ op: 'replace', path: '/calc/entry', value: '$payload' }] },
  'calc/back': { effects: [{ run: 'calc-edit', with: { entry: '$.calc.entry' } }] },
  'calc/equals': {
    effects: [{ run: 'calc-eval', with: {
      entry: '$.calc.entry', mode: '$.calc.mode',
      angleMode: '$.calc.angleMode', wordBits: '$.calc.wordBits',
      signed: '$.calc.signed', ans: '$.calc.ans', memory: '$.calc.memory',
    } }],
  },
  'calc/commit': {
    patch: [
      { op: 'replace', path: '/calc/ans', value: '$payload.value' },
      { op: 'replace', path: '/calc/entry', value: '$payload.display' },
      { op: 'add', path: '/calc/tape/-', value: { expr: '$payload.expr', result: '$payload.display' } },
    ],
  },
  'calc/mode': { patch: [{ op: 'replace', path: '/calc/mode', value: '$payload.mode' }] },
  'calc/angle': { patch: [{ op: 'replace', path: '/calc/angleMode', value: '$payload.mode' }] },
  'calc/base': { patch: [{ op: 'replace', path: '/calc/base', value: '$payload.base' }] },
  'calc/word': { patch: [{ op: 'replace', path: '/calc/wordBits', value: { $number: '$payload.bits' } }] },
  'calc/sign': { patch: [{ op: 'replace', path: '/calc/signed', value: { $if: ['$.calc.signed', false, true] } }] },
  'calc/mem-add': { patch: [{ op: 'replace', path: '/calc/memory', value: { $add: ['$.calc.memory', '$.calc.ans'] } }] },
  'calc/mem-clear': { patch: [{ op: 'replace', path: '/calc/memory', value: 0 }] },
  // plotting
  'calc/plot-expr': { patch: [{ op: 'replace', path: '/calc/plot/expr', value: '$event.value' }] },
  'calc/plot-kind': { patch: [{ op: 'replace', path: '/calc/plot/kind', value: '$payload.kind' }] },
  // converter
  'calc/conv-dim': { patch: [{ op: 'replace', path: '/calc/conv/dimension', value: '$event.value' }] },
  'calc/conv-from': { patch: [{ op: 'replace', path: '/calc/conv/from', value: '$event.value' }] },
  'calc/conv-to': { patch: [{ op: 'replace', path: '/calc/conv/to', value: '$event.value' }] },
  'calc/conv-value': { patch: [{ op: 'replace', path: '/calc/conv/value', value: { $number: '$event.value' } }] },
  'calc/conv-swap': {
    patch: [
      { op: 'replace', path: '/calc/conv/from', value: '$.calc.conv.to' },
      { op: 'replace', path: '/calc/conv/to', value: '$.calc.conv.from' },
    ],
  },
  'calc/rates-refresh': { effects: [{ run: 'rates-fetch', with: { force: true } }] },
  'calc/rates-ok': { patch: [{ op: 'replace', path: '/calc/rates', value: '$payload' }] },
  'calc/rates-err': { patch: [{ op: 'replace', path: '/calc/rates/status', value: 'error' }] },
  // the financial panel writes through the (namespaced) @jarenjs/forms actions
  ...createFormActions({ dataPointer: '/calc/fin', actions: FORM_ACTIONS }),
};

/** All calculator view rules (the calculator UI + the financial form). */
export const calcViewRules = [...CALCULATOR_RULES, ...calcFormViewRules];

export { createRatesLayer, FALLBACK_RATES, CURRENCY_CODES } from './rates/index.js';

/** The `calc-edit` (backspace) and `calc-eval` (=) JS effect handlers. */
export const calcEditEffects = {
  'calc-edit': (props, dispatch) => {
    const entry = String(props?.entry ?? '');
    dispatch('calc/set-entry', entry.slice(0, -1));
  },
  'calc-eval': (props, dispatch) => {
    const entry = String(props?.entry ?? '');
    if (entry === '') return;
    const mode = props.mode ?? 'standard';
    const env = envForMode(mode);
    const scope = {
      angleMode: props.angleMode, wordBits: props.wordBits, signed: props.signed,
      ans: props.ans, mem: props.memory, memory: props.memory,
    };
    const res = evaluate(entry, scope, { env });
    if (!res.ok) return; // leave the entry; the live display shows the error
    const desc = MODE_BY_ID[mode] ?? standardMode;
    const display = desc.format
      ? desc.format(res.value, { angleMode: props.angleMode, wordBits: props.wordBits, signed: props.signed, base: props.base })
      : String(res.value);
    dispatch('calc/commit', { value: res.value, display, expr: entry });
  },
};

/**
 * The viewModel derivation for the calculator (`contributeCalcViewModel`).
 * Pure: state in, UI document out, no dispatching.
 * @param {any} state
 * @param {{ theme?: any }} [options] plot theme (name, overrides, or
 *   `'host'` to follow the embedding host's tokens)
 * @returns {any}
 */
export function contributeCalcViewModel(state, options = {}) {
  const calc = state.calc;
  if (!calc) return null;
  const desc = MODE_BY_ID[calc.mode] ?? standardMode;
  const env = envForMode(calc.mode);
  const scope = scopeOf(calc);

  // live result of the current entry
  const live = calc.entry === '' ? { ok: true, value: calc.ans } : evaluate(calc.entry, scope, { env });
  const display = {
    entry: calc.entry === '' ? '0' : calc.entry,
    result: live.ok ? desc.format(live.value, calc) : '',
    error: live.ok ? null : (live.error.message + (live.error.line ? ` (${live.error.line}:${live.error.column})` : '')),
  };

  // programmer four-base view
  const pv = live.ok && Number.isFinite(live.value) ? live.value : calc.ans;
  const bases = {
    base: calc.base, wordBits: calc.wordBits, signed: calc.signed,
    baseOptions: BASES.map((b) => ({ id: b, label: b, active: b === calc.base, on: { click: { action: 'calc/base', with: { base: b } } } })),
    wordOptions: WORD_SIZES.map((w) => ({ id: String(w), label: w + '-bit', active: w === calc.wordBits, on: { click: { action: 'calc/word', with: { bits: w } } } })),
    signLabel: calc.signed ? 'signed' : 'unsigned',
    views: wordViews(pv, calc.wordBits, calc.signed),
  };

  // financial: reuse @jarenjs/forms model + viewModel; solve via core
  let financial = null;
  if (calc.mode === 'financial') {
    let form = null;
    try { form = buildFormViewModel(FIN_MODEL, calc.fin, { validateFields: true }); }
    catch { form = null; }
    const result = solveTvm({ ...calc.fin });
    financial = { form, solveFor: calc.fin.solveFor, result: financialMode.format(result) };
  }

  // converter: options + live result, all through core/convert
  let converter = null;
  if (calc.mode === 'converter') {
    const dim = calc.conv.dimension;
    const units = unitOptions(dim, calc.rates);
    const result = convertValue(dim, +calc.conv.value, calc.conv.from, calc.conv.to, calc.rates);
    converter = {
      dimension: dim,
      dimensions: converterDimensions().map((d) => ({ id: d, label: d, selected: d === dim })),
      from: calc.conv.from,
      to: calc.conv.to,
      unitsFrom: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.from })),
      unitsTo: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.to })),
      value: calc.conv.value,
      result: converterMode.format(result),
      isCurrency: dim === 'currency',
      rates: { status: calc.rates.status ?? 'idle', stale: calc.rates.stale === true, at: calc.rates.at ?? 0, count: Object.keys(calc.rates.rates ?? {}).length },
    };
  }

  // plot vnode (prebuilt; spliced verbatim into the view)
  let plot = null;
  if (calc.mode !== 'financial' && calc.mode !== 'converter' && calc.mode !== 'programmer') {
    plot = {
      expr: calc.plot.expr,
      kind: calc.plot.kind,
      svg: calcToVnode(calc.plot.expr, { kind: calc.plot.kind, theme: options.theme }),
      kinds: [
        { id: '2d', label: 'x·y', active: calc.plot.kind === '2d', on: { click: { action: 'calc/plot-kind', with: { kind: '2d' } } } },
        { id: '3d', label: 'x·y·z', active: calc.plot.kind === '3d', on: { click: { action: 'calc/plot-kind', with: { kind: '3d' } } } },
      ],
    };
  }

  return {
    mode: calc.mode,
    modes: MODES.map((m) => ({ id: m.id, label: m.label, active: m.id === calc.mode, on: { click: { action: 'calc/mode', with: { mode: m.id } } } })),
    isStandard: calc.mode === 'standard' || calc.mode === 'scientific',
    isScientific: calc.mode === 'scientific',
    isProgrammer: calc.mode === 'programmer',
    isFinancial: calc.mode === 'financial',
    isConverter: calc.mode === 'converter',
    display,
    keypad: keypadFor(calc.mode),
    tape: calc.tape.map((t, i) => ({ key: 'tape' + i, expr: t.expr, result: t.result })),
    memory: calc.memory,
    angle: { mode: calc.angleMode, options: ['rad', 'deg', 'grad'].map((a) => ({ id: a, label: a, active: a === calc.angleMode, on: { click: { action: 'calc/angle', with: { mode: a } } } })) },
    bases,
    financial,
    converter,
    plot,
  };
}

/**
 * Create the calculator component.
 * @param {import('./rates/index.js').RatesLayerOptions} [options]
 * @returns {any}
 */
export function createCalcComponent(options = {}) {
  const rates = createRatesLayer(options);
  const formViewRules = calcFormViewRules;

  return {
    initialState: calcInitialState,
    actions: calcActions,
    mode: 'calculator',
    rules: calcViewRules,
    formRules: formViewRules,
    effects: { ...calcEditEffects, ...rates.effects },
    subs: { ...rates.subs },
    subEntry: rates.subEntry,
    fallbackRates: rates.fallbackRates,
    viewModel: contributeCalcViewModel,
    codes: CURRENCY_CODES,

    /**
     * A standalone app document + running app (headless if `node` omitted).
     * @param {any} [appOptions]
     */
    createApp(appOptions = {}) {
      const appDoc = {
        $app: '0.1',
        state: { calc: calcInitialState() },
        view: {
          $jslt: '0.1',
          modes: { calculator: { unmatched: 'error' } },
          rules: [
            // the entry rule lives in the default (unnamed) mode
            { match: '$', body: ['div', { class: 'jaren-calc-app' }, { $apply: ['$.ui.calculator', 'calculator'] }] },
            ...CALCULATOR_RULES,
            ...formViewRules,
          ],
        },
        actions: calcActions,
        subs: [rates.subEntry],
      };
      return appCreateApp(appDoc, {
        ...appOptions,
        effects: { ...calcEditEffects, ...rates.effects, ...(appOptions.effects ?? {}) },
        subs: { ...rates.subs, ...(appOptions.subs ?? {}) },
        viewModel: (state) => ({ ...state, ui: { calculator: contributeCalcViewModel(state) } }),
      });
    },
  };
}
