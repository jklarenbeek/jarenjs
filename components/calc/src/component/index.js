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
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';

import {
  calcToVnode, MODE_BY_ID, MODES,
  programmerEnv, defaultEnv,
  solveTvm, convertValue, unitOptions, converterDimensions,
} from '../index.js';
import { evaluateExact } from '../compile.js';
import { DECIMAL_INTEGER, fit, isFiniteValue, toNumber } from '../exact.js';
import { standardMode } from '../modes/standard.js';
import { BASES, WORD_SIZES, wordExact, viewsOf, formatWord } from '../modes/programmer.js';
import { financialMode } from '../modes/financial.js';
import { converterMode } from '../modes/converter.js';
import { createRatesLayer, FALLBACK_RATES } from './rates/index.js';
import { CALCULATOR_RULES } from './rules.js';
import { FINANCIAL_SCHEMA } from './schema.js';
import { calcMessagesEn, calcText } from '../messages.js';

const FIN_MODEL = buildFormModel(FINANCIAL_SCHEMA);

/**
 * The financial form's model per reader catalog: its labels resolve at build time.
 * @type {WeakMap<object, any>}
 */
const FIN_MODELS = new WeakMap();

/**
 * The financial form's model in the reader's language: the field labels
 * through `messages` by their `x-msgid` (`<x-msgid>#label`), the English
 * model without a catalog.
 * @param {Readonly<Record<string, unknown>> | null | undefined} messages
 * @returns {any}
 */
function financialModel(messages) {
  if (messages == null) return FIN_MODEL;
  let model = FIN_MODELS.get(messages);
  if (model === undefined) {
    const t = calcText(messages);
    model = buildFormModel(FINANCIAL_SCHEMA, {
      t: (/** @type {string} */ msgid, /** @type {any} */ fallback) => (Object.hasOwn(calcMessagesEn, msgid) ? t(msgid) : fallback),
    });
    FIN_MODELS.set(messages, model);
  }
  return model;
}

/** The message id of each mode's tab label, by mode id. */
const MODE_LABELS = Object.freeze({
  standard: 'calc/mode/standard', scientific: 'calc/mode/scientific', programmer: 'calc/mode/programmer',
  financial: 'calc/mode/financial', converter: 'calc/mode/converter',
});
/** The message id of each converter dimension's name, by dimension id. */
const DIMENSION_LABELS = Object.freeze({
  length: 'calc/dimension/length', area: 'calc/dimension/area', volume: 'calc/dimension/volume', mass: 'calc/dimension/mass',
  temperature: 'calc/dimension/temperature', time: 'calc/dimension/time', speed: 'calc/dimension/speed',
  pressure: 'calc/dimension/pressure', energy: 'calc/dimension/energy', power: 'calc/dimension/power',
  data: 'calc/dimension/data', datarate: 'calc/dimension/datarate', frequency: 'calc/dimension/frequency',
  angle: 'calc/dimension/angle', fuel: 'calc/dimension/fuel', currency: 'calc/dimension/currency',
});
/** The message id of each exchange-rates state, by state. */
const RATES_LABELS = Object.freeze({
  idle: 'calc/rates/idle', fallback: 'calc/rates/fallback', ok: 'calc/rates/ok', error: 'calc/rates/error',
});
/**
 * A label by its table's message id, or the id itself for one the table
 * does not name (a dimension or mode a later core adds shows its id).
 * @param {(id: string, params?: Record<string, unknown>) => string} t
 * @param {Readonly<Record<string, string>>} table @param {string} key
 * @returns {string}
 */
const labelOf = (t, table, key) => (Object.hasOwn(table, key) ? t(table[key]) : key);

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

/**
 * The exact word beside a held `Number`, or `undefined`. The decimal string
 * is trusted only while it is the integer the `Number` rounds from, so a
 * state a host patched at `ans` or `memory` alone, or one written before
 * the exact form existed, reads as the `Number` it holds.
 * @param {any} held the `ans` or `memory` Number
 * @param {any} text the `ansExact` or `memoryExact` sibling
 * @returns {bigint | undefined}
 */
function exactWord(held, text) {
  return typeof text === 'string' && DECIMAL_INTEGER.test(text) && Number(text) === held ? BigInt(text) : undefined;
}

/**
 * The decimal text of a word a `Number` cannot hold exactly, else the empty
 * text the state slice holds beside a safe `Number`.
 * @param {number | bigint} word
 * @returns {string}
 */
function exactText(word) {
  return typeof word === 'bigint' ? String(word) : '';
}

/**
 * The scope for evaluating an entry against a state slice or an effect's
 * props. A programmer-mode `ans` and memory that have an exact form enter
 * the scope as that decimal integer, which the exact environment reads
 * without rounding; every other mode holds the `Number`.
 */
function scopeOf(calc) {
  const programmer = calc.mode === 'programmer';
  const held = (number, text) => {
    const word = programmer ? exactWord(number, text) : undefined;
    return word === undefined ? number : String(word);
  };
  const memory = held(calc.memory, calc.memoryExact);
  return {
    angleMode: calc.angleMode,
    wordBits: calc.wordBits,
    signed: calc.signed,
    ans: held(calc.ans, calc.ansExact),
    mem: memory,
    memory,
  };
}

/**
 * The value a scope entry stands for. In the programmer mode a decimal-integer
 * string is the integer it spells; any other value, a string a host patched
 * into the slice included, is what the state holds.
 */
function scopeValue(held, mode) {
  return mode === 'programmer' && typeof held === 'string' && DECIMAL_INTEGER.test(held) ? fit(BigInt(held)) : held;
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
  'calc/key': { patch: [{ op: 'replace', path: '/calc/entry', value: { $concat: ['$.calc.entry', '$payload.k'] } }] },
  'calc/clear': { patch: [{ op: 'replace', path: '/calc/entry', value: '' }] },
  'calc/set-entry': { patch: [{ op: 'replace', path: '/calc/entry', value: '$payload' }] },
  'calc/back': { effects: [{ run: 'calc-edit', with: { entry: '$.calc.entry' } }] },
  'calc/equals': {
    effects: [{ run: 'calc-eval', with: {
      entry: '$.calc.entry', mode: '$.calc.mode',
      base: '$.calc.base',
      angleMode: '$.calc.angleMode', wordBits: '$.calc.wordBits',
      signed: '$.calc.signed', ans: '$.calc.ans', memory: '$.calc.memory',
      ansExact: '$.calc.ansExact', memoryExact: '$.calc.memoryExact',
    } }],
  },
  'calc/commit': {
    patch: [
      { op: 'replace', path: '/calc/ans', value: '$payload.value' },
      { op: 'add', path: '/calc/ansExact', value: { $if: [{ $exists: '$payload.exact' }, '$payload.exact', ''] } },
      { op: 'replace', path: '/calc/entry', value: { $if: [{ $exists: '$payload.entry' }, '$payload.entry', '$payload.display'] } },
      { op: 'add', path: '/calc/tape/-', value: { expr: '$payload.expr', result: '$payload.display' } },
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
  ...createFormActions({ dataPointer: '/calc/fin', actions: FORM_ACTIONS }),
};

/** All calculator view rules (the calculator UI + the financial form). */
export const calcViewRules = [...CALCULATOR_RULES, ...calcFormViewRules];

export { createRatesLayer, FALLBACK_RATES, CURRENCY_CODES } from './rates/index.js';

/** The `calc-edit` (backspace), `calc-eval` (=) and `calc-mem-add` (M+) JS effect handlers. */
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
    const res = evaluateExact(entry, scopeOf(props), { env });
    if (!res.ok) return; // leave the entry; the live display shows the error
    const desc = MODE_BY_ID[mode] ?? standardMode;
    const view = { angleMode: props.angleMode, wordBits: props.wordBits, signed: props.signed, base: props.base };
    // a programmer result is the exact word, so it is formatted from that
    // rather than from the Number a public `evaluate` would round it to
    const display = mode === 'programmer'
      ? formatWord(res.value, view)
      : desc.format ? desc.format(res.value, view) : String(res.value);
    // `ans` is the word the display shows, so the next calculation uses the
    // value the user saw. A state slice holds it as a JSON number, and a word
    // beyond 2^53 also as its decimal text beside the number, which a
    // programmer-mode scope reads back exactly.
    const word = mode === 'programmer'
      ? wordExact(res.value, props.wordBits ?? 32, props.signed ?? false)
      : res.value;
    const value = toNumber(word);
    // The displayed result becomes the next entry, except when it is not a
    // number (`∞`, `NaN`, `—` are not expressions): the typed expression
    // stays, so the entry still evaluates. Grouping belongs on the
    // tape/display; expression literals contain no spaces.
    const next = !isFiniteValue(res.value) ? entry
      : mode === 'programmer' ? display.replaceAll(' ', '') : display;
    dispatch('calc/commit', { value, exact: exactText(word), display, expr: entry, entry: next });
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
  const desc = MODE_BY_ID[calc.mode] ?? standardMode;
  const env = envForMode(calc.mode);
  const scope = scopeOf(calc);

  // live result of the current entry
  const ans = scopeValue(scope.ans, calc.mode);
  const live = calc.entry === '' ? { ok: true, value: ans } : evaluateExact(calc.entry, scope, { env, messages });
  const display = {
    entry: calc.entry === '' ? '0' : calc.entry,
    result: !live.ok ? '' : calc.mode === 'programmer' ? formatWord(live.value, calc) : desc.format(live.value, calc),
    error: live.ok ? null : live.error.line
      ? t('calc/display/error-at', { message: live.error.message, line: live.error.line, column: live.error.column })
      : live.error.message,
  };

  // programmer four-base view
  const pv = live.ok && isFiniteValue(live.value) ? live.value : ans;
  const bases = {
    base: calc.base, wordBits: calc.wordBits, signed: calc.signed,
    baseOptions: BASES.map((b) => ({ id: b, label: b, active: b === calc.base, on: { click: { action: 'calc/base', with: { base: b } } } })),
    wordOptions: WORD_SIZES.map((w) => ({ id: String(w), label: t('calc/word/bits', { bits: w }), active: w === calc.wordBits, on: { click: { action: 'calc/word', with: { bits: w } } } })),
    signLabel: t(calc.signed ? 'calc/word/signed' : 'calc/word/unsigned'),
    views: viewsOf(pv, calc.wordBits, calc.signed),
  };

  // financial: reuse @jarenjs/forms model + viewModel; solve via core
  let financial = null;
  if (calc.mode === 'financial') {
    let form = null;
    try { form = buildFormViewModel(financialModel(messages), calc.fin, messages == null ? { validateFields: true } : { validateFields: true, catalog: messages }); }
    catch { form = null; }
    const result = solveTvm({ ...calc.fin });
    financial = { form, solveFor: calc.fin.solveFor, result: financialMode.format(result),
      resultLabel: t('calc/financial/result', { solveFor: calc.fin.solveFor }) };
  }

  // converter: options + live result, all through core/convert
  let converter = null;
  if (calc.mode === 'converter') {
    const dim = calc.conv.dimension;
    const units = unitOptions(dim, calc.rates);
    const result = convertValue(dim, +calc.conv.value, calc.conv.from, calc.conv.to, calc.rates);
    converter = {
      dimension: dim,
      dimensions: converterDimensions().map((d) => ({ id: d, label: labelOf(t, DIMENSION_LABELS, d), selected: d === dim })),
      dimensionLabel: `${t('calc/converter/dimension')} `,
      from: calc.conv.from,
      to: calc.conv.to,
      unitsFrom: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.from })),
      unitsTo: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.to })),
      value: calc.conv.value,
      result: converterMode.format(result),
      isCurrency: dim === 'currency',
      rates: { status: calc.rates.status ?? 'idle', stale: calc.rates.stale === true, at: calc.rates.at ?? 0, count: Object.keys(calc.rates.rates ?? {}).length,
        label: `${t('calc/converter/rates')} `, statusLabel: labelOf(t, RATES_LABELS, calc.rates.status ?? 'idle'),
        staleLabel: ` · ${t('calc/converter/stale')}` },
    };
  }

  // plot vnode (prebuilt; spliced verbatim into the view)
  let plot = null;
  if (calc.mode !== 'financial' && calc.mode !== 'converter' && calc.mode !== 'programmer') {
    plot = {
      expr: calc.plot.expr,
      kind: calc.plot.kind,
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
    display,
    keypad: keypadFor(calc.mode),
    tape: calc.tape.map((t, i) => ({ key: 'tape' + i, expr: t.expr, result: t.result })),
    memory: scope.memory,
    angle: { mode: calc.angleMode, options: ['rad', 'deg', 'grad'].map((a) => ({ id: a, label: a, active: a === calc.angleMode, on: { click: { action: 'calc/angle', with: { mode: a } } } })) },
    bases,
    financial,
    converter,
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
      return appCreateApp(appDoc, {
        ...appOptions,
        // the financial panel's selects carry their values as JSON text
        eventFields: { ...formEventFields(), ...(appOptions.eventFields ?? {}) },
        effects: { ...calcEditEffects, ...rates.effects, ...(appOptions.effects ?? {}) },
        subs: { ...rates.subs, ...(appOptions.subs ?? {}) },
        viewModel: (state) => ({ ...state, ui: { calculator: contributeCalcViewModel(state, { messages: options.messages }) } }),
      });
    },
  };
}
