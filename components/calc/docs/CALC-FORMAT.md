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
> `^` stays exponentiation everywhere.

**Programmer integers are exact.** In `programmerEnv()` a value is a
`number`, or a `bigint` once it is a whole number beyond ±(2^53 − 1). An
integer literal (`0xFFFFFFFFFFFFFFFF`, `9007199254740993`), `+ - *`, unary
`-`, `/` and `%` of whole numbers, `^` of a whole base by a whole non-negative
exponent, the word operators and functions, `abs`, `min`, `max` and
`trunc`/`floor`/`ceil`/`round` of one argument are computed on that value, so
a 64-bit result is the integer it is: `0xFFFFFFFFFFFFFFFF` on a 64-bit word
displays `0xFFFF FFFF FFFF FFFF`, `2^64 - 1` and `not(0)` do the same, and
`0xFFFFFFFF * 0xFFFFFFFF` is `0xFFFF FFFE 0000 0001`. The display wraps the
exact value to the word, as `word.js` does, and the committed entry is that
displayed text, which evaluates to the same word again. Every operation on
two safe values is the float operation it always was (`7/2` is `3.5`, `7/2*2`
is `7`), and a function with no integer meaning (`sqrt`, `sin`, `!`,
rounding to digits) takes the nearest `Number` of a big operand.

The public `compileExpr` and `evaluate` answer a `Number` whatever the
environment is, so a big programmer value reads as the nearest double
(`0xFFFFFFFFFFFFFFFF` evaluates to 18446744073709552000); the exact value is
what the calculator component formats. The `Number` a programmer-mode
`evaluate` answers past 2^53 changed as a defect fix: an exact power is
rounded once (`10^23` is `1e+23`, it was `1.0000000000000001e+23`) and the
word operations are exact (`~~5` on a 64-bit word is `5`, it was
`18446744073709552000`). The limits that remain: a division
with a remainder whose quotient is beyond 2^53 is truncated, which is all a
double that large holds of it; a scope value must be a `Number` (or, in the
programmer environment, a decimal-integer string, below), and a `bigint` is
refused, as it always was; and `toExpression` prints a literal beyond 2^53 as
that nearest `Number`.

**The state slice keeps the exact word.** `ans` and `memory` stay JSON numbers
(the nearest double). A programmer-mode word beyond ±(2^53 − 1) is also written
as decimal text in `ansExact` / `memoryExact` (`'18446744073709551615'` for an
unsigned 64-bit all-ones word; the empty text beside a word a `Number` holds).
Calculation reads the text instead of the number only in the programmer mode
and only while it is the integer the number rounds from, so a host that patches
`ans` or `memory` alone, or a state saved before the members existed, reads as
the number it holds. In the programmer environment a scope value that is a
string of decimal digits (an optional leading `-`) is the integer it spells,
exactly; any other string reads as `+value` does. `M+` adds the two words as
integers (unwrapped, as before) when both are whole, and as floats otherwise.
The `memory` member of the viewModel is that decimal text while an exact word is
held and the `Number` otherwise. A decimal-integer string that reads within
±(2^53 − 1) is the `Number` `+value` gives, as before. `calc/commit` takes an
optional `exact` payload member (absent reads as the empty text).

Every function declares how many arguments it takes — the environment's
`arity` table, `[min, max]` per function name — and a call outside that range
is a `CalcParseError` when the expression compiles (`or() expected 2
arguments, got 3`); a surplus argument used to be ignored and a missing one
read as `NaN`. `log` and `round` take an optional second argument; `min`, `max`
and `hypot` take one or more (an empty `min()`, `max()` or `hypot()`, which
answered `Infinity`, `-Infinity` or `0`, is refused). A function name resolves only through the
environment's own members, never through `Object.prototype`, and a word
operation on a non-finite operand is refused (`a word operand must be a finite
number, got NaN`) rather than failing with the engine's BigInt message. An
environment without an `arity` table is not checked.

## Modes

Each mode (`standard`, `scientific`, `programmer`, `financial`,
`converter`) is a data-driven descriptor: a keypad/panel (`{ label, k,
tone?, span? }` rows, where `k` is the token appended to the expression
entry or a command `clear`/`back`/`equals`), a function-binding env, and a
formatter. `financial` holds **no formulas** (it orchestrates
`@jarenjs/core/finance` via `solveTvm`/`buildAmortization`/`npvOf`/`irrOf`);
`converter` holds **no factors** of its own for the static and currency
dimensions (it orchestrates `@jarenjs/core/convert` via `convertValue`,
currency included); its `fuel` dimension (`l100km`, `mpgus`, `mpguk`, `kml`)
is reciprocal and converts in `convertFuel`, which refuses a negative or
non-finite value and zero across L/100km and the distance-per-fuel units.

## Plotting

`plot2d`/`plot3d` (and `calcToVnode`) produce pure-vnode SVG rooted at
`['svg', …]`. They build a deterministic **scene** (geometry as plain JSON
— golden-testable) then render it. 2D compiles `f(x)` once, samples into a
`Float64Array`, maps to the viewport and breaks the path on NaN/±Inf and
asymptote jumps. 3D samples `z = f(x,y)` on a grid, rotates/projects with
the core `mat4`/`project.js` kernel, builds quads, **depth-sorts
back-to-front (painter's algorithm)** and shades by height.
`toSvgString(vnode)` gives a standalone SSR string.
