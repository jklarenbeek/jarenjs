# @jarenjs/db — architecture

The package separates Store behavior from driver ownership and dialect spelling.

## The driver seam (`src/driver.js`, `src/drivers/*`)

A driver is `{ name, dialect, open(path, options) }` returning a Connection
(`docs/MODEL-FORMAT.md` §4). Runtime bindings live behind public Node, Bun, wasm,
PostgreSQL, Node worker and Node pool subpaths. Node and Bun builtins load lazily
inside `open()`, so importing a subpath remains portable and an unavailable
binding becomes `JD0003`. The worker endpoint's static Node imports are reached
only when the Node worker factory launches that endpoint.

Worker protocol, scheduling and snapshot storage sit below `finishConnection`;
query planning, capture and transaction scopes remain in the Store. Compiled
operation metadata classifies reads for the pool. The wasm oo1 adapter shares one
session mapping across OPFS and atomic IndexedDB snapshots. [Execution hosts](docs/HOSTS.md)
documents bounds, native-call shutdown limits, capability probes and measurements.

Every connection and statement method may return a value or a promise.
The store composes through the sync-capable `chain` helper, which
applies a continuation without allocating a promise when the driver
answered with a value — the public asynchronous surface then lifts
exactly once per call. Where the connection is synchronous the same
operation cores are exposed promise-free under `store.sync`; where it
is not, `store.sync` is absent rather than stubbed.

The driver layer also owns prepared-statement lifetimes. Its private
`createStatementOwner` retains a preparation across calls; each `use` borrows it
through preparation and operation settlement. `retire` releases it only after
the final borrow, and a later use prepares an independent temporary statement.
The relational and semantic query caches delegate eviction to this owner. Failed preparations are
forgotten so a deliberate later call can retry. `useStatementOnce` handles
temporary preparations; both owners share settlement and best-effort optional
finalization, preserving synchronous returns and the operation's original error.

Capabilities are probed once at open (version, compile options,
binding declaration) and frozen. Two slots — `statementTimeout` and
`rowEstimates` — are `false` on every SQLite driver because the
underlying facts do not exist there (no interrupt, no progress
handler, no estimate API). They are part of the contract so a driver
that has the facts can fill them without a contract change: the
PostgreSQL driver fills `rowEstimates`, because its planner answers a row
estimate for a statement, and `explain()` then reports that number with
the label that says whose it is.

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
rather than syntactic, and live in the CONNECTION capability table
instead: whether functions register per connection, whether change
capture exists and in what form, and whether tables can be
restructured in place.

The dialect has a capability table of its own, and it is a closed set
(`DIALECT_CAPABILITIES`): `createDialect` refuses a name outside it, so
a misspelled capability cannot read as a quiet `false` on the engine
that has the feature. Every entry answers a SYNTACTIC question — does
this engine have a binary JSON type, indexable generated columns, a
column with no scalar type, `RETURNING`, upsert, savepoints, an
up-front write lock, a result alias in `GROUP BY`, in-place `ALTER`,
virtual tables, triggers, a configuration vocabulary, a stored CREATE
text, always-on referential integrity, an insertion-ordered row
identity, an index function the database itself holds. What the store does where the answer is `false` is a
FALLBACK or a coded refusal on the common path, never a skip:

| Capability off | What the common path does instead |
|---|---|
| `pragmas` | no configuration statement is issued; an explicitly requested pragma is `JD0007`, a defaulted one is dropped, and the effective record reads `null` throughout |
| `declaredSqlText` | the drift check is the structural one — columns and their types, indexes and their covered columns in order, foreign-key tuples — plus what the catalog reads back exactly in place of the CREATE text (the dialect's `readBack`): each index's condition and shape and each generated column's expression; an object the model never declared is no longer detectable |
| `foreignKeysAlwaysOn` (on) | the open path neither sets nor reads back the referential-integrity switch |
| `virtualTables` / `triggers` | a `physical: 'rtree'` column set maps back onto the B-tree over the four edge columns, and `explain().prefilters[].via` says so |
| `untypedColumns` | a comparison against a member the schema does not type reads the member out of the document instead of the column: same answer, unindexed |
| `indexableGeneratedColumns` | the derived-column mapping is the STORED one — the store writes the values and the columns are ordinary |
| `rowIdentity` (with a declared identity column) | the dialect adds that column to every table it creates, and it IS `rowIdentity()` |
| `catalogFunctions` | an entity index over a declared expression is `JD0004` where its table is planned, naming the index, its members and the repair: a function only the registering connection computes would leave every other writer unable to write the table (MODEL-FORMAT §7A) |
| `immediateTransactions` | `mode: 'immediate'` takes no lock before the body, and a read-then-write body takes its row locks when it writes; no shipped dialect answers `false` any more |

Two subsystems say so on the connection rather than in the dialect,
because they write their own statements: the durable job queue
(`capabilities.jobs`) and the change ledger (`capabilities.changeCapture`),
each with a SQLite and a PostgreSQL implementation. Opening a store that asks for either on a connection that
declares it absent is a coded refusal at open — `JD0003` and `JD0051` —
not a failure at the first statement.

`test/db/dialect-conformance.js` is the kit every dialect passes: it
asserts behaviour rather than text, because a second dialect that
passed a golden-SQL comparison would have to spell PostgreSQL the way
SQLite spells it. A quoted identifier cannot close its own quoting; a
write statement binds through the dialect's own parameter form; a
generated column carries the storage word its engine has; an optional
feature is absent in BOTH halves or present in both.
`test/db/dialect-census.test.js` is the other side of the same claim: a
character scanner reads every string and template literal of every
module, keeps the ones that begin as SQL, and fails on a SQLite
spelling outside `src/dialects/` and `src/drivers/` unless the module
is named — with the capability that makes it honest — in a short
approved list.

There are two dialects, SQLite and PostgreSQL, and a third is not planned
until a consumer names one. The seam makes a third dialect's SQL a contained
job, but its cost is everything behind the seam: passing the differential
oracle, and a job queue and a change journal with their own concurrency and
coverage proofs, each qualified on a real server. A capability flag set
optimistically to skip one of those would turn a coded refusal into a wrong
answer. A host on another engine reads and writes through its own driver and
hands the documents to the query engine, which answers over any JSON.

The SQLite dialect stores documents as JSONB in a `BLOB` column of a
`STRICT` table, projects each indexed path into a virtual generated
column over `jsonb_extract`, and renders reads back to text through
`json()`. Parameters are positional because every shipped binding
binds arrays.

### The PostgreSQL dialect (`src/dialects/postgres.js`)

`postgresDialect()` is the second spelling, and the reason the contract
above exists. It imports no client and no runtime builtin, so
`@jarenjs/db/postgres` resolves in a browser bundle and type-checks with
nothing installed; transport is the injected driver's business.

Documents are `jsonb`. An indexed path becomes a **STORED** generated
column — PostgreSQL has no indexable virtual one — typed from the
schema, and its expression guards the member with `jsonb_typeof` inside
a `CASE`, because a generated column's expression must be IMMUTABLE and
a cast that can raise is not one: a document whose member is the wrong
JSON type stores `NULL` rather than failing its INSERT. Text columns and
text comparisons carry `COLLATE "C"`, which is byte order, which is what
SQLite's default `BINARY` collation is — without it the same half-open
prefix range would hold different rows on a server initialised in
another locale. Every table the dialect creates carries `rid bigserial`,
because a collection is a SEQUENCE and PostgreSQL has no per-row
identity that survives an UPDATE (`ctid` moves).

Three mapping decisions cost something, and each is stated rather than
worked around:

| Decision | Why | What it costs |
|---|---|---|
| `integer` and `number` are both `numeric` | `bigint` would reject a document the model accepts — `3.5` in a member the schema types `integer` — inside a generated column's cast, and a storage decision that can refuse a valid document is not one | introspection cannot tell the two apart on the way back |
| a `boolean` member is `smallint` holding 1 or 0 | the shared forms compare a boolean against those integers (a type test, a projected pair's type name); a `boolean` column would make each an operator-resolution error rather than a row | introspection reads the column back as a number |
| a path the schema does not type is `jsonb` | there is no honest scalar type for it, and `capabilities.untypedColumns: false` says so | a comparison against such a member reads the document rather than the column: the same answer, unindexed |

Three engine differences the emitter had to be taught, rather than the
dialect papering over:

- **The type discriminator's vocabulary.** `jsonb_typeof` answers six
  names; the row decoder reads SQLite's in JavaScript. The dialect maps
  the two that differ (`string` → `text`, `boolean` → `true`/`false`)
  and declares `numericTypeNames: ['number']`, which is what the
  emitter's numeric guard reads instead of `('integer', 'real')`.
- **An external operand's parameter.** A PostgreSQL parameter's type is
  resolved once for the whole statement, so one placeholder cannot be a
  text member's operand in one branch and a numeric member's in
  another — and the guard that keeps a row out of the wrong branch does
  not stop the COERCION, because `AND` does not short-circuit. The
  dialect declares `externalEncoding: 'json'`: the store binds the
  value's JSON text, and the two branches compare in a space that holds
  every scalar (text against text under `C`, number against number in
  `jsonb`'s own numeric order).
- **The typed extraction's own NULL.** Every typed form `jsonExtract`
  writes — and every typed generated column, which holds the same `CASE`
  — is `NULL` for an absent member, a stored JSON `null` and every other
  JSON type, so the dialect declares `typedExtract: true` and a literal
  or list comparison and a string operator read the value alone: its
  presence is the type guard, and `$ne` keeps presence through the
  member's JSON value. An untyped (`jsonb`) column and a declared
  expression column are not such a `CASE`, and neither takes the typed
  form. SQLite's `jsonb_extract` reads whatever the member holds, so its
  `json_type` guards stay load-bearing there; externals and type tests
  keep the discriminator on both engines.
- **One spelling for an index and a name.** `#>` takes the element `0`
  of an array and the key `0` of an object for the same path step (and
  `-1`, `+1` and ` 1` for array indexes), where the engine's path and
  SQLite's select an element by index and a member by name alone. A query
  reads a path with such a step from a document guarded on each parent —
  `queryGuard`, a dialect member, and the
  `queryDocument` it yields — so a document whose container is the other
  kind is no document and the member is absent, in an entity's document as in
  a collection's; a path with no such step is written as it always was.
  Wherever the schema leaves the step's container open (no declared `type`:
  `items` binds arrays alone and `properties` objects alone, so the other
  kind conforms) the generated column, an index expression and a declared
  interval's CHECK read the member through the same `queryDocument`
  (`columnRead`, planned on the column as `unpinned`), so a conforming
  document of the other kind holds nothing at the step, and a comparison or an
  ordering reads such a column as it reads any other (the plan's
  `guardedColumns`). The open keeps a column there only where it reads back
  the planned guarded definition: one a table holds unguarded (an earlier
  release's, or one created while the model declared the container) is read
  through the guarded document instead (`PlanRef.unpinned`). The declared
  interval's exact seek holds the document to the container beside its bound
  columns. A path whose container the schema
  declares (`type: 'array'` for an index step, `type: 'object'` for a digit
  name) is spelled as it always was, which is why such a database never
  reads as drifted. A table holds either spelling of a guardable path (a model
  that changes how it declares the container, or a table an earlier release
  created): the planned column and interval keep the other spelling as
  `alternate`, which the drift read-back accepts beside the planned text and the
  migration planner reads as no change (`acceptsColumn`: a column whose text is
  neither the other's nor its `alternate` is a change, so a guard for the other
  kind of digit step rebuilds it), and the interval reader accepts the
  CHECK with or without the guard (and only the guard its own path calls for).
  `memberPathOf` reads a step the guard makes into an object as a name, so a
  derived model opens the table it came from. `memberAt`, the store's own read of a span or of a
  derived column's member, selects an index step off an array and a name off
  an object's own members alone.
A fourth difference is a limit, not a spelling, and the planner and the
query layer enforce it rather than the emitter. PostgreSQL's planner
prices every leaf per row, and a chain long enough to cross its JIT
thresholds is compiled by LLVM, which checks for no interrupt, so a cancel
and a statement timeout wait for the compile to end. The dialect declares
`maxPredicateTerms: 128`; the planner counts the leaves once it has
regrouped (a comparison of two paths decided one family at a time counts a
leaf for each family the two share, and an inequality or a negated
comparison between a document member and an external operand, which
compiles several times slower than any other leaf, counts four, and a member's
membership in an external list counts sixteen, or four in its own column) and answers a document past the bound
in the engine, named
`predicate.termBound`, while a graph load and a native mutation, which
have no engine path, refuse it by name. SQLite declares none.

An identifier longer than 63 bytes is REFUSED rather than emitted:
PostgreSQL truncates one silently, and two generated column names that
share a prefix would become one, which is an index quietly serving
another path.

### Database → model (`src/introspect.js`)

`store.introspect(options)` — and `introspectModel(connection, options)`
under it — reads a live database's catalog and derives the
`jaren-model` document that would produce it, beside a report of
everything it could not.

It is **read-only**, and a statement trace is what says so: every
statement it issues begins `SELECT` (or `PRAGMA`, on SQLite). A derived
model is an ANSWER; applying it is the migration planner's job and the
operator's decision, and the two are deliberately not one act.

It **never claims a byte-perfect round trip**. A physical shape carries
less than the model that made it, and each gap is a report row with a
stable code, an object and a detail, sorted, once:

| code | what the shape does not carry |
|---|---|
| `document-members` | a document's unindexed members leave no trace, so the derived schema holds only what an index or the key names |
| `key-source` | a text key column cannot say which document member filled it; `identity: 'uuid'` is derived and `options.keys` supplies the pointer |
| `unmapped-view` | a view is not a shape a model can declare |
| `unmapped-table` | a table with neither a document column nor a key |
| `unmapped-column` | a generated column whose expression is not a member path this dialect wrote |
| `unmapped-index` | an index over an expression, a predicate the condition reader does not read back exactly, or a column no member path explains |
| `unmapped-constraint` | a CHECK that is not a complete scalar enum of a mapped entity column |
| `unmapped-type` | a column type no schema type maps back from — the member is derived untyped |
| `lossy-type` | a column type two schema types are stored as (SQLite `INTEGER`; PostgreSQL `numeric`, `smallint`) — the derived type is a choice |
| `ambiguous-relation` | a foreign key says which entity it points at; which side declared the edge, whether the other holds many, and under what name, is not in the shape — the relation is declared on the parent (the child, where the key is unique) and reported here |

Scalar entity enum CHECKs are recovered on both dialects. SQLite reads its
stored CREATE text; PostgreSQL reads `pg_constraint` expressions, including
its `ANY (ARRAY[...])` rendering and numeric literal casts. The parser accepts
only the entire enum expression. Unknown predicates, NULL lists, non-binary SQLite collations, nondeterministic
PostgreSQL collations and casts whose meaning is not proven remain `unmapped-constraint`. Partial indexes and
expression terms retain their catalog flags; they are never converted into
unconditional uniqueness. An entity's declared index is a property's flag
when it is the one-column index the flag plans under the property's own
`<Entity>_<member>`, and otherwise an entry of its `indexes`, a partial one's
condition read through the same reader the PostgreSQL open uses
(`readPredicate`; the dialect's `readBack.read` on PostgreSQL). Either way
it derives only where the index the model would plan is the one the database
holds, compared as every open compares it (`plannedDifference`): the stored
CREATE text on SQLite, with the condition `indexCondition` renders from the
reading; on PostgreSQL the catalog's `plain` flag — a B-tree of key columns
only, default operator classes, the columns' own collations, ascending,
nulls distinct, immediate — and the open's condition comparison. Every name
the derived entity plans is checked against the others as the store checks
them, ASCII case folded, so a derived index never claims more than the
database enforces and the derived model never names an object twice. Optional `introspect.checks`/`readChecks` hooks leave
injected dialects compatible with the earlier catalog surface.

`strict: true` refuses instead of returning a partial model, because a
caller about to diff the result against a declared model needs to know
the difference is real.

What IS exact: every index, by name and by covered member paths in
order; the type of every member an index covers, placed at the DEPTH
the path names it at (so `$.nested.deep` rebuilds
`nested.properties.deep`, and the column type round-trips); a
database-allocated integer key; an entity's primary key, its unique and
indexed columns, and its foreign keys with their on-delete behaviour.

Two things make the two engines answer the same question. The dialect's
catalog statements hand back tables, columns, indexes and foreign keys
in ONE row shape — so the IR in the middle is engine-neutral — and only
the dialect reads its own generated-column expression back into a member
path (`memberPathOf`), because only the dialect wrote it. Indexes come
back sorted by name on both, because a physical shape carries no record
of the order a model declared them in and a derivation that inherited
one engine's listing order would not be a derivation.

### The portability matrix

Everything a dialect may decline, and what the store does instead. A
`—` is a feature the engine does not have; the store's behaviour is the
common fallback, never a skip.

| Capability | SQLite | PostgreSQL |
|---|---|---|
| `jsonb` | yes (`BLOB` + the JSONB family) | yes (`jsonb`) |
| `generatedColumns` / `indexableGeneratedColumns` | yes, `VIRTUAL` | yes, `STORED` |
| `untypedColumns` | yes (`ANY`, also for a member of several types) | — (the member is read from the document; a member of several types has a column of its first type) |
| `returning`, `upsert`, `savepoints` | yes | yes |
| `immediateTransactions` | yes (`BEGIN IMMEDIATE`) | yes (`BEGIN`, then the store's advisory writer lock, `tx.writerLock`) |
| `groupByAlias` | yes | yes |
| `alterTableFull` | — | yes |
| `virtualTables` / `triggers` | yes (the R\*Tree mapping) | — (`physical: 'rtree'` maps back onto the four edge columns) |
| `pragmas` | yes (the closed set) | — (a server is configured by its operator) |
| `declaredSqlText` | yes | — (the structural check, and each index's condition and shape and each generated column's expression read back exactly) |
| `foreignKeysAlwaysOn` | — (set and verified per connection) | yes |
| `rowIdentity` | yes (`rowid`) | yes (the declared `rid` column) |
| `savepointStartsTransaction` | yes | — (a top-level transaction is `BEGIN`/`COMMIT`) |
| `catalogFunctions` | — (an entity index over an expression is `JD0004`) | yes (the host's IMMUTABLE `sql` function) |

And the two subsystems that are SQLite's own, declared on the
CONNECTION rather than the dialect because they are a library's
capability and not a syntax: the durable job queue (`jobs`) and the
change ledger (`changeCapture`). A store asked for either on a
connection that declares it absent is refused at open by name.

One behavioural difference is neither a capability nor a fallback,
because nothing can paper over it: **PostgreSQL aborts a transaction a
statement failed in**, and every later statement in it is `25P02` until
it ends. SQLite carries on. A body that means to catch a write's failure
and continue has to say so — `scope.transaction()` opens a savepoint the
failure rolls back to — and where it does not, the store reports the
engine's own condition under `JD2088` (`class: 'aborted'`, not
retryable) rather than a confusing failure of the next statement.

### The injected driver (`src/drivers/postgres.js`)

The driver imports nothing either. It takes a connection SOURCE —
`{ connect() }` answering `{ query(text, values), release?() }`, which a
`pg.Pool` is verbatim — acquires ONE client at open, holds it for the
store's life and releases it exactly once at `close()`. Holding one is
not a simplification: a connection owns one savepoint stack, and a store
that took a different pooled client per statement would have `BEGIN` on
one and `COMMIT` on another.

Statements are prepared by name, from a counter that is monotonic across
the PROCESS rather than across one adapter — a prepared statement
belongs to the session, and a pooled client's session outlives the store
that borrowed it, so a per-adapter counter would re-use a name for
different SQL and the server refuses that. The names are deallocated at
`close()`, so the session goes back to the pool clean. A cached plan
whose result type changed under it (`0A000`, after a migration) is
re-run unnamed rather than raised.

Three normalizations, each forced by the wire rather than chosen:
`int8` and `numeric` arrive as strings (they can exceed a double) and
become JavaScript numbers. An `int8` outside the safe integer range
refuses with `JD2005`; allocated collection inserts decode `RETURNING`
inside a transaction so a refused key rolls its row back. PostgreSQL
sequences still advance on rollback. `json`/`jsonb` arrive parsed, because
the client's type parsers are the host's configuration, and the row decoder reads text; and a
JavaScript boolean is bound as 1 or 0, because a boolean member is 1 or
0 in this mapping.

A held session can die under the store — a terminated backend, a
restarted server, a dropped socket. The client that reports it emits an
`'error'` event, and an event nobody listens for is an uncaught exception
that ends the process, so the adapter listens for the store's whole life:
the event marks the session lost, and the next call refuses `JD2087`
instead of reaching a client that can no longer be queried. Whether that
refusal may be retried depends on what was at stake. A loss outside a
transaction, or inside one that had written nothing, lost nothing
(`retryable: true`); a transaction that had written, or its `COMMIT` in
flight, has an outcome the store cannot know (`retryable: false`), so a
caller never repeats a write that may already have landed.

`schema` is where the store lives. It is set on the acquired connection
AND given to the dialect, so the DDL and the catalog reads agree — one
value, two consumers. A migration's SHADOW replay is a second database,
which on a file engine is `:memory:` and on a server has to be another
schema: `migrate(..., { shadowDriver })` is where the host names one.

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

- **The normalized AST is a compatibility surface.** The planner
  walks the engine's PUBLISHED AST, which promoted an internal shape
  to a versioned contract the engine must now keep. Paid for: a
  load-time exhaustiveness pact means a new language construct breaks
  the build instead of silently becoming a residual.
- **The store API is asynchronous** even though every shipped
  driver is synchronous. Measured cost: ~0.17 µs per point read
  (~6 %) over the `store.sync` twin. Paid for: the browser's OPFS
  story and any future non-embedded driver need no API change, and
  the sync-capable `chain` keeps the internal composition
  allocation-free so the surface pays exactly one promise per call.
- **The dialect indirection is paid for a second backend that
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
singular member path and a literal or external, or two paths the schema
types as scalars, compared by the family of their values (the type truth
table below); a literal `$get` over the binding or over a member the schema
types `object` reads as the member path it names, in a collection query's
`$exists`, `$empty`, six comparisons and, over a member typed `string`
alone, three string operators; membership — `$eq` between a singular
member path and a `$seq` of scalar literals or every item of an external
(`'$ids[*]'`), in either order, and an `$or` of two or more equalities
comparing one member with scalar literals, each ONE list predicate;
`$and`/`$or`/`$not` composition of any length (nested in halves, depth
log₂ n: a flat chain of n terms is n nested expressions, which SQLite
refuses near a thousand); `$exists`/`$empty`; `$starts-with`/`$ends-with`/
`$contains` on schema-typed string paths with literal patterns;
`$orderby` over singular schema-typed paths (`$dir`, `$empty`, no
collation); a top-level `$subsequence` window with literal bounds; the
top-level aggregates `$count` and `$min`/`$max` over a singular
schema-typed path, and `$sum`/`$avg` over a singular `integer` path,
folded as a double beside a guard that every partial sum is exact (a
`number` path keeps the engine's left-to-right accumulation, over the
rows the pushed `$where` selects); the whole-document projection that returns
the bare binding; ONE member path, projected as its value beside its
JSON type; and a nested SHAPE of objects, arrays, literals, whole collection bindings and member
paths, projected as one value/type pair per distinct leaf and rebuilt
by the decoder — never by parsing a JSON text the database assembled,
which could not tell an absent member from a present `null`.

Constant projection trees fetch a row marker instead of a document. A
window over a single path removes absent members before its SQL limit;
a window over an opaque projection (one the tree cannot rebuild) stays
set-residual because that projection may emit zero or several items per source
row, and so does a count of it.

The exception is an object or array constructor, which yields exactly one item
per row, whose every leaf is a singular member path, a literal, the document
itself or one of a closed list of operators that cannot raise on a document
that conforms to its schema (`TOTAL_OPERATORS`): `$default` over member paths
and literals; `$upper`, `$lower` and `$string-length` over a member the schema
types exactly `string` (a union, an untyped member, a column that stores another
kind, reads a NULL as a present `null` or decodes its text through a date codec,
an epoch column and a path with a negative index are none: a schema places an
element by its position from the start, not from the end of a tuple);
`$count` and `$exists` over a member path; `$concat` over literals and members
typed only `string`, `number`, `integer`, `boolean` or `null` (a union of them
too, a column of one of those codecs whatever it reads a NULL as); and `$add`,
`$sub`, `$mul` and `$div` over number literals and members typed exactly
`number` or `integer` that read no NULL as a present `null` (doubles overflow to
an infinity and divide by zero to an infinity or NaN without raising, and an
absent operand leaves the member out; `$idiv` and `$mod` raise on a zero
divisor and are none).
The engine evaluates the return of every row, so only an evaluation that cannot
raise may go unmade for the rows a window leaves out, or for every row of a
count. Over such a constructor on a collection the window rides in the statement
(`LIMIT`/`OFFSET`) while each fetched row runs the constructor in the engine
(the row residual), and a `$count` is a `COUNT(*)` that reads no row; on an
entity only the count lowers, because the entity planner has no row residual, so
a window over an operator projection runs in the engine (`entity.projection`). A
collection's window also stays in the engine when a pushed conjunct runs as a
registered function (`plan.registeredFunction`): the database stops evaluating
one once the window is full, and the engine evaluates every row; so does a count
of such a constructor, which no longer needs to. The engine evaluates a
`$where`'s conjuncts in order, stopping at the first false one, so from the
first conjunct that can raise (one the engine decides, or one that runs as a
registered function, unless it is an `$eq` or `$ne` of literals, member paths and
the operators above, an `$exists` or `$empty`, or an `$and`, `$or` or `$not` of
those) no later conjunct narrows the rows: it runs as a
registered function, evaluated after the earlier one, or stays in the residual
(`predicate.afterRaising`), since an index seek on it would never visit a row
the earlier one raises on. The conjuncts before it keep narrowing. A document whose rows violate their schema is outside this
proof: the engine would raise `JQ2001` on a row the statement never reads. So is
a row of an adopted table that its codec cannot decode (invalid text in a `date`
or `datetime` column, which only trusted SQL writes): the engine raises `JD2003`
decoding it, and a count reads no row, as a count of the bare binding or of a
constructor of member paths already did.

General scalar grouping preserves absent and null keys separately through
value/type pairs, and groups a key by the number it is, not by the way it was
written (`2.0` and `2` are one key). A key is a singular path the schema
declares as scalars alone, however many kinds a union lists; one that may hold
an object or an array, or is reached by a negative index, is the engine's. Null
and boolean keys may group, but ordering them stays
residual to preserve `JQ2005`. Explicit group ordering accepts orderable keys and proven count/min/max
expressions and integer sums and averages, including aggregates absent from the return; first appearance
breaks ties. A floating SUM/AVG ordering remains residual: compensated or differently
ordered SQL accumulation can change which group sorts first. A grouped
SUM/AVG over a `number` member (or one declared `integer` and also `number`)
stays in the engine for the same reason; over
an `integer` member each group carries the exactness guard, and a group past
it sends the run to the engine. A group with no value orders as the engine
orders it: a sum as `0`, an average as the empty key. That guard is read on
the groups a statement returns, so a window over groups ordered by an
integer sum or average stays in the engine (`plan.windowedAccumulation`).
An ordered group key is read at its own kind (a number by value, a string by
code point, on PostgreSQL `numeric` and `COLLATE "C"`), never from the text the
decoder reads. Other literal windows lower over singleton group constructors;
`$count` over such constructors with only row-count aggregates counts a grouped
subquery. `$distinct` uses the same key relation over leaves the schema declares as
scalars alone (a string, a number, an integer or a boolean, each optionally `null`, however
many of them a union lists), alone or as the members of an object constructor with literals;
a path alone has its absent members removed first, a constructor yields an item for every
row. Unordered inputs retain first appearance; an ordering composed solely of the projected
path lowers to group-key order; an ordering by any other paths numbers the rows in that
order in a derived table, as a grouped join does, and a group stands where its first row
does, so a row without the key stays in the ordering where `$empty` places it. A key
reads a number as the number the engine parses: SQLite's `integer` and `real` are one
name, and a member that holds numbers alone is read as a double, so `2` beside `2.0` is one
group and a whole number beyond 2^53, which a client that writes doubles leaves as an integer
text the driver cannot hand over exactly, is a key like any other; PostgreSQL groups the
numeric itself, whose equality ignores the scale it was written with. A member that may also
hold a string reads a number as that double (SQLite) or as the number's text without its scale
(PostgreSQL) and every other scalar as it is stored. The statement groups every row it reads,
and the planner cannot know how many groups there are: with nearly as many groups as rows it
does the engine's own work and, in the engine's order of first appearance, a sort of the groups
besides, and can be slower than the engine. An entity
`$distinct` of mapped columns is the same grouping through the entity emitter, with the guards
of an entity grouping.

Entity projection trees, constants, counts and single-path windows follow the
same cardinality rules. An equijoin graph can additionally filter through
boolean trees whose leaves belong to individual bindings. The entity emitter
resolves each leaf's binding alias before composing the total predicates;
a disjunction never supplies a mandatory join edge.

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
binding, `$min`/`$max` over singular schema-typed numeric paths and
`$sum`/`$avg` over singular paths the schema types `integer`, becomes a
`GROUP BY` over integer arithmetic. So does a `$resample` whose frozen
spec asks for nothing that ladder cannot do — a fixed width,
`fill: 'omit'`, and one of `min|max|count`, or `sum|mean` over an
`integer` reading. A floating sum or average is the engine's
(`floating-accumulation`), and so is any aggregate over a reading that admits a
stored `null` (`nullable-reading`), over the fetch the index still bounds.
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
| a `$groupby` whose key is untyped or may hold an object or an array, whose `$return` reads the binding, or whose `$orderby` names anything but an orderable key, a count/min/max or an integer sum/avg | SQL's grouping and the engine's need not agree on an untyped key; after a grouping the binding holds the group's ROWS, which an object member cannot take; a floating sum or average accumulates in the engine's order (`plan.floatingAccumulation`) |
| a window over a group return that may omit an item, or over groups ordered by an integer sum/avg (`plan.windowedAccumulation`), or a group aggregate beyond the proven constructor count | SQL group cardinality must equal the projected item cardinality; the exactness guard beside a sum is read on the groups a statement returns, not on those a window leaves out; numeric and error semantics need their own proof |
| an entity grouping over a compound physical key whose order leaves two groups tied (`entity.groupOrder`), over a store-owned PostgreSQL table or any join on PostgreSQL (`bind.entityGrouping`), or over a join that is ordered, windowed, returns the nullable form of a sum or reads a whole binding | tied groups come out by first appearance, the smallest key TUPLE, which the minima of the key columns taken one by one do not give; the runtime guards (`_safe`, `_valid`) are qualified on SQLite and over one adopted PostgreSQL table with no document column; a join's groups come out by the number of their first row, which an ordering has not been proven to leave alone |
| an entity grouping that sums, averages or takes an extreme of a column that stores a boolean, or orders its groups by a key that stores one, by two keys whose NULL reads back as a present `null`, or by one such key beside an ordering aggregate of such a column; and, on PostgreSQL, any native read of a column of that policy | the engine refuses a boolean or a `null` (`JQ2001`, `JQ2005`) where SQL folds or orders it; a sum, mean or extreme of such a `null` column lowers on SQLite beside a NULL count the runtime refuses (`JQ2001`), and an order by one such key lowers beside the key's type, which the runtime refuses (`JQ2005`) when it is `null`; which of two such refusals the engine meets first depends on the first group it meets |
| an equality or inequality of two columns of one binding when either reads a NULL as a present `null` (`null: 'null'`), whatever the schema omits | the engine equates two nulls and differs a null from every present value; SQL does neither |
| a `$for` binding nothing joins to — a cartesian product — or one a column equality connects only across comparison families (or a union, or a schema type the codec does not hold), over a boolean, over a column of no declared type, or between two columns that can each read a NULL as a `null` | the engine builds the product; a plan that emitted one by accident is the thing an equi-join graph exists to prevent; SQL pairs `'1'` with `1` by affinity (PostgreSQL has no such operator) and pairs no `null` with another, where the engine pairs none and equates the nulls |
| a statement that must order a table's rows, over a table that takes every spelling of SQLite's row identity (`rowid`, `oid` and `_rowid_`) as a column (`bind.identity`) | the database resolves a name to a column before it resolves it to the row, so no spelling is left that reads the insertion order |
| non-singular path expansion | one relation per binding in this version |
| an entity navigation hop that is chained, ordered or grouped inside, correlated by an inequality, or by equalities across comparison families or over members that admit `null` in their type or their column's policy (`entity.hopShape`; an uncorrelated one in a `$where` is `entity.conjunctBinding`); a hop read as a value (order key, projection leaf) whose equalities do not cover the related entity's key (`entity.hopValue`) | SQL equates the string `"1"` with no integer where the engine does not, pairs no `null` with `null` where the engine pairs them, and a scalar subselect over two rows raises where the engine raises `JQ2005`/`JQ2001` itself — the shapes without the proof keep the engine's answer and its errors |
| `$match` and other unlisted operators, `$call` | no native spelling proven equivalent |
| `$orderby` with a `$collation` | a collation the dialect cannot reproduce is refused, not approximated |
| a projection the tree cannot rebuild: an operator over a member, a reference to the binding itself, a non-singular path | the WHOLE projection runs per row (the row residual) — pushed and ordered rows, projected by the engine; a window over these items, and a count of them, run in the set residual (`flwor.projection`, `plan.countProjection`), except over a constructor whose operators cannot raise (the pushdown contract above), whose window is in the statement and whose count is a `COUNT(*)` while no conjunct runs as a registered function (`plan.registeredFunction`); promoting the part that composes would answer a shape nobody asked for |
| a document that reads the collection root outside its binding — `$`, `$.…`, `$[…]`, a nested query over `$[*]`, a variable bound to the root, the root inside a path filter (`$it.xs[?@ == $[0].n]`) | the engine answers over the WHOLE collection (under a profile, the rows its mandatory predicate keeps): the row residual would hand it one row, and a pushed conjunct, the deterministic-function hatch, a window or a k-nearest cut the rows they keep — so such a document is planned with no hook (nothing registered for a narrowing it cannot keep), a plan that narrows becomes the bare fetch with the reason `plan.rootRead`, and one that already fetches every row keeps its own reasons. The planner counts root reads over the analysis, filter selectors included; a phrase it narrows reads the root once, through its binding or a temporal operator's operand |
| string operators with an external pattern | the pattern's type is unknowable at plan time and the engine ERRORS on non-string patterns |
| a comparison of two paths when either is not typed as a scalar — an object, an array, an untyped member (`predicate.joinTerritory`; an entity query also refuses a pair outside one non-null number or string family); a `$get` whose target is untyped, whose key is no literal string, or that feeds a string operator over a member that can hold another kind (`predicate.operands`, `predicate.existence`, `predicate.stringSubject`), and a string operator, spelled as a path or a `$get`, over a member of several kinds besides `null` or an adopted column with `null: 'null'` (`predicate.stringSubject`) | `$eq` and `$ne` compare objects and arrays deeply, member order and `1` against `1.0` insignificant inside, which SQL text cannot reproduce; the engine raises on a string operator's subject of another kind; the deterministic-function hatch may still take it |
| `$distinct` of an object, an array, an untyped member or a union that may hold either, of a path reached by a negative index, of an array constructor, an operator, the document or a path with several items; on an entity, of anything but mapped columns of scalar codecs, or with an ordering of its own | SQLite groups an object or an array by its text, which keeps the order of its members, and PostgreSQL's jsonb text keeps the spelling of a number (`1.0`), where the engine compares them member by member and numbers by value; an array's elements are not named, so rows with different leaves can answer one array (`plan.distinctProjection`, `entity.distinct`) |
| array/object literals in comparisons | deep-equality has no guarded native form |
| `$within` over a `derive: 'bbox'` column | a bounding-box pre-filter is pushed; exact containment refines in the engine |
| a bounded `$distance` over a `derive: 'bbox'` column | a geodesic-circle box pre-filter is pushed; the exact distance refines in the engine |
| a geohash prefix LONGER than the column's precision | a cell-range pre-filter over the derived column's precision is pushed; the longer prefix refines in the engine |
| a spatial predicate over a member with no matching derived index, or one the schema does not type as an array or an object | nothing is proven; the whole predicate runs in the engine (the deterministic-function hatch may still take it) |
| an unbounded `$distance` (`>= r`), a circle reaching a pole or crossing the antimeridian, a probe with no bounding box | no conservative box exists — pushing nothing is correct, pushing a wrong box is not |
| the k-nearest ordering over a `derive: 'vector'` column | the column cuts the candidates; the engine orders them (mode `knn`, "The k-nearest plan" below) — engine work, so `strict: true` refuses it |
| `$similarity` anywhere else — a threshold in `$where`, a score in `$return`, a second ordering key | no native spelling; runs in the residual over whatever the rest of the document pushed |
| the k-nearest shape with no finite window, ascending, `$empty: 'greatest'`, a probe that is neither a literal vector nor an external, a literal probe of another width, or a selection not pushed whole (a residual conjunct, an implied one, a `$let` before the where) | nothing is proven; the whole document runs in the engine, and `explain()` names which precondition failed — a k-nearest query never falls to the full scan silently |
| `$resample` with a fill policy other than `omit`, `$rolling`, `$asof`, `first`/`last`, a calendar width, a named zone, a `$time-bucket` whose width or origin is an EXPRESSION, an instant the schema does not type as an integer, or a `sum`/`mean` (a `$sum`/`$avg` in a `$time-bucket` grouping) over a reading the schema does not type `integer` | the index bounds the fetch and `@jarenjs/core/series` — for a grouping, the engine — decides over what comes back; `explain().series.reasons` carries the CODE — `fill-policy`, `rolling-refinement`, `asof-refinement`, `unsupported-aggregate`, `calendar-width`, `named-zone`, `nonliteral-spec`, `instant-not-integer`, `floating-accumulation`, `nullable-reading` — and `strict: true` refuses every one of them |

### The type truth table

Jaren compares by JSON type; SQL engines by storage class and
affinity. `jsonb_extract` returns SQL `NULL` for a missing member AND
for a stored JSON `null` — only `json_type` tells them apart, so every
translated predicate is guarded by it — or, on PostgreSQL, whose
extraction at a kind is typed, by the typed value's own `IS NOT NULL`
(the bullet above) — and is therefore **total
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
| `$eq` path, `$seq` of literals | `(jt = 'text' AND v IN (SELECT value FROM json_each(?) WHERE key IS NOT NULL AND type = 'text')) OR (jt IN ('integer','real') AND v IN (… type IN ('integer','real')))` — the strings bind as one JSON list and the numbers as another; a `null`, `true` or `false` in the list is its own `jt` test, OR'd in; an empty list is constant `FALSE` |
| `$eq` path, `$x[*]` | the same two branches, each binding the external's JSON; `json_each` reaches an array's elements or an object's member values, and a scalar reaches nothing — the engine's `[*]` |
| ordering vs external | the same two-branch form with `op` |
| `$eq` path, path | `jtL IS NOT NULL AND jtR IS NOT NULL AND (…)` with one term for each family both members can hold: numbers `jtL IN ('integer','real') AND jtR IN ('integer','real') AND vL = vR`, strings `jtL = 'text' AND jtR = 'text' AND vL = vR`, booleans `jtL IN ('true','false') AND jtR IN ('true','false') AND vL = vR`, nulls `jtL = 'null' AND jtR = 'null'`; a side that can hold only that family omits its test; two members that share no family: constant `FALSE` |
| `$ne` path, path | `jtL IS NOT NULL AND jtR IS NOT NULL AND NOT (…the $eq terms…)`; with no family in common, the two presence tests alone |
| `$lt/$le/$gt/$ge` path, path | the number and string terms with `op`; constant `FALSE` when the two share neither |
| `$starts-with` path, string | `jt = 'text' AND (v >= ? AND v < ?)` — the prefix and its code-point successor |
| `$ends-with` path, string | `jt = 'text' AND (length(?) = 0 OR substr(v, -length(?)) = ?)` |
| `$contains` path, string | `jt = 'text' AND instr(v, ?) > 0` |

**A number past 2^53 is compared as the double it is.** The engine compares
the doubles both sides are; a document spells a double past 2^53 by its
shortest digits (2^60 is `1152921504606847000`), and SQLite reads those digits
as the exact integer they name, which is not the double, and compares it
exactly. So a comparison or a `$seq` membership whose literal list holds an
integer past ±(2^53 − 1) reads the member as `CAST(v AS REAL)` (the dialect's
`numberRead`), and such a list spells each of those integers with an exponent
(`1.152921504606847e+18`), which `json_each` reads as the double. Against a
safe integer or a fraction the exact comparison and the double one agree, so
those statements are unchanged and seek as before; a generated column that
already holds the double (a `number` member's `REAL` column, or the cast read
of a union whose first type is `number`) is compared bare and seeks too, and
every other indexed member reads the cast and does not seek. PostgreSQL reads
both spellings of the digits as one `numeric` and changes nothing. An
external operand's value is known only when it binds, and a writer may have
spelled the member by any digits that round to the double (2^60 is
`1152921504606847000` from a JavaScript writer and `1152921504606846976` from
another). So on SQLite, where the member is read by its digits rather than
from a column of doubles, the number branch compares it with the interval of
integers that round to the external's double, bound as the interval's two
edges (the slots' `digits`: `low`, `high`): `$eq` is `v BETWEEN ? AND ?`,
`$lt` is `v < low`, `$le` is `v <= high`, `$gt` is `v > high` and `$ge` is
`v >= low`, each edge a 64-bit integer, or the double itself where the edge
lies past them. A safe integer or a fraction binds as itself at both edges,
which is the exact comparison it always was. The statement is the same for
every value, the member's index still seeks it as a range, and the rows kept
are the engine's whatever digits the document holds — for a store profile
predicate's external and for a document's own alike, which therefore runs in
the database too.

**A path against a path is decided by the family of the two values.**
Only members the schema types as scalars qualify — `string`, `number`,
`integer` and `boolean`, each optionally with `null` — because those never
hold an object or an array, whose comparison is deep; the planner reads the
WHOLE type of each member (`['string', 'null']` is a text member that may
hold `null`). Two present values are equal when they are of one family and
equal there (numbers as numbers, `1` and `1.0` alike; strings by code point;
booleans by value; two `null`s), differ otherwise, and order only as two
numbers or two strings, so `$le` of two `null`s or two booleans is false and
a number never orders against a string; an absent member answers `false` for
every operator, `$ne` included. Each family's term is true or false, never
`NULL` (on PostgreSQL the test of a side is the typed value's own `IS NOT
NULL`), so a negation composes. Two members of one family that hold nothing
else (`integer` against `number`) keep the plain `vL op vR`. An entity query
keeps that plain form alone: its path comparisons over mapped columns
compare one family, and every other pair stays with the engine.

**A member's column answers every kind, or its own.** A member the schema
lets hold more than one type besides `null` (`['string', 'number']`) has, on
SQLite, an untyped (`ANY`) generated column, which stores a value as the
document holds it: a column of the first type would refuse a conforming
document (`'b'` in a `REAL` column) or rewrite its value (a `TEXT` column holds
the number `2` as the text `'2'`, so a numeric comparison against it answers by
text order or by the spelling of the bound number, never by value). Every
comparison of the member, whether the operand is a literal, an external or
another path and whatever its kind, reads the column and seeks its index, with
the document's own type test beside it. Where the column holds the first type
alone (PostgreSQL, which reads a value of another JSON type as `NULL`, and a
SQLite table an earlier release created in one of the member's types, which
still opens and is read for that type's kind alone, the document for every
other) a comparison reads that column for its own kind and the document for
every other at that kind. On PostgreSQL the plan creates an index beside a
declared index over such a member for each other kind, over exactly that read
(`kindIndexes`, `<index>$<kind>`), so the server seeks it with no change to the
statement. Beside a unique index they are unique and stand beside every shape
of it (one per combination of a composite's members' kinds, `<index>$<kind>$<kind>`,
keying each other member by its column; under a conditional index's condition;
under the guard of a guarded path, or the other spelling of it a table whose
model declared the container the other way holds), and one per container kind
the union lists, keying it as `jsonb`, so the declared index and they together
refuse a duplicate of every kind; the open verifies each one's uniqueness,
condition and keys, accepts a table without them, `planColumnUpgrade` adds them
(refusing `JD0023` first where the table holds duplicates one would refuse), and
`introspect()` reads them back as the union's kinds. On SQLite a unique
index keys, after its columns, each member's kind where its column alone would
key two kinds as one (`dialect.kindKeyTerm`, the planned index's `terms`):
whether the member is a boolean where the column is untyped, since that column
holds `true` as `1`, and the member's value where it is not of a typed column's
own kind (`''` where it is), since a `REAL`, `INTEGER` or `TEXT` column holds
another kind as its type reads it; the open accepts the index without them, or
with an untyped column's alone (`earlierTerms`), as an earlier release created
it, and `planColumnUpgrade` creates it again with them.
That column holds a container as its bytes, so such a member also gets a plain
column (`containerKeys`, `kx_<member>`) that two triggers fill with the
container's key, its nodes sorted by path with each member's name decoded
(`dialect.containerKey`; no index expression may read a table-valued function
or a recursive query), and the unique index keys it in an index
beside the declared one (`<index>$container`) over the rows that hold one; the
open accepts a table without them (`withoutContainerKeys`), `planColumnUpgrade`
adds them, a link that drops one or creates an index over one the from-model
keys rebuilds the table, and `introspect()` reads them back as the plan's. On such a SQLite
table a number comparison of a string-first member does not seek. A
member whose first type besides `null` is `number` stores its numbers as the doubles the query
engine compares, as its `REAL` column did. `explain().indexes`
names an index when the statement spells one of its columns, so a comparison
that reads the document names none, and an index beside a declared one, which
keys no column, is not named where the server seeks it. An untyped column may hold a text or a
fraction where the first type is `integer`, so such a member is no whole epoch
for a native bucket ladder and asks for no as-of anchor.

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
so a path whose schema admits `null`, or several kinds, is a named residual
for ordering and aggregates, and the two engines keep answering alike over
conforming data. A string operator is a named deviation: a member typed
`['string', 'null']` stays native, so a stored `null` answers false where the
engine raises `JQ2001` (the common nullable text shape keeps its index seek,
`strict` and its profile row bound; [NATIVE-PLANS](docs/NATIVE-PLANS.md#named-deviations)
lists it with the store's other named deviations), while a member of
several kinds besides `null` (`['string', 'integer']`) and a column whose
policy reads a NULL back as a present `null` (`null: 'null'`) are the
engine's and raise. An entity column of any other policy holds no member
where it holds NULL, and an epoch column keeps its `null` in the document, so
an ordering over a nullable one is the engine's.
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
execute time, if any referenced external is missing or not a string or finite number, or is a string the database would not receive as written (a lone surrogate bound as text arrives as U+FFFD; PostgreSQL holds no U+0000 and refuses a lone surrogate's JSON escape),, the call runs the always-compiled set residual instead
of the native statement — same answer, one branch, no wrong-typed SQL.
A membership list is bound whole, and binds when every item `$x[*]` reaches is a string or a finite number, a string item on PostgreSQL holding neither U+0000 nor a lone surrogate: a `null` or boolean item (which
`$eq` matches against a present `null` or boolean) and an object or
array item (which it compares structurally) divert the call the same
way. `cellIn`'s neighbourhood list and every membership share the one
list emission (`inListSql` → the dialect's `inList`).
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
| `{$exists: {$index-of: [{$geohash-neighbours: "<cell>"}, {$geohash: [<path>, k]}]}}`, cell length = k | `<c> IS NULL OR <c> IN (…the nine cells…)` | **inexact** | Unbounded members remain candidates so the row predicate preserves the empty-search-item error. An explicit `$exists` guard excludes them safely. Nine cells cover neighbours across a cell boundary; one prefix does not. |

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
| **bucket** | a `$groupby` over `$time-bucket`, or a `$resample` whose spec asks for nothing more, that aggregates with `min`, `max` or `count`, or sums or averages an `integer` reading | native — `GROUP BY` over `at - (((at - origin) % every + every) % every)` |

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
| `$overlaps` over an interval member | the half-open conjunction over the two bound columns — exact over a member the model declares an interval, and otherwise plus every row the operator RAISES on (below) |
| `$resample` (fill, calendar, `first`/`last`, a floating `sum`/`mean`), a `$time-bucket` grouping with a floating `$sum`/`$avg` | the spec's own `start`/`end`, plus the operand's (the grouping's) `$where` |
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
bound columns is two comparisons the emitter already spells. Whether
that conjunction is exact is the model's to say: over a member the
model declares an interval (`intervals`, MODEL-FORMAT §2) no stored
span is empty, reversed or malformed — the store refuses one before the
statement and the table's CHECK refuses every other writer — so the
conjunction decides and the bound's index seeks — and where the
declaration also bounds the duration the plan carries a third
comparison, the start past `from - maxDuration`, so the start index is
sought between two bounds rather than from the probe's end down.
Undeclared, what
makes it a pre-filter rather than an exact translation is the kernel's
other half: a span that is empty or reversed is not `false`, it RAISES
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
nothing and names why. What stays unpromoted is `$overlaps` over an
entity's nested span (ROADMAP).

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
divert has. A `$resample` reading is the same kind of requirement: the
kernel reads it off EVERY row, whatever the aggregate, and a row that
carries none is refused (`null` is a measured gap, an absent member is
neither), while SQL skips the NULL it reads there. When the schema leaves
the member optional the statement counts the rows that carry none, and a
count above zero diverts exactly as a missing instant does; a member the
schema requires needs no count (on a store that validates what it writes),
and a reading that is not a schema-typed
number is not a bucket at all (`value-not-numeric`, also for `count`).
Both counts are over the rows the statement reads: a `start`/`end`
window is applied by the statement, so a row outside it is never read and
a refusable row there is never met (the operand's own `$where` hides
nothing the engine meets: it filters before the kernel there too) — a
[named deviation](docs/NATIVE-PLANS.md#named-deviations), since the engine
validates every row first.

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
  and ordering are fully pushed, with no output window unless the projection is
  a constructor of one item per row that cannot raise (then the window is pushed
  too, and the rows fetched are the window's); each fetched row runs
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
last ACTUAL run's rather than an estimate. `budget.estimatedRows` is `'unavailable'` on SQLite drivers — the
capability slot is empty and no number is fabricated — and, on PostgreSQL, the
planner's own estimate for a native plan, `{ rows, source: 'postgresql-planner' }`,
asked for by one statement of its own (`EXPLAIN (FORMAT JSON)`) beside the
narrative's: an estimate and never a count. `residual` is `null` or
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
Registration is keyed by `semanticKey(fragment, { ordered: true })` (the
collision-free identity from `@jarenjs/core/object`, member order
included: a reordered `$let` can test another condition, and the
registrations outlive any cached plan) so identical
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
cache-identity test exists to keep that key abolished). The cache is
built `{ ordered: true }`, so member order is part of the identity:
`$for` bindings nest and `$let` binds in key order and a `$return`
object's members are the output's in that order, and two documents
differing only there are two plans — sharing one answered the second in
the first one's order, or answered where it must refuse an unbound name.
`store.stats()` exposes hits, misses and evictions, so the cache is
proven rather than assumed.

A keyset load is the one place a value is not part of the identity: the
values of a continuation (or of a scalar `after`) are bound into the
statement's slots by each call, and the key holds the load without them
plus their shape, one flag for each order key saying whether it is NULL,
because that, and nothing else about a continuation, decides the SQL text.
A walk therefore compiles one plan for the first page and one for each shape
its continuations take, and every other page hits; a long walk does not push
the other plans out of the cache. The continuation is checked against the
ordering on every page, a hit included, since the plan is shared and the
check is not.

One semantic entry owns every statement it prepares: its main read,
full-scan diversion, temporal seeks, vector-width alternatives or entity
root fetchers. Capacity eviction retires all those owners. A preparation or
read already in progress keeps its borrow until it settles; a child first
needed after retirement is temporary, as is every read of an uncacheable
document. This lets a lazy materializing cursor outlive its cached plan
without pinning that plan's statements indefinitely.

The finite KNN identity-fetch cache remains owned by the collection engine,
and streaming cursors own independent ephemeral statements. EXPLAIN and
scan-guard probes use the driver's one-shot owner on both success and refusal.
The cache bound counts plans, not physical handles: fixed Store statements,
auxiliary reads and active cursors also consume a remote connection's
statement capacity. Connection close remains the final resource owner.

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
nested-loop order. An equality is a join edge only between mapped columns of
one comparison family — the family the column stores and the engine decodes —
that are not both able to read a NULL as a present `null` (a join reads a
foreign key no property declares as the key it references; a hop does not): SQL
then pairs the rows the engine does. The refinements of an edge and a hop's
correlation follow the family rule and refuse any column that can read a NULL.
A navigation hop — a plain FLWOR over another entity,
correlated with the row by column equalities of one comparison family that
admit no null — is a correlated subselect of the same statement: `EXISTS`, `COUNT(*)`
or a scalar read, in a predicate, a count or value leaf, an order key, or as
the root `$some`/`$every`. It is one implementation of one proof: the hop
planner reads the FLWOR once, every site wraps the same descriptor, and a
profile's mandatory predicate and the dialect's term bound reach every
site through it (MODEL-FORMAT §10.1). A grouping over one binding is a `GROUP BY`
over its keys' value/type pairs with each aggregate beside its guards, and the
groups come out by the keys, the aggregates (an integer sum or average, a count,
an extreme) and then the first row of each group; where the first row is a
compound physical key it is a tuple no per-column minimum gives, so an order
that leaves two groups tied keeps that grouping in the engine (MODEL-FORMAT
§10.6). A grouping over a join groups a derived table of the join that numbers
its rows by every binding's identity in binding order, so the groups come out by
the number of their first row — a tuple order the minima of key columns could
not give — and only the unordered grouping lowers there; PostgreSQL leaves a
join to the engine (`bind.entityGrouping`). The graph loader compiles include trees to
correlated `json_group_array`/`json_object` subqueries: one statement
per load, proven by a counting driver, never promised.

## The unit of work (`src/tracker.js`)

Materialised entities are deep-frozen plain JSON and the frozen
document IS the snapshot — one retained reference, structural sharing
made safe by the freeze. `saveChanges()` diffs with the suite's own
diff engine and maps operations to minimal statements (column writes,
`jsonb_set` chains, join-table key-set sync, a counted whole-row
fallback); inserts batch parent-first, deletes run child-first (a
removal that a rollback staged again under a later `add()` of its key
runs ahead of the inserts, keeping the staged order),
foreign-key cycles among the changed set are `JD0040`, and a declared
`version` property turns every update into an optimistic
`WHERE version = ?` with `JD2040` on conflict. Which removals run ahead
is decided when the save is planned: one a rollback flagged while an
`add()` of its key is still pending, and with it, child before parent
and transitively, the removals of the rows that reference the row it
deletes (a `setNull` reference keeps its place — the delete ahead only
clears it); this is why a restore can cancel a pending insert outright —
an insert whose row a `remove()` staged after the save withdrew, with
the links staged under its key — and leave the removal it followed to
run in its child-first place. A save that FAILS leaves
the tracker exactly as it was, so it retries; a save whose statements
all succeed advances at once — inside an enclosing transaction too,
where the database already holds the rows — and registers the exact
withdrawal of that advance on the owning scope, whose rollback takes it
back so the retry plans the same statements again. The withdrawal keeps
one invariant: the tracker then holds what it held before the save plus
whatever was staged after it, each later word with the row it belongs to
— a word that named its row by the key the save gave it (an allocated key,
a record a re-read filed in place of the saved one) moves onto that row as
it stood before the save. Beside a delete run ahead, the update of a row
that references the deleted row runs before it when the references it
changes name rows that exist already, as the updates of any save run
before its deletes; one that changes a reference to a row the save inserts
follows that insert — run first, after the delete ahead of its own key —
and still precedes the delete it leaves, or, where no order allows both,
keeps its place after every insert. A save that writes nothing still
settles the membership deltas it resolved to no change, and a save of any
size runs its statements one after another without the stack growing
with their number.

## The migration engine, relationally (`src/migrate.js`, `src/cli.js`)

The strategy-table diff renders managed hybrid-model steps. Physical
declaration changes remain an explicit planning-policy refusal; reviewed
`table` steps delegate to `table-migration.js` with their entire source,
checksum, storage, identity and object guards. `migrate.js` owns the one
history/receipt transaction for both structural and data steps. New 0.2 artifacts
carry canonical exact model endpoints. `migration-history.js` owns full text
observations and canonical side receipts; the normal legacy history columns and
ordering values remain unchanged. `migrationHistory` observes without writing;
`adoptMigrationHistory` transactionally attests an explicitly reviewed complete
legacy prefix and model. It cannot recover unknown exact historical endpoints.
The CLI routes history/adoption and ordinary status/apply through these owners.

`physical-transform.js` reuses entity codecs and the document-step kernel
for bounded column reads and changed-only writes. Each step can select a
historical model. Keys remain fixed; generated/default ownership and
unchanged raw storage survive. Text cursor bytes are checked against the
native binding before exposing their batch; unsupported round-trips refuse.

`migration-target.js` owns connection acquisition/cleanup and complete
physical target acceptance for apply, repeated startup and status.
Application-owned inventories include retained programs while unrelated
tables stay outside the selected scope. `schema-sql.js` is the single
literal-aware comparison owner: physical order is strict, and safe managed
named-column comparison opts into a narrow relaxation. Exact source
snapshots and checksums never use relaxed comparison. Its token stream is the
one scanner the catalog reader walks (`scannerFor` in `dialects/check-read.js`,
one scanner built per grammar) under SQLite's own strict grammar: bracketed identifiers, blob literals, hex
and underscored numbers and multi-character operators are tokens, and text the
grammar cannot read is refused, where the catalog reader's grammar answers no
tokens.

`foreign-key-scope.js` brackets FK/legacy settings around the driver's
IMMEDIATE transaction. Nested work shares savepoints. Owned handles close
even after initialization failure; borrowed synchronous work retains its
value boundary. `shadowFixture` initializes a disposable historical schema
before replay uses the shared step/receipt executor, with recursive replay
disabled. Private verified authority executes an adopted legacy prefix on an
empty independent shadow before the exact tail; it does not copy primary
receipts or expose a legacy bypass. Every selected target is accepted before its
receipt. PostgreSQL writers require effective READ COMMITTED and preserve caller
isolation; read-only observations retain the caller's transaction view.

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
documents as the store writes them. The rows the database's own
foreign-key actions change inside a DELETE are the one thing a journal
cannot see written; `src/cascade.js` predicts them from the model's
edges (which the open-time check holds equal to the database's):
before the statement, inside its transaction, breadth first over the
inbound `cascade`/`setNull` and join-table edges of every removed row,
one statement per edge, level and chunk of keys, each read locked
where the engine locks rows as strongly as the delete's own action
will (PostgreSQL: `FOR UPDATE` for a removed row or a nulled unique
member, `FOR NO KEY UPDATE` for any other nulled row). They are
recorded right after the statement's own entry once it removed its
row, so a refused delete records nothing. A tracked UPDATE assigns
only the members its save changed, so the unit of work reads the row
first and, when it no longer holds the tracked snapshot (such an
action changed it), again afterwards: the stored rows are then its
images. Both net ONE op per row — insert+
update coalesces, insert+delete vanishes, an update back to the
original emits nothing — so the two modes agree as SETS (a differential
test pins it). A row deleted and stored again with the document it had
— by the row API, a unit of work's save, a membership or a foreign-key
action — nets to nothing, yet the table holds it last: both modes add one
`replace` of its whole document for it, the session mode from a buffer
the write paths keep beside the changeset of the transaction's deletes,
its inserts once it deleted a row, and every later write to a row it
deleted or so inserted. An insert found no row, so one the patch names
nowhere held that document when the transaction began; the rows a
foreign-key action removed need no read to be told. While such an insert
is buffered, a session-mode delete a foreign key reaches reads its closure
as the journal does, so a member its actions null reaches the buffer as
the row's last document. The journal's netting was added when the wasm parity
suite ran a same-row multi-op transaction the original differential
script never wrote. Op order within a record is UNSPECIFIED; every op targets
a distinct pointer. The persisted `_jaren_changes` log rides the same
transaction as the writes it describes; a caught inner-savepoint
rollback truncates the journal buffer to its checkpoint. Overhead is
measured and published: capture off ~6µs, journal ~17µs, session ~69µs
per single-op commit, amortizing across a transaction.

## Live queries (`src/live.js`, `src/live-nested.js`, `src/live-join.js`, `src/window.js`, `src/live-time.js`)

A live query classifies its document against the normative maintenance
table by reading the COMPILED PLAN — translated filters, order terms
and aggregates are exactly the planner's, never re-derived. On a
synchronous connection the strategies are: incremental **rows**
(per-key items, arrival order); the maintained **window** (all matching
rows sorted, ties by the row's position in the table as a fresh run breaks them, a literal offset as well as a
limit — nested windows composed by the planner — and a delete inside
the visible slice answered without re-query); running **accumulators**
for a whole-query aggregate (per-row contributions retained so a
capture `remove` — which carries no old value — is still answerable;
min/max recompute over contributions when the extremum's holder
leaves; an integer sum past its exactness bound hands the registration
over to re-running); **group** maintenance (the affected groups
recomputed through the query engine from their retained rows, for any
return that reads only the group and for `@jarenjs/linq`'s
one-`groupBy` emissions, with an optional fold over the group
outputs); **distinct** projections (the source holders of each value);
**nested-group** (explicit two-level groups, refreshed per parent);
**join** and **graph** maintenance over entity roots (changed keys
point-read, their bounded owners evaluated again; a flat self join
evaluates each later alias as an input root of its own); and **re-run**
for everything else — declared, reported through `live.mode`, never
silent. Event time adds the **bucket** and **rolling** states, and an
asynchronous connection **resnapshots** every registration (both
below). A plan that fell to the set residual ONLY for a spatial
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
fresh re-query after every mutation, and a census pins, shape by shape,
the strategy and reason the classifier reports against the table row
that names the shape. What maintenance
costs beside a re-run — the wins, and the startup and high-fan-out
losses — is measured, not asserted: see the equal-correctness
[measurements](docs/REPLICATION-FORMAT.md#measurements).

**Event time** (`src/live-time.js`) adds two more strategies for the
one document shape whose answer is a function of instants rather than
of rows: a `$resample` bucket state and a `$rolling` window state, both
over a FIXED width. There is no clock under either — the watermark is a
finite epoch the host supplies and `advance()` is the only way it moves
— and both fold through `@jarenjs/core/series` itself rather than
carrying a second aggregate, so a maintained answer is what a fresh
query gives (a `sum` or `mean` adds rows sharing an instant in the table's
order, read from their positions, and one whose readings stop adding exactly
makes a rolling view fold the series again: LIVE-FORMAT §13.3). A write touches one bucket (two when it
crosses a boundary) or the windows ending in `[t, t + width)`, and
exactly those are recomputed. Everything a per-key state cannot place
exactly re-runs with its member named: a calendar ladder, a named zone,
a `locf`/`linear` fill, a `first`/`last` aggregate, a retention under
`width + allowedLateness`. A reading behind the lateness boundary is
never folded in silently — the view re-reads and the emission carries a
`lateData` record — which is the one place this layer spends a full
re-query to keep a promise rather than a number.

**Asynchronous maintenance** is opt-in through `@jarenjs/db/async-live`. The
existing live registry owns results, reference sharing, patches and registration
lifecycle. `src/async-live.js` supplies its serialized poll/resnapshot strategy;
`src/live-executor.js` owns one bounded ordinary query engine and cursor budget
per registration. `src/snapshot.js` brackets reads with source revisions, shared
with lexical persistence. Reads take the Store transaction gate without the
journal's writer lock, and catch-up rejects mixed enrolled revisions. Retention
gaps reset; sustained churn reports lag within finite attempts. Observer delivery
uses core's `createLatestDelivery`, also shared with lexical invalidations.
The optional scheduler/executor stay outside ordinary synchronous client imports.

## Durable runs and the job queue (`src/jobs.js`, `src/dag-job.js`)

The queue's correctness story has two halves. The claim UPDATE selects
the earliest eligible row (pending, failed, or an expired lease with attempts left — so
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
  (`copy`, `rename`, `remove`; the Node and Bun drivers'), written to a
  temporary sibling and renamed only at verified completion, removed
  with its side files on every other branch. The copy's first step
  (Node) or whole extent (Bun) holds the store gate; progress events
  arrive only between steps, and never twice alike. The root closure
  imports no builtin: the primitives are the driver's. It also holds the
  one rule refusing a target path SQLite reads as something else (`file:`
  URIs, `:memory:`, a NUL byte), which the standalone snapshot helper
  imports, and reads its options as a closed set before it waits. A target
  colliding with the store's own files is refused by the binding's
  publication primitive, which alone can compare files.
- `src/cancellation.js` — the one check every lifecycle runs between its
  units of work (a statement, a row, a step, a batch, a page), on the
  clock the caller was given; each lifecycle owns its abort code, the
  deadline code is one. `capabilities.cancellation` states the
  granularity per lifecycle and that nothing interrupts mid-statement.
- `src/errors.js` — `classifyDriverError`, the one table every path
  consults (writes, the query engines through their boundary and the
  cursor's `wrap`, maintenance and backup under their own code, the open
  sequence): class, retryability, code. The query path has no special
  case: a pushed integer sum or average folds only the terms its exactness
  guard admits, so over the values the store writes no statement of one
  fails with an overflow, and a run past the guard is answered by the
  engine. A lost connection has one rule wherever
  it surfaces — SQLSTATE `57P01`–`57P03` and class `08`, the socket
  errnos, the PostgreSQL client's uncoded sentences — `JD2087`, class
  `connection`, retryable only while no transaction outcome is at stake.

The open path itself creates or verifies the shape inside an IMMEDIATE
transaction with idempotent DDL (one dialect spelling, applied on the
open path only) and retries once on a classed busy failure, so two
processes creating one fresh file never meet the deferred-upgrade
`SQLITE_BUSY` the busy handler cannot retry. The job queue's
administration (`page`, `cancel`, `requeue`, `sweep`) lives in
`src/jobs.js` beside the fence it authorises through (JOBS-FORMAT §10).

A transaction retries only when asked (`retry`), and the loop sits
OUTSIDE everything a transaction is made of: each attempt is a complete
top-level transaction, queued through the gate like any other, on a fresh
unit of work, with change capture seeing one attempt at a time. The loop
reads the failure's classification rather than guessing from the driver:
it runs again only after `class: 'busy'` with `retryable: true` and a
known commit outcome, and sleeps on `@jarenjs/core/retry`'s backoff —
the same function the job queue schedules its attempts with — between
attempts.

The hold limit (`holdTimeoutMs`) is the harder half, because an async
body cannot be stopped: it can only be made harmless. The clock starts
after the transaction has begun. At the limit the root record is marked
expired, so every scoped handle refuses `JD2098` from its next call. The
store then waits for the handle operations already in flight (it counts
them), gives up the capture engine's records for the attempt, and
settles the transaction as failed: the driver rolls back and hands the
connection to the next caller while the body may still be awaiting. Three
fences keep the late body from touching what comes after. The driver
scope refuses every method once its transaction has settled. The scope
restore will not reinstate a scope that is no longer current. The
capture engine drops records from an abandoned generation. The caller
hears `JD2098` only once its own body has settled, so it never runs
beside it.


## Replication and bounded dependency maintenance

`replication-format.js` owns JSON normalization; `replication.js` persists replica
identity, frontiers, canonical receipts, before-images, outbox and conflict
evidence through the capture transaction's `beforeCommit` seam. `logical-rows.js`
shares mapped, validated row access between replication and live dependencies.
Remote application suppresses only local envelope allocation: its data still
invalidates capture subscribers after commit. Snapshot reset carries complete
receipt evidence and refuses histories beyond its explicit credits.

Replication and logical-row one-shot SQL use the driver's shared temporary
statement owner. Bounded pages and snapshots hold that borrow through complete
cursor draining, including cancellation and capacity refusal; the journal's
foreign-key closure reads each statement whole before releasing it. They never
return an iterator after releasing its statement.

`dialects/replication.js` declares the metadata schema once; SQL values use
the connection's parameter vocabulary. `dialects/postgres-replication.js`
supplies bigint sequence storage, binary text collation, enrollment checks and
the shared capture write lock. `dialects/postgres-metadata.js` verifies table
shapes for both jobs and replication. Native replay defers managed foreign keys
inside its transaction; no checkpoint, receipt or outbox engine is duplicated.
Replay writes entity rows in a dependency order over the canonical one, built
from the mapping (its foreign-key edges from `cascade.js`): a row moved off a
parent the transaction removes before that removal, and the write releasing a
unique value before the write taking it.

`live-join.js` compiles indexed dependency descriptors from the entity planner
and mapping. The same cache strategy maintains inner/left joins, flat self joins
included, and eligible nested graph projections. `live-nested.js` maintains
single-level groups, distinct projections and explicit two-level groups by
recomputing the affected groups or parents from bounded leaves. Source and result payloads
consume row and byte credits; unsupported shapes keep named reruns. See
[the replication contract](docs/REPLICATION-FORMAT.md) and
[the strategy matrix](docs/LIVE-FORMAT.md).

Parameterized distance bounds use the closed `circleAxis` derived parameter:
`{ kind: 'circleAxis', centre: { external } | { literal }, radius: { external }
| { literal }, axis: 'w' | 's' | 'e' | 'n' }`. Both inputs are named in every
edge slot. The binder uses the shared geographic kernel and diverts the whole
query for missing/invalid values, negative radii, polar or antimeridian boxes.
The exact distance predicate still refines the candidates. The shared oracle
covers SQLite column/R*Tree indexes and PostgreSQL, including repeated cached
calls with different bound values.


## Explicit relational adoption

`introspect.js` owns physical inventory independently of model derivation.
`physical.js` compiles column codecs and verifies declarations against that
inventory. The existing entity core, tracker and graph row merger execute both
hybrid and column layouts; there is no separate relational store. The query
planner preserves codec semantics through qualified native plans and explicit
residuals, and refuses physical keyset continuation until its identity semantics
are qualified. Present-null scalar predicates and safe fluent projection
flattening join this native subset; strict binding failures stop before a scan.

`sql.js` binds trusted statements to `store.js` transaction views. It reuses the
read classifier's tokenizer and the driver's scope owner. Writes invalidate all
clean tracked entities; pending edits and incomplete capture populations refuse.
`invariants.js` uses the shared Query compiler for store rules; the dialect lowers
a bounded database subset into ordered trigger bodies. `migrate.js` composes
guarded table plans and codec-aware transforms in its existing receipt
transaction, checking preservation and complete selected targets before publication.
The backup publisher copies through SQLite's online backup on both hosts (Node
on the store's own connection, Bun on a dedicated read-only `node:sqlite`
connection, with `VACUUM INTO` only for a Bun database without a file, a Bun
runtime without `node:sqlite`, or a `bun:sqlite` on another SQLite library) and
refuses to publish beside a `-wal` holding frames or a hot `-journal`.
The standalone snapshot helper shares destination reservation, the connection's
own backup primitive as its page copy (`VACUUM INTO` for a connection without
one) and the cleanup of a failed copy across both hosts. On Node it holds one
read transaction on the connection for the whole copy, so another connection's
commits cannot restart it, with the connection `query_only` meanwhile, so a
write through it is refused instead of stalling the copy; a WAL source's copy
is made a rollback-journal file. It refuses a bad target, one colliding with
the database's own files and an open transaction before it reserves anything.

`src/search.js` composes core lexical mechanics and the JSON predicate compiler over complete bounded entity snapshots. Committed capture and data-version checks invalidate derived state; SHA-256 source content validates persisted caches across reopen. Snapshot storage uses existing collection transactions. See [search execution](docs/SEARCH.md); native full-text dialects remain unqualified.

`dialects/row-predicate.js` is the one lowering of a row predicate — a bounded
query expression over the mapped columns of one row — to SQL that answers as the
query engine does over the row as stored, per column `null` policy (SQL NULL as a
JSON null, as an absent member, or refused) — except where `releasedText` keeps
the spelling installed rule programs were planned with (two nulls of columns of
different JSON types compare unequal there; MODEL-FORMAT §13.4). It renders a
rule's trigger check, each column read through its codec with that codec's
domain and each sum, difference or negation of integers held to the safe range
by a domain of its own (the one range `invariants.js` names, which store
enforcement holds too), and an index condition over plain columns, which assumes
code-point text columns and a list short enough for a PostgreSQL index predicate. The caller
passes the dialect's flavor (`SQLITE`
beside `compileInvariants` in `invariant-sql.js`, `POSTGRES` in
`postgres-invariants.js`, so no PostgreSQL code reaches a bundle that carries
only SQLite) and the resolver of the paths it reads, and wraps each refusal
reason in its own error.

A store-owned entity's database rules lower through it too: `planEntity` hands
the dialect the columns its table maps for its members (`rulePrograms` in
`ddl.js`), each with the type the table declares, so the PostgreSQL flavor
reads `numeric` and `smallint` as the store does, and appends the programs to
the table's `createSql` (listed as `programs`), where the open creates them and
the migration planner diffs them. `verifyRulePrograms` in `physical.js` is the
one check of installed programs — on PostgreSQL each read back from the catalog
field by field — that a physical layout's open and `verifyShape` share, the
latter refusing any trigger or rewrite rule on a store-owned table the model
does not declare.

An index condition (MODEL-FORMAT §2, §9.2) is that lowering's index rendering,
every operand read as an absent member and every condition written in one
spelling per meaning, so a condition read back renders as written (one rare
form aside: two members of different types compared, rendered as their
presence test inside an `$and`, joins it); the dialect hands its flavor over as
`rowPredicateFlavor`. `dialects/check-read.js` holds the one reader of a
condition, `readPredicate(sql, spelling, member)`: one exact walk over
`sqlTokens`, beside the CHECK enum recovery and sharing its literal reader, the
engine injecting its spelling (`POSTGRES_PREDICATE` and, for a session without
standard strings, `POSTGRES_PREDICATE_ESCAPED` read the server's deparse and
the PostgreSQL rendering; `SQLITE_PREDICATE` the text SQLite keeps). A
`COALESCE` must stand exactly where the rendering writes one and a number must
spell the double it reads as, so two readings are equal exactly when the
conditions hold for the same rows. `dialects/postgres-read-back.js`, imported
only by the PostgreSQL dialect, is what the open reads back in place of CREATE
text (`dialect.readBack`): the condition through that reader, and a generated
column's expression through `expressionForm`, which reads the planned text and
the server's deparse into one form — undoing literal types, `ELSE NULL`,
parentheses, name quoting and the path array's quoting, nothing else — and
compares them whole. A layout index's condition and the key under each of
its expression terms (the catalog's `pg_get_indexdef` of that key, a
top-level collation set aside), declared `$sql` terms the open renders
through the relational emitter rather than plans, are read by
`conditionForm`: `expressionForm` with a condition's forms (`CAST`, `IN`,
`LIKE`, `IS DISTINCT FROM`), then one form for every spelling the server keeps
of one condition — operands ordered, lists gathered, comparisons oriented,
`NOT` taken in, the server's column casts and literal readings undone by the
column's catalog type — and `readBack.layoutConditionDiffers` compares it only
where both sides read (`physical.js`'s index check calls it). The planner asks it first whether a planned condition or
expression reads back, and refuses one that does not (`JD0004`). SQLite
verifies by its CREATE text, so neither reader enters a bundle that carries
only SQLite. Every planner lists the schema objects it names, the engine's own
relations included, and `refuseNameCollisions` holds them to one namespace
(ASCII case folded): each planner for its table, the store for the whole model.

`dialects/sqlite-relational.js` owns the explicit SQLite expression and statement
compiler; `dialects/sqlite-schema.js` reuses it for ordered tables, indexes and
triggers, sharing its column/reference renderer with native ADD COLUMN.
`table-migration.js` owns reviewed source/settings guards for additive/object
changes and source/target guards for native copying
and preservation checks, with catalog/pragma spellings in the SQLite dialect.
The supplied driver owns transactions and cursors. These programs are explicitly
SQLite-semantic and never enter the JSON residual evaluator. See
[the native SQLite contract](docs/SQLITE-RELATIONAL.md).

`relational.js` is one engine over an admission policy: planning, emission,
execution, the result rule (`lastInsertRowid` only for an insert that inserted
a row of a rowid table) and the classification of every driver failure are the
engine's; where each operation runs is the policy's. `relational(connection)`
is the engine with the connection's own policy. `store.js` supplies four more
(the root, the synchronous root, a transaction view and its synchronous twin),
so `store.relational` needs no second planner: its reads take the gate
prepared read-only, its root cursor goes through `admitRootCursor`, and its
writes run a top-level immediate transaction or a savepoint of the open one.
Its writes pass the one write-rule function trusted SQL uses
(`beforeSqlWrite`), which reads the written table structurally where trusted
SQL's free-form text cannot name one. The store's engines share one bounded
statement cache and one table-kind memo.

`engine-metadata.js` holds inert version/table constants so schema inspection
does not import runtime owners. `/query`, `/model` and `/entity` expose those
mechanisms without the root store import. `compileEntityModel` performs one model
normalization for both entities and mapping; openStore reuses that result.
`mutation.js` keeps bounded statement reuse keyed by emitted SQL; bindings,
projections and limits are call-local, so cached plans do not retain old payloads.

`drivers/worker-client.js` and `drivers/sqlite-endpoint.js` own the shared bounded
RPC contract. Thread and process entries supply their transports. The process
driver retains owner credits until OS exit, fences lost generations, and combines
observed native transaction state with pending statement metadata to distinguish
rollback from an unknown commit. Supervision never serializes callbacks or replays
transactions; Store ownership remains in the existing driver/Store gates.
