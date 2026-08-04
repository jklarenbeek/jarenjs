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

Dependency arrows: `core → json → db`. Nothing else — no validate, no
linq, no app. The linq package couples by contract (`execute(document,
options)`), never by import.
