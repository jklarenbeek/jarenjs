# @jarenjs/calc

A native, headless **multi-mode calculator** for the jarenjs stack:
standard / scientific / programmer / financial / converter, with **x·y and
x·y·z plotting rendered as pure-vnode SVG** through `@jarenjs/view`. The
calculator *is* an `@jarenjs/app` document (state is JSON, keys are data
bindings, transitions are copy-on-write RFC-6902 patches), and it is built
on `@jarenjs/core` — it holds no formulas, and no unit factors beyond the reciprocal fuel-economy
constants.

Zero runtime dependencies beyond `@jarenjs/*`. No `eval`, no `new
Function` (CSP-safe). SSR-able and deterministic.

## Two layers

- **Engine** (`@jarenjs/calc`) — pure functions over data. A two-stage
  expression compiler `parseExpression(text) → ExprAST → compileExpr →
  (scope) => value`, its canonical printer `toExpression` (a round-trip
  fixed point), and `plot2d`/`plot3d`/`calcToVnode` (pure-vnode SVG).
  Imports only `@jarenjs/core` + `@jarenjs/view`.
- **Component** (`@jarenjs/calc/component`) — the `@jarenjs/app` glue:
  `createCalcComponent()` → `{ initialState, actions, mode, rules,
  effects, subs, viewModel, createApp }`, the keypad/panel JSLT view, the
  financial `@jarenjs/forms` panel, and the live crypto/fiat rates layer.

```js
import { evaluate, parseExpression, toExpression, plot2d, toSvgString } from '@jarenjs/calc';

evaluate('sin(pi/2) + 2^10').value;          // 1025
toExpression(parseExpression('a-(b-c)'));    // "a - (b - c)"
toSvgString(plot2d('sin(x)', { domain: [-6.28, 6.28] })); // standalone SVG
```

```js
import { createCalcComponent } from '@jarenjs/calc/component';
const calc = createCalcComponent({ provider: 'coingecko' });
const app = calc.createApp({ node: document.getElementById('calc') });
```

`createCalcComponent({ codes, fallbackRates })` uses those currency choices and
fallback rates for its exposed configuration and both initialization paths.
Programmer Equals records the selected base on the tape; grouping spaces stay
out of the committed expression so it can be used in the next calculation.

## The numeric kernel lives in `@jarenjs/core`

Reusable primitives were pushed *down* into core, so any package can use
them: `@jarenjs/core/math` (transcendentals, `word.js` BigInt word math,
`solve.js` root finders, `mat4`/`project.js` 3D kernel, `format.js`),
`@jarenjs/core/finance` (TVM, cash-flow, amortization, interest,
depreciation, bond, indicators, returns) and `@jarenjs/core/convert`
(fixed-factor dimensional conversion + the pure `convertCurrency` rate-table
primitive). The calculator's financial mode calls `core/finance`; its
converter calls `core/convert` for every dimension but fuel economy, which is
reciprocal and converts in the calculator's own `convertFuel`. Core is pure and
never fetches.

Changing the converter dimension updates its unit selections in the same
transition. Existing choices survive when the new dimension offers them;
otherwise it selects the first two available units (the same unit for both
sides when only one exists). Currency choices come from the current rate
table. A dimension with no available units leaves the conversion unchanged.

## Fuel economy

The converter's `fuel` dimension converts between `l100km` (L/100km),
`mpgus` (mpg, US gallon), `mpguk` (mpg, imperial gallon) and `kml` (km/L). It
is reciprocal rather than affine: L/100km is fuel per distance and the others
are distance per fuel, so a conversion across the two kinds is a constant
divided by the value (8 L/100km is 100 / 8 = 12.5 km/L), not a factor times it.
The mpg constants follow from the US gallon (3.785411784 L), the imperial
gallon (4.54609 L) and the mile (1.609344 km), each exact by definition, and
each is one division of two integers.

```js
import { convertFuel, convertValue } from '@jarenjs/calc';

convertFuel(8, 'l100km', 'kml');       // 12.5
convertFuel(8, 'l100km', 'mpgus');     // 29.401822916666667
convertFuel(30, 'mpgus', 'mpguk');     // 36.028497765145644
convertFuel(0, 'kml', 'mpgus');        // 0
convertFuel(0, 'l100km', 'kml');       // RangeError: convertFuel: 0 L/100km has no finite km/L
convertValue('fuel', 0, 'l100km', 'kml'); // NaN, shown as — in the panel
```

`FUEL` is the dimension id (`'fuel'`) and `FUEL_UNITS` the frozen list of the
four units, each `{ id, symbol, k }`: `k` is the consumption in L/100km of a
vehicle at exactly 1 of that unit (`null` for L/100km itself), the constant
every conversion across the two kinds divides by.

An economy is a finite number of zero or more. Zero between two
distance-per-fuel units stays zero; zero across the reciprocal (a vehicle that
burns no fuel, or goes nowhere on it) has no finite answer and is refused, as
is a negative or non-finite value, an unknown unit or a result beyond the
double range (overflowing, or underflowing to zero). `convertFuel` throws a `RangeError`;
`convertValue` keeps its contract of never throwing and answers `NaN`, which
the panel shows as `—`.

## Live currency (the maturity example)

The converter's currency dimension takes live crypto+fiat rates from free
public tickers (CoinGecko default, Binance alternative) through an
`@jarenjs/app` effect + a `when`-gated polling subscription. The **pure
conversion** is `@jarenjs/core/convert`'s `convertCurrency`; only the
*fetch* is component-side. A static fallback table keeps the converter,
SSR and offline tests working with no network; failures route to an error
action. When refreshes overlap, only the newest request may publish success
or failure; an older completion cannot replace its rates or clear its
in-flight status.

Answers that changed (upgrade notes): `=` on a result that is not a finite
number (`1/0`, `0/0`, a programmer value with no word) leaves the typed
expression as the entry, where it committed `∞`, `NaN` or `—`, which do not
evaluate; a fetched rate table is marked `status: 'ok'` and not stale, where
the converter went on printing `rates: idle`; a plot domain narrower than the
spacing of doubles at its position (near 1e16) lays one tick, where it grew
its tick array until the engine refused to allocate it; an unknown function, a
wrong argument count and a constant the environment lacks report the line and
column of the call (they reported line 1 column 1 wherever it stood; the parser
records the position in a side table, so the AST itself stays geometry-free);
a programmer result beyond 2^53 is the exact word, where the value was rounded
to a double before the display wrapped it (`0xFFFFFFFFFFFFFFFF` on a 64-bit
word displayed `0x0` and now displays `0xFFFF FFFF FFFF FFFF`; `not(0)` and
`0xFFFFFFFFFFFFFFFF & 0xFF00000000000001` were wrong the same way). The `ans`
and memory a state slice holds are still JSON numbers, exact to 2^53, so `=` shows the exact
word while clearing the entry, reusing `ans` and `M+` use the rounded one. A programmer-mode
`evaluate` answer past 2^53 changed too: an exact power is rounded once and the word
operations are exact (see CALC-FORMAT).

See `docs/CALC-FORMAT.md` and `ARCHITECTURE.md` for the full contract.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.calc-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/calc` | JavaScript | declared |
| `@jarenjs/calc/component` | JavaScript | declared |
| `@jarenjs/calc/theme` | JavaScript | declared |
| `@jarenjs/calc/styles/calc.css` | asset | — |
| `@jarenjs/calc/schemas/financial-inputs.schema.json` | schema | — |
| `@jarenjs/calc/schemas/jaren-calc-ast.schema.json` | schema | — |
| `@jarenjs/calc/schemas/jaren-calc-state.schema.json` | schema | — |
| `@jarenjs/calc/package.json` | metadata | — |
<!--/fact-->
