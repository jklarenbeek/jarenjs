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
- Steps are ordered, and the order is the contract.

## 3. Planning and the widening/narrowing rule

`planMigration(fromModel, toModel, { dialect, id })` produces
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
