# Saved formulas and reviewed plans

`@jarenjs/json/formula` compiles versioned JSON profiles through the existing JSON
Query engine. `@jarenjs/linq/formula` authors the same immutable document.

```js
import { defineFormula } from '@jarenjs/linq/formula';
import { compileFormula } from '@jarenjs/json/formula';
const profile = defineFormula('amount', { $mul: ['$.price', '$.quantity'] });
const formula = compileFormula(profile);
formula.evaluate({ price: 2.5, quantity: 4 }); // {kind:'value', value:10}
```

## Profile and capabilities

A profile requires `$formula: "1"`, nonempty `id` and `revision` strings, and
`expression`, an existing JSON Query document. Identity and revision strings have
a maximum length of 256 characters. Optional members are `bindings`, `helpers`,
`packs`, `inputSchema`, `resultSchema`, and `resultMode` (`value`, the default, or
`outcome`). Bindings are immutable JSON. `context` and `computed` are reserved
external names.

Schema references are `{id, version}` and resolve through
`options.schemas[id] = {version, schema}`. Supply `compileTypeTest` from
`@jarenjs/validate/query` (or a structural equivalent); the JSON package never
imports the validator. Missing/mismatched references and invalid schemas fail at
compile time. Input predicates run before evaluation; result predicates validate
the value of value/explanation outcomes. Empty and non-value outcomes have no
result value to validate.

Helper references are `{name, version}` and resolve through
`options.helpers[name] = {version, run, trust:'pure', cost}`. Positive finite cost
is a host declaration, not measured enforcement. Versioned helpers must remain
pure and stable for the lifetime of a compiled formula.

Operator packs are listed the same way: `packs` is an array of unique
`{name, version}` and resolves through `options.packs`, a registry from
`createJsltRegistry()` of `@jarenjs/json/jslt` ([JSLT-FORMAT §13](JSLT-FORMAT.md#13-registered-operators-host-opt-in-non-normative)).
A pack the registry lacks, or holds at another version, refuses at compile time
(`JQ0014`, at `/packs/i`), as a missing helper does. The formula is compiled with
the operators of the listed packs only: an operator of a pack the registry holds
but the profile does not list stays unknown (`JQ0002`), so a saved formula names
every operator its meaning depends on. A helper the profile lists under the name
of a function of a listed pack is refused too (`JQ0014`, at `/helpers/i`): one
would shadow the other, so neither is chosen for it.

```js
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
const packs = createJsltRegistry().use(mathPack);
const profile = defineFormula('side', { $sqrt: ['$.area'] }, { packs: [{ name: 'math', version: '1' }] });
compileFormula(profile, { packs }).evaluate({ area: 16 }); // {kind:'value', value:4}
```

Locale data is data the host hands in, never looked up: `options.dateNames`
(the names `$date-format` writes month and weekday words with, from
`compileDateLocale(pack).names` of `@jarenjs/locales`) and
`options.decimalFormats` (named decimal formats for `$format-number` and
`$quantity`, from `compileNumberLocale(pack).decimalFormat`), passed through to
the Query engine ([QUERY-FORMAT §8.7, §8.13](QUERY-FORMAT.md#87-strings)).
`createFormulaCompiler` (and so `compileFormula` and `compileFormulaBatch`) checks
these and `options.packs` once, when it is made: a malformed record, or a list of
packs where a registry belongs, is the host's `TypeError`, never every formula's
document error.

```js
import { compileDateLocale, compileNumberLocale, nl } from '@jarenjs/locales';
const options = { dateNames: compileDateLocale(nl).names, decimalFormats: { nl: compileNumberLocale(nl).decimalFormat } };
compileFormula(defineFormula('price', { '$format-number': ['$.price', '€ #.##0,00', 'nl'] }), options)
  .evaluate({ price: 1234.5 }); // {kind:'value', value:'€ 1.234,50'}
```

`createFormulaCompiler` retains a bounded compilation cache (default 128
profiles): its collision-free key includes the complete profile, helper function
identity/version/cost, the pack registry, the locale data, schema contents,
type-test function identity and limits. Recompile after replacing a capability; a
new compiler never shares another host's cache. `clear()` releases entries and
`size()` reports retained profiles.

`evaluate(row, context?, computed?)` snapshots and freezes JSON inputs without
freezing caller objects. Clock values, rates and unit tables belong in
bindings/context or explicitly registered pure helpers, and locale data in the
compile options above. No implicit clock, locale, network or database access is
supplied. Formula errors carry `formulaId`, `code`
and an RFC 6901 `docPath`; wrapped Query errors retain their code and point below
`/expression`. Codes are allocated in the [Query registry](QUERY-FORMAT.md#10-errors).

## Values, outcomes and arithmetic

JSON Query semantics apply unchanged: missing paths yield an empty sequence;
explicit null is a value. Numeric operators do not convert strings to numbers.
Native floating-point overflow/non-finite values and non-JSON host results are
refused at the formula boundary. Rounding is explicit: `$round`,
`$round-half-to-even`, `$floor`, `$ceiling` and `$abs` are Query operators
([QUERY-FORMAT §8.5](QUERY-FORMAT.md#85-arithmetic--add-sub-mul-div-idiv-mod-neg-rounding)),
and `$round` with a precision rounds the exact binary value, as XPath F&O
`fn:round` says (`1.005` is stored just below 1.005, so at two places it is 1).
There is no implicit currency rounding or formatting: `$format-number` writes a
number with a picture and a decimal format, and its text is an ordinary string.
JavaScript Number precision remains visible; the API does not claim decimal
arithmetic.

The default result mode produces `{kind:'value', value}`. Empty sequence produces
`{kind:'empty', values:[]}`, distinct from a value containing an empty array.
Explicit `outcome` mode accepts only these exact shapes:

- `{kind:'value', value}`
- `{kind:'skip'}`
- `{kind:'explanation', text}` or `{kind:'explanation', text, value}`
- `{kind:'error', message}`

Outcome tags and JSON value types survive a JSON round trip. Signed zero follows
JavaScript Number arithmetic in memory; JSON/JCS text writes it as zero. Live
compilation/evaluation caches distinguish signed zero. Persist an explicit sign
field when an application needs to preserve that distinction. A skip cannot carry a value. Ordinary
object results are never interpreted as outcome instructions in `value` mode.

## Batches and isolation

`compileFormulaBatch(targets, options)` from `@jarenjs/json/formula/batch` compiles
`{id, enabled?, formula, schemas?}` targets once. An enabled target's own
`schemas` (a migration record's `native.schemas`) join `options.schemas`; two
different schemas under one id refuse (`JQ0015` at `/targets/i/schemas`), since
one formula would otherwise validate its rows against the other's schema. Disabled
targets neither compile nor run, and their schemas take no part in the batch.
Compile/runtime failure of one target does not stop independent cells. Each row
has a stable string/finite-number `id` (or the configured `key`); string IDs and
target IDs are bounded at 256 characters. Duplicate row/target identities refuse.

`batch.evaluate(rows, {context, revision, key})` returns `results`, exact `counts`,
`errors` and `omittedErrors`. Each result is `{id, outcomes}`. Error cells contain
`{kind:'error', code, diagnostic}`; diagnostic is an index into `errors` or null
when the diagnostic credit is exhausted. Counts distinguish rows, cells,
evaluations, cache hits, values, empty sequences, skips, explanations, errors and
disabled cells. Diagnostic text/path are bounded by `maxMessageChars` (default
256); `maxErrors` defaults to 100. `maxRows` defaults to 10000, `maxCells` to
100000, and `memoSize` to 10000. Exceeding an admission limit refuses the batch,
never silently reports a truncated result as complete.

`$computed.targetName` schedules named dependencies; missing targets and cycles
refuse deterministically. A dependency with no value blocks only its dependents.
Normalized Query paths supply conservative source-field dependencies. Whole-root
or nonsingular paths invalidate on any row edit. Named top-level dependencies
invalidate only when those values change; a declared input schema conservatively
tracks the whole row because it may constrain other fields. JSON validity is
checked even on memo hits. Context and explicit input revision
also join the memo key. Disabling/replacing profiles or capabilities requires a
new compiled batch. `clear()` releases memoized cells.

Default Query limits are 10000 expression steps, 64 levels of expression nesting,
10000 output items and 10000 phrase items. Their scope is exactly the
[Query limit contract](QUERY-FORMAT.md): intermediate work and arbitrary pure host
functions can exceed these costs. Batch row/cell credits bound scheduling and
retention, not arbitrary input/result byte sizes.

`createFormulaResource` from `@jarenjs/app/formula` owns injected terminating
workers. Supply `workerFactory`, `timeoutMs` (default 1000) and `maxInFlight`
(default 2). Each worker implements `request(message)` and `terminate()`.
Termination must actually stop the isolate and settle the request. Requests carry
`{version:1, generation, revision, payload}`; replies echo the identity and carry
`result`. The resource terminates and drains after every request, on cancellation,
on deadline and on disposal; late generations cannot publish. It offers no
same-thread timeout guarantee. `stats()` reports admitted pending work;
`dispose()` stops admission and returns a shared drain promise.

## Explicit migration

`migrateFormulas`, `rollbackFormula`, `resolveFormulaMigration` and
`translateFormulaBody` live at `@jarenjs/json/formula/migrate`. Source records
require `id`, `label`, `enabled`, `storageVersion` and `body`. The entire original
is retained, including exact line endings and extra application metadata. No source
body is evaluated: a body is read by a parser and translated, never run.

### Translating a saved source

A body is the statements of a JavaScript function: `migrateFormulas` reads each
enabled one with a hand-written parser (over `@jarenjs/core/scan`, no `eval`, no
`new Function`) and translates it into a native formula. The parser reads all of
the statement and expression syntax a formula body uses, so a construct outside the
translated subset is named with its position rather than stopping at the first:

- literals, names, member access with `.`, `[…]` and `?.` (an optional call
  `x?.m()` yields undefined when `x` is null or undefined, along the whole chain),
  template literals, array and object literals, a spread of an array or a text
  (its characters) into an array;
- the arithmetic, comparison, equality and logical operators, `??` and `?:`;
- `Math.round`, `ceil`, `floor`, `abs`, `max` and `min`; `Date.now()`;
  `new Date(text).getTime()`; `String()` and `Number()`;
- text methods (`toLowerCase`, `toUpperCase`, `toLocaleLowerCase` and
  `toLocaleUpperCase` outside Turkish, Azerbaijani and Lithuanian, `trim`,
  `trimStart`, `trimEnd`, `includes`, `startsWith`, `endsWith`, `concat`, `replace`
  and `replaceAll` with a literal text or regular expression, `split(x)[0]`) and a
  regular expression's `test`;
- `toFixed` and `toLocaleString`, and `new Intl.NumberFormat(…).format`, for a
  language the host describes;
- arrow callbacks of `map`, `filter`, `find`, `some`, `every` and `sort` (of a
  copy, `[...list].sort(…)`, or of a `map` or `filter` result), and `join`,
  `includes`, `length` and `concat` on an array;
- `const` and `let`, a destructuring of plain names (`const { a, b: c } = e`, read
  as the members it names), `if` and `else`, `return`; a `let` reassigned, or an
  array literal a name alone holds pushed to, inside an `if` that does not return;
  `void 0` as undefined.

Statements translate by continuation: `const x = e; rest` is a `$let` around the
rest, `if (c) return a; rest` is `$if(c, a, rest)`, and a variable an `if` changes
is rebound to `$if(c, new, old)` for what follows. A block's `let` and `const` end
with the block: what follows reads the name as it was before it, and what the
block assigns to an outer `let` stays. Before its declaration such a name is no
name at all (JavaScript throws reading it): read there it is the reason
`unknown-name`, assigned there the reason `assignment`.

`options.translate` (closed: an unknown key is a `TypeError`) names what the body
reads and calls:

| Option | Default | Meaning |
|---|---|---|
| `argument` | `'row'` | the row's parameter name |
| `helperObject` | `'helpers'` | the helpers' parameter; `helpers.X` reads as the bare helper `X` |
| `helpers` | none | each helper the body calls: `{call: {name, version}}` (a `$call` of the host helper, listed in the formula's `helpers`) or `{native: {params, expression}}` (an expansion into operators over its parameters, `$name` in the expression); with `returns`, `element`, `absent`, `nullable` and the `differences` it has |
| `skip` | `'SKIP'` | the skip sentinel: returning it, or `undefined`, skips the row, and so does `x ?? SKIP`, `x \|\| SKIP` or `x && SKIP` on that side; the sentinel anywhere else (kept in a name, in an array) is the reason `skip-value` |
| `explain` | `'because'` | `explain(value, text)` returns an explanation, its text `String(text ?? '')` |
| `explanationMember` | none | a returned object literal with this one member is an explanation, its value the text |
| `locales` | none | the languages number formatting may name: `{decimalFormat, grouping, decimal, currencies, nan}`, the decimal format registered under `decimalFormat` and each currency's picture |

Using the skip sentinel or an explanation makes the formula an outcome-mode one.
`options.formula`, when given, is the `FormulaOptions` each translation must
compile under; one that does not (a helper or decimal format the host does not
supply) is untranslatable with the reason `compile`, naming what it lacks.

### The report

Each record is `{version: 1, id, original, sourceHash, state, reason, reasons,
differences, native, nativeHash}`:

- `translated`: the native formula is the source's meaning;
- `translated-with-differences`: the same, but where each named difference
  applies;
- `untranslatable`: `native` is null and `reasons` names every blocker;
- `disabled-preserved`: a disabled source, kept without parsing.

`reason` is the first reason's kind, `translated` or `differences`. A difference
is `{kind, at, note}` and a reason `{kind, at, message}`; `at` is `{offset, line,
column}` in the body, 1-based. Translation is deterministic: the same body and
options give the same formula, whatever was translated before.

A translation is exact on two conditions, stated once rather than at every site.
Each field holds the JSON type the body uses it as (`row.l ?? []` uses it as an
array, `row.s ?? ''` as text): where JavaScript would convert a field's value
between types — text in arithmetic, a number ordered against a text, a boolean,
an array or an object ordered with `<`, `>`, `<=` or `>=`, an array or an object
made into text — the operator refuses the row (`JQ2001`). A value the body computes
itself, or one that may be such a value (`row.b ?? (x > 1)`), is converted as
JavaScript converts it: a boolean is 0 or 1 in arithmetic and in an ordering, and a
text beside a number is read as `Number` reads it (`number-parse`). And a value the
body reads where a guard (`if (x == null)
return …`, `!x`, `x?.y`, `x ?? y`, a test in an `&&` chain) has not proven it
present is named where it matters:

| Difference | Where JavaScript and the query part ways |
|---|---|
| `absent-receiver` | a member or method of null or undefined: JavaScript throws, the query reads nothing (an optional `x?.m()` is exact: both yield undefined) |
| `nullish-arithmetic` | arithmetic on undefined (NaN) or null (0): the query yields nothing, or refuses null |
| `nullish-comparison` | `<`, `>`, `<=`, `>=` with null, which JavaScript compares as 0, where 0 would pass |
| `concat-undefined` | `'x' + undefined` is `"xundefined"`; the query writes `"x"` |
| `absent-element` | undefined kept as an array element (an array literal, a push, `concat`, a `map` result); the query drops it |
| `identity` | objects compared by identity in JavaScript, by value in the query: a fresh array or object, two elements of arrays, a value the translation cannot trace to one read (two different reads of the row are never one object, and compare exactly) |
| `prototype-key` | a constant table indexed by a key JavaScript finds on `Object.prototype` (`constructor`), or an array read at an index of unknown type, where JavaScript also reads a key the array has (`length`, `map`) |
| `clock` | `Date.now()` is `$context.now`: the host evaluates with `context.now` (epoch milliseconds) |
| `date-parse` | `new Date(text)` also reads dates that are not RFC 3339, implementation-defined |
| `regex-subset` | a regular expression rewritten to an I-Regexp that cannot say the same (`\b`) |
| `regex-coercion` | a regular expression's test of a value that may be undefined: JavaScript tests the text `"undefined"`, the query tests nothing |
| `case-fold` | a case-insensitive test: JavaScript folds case by its own table (the dotted and dotless i, the final sigma, the Kelvin sign), the query lower-cases the text |
| `code-units` | text beyond U+FFFF (an emoji is two UTF-16 code units): a pattern's `.`, negated class, `\S`, `\D` or `\W` (but for one such atom replaced away, a run of it, or a test for it), or a character beyond U+FFFF in a pattern, matches one code unit in JavaScript and one character in the query |
| `sort-key` | a sort key that may be missing: JavaScript keeps the order, the query sorts it first |
| `remainder-by-zero` | `%` by zero: JavaScript computes NaN, the query refuses (`JQ2002`) |
| `number-parse` | `Number(text)`, or a text the body computes used as a number: JavaScript reads `''` as 0 and accepts hex, the query does not |
| `replacement-pattern` | a computed replacement: JavaScript reads `$&` and `$1` in it |
| `loose-equality` | `==` where a side's type is not known: JavaScript converts between types (`'1' == 1`, `'' == 0`) |
| (the host's) | a native helper's own `differences`, at each call |

Text is measured and ordered as JavaScript measures and orders it, in UTF-16 code
units: `.length` counts a character beyond U+FFFF twice, and two texts compare by
their code units — the query's character order, turned around where, at the first
difference, one text has a character from U+E000 to U+FFFF and the other one
beyond U+FFFF.

Regular expressions are read as JavaScript reads them without the `u` flag (`\p`
is the letter p, `\u{2}` a `u` twice, a brace that is no quantifier is itself) and
rewritten exactly where I-Regexp can say the same: `\d`, `\w` and `\s` as their
classes (`\s` is JavaScript's fixed white-space set), `.` as everything but a line
terminator, an escaped character as itself (`\$` as the class `[$]`), the anchors
`^` and `$` marked by a sentinel, and the `i` flag by lower-casing the tested text
(`case-fold`; a capital in a case-insensitive pattern is a reason). The anchors and
`trim` mark the ends of a text with the noncharacter U+FFFF, which the text must not
hold. Groups are kept; lookaround, lazy quantifiers, back references and a legacy
octal escape are reasons. A `replace` without the `g` flag is translated where its
pattern matches at most once (anchored, without an alternation). Number formatting
is translated for the languages `options.translate.locales` describes:
`toLocaleString` with `style`, `currency`, `minimumFractionDigits` and
`maximumFractionDigits`, written with `$format-number` (QUERY-FORMAT §8.7); a
text's `toLocaleString` is the text, a boolean's its name.

Every reason names what stops the translation, with a message:

| Reason | What it names |
|---|---|
| `syntax` | text JavaScript does not read (or this parser does not: a class, a label); a let or const of a parameter's name |
| `unreachable` | a statement after a `return` |
| `return-line-break` | a line break right after `return`, where JavaScript returns undefined |
| `loop` | `for`, `while` and `do` |
| `function` | a function, class or async declaration, or an arrow outside a callback |
| `statement` | `switch`, `try`, `break` and the other statements outside the subset; an expression statement other than an assignment to a let or a push |
| `throw` | a `throw` statement |
| `assignment` | an assignment to anything but a `let` of the body (to a `const`, or to a name before its declaration), or inside an expression |
| `push` | a push to a name that does not hold an array literal of its own: JavaScript changes the array in place, which the row or another name may hold too |
| `sort` | `.sort()` other than `(a, b) => key(a) - key(b)` (or the reverse), or of an array the body may read again: JavaScript sorts in place |
| `sequence` | the comma operator |
| `spread` | a spread outside an array literal |
| `array-hole` | a hole in an array literal |
| `object-spread` | a spread or a computed key in an object literal |
| `object-key` | an object key that starts with `$`, or `__proto__` |
| `computed-member` | a computed member of a value that is neither a constant table nor an array |
| `string-of-object` | an array or an object made into text |
| `call` | a call of something other than a helper, `Math`, `Date.now` or a method |
| `arguments` | a call with arguments the translation does not take |
| `helper` | a name that is not a helper the host maps |
| `explanation` | the explaining helper outside a returned value |
| `skip-value` | the skip sentinel used as a value |
| `math` | a `Math` function outside the subset |
| `date` | `new Date()` without exactly one argument |
| `new` | a `new` other than `new Date(text).getTime()` and `new Intl.NumberFormat(…).format(n)` |
| `method` | a method outside the subset |
| `length`, `includes`, `concat` | of a value that could be text or an array |
| `split` | `.split()` other than its first part by a literal text |
| `replace` | a replacement function, a computed pattern, a replacement that names the match (`$&`, `$1`), or `replaceAll` of a pattern without the `g` flag |
| `replace-first` | `.replace()` of the first match, where more than one can match |
| `regex` | a pattern outside the rewrite: a flag other than `g` and `i`, lookaround, a lazy quantifier, a back reference, a legacy octal escape, a capital in a case-insensitive pattern, a pattern that matches the empty text, `test()` of a `g` pattern kept in a name |
| `callback` | a callback other than an arrow of the element (and its index) |
| `toFixed` | `.toFixed()` of anything but a literal number of digits from 0 to 20 |
| `locale` | number formatting or case mapping in a language the translation does not describe, whose case rules are its own, or whose tag JavaScript refuses |
| `destructuring` | a destructuring with a default, a nested or array pattern, or a rest |
| `typeof` | `typeof` |
| `operator` | another operator (`**`, `in`, `instanceof`, a bitwise one, unary `+`), or a `+` adding a value that may be text or a number, which JavaScript adds or concatenates by the value |
| `unknown-name` | a name that is neither a variable of the body, the row nor a helper (`this` too), or a `let` or `const` read before its declaration |
| `compile` | a translation the host's formula options cannot compile, or that is no formula document |

A native formula carries no input schema (`schemas` is `{}`): the operators
refuse what JavaScript would coerce, at the operator rather than the boundary. A
batch still merges schemas a host declares on its targets.

### Equivalents, measured

A body translates with these equivalents; a test runs each one value for value
against the JavaScript it replaces:

| JavaScript | JSON Query |
|---|---|
| `a ?? b`, `a` a missing field | `{"$default": [a, b]}`: a missing path is the empty sequence |
| `a ?? b`, `a` possibly an explicit `null` | `{"$if": [{"$is-null": {"$default": [a, null]}}, b, a]}` |
| `a == null` | `{"$is-null": {"$default": [a, null]}}` |
| `Math.round(x * 100) / 100` | `{"$div": [{"$round": [{"$mul": [x, 100]}]}, 100]}` |
| `Number(x.toFixed(2))`, `x >= 0` | `{"$round": [x, 2]}` |
| `x.toFixed(d)` | `x` rounded on its exact value half away from zero (`$round` of the magnitude, the sign put back), written with the picture `0.00…`, where `x` is below 10^(15 − d) or an integer below 2^53; `{"$string": x}` from 10^21 on; any other `x` refuses the row (`JQ2001`) |
| `text.length` | `{"$add": [{"$string-length": text}, {"$string-length": {"$replace": [text, "[^\uD800\uDC00-\uDBFF\uDFFF]", ""]}}]}`: UTF-16 code units, a character beyond U+FFFF counted twice |
| `list.join(sep)` | `{"$string-join": [{"$for": {"x": list}, "$return": {"$if": [{"$is-null": "$x"}, "", "$x"]}}, sep]}`: a null element is the empty text |
| `list.map((e) => …)` | `[{"$for": {"e": list}, "$return": …}]`: `$for` takes the array one level deep (QUERY-FORMAT §6.2), so an element that is itself an array stays one element |
| `x.toLocaleString('nl-NL')` | `{"$format-number": [x, "#.##0,###", "nl"]}` |
| `x.toLocaleString('nl-NL', {maximumFractionDigits: 1})` | `{"$format-number": [x, "#.##0,#", "nl"]}` |
| `x.toLocaleString('nl-NL', {style: 'currency', currency: 'EUR'})` | `{"$format-number": [x, "€ #.##0,00;€ -#.##0,00", "nl"]}`, the space a no-break space, and `€ NaN` for NaN as ICU writes it |

The two rounding spellings are not interchangeable. `Math.round(x * 100) / 100`
rounds the product, which binary multiplication has already rounded, so
`0.015` becomes `0.02` where `{"$round": [0.015, 2]}` is `0.01`: they differ on
43,412 of the 100,000 half-cent values from 0.005 to 999.995. The
multiply-round-divide spelling reproduces it bit for bit (no difference over
400,000 values, both signs). `toFixed` rounds the exact value too, and agrees with
`$round` on every non-negative value; on a negative exact tie it rounds away from
zero (`(-0.125).toFixed(2)` is `-0.13`) where `$round` rounds toward positive
infinity (`-0.12`).

`toFixed(d)` writes the digits of the exact binary value, the query a rounded
value's shortest digits: they are the same digits where the rounded value has at
most 15 significant ones (`x` below 10^(15 − d)) or `x` is an integer below 2^53,
and from 10^21 on JavaScript writes the number as `String` does. Translated as the
table says, it agrees with JavaScript at 0, 1 and 2 digits:
no difference over 200,000 values (the half-cent values, both signs). At every
digit count from 0 to 20, over 84,000 values from 10^−8 to 10^22 (integers, ties
and both signs among them), each value in that range agrees and each outside it is
refused. The three Dutch number formats agree with `Intl.NumberFormat` on ICU 78.3
over the half-cent values.

### Parity, records and review

`checkFormulaParity(formula, rows, expected, options)` from
`@jarenjs/json/formula` checks a compiled formula against the outputs the host's
own trusted runner produced for the same rows (`expected[i]` in the outcome
shape); the library never runs the original. It returns `{rows, agree, differ,
mismatches, omittedMismatches}`, at most `maxMismatches` (default 20) mismatches
listed. Outcomes compare as canonical JSON; two errors agree whatever their
messages, since a JavaScript TypeError and a query refusal word one failure
differently. The acceptance corpus (`test/json/formula-corpus.json`, 35 saved
columns and rules) translates 20 sources exactly, 14 with named differences and
1 not at all, and agrees with its runner on every row but those made to show a
named difference.

Migration returns `{records, changes, changed}`. Repeating input reports zero
changes; missing sources in a later input do not delete records. A changed source
creates a conflict carrying both the original and current source. Native edits
are preserved. SHA-256 identities track source and native content; a record kept
from an earlier migration stays as it was until its source changes.
`resolveFormulaMigration(record, native, review, options)` requires a reviewer,
reason, matching `sourceHash` and `expectedNativeHash`; it compiles the rewrite
and retains native history. Repeating an identical resolution is a no-op.
Rollback is a compare-and-restore proposal: changed source/native data refuses;
restoring twice has zero changes. The host applies returned records through its
own persistence command. Untranslatable records keep their trusted runner until a
reviewer resolves them.

## Reviewed plans

`compileRulePlan` from `@jarenjs/json/rules` takes
`{$rules:'1', id, revision, targets}` and an explicit `writableFields` allowlist.
Targets add a JSON Pointer `field` to batch declarations. Optional `groupKey`
is application policy: first row per returned JSON group key is evaluated and
remaining duplicates are counted. Group/sibling/provenance data is explicit
`context`; the engine performs no hidden source reads.

`preview({rows, datasetRevision, context})` returns a deeply frozen plan with
SHA-256 `id`, rule ID/revision/document hash, dataset revision, enabled target IDs,
changes, counts and bounded diagnostics. Every change identifies entity/field,
target IDs, before presence/value, proposed value and any explanation. Equal
proposals deduplicate; differing proposals for the same entity/field conflict,
including when one proposal is a no-op. Conflicting locations are omitted from
selectable changes. Counts retain no-ops, conflicts, deduplication and cell errors.
Warm/cold caches produce the same plan identity.

`selectRuleChanges(plan, selection, currentPlan)` verifies both content hashes,
requires the same current plan identity and resolves unique stable change IDs.
**Call it inside an authoritative validated command transaction**, after checking
current authorization and reading saved rule/current rows. The current plan must
be recomputed there from authoritative data and policy. Revalidate resulting rows
before any effects, then use the existing durable receipt repository for replay.
A hash is content identity, never authorization or a signature. The helper alone
performs no writes and supplies no transaction.

The website's reviewed-rule example uses installed exports, a saved rule and local
SQLite, the reusable editor, and the existing virtual collection. Its application
command rechecks authority inside the receipt transaction, compares current rule
and dataset identities, validates all resulting rows before writes, and increments
row revisions only once. Draft preview does not save a rule; changing saved policy
requires a separate application command. Selection persists across review pages
and unmounted inventory rows; stale values never authorize writes.

## Measured qualification

The original fixture freeze and budgets are unchanged. Measurements include
compilation/snapshot overhead beside the retained static arithmetic loop; slower
native execution is reported. Evaluation pages are bounded and real worker
termination is automated on Node. Installed Node/Bun checks exercise source
migration, both frozen workloads and durable review replay. Real downstream data,
manual accessibility, physical devices and arbitrary host helpers remain separate
qualification; their absence is not a pass.

<!--fact:formula.measurements-->

Measured on v24.20.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Static arithmetic ms | Native formula ms | Added cost ratio | Errors | Page rows | Heap / RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---|
| catalog | 10000 | 0.95 | 229.04 | 240.11x | 0 | 256 | 35.85 / 116.09 |
| archive-stock | 75000 | 2.65 | 1629.40 | 615.91x | 0 | 256 | 84.54 / 255.76 |

Sources: 8 preserved, 5 translated (1 with named differences), 2 untranslatable, 1 disabled. Original byte changes: 0; repeat migration changes: 0. Preview writes: 0; replay writes/revisions: 0/0.

Synthetic public APIs only. Static arithmetic is faster; native costs include compilation, immutable snapshots, bounded outcomes and dependency memoization. Real saved-corpus, manual and physical-device acceptance remains pending.

<!--/fact-->
