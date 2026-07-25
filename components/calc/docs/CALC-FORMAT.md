# CALC-FORMAT — the `@jarenjs/calc` expression AST & mode contract

`@jarenjs/calc` is a two-layer package: a pure
**engine** (`src/*`, knows only `@jarenjs/core` + `@jarenjs/view`) and a
**component** (`src/component/`, adds `@jarenjs/app` + `@jarenjs/forms`).
This document is the engine contract.

## Expression AST

`parseExpression(text) → ExprAST` is a char-offset recursive-descent,
precedence-climbing parser (no `eval`, no `new Function`). Nodes are
monomorphic plain objects tagged by `type`; the AST is **geometry-free**
and does not preserve a literal's radix or source spacing. Node kinds:

| kind | shape |
|------|-------|
| `num` | `{ type:'num', value }` |
| `const` | `{ type:'const', name }` — `pi`,`e`,`phi`,`tau`,`inf`,`nan` (+ `π φ τ`) |
| `var` | `{ type:'var', name }` — free identifiers (`x`,`y`,`ans`,…) |
| `unary` | `{ type:'unary', op, arg }` — `- + ~` (prefix) |
| `postfix` | `{ type:'postfix', op, arg }` — `!` (factorial), `%` (percent) |
| `binary` | `{ type:'binary', op, left, right }` — `+ - * / ^ & \| << >>` |
| `call` | `{ type:'call', name, args }` |

The schema `schemas/jaren-calc-ast.schema.json` (draft-neutral) validates it.

### Grammar / precedence (low → high)

`|` → `&` → `<< >>` → `+ -` → `* /` → prefix `- + ~` → `^` (right-assoc) →
postfix `! %` → primary. Power binds tighter than unary minus
(`-2^2 = -(2^2)`); `^` is exponentiation in **every** mode.

### Round-trip fixed point

`toExpression(ast)` is a canonical printer for which
`parseExpression(toExpression(ast))` deep-equals `ast` across the fixture
corpus, and `toExpression` is idempotent on its own output. Parentheses
are emitted from precedence/associativity only where they change the parse.

## Compilation & evaluation

`compileExpr(ast, { env }) → (scope) => number` bakes every dispatch
decision into a nested closure (second compiler stage). `evaluate(source,
scope?, { env }?)` is the error-safe front door, returning
`{ ok:true, value } | { ok:false, error:{ message, line?, column? } }` —
it never throws into the app path. `scope` supplies variables (`x`, `y`,
`ans`, …) and runtime flags (`angleMode`, `wordBits`, `signed`).

**Environments** (the binding sets a mode resolves against): `defaultEnv()`
is float/scientific (angle-aware trig, `^` = power); `programmerEnv()`
overrides `& | << >> ~` with word-masked BigInt math from
`@jarenjs/core/math/word.js` and adds `and/or/xor/not/shl/shr/rol/ror/mod`.

> Bitwise **XOR** is the `xor(a, b)` function (not an infix operator), so
> `^` stays exponentiation everywhere. Programmer results are surfaced as
> `Number`; values beyond 2^53 lose precision when read back as a float —
> the four-base display uses `word.js` on BigInt directly and stays exact.

## Modes

Each mode (`standard`, `scientific`, `programmer`, `financial`,
`converter`) is a data-driven descriptor: a keypad/panel (`{ label, k,
tone?, span? }` rows, where `k` is the token appended to the expression
entry or a command `clear`/`back`/`equals`), a function-binding env, and a
formatter. `financial` holds **no formulas** (it orchestrates
`@jarenjs/core/finance` via `solveTvm`/`buildAmortization`/`npvOf`/`irrOf`);
`converter` holds **no factors** (it orchestrates `@jarenjs/core/convert`
via `convertValue`, currency included).

## Plotting

`plot2d`/`plot3d` (and `calcToVnode`) produce pure-vnode SVG rooted at
`['svg', …]`. They build a deterministic **scene** (geometry as plain JSON
— golden-testable) then render it. 2D compiles `f(x)` once, samples into a
`Float64Array`, maps to the viewport and breaks the path on NaN/±Inf and
asymptote jumps. 3D samples `z = f(x,y)` on a grid, rotates/projects with
the core `mat4`/`project.js` kernel, builds quads, **depth-sorts
back-to-front (painter's algorithm)** and shades by height.
`toSvgString(vnode)` gives a standalone SSR string.
