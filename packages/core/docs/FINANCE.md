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

The additional aligned indicators validate equal-length finite arrays and positive
integer periods. OHLC closes must lie within low/high; volumes are nonnegative.
Arrays and `Float64Array` are accepted; input is never mutated. Defaults and
warm-up conventions are explicit:

| Function | Convention |
|---|---|
| `adx(high, low, close, period = 14)` | `{adx, plusDI, minusDI}`; Wilder sums seeded with period−1 transitions; DI begins at index period, ADX at 2×period−1; period ≥ 2; zero range/direction yields zero |
| `cci(high, low, close, period = 20)` | Typical price `(H+L+C)/3`, SMA and mean absolute deviation, factor 0.015; first at period−1; flat window zero |
| `vwap(high, low, close, volume, sessions?)` | Cumulative typical-price weighting; aligned boolean flags reset before the indicated row; zero accumulated volume gives null |
| `obv(close, volume)` | Starts at first volume; adds/subtracts volume on rising/falling close; equal close adds zero |
| `volumeRatio(volume, period = 20)` | Current volume / mean of the preceding period, excluding current; first at period; zero denominator null |
| `kdj(high, low, close, k = 14, d = 3)` | Existing fast stochastic K and SMA D plus `J = 3K − 2D`; J null until D exists; flat K is 100 |
| `williamsR(high, low, close, period = 14)` | Existing stochastic K minus 100; first at period−1; flat window zero |

ADX/DI, CCI, OBV and Williams vectors are compared against independently generated
[TA-Lib](https://ta-lib.org/functions/) native 0.6.4 / Python 0.6.8 values in
`test/core/finance/fixtures/series-golden.json`. VWAP, volume ratio, KDJ and risk
measures have explicit rational fixtures; their conventions should not be assumed
equivalent to differently seeded/smoothed implementations. TA-Lib is not a runtime
or repository dependency.

New risk functions take **simple per-period returns**, finite and at least −1.
`periodsPerYear` is positive finite; the host supplies the calendar convention.
Existing `sharpe` remains a per-step ratio.

| Function | Convention |
|---|---|
| `annualizedReturn(returns, periodsPerYear)` | `product(1+r)^(periodsPerYear/n) − 1` |
| `sortino(returns, target = 0, periodsPerYear = 1)` | Mean excess / downside RMS over **all** periods, multiplied by sqrt(periodsPerYear); target is per step |
| `calmar(returns, periodsPerYear)` | Annualized compound return / maximum positive drawdown of equity seeded at 1 |
| `beta(returns, benchmark)` | Aligned sample covariance / benchmark variance; at least two observations |

Empty or undefined denominators return NaN, including no downside/no drawdown and
constant benchmark. Arithmetic is ordinary IEEE-754; hosts must keep numerical
magnitudes within representable ranges. `@jarenjs/charts/transforms/finance-adapter`
consumes these functions to make separate indicator charts and risk summaries,
using supplied timestamps and omitting null warm-up points.
