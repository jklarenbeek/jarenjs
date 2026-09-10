# The JTLT pen

> `./jtlt` — text templates with JSLT dispatch and query expressions. **Read it
> when** you want to author Markdown, XML or source text as portable JSON.

## 1. What it writes

The pen emits the public JTLT 0.1 envelope or its bare rule-array shorthand.
`.schema` is a deeply frozen JSON snapshot; serializing a builder writes exactly
that document. The published latest and draft-07 grammars came first and are
held to the existing renderer's complete fixture corpus.

The pen captures expressions but imports no query engine or JTLT renderer.
Pass its document to `compileJtltStylesheet` or `validateJtltTemplate` from
`@jarenjs/json/jtlt`. The [format](../../json/docs/JTLT-FORMAT.md) defines
escaping, dispatch, matching, output and the structural/compiler boundary.

## 2. The mapping table

| Method | Emits | Type | Status |
|---|---|---|---|
| `text(string)` | literal text; doubles a leading `$` | string segment | native |
| `query(expression, options?)` | raw or captured query string/object | interpolated segment | native |
| `raw(expression, options?)` | `{ $raw: expression }` | unescaped interpolation | native |
| `json(expression, options?)` | `{ $json: expression }` | JSON serialization | native |
| `apply(selector, mode?, options?)` | `$apply` selector or selector/mode list | dispatch splice | native |
| `rule(body?, options?)` | body and optional match/mode/priority | rule | native |
| `.body(segments)`, `.match(spec)`, `.mode(string)`, `.priority(number)` | replacement rule member | same rule | native |
| `stylesheet(rules?, options?)` | `$jtlt`, optional output, rules | envelope | native |
| `bare(rules?)` | public rule array | shorthand | native |
| `.rules(rules)`, `.rule(rule)` | replace or append rules | preserves envelope/shorthand | native |
| `.output(method)` | output method; wraps a bare list in an envelope | text or XML | native |
| `from(document)` | raw template with member order preserved | template | native |
| `.schema`, `.toJSON()` | frozen public JSON | document | native |

Expression callbacks receive the matched value and declared externals. Supply
`{ externals: ['rate'] }` as options to name a user parameter; `root` and `path`
are already bound by JTLT. Captured `.get()` paths use bracket notation, as in
other pens. Raw query documents retain the author's spelling. Nested arrays
remain nested segment lists, and literal containers belong inside `json()`.

## 3. Worked examples

```js
import { stylesheet, rule, apply, text } from '@jarenjs/linq/jtlt';
export const template = stylesheet([
  rule([text('# Books\n'), apply('$.books[*]')], { match: '$' }),
  rule(['- ', '$.title', '\n'], { match: '$.books[*]' }),
]);
```
```json
{"$jtlt":"0.1","rules":[{"match":"$","body":["# Books\n",{"$apply":"$.books[*]"}]},{"match":"$.books[*]","body":["- ","$.title","\n"]}]}
```

## 4. Refusals

| Code | Condition |
|---|---|
| `JL0101` | non-JSON input, unknown option, invalid list/text/output/mode argument, invalid or repeated external declaration, or a query segment that is neither a string nor query object |
| `JL0104` | a capture callback reads an undeclared external |

The shared capture also enforces the binder's expression rules. The JTLT compiler
checks match syntax, query arguments, hooks and the reserved priority band;
rendering checks input-dependent serialization and recursion. No type claims
that a template will render every possible input.

## 5. The types

`RuleBuilder` and `TemplateBuilder` are runtime classes. `RuleDocument`,
`TemplateDocument`, `Segment`, `Match`, `Output`, `QueryInput` and `QueryOptions`
are types. The output is text; no inferred schema for rendered content is claimed.
The external-name phantom catches misspellings without adding a runtime registry.

## 6. What it cannot spell

Functions and engine objects cannot enter documents. Callbacks are recorded into
query JSON before emission. The pen does not escape an entire finished document,
validate XML well-formedness, render text, or add a second dispatch language.

## 7. Cost

The isolated JTLT pen costs **<!--fact:bundle.jtlt-->16,803<!--/fact--> bytes**.
Its tree probe excludes target engines and the query chain.
