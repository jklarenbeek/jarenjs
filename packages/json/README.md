# @jarenjs/json

The JSON addressing, query, and stylesheet standards of [Jaren](https://github.com/jklarenbeek/jarenjs), compiled: JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)), a JSONPath engine ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) that passes the complete official compliance suite, the **Jaren JSON Query format** — a declarative query-and-transformation language with XQuery 3.1 semantics whose queries are themselves JSON documents — and **JSLT**, a recursive template-dispatch layer over that same stack. Everything follows the same architecture: parse and decide once, then run a specialized closure. No `eval`, no `new Function`, CSP-safe, zero runtime dependencies beyond the [`@jarenjs/core`](../core) foundation.

None of it depends on JSON Schema: every module can be used standalone in any JavaScript project.

## Modules

| Import | Contents |
|---|---|
| `@jarenjs/json` | everything below |
| `@jarenjs/json/basic` | JSON, JSON Pointer and JSONPath string validation |
| `@jarenjs/json/pointer` | the JSON Pointer and Relative JSON Pointer compiler |
| `@jarenjs/json/patch` | JSON Patch and JSON Merge Patch: compiled apply + structural diff |
| `@jarenjs/json/path` | the JSONPath compiler |
| `@jarenjs/json/query` | the Jaren JSON Query engine |
| `@jarenjs/json/jslt` | the Jaren JSLT stylesheet compiler and dispatcher |
| `@jarenjs/json/jtlt` | the Jaren JTLT template compiler — JSON to text/XML |
| `@jarenjs/json/xquery` | the XQuery text front-end for the query engine |

## JSON utilities

`@jarenjs/json` implements the JSON addressing standards next to each other:

| Standard | Functions |
|---|---|
| JSON validation | `isValidJSON`, `isValidJSONCheap` (a fast "definitely not JSON" pre-test) |
| JSON Pointer ([RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) | `compileJSONPointer`, `parseJSONPointer`, `isValidJSONPointer`, `isValidJSONPointerUriFragment` |
| Relative JSON Pointer | `compileRelativeJSONPointer`, `parseRelativeJSONPointer`, `compileDataRef`, `isValidRelativeJSONPointer` |
| JSON Patch ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) | `compileJSONPatch`, `applyJSONPatch`, `createJSONPatch`, `isValidJSONPatch`, `JsonPatchCompileError`, `JsonPatchRuntimeError` |
| JSON Merge Patch ([RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396)) | `compileMergePatch`, `applyMergePatch`, `createMergePatch` |
| JSONPath ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535.html)) | `compileJSONPath`, `queryJSONPath`, `parseJSONPath`, `isValidJSONPathStrict` |
| Jaren JSON Query | `compileJsonQuery`, `queryJson`, `JsonQueryCompileError`, `JsonQueryRuntimeError` |
| Jaren JSLT | `compileJsltStylesheet`, `transformJson`, `JsltCompileError`, `JsltRuntimeError` |
| Jaren JTLT | `compileJtltStylesheet`, `renderText`, `JtltCompileError`, `JtltRuntimeError` |

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

`compileDataRef(ref)` compiles the union the validator accepts — `''` for the data root, a leading `/` for an absolute pointer, a leading digit for a relative one — deciding the dispatch once at compile time. On a realistic `$data` workload the compiled resolvers are 4–20x faster than the interpretive resolver they replaced, and beat the `jsonpointer` npm package on every scenario (`npm run benchmark:jsonpointer`, 2026-07-17: absolute pointers 12–16x, relative pointers 4–16x, `compileDataRef` dispatch 7–20x).

The write-side encode is there too: `encodeJSONPointerSegment(key)` escapes one reference token (`~` → `~0`, `/` → `~1`) and `formatJSONPointer(segments)` is the inverse of `parseJSONPointer`.

### JSON Patch and JSON Merge Patch

Partial updates follow the same compile-once discipline. `compileJSONPatch(patch)` validates an [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) patch document once (`JsonPatchCompileError`, `JP0xxx`, with a `docPath` pointing into the *patch* document), pre-parses every `path`/`from` through the RFC 6901 parser and specializes one closure per operation. Applying is **copy-on-write**: the input document is never mutated, untouched subtrees are shared by reference with the result, and application is atomic — a failing operation (`JsonPatchRuntimeError`, `JP2xxx`, carrying both the patch `docPath` and the target `dataPath`) leaves nothing behind, exactly as RFC 6902 section 5 requires. The engine passes the complete official [json-patch-tests](https://github.com/json-patch/json-patch-tests) suite:

```javascript
import { compileJSONPatch, applyJSONPatch, createJSONPatch } from '@jarenjs/json';

// compile once, apply many times (hot path)
const apply = compileJSONPatch([
  { op: 'test', path: '/version', value: 5 },
  { op: 'replace', path: '/user/name', value: 'Bob' },
  { op: 'add', path: '/user/tags/-', value: 'admin' },
]);
const next = apply(doc); // doc is untouched; unchanged subtrees are shared

// one-shot
applyJSONPatch(doc, patch);

// structural diff: a change feed for @jarenjs/forms and friends
applyJSONPatch(a, createJSONPatch(a, b)); // deep-equals b
```

Because an application only clones the spine it writes through — and clones it once, no matter how many operations touch the same region — the compiled applier beats the usual clone-and-interpret shape by 5–170x depending on document size (`npm run benchmark:jsonpatch`). Two options tune the copy discipline, mirroring JSLT's `share`/`fresh` dispositions: `values: 'fresh'` deep-copies inserted operation values per application (the default `'share'` inserts them by reference, so treat results as immutable), and `mutate: true` patches in place for the last bit of speed at the cost of atomicity.

[RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396) merge patches ride the same machinery: `compileMergePatch(patch)` pre-splits the patch into remove/set/merge plans, and applying is identity-preserving — a merge that changes nothing returns the target by reference, so it doubles as a cheap change detector. `createMergePatch(source, target)` emits the merge patch (with the RFC's documented `null`-member representability caveat), and `applyMergePatch(doc, patch)` is the one-shot form.

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

Measured with `node benchmark/jsonpath.js --profile --scale -i 3000` (2026-07-17, Node v24.14.0, 1000-item synthetic document, vs [json-p3](https://www.npmjs.com/package/json-p3) 2.2.2):

| Query shape | Jaren | vs json-p3 |
|---|---|---|
| singular `$.items[42].name` | 189 ns (~5M queries/s) | 4.9x |
| wildcard `$.items[*].id` | 31.2 µs | 12.1x |
| slice `$.items[100:200].id` | 4.4 µs | 9.5x |
| filter `$.items[?@.price < 10].name` | 38.9 µs | 8.7x |
| regexp filter `$.items[?match(@.name, "item-1.*")].id` | 38.8 µs | 14.3x |
| descendant `$..value` | 210.0 µs | 81.8x |
| mean over all 456 CTS queries | 151 ns | 18.7x |
| compile | ~2.4 µs per query | — |

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

Measured with `npm run benchmark:jsonquery:profile` (2026-07-17, Node v24.14.0; ratios are that engine's time over Jaren's):

| Scenario | Jaren | fontoxpath 3.34 | jsonata 2.2 |
|---|---|---|---|
| **4-book bookstore** | | | |
| singular access `$b.title` | 382 ns (2.6M/s) | 7.3 µs (19x) | 5.7 µs (15x) |
| filter + project (spec A.2) | 1.9 µs (527k/s) | 36.1 µs (19x) | 27.0 µs (14x) |
| join (spec A.3) | 5.6 µs (178k/s) | 77.5 µs (14x) | 111.7 µs (20x) |
| group + aggregate (spec A.4) | 4.3 µs (234k/s) | n/a | 47.7 µs (11x) |
| deep reshape | 2.6 µs (393k/s) | 190.5 µs (75x) | 82.9 µs (33x) |
| **10,000-book bookstore** | | | |
| singular access | 299 ns (3.3M/s) | 16.6 µs (56x) | 4.2 µs (14x) |
| filter + project | 1.5 ms | 328.3 ms (215x) | 68.0 ms (45x) |
| join (measured at 1,000 books) | 27.8 ms | 1.57 s (57x) | 1.75 s (63x) |
| group + aggregate | 2.5 ms | n/a | 39.9 ms (16x) |
| deep reshape | 3.6 ms | 422.0 ms (118x) | 119.0 ms (33x) |
| **compile, µs per query** | 24.3 µs | 460.7 µs (19x) | 66.1 µs (2.7x) |

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

`npm run benchmark:jslt` asserts result equivalence before timing Jaren against a hand-written recursive JavaScript transform and JSONata's transform operator. Measured with `npm run benchmark:jslt:profile` (2026-07-17, Node v24.14.0; competitor ratios are competitor time over Jaren):

| Scenario | Jaren JSLT | native JS | jsonata 2.2 |
|---|---:|---:|---:|
| **4-book bookstore** | | | |
| identity (`share`) | 81 ns | 2.04 µs (25.3x) | 14.60 µs (180x) |
| surgical prices | 9.15 µs | 1.09 µs (0.12x) | 90.13 µs (9.8x) |
| reshape + modes | 8.70 µs | 431 ns (0.050x) | n/a |
| fresh schema annotation | 3.50 µs | 911 ns (0.26x) | 136.92 µs (39.1x) |
| **10,000-book bookstore** | | | |
| identity (`share`) | 24 ns | 3.41 ms (143,482x) | 13.52 ms (569,663x) |
| surgical prices | 23.17 ms | 2.00 ms (0.086x) | 152.48 ms (6.6x) |
| reshape + modes | 20.01 ms | 137.36 µs (0.007x) | n/a |
| fresh schema annotation | 6.40 ms | 1.73 ms (0.27x) | 277.33 ms (43.4x) |
| **document-independent** | | | |
| compile, per stylesheet | 33.16 µs | n/a | 70.50 µs (2.1x) |

The identity row is the sharing fast path: Jaren returns the input reference in O(1), while native and JSONata deep-copy. On actual transformations, hand-written JavaScript is 3.4–143x faster because it is bespoke code with no matcher, rank table, mode, schema, or error machinery—the honest cost of the abstraction. Jaren is 6.6–45x faster than JSONata where the transform operator can express the scenario; reshape+modes is `n/a`, not silently replaced by a different JSONata feature. JSONata 2.x timings include its required promise overhead and transform-copy cost. Scaled prices are rounded to cents because JSONata's copy normalizes long binary decimal tails and these scenarios do not sort. fontoxpath is excluded because it has XPath/XQuery but no XSLT dispatcher; Saxon-JS is excluded as a heavyweight SEF/XSLT toolchain for this benchmark workspace.

## JTLT — template-driven text output

JSLT transforms JSON into JSON. JTLT points the same dispatcher at **text**: a template is a JSLT-shaped rule document whose bodies are *segment lists* — literal text, interpolated queries, and `$apply` splices — and whose result is a string. It is the T4/XSLT-`method="text"` analogue of this stack, and like the XQuery module it is a **front-end, not a second engine**: `compileJtltStylesheet` desugars the template into an ordinary JSLT 0.1 stylesheet (inspectable as `render.stylesheet`) and serializes the dispatched result, so dispatch, modes, conflict resolution and schema matching are inherited, not reimplemented. The normative contract is [JTLT-FORMAT.md](./docs/JTLT-FORMAT.md); this section is the tour.

```javascript
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';

const listBooks = compileJtltStylesheet([
  { match: '$', body: ['# Books\n', { $apply: '$.store.book[*]' }] },
  { match: '$.store.book[*]', body: ['- ', '$.title', ' (', '$.price', ')\n'] },
]);

listBooks(data);
// '# Books\n' +
// '- Sayings of the Century (8.95)\n' +
// '- Sword of Honour (12.99)\n' + ...
```

Segments follow the query format's own string rules: a string is literal text unless it starts with `$` (a query expression, interpolated), and `"$$x"` escapes the literal text `"$x"`. Objects are operator phrases evaluated as expressions; three forms are special at segment level: `{ "$apply": ... }` splices the dispatched output of other rules in place, `{ "$raw": e }` interpolates without escaping, and `{ "$json": e }` embeds data as `JSON.stringify` text. Sequence-valued interpolations join with a single space (the XSLT `value-of` separator default), the empty sequence renders nothing, and interpolating an object or array is a runtime error that names the offending segment — dispatch into containers with `$apply` instead.

The envelope's `output` member selects the serialization method. `"text"` (the default) writes everything raw; `"xml"` escapes interpolated data while literal template text stays raw markup — the XSLT/T4 contract exactly:

```javascript
const toXml = compileJtltStylesheet({
  $jtlt: '0.1',
  output: 'xml',
  rules: [
    { match: '$', body: ['<books>', { $apply: '$.store.book[*]' }, '</books>'] },
    { match: '$.store.book[*]', body: ['<book title="', '$.title', '"/>'] },
  ],
});

toXml(data);
// '<books><book title="Sayings of the Century"/>...</books>'
// interpolated data is XML-escaped; literal markup passes through raw
```

Unmatched nodes follow the XSLT built-in template rules, restated for JSON: containers apply templates to every child in document order, atoms emit their (method-escaped) string value — so `{ $apply: '$.title' }` doubles as a value-of with rule-override capability. A matchless rule replaces that default; `priority` conflicts resolve exactly as in JSLT, with the band at and below `-1e307` reserved for the built-ins. Modes, schema matches (via `options.compileTypeTest`), user externals and the reserved `$root`/`$path` parameters all work as in JSLT. Compile and runtime errors carry stable `TL`-prefixed codes and a `docPath` into the **template** document (engine errors are remapped from the compiled stylesheet back to the author's source). `renderText(template, data, externals?)` is the cached one-call form.

## Roadmap

This package's roadmap lives in the repository-wide [ROADMAP](../../ROADMAP.md), under its `@jarenjs/json` sections: the query filter optimizer and hash joins, lazy sequences, the JSLT single-walk matcher, write operations and JSON Patch, custom JSONPath function extensions, canonical JSON, XQuery front-end `xs:*` casts, and more. Recently landed from that list: JSON Schema as the query type system (`$valid`/`$assert`/`$as`), the inverse [`$query` keyword](../validate/README.md) in the validator, compiled JSON Pointers, and the complete JSLT template layer.

## Development

Unit tests live in `test/json/` at the repository root (`npm run test:json`); the JSONPath tests are built from the RFC's own examples, the query and JSLT tests from their normative fixtures (each schema corpus validates against both artifact drafts), and every example in this README runs in `test/json/readme-examples.test.js`. This package's internals are described in its own [ARCHITECTURE](./ARCHITECTURE.md) document. Benchmarks (all documented in the [benchmark workspace README](../../benchmark/README.md)): `benchmark/jsonpath.js` (JSONPath compliance + performance), `benchmark/jsonpointer.js` (compiled pointers vs the interpretive resolver and the `jsonpointer` npm package), `benchmark/jsonquery.js` (query engine vs fontoxpath/jsonata), `benchmark/jslt.js` (stylesheet engine vs native JS/JSONata), `benchmark/qt3-runner.js` (W3C QT3 scorecard through the XQuery front-end). See the repository [README](../../README.md) and [ARCHITECTURE](../../ARCHITECTURE.md) for the monorepo picture.
