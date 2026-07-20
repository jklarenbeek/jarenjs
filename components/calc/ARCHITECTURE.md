# @jarenjs/calc — architecture

Two layers, a one-way dependency arrow, and a strict purity boundary.

```
              @jarenjs/core (math · finance · convert)   ← pure kernel, no I/O
                        ▲
                        │ imports
   engine  src/*  ──────┘  parseExpression ⇄ toExpression, compileExpr,
     │                     plot2d/plot3d → pure-vnode SVG (via @jarenjs/view)
     │ imports (one way)
     ▼
   component  src/component/* ── @jarenjs/app + @jarenjs/forms glue,
                                 the JSLT view, the impure rates fetch
```

## The purity boundary (the design axis)

`@jarenjs/core` (math/finance/convert) is **pure**: zero runtime deps, no
I/O, no DOM, deterministic. The pure currency conversion
`convertCurrency(value, from, to, rateTable)` lives in `core/convert` and
**receives** the rate table — it never fetches. Only the impure half
(fetching rates via CoinGecko/Binance adapters) lives in the component,
behind `@jarenjs/app` effects/subscriptions. The seam is purity, not
constant-vs-variable factors.

## Engine (`src/*`)

- `parser/index.js` — char-offset recursive descent, precedence climbing,
  module-const sticky regexes, `fail → CalcParseError{line,column}`.
- `ast.js` — monomorphic node constructors; `astEqual` for round-trip.
- `to-expr.js` — canonical printer; `parseExpression(toExpression(ast))`
  deep-equals `ast` (a fixed point) and is idempotent.
- `env.js` / `compile.js` — the binding environments (float / programmer
  word-math) and the compile-to-closure second stage; `evaluate` is the
  error-safe front door.
- `modes/*` — the five data-driven mode kernels (keypad + env + formatter).
  `financial` orchestrates `core/finance` (no formulas); `converter`
  orchestrates `core/convert` (no factors).
- `plot/plot2d.js`, `plot/plot3d.js` — geometry-as-JSON scene builders +
  scene→SVG renderers. 3D uses the core `mat4`/`project.js` kernel and
  painter's-algorithm depth sort.
- `render/svg.js`, `render/error.js`, `theme.js`, `utils.js` — SVG vnode
  helpers (adapted from mermaid), the error vnode, `--calc-*` theme tokens,
  and the byte-reused `hashContent`.

## Component (`src/component/*`)

- `index.js` — `createCalcComponent()`: `initialState`, `actions`
  (patch/effect query documents + spread `createFormActions`), `viewModel`
  (`contributeCalcViewModel`), `rules`, `effects`, `subs`, `createApp`.
- `rules.js` — the `calculator` JSLT view.
- `schema.js` / `schemas/*` — the financial form schema + AST/state schemas.
- `rates/*` — CoinGecko + Binance adapters, the `rates-fetch` effect and
  `rates-poll` subscription (min-refresh debounce, last-good + static
  fallback, error routing). All network is here; core never fetches.

## The app document (D4)

State (`$.calc`) is plain JSON, immutable, copy-on-write via
`@jarenjs/json/patch`. Keys dispatch `{action, with}` bindings; actions
return `patch`/`effects` transitions. The display string, four-base views,
plot vnode and forms model are derived in the `viewModel` boundary — never
stored in state. `=` and backspace route through JS effects (`calc-eval`,
`calc-edit`) because evaluation is JS; everything else is a pure patch.
Works headless (omit `node`) → SSR / replay for free.
