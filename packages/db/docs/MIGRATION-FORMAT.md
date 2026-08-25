# The Jaren migration format (`jaren-migration`)

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Canonical schema: [`schemas/jaren-migration.schema.json`](../schemas/jaren-migration.schema.json)
(draft 2020-12), with the mechanically derived draft-07 twin beside it.

## 1. Scope

A store evolves without hand-written SQL: two model documents diff into
a **migration document** whose ordered steps are rendered DDL, JSLT
data transforms and query assertions. The migration replays on a
shadow database before the real store is touched; a history table
records what ran, in what order, with a checksum; rolling forward is
deterministic and inspectable, and the generated SQL is always shown
before it is executed.

This is the phase-A payoff for storing documents rather than rows: a
shape change is a **transformation of values**, not a table rebuild.

## 2. The migration document

```json
{
  "$migration": "0.1",
  "id": "0002-split-name",
  "from": "1m60qna…", "to": "8kf22bd…",
  "steps": [
    { "kind": "ddl",   "sql": "DROP INDEX \"users_by_first\"" },
    { "kind": "jslt",  "collection": "users", "stylesheet": [ { "match": "$", "body": { } } ] },
    { "kind": "query", "collection": "users",
      "assert": { "$for": { "it": "$[*]" }, "$where": { "$empty": "$it.name" }, "$return": "$it.id" } }
  ]
}
```

- `from`/`to` are `hashContent(canonicalizeJson(model))` — the
  identity of a **shape**, not a version number a human must remember
  to bump. A migration whose `from` does not match the database's
  recorded shape MUST refuse to run (`JD0020`).
- `kind: "ddl"` executes one rendered statement. The planner produces
  these through the dialect; they are ordinary text in the document so
  a reviewer reads exactly what will run.
- `kind: "jslt"` rewrites every document of a collection through a
  compiled JSLT stylesheet, in batches, inside the migration's
  transaction. The empty stylesheet (`[]`) is the identity transform.
  A step carrying `"draft": true` is a planner placeholder and MUST
  refuse to run (`JD0021`) until the author fills it in.
- `kind: "query"` is an assertion: the query runs over the
  collection's documents and MUST answer an empty sequence (`expect:
  "empty"`, the default) or an EBV-true value (`expect: "ebv"`) for
  the migration to proceed. This is how a migration states its own
  precondition — "no user has a null email before the NOT NULL
  index" — and it is checked on the shadow first.
- `kind: "derive"` recomputes named STORED derived index columns from
  the documents already in a collection — the backfill described in
  §2.1. It is idempotent: a derived value is a pure function of the
  document, so a replay writes what the first run wrote.
- Steps are ordered, and the order is the contract.

### 2.1 Derived spatial columns and the backfill

MODEL-FORMAT §3.1 gives a derived index (`derive: 'geohash' | 'bbox'`)
two physical mappings, chosen by what the driver declares. That choice
belongs to the migration DOCUMENT, because the two mappings really are
different columns: `planMigration(from, to, { dialect, derived })`
takes `'virtual'` (the default: a generated column) or `'stored'`, and
a document planned for one is not the document the other needs.

The difference the runner sees is one step. A generated column arrives
POPULATED — SQLite computes it from every existing row. A stored one
arrives `NULL`, and a query pushed to a `NULL` column silently returns
fewer rows, so the planner emits an explicit `derive` step after the
`ALTER TABLE … ADD COLUMN`:

```json
{ "kind": "derive", "collection": "places",
  "columns": [ { "name": "gx_at_gh7", "derive": "geohash", "precision": 7,
                 "segments": [ { "name": "at" } ] } ] }
```

A `jslt` transform on such a collection gets the same treatment for the
same reason: it rewrites the documents the columns are computed from,
so the planner follows it with a `derive` step that recomputes them.

A `derive: 'vector'` column (MODEL-FORMAT §2.1) is stored under BOTH
mappings, so the planner emits its backfill whatever `derived` says,
and the column entry carries the width the value is packed to:

```json
{ "kind": "derive", "collection": "items",
  "columns": [ { "name": "gx_embedding_v768", "derive": "vector", "dims": 768,
                 "segments": [ { "name": "embedding" } ] } ] }
```

## 3. Planning and the widening/narrowing rule

`planMigration(fromModel, toModel, { dialect, id, derived })` produces
`{ migration, report }` by diffing the two models' PHYSICAL plans:

- An added collection becomes its full CREATE DDL; a removed
  collection becomes a `DROP TABLE` step whose note says
  **DESTRUCTIVE** plainly, and `report.destructive` is `true` — the
  planner never guesses at data loss.
- A rename cannot be inferred from a diff. It is DECLARED with
  `"x-rename": "oldName"` on the target collection; the planner emits
  the rename first and rebuilds the indexes (a renamed SQLite table
  keeps its old index names — probed). Without the hint, a rename is
  a drop plus a create and the report says so.
- Added, removed and changed indexes become index DDL — reusing the
  store's own DDL generator, never a second implementation. A changed
  generated column (type or path) is a drop plus an add, with its
  dependent indexes dropped first and recreated after.
- A changed schema gets a `jslt` step with the identity stylesheet and
  `"draft": true`. The planner **cannot** infer a data transform and
  MUST NOT pretend to — a silent identity transform is how data gets
  quietly lost. The author fills in the stylesheet, or deletes the
  step when the change is a pure widening.
- **The widening/narrowing rule runs against real data, not schema
  comparison**: at the end of the migration run (inside its
  transaction) every stored document is validated against the target
  schema through the injected `compileSchema` hook. A document that no
  longer validates is `JD0021` and the whole migration rolls back — a
  narrowing without an adequate transform cannot land. A widening
  needs no transform, and passes this check by fact.
- Changing a collection's key declaration is not planned (a rebuild);
  the planner refuses with a `TypeError` naming the non-goal.

## 4. The shadow database

Before the real store is touched, the WHOLE chain — the baseline
shape, every applied migration, every pending migration — replays on a
shadow database (`:memory:` by default; free with SQLite, no server).
The shadow proves **structure**: every DDL statement runs, every
stylesheet and assertion compiles and executes, and the end shape is
verified against the target model. A failure there leaves the real
store untouched.

The shadow runs over an empty data set; the real-data facts (the
widening check, key consistency, the assertions over real rows) run on
the real store inside its transaction. The model format declares no
UDF-expression indexes, so there is no function set to re-register on
the shadow — stated here because a dialect that allowed such indexes
would make the shadow fail on a schema the real store accepts.

## 5. History and checksums

```
_jaren_migrations(id TEXT PRIMARY KEY, applied_at INTEGER,
                  from_hash TEXT, to_hash TEXT, checksum TEXT, steps INTEGER)
```

`checksum` is `hashContent(canonicalizeJson(migration))` —
signature-grade (D12), never the memo-grade `contentKey`. On every
run, the supplied migration list MUST contain every applied migration,
in order, with matching checksums; a migration whose recorded checksum
differs from the document on disk is `JD0022` — someone edited an
applied migration, which is always a bug and always worth failing on.
The database's current shape is the last applied `to_hash`, or the
hash of the `baseline` model when no migration has run.

## 6. Running and batching

`migrate({ driver, path }, migrations, options)`:

- `options.baseline` (REQUIRED) — the model the store was FIRST
  created with: the chain's anchor and the shadow's starting shape.
- `options.model` (RECOMMENDED) — the target model. When present, the
  last pending migration's `to` MUST equal its shape hash (`JD0020`
  otherwise), the physical end shape is verified, and the real-data
  validation of §3 runs.
- `dryRun: true` prints every statement and the affected document
  counts, validates the chain on the shadow, and writes NOTHING. The
  API default is to run; a CLI SHOULD default to the dry run.
- Each pending migration runs in ONE exclusive transaction
  (`BEGIN IMMEDIATE` on SQLite — concurrent writers wait or time out
  under the busy timeout) with a savepoint per step; any failure rolls
  back the whole migration including its earlier steps. Where a driver
  cannot open exclusively, the transaction still isolates; the busy
  policy of MODEL-FORMAT §4 governs contention.
- JSLT steps walk the collection in bounded batches
  (`options.batchSize`, default 500) ordered by row identity, report
  progress through `options.onProgress`, and never hold the whole
  collection in memory. Assertion steps read the whole collection into
  one array — a documented cost; keep assertions early, before the
  data grows.
- A transform MUST NOT change a caller-keyed document's key member —
  the key column would go stale; the run refuses (`JD0023`).

## 7. Non-goals

- **Down migrations are not shipped in 0.1.** A JSLT transform is not
  generally invertible, and a reverse step that silently loses data is
  worse than a restore from backup. The recommended path: branch the
  shape (a new collection or a new store), migrate forward, drop the
  old collection once verified. `down` is not planned for this format
  version; if it ever arrives it will be an explicit author-written
  document, never an inferred inverse.
- **Inferred renames.** A diff cannot distinguish a rename from a drop
  plus a create; guessing risks silent data loss. Renames are declared
  with `x-rename`, or they are what they look like.
- **Key-declaration changes** (see §3) — a rebuild, not a migration
  step.

## 8. Error codes

| code | raised when |
|---|---|
| `JD0020` | the migration's from-shape does not match the database |
| `JD0021` | the migration is missing a required data transform |
| `JD0022` | an applied migration disagrees with the history record |
| `JD0023` | a migration step failed |

These live in the same runtime `DB_CODES` table as the storage codes
(MODEL-FORMAT §7); the union of both documents is proven in sync with
the runtime table by a test.

## 9. Relational changes (entities)

`planModelMigration(fromModel, toModel, { dialect })` extends the §3
planner to models with `entities`. The strategy table is the design;
every row has a shadow-verified test that migrates seeded data:

| Change | Strategy |
|---|---|
| add mapped column (property added, or moved out of the document) | `ALTER TABLE ADD COLUMN` — always nullable (absent reads back absent, MODEL-FORMAT §9.3) — plus a `sql` data step when the property's values already live in the document |
| drop mapped column (property removed, or moved into the document) | fold the column back into the document first (`sql` step) when the property survives; drop its index, then `DROP COLUMN` where SQLite's conditions hold, else rebuild |
| change type / enum CHECK / key / epoch flavor | **rebuild** (§10) |
| add or drop an index (`unique`/`index`/version) | plain DDL |
| add or drop a relation (foreign-key column, join table) | foreign keys **rebuild** the holder; join tables create/drop directly |
| entity added / dropped | create / `DROP TABLE` (destructive, named) |
| entity renamed | declared with `x-rename` on the target entity — never inferred; join tables renamed mechanically with their endpoints |
| scalar ⇄ JSONB move (`column: "json"` toggled, shape change) | rebuild + a data step |

Two rules keep the diff honest:

- **Document changes are compared with `x-entity` stripped.** A pure
  mapping change (an index added, a column toggle) is NOT a document
  schema change and demands no transform; a real document change
  yields the §3 draft-`jslt` step over the entity's table.
- **Epoch columns populate in SQL** via
  `(julianday(value) − 2440587.5) × 86 400 000`, rounded to the
  millisecond — fractional seconds beyond that are the write
  contract's business (MODEL-FORMAT §10.3), not the migration's.

### 9.4 The `sql` step

```json
{ "kind": "sql", "sql": "UPDATE …", "note": "why" }
```

A data step spelled directly — for row-shuffling that is more honest
as SQL than as a stylesheet. Runs like `ddl` (inside the migration's
transaction, its own savepoint), but a dry run ALWAYS prints it with
its note, and reviewers read intent from the kind.

## 10. The rebuild procedure

SQLite's `ALTER TABLE` cannot drop a constraint, change a type or
reorder columns; the documented procedure for "making other kinds of
table schema changes" (sqlite.org/lang_altertable.html §7) is followed
literally, as one implementation used by every rebuilding strategy:

```json
{ "kind": "rebuild", "table": "User",
  "create": ["CREATE TABLE \"User__rebuild\" (…)"],
  "copy": "INSERT INTO \"User__rebuild\" (…) SELECT … FROM \"User\"",
  "indexes": ["CREATE INDEX …"], "note": "…" }
```

The step is SELF-CONTAINED rendered SQL — reviewable in the migration
document, mechanical to run: create the new shape under the temporary
name, copy (the planner renders the column mapping: surviving columns
verbatim, new ones from the document, dropped ones already folded),
`DROP` the old table, `RENAME` the new one into place, recreate every
index from the target model, then **`PRAGMA foreign_key_check` inside
the transaction** — a broken reference fails the migration rather
than shipping.

Two deviations from the cited twelve steps, recorded: (1) the
procedure brackets itself with `PRAGMA foreign_keys=OFF/ON`, which is
a no-op inside a transaction — the migration connection never enables
the pragma (SQLite's default is off; `openStore` enables AND verifies
it per connection), so enforcement during the rebuild is off exactly
as the procedure wants, and `foreign_key_check` provides the
guarantee; (2) triggers and views are not re-created because this
store creates none — a hand-added trigger is outside the model and
outside the diff, which drift (§12) will name.

**Shape equality is the acceptance criterion.** After a rebuild —
after ANY relational migration — the database's declared schema
(`schemaShapeOf`) must equal what a fresh `createModelShape(toModel)`
produces, indexes, foreign keys and constraints included. The shadow
asserts it before the real database is touched, and the real run
asserts it again after the last migration.

**UDF-expression indexes.** An index over a registered deterministic
function is invisible to any connection that has not registered the
function (probed): `migrate(…, { registerFunctions })` re-registers
every declared function on the real, shadow AND reference connections
before any DDL runs — without it, a rebuild would fail (or silently
drop the index) on a schema the store accepts.

## 11. The CLI

`jaren-db` drives the workflow (mirroring `jaren-emit`):

```
jaren-db plan   --from <model> --to <model> [--store <db>] [--id x] [--out file]
jaren-db status --model <model> --store <db> --baseline <model> [--migrations <dir>]
jaren-db apply  --store <db> --baseline <model> --migrations <dir> [--model <m>] [--dry-run] [--yes]
jaren-db check  --model <model> --store <db> --baseline <model> [--migrations <dir>]
jaren-db shape  --model <model>
```

- `plan` diffs two model FILES (a database stores shape hashes, not
  models — the from-model is the previous model file); with `--store`
  it first verifies the from-model's hash matches the database's
  recorded shape.
- `check` is the CI command: exit 1 when migrations are pending OR the
  database drifted; 0 in sync.
- `apply` prints every statement before running; destructive steps
  (drop table/column, rebuild) require `--yes` or an interactive
  confirmation that NAMES what is lost. Default is dry-run + ask.
- `status` lists applied/pending and reports drift (§12).
- `shape` prints the physical mapping a model produces.

## 12. Drift

Drift is the database not matching what its history says it should
be: someone changed it by hand. `status`/`check` detect it by
verifying the current model's physical shape against the actual
database (`schemaShapeOf` against `createModelShape`, when the chain
is fully applied) — a hand-added index, a dropped column or a foreign
key edited outside a migration is named early, which is the
difference between a puzzled afternoon and a five-minute fix.

Down migrations REMAIN a non-goal (§7's reasoning is unchanged): a
down migration is a data-loss generator wearing a seatbelt; recovery
is a backup restored plus the forward chain.
