# @jarenjs/db — architecture

The public documentation promises SQLite and nothing else. This file
documents the two seams that make that promise cheap to keep and cheap
to outgrow — an undocumented seam decays into an accident.

## The driver seam (`src/driver.js`, `src/drivers/*`)

A driver is `{ name, dialect, open(path, options) }` returning a
`Connection` (see `docs/MODEL-FORMAT.md` §4). Three bindings exist,
one per subpath — `./node` (`node:sqlite`), `./bun` (`bun:sqlite`),
`./wasm` (an injected handle) — and each imports its runtime builtin
**lazily inside `open()`**, never at module scope. The release gate
imports every export subpath under Node *and* Bun; Bun ships no
`node:sqlite` and Node cannot resolve `bun:` specifiers, so a
top-level builtin import would turn the gate red in both directions.
`open()` is where "this binding does not exist here" becomes the coded
`JD0003`.

Every connection and statement method may return a value or a promise.
The store composes through the sync-capable `chain` helper, which
applies a continuation without allocating a promise when the driver
answered with a value — the public asynchronous surface then lifts
exactly once per call. Where the connection is synchronous the same
operation cores are exposed promise-free under `store.sync`; where it
is not, `store.sync` is absent rather than stubbed.

Capabilities are probed once at open (version, compile options,
binding declaration) and frozen. Two slots — `statementTimeout` and
`rowEstimates` — are `false` on every SQLite driver because the
underlying facts do not exist there (no interrupt, no progress
handler, no estimate API). They are part of the contract so a driver
that has the facts can fill them without a contract change.

## The dialect seam (`src/dialect.js`, `src/dialects/sqlite.js`)

A dialect is data plus a small emitter, and it is the only place SQL
text is produced. `createDialect(spec)` composes a spelling spec —
identifier quoting, parameter references, string literals, JSON
extract/set/remove/append, transaction phrases, PRAGMA phrases,
introspection queries, the table suffix and document column type —
into the DDL and DML builders the store consumes. Nothing outside a
dialect concatenates SQL; a reviewer can point at every emitted
statement and find it behind the seam. The suite pins this with a
test-double dialect whose quoting, parameter style and type names all
differ: the same model produces correspondingly different SQL.

Deliberately *not* dialect concerns, because they are behavioural
rather than syntactic, and live in the capability table instead:
whether functions register per connection, whether change capture
exists and in what form, and whether tables can be restructured in
place.

The SQLite dialect stores documents as JSONB in a `BLOB` column of a
`STRICT` table, projects each indexed path into a virtual generated
column over `jsonb_extract`, and renders reads back to text through
`json()`. Parameters are positional because every shipped binding
binds arrays.

## What sits on top

- `src/ddl.js` — a normalized collection to its physical plan. Index
  paths are analyzed through the query engine's **published AST**
  (`analyzeQuery`): singularity decides indexability (`JD0004`
  otherwise), and the collection's schema is the type source for
  generated columns. The plan carries both the CREATE statements and
  the structural facts an existing table must match (`JD0002` when it
  does not — nothing is ever altered).
- `src/derive.js` — the one place a declared `derive` becomes a value.
  A geohash cell or a bounding-box edge from `@jarenjs/core/geo`, and
  the deterministic SQL functions a generated column's expression
  calls. The SAME functions serve both physical mappings, so the two
  branches cannot drift into different answers.
- `src/patch-sql.js` — RFC 6902 to JSON-set primitives, discriminated
  against the live document (a pointer cannot say array-or-object on
  its own). Untranslatable operations fall back to a whole-document
  write; the store counts and exposes the fallback.
- `src/store.js` — model normalization (`JD0005`), shape
  create-or-verify, the validated write path (injected
  `compileSchema` hook; `capabilities.validated` says whether it is
  in force), identity strategies, savepoint-nested transactions, and
  the sync surface.

Dependency arrows: `core → json → db`, plus `validate → db` for
exactly ONE reason: the entity walk resolves `$ref` and merges `allOf`
through the schema resolvers `@jarenjs/validate/normalize` exports for
other packages to walk schemas with (emit already does). Validation
itself still arrives only through the injected `compileSchema` hook —
this package never calls the validator. No linq, no app, no view, no
flow. The linq package couples by contract (`execute(document,
options)`), never by import.

## The decisions that cost something

- **D3 — the normalized AST is a compatibility surface.** The planner
  walks the engine's PUBLISHED AST, which promoted an internal shape
  to a versioned contract the engine must now keep. Paid for: a
  load-time exhaustiveness pact means a new language construct breaks
  the build instead of silently becoming a residual.
- **D6 — the store API is asynchronous** even though every shipped
  driver is synchronous. Measured cost: ~0.17 µs per point read
  (~6 %) over the `store.sync` twin. Paid for: the browser's OPFS
  story and any future non-embedded driver need no API change, and
  the sync-capable `chain` keeps the internal composition
  allocation-free so the surface pays exactly one promise per call.
- **D21 — the dialect indirection is paid for a second backend that
  does not exist.** Every byte of SQL routes through a spelling spec;
  the test double proves the seam by rendering the same plans and the
  same DDL differently. The cost is one indirection and a larger
  contract; the alternative was a rewrite on the day a second dialect
  matters — and the capability slots (`statementTimeout`,
  `rowEstimates`) already model what a server would fill in.

## The pushdown contract (`src/plan.js`, `src/emit.js`, `src/query.js`)

This is an implementation contract, not a format: it binds the planner,
the emitter and their tests, and `explain()` is its runtime witness.

**Three stages, and the middle one is dialect-neutral.** A query
document is analyzed to the engine's published AST, the AST becomes a
`Plan` — a relational algebra value carrying **no SQL text** (a test
scans plan output for dialect tokens) — and the plan renders to SQL
through a dialect. What cannot be proven equivalent runs as a
**residual**: a real compiled Jaren query, never a reimplementation.
`explain()` always says which is which.

**Dispatch is exhaustive.** The planner switches on the AST's node
kinds with no default branch that degrades silently: an unrecognised
kind is an internal error naming the kind and the `AST_VERSION`. A
construct that is *deliberately* not translated is a row in the table
below, and that table's reasons are what `explain()` reports.

### The translated set

A single-binding FLWOR over the collection (`$for: { <name>: '$[*]' }`
— the examples here write `it`, but the binding is the **document's** to
name and nothing translates differently under another one)
with: comparison predicates (`$eq $ne $lt $le $gt $ge`) between a
singular member path and a literal or external; `$and`/`$or`/`$not`
composition; `$exists`/`$empty`; `$starts-with`/`$ends-with`/
`$contains` on schema-typed string paths with literal patterns;
`$orderby` over singular schema-typed paths (`$dir`, `$empty`, no
collation); a top-level `$subsequence` window with literal bounds; the
top-level aggregates `$count` and `$sum`/`$avg`/`$min`/`$max` over a
singular schema-typed path; the whole-document projection that returns
the bare binding; ONE member path, projected as its value beside its
JSON type; and a nested SHAPE of objects, arrays, literals and member
paths, projected as one value/type pair per distinct leaf and rebuilt
by the decoder — never by parsing a JSON text the database assembled,
which could not tell an absent member from a present `null`.

Plus the spatial predicates a **derived** index makes decidable:
`$bbox-intersects` against a literal or external region, a geohash
prefix no longer than a `derive: 'geohash'` column's precision, and the
nine-cell neighbourhood probe over that same column — each over a
member the schema types as an array or an object. Those are exact; the
spatial predicates that only NARROW are rows in the residual table, and
the implied-conjunct table below carries every proof.

Plus one GROUPING a composite instant index makes exact: the
fixed-width temporal bucket. A `$groupby` whose single key is
`$time-bucket` over a schema-typed integer epoch path with a literal
width and origin, projected to the group key plus `$count` of the
binding and `$sum`/`$avg`/`$min`/`$max` over singular schema-typed
numeric paths, becomes a `GROUP BY` over integer arithmetic. So does a
`$resample` whose frozen spec asks for nothing that ladder cannot do —
a fixed width, `fill: 'omit'`, and one of `sum|mean|min|max|count`.
Everything else about time is a NAMED refinement ("The temporal plan"
below).

Plus one ORDERING a **`derive: 'vector'`** column makes cheap without
making it native: the k-nearest composition — `$orderby` on a
`$similarity` key, descending, `$empty: 'least'`, under a `$subsequence`
window with a finite limit — over the member the column stores. It is
never pushed as an `ORDER BY`: the column CUTS the candidate set and the
engine DECIDES the order ("The k-nearest plan" below), which is a fourth
mode, `knn`, beside native, row and set.

### The deliberate-residual table

| construct | reason |
|---|---|
| `$let` bindings, `$fold`, positional/window bindings | no equivalence proof exists yet; residual by default |
| a `$groupby` whose key is untyped or nullable, whose `$return` reads the binding, or whose `$orderby` names anything but a key | SQL's grouping and the engine's need not agree on an untyped key; after a grouping the binding holds the group's ROWS, which an object member cannot take |
| a window over the GROUPS, or an aggregate of them | the plan groups whole; a `LIMIT` over the groups would cut a different set |
| a `$for` binding nothing joins to — a cartesian product | the engine builds the product; a plan that emitted one by accident is the thing an equi-join graph exists to prevent |
| non-singular path expansion | one relation per binding in this version |
| `$match` and other unlisted operators, `$call` | no native spelling proven equivalent |
| `$orderby` with a `$collation` | a collation the dialect cannot reproduce is refused, not approximated |
| a projection the tree cannot rebuild: an operator over a member, a reference to the binding itself, a non-singular path, a projection with no member path at all | the WHOLE projection runs per row (the row residual) — pushed, ordered and windowed rows, projected by the engine; promoting the part that composes would answer a shape nobody asked for |
| string operators with an external pattern | the pattern's type is unknowable at plan time and the engine ERRORS on non-string patterns |
| comparisons where both sides are paths | join territory |
| array/object literals in comparisons | deep-equality has no guarded native form |
| `$within` over a `derive: 'bbox'` column | a bounding-box pre-filter is pushed; exact containment refines in the engine |
| a bounded `$distance` over a `derive: 'bbox'` column | a geodesic-circle box pre-filter is pushed; the exact distance refines in the engine |
| a geohash prefix LONGER than the column's precision | a cell-range pre-filter over the derived column's precision is pushed; the longer prefix refines in the engine |
| a spatial predicate over a member with no matching derived index, or one the schema does not type as an array or an object | nothing is proven; the whole predicate runs in the engine (the deterministic-function hatch may still take it) |
| an unbounded `$distance` (`>= r`), a circle reaching a pole or crossing the antimeridian, a probe with no bounding box | no conservative box exists — pushing nothing is correct, pushing a wrong box is not |
| the k-nearest ordering over a `derive: 'vector'` column | the column cuts the candidates; the engine orders them (mode `knn`, "The k-nearest plan" below) — engine work, so `strict: true` refuses it |
| `$similarity` anywhere else — a threshold in `$where`, a score in `$return`, a second ordering key | no native spelling; runs in the residual over whatever the rest of the document pushed |
| the k-nearest shape with no finite window, ascending, `$empty: 'greatest'`, a probe that is neither a literal vector nor an external, a literal probe of another width, or a selection not pushed whole (a residual conjunct, an implied one, a `$let` before the where) | nothing is proven; the whole document runs in the engine, and `explain()` names which precondition failed — a k-nearest query never falls to the full scan silently |
| `$resample` with a fill policy other than `omit`, `$rolling`, `$asof`, `first`/`last`, a calendar width, a named zone, a `$time-bucket` whose width or origin is an EXPRESSION, or an instant the schema does not type as an integer | the index bounds the fetch and `@jarenjs/core/series` decides over what comes back; `explain().series.reasons` carries the CODE — `fill-policy`, `rolling-refinement`, `asof-refinement`, `unsupported-aggregate`, `calendar-width`, `named-zone`, `nonliteral-spec`, `instant-not-integer` — and `strict: true` refuses every one of them |

### The type truth table

Jaren compares by JSON type; SQL engines by storage class and
affinity. `jsonb_extract` returns SQL `NULL` for a missing member AND
for a stored JSON `null` — only `json_type` tells them apart, so every
translated predicate is guarded by it and is therefore **total
(two-valued)**: `NOT`, `AND` and `OR` compose classically and SQL's
three-valued `NULL` logic never reaches a result row. Probed engine
facts the table encodes: a comparison against a missing member is
`false` (even `$ne`); a cross-type `$eq` is `false` and a cross-type
`$ne` against a PRESENT value is `true`; booleans do not order;
string order is codepoint order (which is exactly SQLite's BINARY
order over UTF-8);
`$exists` is true for a stored `null`, `$empty` is true for a missing
member.

With `jt` = `json_type(doc, path)`, `v` = the compared value (the
generated column where one exists), `?` = the bound operand:

| Jaren predicate | emitted form |
|---|---|
| `$eq` path, number | `jt IN ('integer','real') AND v = ?` |
| `$ne` path, number | `jt IS NOT NULL AND (jt NOT IN ('integer','real') OR v <> ?)` |
| `$lt/$le/$gt/$ge` path, number | `jt IN ('integer','real') AND v op ?` |
| `$eq` path, string | `jt = 'text' AND v = ?` |
| `$ne` path, string | `jt IS NOT NULL AND (jt <> 'text' OR v <> ?)` |
| `$lt/$le/$gt/$ge` path, string | `jt = 'text' AND v op ?` |
| `$eq` path, `true`/`false` | `jt = 'true'` / `jt = 'false'` (no value bind) |
| `$ne` path, `true`/`false` | `jt IS NOT NULL AND jt <> 'true'/'false'` |
| `$eq` path, `null` | `jt = 'null'` |
| `$ne` path, `null` | `jt IS NOT NULL AND jt <> 'null'` |
| ordering vs `true/false/null` literal | constant `FALSE` (booleans and nulls do not order) |
| `$exists` path | `jt IS NOT NULL` |
| `$empty` path | `jt IS NULL` |
| `$eq` path, external | `(jt = 'text' AND typeof(?) = 'text' AND v = ?) OR (jt IN ('integer','real') AND typeof(?) IN ('integer','real') AND v = ?)` |
| `$ne` path, external | `jt IS NOT NULL AND NOT (…the $eq form…)` |
| ordering vs external | the same two-branch form with `op` |
| `$starts-with` path, string | `jt = 'text' AND (v >= ? AND v < ?)` — the prefix and its code-point successor |
| `$ends-with` path, string | `jt = 'text' AND (length(?) = 0 OR substr(v, -length(?)) = ?)` |
| `$contains` path, string | `jt = 'text' AND instr(v, ?) > 0` |

**The prefix predicate is index-usable, and the other two are not.**
`$starts-with` emits a half-open range over the value, so a declared
index on that path is *seeked*, not scanned — worth declaring one for.
The bounds are computed at emit time, which the planner's own rule
makes exact: a string operator translates only with a literal,
non-empty pattern, so its code-point successor is known there. (A
pattern of nothing but U+10FFFF has no successor and falls back to the
scannable `substr` form.) `$ends-with` and `$contains` have no
index-usable spelling and read every row of the collection.

The guards make the forms sound for typed AND untyped paths alike —
the schema type's job is choosing the generated COLUMN (the index),
never weakening the guard. Two documented preconditions. String
operators, aggregates and ordering are only promoted on schema-typed
paths that cannot hold `null` and are not boolean, because the engine
ERRORS on non-conforming operands where SQL would coerce or sort — a
`null` under an ordered key, a non-string under a string operator —
so a path whose schema admits `null` is a named residual for those
forms and the two engines keep answering alike over conforming data.
And the guards protect the JSON TYPE, not the VALUE: a typed
generated column carries SQLite affinity, so on an unvalidated store a
row that violates the schema — the string `'020'` under an `integer`
path — reads as the integer `20` in the column while `json_type` still
says text, and a pushed comparison answers rows the engine (comparing
the JSON value) does not. Keep `compileSchema` injected: with the hook
no such row is ever stored, and without it the pushdown is exact only
over documents that happen to conform.

**Bind-time diversion.** SQLite cannot bind a boolean, and a
`null`-valued external needs Jaren's null semantics, not SQL's. At
execute time, if any referenced external is missing or not a string or
finite number, the call runs the always-compiled set residual instead
of the native statement — same answer, one branch, no wrong-typed SQL.
A **derived** slot is the exception that proves it: a GeoJSON region is
not bindable at all, so what binds is one edge of its bounding box per
slot, computed at bind time; such a call diverts only when the bound
value has no box.

### The implied conjunct (spatial)

Every conjunct above is a conjunct **of the document**: it translates
exactly or it does not. A spatial predicate mostly cannot — there is no
`ST_Within` in SQLite and this package does not build one — but it
*implies* one that can be, over the columns a model declares with
`indexes[].derive` (MODEL-FORMAT §2.1).

> An **implied conjunct** is a predicate the planner ADDS to the SQL
> that is not in the document, proven below to be implied by one that
> is. It narrows; it never decides. The conjunct it came from stays in
> the residual.

Three properties make that safe, and each is asserted by test: **no
false negatives** (every row the document's predicate keeps passes the
implied one — the proofs below); **idempotent refinement** (the residual
re-runs the original predicate over the narrowed candidates, which is
why an implied conjunct forces the SET residual and not the row one);
and **`strict: true` refuses it** (an implied conjunct leaves its own
reason behind, so the plan is never native and `JD0010` names it).

Throughout, `B(v)` is the value's bounding box and `<c>_w`/`_s`/`_e`/`_n`
are a `bbox` index's columns; `<c>` is a `geohash` index's column at its
declared precision `k`. Every promotion requires the schema to type the
member as an array or an object **and nothing else** — §8.14 answers
`JQ2001` for a non-geographic operand, and a union that also admits
`null` is not geography.

| Jaren predicate | pushed | exact? | why it is implied |
|---|---|---|---|
| `$bbox-intersects(<path>, <literal\|external>)`, `physical: 'columns'` | `w <= L_e AND e >= L_w AND s <= L_n AND n >= L_s` | **exact** | the derived columns ARE `B(row)`, so box overlap is fully decidable. `<=`/`>=`, not `<`/`>`: the kernel counts touching edges as intersecting, and a strict comparison would disagree on every shared edge |
| the same, `physical: 'rtree'` | the same four comparisons, spelled as `rowid IN (SELECT id FROM <c>_rtree WHERE minx <= L_e AND maxx >= L_w AND miny <= L_n AND maxy >= L_s)` | implied | an R\*Tree stores coordinates as **32-bit floats rounded OUTWARD**, so what it holds is `B(row)` widened — a superset, by ~3 cm in x and ~84 cm in y at 52°N. A superset has no false negatives, which is all a pre-filter needs; it is not a decision, so the exact box test refines and `strict: true` is `JD0010` here where the column mapping was native |
| `$within(<path>, <literal\|external>)` | the same four comparisons against `B(area)`, in whichever spelling the mapping takes | implied | the representative position is inside `B(subject)` — a bare position IS the box, and a centroid is a mean of positions, which lies within their min/max — and inside the area's surface implies inside `B(area)`; so the two boxes share at least that position ∎ |
| `{$le\|$lt: [{$distance: [<path>, <literal>]}, r]}` | the same four comparisons against `circleBounds(probe, r)` | implied | every position within `r` metres lies inside the circle's box, which the kernel computes on the same sphere and the same `EARTH_RADIUS` the engine measures with — so the two cannot disagree by model. `$ge`/`$gt` is NOT promoted: no box narrows "farther than r" |
| `{$starts-with: [{$geohash: [<path>, k]}, "<cell>"]}`, cell length ≤ k | `<c> IN ("<cell>")` or `<c> >= "<cell>" AND <c> < successor` | **exact** | the column HOLDS `$geohash(row, k)`, and geohash is a prefix code, so a prefix test on the expression is the same test on the column |
| the same, cell length > k | the cell truncated to k | implied | the column can only confirm its own first k characters |
| `{$exists: {$index-of: [{$geohash-neighbours: "<cell>"}, {$geohash: [<path>, k]}]}}`, cell length = k | `<c> IN (…the nine cells…)` | **exact** | the membership test compares whole strings and the column is exactly one of them. Nine cells, never one: two points ten metres apart can differ in the FIRST character of their cell (D7), so a single prefix is bucketing and only the neighbourhood is proximity |

**The proof is a proof about BOXES, not about SQL**, so the physical
mapping (MODEL-FORMAT §2.1, `physical`) does not enter it: the same box
is computed either way and only its spelling changes. The `rtree`
spelling is a `rowid` subquery — a conjunct on the collection table, so
the `FROM` clause, the residual machinery and `prefilters` are all
untouched. It is not a join (which would need join support the emitter
does not have, for 6 % ) and emphatically not a correlated `EXISTS`,
which defeats the virtual table's index entirely and measured 85× worse
than the subquery.

The implied forms carry no `json_type` guard — a derived column IS the
value — but each is TOTAL through its own `IS NOT NULL`, so a row with
no box answers `FALSE` rather than SQL's `NULL` and negation composes
classically. The `rtree` form is total for the same reason by a
different route: a row with no box was never inserted into the virtual
table (the sync trigger's guard, MODEL-FORMAT §3.2), so it is simply not
in the list. An implied conjunct may not be negated at all: negating a
superset is a subset, and that drops rows. That guard also makes the
leading term a two-sided range, which is what SQLite will actually
**seek**: with a one-sided range it prefers a table scan, and a scan over
a virtual generated column pays a registered-function call per row.

**A pre-filter decides which rows the engine SEES, so it also decides
which rows can raise.** The row set is unchanged — that is what the
table above proves — but a row the pre-filter excludes never reaches
the engine and therefore never throws: a stored `null` under a member
the schema types as geography, or a value with no bounded position
under §8.14's membership recipe (`$index-of` refuses an empty search
item). This is the same class as the string-operator and aggregate
preconditions above, and the same answer: keep `compileSchema` injected
if that distinction matters to you.

### The k-nearest plan (vector)

A `derive: 'vector'` column (MODEL-FORMAT §2.1) holds each row's member
as a packed, l2-normalized binary32 vector. Nothing in SQL ranks over
it, and the reasons are portability and correctness rather than speed:
none of the `ORDER BY`-over-a-function spellings runs where no function
can be registered, and an ordering decided in SQL cannot break a tie by
the document's own secondary keys — which the engine executor has to,
for the three executors to agree. (On speed the two are close: re-measured
against the real column with the probe hoisted out of the per-row call,
`ORDER BY` over a registered function sits at rough parity with fetching
the column and ranking in the engine — `benchmark/vector.js` publishes
the band, and the store does not emit it anyway.) The k-nearest
composition is therefore planned as **a cut the engine finishes**, the
implied-conjunct pattern applied to an ordering instead of a predicate:

| stage | what | where |
|---|---|---|
| narrow | the pushed `$where` conjuncts, exactly as in every other mode | SQL |
| fetch | `(row identity, packed column)` for every narrowed row — no `ORDER BY`, no `LIMIT`, no similarity call; the probe never binds into the statement | SQL |
| score | every column unpacked and dotted with the l2-normalized probe (the cosine of the raw vectors, up to binary32 rounding); a `NULL` column scores nothing | engine (`@jarenjs/core/vector`, through `derive.js`) |
| cut | with `m = offset + limit`: every scored row whose score is within `margin` (`1e-6`) of the m-th best is a candidate; when fewer than `m` rows scored, EVERY row is | engine (`knn.js`) |
| fetch | the candidates' documents, by identity, in identity order, through the dialect's by-identities statement (batched under every build's parameter cap) | SQL |
| decide | the ORIGINAL document — its whole `$orderby` (the `$similarity` key over the raw member, every secondary key, `$empty`), its window, its `$return` — as the set residual over exactly those documents | engine |

**Why the cut is exact.** The column's score and the engine's key are
not the same number: one is a dot product over binary32-normalized
forms, the other the cosine of the raw doubles, and they differ by up
to ~1e-8 (measured over the corpus and over thousands of random 768-d
pairs). A plan that CUT by the column's score alone could therefore
pick a different m-th row than the engine whenever two true cosines lie
within that distance. With a margin of at least twice the divergence
the engine's top `m` is a subset of the candidates: if a row the engine
ranks inside the window were cut, some candidate the engine ranks
outside it would have to score higher by the column and lower by the
engine, which two scores within half the margin of each other cannot
do. `1e-6` is a hundred times the bound; in practice it admits only true
ties, and the residual re-ranks a handful of documents — microseconds.

**What the engine's decision buys.** Ties break by the document's OWN
secondary keys, never by row identity, which the engine executor cannot
see (row identity serves the fetch, never the order — a stable sort
over the candidates in identity order sees what it would have seen over
the whole collection). Offsets, nested windows and every secondary key
compose for free. And the unrankable tail is right by construction:
`$empty: 'least'` places a row whose key is empty LAST, so a window
wider than the scored rows must produce those rows in the engine's own
secondary order — which is exactly why the cut takes every row when
fewer than `m` scored (the collection is then no larger than the window)
rather than dropping what the column cannot rank.

**What can raise, and where** — the spatial ERRORS rule, restated for
the probe path. §8.15 raises `JQ2001` for a member that is not an array
(a string, an object, a typed array held as an object); the column is
`NULL` for such a member (MODEL-FORMAT §3.2), so below the scored cut
the row is never fetched and never raises, and past it (the full fetch)
the engine raises as it would have. An ABSENT member is not that case:
its key is the empty sequence before the operand is checked, the column
is `NULL`, and both executors place the row in the tail. A store that
wants the engine's refusal for every row keeps `compileSchema` injected
— the vector column only exists over a member the schema types `array`
and nothing else, which is what makes the two agree on every row it
does fetch.

**The probe.** A literal vector must be a DECLARED width at plan time
(another width is not recognized, and the reason says both widths). An
external probe's width is only knowable when it is bound, so the plan
carries one ALTERNATIVE per declared width over the member — one emitted
statement each, prepared once and kept with the plan — and the bind
picks the alternative whose width the probe has. A `CASE` across the
columns would read every one of them per row, and a statement per call
would give up the prepared cache; neither is emitted. A bound value no
declared width takes — another width, a non-finite component, not an
array at all — DIVERTS the call to the full-collection residual, where
the engine answers what it answers everywhere (empty keys, so the
secondary keys order every row; or its own `JQ2001` for a non-array).
The plan never raises on the engine's behalf.

That diversion is correct and it is expensive: the residual reads every
document, and `explain()` still reports `knn`, because the plan is the
shape and the bound value is not part of it. So the fallback is
COUNTED — `collection.stats().knn.diverted` — which is the only surface
on which a probe arriving at the wrong width from a model or a form is
distinguishable from a query that ran the cut. A rising `diverted` beside
a flat `queries` is a caller embedding through the wrong model.

**Preconditions, each named in `explain()`.** The selection must be
pushed whole — every `$where` conjunct exact, nothing before it — because
a conjunct left to the residual could drop a candidate the cut counted,
and an implied conjunct narrows to a superset the residual then shrinks;
either could leave the window short. The ordering's first key must be
the `$similarity`, descending, under `$empty: 'least'`; the window must
have a finite limit (an unbounded ranking is a full sort, and the engine
does it over the whole collection, said so). Further keys are the
engine's business. With `strict: true` the shape is `JD0010` naming the
rank: the order is engine work, the same honesty as a spatial
refinement.

### The temporal plan (series)

Time needs no storage kind here. The physical declaration is the
composite JSONPath index a model already has —
`{ "name": "by_series_at", "path": ["$.series", "$.at"] }` — over a
numeric epoch member, and the whole of `src/series.js` is deciding
which questions that index answers. There is no `derive: 'series'`, no
column type, no host function and no extension.

A B-tree seeks exactly as far as its leading columns are decided: a run
of equalities, then at most one range. So the index that a temporal
plan reports is the declared one with the longest leading run of
columns an equality PINNED whose next column is the instant the query
ranges over. Three shapes follow from that, and they are closed:

| shape | the document | the plan |
|---|---|---|
| **range** | every leading column pinned, a half-open range on the instant, ordered by it | native — `SEARCH … (series=? AND at>? AND at<?)` |
| **as-of** | the same prefix with ONE instant bound, ordered by the instant, under a finite window | native — the index read backwards, one row |
| **bucket** | a `$groupby` over `$time-bucket`, or a `$resample` whose spec asks for nothing more | native — `GROUP BY` over `at - (((at - origin) % every + every) % every)` |

The ladder is integer arithmetic all the way down, and the non-negative
remainder is why: a truncating division puts an instant before 1970 in
the bucket AFTER its own. The width and the anchor are read through the
kernel's own `compileBuckets`, so `'PT1H'` and `3600000` are the same
ladder and the default anchor is the kernel's rather than a second
guess at it; an `{ offset }` calendar context folds into the anchor,
because a constant number of minutes east is arithmetic. A named zone
never does: its clock is host code the database does not have.

Everything else is a **named refinement** — the implied-conjunct
pattern again, applied to a whole operator. The planner narrows the
fetch by whatever the frozen spec makes provable and the residual, which
is the ENGINE running the caller's own document, decides:

| operator | what bounds the fetch |
|---|---|
| `$overlaps` over a declared interval | the half-open conjunction over the two bound columns, plus every row the operator RAISES on (below) |
| `$resample` (fill, calendar, `first`/`last`) | the spec's own `start`/`end`, plus the operand's `$where` |
| `$rolling` | the operand's `$where` alone — a window measured in time answers once per input instant |
| `$asof` with the collection on the RIGHT | the probes' own span (`at <= max` backward, `at >= min` forward, both sides under a `tolerance`) and a membership test over the probes' `by` keys, plus the ANCHOR below |
| `$asof` with the collection on the LEFT | nothing — a join answers once per LEFT row, so every left row is needed |

The as-of bound is a FIXED number of statements, whatever the probes
number, which is what `test/db/statement-count.test.js` pins: the
failure mode a batch exists to refuse is one seek per left row.

**The anchor.** Without a `tolerance` the open side has no bound the
probes imply: the row that answers the earliest probe is the last one at
or before it, however far back that lies. The tight bound is the data's
own, so the plan ASKS for it — `plan.seeks` carries one aggregate read
through the same declared index, and the statement binds its answer
through the typed slot (`emit.js`'s fourth `ParamSlot` kind), which
needs no bind-time type branch because the column's type is declared.

Per group the anchor is `MAX(at) WHERE at <= min(probes)`; the scalar is
the LEAST of those over the groups. A single global `MAX` would be
unsound — it can come from one group and drop another group's only
candidate — and matches only move forward as the probe does, so no row
below the fold can answer any probe. The comparison stays inclusive, so
rows sharing the anchor instant reach the kernel and its duplicate rule
decides among them. A seek that finds nothing binds its own probe: it
proved there is no row on that side. `forward` anchors the other end,
`nearest` both, and a `tolerance` asks for none — arithmetic already
closed both sides. What the anchor saves depends on where the probes
sit; `benchmark/series.js` publishes the candidate count beside the
timing rather than netting it out, over probes spread evenly across the
whole span, which is the anchor at its worst.

**`$overlaps` and the row that raises.** Two half-open spans share an
instant when each starts before the other ends, which over declared
bound columns is two comparisons the emitter already spells. What makes
it a pre-filter rather than an exact translation is the kernel's other
half: a span that is empty or reversed is not `false`, it RAISES
(`JQ2001`). A conjunction alone would drop `[500, 100)` for a probe of
`[100, 200)` — answering where the engine errors, which no pushdown may
do — so the statement keeps every row whose own span is inverted
(`start >= end`) and the operator decides over the candidates. That
disjunct compares two COLUMNS, which no index bounds, so the fetch
scans; what it still buys is that the pruned rows never reach the
engine at all. The other malformed cases are SCHEMA ones, exactly as the
spatial promotions' precondition is: the member must be typed as an
object whose `start` and `end` are both REQUIRED and both numeric, and a
write is validated against that schema, so a bound that is absent,
textual or null is a row the collection cannot hold. An unmapped pair,
an untyped one, or a probe that is not itself a half-open span pushes
nothing and names why. ROADMAP carries the declared-interval `CHECK`
that would make the conjunction exact and the fetch a seek.

**Reading a declared column without its guard.** A temporal refinement's
own bounds (`p: 'colCmp'`) carry no `json_type` beside them: the model
declared the column, the comparison only NARROWS, and the kernel decides
over what comes back. Without that, the statement parsed every scanned
row's document to discriminate a member the column already carried — at
the benchmark's largest shape that guard was most of the fetch's cost.
Narrowing is what makes it safe: SQL's own ordering keeps a row the
guard would have dropped, never the other way about.

**A group with no instant.** A row whose instant member is missing or
is not a number groups under SQL `NULL`; the kernel REFUSES such a row
(`JQ2001`). SQL cannot refuse, so a native bucket that meets one hands
the whole question back — the full-collection residual, where the engine
answers what it answers everywhere — and the fallback is COUNTED as
`collection.stats().series.diverted`, the same honesty the k-nearest
divert has.

**`explain().series`** is `null` unless the document asked a temporal
question, which it does by naming a §8.16 operator or by being the
closed range/as-of shape over a COMPOSITE instant index. (A singular
index over an ordinary member cannot make a query temporal: nothing in
a column says "instant", and inventing one would make every `age > 21`
a temporal plan.) It carries `{ mode, operation, index, prefix, range,
ladder, aggregates, refinement, reasons, counts }`. `mode` is
`'native'` (the statement alone answers), `'hybrid'` (the database
narrows and a kernel decides) or `'engine'` (the database narrowed
nothing). `reasons` is `{ code, reason }` where the code is the first
word of the sentence, so the machine-readable code and the sentence
`strict: true` prints cannot drift apart. `counts` is the LAST ACTUAL
execution's `{ statements, candidates, results }` and is `null` before
the document has run once — an estimate mislabelled as a count is
exactly what an honest explain may not print.

### The two residual modes

- **Row residual** — only the projection is untranslated: predicates,
  ordering and the window are fully pushed; each fetched row runs
  `{ $for: { <the document's own binding>: '$[*]' },
  $return: [ <the document's $return> ] }` (the array wrapper keeps
  array-valued items unambiguous) and the items concatenate in row
  order. Streams. **The planner emits that one-row document whole**,
  binding included, rather than handing the projection to be re-wrapped
  elsewhere: the wrapper must bind what the projection references, and
  only the planner knows what the caller called it.
- **Set residual** — anything else: the pushed predicate conjuncts
  narrow candidates (`$and` splits; a partially translatable `$or`
  does not), and the WHOLE original compiled document runs over the
  materialized candidate array. Re-applying pushed conjuncts is
  idempotent, so pushdown is pure narrowing. Reported as a barrier.
- **Set residual over a cut** (`knn`) — the same whole-document
  re-run, over a candidate set an ORDERING chose rather than a
  predicate (the k-nearest plan above). A barrier too, and
  `stats().knn` counts the rows scored and the candidates kept per
  query, so a collection of many exact duplicates is visible rather
  than merely slow.

### `explain()`

Extends `compileJsonQuery(...).explain()`'s shape — `{ externals,
operators, functions, collations, limits }` — with `{ mode, sql, params,
indexes, prefilters, rank, residual, barriers, scanNarrative }`. `mode`
is `'native' | 'row' | 'set' | 'knn'`. `params`
lists the bound slots in order (external names, literal markers, and
derived slots naming the external and box axis they compute — values
are ALWAYS bound, never interpolated). `indexes` names the declared
indexes whose generated columns the pushed predicates and ordering
touch, and the `scanNarrative` is the database's own `EXPLAIN QUERY
PLAN` prose so the claim is checkable against the engine that will run
it. `prefilters` is the implied conjuncts —
`{ construct, via, columns, exact }` each — because whether a declared
index is earning its keep is not readable from `sql` alone, and because
`indexes` says what a predicate TOUCHES while the narrative says what
the database will DO. `via` is `'columns'` or `'rtree'`: which physical
realization of a `bbox` column set actually ran, which is not always
what the model declared — a build without the R\*Tree module falls back
and this is where it says so (MODEL-FORMAT §4). Under `'rtree'` the
`columns` member names the virtual table's own columns and `indexes`
names the virtual table. `rank` is `null` or the k-nearest stage —
`{ column, dims, probe, limit, offset, margin, decides: 'engine' }` —
what the fetch reads, the window the cut serves, the margin it keeps,
and who decides the order (always the engine). `series` is `null` or
the temporal record ("The temporal plan" above), whose `counts` are the
last ACTUAL run's rather than an estimate. `estimatedRows` is ABSENT on SQLite drivers — the capability slot
is empty and no number is fabricated. `residual` is `null` or
`{ mode: 'row' | 'set' | 'knn', reasons: [{ construct, reason }] }` with
reasons drawn from the deliberate-residual table. With
`strict: true`, any residual is instead the compile error `JD0010`
naming the forcing construct.

### The UDF escape hatch (capability-gated)

Between native SQL and pulling rows sits registering a compiled
predicate conjunct as a deterministic function used in the `WHERE`
clause. Gated on `capabilities.userFunctions` (absent on Bun by
construction) and applied only to fragments with no externals, no
functions and no collations — deterministic and side-effect-free by
analysis, not by hope. The fragment is a raw conjunct over the caller's
collection binding, so the planner passes that binding's **name** in:
wrapped under any other name every reference would read as an external,
the determinism rule would reject the fragment, and the hatch would
silently not engage — no error and no reason in `explain()`.
Registration is keyed by `semanticKey(fragment)` (the
order-insensitive identity from `@jarenjs/core/object`) so identical
fragments share one registration, and the planner MUST
produce a correct plan with the capability disabled (tested that way).
Preference order: native SQL → deterministic function → residual, and
`explain()` names the choice. **Index-form UDFs are deliberately not
part of this**: an index over a registered function makes the database
unwritable from any connection that has not registered the identical
function — a WHERE-clause UDF carries no such schema dependency, and
that operational hazard is why the model format declares no
UDF-expression indexes.

### The statement cache

A caller of the core primitives, not an eighth implementation:
`createSemanticCache` keyed by the whole discriminating tuple — the
document plus collection, dialect, strictness, the pushdown switch and
the profile — where the identity is the tuple's COMPLETE
serialization, never a fingerprint of it: a 32-bit content hash
collides after tens of thousands of documents, and a collision here
answers one query with another query's plan and rows (the
cache-identity test exists to keep that key abolished).
`store.stats()` exposes hits, misses and evictions so the cache is
proven rather than assumed.
`store.stats()` exposes hits, misses and evictions, so the cache is
proven rather than assumed.

## The relational half (`src/model.js`, `src/plan.js` §entities, `src/query.js`)

The same planner, a second document kind: entity query documents
address the multi-entity root (`$.User[*]`), the ONLY shape a
differential oracle can prove (the engine has no embedded relation
members to walk — which is why relation-name sugar is deliberately
absent from the query surface and lives on `load`). Three reference
flavors decide emission: entity COLUMNS get total forms with no
`json_type` guard (a mapped property has no present-null), entity
EPOCH columns get a ±1 s index range plus the exact document-string
recheck (mixed stored precisions can never diverge from the engine's
codepoint order), and everything else rides the phase-A guarded truth
table aliased per binding. Two-binding equijoins emit INNER JOIN with
binding-order row-identity tiebreakers — exactly the engine's
nested-loop order. The graph loader compiles include trees to
correlated `json_group_array`/`json_object` subqueries: one statement
per load, proven by a counting driver, never promised.

## The unit of work (`src/tracker.js`)

Materialised entities are deep-frozen plain JSON and the frozen
document IS the snapshot — one retained reference, structural sharing
made safe by the freeze. `saveChanges()` diffs with the suite's own
diff engine and maps operations to minimal statements (column writes,
`jsonb_set` chains, join-table key-set sync, a counted whole-row
fallback); inserts batch parent-first, deletes run child-first,
foreign-key cycles among the changed set are `JD0040`, and a declared
`version` property turns every update into an optimistic
`WHERE version = ?` with `JD2040` on conflict. A save that FAILS leaves
the tracker exactly as it was, so it retries; a save whose statements
all succeed advances at once — inside an enclosing transaction too,
where the database already holds the rows — and registers the exact
withdrawal of that advance on the owning scope, whose rollback takes it
back so the retry plans the same statements again.

## The migration engine, relationally (`src/migrate.js`, `src/cli.js`)

The strategy-table diff renders SELF-CONTAINED steps — additive
columns, data steps, and one rebuild implementation following
SQLite's documented twelve-step procedure with `foreign_key_check`
inside the transaction. Shape EQUALITY (schemaShapeOf versus a fresh
createModelShape build) is the acceptance criterion, asserted on the
shadow before the real database is touched and again after. Probed
and designed around: node:sqlite enables foreign keys BY DEFAULT (the
pragma bracket is load-bearing), `jsonb()` PARSES its argument
(column folds pass plain SQL values), and a table rename does not
rename columns (join tables rename their endpoint keys explicitly).

## One cross-runtime seam worth remembering

`bun:sqlite` answers **null** for a missing row where `node:sqlite`
answers undefined; the bun adapter normalizes at the seam (and the
bun-shaped test double mimics the null so the packed run pins it).
Found by the ORM benchmark's first real-Bun file-store open — the
in-memory tests never reopen a database, so create-or-verify had
never seen bun's null.

## Change capture (`src/capture.js`)

Every committed write becomes an ordered stream of RFC 6902 patches.
Two sources behind one contract: SQLite's **session changeset** where
the binding exposes `createSession` (node:sqlite), parsed from its
binary format by a hand-written decoder; a **write-path journal**
where it does not (bun:sqlite, the wasm build), buffering before/after
documents as the store writes them. Both net ONE op per row — insert+
update coalesces, insert+delete vanishes, an update back to the
original emits nothing — so the two modes agree as SETS (a differential
test pins it). The journal's netting was added when the wasm parity
suite ran a same-row multi-op transaction the original differential
script never wrote. Op order within a record is UNSPECIFIED; every op targets
a distinct pointer. The persisted `_jaren_changes` log rides the same
transaction as the writes it describes; a caught inner-savepoint
rollback truncates the journal buffer to its checkpoint. Overhead is
measured and published: capture off ~6µs, journal ~17µs, session ~69µs
per single-op commit, amortizing across a transaction.

## Live queries (`src/live.js`, `src/live-time.js`, `src/window.js`)

A live query classifies its document against the normative maintenance
table by reading the COMPILED PLAN — translated filters, order terms
and aggregates are exactly the planner's, never re-derived. Five
strategies: incremental **rows** (per-key items, arrival order), the
maintained **window** (all matching rows sorted, ties by key token, a
delete inside the visible slice answered without re-query), running
**accumulators** (per-row contributions retained so a capture `remove`
— which carries no old value — is still answerable; min/max recompute
over contributions when the extremum's holder leaves), per-group
**deltas** (the accumulator machinery once per group), and **re-run**
for everything else — declared, reported through `live.mode`, never
silent. A plan that fell to the set residual ONLY for a spatial
refinement (a pushed box or cell range with the exact predicate left
to the engine) is still the rows strategy — the geofence: the fetch is
index-narrowed and per-row re-evaluation IS the exact test — while an
ordering or an aggregate beside such a refinement re-runs, the
refinement never being the reason named. Invalidation matches a record
by table plus pointer prefix,
over-approximating toward re-evaluation (a missed update would be a
correctness bug; an extra one is only slower). Emissions preserve
reference identity for untouched rows — the O(k) renderer's contract —
proven by a seeded oracle that holds the maintained result equal to a
fresh re-query after every mutation. Incremental beats re-run 13× at
1k rows, 51× at 10k.

**Event time** (`src/live-time.js`) adds two more strategies for the
one document shape whose answer is a function of instants rather than
of rows: a `$resample` bucket state and a `$rolling` window state, both
over a FIXED width. There is no clock under either — the watermark is a
finite epoch the host supplies and `advance()` is the only way it moves
— and both fold through `@jarenjs/core/series` itself rather than
carrying a second aggregate, so a maintained answer cannot drift from
what a fresh query gives. A write touches one bucket (two when it
crosses a boundary) or the windows ending in `[t, t + width)`, and
exactly those are recomputed. Everything a per-key state cannot place
exactly re-runs with its member named: a calendar ladder, a named zone,
a `locf`/`linear` fill, a `first`/`last` aggregate, a retention under
`width + allowedLateness`. A reading behind the lateness boundary is
never folded in silently — the view re-reads and the emission carries a
`lateData` record — which is the one place this layer spends a full
re-query to keep a promise rather than a number.

## Durable runs and the job queue (`src/jobs.js`, `src/dag-job.js`)

The queue's correctness story has two halves. The claim UPDATE selects
the earliest eligible row (pending, failed, or an expired lease — so
recovery IS the next claim, not a sweeper) whose kind the worker
registered, MINTS the fence — a fresh opaque `lease_token` and the next
`lease_generation` — sets the row leased with a deadline, and RETURNs
it. One statement is one transaction, so no two workers claim the same
job without any distributed lock. Every later settling transition —
renew, checkpoint save, complete, fail — then wears the fence:
`state='leased' AND lease_token=? AND lease_until > ?`, the token plus
CURRENT validity, never the owner (one worker reuses one owner for
every attempt it ever makes, so an owner cannot say which attempt is
speaking). A lease is immutable — `renew` answers a replacement and the
superseded token settles nothing — and a guard that matches nothing is
a coded refusal naming which of the three reasons applied (`JD2065`
settled/unknown, `JD2066` superseded, `JD2067` expired), never a silent
`false`. A renewal that fails for any OTHER reason is a storage problem
the next renewal may survive; only the three fence codes prove loss.
Checkpoint rows are stamped with the attempt's generation: `load` reads
up to it, and a settlement prunes no further, so a stale attempt cannot
erase a live one's work. Execution stays at-least-once; settlement is
exactly-once AGAINST THE STORE (proven by four workers on four
connections over one WAL file) — an external effect a handler already
made is still the handler's to make idempotent. Ownership follows the
handle: root `store.jobs.*` and all worker control I/O take the store
gate, while `tx.jobs` runs as its exact transaction scope — the
transactional outbox. The `@jarenjs/flow` composition injects
`compileDag` (db never imports flow — an import-graph test enforces it)
and binds a per-ATTEMPT checkpoint store that follows the current
lease; a DAG run's completion records the result, marks the job done
and prunes the checkpoint rows in ONE transaction, so a crash resumes
from its checkpointed nodes rather than restarting, and a resume must
match the persisted workflow revision and input hash (`JD2069`).
Non-goals stated plainly: a shared SQLite file over a network
filesystem is not a safe coordination substrate.

## The wasm driver (`src/drivers/wasm.js`)

An injected handle, never an import: the host loads the official
SQLite wasm build and this driver adapts its `oo1` object API — which
is SYNCHRONOUS in a dedicated worker over the SAH-pool OPFS VFS, which
is exactly what keeps journal capture, live queries and the job queue
working unchanged in a browser. The engine parity is proven in Node
against the real wasm bytes (the full pushdown oracle, entities, live
queries, jobs, a shadow-verified migration); the browser suite proves
the ENVIRONMENT — OPFS persistence across reloads, the owner topology
(one context holds the sole connection, tabs are clients over a
BroadcastChannel), and the second-writer refusal — across Chromium,
Firefox and WebKit, with the memory fallback stated where OPFS is
absent — and the spatial corpus, run entry by entry through the data
studio's throwaway-store operation, holds the wasm build to the
JavaScript engine's recorded answers in every one of those engines,
OPFS or not, because an entry seeds its own store and needs execution,
not persistence.

## Operating the store (`src/pragmas.js`, `src/maintenance.js`, `src/backup.js`, `src/cancellation.js`, `src/errors.js`)

The operability surface is five small modules and one rule each,
consumed by `src/store.js` and never reached by a query:

- `src/pragmas.js` — the closed table of configurable connection
  pragmas (option name, SQL spelling, validator, read-back mapping,
  default, the two store-kind flags). The open sequence applies the
  requests in table order and reads every declared pragma back; an
  explicit request the engine did not take refuses the open, a default
  it could not take is reported as read. The dialect spells exactly one
  set statement and one read statement for it.
- `src/maintenance.js` — `checkpoint`, `integrityCheck`,
  `foreignKeyCheck`, `optimize` over a connection, answering the engine's
  own row as typed data; availability per operation is the binding's
  declaration and, for the two that write, the store's read-only flag —
  refused by code exactly where the report says `false`.
- `src/backup.js` — the online backup over the driver's primitive triple
  (`copy`, `rename`, `remove`; the Node binding's), written to a
  temporary sibling and renamed only at verified completion, cleaned up
  on every other branch. The root closure imports no builtin: the
  primitives are the driver's.
- `src/cancellation.js` — the one check every lifecycle runs between its
  units of work (a statement, a row, a step, a batch, a page), on the
  clock the caller was given; each lifecycle owns its abort code, the
  deadline code is one. `capabilities.cancellation` states the
  granularity per lifecycle and that nothing interrupts mid-statement.
- `src/errors.js` — `classifyDriverError`, the one table every path
  consults (writes, the query engines through their boundary and the
  cursor's `wrap`, maintenance and backup under their own code, the open
  sequence): class, retryability, code. The query path's only special
  case is the int64 overflow of a pushed aggregate, answered by the
  engine as a coded residual.

The open path itself creates or verifies the shape inside an IMMEDIATE
transaction with idempotent DDL (one dialect spelling, applied on the
open path only) and retries once on a classed busy failure, so two
processes creating one fresh file never meet the deferred-upgrade
`SQLITE_BUSY` the busy handler cannot retry. The job queue's
administration (`page`, `cancel`, `requeue`, `sweep`) lives in
`src/jobs.js` beside the fence it authorises through (JOBS-FORMAT §10).
