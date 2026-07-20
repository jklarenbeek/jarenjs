//@ts-check
/**
 * @file `@jarenjs/core/finance` — the finance & trading formula library.
 * Pure, zero runtime dependencies (imports only `@jarenjs/core/math`).
 * Every export is a plain function over numbers/number-arrays, reusable
 * by any package: a calculator, a trading dashboard or a backtester. The
 * math lives here; orchestration (which variable to solve, forms, display)
 * lives in the consumer.
 */

export { pmt, pv, fv, nper, rate } from './tvm.js';
export { npv, irr, mirr, xnpv, xirr } from './cashflow.js';
export { amortizationSchedule } from './amortization.js';
export {
  simpleInterest, compoundAmount, compoundInterest,
  nominalToEffective, effectiveToNominal, continuousCompound,
} from './interest.js';
export { straightLine, decliningBalance, sumOfYearsDigits } from './depreciation.js';
export {
  bondPrice, bondYTM, macaulayDuration, modifiedDuration, convexity,
} from './bond.js';
export {
  sma, ema, wma, macd, rsi, bollinger, stochastic, atr, roc,
} from './indicators.js';
export {
  cagr, holdingPeriodReturn, returnsOf, volatility, sharpe, maxDrawdown,
} from './returns.js';
