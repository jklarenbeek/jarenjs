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
import { formatNumber } from '@jarenjs/core/math';

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

/** Format a money-ish result. @param {number} value */
export function format(value) {
  return formatNumber(value, { notation: 'fixed', precision: 2, group: true });
}

export const financialMode = {
  id: 'financial',
  label: 'Financial',
  tvmFields: TVM_FIELDS,
  solveTvm,
  format,
};
