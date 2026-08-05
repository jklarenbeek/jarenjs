//@ts-check
/**
 * @file The finance pack — parameterized aggregators over a sequence of
 * numbers, wrapping the pure functions of `@jarenjs/core/finance`. Each
 * `agg` entry declares which operands are folded sequences (`seq`) and
 * which are scalars; the registry gathers the `seq` operands into arrays
 * before the call (the fold contract). Whole-series functions (`irr`,
 * `npv`, moving averages) are `pushable: false` — they run in the engine
 * or the db residual, never as an index-eligible SQLite scalar UDF.
 */

import {
  npv, irr, mirr, fv, pv, pmt, cagr,
  sma, ema, wma, rsi, roc,
  volatility, sharpe, maxDrawdown,
} from '@jarenjs/core/finance';

const aggNum = (signature, fn) => ({ kind: 'agg', signature, result: 'number', fn, pushable: false });
const aggSeq = (signature, fn) => ({ kind: 'agg', signature, result: 'seq<number>', fn, pushable: false });
const opNum = (n, fn) => ({ kind: 'op', signature: new Array(n).fill('number'), result: 'number', fn, pushable: false });

export const financePack = {
  name: 'finance',
  entries: {
    // present value of a cashflow series at a rate
    $npv: aggNum(['number', 'seq<number>'], (rate, cashflows) => npv(rate, cashflows)),
    // internal rate of return of a cashflow series
    $irr: aggNum(['seq<number>'], (cashflows) => irr(cashflows)),
    // modified IRR: series, finance rate, reinvest rate
    $mirr: aggNum(['seq<number>', 'number', 'number'],
      (cashflows, financeRate, reinvestRate) => mirr(cashflows, financeRate, reinvestRate)),
    // time value of money (scalar operands; pv/type default)
    $fv: opNum(3, (rate, nper, pmtv) => fv(rate, nper, pmtv)),
    $pv: opNum(3, (rate, nper, pmtv) => pv(rate, nper, pmtv)),
    $pmt: opNum(3, (rate, nper, pval) => pmt(rate, nper, pval)),
    // compound annual growth rate
    $cagr: opNum(3, (begin, end, years) => cagr(begin, end, years)),
    // moving averages / indicators — return a series (null during warm-up)
    $sma: aggSeq(['seq<number>', 'number'], (values, period) => sma(values, period)),
    $ema: aggSeq(['seq<number>', 'number'], (values, period) => ema(values, period)),
    $wma: aggSeq(['seq<number>', 'number'], (values, period) => wma(values, period)),
    $rsi: aggSeq(['seq<number>', 'number'], (values, period) => rsi(values, period)),
    $roc: aggSeq(['seq<number>', 'number'], (values, period) => roc(values, period)),
    // risk / return summaries over a returns series
    $volatility: aggNum(['seq<number>'], (returns) => volatility(returns)),
    $sharpe: aggNum(['seq<number>'], (returns) => sharpe(returns)),
    $maxDrawdown: aggNum(['seq<number>'], (values) => maxDrawdown(values)),
  },
};
