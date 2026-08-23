---
package: "@jarenjs/json"
card:
  title: JSON addressing
  blurb: >-
    The addressing and transformation standards as compilers: JSON Pointer,
    JSONPath, JSON Patch and Merge Patch, copy-on-write write operations, an
    XQuery-semantics query language written as JSON documents, JSLT
    stylesheets and the JTLT text front-end — one family, every grammar
    published as JSON Schema.
engines:
  - key: path
    suite: jsonpath
    title: JSONPath
    blurb: >-
      The complete RFC 9535 grammar as a compiler — every case of the
      official compliance corpus scored, normalized paths included.
    perf: >-
      scored on the whole official compliance corpus
  - key: pointer
    suite: jsonpointer
    title: JSON Pointer
    blurb: >-
      RFC 6901 with zero-allocation compiled getters, plus relative pointers
      — the $data hot path.
    perf: >-
      compiled getters, far ahead of the npm package
  - key: patch
    suite: jsonpatch
    title: JSON Patch
    blurb: >-
      RFC 6902 and RFC 7396 as copy-on-write appliers: atomic,
      structure-sharing, and a change feed of written paths.
    perf: >-
      measured against clone-and-interpret
  - key: query
    suite: jsonquery
    title: JSON Query
    blurb: >-
      XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, folds and
      windows — as JSON documents with JSONPath leaves. Uncorrelated
      equijoins are planned as hash joins, and only where the rewrite is
      provably invisible.
    perf: >-
      measured against fontoxpath and JSONata
  - key: jslt
    suite: jslt
    title: JSLT
    blurb: >-
      The stylesheet layer: JSONPath matches position, JSON Schema matches
      shape, query documents produce output. Identity transforms return the
      input reference. Operator packs register more —
      createJsltRegistry().use(mathPack)… adds $npv, $mean, $sqrt to JSLT,
      query and linq, and over @jarenjs/db the scalar subset pushes to
      SQLite as UDFs.
    perf: >-
      proof-of-no-change without rebuilding the document; host operator
      packs are opt-in
  - key: jtlt
    title: JTLT
    blurb: >-
      The text sibling of JSLT: template rules render JSON as Markdown, XML
      or source code — schema-matched rules turn one table document into
      SQLite or PostgreSQL DDL, and the xml method escapes interpolated data
      while literal markup passes raw.
    perf: >-
      a front-end, not a second engine: compiles to JSLT
---

One package, one idea: every way of ADDRESSING and TRANSFORMING a JSON
document, compiled rather than interpreted. A pointer, a path, a patch, a
query, a stylesheet and a text template are all documents here — plain JSON
values with published grammars, so a constrained decoder can write them and the
engine can compile them once and run them at speed.

### JSON Pointer

RFC 6901 as compiled, zero-allocation getters — plus relative JSON Pointers,
the `$data` hot path. A miss returns the `JSONPOINTER_NOTHING` sentinel, never
a throw.

```js
import { compileJSONPointer } from '@jarenjs/json/pointer';
const get = compileJSONPointer('/limits/min');
get({ limits: { min: 2 } });  // 2
```

### JSON Patch & Merge Patch

RFC 6902 and RFC 7396 as copy-on-write appliers: the input is never mutated,
untouched subtrees are shared by reference, application is atomic, and the
changes option turns the engine into a change feed of written paths.

```js
import { compileJSONPatch } from '@jarenjs/json/patch';
const apply = compileJSONPatch([
  { op: 'replace', path: '/user/name', value: 'Bob' },
], { changes: true });
const { doc, changes } = apply(document);
// changes: ['/user/name']
```

### Write operations

Compiled setters, inserters and removers for both pointer and JSONPath targets:
a singular pointer writes one location; a JSONPath target writes every match.
All copy-on-write with the same sharing guarantees as patch.

```js
import { compileJSONPathSetter } from '@jarenjs/json/write';
const discount = compileJSONPathSetter('$.store.book[?@.price > 20].price');
const next = discount(doc, (old) => old * 0.9);
```

### JSONPath

The complete RFC 9535 grammar as a compiler — all 703 tests of the official
compliance suite pass, normalized paths included. Compiled queries expose
.nodes(data) returning { path, value } pairs.

```js
import { compileJSONPath } from '@jarenjs/json';
const query = compileJSONPath('$.store.book[?@.price < 10].title');
query.nodes(data);  // [{ path: "$['store']['book'][0]['title']", value: '...' }]
```

### JSON Query

XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, a 98-operator
library extensible with host operator packs (see JSLT stylesheets, below) — as
JSON documents with JSONPath leaves. The grammar is published as JSON Schema,
so a constrained decoder cannot emit an invalid query.

```json
{ "$for": { "b": "$.store.book[*]" },
  "$where": { "$lt": ["$b.price", 10] },
  "$orderby": ["$b.price"],
  "$return": { "title": "$b.title", "price": "$b.price" } }
```

A `$fold` clause turns the same phrase into a reduction: the accumulator is a
binding, not a lambda, so the language gets folds, running totals and runtime
pointer walks without the JSON encoding ever needing to spell a function value.
Extended `$for` bindings cover the rest of XQuery iteration — `$allowing-empty`
for outer joins, and tumbling or sliding windows for moving aggregates.

```json
{ "$fold": { "total": 0 },
  "$for": { "b": "$.store.book[*]" },
  "$where": { "$lt": ["$b.price", 10] },
  "$return": { "$add": ["$total", "$b.price"] } }
```

> **Schema operators** — With the `compileTypeTest` hook from
> `@jarenjs/validate/query`, queries can type-check their own data: `$valid`,
> `$assert` and `$as` take JSON Schema literals.

> **Uncorrelated equijoins are hash joins** — The planner recognizes a `$where`
> equality whose probe side does not depend on the outer binding and answers it
> from a hash table — O(n+m) instead of O(n·m). It declines whenever the
> rewrite would be observable (a `$as` or `$let` in the phrase, a correlated
> source, an equality that is not the first `$and` conjunct), so the
> optimization can never change an answer.

### JSLT stylesheets

XSLT's `apply-templates` idea, JSON-native: template rules match by location
(JSONPath) and shape (JSON Schema) and produce output with query documents.
Unchanged input flows to output by reference — the identity transform returns
the input in nanoseconds, whatever the document size.

```json
[ { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]
```

Dispositions (share / fresh / error), modes, priorities and the `$apply`
operator are specified in `JSLT-FORMAT.md`; this site's entire UI is one JSLT
stylesheet producing vnodes.

The operator vocabulary is EXTENSIBLE without changing the format.
`createJsltRegistry()` from `@jarenjs/json/jslt` composes packs of pure
`@jarenjs/core` functions into a compiler — math (`$sqrt`, `$pow`, `$hypot`,
the trig family), finance (`$npv`, `$irr`, `$sma`, `$fv`, `$pv`, `$pmt`) and
statistics (`$mean`, `$median`, `$stddev`, `$percentile`) — so a stylesheet or
a bare query can COMPUTE with them. An aggregator folds a JSONPath-selected
sequence before its pure call, the way `$sum` does.

```js
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
const jslt = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const t = jslt.compile([{ match: '$', body: {
  npv:  { $npv:  ['$.rate', '$.cashflows[*]'] },
  mean: { $mean: '$.people[?(@.class == "upper")].probability' },
} }]);
```

> **Host opt-in, and where they run** — A document compiled WITHOUT a registry
> still rejects these operators (JQ0002) — they never change the published
> closed vocabulary. The same registry compiles JSLT stylesheets, bare query
> documents and `@jarenjs/linq` chains; against a `@jarenjs/db` store they run
> in the query residual, and the pushable-scalar (math) subset is pushed into
> SQLite as deterministic UDFs where the driver allows. Play mounts the packs,
> so the "Registered …" examples run. See JSLT-FORMAT §13 and MODEL-FORMAT
> §8.1–8.2.

### JTLT text templates

The text sibling of JSLT, and a front-end rather than a second engine:
`compileJtltStylesheet` desugars a template into an ordinary JSLT stylesheet
(inspectable as `render.stylesheet`) and serializes what the dispatcher
produced, so modes, priorities, schema matching and conflict resolution are
inherited rather than reimplemented. A rule body is a segment list — literal
text, interpolated query expressions, and `$apply` splices that dispatch into
other rules.

```json
[ { "match": "$", "body": ["# Books\n", { "$apply": "$.store.book[*]" }] },
  { "match": "$.store.book[*]", "body": ["- ", "$.title", " (", "$.price", ")\n"] } ]
```

The envelope's `output` member picks the serialization method. `text` writes
every segment raw; `xml` escapes interpolated DATA while literal template
markup passes through untouched — the XSLT and T4 contract exactly, which is
what makes one template document able to emit Markdown, XML or SQL DDL from
schema-matched rules. Unmatched nodes follow XSLT's built-in rules restated
for JSON: containers apply templates to every child in document order, atoms
emit their escaped string value.

### The XQuery front-end

`parseXQuery` reads an XQuery 3.1 text subset and emits a query document — the
bridge that runs the W3C QT3 suite (31,821 cases) against the JSON engine with
zero unattributed failures.

```js
import { parseXQuery } from '@jarenjs/json/xquery';
const doc = parseXQuery('for $b in $doc?store?book?* where $b?price < 10 return $b?title');
```

**Try it.** Play has a tab for each of them — [JSONPath](#/play?engine=path),
[JSON Pointer](#/play?engine=pointer), [JSON Patch](#/play?engine=patch),
[`$query`](#/play?engine=query), [JSLT](#/play?engine=jslt),
[JTLT](#/play?engine=jtlt) and [the XQuery front-end](#/play?engine=xquery) —
each opening on a document that runs.
