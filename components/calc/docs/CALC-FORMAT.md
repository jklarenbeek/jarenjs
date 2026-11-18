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

`|` → `xor` → `&` → `<< >>` → `+ -` → `* / mod` → prefix `- + ~` → `^`
(right-assoc) → postfix `! %` → primary. Power binds tighter than unary minus
(`-2^2 = -(2^2)`); `^` is exponentiation in **every** mode.

`a mod b` and `a xor b` are the word operators a programmer keypad writes
between two operands. The parser reads them as the calls `mod(a, b)` and
`xor(a, b)`, so the AST has no node of its own for them and `toExpression`
prints the call; `7 mod 3` is `1`, `5 xor 3` is `6`, and `mod(7, 3)` is still
the call it always was. A name after a complete operand is an operator only
when it is one of these two.

### Round-trip fixed point

`toExpression(ast)` is a canonical printer for which
`parseExpression(toExpression(ast))` deep-equals `ast` across the fixture
corpus, and `toExpression` is idempotent on its own output. Parentheses
are emitted from precedence/associativity only where they change the parse.
A number prints as the shortest decimal of its `Number`, except an integer
beyond 2^53 that text would not read back as: it prints as the exact
integer (`9007199254740993` and `0x7FFFFFFFFFFFFFFF` print as
`9007199254740993` and `9223372036854775807`, where they printed the nearest
double's `9007199254740992` and `9223372036854776000`), so the programmer
environment compiles the printed text to the integer it compiled before.

## Compilation & evaluation

`compileExpr(ast, { env }) → (scope) => number` bakes every dispatch
decision into a nested closure (second compiler stage). `evaluate(source,
scope?, { env }?)` is the error-safe front door, returning
`{ ok:true, value } | { ok:false, error:{ message, line?, column?, id?, params? } }` —
it never throws into the app path. `id` and `params` are the diagnostic's
message id and the parameters it renders with (`calc/parse/end`,
`calc/compile/function` with `{ name }`, …) for each of the engine's own
diagnostics; an error a host function or a core kernel throws has neither. `scope` supplies variables (`x`, `y`,
`ans`, …) and runtime flags (`angleMode`, `wordBits`, `signed`).

**Environments** (the binding sets a mode resolves against): `defaultEnv()`
is float/scientific (angle-aware trig, `^` = power); `programmerEnv()`
overrides `& | << >> ~` with word-masked BigInt math from
`@jarenjs/core/math/word.js` and adds `and/or/xor/not/shl/shr/rol/ror/mod`.

> Bitwise **XOR** is the word operator `a xor b` (the `xor(a, b)` function),
> never `^`, so `^` stays exponentiation everywhere.

**Percent reads as a desk calculator reads it.** A percent that is the whole
right operand of a sum or a difference is that percent *of* the left operand:
`a + b%` is `a + a·b/100` and `a − b%` is `a − a·b/100` (`200 + 10%` is `220`,
`200 − 10%` is `180`). Every other percent is its value over 100, which is
already what a desk calculator means: `a × b%` is `a·b/100` (`200 × 10%` is
`20`), `a ÷ b%` is `a/(b/100)` (`200 ÷ 10%` is `2000`), and a lone `b%` is
`b/100`. Parentheses leave no trace in the AST, so `a + (b%)` reads as
`a + b%`; write `a + b/100` to add the plain fraction. The rule composes the
environment's own `*` and `%`, so the programmer environment's exact
arithmetic stays exact.

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

**A division keeps its remainder.** `/` is division, not integer division,
past 2^53 as below it: when an operand is beyond the safe range (a `bigint`,
or a whole `Number` past it) or is itself such a fraction, and neither is a
fractional `Number`, a quotient that is not whole is held as the exact
fraction, so it multiplies back to the dividend as `7/2*2` is `7`:
`(2^53+1)/2*2` is `9007199254740993` and `0xFFFFFFFFFFFFFFFF/2*2` displays
`0xFFFF FFFF FFFF FFFF`, where the quotient was truncated and they were
`9007199254740992` and `0xFFFF FFFF FFFF FFFE`. The fraction stays exact
through `+ - * /`, unary `-`, `^` by a whole non-negative exponent, `abs`,
`min` and `max`; `trunc`/`floor`/`ceil`/`round` of it are exact whole numbers
(`round` half toward +∞, as `Math.round`); a word reads its whole part,
truncated toward zero, as a word reads a `Number`, so the display and the
committed `ans` are the word of the truncated quotient, as they were; a
fractional `Number` operand (`0.5`), a root and every other float function
take its nearest `Number`. A fraction too large for a double is `±Infinity`.
Two safe values still divide as floats. Those answers changed with it:
`ceil((2^53+1)/2)` and `round((2^53+1)/2)` are `4503599627370497`, they were
`4503599627370496`, and `((2^53+1)/2)^2*4` is
`81129638414606699710187514626049`, it was
`81129638414606681695789005144064`.

The public `compileExpr` and `evaluate` answer a `Number` whatever the
environment is, so a big programmer value reads as the nearest double
(`0xFFFFFFFFFFFFFFFF` evaluates to 18446744073709552000); the exact value is
what the calculator component formats. The `Number` a programmer-mode
`evaluate` answers past 2^53 changed as a defect fix: an exact power is
rounded once (`10^23` is `1e+23`, it was `1.0000000000000001e+23`), the
word operations are exact (`~~5` on a 64-bit word is `5`, it was
`18446744073709552000`), and an exact fraction is rounded once to its
nearest `Number` (`(2^55+6)/4` is `9007199254740994`, the double nearest
`9007199254740993.5`, where the truncated quotient gave `9007199254740992`;
`0x7FFFFFFFFFFFFFFF/0x1000000000000000` is `8`, it was `7`, and its word is
still `7`).

**A scope value** is a `Number`, or, in the programmer environment, also a
`bigint` or a decimal-integer string (below), each read as the integer it
holds, exactly (`x: 2n ** 63n - 1n` is `9223372036854775807`; a `bigint`
within ±(2^53 − 1) is the `Number` it equals, and one past what a double
holds is `±Infinity`). Every other environment computes in doubles and
refuses a `bigint`, as it always did: `evaluate('x', { x: 5n })` answers
`{ ok: false }` with the engine's message (`Cannot convert a BigInt value to
a number`), rather than converting it.

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
tone?, span?, aria? }` rows, where `k` is the token the key presses or a
command `clear`/`back`/`equals`, and `aria` the message id of a symbol key's
accessible name), a function-binding env, and a formatter. Only the three
keypad modes show the display, keypad, memory row and tape; the financial and
converter modes show their own panel alone, and the x·y / x·y·z plot belongs
to the scientific mode (the standard mode is the plain calculator).

The financial panel explains itself: what time value of money is, what each
of N, I/Y, PV, PMT and FV means (I/Y is the rate per period: 6% a year paid
monthly is 0.5), the sign convention (money received is positive, money paid
negative, so a 200,000 loan's payment is negative), and the formula it
solves. The unknown's field is read-only and shows the answer, and four
worked examples (`FINANCIAL_EXAMPLES`: a mortgage payment, a savings goal, a
loan's payoff time, an implied return) fill the five values in one click
(`calc/fin-example`). Values with no solution say so instead of `NaN`. `financial` holds **no formulas** (it orchestrates
`@jarenjs/core/finance` via `solveTvm`/`buildAmortization`/`npvOf`/`irrOf`);
`converter` holds **no factors** of its own for the static and currency
dimensions (it orchestrates `@jarenjs/core/convert` via `convertValue`,
currency included); its `fuel` dimension (`l100km`, `mpgus`, `mpguk`, `kml`)
is reciprocal and converts in `convertFuel`, which refuses a negative or
non-finite value and zero across L/100km and the distance-per-fuel units.

### Typing an expression (the component's entry editor)

The calculator component edits the entry key by key (`component/entry.js`,
exported as `pressKeys`, `keyChange`, `applyChange`, `previewOf`):

- After `=`, an operator or a postfix key continues from the result (`ans +`,
  so the next step uses the exact result, not the twelve digits the display
  shows); a digit, `.`, a function, a constant or `ans` starts a new
  expression.
- A key that cannot follow the expression writes nothing: a second `.` in one
  number, `)` with no parenthesis open, `%` or `!` with no operand, a digit the
  number's base lacks (`2` after `0b`). A lone `0` is replaced by the next
  digit. An operator after an operator replaces it, except a `−` that can be
  the next operand's sign (`6 × −2`). A function, constant, `(` or number key
  right after a complete operand multiplies (`2 sin` writes `2*sin(`,
  `(2)(3` writes `(2)*(3`). So no key sequence writes a parse error.
- While an expression is typed the result line is a live preview: the value of
  its longest complete prefix with the open parentheses closed (`2 × (3 +`
  previews `6`), or nothing when no prefix is complete or the value is not
  finite. Typing never shows a diagnostic.
- `=` closes every parenthesis still open (`sin 30 =` is `sin(30)`) and
  evaluates. An expression that still cannot complete shows one message,
  *Incomplete expression*; a value outside the real numbers (`√−4`,
  `asin(2)`) *No real result*; `±∞` (`1 ÷ 0`, an overflow) *The result is
  infinite*; a programmer division by zero *No result*; a function or name an
  environment lacks its own sentence (`unknown function 'f'`). None carries a
  parser position. The next key dismisses the message.
- Clear (`AC`) clears the expression, the result line and the message.
- The result line shows twelve significant digits with no zeros padding the
  mantissa (`9.99e+22`), a safe integer in full, and grouped thousands
  (`2,000`); the committed entry is the same value ungrouped, a literal the
  parser reads back. The converter shows eight significant digits and a
  currency in its minor units (two decimals, none for the yen, eight for a
  crypto asset).

In the programmer mode each result is truncated toward zero and wrapped to
the selected word size when it is shown and committed; inside one expression
`+ − ×` are exact and `÷` keeps the exact fraction (`7 ÷ 2 × 2` is `7`). The
page says so under the four-base view.

`bindCalcKeyboard(root, app)` (from `@jarenjs/calc/component`) is the host
listener that types into the keypad while focus is inside it (`.calc-pad`,
which takes focus): digits, `+ - * / ^ % ( ) .` (and `,` for the point),
Enter or `=` for equals, Backspace, Escape (or Delete) to clear, and in the
programmer mode `a`–`f` as hex digits, `%` as `mod` and `<`/`>` as the
shifts. It suppresses the browser default of exactly the keys it takes, so
Enter on a focused keypad button evaluates once, and leaves Tab, Space and
every Ctrl/Meta/Alt shortcut alone; focus in a financial, converter or plot
field never types into the calculator.

## Plotting

`plot2d`/`plot3d` (and `calcToVnode`) produce pure-vnode SVG rooted at
`['svg', …]`. They build a deterministic **scene** (geometry as plain JSON
— golden-testable) then render it. 2D compiles `f(x)` once, samples into a
`Float64Array`, maps to the viewport and breaks the path on NaN/±Inf and
asymptote jumps. 3D samples `z = f(x,y)` on a grid, rotates/projects with
the core `mat4`/`project.js` kernel, builds quads, **depth-sorts
back-to-front (painter's algorithm)** and shades by height.
`toSvgString(vnode)` gives a standalone SSR string.
