//@ts-check
/**
 * @file The Calculator COMPONENT — part two of the package. Everything
 * here is presentation + app glue; the engine knows none of it. `createCalcComponent(options)` returns the
 * pieces the site (and a standalone `createApp`) compose into one
 * `@jarenjs/app` document:
 *
 *  - `initialState()` — the plain-JSON `$.calc` slice (immutable, COW).
 *  - `actions` — key/mode/plot/converter action query documents + the
 *    financial `@jarenjs/forms` write actions.
 *  - `mode` + `rules` — the JSLT `calculator` view (keypad, display, tape,
 *    mode menu, plot panel, financial form, converter).
 *  - `effects` / `subs` / `subEntry` — the live-rates effect + `when`-gated
 *    poll; the pure conversion stays in `@jarenjs/core/convert`.
 *  - `viewModel(state)` (a.k.a. `contributeCalcViewModel`) — the derivation
 *    boundary: display string, live result, four-base views, plot vnode,
 *    forms model, converter options — none of it stored in state.
 *  - `createApp()` — a standalone app document for reuse outside the site.
 *
 * The boundary is one-way: the component imports the engine, never the
 * reverse.
 */

import {
  createApp as appCreateApp, createFormView, createFormActions, formEventFields, FORM_NUMBER_VALUE,
} from '@jarenjs/app';

import { calcToVnode, MODE_BY_ID, MODES, converterDimensions, unitOptions } from '../index.js';
import { fit, toNumber } from '../exact.js';
import { BASES, WORD_SIZES, viewsOf } from '../modes/programmer.js';
import {
  keyChange, changesOf, localizeEntry, previewOf, previewValue, scopeOf, scopeValue, exactText,
} from './entry.js';
import { createRatesLayer, FALLBACK_RATES } from './rates/index.js';
import { CALCULATOR_RULES } from './rules.js';
import { financialView, converterView, carrySolved } from './panels.js';
import { localizeNumber, numberSymbols } from '../format.js';
import { calcText } from '../messages.js';
import { bindCalcKeyboard } from './keyboard.js';

/** The message id of each mode's tab label, by mode id. */
const MODE_LABELS = Object.freeze({
  standard: 'calc/mode/standard', scientific: 'calc/mode/scientific', programmer: 'calc/mode/programmer',
  financial: 'calc/mode/financial', converter: 'calc/mode/converter',
});
/**
 * Namespaced form action names so the financial panel never collides with
 * another `@jarenjs/forms` instance on the same page (e.g. the website's
 * schema playground, which also spreads `createFormActions`).
 */
export const FORM_ACTIONS = {
  input: 'calc-form/input', check: 'calc-form/check', number: 'calc-form/number',
  json: 'calc-form/json', add: 'calc-form/add', remove: 'calc-form/remove',
};

/** The financial form's own write actions (the select's JSON write is wrapped below). */
const FIN_FORM_ACTIONS = createFormActions({ dataPointer: '/calc/fin', actions: FORM_ACTIONS });

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
    fresh: false,
    error: '',
    errorParams: {},
    ans: 0,
    ansExact: '',
    memory: 0,
    memoryExact: '',
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

/** The `on` click binding for a keypad key `k`. */
function keyBinding(k) {
  if (k === 'clear') return { click: { action: 'calc/clear' } };
  if (k === 'back') return { click: { action: 'calc/back' } };
  if (k === 'equals') return { click: { action: 'calc/equals' } };
  return { click: { action: 'calc/key', with: { k } } };
}

/**
 * Project a mode's keypad descriptor into render-ready rows, each key's
 * accessible name in the reader's language; `null` for a mode without a
 * keypad (financial, converter), which shows only its own panel.
 * @param {string} mode
 * @param {(id: string, params?: Record<string, unknown>) => string} t
 * @returns {any[] | null}
 */
function keypadFor(mode, t) {
  const desc = MODE_BY_ID[mode];
  if (!desc || !desc.keypad) return null;
  return desc.keypad.map((/** @type {any[]} */ row, /** @type {number} */ ri) => ({
    key: 'r' + ri,
    keys: row.map((k) => ({
      key: k.label + ':' + k.k,
      label: k.label,
      aria: k.aria === undefined ? undefined : t(k.aria),
      cls: 'calc-key' + (k.tone ? ' calc-key-' + k.tone : '') + (k.span ? ' calc-key-span' + k.span : ''),
      on: keyBinding(k.k),
    })),
  }));
}

/** Static choices come from the converter's unit registry; currency
 * choices are read from the current rate table by the action. */
const CONVERTER_UNIT_IDS = Object.fromEntries(converterDimensions()
  .filter((dimension) => dimension !== 'currency')
  .map((dimension) => [dimension, unitOptions(dimension).map((unit) => unit.id)]));

/**
 * The action query documents. `dataPointer` for the financial form is
 * `/calc/fin`.
 */
export const calcActions = {
  // every key goes through the entry editor (`./entry.js`), an effect
  'calc/key': { effects: [{ run: 'calc-press', with: { k: '$payload.k', calc: '$.calc' } }] },
  'calc/back': { effects: [{ run: 'calc-press', with: { k: 'back', calc: '$.calc' } }] },
  'calc/equals': {
    effects: [{ run: 'calc-eval', with: {
      entry: '$.calc.entry', mode: '$.calc.mode',
      base: '$.calc.base',
      angleMode: '$.calc.angleMode', wordBits: '$.calc.wordBits',
      signed: '$.calc.signed', ans: '$.calc.ans', memory: '$.calc.memory',
      ansExact: '$.calc.ansExact', memoryExact: '$.calc.memoryExact',
      fresh: '$.calc.fresh', error: '$.calc.error',
    } }],
  },
  'calc/clear': {
    patch: [
      { op: 'replace', path: '/calc/entry', value: '' },
      { op: 'add', path: '/calc/fresh', value: false },
      { op: 'add', path: '/calc/error', value: '' },
      { op: 'add', path: '/calc/errorParams', value: {} },
    ],
  },
  // a host's raw entry text: an expression being typed, no result yet
  'calc/set-entry': {
    patch: [
      { op: 'replace', path: '/calc/entry', value: '$payload' },
      { op: 'add', path: '/calc/fresh', value: false },
      { op: 'add', path: '/calc/error', value: '' },
      { op: 'add', path: '/calc/errorParams', value: {} },
    ],
  },
  'calc/entry': {
    patch: [
      { op: 'replace', path: '/calc/entry', value: '$payload.entry' },
      { op: 'add', path: '/calc/fresh', value: '$payload.fresh' },
      { op: 'add', path: '/calc/error', value: '$payload.error' },
      { op: 'add', path: '/calc/errorParams', value: '$payload.errorParams' },
    ],
  },
  'calc/commit': {
    patch: [
      { op: 'replace', path: '/calc/ans', value: '$payload.value' },
      { op: 'add', path: '/calc/ansExact', value: { $if: [{ $exists: '$payload.exact' }, '$payload.exact', ''] } },
      { op: 'replace', path: '/calc/entry', value: { $if: [{ $exists: '$payload.entry' }, '$payload.entry', '$payload.display'] } },
      { op: 'add', path: '/calc/tape/-', value: { expr: '$payload.expr', result: '$payload.display' } },
      { op: 'add', path: '/calc/fresh', value: true },
      { op: 'add', path: '/calc/error', value: '' },
      { op: 'add', path: '/calc/errorParams', value: {} },
    ],
  },
  'calc/mode': { patch: [{ op: 'replace', path: '/calc/mode', value: '$payload.mode' }] },
  'calc/angle': { patch: [{ op: 'replace', path: '/calc/angleMode', value: '$payload.mode' }] },
  'calc/base': { patch: [{ op: 'replace', path: '/calc/base', value: '$payload.base' }] },
  'calc/word': { patch: [{ op: 'replace', path: '/calc/wordBits', value: { $number: '$payload.bits' } }] },
  'calc/sign': { patch: [{ op: 'replace', path: '/calc/signed', value: { $if: ['$.calc.signed', false, true] } }] },
  'calc/mem-add': {
    effects: [{ run: 'calc-mem-add', with: {
      mode: '$.calc.mode',
      ans: '$.calc.ans', ansExact: '$.calc.ansExact',
      memory: '$.calc.memory', memoryExact: '$.calc.memoryExact',
    } }],
  },
  'calc/mem-set': {
    patch: [
      { op: 'replace', path: '/calc/memory', value: '$payload.value' },
      { op: 'add', path: '/calc/memoryExact', value: '$payload.exact' },
    ],
  },
  'calc/mem-clear': {
    patch: [
      { op: 'replace', path: '/calc/memory', value: 0 },
      { op: 'add', path: '/calc/memoryExact', value: '' },
    ],
  },
  // plotting
  'calc/plot-expr': { patch: [{ op: 'replace', path: '/calc/plot/expr', value: '$event.value' }] },
  'calc/plot-kind': { patch: [{ op: 'replace', path: '/calc/plot/kind', value: '$payload.kind' }] },
  // converter
  'calc/conv-dim': {
    $let: { units: { $if: [
      { $eq: ['$event.value', 'currency'] },
      [{ $for: { unit: { $entries: '$.calc.rates.rates' } }, $return: '$unit.key' }],
      { $get: [{ $const: CONVERTER_UNIT_IDS }, '$event.value'] },
    ] } },
    // Change the dimension and its unit selections in one transition,
    // retaining a selection only when the new dimension offers it.
    $return: { $if: [
      { $exists: '$units[0]' },
      { patch: [
        { op: 'replace', path: '/calc/conv/dimension', value: '$event.value' },
        { op: 'replace', path: '/calc/conv/from', value: { $if: [
          { $eq: ['$units[*]', '$.calc.conv.from'] }, '$.calc.conv.from', '$units[0]',
        ] } },
        { op: 'replace', path: '/calc/conv/to', value: { $if: [
          { $eq: ['$units[*]', '$.calc.conv.to'] }, '$.calc.conv.to',
          { $default: ['$units[1]', '$units[0]'] },
        ] } },
      ] },
      {},
    ] },
  },
  'calc/conv-from': { patch: [{ op: 'replace', path: '/calc/conv/from', value: '$event.value' }] },
  'calc/conv-to': { patch: [{ op: 'replace', path: '/calc/conv/to', value: '$event.value' }] },
  'calc/conv-value': { patch: [{ op: 'replace', path: '/calc/conv/value', value: FORM_NUMBER_VALUE }] },
  'calc/conv-swap': {
    patch: [
      { op: 'replace', path: '/calc/conv/from', value: '$.calc.conv.to' },
      { op: 'replace', path: '/calc/conv/to', value: '$.calc.conv.from' },
    ],
  },
  // a worked example (or a change of the unknown) writes the five values and
  // the unknown in one transition
  'calc/fin-example': { patch: [{ op: 'replace', path: '/calc/fin', value: '$payload' }] },
  'calc/rates-refresh': { effects: [{ run: 'rates-fetch', with: { force: true } }] },
  // a fetched table is live: it replaces the fallback and says so
  'calc/rates-ok': {
    patch: [
      { op: 'replace', path: '/calc/rates', value: '$payload' },
      { op: 'add', path: '/calc/rates/status', value: 'ok' },
      { op: 'add', path: '/calc/rates/stale', value: false },
    ],
  },
  'calc/rates-err': { patch: [{ op: 'replace', path: '/calc/rates/status', value: 'error' }] },
  // the financial panel writes through the (namespaced) @jarenjs/forms actions
  ...FIN_FORM_ACTIONS,
  // changing the unknown carries the answer the panel showed into the field
  // that was the unknown, so no field is left at an editable stale value
  [FORM_ACTIONS.json]: { $if: [
    { $eq: ['$payload.pointer', '/solveFor'] },
    { effects: [{ run: 'calc-solve-for', with: { fin: '$.calc.fin', solveFor: '$event.formJsonValue' } }] },
    FIN_FORM_ACTIONS[FORM_ACTIONS.json],
  ] },
};

/** All calculator view rules (the calculator UI + the financial form). */
export const calcViewRules = [...CALCULATOR_RULES, ...calcFormViewRules];

export { createRatesLayer, FALLBACK_RATES, CURRENCY_CODES } from './rates/index.js';
export { pressKeys, keyChange, applyChange, previewOf, tokenize, untokenize } from './entry.js';
export { calcKeyOf, bindCalcKeyboard } from './keyboard.js';
export { formatCurrency, formatInstant } from './panels.js';

/**
 * The `calc-press` (every key and backspace), `calc-eval` (=),
 * `calc-solve-for` (the financial unknown changes) and `calc-mem-add` (M+)
 * JS effect handlers.
 */
export const calcEditEffects = {
  /**
   * `{ k, calc }`: one key on the slice, or a run of keys (`'65535'`,
   * `'+1'`, `'0xFF'`) pressed one by one and typed whole or not at all, each change dispatched as
   * `calc/entry` or, for an `=` that answers, `calc/commit`.
   * @param {any} props @param {(name: string, payload?: any) => void} dispatch
   */
  'calc-press': (props, dispatch) => {
    if (typeof props?.k !== 'string') return;
    const k = props.k;
    for (const change of changesOf(props?.calc ?? {}, k)) {
      dispatch(change.kind === 'commit' ? 'calc/commit' : 'calc/entry', change);
    }
  },
  /**
   * `=` on the slice fields it reads (`entry`, `mode`, `base`, `angleMode`,
   * `wordBits`, `signed`, `ans`, `memory`, their exact texts, `fresh`,
   * `error`): `calc/commit` with the result, or `calc/entry` with the
   * message id of an expression that has none.
   * @param {any} props @param {(name: string, payload?: any) => void} dispatch
   */
  'calc-eval': (props, dispatch) => {
    const change = keyChange(props ?? {}, 'equals');
    if (change !== null) dispatch(change.kind === 'commit' ? 'calc/commit' : 'calc/entry', change);
  },
  /**
   * `{ fin, solveFor }`: the five values with the answer the panel showed
   * written into the field that was the unknown, and the new unknown.
   * @param {any} props @param {(name: string, payload?: any) => void} dispatch
   */
  'calc-solve-for': (props, dispatch) => {
    dispatch('calc/fin-example', carrySolved(props?.fin ?? {}, props?.solveFor));
  },
  'calc-mem-add': (props, dispatch) => {
    const scope = scopeOf(props);
    const ans = scopeValue(scope.ans, props.mode);
    const memory = scopeValue(scope.memory, props.mode);
    const whole = (v) => typeof v === 'bigint' || Number.isInteger(v);
    // a programmer word is added as the integer it is, so the register keeps
    // an exact word; every other sum is the float sum it always was
    const sum = props.mode === 'programmer' && whole(ans) && whole(memory)
      ? fit(BigInt(ans) + BigInt(memory))
      : Number(memory) + Number(ans);
    dispatch('calc/mem-set', { value: toNumber(sum), exact: exactText(sum) });
  },
};

/**
 * The viewModel derivation for the calculator (`contributeCalcViewModel`).
 * Pure: state in, UI document out, no dispatching.
 * @param {any} state
 * @param {{ theme?: any, messages?: Readonly<Record<string, unknown>> | null }} [options] plot theme
 *   (name, overrides, or `'host'` to follow the embedding host's tokens), and
 *   the reader's compiled catalog (`compileMessageCatalog` over a locale
 *   pack): every word of chrome and every expression diagnostic renders
 *   through it, falling back to English (`calcMessagesEn`) per id
 * @returns {any}
 */
export function contributeCalcViewModel(state, options = {}) {
  const calc = state.calc;
  if (!calc) return null;
  const messages = options.messages;
  const t = calcText(messages);
  const scope = scopeOf(calc);
  const keypad = keypadFor(calc.mode, t);

  // the display: the entry, its live preview (never a diagnostic while it
  // is typed) and the message the last `=` left
  const error = typeof calc.error === 'string' && calc.error !== '' ? t(calc.error, calc.errorParams ?? {}) : null;
  // results and the entry read in the reader's separators (the entry is
  // stored as expression text: `.` the point, `,` between arguments)
  const symbols = numberSymbols(messages);
  const display = {
    entry: calc.entry === '' ? '0' : localizeEntry(calc.entry, symbols),
    result: localizeNumber(previewOf(calc), symbols),
    error,
  };

  // programmer four-base view: the live value; a cleared entry is 0, and
  // an entry with no finite value keeps the last answer's word
  const live = calc.mode === 'programmer' ? previewValue(calc) : undefined;
  const pv = live !== undefined ? live : calc.entry === '' ? 0 : scopeValue(scope.ans, calc.mode);
  const bases = {
    base: calc.base, wordBits: calc.wordBits, signed: calc.signed,
    baseOptions: BASES.map((b) => ({ id: b, label: b, active: b === calc.base, on: { click: { action: 'calc/base', with: { base: b } } } })),
    wordOptions: WORD_SIZES.map((w) => ({ id: String(w), label: t('calc/word/bits', { bits: w }), active: w === calc.wordBits, on: { click: { action: 'calc/word', with: { bits: w } } } })),
    signLabel: t(calc.signed ? 'calc/word/signed' : 'calc/word/unsigned'),
    views: viewsOf(pv, calc.wordBits, calc.signed),
    note: t('calc/programmer/note'),
    shiftNote: t('calc/programmer/shift-note', { bits: calc.wordBits, next: calc.wordBits + 1 }),
  };

  // the plot belongs to the scientific mode: the standard mode is the
  // plain four-function calculator
  let plot = null;
  if (calc.mode === 'scientific') {
    plot = {
      expr: calc.plot.expr,
      kind: calc.plot.kind,
      exprLabel: t('calc/plot/expr'),
      svg: calcToVnode(calc.plot.expr, { kind: calc.plot.kind, theme: options.theme, messages }),
      kinds: [
        { id: '2d', label: 'x·y', active: calc.plot.kind === '2d', on: { click: { action: 'calc/plot-kind', with: { kind: '2d' } } } },
        { id: '3d', label: 'x·y·z', active: calc.plot.kind === '3d', on: { click: { action: 'calc/plot-kind', with: { kind: '3d' } } } },
      ],
    };
  }

  return {
    mode: calc.mode,
    modes: MODES.map((m) => ({ id: m.id, label: Object.hasOwn(MODE_LABELS, m.id) ? t(MODE_LABELS[m.id]) : m.label, active: m.id === calc.mode, on: { click: { action: 'calc/mode', with: { mode: m.id } } } })),
    isStandard: calc.mode === 'standard' || calc.mode === 'scientific',
    isScientific: calc.mode === 'scientific',
    isProgrammer: calc.mode === 'programmer',
    isFinancial: calc.mode === 'financial',
    isConverter: calc.mode === 'converter',
    hasKeypad: keypad !== null,
    display,
    displayLabel: t('calc/display/label'),
    keyboardHint: t('calc/keyboard/hint'),
    keypad,
    tape: keypad === null ? [] : calc.tape.map((row, i) => ({ key: 'tape' + i, expr: localizeEntry(String(row.expr), symbols), result: localizeNumber(String(row.result), symbols) })),
    memory: scope.memory,
    memoryLabels: { add: t('calc/key/mem-add'), clear: t('calc/key/mem-clear') },
    angle: { mode: calc.angleMode, options: ['rad', 'deg', 'grad'].map((a) => ({ id: a, label: a, active: a === calc.angleMode, on: { click: { action: 'calc/angle', with: { mode: a } } } })) },
    bases,
    financial: calc.mode === 'financial' ? financialView(calc, t, messages, symbols) : null,
    converter: calc.mode === 'converter' ? converterView(calc, t, symbols) : null,
    plot,
  };
}

/**
 * Create the calculator component.
 * @param {import('./rates/index.js').RatesLayerOptions & { messages?: Readonly<Record<string, unknown>> | null }} [options]
 *   the rates layer's options, and `messages`: the reader's compiled
 *   catalog, which the standalone app's view model renders through (a host
 *   that composes `viewModel` itself passes it there)
 * @returns {any}
 */
export function createCalcComponent(options = {}) {
  const rates = createRatesLayer(options);
  const initialState = () => ({ ...calcInitialState(), rates: structuredClone(rates.fallbackRates) });
  const formViewRules = calcFormViewRules;

  return {
    initialState,
    actions: calcActions,
    mode: 'calculator',
    rules: calcViewRules,
    formRules: formViewRules,
    effects: { ...calcEditEffects, ...rates.effects },
    subs: { ...rates.subs },
    subEntry: rates.subEntry,
    fallbackRates: rates.fallbackRates,
    viewModel: contributeCalcViewModel,
    codes: rates.codes,

    /**
     * A standalone app document + running app (headless if `node` omitted).
     * Mounted into a `node`, it binds the keyboard there
     * (`bindCalcKeyboard(node, app)`) and unbinds it on `app.destroy()`.
     * @param {any} [appOptions]
     */
    createApp(appOptions = {}) {
      const appDoc = {
        $app: '0.1',
        state: { calc: initialState() },
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
      const app = appCreateApp(appDoc, {
        ...appOptions,
        // the financial panel's selects carry their values as JSON text
        eventFields: { ...formEventFields(), ...(appOptions.eventFields ?? {}) },
        effects: { ...calcEditEffects, ...rates.effects, ...(appOptions.effects ?? {}) },
        subs: { ...rates.subs, ...(appOptions.subs ?? {}) },
        viewModel: (state) => ({ ...state, ui: { calculator: contributeCalcViewModel(state, { messages: options.messages }) } }),
      });
      // a mounted calculator takes the keyboard while its keypad has focus,
      // until the app is destroyed
      const node = appOptions.node;
      if (node != null && typeof node.addEventListener === 'function') {
        const unbind = bindCalcKeyboard(node, app);
        const destroy = app.destroy;
        app.destroy = () => {
          unbind();
          destroy();
        };
      }
      return app;
    },
  };
}
