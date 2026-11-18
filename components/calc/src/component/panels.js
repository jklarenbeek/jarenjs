//@ts-check
/**
 * @file The financial and converter panels' view models: the financial
 * form with its help, worked examples and the solved field shown as the
 * answer; the converter's dimension and unit choices, its result at a
 * precision the unit can use, and a rates line that says where the rates
 * came from and when.
 */

import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';

import { solveTvm, convertValue, unitOptions, converterDimensions } from '../modes/index.js';
import { financialMode, FINANCIAL_EXAMPLES } from '../modes/financial.js';
import { converterMode } from '../modes/converter.js';
import { formatFixed, formatSignificant, localizeNumber } from '../format.js';
import { FINANCIAL_SCHEMA } from './schema.js';
import { calcMessagesEn, calcText } from '../messages.js';

/** @typedef {(id: string, params?: Record<string, unknown>) => string} Text */

/**
 * The financial form's model per reader catalog (the English one under the
 * `null` key): its labels, descriptions and option labels resolve at build
 * time, through the calc catalog by the fields' `x-msgid`.
 * @type {WeakMap<object, any>}
 */
const FIN_MODELS = new WeakMap();
/** The English form model. */
let englishModel;

/**
 * The financial form's model in the reader's language.
 * @param {Readonly<Record<string, unknown>> | null | undefined} messages
 * @returns {any}
 */
function financialModel(messages) {
  const cached = messages == null ? englishModel : FIN_MODELS.get(messages);
  if (cached !== undefined) return cached;
  const t = calcText(messages);
  const model = buildFormModel(FINANCIAL_SCHEMA, {
    t: (/** @type {string} */ msgid, /** @type {any} */ fallback) => (Object.hasOwn(calcMessagesEn, msgid) ? t(msgid) : fallback),
  });
  if (messages == null) englishModel = model;
  else FIN_MODELS.set(messages, model);
  return model;
}

/** The fraction digits a solved field shows, by field. */
const SOLVED_DECIMALS = Object.freeze({ nper: 2, rate: 4, pv: 2, pmt: 2, fv: 2 });

/**
 * A number with at most `decimals` fraction digits.
 * @param {number} value @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * The parameters of an example's explanation: its amounts and its yearly
 * rate and length, as the text shows them.
 * @param {typeof FINANCIAL_EXAMPLES[number]} example
 * @param {{ decimal: string, group: string }} symbols the reader's separators
 * @returns {Record<string, string>}
 */
function exampleParams(example, symbols) {
  const { inputs, perYear } = example;
  const amount = (/** @type {number} */ v) => localizeNumber(formatSignificant(Math.abs(v), { group: true }), symbols);
  return {
    pv: amount(inputs.pv), pmt: amount(inputs.pmt), fv: amount(inputs.fv),
    annual: localizeNumber(formatSignificant(roundTo(inputs.rate * perYear, 6)), symbols),
    years: localizeNumber(formatSignificant(roundTo(inputs.nper / perYear, 6)), symbols),
  };
}

/**
 * The financial panel: the form (the solved field read-only and showing the
 * answer), the result line, the help text and the worked examples.
 * @param {any} calc the `$.calc` slice
 * @param {Text} t
 * @param {Readonly<Record<string, unknown>> | null | undefined} messages
 * @param {{ decimal: string, group: string }} symbols the reader's separators
 * @returns {any}
 */
export function financialView(calc, t, messages, symbols) {
  const solveFor = calc.fin.solveFor;
  const result = solveTvm({ ...calc.fin });
  const solved = Number.isFinite(result);
  let form = null;
  try {
    form = buildFormViewModel(financialModel(messages), calc.fin, messages == null ? { validateFields: true } : { validateFields: true, catalog: messages });
  }
  catch { form = null; }
  if (form !== null && Array.isArray(form.children)) {
    form = {
      ...form,
      children: form.children.map((/** @type {any} */ field) => (field.key === solveFor && Object.hasOwn(SOLVED_DECIMALS, solveFor)
        // the unknown is the answer: shown, never an editable stale value
        ? { ...field, readOnly: true, value: solved ? roundTo(result, SOLVED_DECIMALS[/** @type {keyof typeof SOLVED_DECIMALS} */ (solveFor)]) : null }
        : field)),
    };
  }
  const mortgage = FINANCIAL_EXAMPLES[0];
  const mortgageParams = exampleParams(mortgage, symbols);
  const money = (/** @type {number} */ v) => localizeNumber(financialMode.format(v), symbols);
  return {
    form,
    solveFor,
    result: solved ? money(result) : '—',
    resultLabel: t('calc/financial/result', { solveFor: t(`calc/financial/solve-for#enum/${solveFor}`) }),
    noSolution: solved ? null : t('calc/financial/no-solution'),
    // what the panel is and how to use it, above the form
    help: [
      { key: 'intro', text: t('calc/financial/intro') },
      { key: 'how', text: t('calc/financial/how', { solveFor: t('calc/financial/solve-for#label') }) },
    ],
    // why an answer has its sign, and the formula, below the result
    notes: [
      { key: 'signs', text: t('calc/financial/signs', { ...mortgageParams, payment: money(-solveTvm(mortgage.inputs)) }) },
      { key: 'formula', text: t('calc/financial/formula') },
    ],
    examplesLabel: t('calc/financial/examples'),
    examples: FINANCIAL_EXAMPLES.map((example) => ({
      key: example.id,
      label: t(`calc/financial/example/${example.id}`),
      text: t(`calc/financial/example/${example.id}/text`, exampleParams(example, symbols)),
      on: { click: { action: 'calc/fin-example', with: { ...example.inputs } } },
    })),
  };
}

/** The message id of each converter dimension's name, by dimension id. */
const DIMENSION_LABELS = Object.freeze({
  length: 'calc/dimension/length', area: 'calc/dimension/area', volume: 'calc/dimension/volume', mass: 'calc/dimension/mass',
  temperature: 'calc/dimension/temperature', time: 'calc/dimension/time', speed: 'calc/dimension/speed',
  pressure: 'calc/dimension/pressure', energy: 'calc/dimension/energy', power: 'calc/dimension/power',
  data: 'calc/dimension/data', datarate: 'calc/dimension/datarate', frequency: 'calc/dimension/frequency',
  angle: 'calc/dimension/angle', fuel: 'calc/dimension/fuel', currency: 'calc/dimension/currency',
});

/**
 * A label by its table's message id, or the id itself for one the table
 * does not name (a dimension a later core adds shows its id).
 * @param {Text} t @param {Readonly<Record<string, string>>} table @param {string} key
 * @returns {string}
 */
const labelOf = (t, table, key) => (Object.hasOwn(table, key) ? t(table[key]) : key);

/**
 * The fraction digits of an amount of a currency: its minor unit (ISO 4217:
 * two, none for the yen), and eight for a crypto asset, whose smallest unit
 * is far below a cent.
 * @type {Readonly<Record<string, number>>}
 */
const CURRENCY_DECIMALS = Object.freeze({ JPY: 0, BTC: 8, ETH: 8, BNB: 8, SOL: 8 });

/**
 * A converted amount of `code`: its minor units, trailing zeros past the
 * second decimal dropped for an asset counted in eight.
 * @param {number} value @param {string} code
 * @returns {string}
 */
export function formatCurrency(value, code) {
  if (!Number.isFinite(value)) return '—';
  const decimals = Object.hasOwn(CURRENCY_DECIMALS, code) ? CURRENCY_DECIMALS[code] : 2;
  const text = formatFixed(value, decimals);
  return decimals > 2 ? text.replace(/(\.\d\d\d*?)0+$/, '$1') : text;
}

/**
 * An instant as `YYYY-MM-DD HH:MM UTC`: the same text in every language
 * and on every host clock.
 * @param {number} at epoch milliseconds
 * @returns {string}
 */
export function formatInstant(at) {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The rates line: live rates name their source and time; a failed fetch
 * says the live rates are unavailable and which rates the converter is
 * using instead; the built-in table says it is a sample, not live.
 * @param {any} rates the `$.calc.rates` table
 * @param {Text} t
 * @returns {string}
 */
export function ratesStatus(rates, t) {
  const at = typeof rates.at === 'number' && rates.at > 0 ? rates.at : 0;
  const source = typeof rates.source === 'string' && rates.source !== '' ? rates.source : '—';
  if (rates.status === 'ok') return t('calc/rates/live', { source, time: at > 0 ? formatInstant(at) : '—' });
  if (rates.status === 'error') return at > 0 ? t('calc/rates/offline-since', { source, time: formatInstant(at) }) : t('calc/rates/offline');
  return t('calc/rates/builtin');
}

/**
 * The converter panel.
 * @param {any} calc the `$.calc` slice
 * @param {Text} t
 * @param {{ decimal: string, group: string }} symbols the reader's separators
 * @returns {any}
 */
export function converterView(calc, t, symbols) {
  const dim = calc.conv.dimension;
  const units = unitOptions(dim, calc.rates);
  const result = convertValue(dim, +calc.conv.value, calc.conv.from, calc.conv.to, calc.rates);
  const isCurrency = dim === 'currency';
  return {
    dimension: dim,
    dimensions: converterDimensions().map((d) => ({ id: d, label: labelOf(t, DIMENSION_LABELS, d), selected: d === dim })),
    dimensionLabel: `${t('calc/converter/dimension')} `,
    valueLabel: t('calc/converter/value'),
    fromLabel: t('calc/converter/from'),
    toLabel: t('calc/converter/to'),
    swapLabel: t('calc/converter/swap'),
    from: calc.conv.from,
    to: calc.conv.to,
    unitsFrom: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.from })),
    unitsTo: units.map((u) => ({ id: u.id, symbol: u.symbol, selected: u.id === calc.conv.to })),
    value: calc.conv.value,
    result: localizeNumber(isCurrency ? formatCurrency(result, calc.conv.to) : converterMode.format(result), symbols),
    isCurrency,
    rates: {
      status: calc.rates.status ?? 'idle', stale: calc.rates.stale === true, at: calc.rates.at ?? 0,
      count: Object.keys(calc.rates.rates ?? {}).length,
      statusLabel: ratesStatus(calc.rates, t),
      refreshLabel: t('calc/converter/refresh'),
    },
  };
}
