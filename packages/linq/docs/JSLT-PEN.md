# The Jaren JSLT pen

> `./jslt` — `$jslt` 0.1 stylesheets: the envelope and its rules, whose
> bodies are captured over the matched value. **Read it when** you are
> transforming one document into another

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

You have one shape of JSON and you need another one — a record reshaped
for an API, a document rendered as a view, a value converted everywhere it
appears in a tree. A stylesheet is the declarative way to say that, and
writing one by hand means writing JSONPath strings and operator objects
into JSON literals with nothing checking either. This pen lets you write
each rule's body as a JavaScript arrow function and hands you the document
it recorded.

```js
import { stylesheet, rule, body, apply, op } from '@jarenjs/linq/jslt';
```

writes `$jslt` 0.1 stylesheets ([JSLT-FORMAT](../../json/docs/JSLT-FORMAT.md)):
the envelope and its rules, whose bodies are callbacks captured over `$` —
the matched value — through the chain's recording proxy, with the two
externals the engine binds on every dispatch (`root`, `path`) and the
parameters a body declares. The document is what `compileJsltStylesheet`
takes unchanged; the grammar it validates under is `jaren-jslt`
(`packages/json/schemas/jaren-jslt.schema.json`, and its draft-07 twin);
the engine is `@jarenjs/json`'s stylesheet dispatcher.

The pen imports no engine and judges nothing the compiler judges — path
syntax (`JT0003`), the body's operators (`JT0007`), a `schema` match's
hook (`JT0006`), the depth guard (`JT2001`) — with one exception it can
see earlier: the `[]` idiom of JSLT-FORMAT §6.3.

**The running example.** §3 is one publisher's catalogue, seen eight ways:
summarised, walked as a book of chapters, repriced in another currency,
rendered twice under two modes, appraised through a registered operator,
sorted by an importer's log records, rendered as a view, and matched by a
schema builder. Each rule set stands alone — that is what the gate runs —
but they are all over the same kind of document, so a member you meet in
§3.1 means the same thing in §3.8.

**A stylesheet is recursive, and a two-rule example hides it.** The whole
point of a template language is that a rule's body dispatches BACK into
the rule set for its children, so the shape a reader should have in mind
is a walk, not a mapping:

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const outline = stylesheet([
  rule('$', (v) => ({ name: v.name, children: [apply(v.children.all())] })),
  rule('$..children[*]', (v) => ({ name: v.name, children: [apply(v.children.all())] })),
]);
//   the second rule applies to its own children, so one rule walks a tree
//   of any depth: { name: '$.name', children: [ { $apply: '$.children[*]' } ] }
```

Both rules emit the same body; the second one reaching its own matches is
what makes the stylesheet a recursive walk. §3.2 shows the same shape with
two different bodies, which is what a real transform looks like, and §3.4
shows the same walk split across two modes.

### 1.1 How a JavaScript callback becomes a document

This is the one thing about this pen a reader cannot get from
JSLT-FORMAT, and it is stated here once. The flow pen
([FLOW-PEN.md](FLOW-PEN.md) §5), the migration pen
([MIGRATION-PEN.md](MIGRATION-PEN.md) §4.3) and the app pen
([APP-PEN.md](APP-PEN.md)) capture through the same machine and link
this section rather than restate it.

A body is not parsed and it is not serialized. It is **run once, at build
time, against a recording proxy** — the same proxy the chain's `select()`
records — and the document is what the recording left behind. Five
consequences, in the order a writer meets them:

1. **A member read records a path.** `v.author.name` is not a value; it
   is a proxy that answers another proxy for every member read and
   remembers the walk. When the callback returns, that walk has become the
   string `"$.author.name"`. `v.chapters.all()` records the wildcard
   segment (`"$.chapters[*]"`), `v.get('sub title')` records a bracket
   segment (`"$['sub title']"`), and an operator method records the
   operator (`v.price.mul(1.21)` → `{ "$mul": ["$.price", 1.21] }`). The
   operators are the chain's own and are documented once, in
   [QUERY-PEN.md](QUERY-PEN.md) §4.
2. **The callback runs exactly once, with no data — so JavaScript's own
   logic is not the document's.** There is no input value to branch on,
   and the ways that goes wrong divide in two. `>`, `<`, `+` and template
   interpolation throw a plain `TypeError` ("Cannot convert object to
   primitive value"): loud, uncoded, and impossible to miss. But `!`,
   `&&`, `||`, the ternary, `in`, `typeof` and `Object.keys` all evaluate
   against the PROXY and silently write the wrong document —
   `() => ({ live: !v.deleted })` writes `{ "live": false }`,
   `() => ({ both: v.a && v.b })` keeps only the right operand
   (`{ "both": "$.b" }`), and `v.flag ? 'a' : 'b'` is always `'a'`. A
   condition belongs in the document: the expression surface's `.and()`,
   `.or()`, `.not()`, an operator (`op('$if', …)`), or a second rule with
   a narrower `match`. [QUERY-PEN.md](QUERY-PEN.md) §3 states this once
   for every capture in the suite.
3. **The externals argument is a closed world.** `body()`'s second
   argument answers exactly the names the engine will bind: `root` and
   `path` always (JSLT-FORMAT §8.2), plus each name the body declared in
   `{ externals: [...] }` (§8.1). Any other name is `JL0104` at build
   time, where the fix can be named — see §4.3. That is the whole reason
   the argument is a proxy and not an object: an object would answer
   `undefined` and the mistake would surface at run time as a missing
   binding.
4. **A returned literal is a CONSTRUCTOR, not a constant.** The chain
   folds a pure data tree into one `$const` ([QUERY-PEN.md](QUERY-PEN.md)
   §3, expression capture); a body does not. `() => ({ level: 'unknown' })`
   writes `{ "level": "unknown" }` — the format's own object constructor,
   JSLT-FORMAT Appendix A.6's spelling — because that is what a
   stylesheet author reads and edits.
   The pen passes `fold: false` to the shared capture for exactly this.
   The cost is that a string is now ambiguous with a path, so a string
   value that starts with `$` is escaped `$$` on the way out
   (`() => '$x'` writes `"$$x"`); the engine unescapes it.
5. **The document is a value.** What comes back is plain, deep-frozen
   JSON — never the caller's object, never a proxy. Round-tripping it
   through `JSON.stringify` and `JSON.parse` deep-equals it, two builds
   of one spelling are one document, and an array the caller passed in
   stays unfrozen. Captures
   also nest: a `body()` built inside another body's callback is its own
   document, and embedding it in the outer literal makes it DATA there
   (the `$$` escape says so).

The machine underneath is `captureQuery` in
`packages/linq/src/capture-root.js` — a value rooted at `$` plus a list
of named externals — and `body()` is the JSLT pen's entry point into it
(`packages/linq/src/jslt/body.js`). The migration pen calls `body()`
itself, so a `jslt` migration step's externals are `root` and `path` too.
The flow and app pens call `captureQuery` directly with an EMPTY external
list, because their engines bind nothing; [FLOW-PEN.md](FLOW-PEN.md) §5
states what that changes.

## 2. The mapping table

Five exported names — `stylesheet`, `rule`, `body`, `apply` and `op` —
and seventeen rows, because every member and option a call takes earns
one of its own (`match`'s three forms, `mode`, `priority`, `unmatched`,
`modes`, and the two things that can stand where a body is taken). The
completeness gate in `test/linq/pen-docs.test.js` asserts that every
exported callable name appears somewhere in this section; rows
legitimately outnumber names here, which is why that gate is
one-directional, and this pen is its clearest case.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `stylesheet(rules, { unmatched?, modes? })` | `{ $jslt: '0.1', unmatched?, modes?, rules }` — the envelope (§2.1), in that member order; the bare-array form is the rules array itself | `Stylesheet<In, Out>`: the FIRST rule's phantoms, or the author's (`stylesheet<In, Out>(…)`) | native; a non-array, another option, a rule that is not an object, a rule without `body`, a rule that is not JSON `JL0101` |
| `unmatched` | `unmatched: 'share' \| 'fresh' \| 'error'` (§5) | `Disposition` | native; another value `JL0101` |
| `modes` | `modes: { name: { unmatched } }` (§2.1) | — | native; another member, a mode that is not `{ unmatched }`, a map whose prototype a `__proto__:` literal replaced `JL0101` |
| `rule(match, body, { mode?, priority? })` | `{ mode?, match?, priority?, body }` — the rule object (§2.2), in that member order | `Rule<In, Out>` | native; a non-object options, another option `JL0101` |
| `match` as a JSONPath string | `match: '$..price'` (§3.1) | the honest top | native |
| `match` as `{ path?, schema? }` | the object; `schema` a schema-pen builder's document, or a schema verbatim | a builder types the body's value (`Infer<>`) | native; `{}` is `JL0102`; another member, a non-string `path`, a `schema` that is not JSON `JL0101` |
| `match` `null` or absent | no `match` member — the unconditional rule (default priority −1, §4) | the honest top | native |
| `mode` | `mode: 'toc'` (§7) | `string` | native; a non-string `JL0101` |
| `priority` | `priority: 2` (§4) | `number` | native; a non-finite number, or `-0`, `JL0101` |
| `body(fn, { externals? })` | the captured query document — `fn(v, x)` with `v` at `$`, `x.root`/`x.path` (§8.2) and the declared parameters as `$name` externals (§8.1); a returned literal is a constructor, a string starting `$` is escaped `$$` | `BodyDocument<In, Out>`: `In` from the annotated `v` (`(v: Expr<Book>) => …`), `Out` the unwrapped return; a declared parameter is `UnknownExpr` until `x` is annotated (`x: Externals<{ rate: number }>`) | native; a non-callback, a non-object options, another option, a non-array or non-identifier external `JL0101`; an undeclared external `JL0104`; `root`/`path` declared `JL0104` |
| a callback where a body is taken | `body(fn)` with no parameters | as above; the match's builder types `v` | native |
| a query document where a body is taken | the document, verbatim (a `body()` result, or by hand) | a `body()` document carries its phantoms; a hand-written one is `unknown` | native; not JSON `JL0101` |
| `apply(selector)` | `{ $apply: selector }` — the rule's own mode (§6.2); the selector an expression (`v.chapters.all()`), a path string verbatim (`'$.chapters[*]'`), or data (`[1, 2]` embeds as `$const`) | `UnknownExpr` — a dispatch to other rules | native; no selector `JL0101`; outside `body()` `JL0102` |
| `apply(selector, mode)` | `{ $apply: [selector, mode] }` — the argument-list form (§6.2) | `UnknownExpr` | native; a non-string mode `JL0101` |
| `[apply(…)]` as a member value | `[{ $apply: … }]` — the `[]` idiom (§6.3) | `unknown[]` | native |
| `apply(…)` as a bare member value | — | — | refused (`JL0102`): the engine fails at run time on the second child (`JQ2001`) |
| `op(name, operands)` | `{ [name]: operands }` — a registered operator (§13), spelled without judging it; one operand or a list | `UnknownExpr` | native; the engine's `JQ0002` decides; a name without `$` `JL0101`; outside any capture `JL0005` |

Three rules the table implies, spelled out:

- **A body's literal is a constructor, not a constant.** §1.1 point 4 is
  where the reason lives; the consequence for the table is that a `body`
  cell never shows a `$const` unless the value reached the document as
  DATA (an `apply()` selector that is plain data, an `op()` operand that
  is an object).
- **`root` and `path` need no declaration; a parameter needs one.** The
  engine binds the two on every dispatch (§8.2) and shadows any binding
  of the same name, so declaring them is the mistake and is refused. A
  parameter is `body(fn, { externals: ['rate'] })`, and
  `transform.externals` lists exactly the declared names the body used
  (§8.3).
- **The pen judges nothing the compiler judges.** A path that does not
  parse, an operator no registry answers, a `schema` match compiled
  without a hook, a self-applying loop: each is the engine's own error
  (`JT0003`, `JT0007`/`JQ0002`, `JT0006`, `JT2001`), unwrapped. The one
  refusal the pen adds is the one the engine would only raise at RUN
  time.

## 3. Worked examples

Every `js` fence below exports exactly one stylesheet (or rule list), and
the `json` fence that follows it is what the pen emits — executed by
`test/linq/pen-docs.test.js`, which imports each fence from the workspace
and compares its one export to the JSON beside it. The seven fixtures of
JSLT-FORMAT Appendix A are all rebuilt through the pen and held BYTE-equal
to the format doc's own fences by `test/linq/jslt-pen.test.js`; three of
them are here, and every document below also validates under both
published grammars.

### 3.1 A rule at the root, with a `$const`-free body

The plainest thing the pen does: one rule matching the whole document,
and a body of member reads and operators. Nothing here is data, so
nothing here is `$const`.

```js
import { stylesheet, rule } from '@jarenjs/linq/jslt';

export const summary = stylesheet([
  rule('$', (v) => ({
    isbn: v.isbn,
    author: v.author.name.upper(),
    pages: v.chapters.all().pages.sum(),
    chapters: v.chapters.all().count(),
  })),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": "$",
      "body": { "isbn": "$.isbn",
                "author": { "$upper": "$.author.name" },
                "pages": { "$sum": "$.chapters[*].pages" },
                "chapters": { "$count": "$.chapters[*]" } } }
  ] }
```

Over `{ isbn: '978-1', author: { name: 'ada' }, chapters: [{ pages: 3 }, { pages: 4 }] }`
the compiled transform answers
`{ isbn: '978-1', author: 'ADA', pages: 7, chapters: 2 }`. Note
`v.chapters.all().count()`, not `v.chapters.count()`: the first counts the
ITEMS the wildcard yields, the second counts the one value `$.chapters` is.
That distinction is the chain's, not this pen's, and QUERY-PEN §4 is
where it is stated.

### 3.2 An `apply()` splice, and the `[]` idiom

JSLT-FORMAT Appendix A.3 — the book example, done right. The brackets
around the `apply()` are not decoration: they are what splices the
dispatched sequence into one array.

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const book = stylesheet([
  rule({ schema: { type: 'object', required: ['isbn'] } },
    (v) => ({ title: v.title, children: [apply(v.chapters.all())] })),
  rule({ schema: { type: 'object', required: ['heading'] } },
    (v) => ({ name: v.heading })),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": { "schema": { "type": "object", "required": ["isbn"] } },
      "body": { "title": "$.title",
                "children": [ { "$apply": "$.chapters[*]" } ] } },
    { "match": { "schema": { "type": "object", "required": ["heading"] } },
      "body": { "name": "$.heading" } }
  ] }
```

Drop the brackets — `children: apply(v.chapters.all())` — and the pen
refuses with `JL0102` before anything runs, because the engine would
accept it and then fail on the second chapter. §6.1 shows both spellings
side by side with the run-time error the refusal prevents.

### 3.3 A body captured directly: `root`, `path` and a declared parameter

Appendix A.7, in the bare-array form (a rules array is a stylesheet too).
This is `body()` used on its own, which is what the reader reaches for
when a body is shared between rules or built conditionally in JavaScript.

```js
import { rule, body } from '@jarenjs/linq/jslt';

export const priced = [
  rule('$..price', body(
    (v, x) => ({ amount: v.mul(x.rate), currency: x.root.currency, at: x.path }),
    { externals: ['rate'] })),
];
```

```json
[ { "match": "$..price",
    "body": { "amount": { "$mul": ["$", "$rate"] },
              "currency": "$root.currency",
              "at": "$path" } } ]
```

Three different things become three different spellings: `v` is the
matched value, so it records `"$"`; `x.root` is the input document root,
so it records `"$root.…"`; `x.path` is the matched value's normalized
path, a STRING the engine supplies per dispatch. Only `rate` needed
declaring, and the compiled transform then reports
`transform.externals` as `['rate']` — a caller who omits it gets
`JT2004` wrapping `JQ2006` at run time, which is the engine's business,
not the pen's.

### 3.4 Two modes, and the `modes` member

Appendix A.4 with dispositions added: the same sections rendered twice,
once as a table of contents and once as body copy, and each mode saying
what happens when nothing matches (§5).

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const guide = stylesheet([
  rule('$', (v) => ({
    toc: [apply(v.sections.all(), 'toc')],
    body: [apply(v.sections.all(), 'render')],
  })),
  rule('$.sections[*]', (v) => ({ ref: v.id, label: v.heading }), { mode: 'toc' }),
  rule('$.sections[*]', (v) => ({ anchor: v.id, heading: v.heading, text: v.text }), { mode: 'render' }),
], { unmatched: 'share', modes: { toc: { unmatched: 'error' }, render: { unmatched: 'fresh' } } });
```

```json
{ "$jslt": "0.1",
  "unmatched": "share",
  "modes": { "toc": { "unmatched": "error" }, "render": { "unmatched": "fresh" } },
  "rules": [
    { "match": "$",
      "body": { "toc":  [ { "$apply": ["$.sections[*]", "toc"] } ],
                "body": [ { "$apply": ["$.sections[*]", "render"] } ] } },
    { "mode": "toc", "match": "$.sections[*]",
      "body": { "ref": "$.id", "label": "$.heading" } },
    { "mode": "render", "match": "$.sections[*]",
      "body": { "anchor": "$.id", "heading": "$.heading", "text": "$.text" } }
  ] }
```

The envelope's member order is fixed (`$jslt`, `unmatched`, `modes`,
`rules`) whatever order the options were written in, and a rule's is
`mode`, `match`, `priority`, `body`. The `mode` argument of `apply()` is
a literal string, never an expression — dynamic mode selection is a
non-goal of 0.1 (§6.2) — and passing one records `JL0101` naming that.

### 3.5 `op()` — an operator the chain cannot reach

`op()` exists because a registry may carry operators the chain has no
method for. `$npv` is one: `@jarenjs/json`'s `financePack` registers it,
and no chain builder spells it.

```js
import { stylesheet, rule, op } from '@jarenjs/linq/jslt';

export const appraisal = stylesheet([
  rule('$.titles[*]', (v) => ({
    name: v.name,
    npv: op('$npv', [v.rate, v.cashflows.all()]),
  })),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": "$.titles[*]",
      "body": { "name": "$.name",
                "npv": { "$npv": ["$.rate", "$.cashflows[*]"] } } }
  ] }
```

The pen writes the name it is given and stops there. Compiled through
`createJsltRegistry().use(financePack)` this runs; compiled through the
default `compileJsltStylesheet` it is `JT0007` wrapping `JQ0002`,
"unknown operator". That is deliberate: LINQ-FORMAT §1.1 rule 1 forbids
the pen from carrying its own opinion of which operators exist, because
the registry is the host's to choose. `op()` also works inside a chain
callback — it lifts into whatever capture is in progress — and outside
every capture it is the chain's `JL0005`.

### 3.6 A constructor literal, and the `$$` escape

Appendix A.6's dispatch with an explicit fallback. Every body here
returns a JavaScript object literal, and every one of them lands in the
document as an object constructor rather than a `$const` — including the
string that starts with `$`, which is escaped so the engine reads it as
data.

```js
import { stylesheet, rule } from '@jarenjs/linq/jslt';

export const levels = stylesheet([
  rule({ schema: { type: 'object', required: ['error'] } }, (v) => ({ level: 'fatal', message: v.error })),
  rule({ schema: { type: 'object', required: ['info'] } }, (v) => ({ level: 'note', message: v.info })),
  rule(null, () => ({ level: 'unknown', hint: '$path is a literal here' })),
], { unmatched: 'error' });
```

```json
{ "$jslt": "0.1",
  "unmatched": "error",
  "rules": [
    { "match": { "schema": { "type": "object", "required": ["error"] } },
      "body": { "level": "fatal", "message": "$.error" } },
    { "match": { "schema": { "type": "object", "required": ["info"] } },
      "body": { "level": "note", "message": "$.info" } },
    { "body": { "level": "unknown", "hint": "$$path is a literal here" } }
  ] }
```

Read the third rule closely. `'fatal'`, `'note'` and `'unknown'` are
data, and they are spelled as themselves because no path can be confused
with them. `'$path is a literal here'` starts with `$`, which in a
document means an expression, so the pen wrote `"$$path is a literal
here"` — and the engine unescapes it back to the string the callback
returned. The rule for a reader is short: **an object literal in a body
is always spelled as the format's own constructor, and a string in it is
data**, escaped where it has to be. There is no spelling of a body that
turns an object literal into an expression by accident; to write an
expression you call one (a member read, an operator, `apply()`, `op()`).

The `rule(null, …)` in third place is the unconditional rule, whose
default priority is −1 (§4) — it is what makes `unmatched: 'error'` safe
to declare, since nothing can reach the built-in rule.

### 3.7 A stylesheet whose output is a view

A `jaren-vnode` tree is `[tag, props, children]` arrays, so a stylesheet
that writes one is an ordinary stylesheet whose bodies return arrays. This
is how an app document's view is written — [APP-PEN.md](APP-PEN.md) links
here for it — and how a `jslt` node in a dataflow renders
([FLOW-PEN.md](FLOW-PEN.md) §3.6).

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const catalogue = stylesheet([
  rule('$', (v) => ['ul', { class: 'catalogue' }, [apply(v.books.all())]]),
  rule('$.books[*]', (v) => ['li', { 'data-isbn': v.isbn }, v.title]),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": "$",
      "body": ["ul", { "class": "catalogue" }, [ { "$apply": "$.books[*]" } ]] },
    { "match": "$.books[*]",
      "body": ["li", { "data-isbn": "$.isbn" }, "$.title"] }
  ] }
```

The `[]` idiom is doing its usual work in the children position, and for
once the brackets look like what they are: an array constructor holding
one spliced sequence. Over two books this renders
`['ul', { class: 'catalogue' }, [['li', { 'data-isbn': '978-1' }, 'Ada'], ['li', { 'data-isbn': '978-2' }, 'Grace']]]`.

### 3.8 An `.open()` match, and the honest top

A `schema` match that is a schema-pen builder types the body's value, so
`v.title` is `string` and `v.titel` does not compile. `.open()` changes
that reading and it is worth seeing why.

```js
import * as s from '@jarenjs/linq/schema';
import { stylesheet, rule } from '@jarenjs/linq/jslt';

const Book = s.object({ isbn: s.string(), title: s.string() }).open();

export const listing = stylesheet([
  rule({ schema: Book }, (v) => ({ title: v.title, isbn: v.isbn, extra: v.get('subtitle') })),
]);
```

```json
{ "$jslt": "0.1",
  "rules": [
    { "match": { "schema": { "type": "object",
                             "properties": { "isbn": { "type": "string" },
                                             "title": { "type": "string" } },
                             "required": ["isbn", "title"] } },
      "body": { "title": "$.title", "isbn": "$.isbn", "extra": "$['subtitle']" } }
  ] }
```

`.open()` removes `additionalProperties: false`, which is why the emitted
schema carries no such member. The type follows emit's reading of the
EMITTED document (LINQ-FORMAT §1.1 rule 4), so `Infer<typeof Book>`
becomes `{ isbn: string; title: string } & { [key: string]: unknown }` —
and that index signature is what a reader has to see coming, because on
the chain it changes EVERY member:

| | closed `s.object({ isbn, title })` | the same builder `.open()` |
|---|---|---|
| `Infer<>` | `{ isbn: string; title: string }` | the same, plus `{ [key: string]: unknown }` |
| `v.title` in the body | `string` | `unknown` |
| `v.get('subtitle')` | `unknown`, and nothing says the member exists | `unknown`, and the shape says it may |
| the emitted document | identical apart from `additionalProperties: false` | — |

The chain reads a member through the same lookup for both, and an index
signature answers `unknown` for every key — so opening the object buys
the honest statement that the shape has more in it than the schema
declares, and pays for it with the declared members' types. Both bodies
above emit exactly the same paths; only the compiler's opinion of them
differs. Where the members matter more than the openness, keep the
builder closed and reach the undeclared ones with `get()`; the pen never
blocks it.

## 4. Refusals

The JSLT pen raises these three `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/jslt/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, an option it does not know, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry: an `apply()` as a bare object member, a `match` of `{}`, an `apply()` outside a body |
| `JL0104` | an external a captured body did not declare, or `root`/`path` declared as one |

`packages/linq/src/jslt/` carries **28 throw sites** — 24 `JL0101`, 3
`JL0102` and 1 `JL0104` — and they collapse to the conditions below. Two
further conditions reach a caller through this pen without being thrown
in its directory: the JSON boundary (`requireJson`, `requireNameMap`) and
the shared capture's undeclared-external check
(`packages/linq/src/capture-root.js`), which is where the second
`JL0104` comes from.

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. `docPath`, where the
refusal carries one, is the JSON pointer of the node being assembled and
is appended to the message text as well (`… at /modes/m`); the rows name
it where it exists, and its absence in a row is not an oversight but the
pen's state today (§4.4).

### 4.1 `JL0101` — the value, the option and the map

**`body()`** — five conditions, all at the door, before the callback runs.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `body(42)`, `body('$')` | `body() takes a callback (value, x) => …, got 42` | a callback; a document goes straight into `rule()` |
| `body(fn, 'rate')` | `body() options are { externals?: string[] }, got a string` | `{ externals: ['rate'] }` |
| `body(fn, { params: ['rate'] })` | `body() does not take 'params'` | `externals` — the format's word (§8.1) |
| `body(fn, { externals: 'rate' })` | `body() externals is an array of parameter names, got a string` | an array, even for one name |
| `body(fn, { externals: ['not a name'] })` | `body() externals are identifiers ('rate'), got a string` | an identifier: `[A-Za-z_][A-Za-z0-9_]*` |

**`apply()` and `op()`** — three conditions.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `body(() => [apply()])` | `apply() takes a selector: a path (v.chapters.all(), '$.chapters[*]') or an expression` | a selector |
| `body((v) => [apply(v, v.mode)])` | `apply() takes the target mode as a literal string (a mode is not an expression, JSLT-FORMAT §6.2), got an expression` | `apply(v, 'toc')` |
| `body(() => op('npv', []))` | `op() takes an operator name starting with '$' ('$npv'), got a string` | `op('$npv', …)` |

**`rule()`** — ten conditions, four of them about `match`.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `rule(42, fn)` | `rule() match is a JSONPath string or { path?, schema? }, got 42` — `docPath` `/match` | a path string, the object form, or `null` |
| `rule({ paths: '$' }, fn)` | `rule() match takes 'path' and/or 'schema', not 'paths' (JSLT-FORMAT §3.1)` — `docPath` `/match/paths` | `path`, `schema`, or both |
| `rule({ path: 42 }, fn)` | `rule() match.path is an RFC 9535 query string, got 42` — `docPath` `/match/path` | a query string |
| `rule({ schema: new Date(0) }, fn)` | `rule() match.schema received a Date instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a schema-pen builder, or a JSON schema |
| `rule('$')` | `rule() takes a body: a callback (value, x) => …, body(…), or a query document` — `docPath` `/body` | one of the three |
| `rule('$', { $const: Symbol('x') })` | `rule() body received a Object instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON document |
| `rule('$', fn, 'toc')` | `rule() options are { mode?, priority? }, got a string` | `{ mode: 'toc' }` |
| `rule('$', fn, { modes: 'x' })` | `rule() does not take 'modes' (JSLT-FORMAT §2.2)` | `mode` on a rule; `modes` on the stylesheet |
| `rule('$', fn, { mode: 1 })` | `rule() mode is a string naming the rule's mode, got 1` — `docPath` `/mode` | a string; `''` is the unnamed mode |
| `rule('$', fn, { priority: 'high' })`, `{ priority: NaN }`, `{ priority: -0 }` | `rule() priority is a finite JSON number, got a string` — `docPath` `/priority` | a finite number |

**`stylesheet()`** — eleven conditions.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `stylesheet({ rules: [] })` | `stylesheet() takes an array of rules, got a Object instance` — `docPath` `/rules` | the rules array itself |
| `stylesheet([], 'fresh')` | `stylesheet() options are { unmatched?, modes? }, got a string` | `{ unmatched: 'fresh' }` |
| `stylesheet([], { version: '0.1' })` | `stylesheet() does not take 'version' (JSLT-FORMAT §2.1)` | the pen writes `$jslt` itself |
| `stylesheet([], { unmatched: 'copy' })` | `unmatched is one of 'share', 'fresh' or 'error' (JSLT-FORMAT §5), got 'copy'` — `docPath` `/unmatched` | one of the three |
| `stylesheet([], { modes: 'x' })` | `stylesheet() modes is { name: { unmatched } }, got a string` — `docPath` `/modes` | a name → `{ unmatched }` map |
| `stylesheet([], { modes: { __proto__: { unmatched: 'error' } } })` | `stylesheet() modes received a map whose prototype was replaced: a '__proto__:' key in an object literal sets the prototype instead of adding a member, so that member is not there to emit — spell it { ['__proto__']: … }, which is an own key` — `docPath` `/modes` | `{ ['__proto__']: … }` |
| `stylesheet([], { modes: { m: {} } })`, `{ m: { unmatched: 'share', extra: 1 } }` | `stylesheet() mode 'm' is { unmatched } and nothing else (JSLT-FORMAT §2.1)` — `docPath` `/modes/m` | exactly `{ unmatched }` |
| `stylesheet([], { modes: { m: { unmatched: 'x' } } })` | `modes/m/unmatched is one of 'share', 'fresh' or 'error' (JSLT-FORMAT §5), got 'x'` — `docPath` `/modes/m/unmatched` | one of the three |
| `stylesheet(['$'])` | `stylesheet() rule 0 is an object — rule(match, body) — got a string` — `docPath` `/rules/0` | `rule(match, body)` |
| `stylesheet([{ match: '$' }])` | `stylesheet() rule 0 has no body (JSLT-FORMAT §2.2, the compiler's JT0002)` — `docPath` `/rules/0/body` | give the rule a body |
| a hand-written rule that is not JSON | `stylesheet() rule 0 received a … instance, which is not JSON — …` — `docPath` `/rules/0` | a JSON rule document |

The `modes` row that names `__proto__` is not a curiosity: it is
LINQ-FORMAT §1.1 rule 5 applied at this pen's one name → value map, and
the gate that proves it is the same one that proves it for the schema,
model, contract, flow, app and forms pens.

Two refusals a body can raise that are the CHAIN's rather than this
pen's, listed because a reader who hits one will look here first:
`rule('$', () => 1n)` is `JL0005` ("a captured expression cannot embed a
bigint value") and `op('$npv', [])` outside any capture is `JL0005` ("an
operator expression can only be lifted inside a capture callback — no
capture is in progress to bind it to"). Both are documented in
[QUERY-PEN.md](QUERY-PEN.md) §9.

### 4.2 `JL0102` — the construct the format cannot carry

Three conditions, and every one of them is the pen seeing something the
engine would only object to later, or not at all.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `body((v) => ({ children: apply(v.chapters.all()) }))` | `an object member takes exactly one value — 'children' holds an apply(), which yields a SEQUENCE and fails at run time on the second child (JQ2001); wrap the apply in [] (JSLT-FORMAT §6.3: children: [apply(…)])` — `docPath` `/children` | `children: [apply(v.chapters.all())]` |
| `rule({}, fn)` | `rule() match {} would match nothing — write no match for the unconditional rule (JSLT-FORMAT §3.1, the compiler's JT0003)` — `docPath` `/match` | `rule(null, fn)` |
| `apply('$')` outside a body | `apply() spells $apply, which exists only inside a rule body (JSLT-FORMAT §6.1) — call it inside body()` | call it inside `body()` or a `rule()` callback |

The first is this pen's whole reason for existing beyond typing, and §6.1
tells the story with the run-time error beside it. The walk that finds it
descends the literal the callback returned — plain objects and arrays,
any depth — so `body((v) => ({ a: { b: [{ c: apply(v.x) }] } }))` refuses
with `docPath` `/a/b/0/c`, naming the exact member. §6.1 also names the
one place the walk does not reach.

The second is `JT0003` seen early. `{}` is a legal JSON object and an
illegal `match`, and the compiler would say so — but a stylesheet is
often assembled from a variable, and `rule(someMatch, fn)` with an empty
object is the shape that mistake takes.

The third is availability: `$apply` is injected into body compilation and
exists nowhere else (§6.1), so an `apply()` outside a capture has no
document to belong to.

### 4.3 `JL0104` — the closed world of a body

A body may name `root`, `path` and its declared parameters. Nothing else,
because the engine binds nothing else — JSLT-FORMAT §8.1 and §8.2 are the
whole vocabulary, and a name outside it would compile and then fail at
run time as an unbound reference (`JQ2006`, wrapped as `JT2004`).

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `body((v, x) => v.mul(x.rate))` | `a body() rule cannot bind 'rate' — its query evaluates with exactly 2 externals, 'root' and 'path'; anything else has nothing to bind to — a stylesheet parameter is declared first: body(fn, { externals: ['rate'] })` | declare it: `body(fn, { externals: ['rate'] })` |
| `body((v, x) => x.limit, { externals: ['rate'] })` | `a body() rule cannot bind 'limit' — its query evaluates with exactly 3 externals, 'root' and 'path' and 'rate'; anything else has nothing to bind to — a stylesheet parameter is declared first: body(fn, { externals: ['limit'] })` | add it: `{ externals: ['rate', 'limit'] }` |
| `body(fn, { externals: ['root'] })`, `['path']` | `'root' is engine-bound on every dispatch (JSLT-FORMAT §8.2) — it needs no declaration and is always present on the externals argument` | drop the declaration; read `x.root` directly |

The second message's advice names the ONE name that was missing, which is
the fix in a body that declared nothing else; a body that already
declares parameters adds to the list rather than replacing it, as the
"spelling that works" column says.

The third row is the interesting one. Declaring `root` is not harmless
and then ignored: §8.2 makes the two names reserved, and the engine
shadows any stylesheet parameter of the same name, so a body that
declared `root` and passed a value for it would silently read the
document root instead. Refusing the declaration is what keeps that from
being a run-time surprise.

### 4.4 What carries a `docPath` and what does not

Where the pen knows the pointer of the node it is assembling, the
refusal carries it: every `match`, `mode`, `priority`, `modes` and
`rules` row above. Where the value crossed the JSON boundary
(`requireJson`) the pointer is not passed through, so
`rule({ schema: new Date(0) }, fn)` names the method in its message and
carries no `docPath` — the message is still unambiguous, and the
convention across the family is that a row states the pointer only when
one exists.

## 5. The types

The declarations are `packages/linq/types/jslt.d.ts` (193 lines), and
every claim below is pinned at compile level in
`test/consumer/linq-jslt.ts` with a runtime twin in
`test/linq/jslt-pen.test.js`. This subpath exports **no builder class, no
constant and no type guard** — the three kinds the mapping table excludes
(LINQ-FORMAT's D5 reading) are empty here, so §2 names the whole runtime
surface and this section is about the compile-time one. The shapes below
are §3.2's book and its chapters, declared.

```ts
import { stylesheet, rule, body, apply } from '@jarenjs/linq/jslt';
import type { Externals, Input, Output, Rule, Stylesheet, BodyDocument } from '@jarenjs/linq/jslt';
import type { Expr } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';

interface Chapter { heading: string }
interface Book { isbn: string; title: string; chapters: Chapter[] }
interface Item { sku: string; price: number }

const BookSchema = s.object({ isbn: s.string(), title: s.string() });

const chapter = rule({ schema: s.object({ heading: s.string() }) }, (v) => ({ name: v.heading }));
//    ^ Rule<{ heading: string }, { name: string }> — the builder types v
const book = body((v: Expr<Book>) => ({ title: v.title, children: [apply(v.chapters.all())] }));
//    ^ BodyDocument<Book, { title: string; children: unknown[] }> — a dispatch is unknown
const priced = body(
  (v: Expr<Item>, x: Externals<{ rate: number }>) => ({ amount: v.price.mul(x.rate) }),
  { externals: ['rate'] });                        // x.limit does not compile

const sheet = stylesheet([rule(null, book), chapter]);
type Out = Output<typeof sheet>;                   // the FIRST rule's: { title: string; children: unknown[] }
const typed = stylesheet<Book, { title: string; children: { name: string }[] }>([rule(null, book), chapter]);
```

### 5.1 The phantoms, and where each side comes from

`BodyDocument<In, Out>`, `Rule<In, Out>` and `Stylesheet<In, Out>` all
carry two phantom members — `__in` and `__out`, declared and never
present at runtime — and `Input<>`/`Output<>` read them back. The
question a reader has is where each side gets its value.

| | `In` — what the body was written over | `Out` — what it produces |
|---|---|---|
| `body(fn)` | the annotation on the first argument (`(v: Expr<Book>) => …`); `unknown` without one | `Unwrap<>` of the callback's return |
| `rule(match, fn)` | the `schema` match's `Infer<>` when it is a schema-pen builder; the first argument's annotation otherwise; `unknown` for a path match alone | `Unwrap<>` of the callback's return |
| `rule(match, bodyDoc)` | the body document's `In`, or the match's when the body is untyped | the body document's `Out` |
| `rule(match, json)` | `unknown` | `unknown` |
| `stylesheet(rules)` | the FIRST rule's `In` | the FIRST rule's `Out` |
| `stylesheet<In, Out>(rules)` | the author's | the author's |

Two consequences worth stating rather than discovering:

- **Write the root rule first.** A stylesheet's phantoms are its first
  rule's, which is a convention rather than an inference — Appendix A
  writes the root rule first in every fixture, and this pen types on that
  assumption. A stylesheet whose first rule is a leaf rule types as that
  leaf.
- **Every `apply()` is `unknown`, and it has to be.** A dispatch lands on
  whichever rule wins at run time, over a value the type system never
  sees; `[apply(…)]` therefore unwraps to `unknown[]`, and
  `apply(…).count()` to `number` (the operator is typed, its input is
  not). Where the author knows the answer — a chapter always renders as
  `{ name }` — the author states it with `stylesheet<In, Out>(…)`, and
  the pin file holds that annotation as the way to say so.

The built-in rule's rebuilds (`share`/`fresh` around an unmatched
container, §5) are not typed at all: a stylesheet whose root is unmatched
is `Stylesheet<unknown, unknown>` unless annotated.

### 5.2 `Externals<X, Root>` — a second argument that answers by name

`Externals` is the type of `body()`'s second parameter and it is built
from two halves: `root` and `path`, always present, and a mapped type
over the declared names.

```ts
// root types by the second parameter of Externals<>; path is always a string expression
void body((v: Expr<Item>, x: Externals<{}, Book>) => ({ isbn: x.root.isbn.upper(), me: v.sku }));
// a declared name types through the annotation; the declaration and the annotation must agree
const p = body((v: Expr<Item>, x: Externals<{ rate: number }>) => v.price.mul(x.rate), { externals: ['rate'] });
// @ts-expect-error — the annotation names 'rate' and the declaration says 'limit'
void body((v: Expr<Item>, x: Externals<{ rate: number }>) => x.rate, { externals: ['limit'] });
// @ts-expect-error — a typed parameter takes its own kind
void body((v: Expr<Item>, x: Externals<{ rate: number }>) => x.rate.upper(), { externals: ['rate'] });
```

Without an annotation a declared name is still reachable and is
`UnknownExpr` — the honest top — so `{ externals: ['rate'] }` alone buys
the runtime check without the type. Undeclared names are a compile error
whether or not `x` is annotated, which is the same shape the chain's
`params()` has and the reason the pin file checks both directions.

### 5.3 What the pins hold

`test/consumer/linq-jslt.ts` (117 lines) is the compile-level record, and
it is worth knowing what it asserts because a claim not in it is a claim
this document should not make. It pins, with `Equals<A, B>` — identity in
both directions, never assignability — the `In`/`Out` of an annotated
body, an unannotated body, a scalar body, a schema-matched rule, an
annotated callback rule, a path-only rule, a rule built from a body
document, and a stylesheet in both its inferred and annotated forms. It
pins eleven negatives with `@ts-expect-error`, each of which FAILS the
build if it ever starts compiling: an undeclared external, an annotation
that disagrees with its declaration, an external used at the wrong kind,
a misspelled member on an annotated value, a misspelled member under a
schema match, a non-string mode, a non-number priority, an unknown
disposition, an operator name without `$`, an expression where a mode
string belongs, and a stylesheet asserted at an output its rule
contradicts.

## 6. What it cannot spell

Four things, and only one of them is a limit of the FORMAT. The other
three are the pen refusing a spelling that would compile and then behave
wrongly, or a route the pen does not offer.

### 6.1 The `[]` idiom — the refusal, and the run-time failure it prevents

This is the trap JSLT-FORMAT §6.3 names as "the one trap every author
hits", and it is the only place the pen refuses something the compiler
accepts.

An `$apply` yields a SEQUENCE. An object member holds exactly one value
(QUERY-FORMAT §3.1). So:

```js
// refused at build time — JL0102, docPath /children
rule('$', (v) => ({ title: v.title, children: apply(v.chapters.all()) }))

// the spelling that works — the brackets splice the sequence into one array
rule('$', (v) => ({ title: v.title, children: [apply(v.chapters.all())] }))
```

Write the refused spelling by hand — as a JSON rule document, which the
pen carries verbatim — and the engine compiles it happily. Over a book
with ONE chapter it even works, answering
`{ title: 'T', children: 1 }`; over a book with two it throws
`JT2004` wrapping `JQ2001`, "member 'children' evaluated to 2 items; an
object member takes exactly one". That is the failure mode this refusal
exists for: a transform that passes its first test and breaks on real
data.

**The check runs over the emitted document, not over what the callback
returned, and the difference matters.** An object literal handed to an
OPERATOR is lowered while the callback is still running —
`op('$if', [v.flag, { children: apply(v.chapters.all()) }, null])` — so by
the time the callback returns there is no marker left to find, only the
node it left behind in the document. Walking the document catches both
routes with one rule, and it reads member position exactly as the capture
wrote it: a map constructor has no `$`-prefixed key, an operator or FLWOR
phrase does, and `$map` — the phrase a `$`-keyed data object is spelled
as — carries its members as `[key, value]` pairs. So all four of these are
`JL0102`, at the pointer of the offending member:

| The spelling | `docPath` |
|---|---|
| `({ children: apply(v.x) })` | `/children` |
| `({ a: { b: [{ c: apply(v.x) }] } })` | `/a/b/0/c` |
| `({ out: op('$if', [v.flag, { children: apply(v.x) }, null]) })` | `/out/$if/1/children` |
| `({ $weird: apply(v.x) })` | `/$map/0/1` |

An `apply()` in an OPERAND position is not a member and stays legal:
`apply(v.items.all()).count()` is `{ "$count": { "$apply": … } }`, and
`[apply(…)]` is the idiom itself. A hand-written body is untouched by any
of this — the pen judges what it captured, and a rule document handed to
`rule()` rides verbatim (§2).

### 6.2 A `match` of `{}`

The format has two ways to say "match everything": a path of `'$'`
(positional, the document root only) and no `match` at all (the
unconditional rule, which reaches every dispatched value). It has no way
to say it with an empty object, and the compiler's `JT0003` is what would
otherwise say so. `rule(null, fn)` is the spelling; `rule('$', fn)` is
the other one and means something different.

### 6.3 `apply()` outside a body

`$apply` is not part of the query language. The stylesheet compiler
injects it into each body compile (§6.1), and `compileJsonQuery` rejects
it as `JQ0002`. So there is no way to build a fragment containing an
`apply()` outside a `body()` and splice it in later — the marker the pen
uses to find bare applies is created by the capture and only lives inside
one. Build the fragment as a callback and pass it where a body is taken,
or write the `{ $apply: … }` document by hand and accept that the `[]`
check will not see it.

### 6.4 `from()` has no extensions pass-through — the one that surprises

This is not a limit of the stylesheet format at all, and it is here
because it is where readers of this document look for it. `op()` lifts an
operator into whatever capture is in progress, so it works in a chain
callback as well as in a body:

```js
from([{ rate: 0.1, cashflows: [-100, 60, 60] }])
  .select((r) => ({ v: op('$npv', [r.rate, r.cashflows.all()]) }))
```

The DOCUMENT this records is correct and identical to the one a body
would record. But the chain's in-memory evaluation carries no operator
registry, so `explain()` and `toArray()` both raise the engine's
`JQ0002` — "unknown operator '$npv'" — with `docPath` `/$return/v`. A
registered operator is reachable from a chain only where the chain runs
against a provider that was given the registry, or from a stylesheet
compiled through one (`createJsltRegistry().use(financePack)`, §3.5).
`test/linq/jslt-pen.test.js` pins both directions.

### 6.5 Everything else is the compiler's, by design

For completeness, because the boundary is what LINQ-FORMAT §1.1 rule 1
asks each pen document to state plainly. The pen does NOT check: whether
a `match` path parses (`JT0003`); whether a body's operators exist
(`JT0007` wrapping `JQ0002`); whether a `schema` match can be compiled
without the type-test hook (`JT0006`); whether a rule set recurses
without bottoming out (`JT2001`, the depth guard); whether an `$apply`
argument list has the right arity (`JQ0003` inside `JT0007`); or whether
two rules of equal priority conflict (§4 decides by document order and
never errors). Every one of those is built through the pen and asserted
at the engine's own code in `test/linq/jslt-pen.test.js` — the pen's
non-judgement is itself gated.

### 6.6 When not to reach for this pen

- **The stylesheet is data.** A `$jslt` document loaded from a file,
  authored by a model ([@jarenjs/ai](../../ai/README.md)'s authoring
  profile writes them) or edited in the studio is a value;
  `compileJsltStylesheet` takes it directly and nothing here has to be in
  the path.
- **You are transforming one value, once, in JavaScript.** A stylesheet
  is a document because it has to travel — into a migration step, into a
  flow node, into an app's view, into a database. Code that runs in one
  process and stays there should be a function: it can branch, loop and
  call libraries, and §1.1's five consequences are five ways a callback
  that looks like ordinary JavaScript is not.
- **The transform needs a condition JavaScript would express better.** A
  body cannot use `if`, `&&`, `||` or a ternary — §1.1 rule 2 says what
  they do instead, and it is silent and wrong. A transform whose shape is
  mostly conditional is a set of rules with narrower `match` paths, or it
  is not a stylesheet.
- **You need an operator the query language does not have.** `op()`
  reaches a REGISTERED operator, so the escape exists — but registering
  one is a decision about the engine everywhere it runs, not a local
  convenience, and a transform that needs three of them is a program.
- **The output is not JSON.** A stylesheet's result is a JSON value. Text,
  bytes and streams are somebody else's job — a `jaren-vnode` tree
  (§3.7) is JSON and renders to HTML downstream, which is the pattern to
  copy rather than the exception to it.

## 7. Cost

`@jarenjs/linq/jslt` builds to **<!--fact:bundle.jslt-->19,856<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.jslt.kb-->20<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report. Building a stylesheet as a consumer
would, it asserts that the bundle carries:

- **no engine** — not one byte of `@jarenjs/json`, `@jarenjs/validate`,
  `@jarenjs/emit`, `@jarenjs/db`, `@jarenjs/formats` or `@jarenjs/refs`,
  which is what makes the "the pen imports no engine" rule a measurement
  rather than a promise;
- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js`, `sources.js` or `schema-of.js`;
- **of the schema pen, only `brand.js`** — the builder brand, which
  `rule()` needs to tell a `schema` match's builder from a hand-written
  schema;
- **a ceiling** of 20,000 bytes; and the other direction, that neither the
  chain's bundle nor the schema pen's carries a byte of
  `packages/linq/src/jslt/`.

What it does carry is the recording proxy (`expression.js`), the shared
root capture (`capture-root.js`), the JSON boundary
(`json-boundary.js`), and this pen's own three files — 414 lines of
source. That makes it the SMALLEST of the nine pen bundles, and the
reason is that a stylesheet is mostly bodies, and a body is the shared
machine every pen already pays for.

Two figures worth reading beside it: `./migration` (<!--fact:bundle.migration-->24,259<!--/fact--> bytes)
carries this pen's `body()` and pays for it, which is why the two prices
sit so close; and `./flow` (<!--fact:bundle.flow-->19,910<!--/fact--> bytes) is within 60 bytes of this one
despite writing two formats, because it shares the same capture and adds
almost nothing but member checks and their messages.
