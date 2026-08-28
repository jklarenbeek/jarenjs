# The Jaren JSLT pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

```js
import { stylesheet, rule, body, apply, op } from '@jarenjs/linq/jslt';
```

writes `$jslt` 0.1 stylesheets ([JSLT-FORMAT](../../json/docs/JSLT-FORMAT.md)):
the envelope and its rules, whose bodies are callbacks captured over `$` —
the matched value — through the chain's recording proxy, with the two
externals the engine binds on every dispatch (`root`, `path`) and the
parameters a body declares. The document is what `compileJsltStylesheet`
takes unchanged; the pen imports no engine and judges nothing the compiler
judges — path syntax (`JT0003`), the body's operators (`JT0007`), a
`schema` match's hook (`JT0006`), the depth guard (`JT2001`) — with one
exception it can see earlier: the `[]` idiom. `body()` is the one
body-capture entry point the migration, flow and app pens reuse.

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `stylesheet(rules, { unmatched?, modes? })` | `{ $jslt: '0.1', unmatched?, modes?, rules }` — the envelope (§2.1), in that member order; the bare-array form is the rules array itself | `Stylesheet<In, Out>`: the FIRST rule's phantoms, or the author's (`stylesheet<In, Out>(…)`) | native; another option, a rule without `body`, a non-array `JL0101` |
| `unmatched` | `unmatched: 'share' \| 'fresh' \| 'error'` (§5) | `Disposition` | native; another value `JL0101` |
| `modes` | `modes: { name: { unmatched } }` (§2.1) | — | native; another member `JL0101` |
| `rule(match, body, { mode?, priority? })` | `{ mode?, match?, priority?, body }` — the rule object (§2.2), in that member order | `Rule<In, Out>` | native; another option `JL0101` |
| `match` as a JSONPath string | `match: '$..price'` (§3.1) | the honest top | native |
| `match` as `{ path?, schema? }` | the object; `schema` a schema-pen builder's document, or a schema verbatim | a builder types the body's value (`Infer<>`) | native; `{}` is `JL0102`; another member, a non-string `path` `JL0101` |
| `match` `null` or absent | no `match` member — the unconditional rule (default priority −1, §4) | the honest top | native |
| `mode` | `mode: 'toc'` (§7) | `string` | native; a non-string `JL0101` |
| `priority` | `priority: 2` (§4) | `number` | native; a non-finite number `JL0101` |
| `body(fn, { externals? })` | the captured query document — `fn(v, x)` with `v` at `$`, `x.root`/`x.path` (§8.2) and the declared parameters as `$name` externals (§8.1); a returned literal is a constructor, a string starting `$` is escaped `$$` | `BodyDocument<In, Out>`: `In` from the annotated `v` (`(v: Expr<Book>) => …`), `Out` the unwrapped return; a declared parameter is `UnknownExpr` until `x` is annotated (`x: Externals<{ rate: number }>`) | native; an undeclared external `JL0104`; `root`/`path` declared `JL0104` |
| a callback where a body is taken | `body(fn)` with no parameters | as above; the match's builder types `v` | native |
| a query document where a body is taken | the document, verbatim (a `body()` result, or by hand) | a `body()` document carries its phantoms; a hand-written one is `unknown` | native; not JSON `JL0101` |
| `apply(selector)` | `{ $apply: selector }` — the rule's own mode (§6.2); the selector an expression (`v.chapters.all()`), a path string verbatim (`'$.chapters[*]'`), or data (`[1, 2]` embeds as `$const`) | `UnknownExpr` — a dispatch to other rules | native; outside `body()` `JL0102` |
| `apply(selector, mode)` | `{ $apply: [selector, mode] }` — the argument-list form (§6.2) | `UnknownExpr` | native; a non-string mode `JL0101` |
| `[apply(…)]` as a member value | `[{ $apply: … }]` — the `[]` idiom (§6.3) | `unknown[]` | native |
| `apply(…)` as a bare member value | — | — | refused (`JL0102`): the engine fails at run time on the second child (`JQ2001`) |
| `op(name, operands)` | `{ [name]: operands }` — a registered operator (§13), spelled without judging it; one operand or a list | `UnknownExpr` | native; the engine's `JQ0002` decides; a name without `$` `JL0101`; outside any capture `JL0005` |

Three rules the table implies, spelled out:

- **A body's literal is a constructor, not a constant.** The chain folds a
  pure data tree into one `$const` (QUERY-PEN §3); a body spells it as
  the format's own object constructor — Appendix A.6's `{ "level":
  "unknown" }` — the same value, the published spelling. A string starting
  `$` is data only with the `$$` escape, so the pen writes it.
- **`root` and `path` need no declaration; a parameter needs one.** The
  engine binds the two on every dispatch (§8.2) and shadows any binding of
  the same name, so declaring them is the mistake and is refused. A
  parameter is `body(fn, { externals: ['rate'] })`, and `transform.externals`
  lists exactly the declared names the body used (§8.3).
- **The pen judges nothing the compiler judges.** A path that does not
  parse, an operator no registry answers, a `schema` match compiled without
  a hook, a self-applying loop: each is the engine's own error
  (`JT0003`, `JT0007`/`JQ0002`, `JT0006`, `JT2001`), unwrapped. The one
  refusal the pen adds is the one the engine would only raise at RUN time.

## 3. Worked examples

Every `js` fence exports exactly one stylesheet (or rule list), and the
`json` fence that follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. The seven fixtures of JSLT-FORMAT
Appendix A are all rebuilt through the pen and held byte-equal to the
format doc by `test/linq/jslt-pen.test.js`; three of them here.

JSLT-FORMAT A.3 — the book example, done right (the `[]` around the
`apply`):

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

A.4 — two modes, the argument-list form of `apply`:

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';

export const guide = stylesheet([
  rule('$', (v) => ({
    toc: [apply(v.sections.all(), 'toc')],
    body: [apply(v.sections.all(), 'render')],
  })),
  rule('$.sections[*]', (v) => ({ ref: v.id, label: v.heading }), { mode: 'toc' }),
  rule('$.sections[*]', (v) => ({ anchor: v.id, heading: v.heading, text: v.text }), { mode: 'render' }),
]);
```

```json
{ "$jslt": "0.1",
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

A.7 — a declared parameter and the two reserved externals, in the
bare-array form:

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

## 4. Refusals

The JSLT pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/jslt/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { stylesheet, rule, body, apply } from '@jarenjs/linq/jslt';
import type { Externals, Output, Stylesheet } from '@jarenjs/linq/jslt';
import type { Expr } from '@jarenjs/linq';

interface Chapter { heading: string }
interface Book { title: string; chapters: Chapter[] }

const chapter = rule({ schema: ChapterSchema }, (v) => ({ name: v.heading }));
//    ^ Rule<Infer<typeof ChapterSchema>, { name: string }> — the builder types v
const book = body((v: Expr<Book>) => ({ title: v.title, children: [apply(v.chapters.all())] }));
//    ^ BodyDocument<Book, { title: string; children: unknown[] }> — a dispatch is unknown
const priced = body(
  (v: Expr<Item>, x: Externals<{ rate: number }>) => ({ amount: v.price.mul(x.rate) }),
  { externals: ['rate'] });                        // x.limit does not compile

const sheet = stylesheet([rule(null, book), chapter]);
type Out = Output<typeof sheet>;                   // the FIRST rule's: { title: string; children: unknown[] }
const typed = stylesheet<Book, { title: string; children: { name: string }[] }>([rule(null, book), chapter]);
```

A stylesheet's output is its root rule's, and every `apply()` inside it
is `unknown` — a dispatch lands on whichever rule wins, which no type can
see. Where the author knows (a chapter always renders as `{ name }`), the
author says so with `stylesheet<In, Out>(…)`; the built-in rule's
rebuilds around an unmatched root are not typed at all.

## 6. What it cannot spell

Every construct the JSLT pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/jslt` builds to **18,722 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the body capture and, of the schema pen, only `brand.js` — no chain module and no engine.
