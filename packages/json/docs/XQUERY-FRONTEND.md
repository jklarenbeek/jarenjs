# The XQuery Text Front-End

**Version 0.1 — Front-end guide (non-normative)**

Module: `@jarenjs/json/xquery`.

This document describes `parseXQuery(text)`: a parser for a defined
**subset of XQuery 3.1 text syntax** that emits Jaren JSON Query documents.
The JSON query document ([QUERY-FORMAT.md](./QUERY-FORMAT.md)) is the
canonical language; this front-end is (a) a human authoring syntax and (b)
the compatibility bridge that makes XQuery-oriented test material (the QT3
suite) runnable against the engine. It is **not a second engine**: the
output is always a query document that `compileJsonQuery` consumes, and
where the two languages disagree, the JSON format's semantics win.
QUERY-FORMAT.md is authoritative; this document only defines the text →
document mapping.

## 1. API

```js
import { parseXQuery, compileXQuery, XQuerySyntaxError } from '@jarenjs/json/xquery';

parseXQuery('for $x in (1,2,3) return $x * 2');
// -> { "$for": { "x": { "$seq": [1, 2, 3] } }, "$return": { "$mul": ["$x", 2] } }

const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');
q.externals;          // ['doc']
q(null, { doc: data }); // parse + compile convenience; returns the engine's compiled query
```

- `parseXQuery(text) -> document` — a valid query document (the version
  envelope is never emitted). The parser never emits an invalid document:
  every output validates against `jaren-query.schema.json`.
- `compileXQuery(text, options?)` — `compileJsonQuery(parseXQuery(text), options)`;
  returns the engine's compiled query function (`query(data, externals?)`,
  `.first`, `.exists`, `.externals`, `.doc`).
- `XQuerySyntaxError extends SyntaxError` — carries `source` and `position`
  (mirrors `JSONPathSyntaxError`). Constructs outside the subset fail with
  stable, machine-greppable messages:

  | Message shape | Meaning |
  |---|---|
  | `unsupported construct '<name>'` | recognized XQuery construct outside the subset |
  | `unsupported function '<name>'` / `unsupported function '<name>#<arity>'` | function (or an arity of one) outside the mapping table |
  | `unsupported construct 'tokenize flag <f>'` / `'tokenize flags other than a literal'` / `'tokenize flag q with a computed pattern'` | `fn:tokenize` flags an I-Regexp cannot honour, or that are not known as the query is read (§4.6) |
  | `unsupported construct 'cast as <name>'` / `'castable as <name>'` | a cast to a type outside the mapped ones (§4.6) |
  | `unsupported construct 'xs:date with a timezone'`, `'xs:dateTime without a timezone'`, ... | a date or time value outside the values the front-end reads (§4.9) |
  | `unsupported construct '<use> of a value that may be a date'`, `'date arithmetic'` | a use of a value whose date type the query does not fix, the difference of two dates (§3, §4.9) |
  | `unsupported construct 'format-number picture with a percent and a per-mille sub-picture'` | a picture whose sub-pictures multiply by different signs (§4.8) |
  | `unsupported clause order: '<kw>' after '<kw>'` | FLWOR clause sequence that cannot be expressed by nesting (§5.1) |
  | `unsupported variable name '<name>'`, `unsupported lookup index 0 ...` | lexeme outside the JSON format's rules |

  Anything *not* prefixed `unsupported` is a plain syntax error — text that
  is not valid XQuery 3.1 to begin with — with one exception: text that
  nests deeper than 256 levels is refused by position as
  `the expression nests deeper than 256 levels`. The levels are the
  source text's: every nested expression (a parenthesized one included)
  and every phrase a FLWOR's clauses nest into counts one. 256 is the
  number `compileJsonQuery` enforces on a document's nesting (`JQ0011`),
  but the two counts differ: 256 parentheses around `1` mean just `1`, a
  document that compiles, and are refused here all the same, while a long
  `1 + 1 + …` chain parses and is refused by `compileJsonQuery` instead.
  Text from 257 levels up to the host's stack limit (about 500 to 600
  nested parentheses, arrays or maps on Node's default stack) used to
  parse and is now refused; only deeper text used to escape as a
  `RangeError`.

## 2. Accessing the input document

The JSON format's absolute paths (`"$.store.book[*]"`) have **no textual
XQuery equivalent in v1**: the context item `.` and `/`-rooted path
expressions are outside the subset. Bind the document (or any part of it)
as an **external parameter** instead — in the JSON format, use is the
declaration (QUERY-FORMAT.md §9), and `declare variable $doc external;` is
accepted for compatibility:

```xquery
declare variable $doc external;
for $b in $doc?store?book?*
where $b?price lt 10
return $b?title
```

```js
compileXQuery(text)(null, { doc: inputDocument });
```

## 3. Prominent caveats

> ### ⚠ 1-based XQuery vs 0-based JSON positions (D6)
>
> RFC 9535 and the JSON query format are 0-based (deviation **D6**);
> XQuery is 1-based. The front-end splits the difference along a single
> rule — **positional inputs and `fn:index-of` results are adjusted, positional
> bindings are not**:
>
> **Adjusted at parse time** (the text means what XQuery says it means):
> - `?N` lookups: `$b?1` → `"$b[0]"` (`?0` is an `unsupported lookup index` error);
> - `fn:substring` / `fn:subsequence` *start* arguments: `substring("hello", 2)`
>   → `{"$substring": ["hello", 1]}` (a non-literal start emits
>   `{"$sub": [start, 1]}`; length arguments are counts and pass through);
> - `array:get`: `array:get($a, 1)` → `{"$get": ["$a", 0]}`
>   (`map:get` keys are values, not positions — never adjusted);
> - `fn:index-of` *results*: each position the engine's `$index-of` answers is
>   shifted in the emission, `index-of($xs, 3)` →
>   `{"$for": {"io_at": {"$index-of": ["$xs", 3]}}, "$return": {"$add": ["$io_at", 1]}}`
>   (the operands are read outside the binding, so a variable named `io_at`
>   in the query is never captured).
>
> **Not adjusted — 0-based values surface** (deviation carried into the
> front-end, because these are *bindings* the parser cannot locally rewrite):
> - `for $x at $i in ...` — `$i` counts from **0**, not 1;
> - `count $c` — `$c` counts from **0**.
>
> These two stay 0-based by design. Making them 1-based means rewriting
> every reference to the bound variable (`$i` → `$i + 1`) through every
> nested scope that can see it, which turns a one-token binding into a
> scope-tracking rewrite of the whole query, for no change to what the JSON
> format computes. The QT3 scorecard counts the test cases that assert a
> 1-based `at` or `count` value as wrong-value failures. Where a 1-based
> position is wanted, write it: `for $x at $i in $xs return $i + 1`.
>
> *Upgrade: `fn:index-of` used to answer the engine's 0-based positions, so
> `index-of((10, 20), 20)` answered `1`; it now answers `2`. A query that
> compensated with `+ 1` must drop it, and the emitted document is no longer a
> bare `$index-of`.*

> ### ⚠ Value comparisons are mapped to general comparisons
>
> `eq ne lt le gt ge` emit the same operators as `= != < <= > >=`
> (`$eq`-family, existential over sequences). For **singleton** operands
> the two behave identically. For non-singletons XQuery raises a type
> error on value comparisons while this mapping evaluates existentially,
> and `1 eq ()` is `false` here instead of XQuery's empty sequence (the
> difference disappears under EBV, e.g. in `where`). A front-end
> approximation — use singletons with value comparisons.

> ### ⚠ `fn:matches` maps to `$search`, and regexes are I-Regexp
>
> F&O `fn:matches` tests a **substring** match, which is the JSON format's
> `$search` (`$match` is the *anchored* RFC 9535 `match()` — no XQuery
> function maps to it). Patterns are **I-Regexp (RFC 9485)**, not XSD
> regular expressions (deviation **D5**); there is no flags argument
> (`matches#3`, `replace#4` are unsupported arities).

> ### ⚠ Square array constructors flatten their members
>
> `[E1, E2]` emits a JSON array constructor, which **flattens each
> member's sequence** (QUERY-FORMAT.md §3.4): `[(1,2), 3]` constructs
> `[1, 2, 3]` — three members. XQuery's square constructor would keep
> `(1,2)` as one sequence-valued member, which a JSON array cannot hold.
> `array { ... }` has identical flattening semantics in both languages.
> Members that are singletons (the JSON-shaped case) agree everywhere.

> ### ⚠ `xs:` constructors and casts: one number type, JSON-model values
>
> `xs:integer`, `xs:decimal`, `xs:double`, `xs:float`, `xs:boolean`,
> `xs:string` and the integer types XSD derives by range (`xs:long`,
> `xs:int`, ..., `xs:negativeInteger`) are constructor functions and the
> types `cast as` and `castable as` take (§4.6). The engine has one number
> type (**D1**), so the numeric types differ in the *text and values
> they accept and the errors they raise*, not in the value they give:
> `xs:float` is a double (no single-precision rounding, range or
> overflow to `INF`), `xs:integer(7.9)` is `7`, and an integer or decimal
> beyond 2^53 loses precision (`xs:long` and `xs:unsignedLong` check their
> range on that double). A cast that fails raises `JQ2001` (the
> analogue of `FORG0001`, `FOCA0002` and `XPTY0004` alike), when the cast is
> evaluated, never when the query is read. `xs:date`, `xs:dateTime` and
> `xs:time` are mapped for the values whose RFC 3339 text the engine reads
> right (§4.9); the other `xs:` types (durations, the `g` types, binary,
> `xs:untypedAtomic`, ...) stay outside the subset (§6).

> ### ⚠ A date is a string, typed as the query is read
>
> JSON has no date type, so a constructed `xs:date`, `xs:dateTime` or
> `xs:time` is its RFC 3339 text (§4.9), and every engine operator would
> read it as the string it is. The front-end therefore types it: the result
> of a date constructor or cast, a variable bound to one, the items `head`,
> `subsequence`, `if` or a FLWOR pass on, carry the date type, and every use
> XQuery types as an error raises XQuery's code where it is evaluated —
> `JQ2001` whose message names it and the position (`'FORG0006: an xs:date
> has no effective boolean value (position 0)'`). Within one type the answers
> are XQuery's: comparisons order by time, `string()`, `concat` and
> `string-join` give the canonical text, `min` and `max` pick by time. §4.9
> lists the uses. A use whose operand may or may not be a date (an item of
> `(xs:date(...), "a")`, a member looked up in an array or a map that holds
> one) is refused by name (`unsupported construct 'the effective boolean
> value of a value that may be a date'`). The difference of two dates is a
> duration, a type outside the subset (`unsupported construct 'date
> arithmetic'`).

## 4. The supported subset

### 4.1 Prolog

| Construct | Handling |
|---|---|
| `xquery version "3.1";` (optional `encoding "..."`) | parsed, ignored |
| `(: comments :)` (nestable) | whitespace, legal between any two tokens |
| `declare variable $x external;` | validated, emits nothing (use is the declaration, §2) |
| `declare variable $x := ...`, `... external := ...` | error `unsupported construct 'variable declaration with default value'` |
| any other declaration, `declare` followed by `function`, `namespace`, `default`, `option`, `base-uri`, `boundary-space`, `copy-namespaces`, `construction`, `ordering`, `context`, `decimal-format`, `revalidation` or `updating` | error `unsupported construct 'declare <kind>'` |
| `declare` followed by any other word, or by no word | a name test like any other: `unsupported construct 'path expression'` (`declare ne gt`), or `unexpected keyword 'declare'` before an operand |
| `import module` / `import schema`, `module namespace` (library modules), at the start of the prolog | error `unsupported construct 'import module'` / `'library module'` |
| `import` or `module` anywhere else, or at the start without `module`/`schema`/`namespace` after it | a name test like any other: `unsupported construct 'path expression'` (`import eq 1`), or `unexpected keyword 'import'` before an operand |

### 4.2 Expressions, by precedence

| XQuery construct | Emitted JSON form |
|---|---|
| `E1, E2, ...` (top level, in `( )`, in `if (...)`) | `{"$seq": [E1, E2, ...]}` |
| FLWOR `for/let/where/group by/order by/count/return` | FLWOR phrase, nested when needed (§5) |
| `some $x in E satisfies C` / `every ...` | `{"$some": {x: E}, "$satisfies": C}` / `$every` |
| `if (C) then T else E` | `{"$if": [C, T, E]}`; `else ()` folds to `{"$if": [C, T]}` |
| `A or B or ...` / `A and B and ...` | `{"$or": [A, B, ...]}` / `{"$and": [...]}` (variadic) |
| `= != < <= > >=` and `eq ne lt le gt ge` | `{"$eq": [L, R]}`, `$ne`, `$lt`, `$le`, `$gt`, `$ge` (caveat §3) |
| `A \|\| B \|\| ...` | `{"$concat": [A, B, ...]}` |
| `A to B` | `{"$range": [A, B]}` |
| `+ - * div idiv mod` | `$add $sub $mul $div $idiv $mod` (binary, left-associative) |
| `E cast as T`, `E cast as T?`, `E castable as T`, `E castable as T?` | the cast's `$let` phrase, or the folded literal (§4.6) |
| unary `-E` / `+E` | `{"$neg": E}` (folded into number literals: `-5` → `-5`) / no-op |
| postfix lookup `?name ?N ?*` | path fold, `$let`-bound path, or `$get` (§4.3) |
| `map { K: V, ... }` | plain map constructor / `$map` (§4.4) |
| `[E, ...]`, `array { E }` | array constructor `[E, ...]` (flattening caveat §3) |
| `( E )` / `()` | the inner expression / `{"$seq": []}` |
| string literals (both quotes, `""`/`''` doubling) | literal string, `$$`-escaped when it starts with `$` (`"$price"` → `"$$price"`) |
| number literals (`7`, `.5`, `1.`, `1.5e2`, leading zeros allowed) | the JSON number value |
| `true()` / `false()` | `true` / `false` (XQuery has no boolean literals) |
| `$name` | `"$name"` (whole-variable reference) |
| function calls | operator vocabulary via the mapping table (§4.5) |

### 4.3 Postfix lookup and path folding

When the base is a **variable reference or a chain of lookups from one**,
the whole chain folds into one variable-rooted RFC 9535 path string —
per-item application over the variable's sequence, exactly XQuery's
postfix-lookup rule:

| Text | Emitted |
|---|---|
| `$b?price` | `"$b.price"` |
| `$b?price?1` | `"$b.price[0]"` (1-based → 0-based, §3) |
| `$doc?store?book?*` | `"$doc.store.book[*]"` |
| `$b?odd-name`, `$x?prénom` | `"$b['odd-name']"`, `"$x['prénom']"` (bracket form when not shorthand-safe) |

A lookup applies to every item of its base, so any base that may hold
several items is bound once and the whole chain becomes a path over that
binding, the same per-item rule:

| Text | Emitted |
|---|---|
| `tail($xs)?name` | `{"$let": {"lk_base": {"$tail": "$xs"}}, "$return": "$lk_base.name"}` |
| `(map{"a":1}, map{"a":2})?a?1` | `{"$let": {"lk_base": {"$seq": [...]}}, "$return": "$lk_base.a[0]"}` |
| `([10,20], [30,40])?*` | `{"$let": {"lk_base": {"$seq": [...]}}, "$return": "$lk_base[*]"}` → `10, 20, 30, 40` |
| `($b?x)?y` | `"$b.x.y"` (a parenthesized variable path continues the path) |

A base that is **at most one item** keeps the single-item dynamic lookup
`{"$get": [base, key]}` (numeric keys 1-based → 0-based): literals, map and
array constructors, `head(...)`, a lookup on such a base, and a conditional
whose branches are such — `head($xs)?name` →
`{"$get": [{"$head": "$xs"}, "name"]}`. The binding is named `lk_base`; the
base is evaluated outside it and the path alone runs beneath it, so a
variable of the same name written in the query is never captured.

> *Upgrade: a lookup on a base that evaluated to two or more items used to
> answer the empty sequence, and `?*` on a non-variable base was rejected
> (`wildcard lookup on a non-variable expression`); both now apply per item,
> as XQuery does.*

`?name` on an array, `?N` out of bounds, and lookups on scalars yield the
empty sequence where XQuery raises a type/range error (`FOAY0001`,
`XPTY0004`). `map:get` and `array:get` are a single `$get` and share it: a
sequence argument is empty rather than the type error.

Parenthesized key specifiers `?(E)` and unary lookup (`?name` on the
context item) are unsupported (§6).

### 4.4 Map constructors

`map { K: V, ... }` emits a **plain map constructor** `{K: V, ...}` when
every key is a string literal that does not start with `$`; otherwise the
general `{"$map": [[K, V], ...]}` form (computed keys must evaluate to a
single string at runtime, `JQ2004`). Literal keys that start with `$` are
`$$`-escaped inside `$map`: `map { "$for": 1 }` → `{"$map": [["$$for", 1]]}`.

Duplicate literal keys are rejected at parse time (XQuery's XQDY0137 made
static). Keys that are statically not strings (`map {1: "x"}`,
`map {true(): "x"}`) are `unsupported construct 'non-string map key'` —
JSON member names are strings.

### 4.5 Function mapping table

Bare and `fn:`-prefixed names are equivalent. The `xs:` prefix names the
constructor functions of §4.6, `map:` and `array:` their one function each.
Any other prefix, any name not listed, or any arity not listed is an error
(`unsupported function '<name>'` / `'<name>#<arity>'`).

| Function | Arity | Emitted |
|---|---|---|
| `count` | 1 | `{"$count": e}` |
| `sum`, `avg`, `min`, `max` | 1 | `$sum $avg $min $max` (collation/zero arities unsupported) |
| `exists`, `empty` | 1 | `$exists`, `$empty` |
| `not`, `boolean` | 1 | `$not`, `$boolean` |
| `string`, `number` | 1 | `$string`, `$number` (0-arg context forms unsupported) |
| `concat` | ≥ 2 | `{"$concat": [...]}` |
| `string-join` | 1–2 | `{"$string-join": [seq, sep?]}` |
| `substring` | 2–3 | `{"$substring": [s, start−1, len?]}` (**start adjusted**, §3) |
| `contains`, `starts-with`, `ends-with` | 2 | `$contains $starts-with $ends-with` |
| `substring-before`, `substring-after` | 2 | `$substring-before $substring-after` (collation arities unsupported) |
| `translate` | 3 | `{"$translate": [str, map, trans]}` |
| `upper-case`, `lower-case` | 1 | `$upper`, `$lower` |
| `string-length`, `normalize-space` | 1 | `$string-length`, `$normalize-space` |
| `matches` | 2 | `{"$search": [input, pattern]}` (**not** `$match`; §3) |
| `replace` | 3 | `{"$replace": [input, pattern, replacement]}` (I-Regexp, no flags) |
| `tokenize` | 1–3 | `{"$tokenize": [input, pattern]}`; the flags `""` and `q` only (§4.6) |
| `format-number` | 2–3 | `{"$format-number": [value, picture, format?]}`; a percent or per-mille picture multiplies first (§4.8) |
| `distinct-values` | 1 | `{"$distinct": e}` |
| `reverse`, `head`, `tail` | 1 | `$reverse`, `$head`, `$tail` |
| `subsequence` | 2–3 | `{"$subsequence": [seq, start−1, len?]}` (**start adjusted**, §3) |
| `index-of` | 2 | a `$for` over `{"$index-of": [seq, item]}` adding 1 to each position (**results adjusted to 1-based**, §3) |
| `abs`, `floor`, `ceiling` | 1 | `$abs`, `$floor`, `$ceiling` |
| `round`, `round-half-to-even` | 1–2 | `{"$round": [e, precision?]}`, `$round-half-to-even` (F&O rounding over doubles, QUERY-FORMAT §8.5) |
| `remove` | 2 | a `$let` phrase: the items before the position and after it (§4.7) |
| `insert-before` | 3 | a `$let` phrase: the items before the position, the inserts, the rest (§4.7) |
| `compare` | 2–3 | a `$let` phrase ordering two strings by code point; the third argument only the codepoint collation (§4.7) |
| `true`, `false` | 0 | the literals `true` / `false` |
| `map:get` | 2 | `{"$get": [map, key]}` (key never adjusted) |
| `array:get` | 2 | `{"$get": [array, pos−1]}` (**position adjusted**, §3) |
| `xs:string` | 1 | `{"$string": e}` |
| `xs:integer`, `xs:decimal`, `xs:double`, `xs:float`, `xs:boolean` | 1 | folded literal or a `$let` phrase (§4.6) |
| `xs:long`, `xs:int`, `xs:short`, `xs:byte`, `xs:unsignedLong`, `xs:unsignedInt`, `xs:unsignedShort`, `xs:unsignedByte`, `xs:nonNegativeInteger`, `xs:positiveInteger`, `xs:nonPositiveInteger`, `xs:negativeInteger` | 1 | folded literal or a `$let` phrase checking the range (§4.6) |
| `xs:date`, `xs:dateTime`, `xs:time` | 1 | folded RFC 3339 text or a `$let` phrase reading it (§4.9) |

### 4.6 The `xs:` constructors, `cast as`, `castable as` and `fn:tokenize`

**Numeric constructors** read their operand by what it is:

| Operand | `xs:double`, `xs:float` | `xs:decimal` | `xs:integer` |
|---|---|---|---|
| string | XSD `double` text (below) | XSD `decimal` text | XSD `integer` text |
| number | itself (`NaN`, `INF` too) | itself; `NaN`, `INF` are `JQ2001` | truncated toward zero; `NaN`, `INF` are `JQ2001` |
| boolean | `1` / `0` | `1` / `0` | `1` / `0` |
| empty sequence | empty | empty | empty |
| `null`, array, object, two or more items | `JQ2001` | `JQ2001` | `JQ2001` |

XSD text is read after trimming space, tab, CR and LF; an optional sign
follows; the digits may carry leading zeros and a bare leading or trailing
dot (`.5`, `5.`). `double` and `float` text also takes an exponent
(`1.5E3`, `5.e3`) and the spellings `INF`, `+INF`, `-INF` and `NaN`;
`decimal` and `integer` text takes no exponent, no `INF`, no `NaN`, and an
integer no dot. Negative zero survives only in a double (`xs:double("-0")`);
an integer or a decimal has none. Anything else is `JQ2001`, with the type
and the text in the message (`xs:integer: 1.5`).

A **literal** operand folds when the query is parsed: `xs:integer(" +007 ")`
emits `7`, `xs:double("INF")` emits `{"$div": [1, 0]}` (JSON has no literal
for the non-finite doubles), `xs:double("-INF")` `{"$div": [-1, 0]}`,
`xs:double("NaN")` `{"$div": [0, 0]}`, and a literal outside the type's text
emits a cast that fails when it runs (`{"$number": "xs:integer: 1.5"}`).
Any other operand is bound once to the variable `xs_arg` in a `$let` phrase
whose `$return` reads it by the table above, so the cast is lazy: `if
(false()) then xs:integer("x") else 1` is `1`. The phrase is larger than the
`$number` it replaces and costs a pattern match or two for a string operand;
a number or a boolean costs a few type tests.

`xs:boolean` is not the `$boolean` operator, which is the effective boolean
value (for which the string `"false"` is `true`): a boolean is itself, a
number is `false` only for `0` and `NaN`, a string (trimmed) is `true`/`1`
or `false`/`0` and nothing else, and the empty sequence is empty.
`xs:string(e)` is `{"$string": e}`: `xs:string(())` is the empty sequence, an
array or object is `JQ2001`, and a number serializes the way JavaScript does
(`Infinity`, `1e+21`; deviation **D1**), not as XDM's canonical form.

**Derived integer types.** `xs:long`, `xs:int`, `xs:short`, `xs:byte`,
`xs:unsignedLong`, `xs:unsignedInt`, `xs:unsignedShort`,
`xs:unsignedByte`, `xs:nonNegativeInteger`, `xs:positiveInteger`,
`xs:nonPositiveInteger` and `xs:negativeInteger` read their operand as
`xs:integer` does and keep the integer only inside the type's range;
outside it the cast fails with `JQ2001` (XQuery's `FORG0001`), the type and
the operand in the message: `xs:byte("127")` emits `127`, `xs:byte(300)`
emits `{"$number": "xs:byte: 300"}`, `xs:unsignedInt("-0")` emits `0`. For
any other operand the phrase reads the integer and keeps it with a `$where`
on the range (bound to `xs_int`). The ranges of `xs:long` and
`xs:unsignedLong` reach past 2^53, where an integer is a double (**D1**): a
text or a literal is read as the double nearest it first, and the range is
then checked on that double, exactly. Near those bounds a value is judged by
the double it rounds to: `xs:long("9223372036854775807")` rounds to 2^63 and
fails, `xs:long("-9223372036854775809")` rounds to -2^63 and gives it, and
`xs:unsignedLong("18446744073709551615")` rounds to 2^64 and fails.

**`cast as` and `castable as`.** `E cast as xs:T?` is the constructor
`xs:T(E)`; `E cast as xs:T` is the same cast, except that the empty
sequence fails with `JQ2001` (XQuery's `XPTY0004`). `E castable as xs:T` is
`true` when the cast gives a value and `false` when it would fail, and is
never an error itself: both read the operand the same way, and the cast
raises only where that reading gives no value. The empty sequence is
castable only as `xs:T?`, two or more items as nothing. `T` is one of the
types of this section or of §4.9, written with the `xs:` prefix; any other
(`xs:duration`, `xs:anyAtomicType`, an unprefixed name) is `unsupported
construct 'cast as <name>'` or `'castable as <name>'`. A literal operand
folds: `"12" castable as xs:byte` emits `true`. The grammar is XQuery's:
unary minus binds tighter (`-1 cast as xs:string` is `"-1"`), arithmetic
looser (`1 + "2" cast as xs:integer` is `3`), and an expression takes one
`cast` and then one `castable` at most (`1 cast as xs:integer cast as
xs:string` is a syntax error; parenthesize the operand instead).

**`fn:tokenize`** is the engine's `$tokenize` (QUERY-FORMAT.md §8.7): the
pieces of the text between the matches of an I-Regexp pattern (**D5**),
leftmost first, read in one pass. As in F&O, the empty text and the empty
sequence give no tokens whatever the pattern, the pieces between
neighbouring matches, and before the first or after the last, are kept
(`tokenize("a,,b,", ",")` is `"a"`, `""`, `"b"`, `""`), a separator that
overlaps itself is matched left to right (`tokenize("aaa", "aa")` is `""`,
`"a"`), and a pattern that matches the zero-length string (FORX0003) or is
no I-Regexp (FORX0002, which takes in XSD's `\s` and `\w`) is `JQ2001` when
the call runs. `tokenize($s)` is `tokenize(normalize-space($s), " ")`.

The flags argument is read as the query is read. `""` is the two-argument
call; `q` reads the pattern as plain text, so a literal pattern is escaped
into the I-Regexp that matches it (`tokenize($s, ".", "q")` emits
`{"$tokenize": ["$s", "\\."]}`). `i`, `s`, `m` and `x` change what a pattern
matches in ways an I-Regexp cannot express and are refused by name
(`unsupported construct 'tokenize flag i'`), as are flags computed when the
query runs and `q` with a computed pattern; a letter F&O does not define is
F&O's `FORX0001`, `JQ2001` when the call runs.

*Upgrade: `tokenize` used to emit a `$let` phrase over the separator's
positions, whose cost grew with the square of the text's length and whose
positions the sequence guards bounded (`JQ2007`, `JQ2009`); it now emits
`$tokenize`, which reads the text once and answers past those bounds. A
regular-expression pattern, a separator that overlaps itself and the flags
`""` and `q` used to be refused and now answer.*

### 4.7 `fn:remove`, `fn:insert-before` and `fn:compare`

The engine has no operator for these three; each composes from operators it
has. Every operand is evaluated once, outside the names the composition
binds: the operands are bound together, one array per operand (an array
constructor keeps an operand's items together as its members) —
`remove($xs, $p)` emits `{"$let": {"rm_args": [["$xs"], ["$p"]]}, ...}` and
reads the operands back as `"$rm_args[0][*]"` and `"$rm_args[1][*]"`
(`ib_args` for `insert-before`, `cmp_args` for `compare`).

- `remove(target, position)` is the items before the position followed by
  the items after it, two `$subsequence`s; `insert-before(target,
  position, inserts)` puts the inserts between the items before the
  position and the rest. As in F&O, a position outside the target removes
  nothing, one below 1 inserts before the first item and one past the end
  appends.
- The position is an `xs:integer`: one finite integral number, else
  `JQ2001` (XQuery's `XPTY0004`). With one number type (**D1**), `1.0` and
  `1e0` are integers here, where XQuery refuses a decimal or a double.
- `compare(a, b)` is `-1`, `0` or `1` as `a` sorts before, with or after `b`
  by code point — the order `$lt` gives two strings, so U+FFFD sorts before
  U+1F600, which UTF-16 order would reverse — and the empty sequence when
  either is empty. An operand that is neither one string nor empty is
  `JQ2001`. The third argument may only be the codepoint collation's URI
  (`http://www.w3.org/2005/xpath-functions/collation/codepoint`) as a
  literal; any other collation is `unsupported construct 'collation'`.

### 4.8 `fn:format-number`

`format-number(value, picture, format?)` is `$format-number`
(QUERY-FORMAT.md §8.7): F&O's picture, under F&O's default decimal format or
the format the third argument names, registered with the compilation
(`compileXQuery(text, { decimalFormats })`); a literal name is trimmed of
the white space around it, as F&O reads an EQName. A value that is not a
number is `JQ2001` (XQuery's `XPTY0004`), and a picture F&O refuses is
`JQ0003` when the query compiles (`FODF1310`).

A percent (`%`) or per-mille (`‰`) picture multiplies the value by 100 or
1000. F&O multiplies the double, so the product carries the double's
rounding and an overflow is the infinity of its sign (`format-number(1e308,
"0%")` is `Infinity%`), where `$format-number` scales the value's decimal
digits exactly. The two-argument call reads its picture under the default
decimal format, so a literal picture names its sign, and the front-end
multiplies first: `format-number($v, "0.0%")` emits

```json
{ "$replace": [
    { "$format-number": [{ "$mul": ["$v", 100] }, "0.0\uffff"] },
    "\uffff", "%"] }
```

formatting the product with the sign as a passive character and putting it
back. A computed picture or a named format keeps `$format-number`'s exact
scaling, since the sign is not known as the query is read; a picture whose
two sub-pictures carry different signs (`"0%;0‰"`) is refused
(`unsupported construct 'format-number picture with a percent and a
per-mille sub-picture'`).

### 4.9 `xs:date`, `xs:dateTime` and `xs:time`

The engine's dates are RFC 3339 strings (QUERY-FORMAT.md §8.13), and a
constructed date is read as the string it is (§3): comparisons compare its
code points and `string()` is its text. So the front-end admits exactly the
values whose text sorts in time order and is XSD's canonical form:

| Type | Admitted | Emitted |
|---|---|---|
| `xs:date` | no timezone, years 0000 to 9999 | `"2000-01-01"` (an RFC 3339 `full-date`) |
| `xs:dateTime` | UTC (`Z`, `+00:00`, `-00:00`), no fraction of a second, years 0000 to 9999 | `"2000-01-01T12:00:00Z"` |
| `xs:time` | UTC, no fraction of a second | `"12:00:00Z"` |

XSD white space around the text is trimmed, a fraction of zeros is dropped
(`"12:00:00.000Z"` is `12:00:00Z`), and `24:00:00` is midnight of the next
day (`xs:dateTime("1999-12-31T24:00:00Z")` is `"2000-01-01T00:00:00Z"`, as
XSD's canonical form writes it). A literal folds when the query is parsed;
any other operand is bound to `xs_arg` and read when the cast runs, by the
domain's text and the engine's `$is-date`, `$is-datetime` or `$is-time`.

A value XSD reads but the domain does not hold is refused by name, never
answered: a literal as the query is read (`unsupported construct 'xs:date
with a timezone'`, `'xs:dateTime without a timezone'`, `'xs:time with a
timezone other than Z'`, `'xs:dateTime with a fraction of a second'`,
`'xs:date outside the years 0000 to 9999'`), a computed operand with
`JQ2001` when the cast runs, in `castable as` too, which would otherwise
answer `false` for a value XQuery casts. Normalizing another timezone to
UTC would keep the order and lose the text `string()` gives.

A cast reads its operand by its static type (§3). A string, literal or
computed, is read as one: a text in another date type's lexical space has
no value (`xs:date("2000-01-01T00:00:00Z")` is XQuery's `FORG0001`,
`JQ2001`), as have a text in no date shape, a number and a boolean (XQuery
casts neither to a date: `XPTY0004`); the empty sequence gives the empty
sequence. A date value casts as XQuery casts it: to its own type it is
itself, an `xs:dateTime` to an `xs:time` is its time, an `xs:date` and an
`xs:time` have no value as each other (`XPTY0004`), and the two casts whose
result leaves the domain are refused (an `xs:dateTime`'s date keeps its
timezone, `'xs:date with a timezone'`; an `xs:date`'s dateTime has none,
`'xs:dateTime without a timezone'`). An operand that may or may not be a
date value is read as either: a string in the shape of another date type,
which may stand for a value that casts, raises rather than answer.

The uses XQuery types as an error, each raised where it is evaluated with
the date operand non-empty:

| Use | XQuery's code |
|---|---|
| the effective boolean value: `boolean`, `not`, an `if` condition, a `where` clause, `satisfies`, an `and`/`or` operand | `FORG0006` |
| a string argument: `string-length`, `substring`, `contains`, `starts-with`, `ends-with`, `upper-case`, `lower-case`, `normalize-space`, `matches`, `replace`, `tokenize`, `substring-before`, `substring-after`, `translate`, `compare`, the separator of `string-join`, the picture and format of `format-number` | `XPTY0004` |
| a comparison with anything but a value of its own date type (a string, a number, another date type, an external value) | `XPTY0004` |
| unary plus | `XPTY0004` |
| unary minus, `+`, `*`, `div`, `idiv`, `mod`, `to`, a numeric function (raised by the engine's operator, which takes no string) | `XPTY0004` |

The duration types (`xs:duration`, `xs:dayTimeDuration`,
`xs:yearMonthDuration`) stay outside the subset: a duration's text orders
neither by length (`"P1D"` sorts before `"PT12H"`) nor equals its canonical
twin (`"P1Y"` and `"P12M"` are one duration), and the engine has no
operator that compares or canonicalizes one.

## 5. FLWOR

Clauses parse in source order, then pack into the JSON FLWOR phrase, whose
clause keys apply in the fixed semantic order `$for → $let → $where →
$groupby → $orderby → $count → $return` regardless of key order (D7).
Sequences that fit that order (with consecutive `for`s / `let`s merged
into one binding object) emit **one phrase**:

```xquery
for $b in $doc?store?book?*, $r in $doc?ratings?*
where $b?isbn = $r?isbn
order by $b?price
return map { "title": $b?title, "stars": $r?stars }
```

```json
{ "$for":    { "b": "$doc.store.book[*]", "r": "$doc.ratings[*]" },
  "$where":  { "$eq": ["$b.isbn", "$r.isbn"] },
  "$orderby": "$b.price",
  "$return": { "title": "$b.title", "stars": "$r.stars" } }
```

Everything else nests mechanically — sound for the **per-tuple** clauses
(`for`, `let`, `where`), because a phrase nested in `$return` runs once
per surviving tuple, which is exactly XQuery's tuple-stream semantics:

- `let` between `for`s, `for` after `where`, repeated `where`s → the
  remainder becomes a nested phrase in `$return`;
- a remainder starting with `where` (no bindings of its own) emits
  `{"$if": [condition, rest]}` — the per-tuple filter;
- name reuse (XQuery shadowing; one JSON phrase cannot bind a name twice,
  `JQ0007`) also forces a split: `for $x in E let $x := $x + 1 ...`
  nests, and the inner phrase shadows — exactly XQuery's scoping.

Other clause details:

- `for $x at $i in E` → `{"$in": E, "$at": "i"}` (`$i` is **0-based**, §3);
  `allowing empty` is unsupported.
- `group by $k := E` (multiple specs comma-separated) → `"$groupby":
  {"k": E, ...}`. The grouping variable must be **fresh** — the bare
  rebinding form `group by $x` and `group by $x := ...` over an existing
  name are unsupported (the JSON format's grouping key is always a new
  variable, `JQ0007`).
- `order by` / `stable order by` (the engine's sort is always stable) with
  `ascending | descending` and `empty least | greatest` modifiers →
  `"$orderby"` key specs; defaults emit the bare key expression, explicit
  non-defaults the `{"$key", "$dir", "$empty"}` form; `collation` is
  unsupported. An array-constructor key always emits the explicit
  `{"$key": [...]}` form (a bare array reads as a spec list).
- `count $c` → `"$count": "c"` (**0-based**, §3).

### 5.1 Unsupported clause orders

`group by`, `order by` and `count` operate on the **whole tuple stream**.
Nesting one under a phrase that iterates (`$for` or `$groupby` present)
would wrongly scope it to a single tuple, so such sequences are rejected
with `unsupported clause order: '<kw>' after '<kw>'` rather than
mis-evaluated. Examples: a second `order by` after a `for ... order by`,
`group by` after `order by`, `count` after `count`, `order by` after a
split forced by shadowing. (Equivalent single-phrase spellings — e.g.
moving the `where` before the `order by` — are supported.)

`where` after `group by`/`order by`/`count` is fine (per-tuple), and so is
anything already in fixed order — including `count $c` **followed by**
`where` (the filter nests as `$if`, preserving XQuery's
number-then-filter semantics).

## 6. Unsupported constructs (v1)

Each is recognized and rejected by name (`unsupported construct '...'`):

| Construct | Error name |
|---|---|
| `/`-rooted, `//`, relative paths, axis steps, `@attr`, `..`, bare names, `*` | `path expression` |
| context item `.` | `context item expression` |
| unary lookup `?name`, `?( E )` keys, `?0` | `unary lookup`, `parenthesized lookup key`, `unsupported lookup index 0` |
| predicates `E[...]` | `predicate` |
| dynamic calls `E(...)`, `name#arity`, inline `function(){}`, `?` placeholder | `dynamic function call`, `named function reference`, `inline function expression`, `argument placeholder` |
| `instance of`, `treat as` | `instance of`, `treat as` |
| `cast as` / `castable as` a type outside §4.6 and §4.9 (`xs:duration`, `xs:anyAtomicType`, an unprefixed name, ...) | `cast as <name>`, `castable as <name>` |
| `union` / `\|`, `intersect`, `except` | `union expression`, ... |
| node comparisons `is`, `<<`, `>>` | `node comparison` |
| arrow `=>`, simple map `!` | `arrow expression`, `simple map operator` |
| `switch`, `typeswitch`, `try { } catch { }` | `switch expression`, `typeswitch expression`, `try/catch expression` |
| direct (`<a/>`) and computed node constructors, `ordered {}`, `unordered {}`, `validate {}` | `node constructor`, `computed node constructor`, ... |
| type declarations `as T` (anywhere), `allowing empty`, window clauses, collations | `type declaration`, `allowing empty`, `window clause`, `collation` |
| `xs:` constructors other than §4.6's and §4.9's (`xs:dayTimeDuration`, `xs:gYear`, `xs:hexBinary`, `xs:untypedAtomic`, `xs:anyURI`, ...) | `unsupported function '<name>'` |
| string `&`-entities, non-finite number literals (`1e400`) | `character reference`, `non-finite number literal` |
| string constructors `` `...` ``, ` ``[...]`` ` | `string constructor` |
| annotations `declare %ann ...` | `annotation` |
| namespaced variables `$ns:x`; URI-qualified names `$Q{uri}x`; NCName variables outside `[A-Za-z_][A-Za-z0-9_]*` (e.g. `$foo-bar`) | `namespaced variable`, `URI-qualified name`, `unsupported variable name` |
| library modules, every non-`variable` prolog declaration | §4.1 |

**Prime v2 candidates** (noted for planning): the simple map operator `!`
and the arrow operator `=>` (both are sugar the emitter could expand),
parenthesized/dynamic lookup keys via `$get`, and positional predicates.
