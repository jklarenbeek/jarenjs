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
  | `unsupported construct 'tokenize pattern other than plain text'` / `'tokenize separator that overlaps itself'` | `fn:tokenize` with a pattern the document cannot split at (§4.6) |
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
> rule — **positional inputs are adjusted, positional outputs are not**:
>
> **Adjusted at parse time** (the text means what XQuery says it means):
> - `?N` lookups: `$b?1` → `"$b[0]"` (`?0` is an `unsupported lookup index` error);
> - `fn:substring` / `fn:subsequence` *start* arguments: `substring("hello", 2)`
>   → `{"$substring": ["hello", 1]}` (a non-literal start emits
>   `{"$sub": [start, 1]}`; length arguments are counts and pass through);
> - `array:get`: `array:get($a, 1)` → `{"$get": ["$a", 0]}`
>   (`map:get` keys are values, not positions — never adjusted).
>
> **Not adjusted — 0-based values surface** (deviation carried into the
> front-end, because these are *bindings and results* the parser cannot
> locally rewrite):
> - `for $x at $i in ...` — `$i` counts from **0**, not 1;
> - `count $c` — `$c` counts from **0**;
> - `fn:index-of` — returned positions count from **0**.

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

> ### ⚠ `xs:` constructors: one number type, JSON-model values
>
> `xs:integer`, `xs:decimal`, `xs:double`, `xs:float`, `xs:boolean` and
> `xs:string` are constructor functions (§4.6). The engine has one number
> type (**D1**), so the numeric constructors differ in the *text and values
> they accept and the errors they raise*, not in the value they give:
> `xs:float` is a double (no single-precision rounding, range or
> overflow to `INF`), `xs:integer(7.9)` is `7`, and an integer or decimal
> beyond 2^53 loses precision. A cast that fails raises `JQ2001` (the
> analogue of `FORG0001`, `FOCA0002` and `XPTY0004` alike), when the cast is
> evaluated, never when the query is read. `cast as`, `castable as` and the
> other `xs:` types (dates, durations, binary, the derived integer types)
> stay outside the subset (§6).

## 4. The supported subset

### 4.1 Prolog

| Construct | Handling |
|---|---|
| `xquery version "3.1";` (optional `encoding "..."`) | parsed, ignored |
| `(: comments :)` (nestable) | whitespace, legal between any two tokens |
| `declare variable $x external;` | validated, emits nothing (use is the declaration, §2) |
| `declare variable $x := ...`, `... external := ...` | error `unsupported construct 'variable declaration with default value'` |
| any other `declare ...` (function, namespace, option, default, ...) | error `unsupported construct 'declare <kind>'` |
| `import module` / `import schema`, `module namespace` (library modules) | error `unsupported construct 'import module'` / `'library module'` |

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
| unary `-E` / `+E` | `{"$neg": E}` (folded into number literals: `-5` → `-5`) / no-op |
| postfix lookup `?name ?N ?*` | path fold or `$get` (§4.3) |
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

On **any other base**, each lookup emits dynamic `{"$get": [base, key]}`
(numeric keys 1-based → 0-based): `head($xs)?name` →
`{"$get": [{"$head": "$xs"}, "name"]}`.

> **`$get` addresses a single item.** If a non-variable base evaluates to
> a sequence of two or more items, `$get` yields the empty sequence
> instead of XQuery's per-item lookup. Bind the base with `let` and use a
> variable lookup for per-item semantics. Also `?name` on an array,
> `?N` out of bounds, and lookups on scalars yield the empty sequence
> where XQuery raises a type/range error.

`?*` on a non-variable base, parenthesized key specifiers `?(E)`, and
unary lookup (`?name` on the context item) are unsupported (§6).

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
| `upper-case`, `lower-case` | 1 | `$upper`, `$lower` |
| `string-length`, `normalize-space` | 1 | `$string-length`, `$normalize-space` |
| `matches` | 2 | `{"$search": [input, pattern]}` (**not** `$match`; §3) |
| `replace` | 3 | `{"$replace": [input, pattern, replacement]}` (I-Regexp, no flags) |
| `tokenize` | 1–2 | a `$for` over the separator's positions (**plain-text patterns only**, §4.6) |
| `distinct-values` | 1 | `{"$distinct": e}` |
| `reverse`, `head`, `tail` | 1 | `$reverse`, `$head`, `$tail` |
| `subsequence` | 2–3 | `{"$subsequence": [seq, start−1, len?]}` (**start adjusted**, §3) |
| `index-of` | 2 | `{"$index-of": [seq, item]}` (**results 0-based**, §3) |
| `true`, `false` | 0 | the literals `true` / `false` |
| `map:get` | 2 | `{"$get": [map, key]}` (key never adjusted) |
| `array:get` | 2 | `{"$get": [array, pos−1]}` (**position adjusted**, §3) |
| `xs:string` | 1 | `{"$string": e}` |
| `xs:integer`, `xs:decimal`, `xs:double`, `xs:float`, `xs:boolean` | 1 | folded literal or a `$let` phrase (§4.6) |

### 4.6 The `xs:` constructors and `fn:tokenize`

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
a number or a boolean takes one `$if` branch.

`xs:boolean` is not the `$boolean` operator, which is the effective boolean
value (for which the string `"false"` is `true`): a boolean is itself, a
number is `false` only for `0` and `NaN`, a string (trimmed) is `true`/`1`
or `false`/`0` and nothing else, and the empty sequence is empty.
`xs:string(e)` is `{"$string": e}`: `xs:string(())` is the empty sequence, an
array or object is `JQ2001`, and a number serializes the way JavaScript does
(`Infinity`, `1e+21`; deviation **D1**), not as XDM's canonical form.

**`fn:tokenize`** splits at the matches of a regular expression, and the
engine has no operator that finds matches, so the front-end maps the one
case a document can express: a **plain-text separator**, a string literal
without any character an I-Regexp or XSD pattern reads as syntax
(`\ | . ? * + ( ) { } [ ] ^ $`). It emits a `$let` phrase that finds the
positions at which the text holds the separator and cuts the pieces
between them, in code points. As in F&O, the empty text and the empty
sequence give no tokens, and the pieces between neighbouring separators,
and before the first or after the last, are kept (`tokenize("a,,b,", ",")`
is `"a"`, `""`, `"b"`, `""`). `tokenize($s)` is `tokenize(normalize-space($s), " ")`.
A separator that overlaps itself (`"aa"`, `"abab"`, `"--"`: some prefix is
also its suffix) is refused, because the scan would then need XQuery's
left-to-right match order, as is any other pattern, a computed one, and the
flags argument (`tokenize#3`, `tokenize#4`). Every position is probed, so
the cost grows with the square of the text's length, and the positions are a
sequence the engine's guards bound: a text longer than 1,000,000 code points
is `JQ2007`, one longer than a lower `limits.sequenceItems` is `JQ2009`. A
long text wants a regular-expression operator in the engine, which does not
exist.

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
| unary lookup `?name`, `?*` on non-variables, `?( E )` keys, `?0` | `unary lookup`, `wildcard lookup on a non-variable expression`, `parenthesized lookup key`, `unsupported lookup index 0` |
| predicates `E[...]` | `predicate` |
| dynamic calls `E(...)`, `name#arity`, inline `function(){}`, `?` placeholder | `dynamic function call`, `named function reference`, `inline function expression`, `argument placeholder` |
| `instance of`, `treat as`, `castable as`, `cast as` | `instance of`, `treat as`, `castable as`, `cast as` |
| `union` / `\|`, `intersect`, `except` | `union expression`, ... |
| node comparisons `is`, `<<`, `>>` | `node comparison` |
| arrow `=>`, simple map `!` | `arrow expression`, `simple map operator` |
| `switch`, `typeswitch`, `try { } catch { }` | `switch expression`, `typeswitch expression`, `try/catch expression` |
| direct (`<a/>`) and computed node constructors, `ordered {}`, `unordered {}`, `validate {}` | `node constructor`, `computed node constructor`, ... |
| type declarations `as T` (anywhere), `allowing empty`, window clauses, collations | `type declaration`, `allowing empty`, `window clause`, `collation` |
| `xs:` constructors other than §4.6's six (`xs:date`, `xs:dayTimeDuration`, `xs:long`, `xs:int`, `xs:hexBinary`, `xs:untypedAtomic`, `xs:anyURI`, ...) | `unsupported function '<name>'` |
| string `&`-entities, non-finite number literals (`1e400`) | `character reference`, `non-finite number literal` |
| string constructors `` `...` ``, ` ``[...]`` ` | `string constructor` |
| annotations `declare %ann ...` | `annotation` |
| namespaced variables `$ns:x`; URI-qualified names `$Q{uri}x`; NCName variables outside `[A-Za-z_][A-Za-z0-9_]*` (e.g. `$foo-bar`) | `namespaced variable`, `URI-qualified name`, `unsupported variable name` |
| library modules, every non-`variable` prolog declaration | §4.1 |

**Prime v2 candidates** (noted for planning): the simple map operator `!`
and the arrow operator `=>` (both are sugar the emitter could expand),
parenthesized/dynamic lookup keys via `$get`, and positional predicates.
