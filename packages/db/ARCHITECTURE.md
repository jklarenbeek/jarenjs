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

A single-binding FLWOR over the collection (`$for: { it: '$[*]' }`)
with: comparison predicates (`$eq $ne $lt $le $gt $ge`) between a
singular member path and a literal or external; `$and`/`$or`/`$not`
composition; `$exists`/`$empty`; `$starts-with`/`$ends-with`/
`$contains` on schema-typed string paths with literal patterns;
`$orderby` over singular schema-typed paths (`$dir`, `$empty`, no
collation); a top-level `$subsequence` window with literal bounds; the
top-level aggregates `$count` (bare-binding return only) and
`$sum`/`$avg`/`$min`/`$max` over a singular schema-typed path; and the
whole-document projection `$return: '$it'`.

### The deliberate-residual table

| construct | reason |
|---|---|
| `$let` bindings, `$fold`, `$groupby`, positional/window bindings | no equivalence proof exists yet; residual by default |
| a second `$for` binding, joins, non-singular path expansion | one relation per plan in this version |
| `$match` and other unlisted operators, `$call` | no native spelling proven equivalent |
| `$orderby` with a `$collation` | a collation the dialect cannot reproduce is refused, not approximated |
| projections other than `'$it'` | run per row (the row residual) — pushed, ordered and windowed rows, projected by the engine |
| string operators with an external pattern | the pattern's type is unknowable at plan time and the engine ERRORS on non-string patterns |
| comparisons where both sides are paths | join territory |
| array/object literals in comparisons | deep-equality has no guarded native form |
| spatial predicates | no spatial index vocabulary in the model format |

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
| `$starts-with` path, string | `jt = 'text' AND substr(v, 1, length(?)) = ?` |
| `$ends-with` path, string | `jt = 'text' AND (length(?) = 0 OR substr(v, -length(?)) = ?)` |
| `$contains` path, string | `jt = 'text' AND instr(v, ?) > 0` |

The guards make the forms sound for typed AND untyped paths alike —
the schema type's job is choosing the generated COLUMN (the index),
never weakening the guard. Two documented preconditions: string
operators, aggregates AND ordering are only promoted on schema-typed
paths because the engine ERRORS on non-conforming operands where SQL
would coerce or sort — a stored `null` under an ordered key, a
non-string under a string operator — so on an unvalidated store, rows
violating the collection schema can make the engine throw where the
database answers; keep `compileSchema` injected if that distinction
matters to you.

**Bind-time diversion.** SQLite cannot bind a boolean, and a
`null`-valued external needs Jaren's null semantics, not SQL's. At
execute time, if any referenced external is missing or not a string or
finite number, the call runs the always-compiled set residual instead
of the native statement — same answer, one branch, no wrong-typed SQL.

### The two residual modes

- **Row residual** — only the projection is untranslated: predicates,
  ordering and the window are fully pushed; each fetched row runs
  `{ $for: { it: '$[*]' }, $return: [ <the document's $return> ] }`
  (the array wrapper keeps array-valued items unambiguous) and the
  items concatenate in row order. Streams.
- **Set residual** — anything else: the pushed predicate conjuncts
  narrow candidates (`$and` splits; a partially translatable `$or`
  does not), and the WHOLE original compiled document runs over the
  materialized candidate array. Re-applying pushed conjuncts is
  idempotent, so pushdown is pure narrowing. Reported as a barrier.

### `explain()`

Extends `compileJsonQuery(...).explain()`'s shape — `{ externals,
operators, functions, collations, limits }` — with `{ sql, params,
indexes, residual, barriers, scanNarrative }`. `params` lists the
bound slots in order (external names and literal markers — values are
ALWAYS bound, never interpolated). `indexes` names the declared
indexes whose generated columns the pushed predicates and ordering
touch, and the `scanNarrative` is the database's own `EXPLAIN QUERY
PLAN` prose so the claim is checkable against the engine that will run
it. `estimatedRows` is ABSENT on SQLite drivers — the capability slot
is empty and no number is fabricated. `residual` is `null` or
`{ mode: 'row' | 'set', reasons: [{ construct, reason }] }` with
reasons drawn from the deliberate-residual table. With
`strict: true`, any residual is instead the compile error `JD0010`
naming the forcing construct.

### The UDF escape hatch (capability-gated)

Between native SQL and pulling rows sits registering a compiled
predicate conjunct as a deterministic function used in the `WHERE`
clause. Gated on `capabilities.userFunctions` (absent on Bun by
construction) and applied only to fragments with no externals, no
functions and no collations — deterministic and side-effect-free by
analysis, not by hope. Registration is keyed by `contentKey(fragment)`
so identical fragments share one registration, and the planner MUST
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
`createBoundedCache` keyed by `contentKey(document)` plus collection,
dialect and strictness. `contentKey` is the memo-grade key
(`hashContent(stableStringify(x) ?? '')` — drops `undefined` members,
no cycle guard; both properties acceptable for a cache key), never
`canonicalizeJson` (signature-grade, throws on `undefined`).
`store.stats()` exposes hits, misses and evictions, so the cache is
proven rather than assumed.
