# @jarenjs/calc

A native, headless **multi-mode calculator** for the jarenjs stack:
standard / scientific / programmer / financial / converter, with **x·y and
x·y·z plotting rendered as pure-vnode SVG** through `@jarenjs/view`. The
calculator *is* an `@jarenjs/app` document (state is JSON, keys are data
bindings, transitions are copy-on-write RFC-6902 patches), and it is built
on `@jarenjs/core` — it holds no formulas or unit factors of its own.

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

## The numeric kernel lives in `@jarenjs/core`

Reusable primitives were pushed *down* into core, so any package can use
them: `@jarenjs/core/math` (transcendentals, `word.js` BigInt word math,
`solve.js` root finders, `mat4`/`project.js` 3D kernel, `format.js`),
`@jarenjs/core/finance` (TVM, cash-flow, amortization, interest,
depreciation, bond, indicators, returns) and `@jarenjs/core/convert`
(fixed-factor dimensional conversion + the pure `convertCurrency` rate-table
primitive). The calculator's financial mode calls `core/finance`; its
converter calls `core/convert`. Core is pure and never fetches.

## Live currency (the maturity example)

The converter's currency dimension takes live crypto+fiat rates from free
public tickers (CoinGecko default, Binance alternative) through an
`@jarenjs/app` effect + a `when`-gated polling subscription. The **pure
conversion** is `@jarenjs/core/convert`'s `convertCurrency`; only the
*fetch* is component-side. A static fallback table keeps the converter,
SSR and offline tests working with no network; failures route to an error
action.

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
