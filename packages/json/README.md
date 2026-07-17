# @jarenjs/json

The JSON addressing, query, and stylesheet standards of [Jaren](https://github.com/jklarenbeek/jarenjs), compiled: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), a JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) that passes the complete official compliance suite, the **Jaren JSON Query format** — a declarative query-and-transformation language with XQuery 3.1 semantics whose queries are themselves JSON documents — and **JSLT**, a recursive template-dispatch layer over that same stack. Everything follows the same architecture: parse and decide once, then run a specialized closure. No `eval`, no `new Function`, CSP-safe, zero runtime dependencies beyond the [`@jarenjs/core`](../core) foundation.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/json` | everything below |
| `@jarenjs/json/basic` | JSON, JSON Pointer and JSONPath string validation |
| `@jarenjs/json/pointer` | the JSON Pointer and Relative JSON Pointer compiler |
| `@jarenjs/json/path` | the JSONPath compiler |
| `@jarenjs/json/query` | the Jaren JSON Query engine |
| `@jarenjs/json/jslt` | the Jaren JSLT stylesheet compiler and dispatcher |
| `@jarenjs/json/xquery` | the XQuery text front-end for the query engine |

## JSON utilities

`@jarenjs/json` implements the JSON addressing standards next to each other:

| Standard | Functions |
|---|---|
| JSON validation | `isValidJSON`, `isValidJSONCheap` (a fast "definitely not JSON" pre-test) |
| JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) | `compileJSONPointer`, `parseJSONPointer`, `isValidJSONPointer`, `isValidJSONPointerUriFragment` |
| Relative JSON Pointer | `compileRelativeJSONPointer`, `parseRelativeJSONPointer`, `compileDataRef`, `isValidRelativeJSONPointer` |
| JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) | `compileJSONPath`, `queryJSONPath`, `parseJSONPath`, `isValidJSONPathStrict` |
| Jaren JSON Query | `compileJsonQuery`, `queryJson`, `JsonQueryCompileError`, `JsonQueryRuntimeError` |
| Jaren JSLT | `compileJsltStylesheet`, `transformJson`, `JsltCompileError`, `JsltRuntimeError` |

### JSON Pointer

Pointers address a single location. Like every other engine in this package they are compiled, not interpreted: `compileJSONPointer(pointer)` parses once (strict RFC 6901, throwing a `JSONPointerSyntaxError` with `source` and `position` on bad input), pre-decodes every member name, pre-parses every array index, and returns a getter specialized by segment count. Resolving allocates nothing and returns `JSONPOINTER_NOTHING` — the same sentinel as `JSONPATH_NOTHING` — when the pointer addresses no location:

```javascript
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json';

const doc = { limits: { min: 2, max: 9 }, value: 5 };

const getMin = compileJSONPointer('/limits/min');
getMin(doc); // 2
getMin({});  // JSONPOINTER_NOTHING
```

Relative pointers resolve from a location inside the document, given as an RFC 6901 pointer string. The relative part (level count, `#` form, trailing segments) compiles once; per call only the location varies. This is the hot path of the validator's `data`/`$data` keywords, where the ref is a schema constant known at schema-compile time:

```javascript
import { compileRelativeJSONPointer } from '@jarenjs/json';

const getLimits = compileRelativeJSONPointer('1/limits');
getLimits(doc, '/value'); // { min: 2, max: 9 }

const getName = compileRelativeJSONPointer('0#');
getName(doc, '/limits/min'); // 'min' (the member name of the location)
```

`compileDataRef(ref)` compiles the union the validator accepts — `''` for the data root, a leading `/` for an absolute pointer, a leading digit for a relative one — deciding the dispatch once at compile time. On a realistic `$data` workload the compiled resolvers are 4–19x faster than the interpretive resolver they replaced (`npm run benchmark:jsonpointer`).

## The JSONPath compiler

JSONPath selects *many* locations: a query like `$.store.book[?@.price < 10].title` describes a whole nodelist. The `path.js` module implements the complete RFC 9535 specification as a two-stage compiler, mirroring the philosophy of the schema validator: **parse and decide everything once, then run a specialized function**.

```javascript
import { compileJSONPath } from '@jarenjs/json';

const query = compileJSONPath('$.store.book[?@.price < 10].title');

query(data);   // ['Sayings of the Century', 'Moby Dick']
query(other);  // compiled once, reusable on any document
```

### Compiled query API

`compileJSONPath(source)` throws a `JSONPathSyntaxError` (with `source` and `position` properties) on invalid queries and returns a function with helpers attached:

| Call | Returns |
|---|---|
| `query(data)` / `query.values(data)` | array of matched values, in document order |
| `query.first(data)` | the first matched value, or `undefined` |
| `query.exists(data)` | `true` when at least one node matches |
| `query.nodes(data)` | array of `{ path, value }` pairs with normalized paths |
| `query.paths(data)` | array of normalized paths (RFC 9535 §2.7), e.g. `$['store']['book'][0]['title']` |
| `query.source` | the original query string |
| `query.ast` | the parsed query AST (deeply frozen) |

For one-off queries there is `queryJSONPath(source, data)`, which keeps a cache of compiled queries (512 entries, FIFO), and `isValidJSONPathStrict(source)` for a boolean grammar check — this is what the `json-path` format in [`@jarenjs/formats`](../formats) uses.

### Supported syntax

Everything in RFC 9535, with no extensions and no omissions:

| Construct | Example |
|---|---|
| root / current node | `$` — `@` inside filter expressions |
| name selector | `$.store`, `$['two words']`, `$["é"]` |
| wildcard | `$.store.*`, `$[*]` |
| index (negative from end) | `$[0]`, `$[-1]` |
| array slice | `$[1:3]`, `$[5:]`, `$[::2]`, `$[::-1]` |
| child segment, multi-selector | `$[0, 3]`, `$['a', 'b', *]` |
| descendant segment | `$..author`, `$..[0]`, `$..*` |
| filter selector | `$[?@.price < 10]`, `$[?(@.a && !@.b)]` |
| comparisons | `== != < <= > >=` with `Nothing`-aware semantics |
| logical operators | `&&`, `\|\|`, `!`, parentheses |
| function extensions | `length()`, `count()`, `match()`, `search()`, `value()` |

The parser is strict about everything the RFC is strict about: leading zeros, `-0`, integer bounds (±2⁵³−1), whitespace placement, lone surrogates, string escape rules, and the *well-typedness* of function expressions — `$[?length(@)]` (a value used as a test) and `$[?@[*] == 1]` (a non-singular query in a comparison) are compile-time errors, as the spec demands.

### Filter semantics worth knowing

- **`Nothing` is not `null`.** A missing member and a member whose value is `null` are different things: `$[?@.a == null]` only matches nodes where `a` exists *and* is `null`. Two missing values compare equal (`$[?@.absent1 == @.absent2]` is `true`). The sentinel is exported as `JSONPATH_NOTHING` for advanced integrations.
- **`==` is deep structural equality**; numbers compare mathematically (`1 == 1.0`).
- **`<` orders numbers and strings only**, and strings are ordered by Unicode scalar value (code points), not by UTF-16 code units.
- **`match()`/`search()` take I-Regexp** ([RFC 9485](https://www.rfc-editor.org/rfc/rfc9485.html)) patterns, validated against the complete I-Regexp grammar — lookarounds, backreferences, lazy quantifiers and multi-character escapes like `\d` make the function yield `false`, as the spec requires. Literal patterns are compiled to a `RegExp` once at query-compile time; dynamic patterns get a per-callsite cache. Unescaped `^`/`$` behave as anchors, matching the RFC's own ECMAScript translation and the official compliance test suite.

### Conformance and performance

Conformance: **all 703 tests** of the official [JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite) pass, including the normalized-path assertions (the suite is a git submodule at `benchmark/jsonpath-suite/`).

Measured with `node benchmark/jsonpath.js --profile --scale` (2026-07-16, Node v24.14.0, 1000-item synthetic document, vs [json-p3](https://www.npmjs.com/package/json-p3)):

| Query shape | Jaren | vs json-p3 |
|---|---|---|
| singular `$.items[42].name` | 191 ns (~5M queries/s) | 4.0x |
| wildcard `$.items[*].id` | 26.6 µs | 12.9x |
| slice `$.items[100:200].id` | 4.4 µs | 8.0x |
| filter `$.items[?@.price < 10].name` | 31.6 µs | 9.9x |
| regexp filter `$.items[?match(@.name, "item-1.*")].id` | 37.1 µs | 14.2x |
| descendant `$..value` | 187.6 µs | 86.0x |
| mean over all 456 CTS queries | 133 ns | 20.2x |
| compile | ~2.7 µs per query | — |

## The Jaren JSON Query language

JSONPath answers "which nodes?"; it cannot join, group, aggregate or reshape. The Jaren JSON Query format is the next layer: a query-and-transformation language with the semantics of **XQuery 3.1** — sequences, FLWOR, effective boolean value, existential comparisons — and a surface syntax that is **JSON itself**, the way an XSLT stylesheet is an XML document. Navigation leaves are RFC 9535 JSONPath strings.

The language contract is the specification in [docs/QUERY-FORMAT.md](./docs/QUERY-FORMAT.md); this section is the tour.

```javascript
import { compileJsonQuery } from '@jarenjs/json';

const query = compileJsonQuery({
  $for: { b: '$.store.book[*]' },
  $where: { $lt: ['$b.price', 10] },
  $orderby: '$b.price',
  $return: { title: '$b.title', price: '$b.price' },
});

query(data);
// [ { title: 'Sayings of the Century', price: 8.95 },
//   { title: 'Moby Dick', price: 8.99 } ]
```

### Three rules

Every JSON value is an expression under three rules — there is no rule four:

1. **Objects** partition by their keys. All keys `$`-prefixed → an **operator phrase** from a closed vocabulary (`{"$lt": [a, b]}`, the FLWOR phrase, ...). No key `$`-prefixed → a **map constructor**: keys are literal member names, values are evaluated. Mixed → compile error.
2. **Strings** starting with `$` are **queries**: a complete RFC 9535 JSONPath (`"$.store.book[*]"`), or a variable-rooted path (`"$b.title"`). `"$$x"` escapes to the literal string `"$x"`; any other string is itself.
3. **Scalars** (`42`, `true`, `null`) are literals; **arrays** are array constructors whose element sequences flatten, XQuery-style.

Escape hatches: `{"$const": v}` quotes any value verbatim; `{"$map": [[keyExpr, valExpr], ...]}` constructs objects with computed keys. That is the entire encoding.

### The degenerate query is a JSONPath string

A bare JSONPath string is a complete query document, so the on-ramp from "I use JSONPath" to "I need a join" is a one-liner at each step:

```javascript
import { queryJson } from '@jarenjs/json';

queryJson('$.store.book[?@.price < 10].title', data);
// [ 'Sayings of the Century', 'Moby Dick' ]
```

### Joins

Cross-variable predicates — the thing path filters fundamentally cannot express — are a `$where` away (this is the spec's example A.3):

```javascript
queryJson({
  $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
  $where: { $eq: ['$b.isbn', '$r.isbn'] },
  $orderby: '$b.price',
  $return: { title: '$b.title', stars: '$r.stars' },
}, data);
// [ { title: 'Moby Dick', stars: 4 },
//   { title: 'The Lord of the Rings', stars: 5 } ]
```

Books without an `isbn` drop out on their own: `$b.isbn` evaluates to the empty sequence and an existential `$eq` over an empty sequence is `false`.

### Grouping

XQuery 3.1 `group by` semantics: grouping keys become singleton variables, every other variable rebinds to the sequence of its values across the group (spec example A.4):

```javascript
queryJson({
  $for: { b: '$.store.book[*]' },
  $groupby: { genre: '$b.category' },
  $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
}, data);
// [ { genre: 'reference', count: 1, avg: 8.95 },
//   { genre: 'fiction', count: 3, avg: 14.99 } ]
```

### The FLWOR phrase

One phrase carries the whole pipeline. Clauses apply in **fixed semantic order regardless of JSON key order** (JSON key order is not interoperable, so it never carries meaning here); exotic interleavings nest phrases:

| Key | Value | Presence |
|---|---|---|
| `$for` | iteration bindings `{ name: source, ... }`, positional form `{ "$in": expr, "$at": "i" }` | at least one of `$for`/`$let` |
| `$let` | sequence bindings (no iteration) | at least one of `$for`/`$let` |
| `$where` | tuple filter (effective boolean value) | optional |
| `$groupby` | grouping-key bindings | optional |
| `$orderby` | key spec or list: `{ "$key": e, "$dir": "desc", "$empty": "greatest" }` | optional |
| `$count` | variable name for the 0-based tuple index | optional |
| `$return` | the result expression per surviving tuple | required |

Semantic order: `$for → $let → $where → $groupby → $orderby → $count → $return`. Quantifiers are their own two-key phrases: `{"$some": bindings, "$satisfies": expr}` / `{"$every": ...}`, with short-circuit evaluation.

The operator library (58 operators: comparisons, IEEE-double arithmetic, logic, strings with I-Regexp `$match`/`$search`/`$replace`, aggregates, sequence tools like `$distinct`/`$subsequence`/`$range`, type predicates and casts, `$coalesce`) is cataloged in [QUERY-FORMAT.md §8](./docs/QUERY-FORMAT.md#8-operators).

### External parameters

A variable no phrase binds is an **external**: use is the declaration. The compiled query exposes the collected names and takes bindings at call time:

```javascript
const cheaper = compileJsonQuery({
  $for: { b: '$.store.book[*]' },
  $where: { $le: ['$b.price', '$maxPrice'] },
  $return: '$b.title',
});

cheaper.externals;                    // ['maxPrice']
cheaper(data, { maxPrice: 9 });       // [ 'Sayings of the Century', 'Moby Dick' ]
```

The compiled function also carries `query.first(data, externals)`, `query.exists(data, externals)` and `query.doc` (a frozen copy of the query document). Results come back as plain JSON: `undefined` for the empty sequence, the item for a singleton, an array for anything longer. `queryJson(doc, data, externals)` is the cached one-call form.

### XQuery semantics, stated deviations

Wherever this format does not explicitly deviate, **XQuery 3.1 defines the behavior** — sequences flatten, comparisons are existential, `$where` takes the effective boolean value, `$groupby` is XQuery `group by`. The deviations are few, numbered, and normative ([QUERY-FORMAT.md §11](./docs/QUERY-FORMAT.md#11-deviations-from-xquery-31)): D1 all numbers are IEEE doubles, D2 `$eq` is deep structural JSON equality, D3 the EBV of an object/array is `true`, D4 `$for` unpacks array items one level, D5 regexes are I-Regexp not XSD, D6 all positions are 0-based, D7 fixed clause order.

> **The two filter dialects.** A filter inside a path string (`"$.a[?@.b == @.c]"`) keeps **RFC 9535 semantics**, where two missing members compare equal (`Nothing == Nothing` is true). The same comparison at query level (`{"$eq": ["$x.b", "$x.c"]}`) keeps **XQuery semantics**, where a comparison over empty sequences is `false`. Both dialects are conformant to their own standard; the spec documents the split in [§5.2](./docs/QUERY-FORMAT.md#52-the-two-filter-dialects) and query variables are deliberately not visible inside path filters — a predicate that needs two variables belongs in `$where`.

### Errors carry a docPath

Compile errors (`JsonQueryCompileError`, codes `JQ0xxx`) and runtime errors (`JsonQueryRuntimeError`, codes `JQ2xxx`) both carry a stable `code` and a `docPath` — an RFC 6901 JSON Pointer **into the query document** locating the offending construct (e.g. `/$where/$eq/1`). Unknown operators come with a "did you mean" suggestion.

### The schema twins

The complete structural grammar of the language is published as JSON Schema, twice:

- [`schemas/jaren-query.schema.json`](./schemas/jaren-query.schema.json) — canonical, draft 2020-12;
- [`schemas/jaren-query.draft-07.schema.json`](./schemas/jaren-query.draft-07.schema.json) — a mechanically derived draft-07 twin.

Both exist because the schema is authored in a draft-neutral keyword subset (no `$ref` siblings, no `unevaluated*`, no tuples), so ecosystems pinned to draft-07 — several structured-output stacks among them — get an identical grammar for one `$defs`→`definitions` rename. Every fixture in the test suite validates under both drafts.

## Generating queries with LLMs

A query language whose entire grammar is one JSON Schema is a natural fit for **constrained decoding** — the structured-output mode of every major LLM API. Hand the schema to the provider and the model cannot emit an unknown operator, a three-argument `$eq`, or a mixed `$`/plain-key object; what remains is validated and compiled in two lines, and every failure carries a `docPath` you can feed back to the model for repair:

```javascript
import { readFile } from 'node:fs/promises';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsonQuery } from '@jarenjs/json';

const schema = JSON.parse(await readFile('packages/json/schemas/jaren-query.schema.json', 'utf8'));

const text = await generate(prompt, schema); // your provider's structured-output call

const isQueryDoc = new JarenValidator().compile(schema);
const doc = JSON.parse(text);
if (!isQueryDoc(doc)) throw new Error('model escaped the schema');
const query = compileJsonQuery(doc);         // JsonQueryCompileError.docPath on the residue
query(data);                                 // JsonQueryRuntimeError.docPath at runtime
```

The validate step is not redundant: provider structured-output implementations support varying JSON Schema subsets regardless of the draft they declare (`patternProperties` and `propertyNames`, which the schema uses for binding names and map constructors, are not universally enforced). Validating locally catches whatever the provider's subset let through. A simplified "LLM profile" of the schema — trading some precision for the lowest-common-denominator subset — is a possible follow-up; it does not exist today.

Query documents are plain JSON, so they travel through the rest of an LLM toolchain as-is: function-call arguments, retrieval filters, audit logs, replay.

## The XQuery text front-end

`@jarenjs/json/xquery` ships `parseXQuery(text)`, a parser for a defined subset of XQuery 3.1 *text* syntax that emits Jaren JSON Query documents — a human authoring syntax and the compatibility bridge that makes W3C QT3 test material runnable against the engine (see `benchmark/qt3-runner.js`, `npm run benchmark:qt3`). It is not a second engine: the output is always a query document, and where the two languages disagree, the JSON format wins. Subset boundaries, the 1-based/0-based adjustment rules and the function mapping table are documented in [docs/XQUERY-FRONTEND.md](./docs/XQUERY-FRONTEND.md).

```javascript
import { compileXQuery } from '@jarenjs/json/xquery';

const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');
q(null, { doc: data }); // [ 'Sayings of the Century', 'Moby Dick' ]
```

## Query benchmark

`npm run benchmark:jsonquery` runs the scenario matrix against [fontoxpath](https://www.npmjs.com/package/fontoxpath) (a real XQuery 3.1 engine in JavaScript — the closest honest comparison) and [jsonata](https://www.npmjs.com/package/jsonata) (the popular practical alternative), asserting result equivalence on every document before timing anything. Each engine runs the same scenario written idiomatically in its own language (`benchmark/adaptors/jsonquery/`).

Measured with `npm run benchmark:jsonquery:profile` (2026-07-16, Node v24.14.0; ratios are that engine's time over Jaren's):

| Scenario | Jaren | fontoxpath 3.34 | jsonata 2.2 |
|---|---|---|---|
| **4-book bookstore** | | | |
| singular access `$b.title` | 377 ns (2.7M/s) | 6.9 µs (18x) | 4.8 µs (13x) |
| filter + project (spec A.2) | 1.8 µs (551k/s) | 33.6 µs (18x) | 24.6 µs (14x) |
| join (spec A.3) | 3.3 µs (305k/s) | 69.8 µs (21x) | 82.8 µs (25x) |
| group + aggregate (spec A.4) | 2.7 µs (371k/s) | n/a | 41.0 µs (15x) |
| deep reshape | 2.5 µs (401k/s) | 132.0 µs (53x) | 60.7 µs (24x) |
| **10,000-book bookstore** | | | |
| singular access | 306 ns (3.3M/s) | 14.9 µs (49x) | 4.0 µs (13x) |
| filter + project | 1.5 ms | 305.5 ms (210x) | 62.9 ms (43x) |
| join (measured at 1,000 books) | 29.5 ms | 1.33 s (45x) | 1.55 s (53x) |
| group + aggregate | 2.3 ms | n/a | 37.0 ms (16x) |
| deep reshape | 3.7 ms | 357.1 ms (98x) | 110.4 ms (30x) |
| **compile, µs per query** | 23.1 µs | 483.5 µs (21x) | 65.6 µs (2.8x) |

Honest caveats — what each competitor is optimized for:

- **fontoxpath** is an XML-first XPath/XQuery engine; JSON rides on XDM maps and arrays. The benchmark pre-converts each document to XDM *once, outside the timed loop* (per-call conversion would cost ~12 ms alone at 10k books), and fontoxpath has no public compile-only API, so its compile number is fresh-source evaluation minus cached re-evaluation. It does not implement `group by`. Its engineering effort goes into DOM navigation, buckets and XQuery Update — not JSON throughput.
- **jsonata** is a tree-walking interpreter whose `evaluate()` is async since 2.x; its numbers include that promise overhead because its API imposes it. It is optimized for expressiveness and embeddability, not raw speed.
- **Jaren**'s compile number includes `JSON.parse` of the query text, since the competitors parse text too.
- The join is a naive O(books × ratings) nested loop in **all three** engines (Jaren's hash-join optimizer is roadmap); it is measured at 1,000 books.

## JSLT — declarative JSON transformation

JSLT adds XSLT-style recursive template dispatch without adding another data language: **match = JSONPath, type = JSON Schema, produce = Jaren queries**. A rule can select by position, by shape, or by both; a schema is therefore a pattern, compiled through the same type-test hook as `$valid`/`$assert`/`$as`. The normative contract is [JSLT-FORMAT.md](./docs/JSLT-FORMAT.md).

The small-but-important use case is a surgical override. Unmatched containers recurse into their children and return the original object when every child is unchanged, so unrelated subtrees remain shared:

```javascript
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const applyVat = compileJsltStylesheet([
  { match: '$..price', body: { $mul: ['$', 1.21] } },
]);

const input = {
  catalog: { books: [{ title: 'A', price: 10 }] },
  meta: { publisher: 'N' },
};
const output = applyVat(input);
// output.catalog.books[0].price === 12.1
// output.meta === input.meta
```

Modes walk the same source through independent rule sets. Here the root applies the section list once as a table of contents and once as rendered body content:

```javascript
const renderGuide = compileJsltStylesheet({
  $jslt: '0.1',
  rules: [
    {
      match: '$',
      body: {
        toc: [{ $apply: ['$.sections[*]', 'toc'] }],
        body: [{ $apply: ['$.sections[*]', 'render'] }],
      },
    },
    {
      mode: 'toc',
      match: '$.sections[*]',
      body: { ref: '$.id', label: '$.heading' },
    },
    {
      mode: 'render',
      match: '$.sections[*]',
      body: { anchor: '$.id', text: '$.text' },
    },
  ],
});

renderGuide({
  sections: [{ id: 'intro', heading: 'Introduction', text: 'Start here.' }],
});
// { toc: [{ ref: 'intro', label: 'Introduction' }],
//   body: [{ anchor: 'intro', text: 'Start here.' }] }
```

The brackets around each `$apply` are deliberate: an object member holds one value, while `$apply` returns a sequence. `children: [{ $apply: '$.children[*]' }]` uses the query array-constructor rule to collect that sequence into an array; the bare member form fails when two or more children are produced.

The default unmatched disposition is `share`: unchanged containers retain `===` identity with the input. Use envelope-level `"unmatched": "fresh"` when the caller needs an independently mutable tree; use `"error"` for exhaustive dispatch. Rule-body outputs and path results still follow query-engine sharing semantics.

Shape matches and schema operators need the validator bridge at application wiring time—the JSON package itself remains validator-independent:

```javascript
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const annotateBooks = compileJsltStylesheet([
  {
    match: {
      schema: { type: 'object', required: ['title', 'author'] },
    },
    body: {
      title: '$.title',
      byline: { $concat: ['$.title', ' by ', '$.author'] },
    },
  },
], { compileTypeTest: createTypeTestCompiler() });
```

The complete stylesheet grammar is published for validators and LLM constrained decoding as [`jaren-jslt.schema.json`](./schemas/jaren-jslt.schema.json) (draft 2020-12) and its mechanically derived [`jaren-jslt.draft-07.schema.json`](./schemas/jaren-jslt.draft-07.schema.json) twin. Rule-body definitions are mechanically copied from the query artifact and extended only with `$apply`, so the query vocabulary stays closed. Provider structured-output implementations still support uneven schema subsets; validate the generated document locally before compiling it, as described in [JSLT-FORMAT Appendix B](./docs/JSLT-FORMAT.md#appendix-b-llm-structured-output-non-normative).

### JSLT benchmark

`npm run benchmark:jslt` asserts result equivalence before timing Jaren against a hand-written recursive JavaScript transform and JSONata's transform operator. Measured with `npm run benchmark:jslt:profile` (2026-07-16, Node v24.14.0; competitor ratios are competitor time over Jaren):

| Scenario | Jaren JSLT | native JS | jsonata 2.2 |
|---|---:|---:|---:|
| **4-book bookstore** | | | |
| identity (`share`) | 83 ns | 1.83 µs (22.0x) | 14.60 µs (176x) |
| surgical prices | 10.89 µs | 1.12 µs (0.10x) | 89.61 µs (8.2x) |
| reshape + modes | 8.14 µs | 381 ns (0.047x) | n/a |
| fresh schema annotation | 3.46 µs | 928 ns (0.27x) | 135.22 µs (39.1x) |
| **10,000-book bookstore** | | | |
| identity (`share`) | 27 ns | 3.24 ms (119,274x) | 13.20 ms (485,954x) |
| surgical prices | 27.78 ms | 1.96 ms (0.071x) | 146.12 ms (5.3x) |
| reshape + modes | 18.27 ms | 131.08 µs (0.007x) | n/a |
| fresh schema annotation | 5.75 ms | 1.70 ms (0.30x) | 251.27 ms (43.7x) |
| **document-independent** | | | |
| compile, per stylesheet | 35.63 µs | n/a | 59.03 µs (1.7x) |

The identity row is the sharing fast path: Jaren returns the input reference in O(1), while native and JSONata deep-copy. On actual transformations, hand-written JavaScript is 3.3–139x faster because it is bespoke code with no matcher, rank table, mode, schema, or error machinery—the honest cost of the abstraction. Jaren is 5–44x faster than JSONata where the transform operator can express the scenario; reshape+modes is `n/a`, not silently replaced by a different JSONata feature. JSONata 2.x timings include its required promise overhead and transform-copy cost. Scaled prices are rounded to cents because JSONata's copy normalizes long binary decimal tails and these scenarios do not sort. fontoxpath is excluded because it has XPath/XQuery but no XSLT dispatcher; Saxon-JS is excluded as a heavyweight SEF/XSLT toolchain for this benchmark workspace.

## Roadmap

Ideas we consider interesting or necessary for this package, roughly in order of appetite:

- [x] **JSON Schema as the query type system** — the `$valid`/`$assert` operators and the `$as` FLWOR clause embed JSON Schema literals in query documents ([QUERY-FORMAT §8.11](./docs/QUERY-FORMAT.md)), compiled through the dependency-free `compileTypeTest` hook; [`@jarenjs/validate/query`](../validate) supplies the reference hook (`createTypeTestCompiler`).
- [x] **Queries inside schemas — the `$query` keyword** — the inverse arrow of the entry above: [`@jarenjs/validate`](../validate/README.md) gained a `$query` extension keyword whose value is a query document, compiled once at schema compile time and asserted by effective boolean value per validation (compiled queries expose `query.ebv` beside `first`/`exists` for exactly this). Cross-field arithmetic, ordering and quantification land in JSON Schema through the engine that already exists.
- [x] **JSLT template layer** — the XSLT-derivative stylesheet language on top of the query engine: [`@jarenjs/json/jslt`](./docs/JSLT-FORMAT.md) compiles positional JSONPath matches, JSON Schema shape matches, ranked modes, `$apply`, and the `share`/`fresh`/`error` built-in rules.
- [ ] **Standalone `@jarenjs/jslt` package** — publish the stylesheet layer as its own package only when the query-engine internals it needs have a deliberate public boundary; today the module stays colocated to avoid exposing compiler internals.
- [ ] **Forms computed views through JSLT** — generalize `x-form.computed` from one query per field into schema-dispatched view-model stylesheets, while keeping forms validator-independent.
- [ ] **JSLT matcher optimizer** — replace per-rule path pre-passes with a single multi-pattern walk, specialize location tracking by reachable modes, and use input-schema knowledge to prune impossible shape rules.
- [ ] **Filter optimizer / hash joins** — hoist `$`-absolute comparables out of filter loops, fuse adjacent singular segments, and turn `$where` equijoins into hash joins instead of nested loops (see the benchmark's join row).
- [ ] **Write operations** — `set`/`insert`/`remove` at a pointer, a normalized path, or every node a JSONPath query selects, with a copy-on-write mode.
- [ ] **JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396)** — apply and structural diff, built on compiled pointers; a diff that emits JSON Patch doubles as a change feed for [`@jarenjs/forms`](../forms).
- [x] **Compiled JSON Pointers** — `pointer.js` got the `path.js` treatment: `compileJSONPointer`/`compileRelativeJSONPointer`/`compileDataRef` return specialized zero-allocation getters over the shared `NOTHING` sentinel, and the validator's `data`/`$data` keywords compile their refs at schema-compile time.
- [ ] **`$allowing-empty` and window clauses** — the two FLWOR constructs v0.1 leaves out (outer-join-style iteration and `tumbling`/`sliding` windows).
- [ ] **Higher-order operators** — user-supplied functions for map/filter/fold shapes; requires a function-value story the JSON encoding deliberately does not have yet.
- [ ] **XQuery front-end: `xs:*` constructor casts and more `fn:*` mappings** — the QT3 scorecard attributes the bulk of its `unsupported-syntax` bucket to these; a handful of numeric casts moves thousands of cases into the measurable buckets. Lazy `$range` evaluation belongs to the same batch (the eager materialization defeats the JQ2007 resource guard).
- [ ] **Custom JSONPath function extensions** — a registry per RFC 9535 §2.4 with declared parameter/return types, so user functions get the same compile-time well-typedness checks as the built-ins.
- [ ] **Lazy iteration** — `query.iterate(data)` as a generator yielding nodes on demand, plus early-exit `first()`/`exists()` for non-singular JSONPath queries.
- [ ] **Normalized path ↔ JSON Pointer bridge** — convert singular queries and normalized paths to RFC 6901 pointers and back, so the addressing standards compose.
- [ ] **Canonical JSON (RFC 8785 / JCS)** — deterministic serialization for hashing and signing; `stableKeyString` in the query runtime is a starting point.
- [ ] **Optional codegen backend** — compile hot queries to source via `new Function` where CSP allows, reusing the same AST and semantics; the closure compiler stays the default.
- [ ] **Date/time operators** — `@jarenjs/core/dates` exists as the foundation; the operator registry makes the addition mechanical.

## Development

Unit tests live in `test/json/` at the repository root (`npm run test:json`); the JSONPath tests are built from the RFC's own examples, the query and JSLT tests from their normative fixtures (each schema corpus validates against both artifact drafts), and every example in this README runs in `test/json/readme-examples.test.js`. This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document. Benchmarks: `benchmark/jsonpath.js` (JSONPath compliance + performance), `benchmark/jsonpointer.js` (compiled pointers vs the interpretive resolver and the `jsonpointer` npm package), `benchmark/jsonquery.js` (query engine vs fontoxpath/jsonata), `benchmark/jslt.js` (stylesheet engine vs native JS/JSONata), `benchmark/qt3-runner.js` (W3C QT3 scorecard through the XQuery front-end). See the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for the validator-wide picture.
