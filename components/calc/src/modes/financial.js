//@ts-check
/**
 * @file The financial mode kernel. Contains **no
 * formulas** — every number comes from `@jarenjs/core/finance`. This is
 * pure orchestration: the solve-for-unknown dispatcher (given any four of
 * {N, I/Y, PV, PMT, FV}, pick the core function for the fifth) plus thin
 * wrappers that turn a cash-flow / amortization request into core calls.
 */

import {
  pmt, pv, fv, nper, rate,
  npv, irr, amortizationSchedule,
} from '@jarenjs/core/finance';
import { formatFixed } from '../format.js';

/** The five TVM variables the panel exposes. */
export const TVM_FIELDS = ['nper', 'rate', 'pv', 'pmt', 'fv'];

/**
 * Solve for the one unknown TVM variable. `rate` is a **percent** per
 * period on the way in and out (e.g. 6 ⇒ 6%); the other four are plain
 * numbers under the standard sign convention.
 *
 * @param {{ nper?: number, rate?: number, pv?: number, pmt?: number, fv?: number, type?: number, solveFor: string }} inputs
 * @returns {number}
 */
export function solveTvm(inputs) {
  const N = +inputs.nper;
  const i = +inputs.rate / 100;
  const PV = +inputs.pv;
  const PMT = +inputs.pmt;
  const FV = +inputs.fv;
  const type = inputs.type ?? 0;
  switch (inputs.solveFor) {
    case 'pmt': return pmt(i, N, PV, FV, type);
    case 'pv': return pv(i, N, PMT, FV, type);
    case 'fv': return fv(i, N, PMT, PV, type);
    case 'nper': return nper(i, PMT, PV, FV, type);
    case 'rate': return rate(N, PMT, PV, FV, type) * 100;
    default: return NaN;
  }
}

/**
 * Amortization series (delegates to core), ready to become a table/plot.
 * @param {{ principal: number, rate: number, nper: number, type?: number }} inputs
 * @returns {import('@jarenjs/core/finance/amortization').AmortRow[]}
 */
export function buildAmortization(inputs) {
  return amortizationSchedule(+inputs.principal, +inputs.rate / 100, +inputs.nper, { type: inputs.type ?? 0 });
}

/**
 * NPV of a discount rate (percent) and a comma/space-separated cash-flow
 * string or array.
 * @param {number} ratePct @param {number[]|string} cashflows
 * @returns {number}
 */
export function npvOf(ratePct, cashflows) {
  return npv(ratePct / 100, parseFlows(cashflows));
}

/**
 * IRR (percent) of a cash-flow series.
 * @param {number[]|string} cashflows
 * @returns {number}
 */
export function irrOf(cashflows) {
  return irr(parseFlows(cashflows)) * 100;
}

/** @param {number[]|string} flows */
function parseFlows(flows) {
  if (Array.isArray(flows)) return flows.map(Number);
  return String(flows).split(/[\s,]+/).filter((s) => s !== '').map(Number);
}

/** Format a money-ish result: two decimals, thousands grouped. @param {number} value */
export function format(value) {
  return formatFixed(value, 2);
}

/**
 * The worked examples the panel offers, each a full set of inputs one click
 * writes into the form: the unknown is `solveFor`, its own value a
 * placeholder the answer replaces. `perYear` is the periods per year the
 * example's explanation counts in (12: monthly; 1: yearly).
 * @type {ReadonlyArray<{ id: string, perYear: number, inputs: { nper: number, rate: number, pv: number, pmt: number, fv: number, solveFor: string } }>}
 */
export const FINANCIAL_EXAMPLES = Object.freeze([
  // a 200,000 loan at 6% a year over 30 years, repaid monthly: the payment
  { id: 'mortgage', perYear: 12, inputs: { nper: 360, rate: 0.5, pv: 200000, pmt: 0, fv: 0, solveFor: 'pmt' } },
  // 200 saved each month for 10 years at 3% a year: the balance
  { id: 'savings', perYear: 12, inputs: { nper: 120, rate: 0.25, pv: 0, pmt: -200, fv: 0, solveFor: 'fv' } },
  // a 10,000 debt at 12% a year, repaid 300 a month: the months it takes
  { id: 'payoff', perYear: 12, inputs: { nper: 0, rate: 1, pv: 10000, pmt: -300, fv: 0, solveFor: 'nper' } },
  // 1,000 invested that returns 2,000 after 10 years: the yearly rate
  { id: 'return', perYear: 1, inputs: { nper: 10, rate: 0, pv: -1000, pmt: 0, fv: 2000, solveFor: 'rate' } },
].map((example) => Object.freeze({ ...example, inputs: Object.freeze(example.inputs) })));

export const financialMode = {
  id: 'financial',
  label: 'Financial',
  tvmFields: TVM_FIELDS,
  solveTvm,
  format,
};
