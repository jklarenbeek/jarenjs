# `@jarenjs/core/finance`

A first-class subpackage of finance & trading **formulas** — pure,
zero-dependency (imports only `@jarenjs/core/math`), reusable by any
package. The math lives here; orchestration (which variable to solve,
input forms, display) belongs to the consumer. Import the barrel
(`@jarenjs/core/finance`) or a single module (`@jarenjs/core/finance/tvm`).

Sign convention (TVM/cash-flow): money **in** is positive, money **out**
negative — the standard Excel / HP-12C model.

## Time Value of Money — `tvm.js`

`pmt`, `pv`, `fv`, `nper`, `rate`. The five obey one identity; each solves
for its own variable. Rates are per period; `type` is 0 (ordinary
annuity, payment at period end) or 1 (annuity-due, begin). `rate` is
iterative (`math/solve`).

## Cash flow — `cashflow.js`

`npv(rate, cashflows)`, `irr(cashflows, guess?)`, `mirr(cashflows,
financeRate, reinvestRate)`, and date-indexed `xnpv(rate, cashflows,
dates)` / `xirr(cashflows, dates, guess?)` (dates as `Date` or ms). IRR
uses Newton with a bisection fallback.

## Amortization — `amortization.js`

`amortizationSchedule(principal, rate, nper, { payment?, type? })` →
rows of `{ period, payment, interest, principal, balance }`; the last row
clears rounding residue to a zero balance.

## Interest — `interest.js`

`simpleInterest`, `compoundAmount`, `compoundInterest`,
`nominalToEffective` (APR→APY/EAR), `effectiveToNominal`,
`continuousCompound`.

## Depreciation — `depreciation.js`

`straightLine`, `decliningBalance` (factor 2 = double-declining, floored
at salvage), `sumOfYearsDigits` — each returns per-period amounts.

## Bonds — `bond.js`

`bondPrice`, `bondYTM` (iterative), `macaulayDuration`,
`modifiedDuration`, `convexity`. Basic day-count (level coupons, whole
periods); exotic conventions are out of scope.

## Technical indicators — `indicators.js`

`sma`, `ema`, `wma`, `macd` (line + signal + histogram), `rsi`,
`bollinger`, `stochastic`, `atr`, `roc`. Each returns an array **aligned**
to the input (same length) with `null` in warm-up positions.
`Float64Array` inputs are accepted.

## Returns & risk — `returns.js`

`cagr`, `holdingPeriodReturn`, `returnsOf` (price series → return series),
`volatility` (sample stddev), `sharpe`, `maxDrawdown`.
