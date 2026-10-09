# Upgrading migration history to exact identity

New planner and migration-pen output uses `$migration: "0.2"`. Its exact model
endpoints and canonical document receipts prevent a short-hash collision from
authorizing a different artifact. Existing applied 0.1 documents and normal
history rows remain unchanged. Ordinary status/apply refuse unadopted legacy
history and newly pending 0.1 work with `JD0028`.

Use this procedure on a reviewed copy first, then follow the application's
normal backup and rollout procedure. Adoption attests the artifacts and current
model you reviewed; an old checksum cannot prove which colliding document ran.
The protocol is specified in [MIGRATION-FORMAT §5](MIGRATION-FORMAT.md#5-history-and-checksums).

A consistent backup must keep application data, `_jaren_migrations` and
`_jaren_migration_identity` together. Preserve the normal rows' ordering values
(SQLite `rowid` or PostgreSQL `rid`), columns and complete side payloads; an
application-table-only export is insufficient. Use a backend-consistent snapshot,
including committed WAL, rather than copying an open SQLite main file alone
([native backup behavior](HOSTS.md#existing-file-adoption-and-backup)). Reopen a
restored copy and verify its full history against the unchanged reviewed artifacts
before using it. Do not recreate missing receipts from short checksums.

## 1. Preserve applied artifacts before upgrading

Keep each applied JSON file byte-for-byte. Do not change `$migration`, add an
`identity`, re-plan an applied link or reevaluate its module with an upgraded pen.
`defineMigration` and planners now emit 0.2; unchanged JavaScript source can
therefore emit a different document after a dependency upgrade.

For code-first migrations, retain the old lockfile, original modules, dependencies
and model snapshots. Under that pinned old toolchain, use its status command to
identify the complete applied prefix. Capture those emissions to immutable JSON
in a separate reviewed directory, one file per applied history id, in history
order. Keep pending artifacts outside this applied-prefix directory.

For example, run this script from the preserved old checkout, with the explicit
reviewed file list substituted. It refuses to overwrite an existing capture:

```js
import { copyFileSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { loadDocument } from '@jarenjs/json/node';

const applied = ['migrations/0001-create.mjs', 'migrations/0002-handles.json'];
const destination = './reviewed-applied';
mkdirSync(destination);
for (const file of applied) {
  const output = join(destination, `${basename(file, extname(file))}.json`);
  if (extname(file) === '.json') copyFileSync(file, output, constants.COPYFILE_EXCL);
  else {
    const document = await loadDocument(file, { what: 'migration', exportName: 'migration' });
    writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  }
}
```

Capture the current model and original shadow baseline under the same pinned
runtime if they are code-generated. Review and preserve those outputs too. If the
upgrade already happened, an isolated checkout with the pinned old runtime can
reproduce emissions for review; that does not prove which artifact originally
ran. Never silently adopt newly emitted 0.2 replacements for applied 0.1 modules.

## 2. Observe and review the complete stored history

After installing the new release:

```sh
mkdir -p ./review
jaren-db history --store ./app.db --out ./review/history.observed.json
```

The JSON contains `version: 1`, the dialect and ordering discriminator, every
normal history row and the current exact side metadata. `rowid`/`rid`,
`applied_at` and `steps` are SQL text projections, so values beyond 2^53 and
fractional PostgreSQL timestamps survive JSON without Number rounding. Raw fields
can be null or malformed for diagnosis; observing them does not authorize them.
The command creates neither history table.

Review the complete ordered prefix against the preserved artifacts, the current
model and the application's actual data. The old id/hash/checksum/count checks
are necessary but cannot recover exact historical identity. Review physical
mappings with their complete owned schema and programs; mappings alone cannot
establish the state of triggers or indexes. Save a complete `physicalTarget`
when the final applied physical artifact does not already carry one.

## 3. Attest exactly that applied prefix

```sh
jaren-db adopt-history --store ./app.db --migrations ./reviewed-applied \
  --observed ./review/history.observed.json --model ./review/current-model.json --yes
```

Add `--physical-target ./review/physical-target.json` for an explicitly selected
complete physical target. Without `--yes`, an interactive terminal asks for
confirmation; unattended calls refuse. Adoption has no `--dry-run`. New history
command misuse exits 2; an authority or runtime failure exits 1.

The first successful result is `{ "adopted": N, "unchanged": 0 }`. These count
legacy receipts attested; no migration step executes. Only the side metadata is
written. Original history columns, ordering values, application rows and reviewed
files remain unchanged. Repeating the exact operation with its original
observation returns `{ "adopted": 0, "unchanged": N }` and writes nothing.

Changed rows, a different model/target/document, appended history, partial side
metadata or a stale observation refuse. Re-observe and review the actual state;
there is no force/allowLegacy switch or automatic metadata repair. An empty
history or a history containing only exact artifacts uses the normal 0.2 workflow
and cannot be relabeled as a legacy prefix.

For an application-managed connection, the equivalent public API is:

```js
import { migrationHistory, adoptMigrationHistory } from '@jarenjs/db';
const target = { connection };
const observed = await migrationHistory(target);
const result = await adoptMigrationHistory(target, appliedLegacyDocuments, {
  observed, model: currentModel, shadowDriver, physicalTarget,
  // Include compileSchema when logical stored-document validation is required.
});
```

Owned `{ driver, path? }` targets return promises and close acquired connections.
Borrowed synchronous targets preserve their value boundary and stay open.
Observation accepts `runtime`, `signal` and `deadline`; adoption also accepts
`physicalTarget`, `shadowDriver`, `registerFunctions`, `compileSchema`,
`expressions` and `batchSize`. Options are closed. Logical row validation is
conditional on `compileSchema`; the native CLI supplies no implicit validator.
PostgreSQL migration/adoption writers require effective `READ COMMITTED` and
refuse stronger transaction snapshots with `JD0021`, preserving caller isolation.
Read-only status/history see their caller's transaction view.

## 4. Extend the reviewed chain with new exact artifacts

Keep the adopted JSON prefix unchanged in the ordinary full migrations directory.
Author and review a new 0.2 tail from the attested current model. Old pending 0.1
files cannot execute; preserve them outside the active directory and deliberately
author/review their 0.2 replacements. `fromPlanned` accepts only current exact
artifacts and refuses recognized 0.1 input with `JL0102`.

```sh
jaren-db apply --store ./app.db --baseline ./review/original-model.json \
  --model ./model.json --migrations ./migrations --dry-run
jaren-db apply --store ./app.db --baseline ./review/original-model.json \
  --model ./model.json --migrations ./migrations --yes
jaren-db check --store ./app.db --model ./model.json --migrations ./migrations
```

The CLI dry run only prints; it still refuses unverifiable legacy authority.
Real apply performs the runner's acceptance checks before reporting success,
including no-pending runs. Model comparison is canonical, while the admitted source retains declaration
order for execution and generated program identities. Shadow replay executes the actual verified legacy
prefix on an independent empty shadow, establishes its attested boundary, then
runs the exact tail. It never copies primary receipts to skip work. Legacy
starting/intermediate exact models remain unknown; adoption establishes the
reviewed current boundary, not unavailable historical facts.

These operations establish different things:

| Operation | Result |
|---|---|
| Physical adoption: `openStore(..., { adopt: true })` | Verifies an existing physical mapping; grants no migration-history authority. |
| Identity attestation: `adopt-history` / `adoptMigrationHistory` | Records exact receipts for the reviewed applied 0.1 prefix without rerunning its steps. |
| New zero-step physical baseline | Starts 0.2 history for an existing schema with no applied migration records; saves a reviewed model-to-itself target. |
| New planner or pen output | Authors a pending 0.2 artifact; the runner applies it and records both receipt families. |

File-only `migrateDocuments`, `streamDocuments` and `jaren-db documents` retain
structural 0.1 compatibility because they have no database history.

## 5. Refusals to resolve before retrying

| Code | Meaning and next step |
|---|---|
| `JD0028` | Legacy authority needs explicit observation/attestation, or pending work is 0.1. Preserve applied files; deliberately author pending replacements as 0.2. |
| `JD0022` | The complete history, observation, exact document or side authority disagrees. Stop and compare the stored state with reviewed artifacts and backups; do not delete or regenerate receipts. |
| `JD0020` | The baseline, adjacent exact endpoints or supplied model disagree. Select the matching model snapshots and full chain without editing applied artifacts. |
| `JD0021` | A draft, target-data check, replay prerequisite or writer setting refuses. Read the named reason; provide the required transform/target/independent shadow or dedicated PostgreSQL `READ COMMITTED` scope. |
| `JD0023` | A malformed migration, failed step or physical acceptance check refuses. Inspect the reason and any classified cause before changing pending work. |
| `JL0102` | `fromPlanned` received legacy input or a model that differs from the exact planned endpoint. Keep legacy files immutable and supply the reviewed current artifact/models. |
| `JD0013` | The call itself is malformed: a misspelt option, a malformed control named in [MIGRATION-FORMAT §6](MIGRATION-FORMAT.md#6-running-and-batching), a migration list that repeats an id, or a runtime clock that does not answer integer epoch milliseconds. Correct the call. An option or a repeated id is refused before any connection is acquired; the clock before the run's first link (no step ran) or, when it stops answering an integer mid-run, before the receipt of that link, which rolls back whole while the earlier links stand (an atomic run rolls the whole chain back). With the shadow (the default), its replay reads the clock first, so a clock refused there leaves the database without a step run. A malformed `batchSize`, `atomic`, `hosts`, `assertionBounds` or runtime record is still a `TypeError`. |

A fresh observation is a review input, not permission to repair authority
metadata. These codes do not replace the application's restore and rollout policy.

## 6. Stricter migration admission

Calls that were accepted, or refused only after work began, now refuse before
a connection is acquired or a link runs:

- A `deadline` that is not a finite number escaped as a raw `TypeError`
  (`deadline is an epoch-millisecond number`); `migrate`, `migrationStatus`,
  `migrationHistory` and `adoptMigrationHistory` now refuse it `JD0013`.
- A `registerFunctions`, `compileSchema`, `onProgress` or `onAssertionPlan` that
  is not a function was ignored, or failed as a raw `TypeError` after an owned
  connection had opened and created its file; it is now `JD0013` before
  anything opens, as is a `shadowFixture` that is not a function (a raw
  `TypeError` before).
- An `expressions` that is not a plain object and a `shadowDriver` without
  `open()` were ignored; both are now `JD0013`.
- A `dryRun` or `shadow` that is not a boolean, and a `shadowPath` that is not
  a string, were read loosely (`dryRun: 'true'` applied the migration for
  real); `migrate` now refuses them `JD0013`.
- `migrationStatus` and `adoptMigrationHistory` read `physicalTarget: null` as
  no target, and `migrationStatus` checked an explicit target only once nothing
  was pending; both now refuse a malformed explicit target `JD0021` before
  acquisition, as `migrate` already did.
- A migration list that repeats an id committed its earlier links and then
  failed the repeated one on the history key (`JD0023`), while
  `migrationStatus` reported that id pending forever; `migrate`,
  `migrationStatus` and `adoptMigrationHistory` now refuse the list `JD0013`,
  naming the id and both positions, before any link runs. A revert/redo chain
  planned without explicit ids repeats the planner's default id
  ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#3-planning-and-the-wideningnarrowing-rule)).
- A runtime record whose `now()` answered a fraction (or a non-finite or
  out-of-range value) ran a link's steps on SQLite and then failed its receipt
  (`JD0023`, rolled back), while PostgreSQL stored the fraction; a run now
  refuses it `JD0013` before its first link, on both.
- A clock that stops answering an integer after that first read failed the
  receipt it could not stamp the same way (`JD0023` on SQLite, the fraction
  stored on PostgreSQL); each receipt's stamp is now refused `JD0013` before
  its insert, on both, and that link rolls back whole while the earlier links
  stand (an atomic run rolls the whole chain back). With the shadow (the
  default) the shadow's replay reads the clock first, so a clock it cannot use
  is refused there, before the database runs any step.
- An owned `{ driver, path? }` target threw some admission refusals of `migrate`
  and `adoptMigrationHistory`, and a non-array list of `migrationStatus`,
  synchronously; every refusal of an owned call is now a rejected promise. A
  borrowed `{ connection }` target still throws, and a target of neither form
  is a `TypeError`, thrown.
- Over a driver whose `open()` answers synchronously (the wasm driver over a
  synchronous handle), an owned call also threw what it met after acquisition
  (a malformed document, a history the list disagrees with, a failed step)
  and an `open()` that throws; these are rejected promises now as well.
- `jaren-db history`, `status`, `check` and `apply --dry-run` created a missing
  `--store` file and reported it as an empty history; they now refuse it
  (`the database file does not exist`, exit 1) and create nothing.
- `jaren-db plan --store` created a missing store and reported its empty
  shape as drift from the from-model, `adopt-history` created it before
  refusing the attestation (`JD0022`), and an `apply` that was only printed
  (no `--yes` and nobody to ask, or a declined confirmation) left an empty
  store behind, as did an `apply` without `--yes` that found nothing pending;
  the first two now refuse a missing store the same way, the printout reads it
  as the empty database the confirmed apply creates, and the apply with
  nothing pending only reports. These hold for a `--store` named by a plain
  path; a `file:` URI reaches SQLite as written, and without `mode=ro` or
  `mode=rw` it still creates a missing file.
- `jaren-db apply` of pending work onto a database that drifted from its target
  exited 0 and left the verdict to the next run; it now reports the applied
  links and exits 1 naming the drift, as the no-op rerun does.

### Rebuilt PostgreSQL tables

A PostgreSQL rebuild step left the table's primary key under the temporary
table's name (`<table>__rebuild_pkey`); it restarted an allocated key's
sequence at 1, so the next allocations collided with copied keys and, once
past them, could hand out again keys the table had handed out before; and it
renumbered `rid`, so an entity read with no ordering could answer its rows in
another order. A rebuild now continues every sequence from the old table's
next value and past the copied values, keeps each row's `rid`, and gives the
key `<table>_pkey` where no other relation holds that name
([MIGRATION-FORMAT §10](MIGRATION-FORMAT.md#10-the-rebuild-procedure)). Plan
an unapplied rebuild document again.

A rebuild also left the table open to writers while it ran, so a row another
session committed after the copy read the table was dropped with the old
table, silently. A rebuild now blocks writers to that table until it commits:
its first statement is `LOCK TABLE "<table>" IN SHARE ROW EXCLUSIVE MODE`, held
to the end of the link (of the chain, in an atomic run). Reads go on until the
old table is dropped. A waiting write continues against the rebuilt table once
the link commits; through a store it is refused `JD2005`, `class: 'busy'`,
`retryable: true`, if its wait outlasts the driver's `lockTimeoutMs` (5000 by
default). Plan a rebuild of a table under write load with that wait in mind.

A table an earlier release rebuilt needs no rename: the store reads the name
of the table's key constraint from the catalog when it opens, whatever the
server called it (`<table>__rebuild_pkey`, or the number PostgreSQL appends to
a taken key name, `Post_pkey1`). Its allocated key's sequence needs repair
once, per key, with the store's schema on the search path; here `Post` keys by
`pid`:

```sql
SELECT setval(pg_get_serial_sequence('"Post"', 'pid'),
  GREATEST(nextval(pg_get_serial_sequence('"Post"', 'pid')), COALESCE((SELECT max("pid") FROM "Post"), 0) + 1), false);
```

It sets the next key past the highest key the table holds, and never moves
the sequence backwards. Keys deleted from the top of the table before that
rebuild were forgotten with its old sequence: if anything outside the table
still refers to one, advance the sequence past it by hand. The `rid` order
that rebuild gave the rows stays.

One difference from SQLite remains. A rebuild of an entity that another
object depends on — a foreign key, another entity's or its own, or a view —
is refused `JD0023` naming the dependent as the server does, and the link
rolls back whole: PostgreSQL refuses to drop a table another object depends
on, and the rebuild re-points nothing.

## 7. Stricter reads and exact sums

Store reads that silently ignored a mistake, or answered differently from
the query engine, now refuse by code or answer what the engine answers:

- A graph-load specification (`load`, `page`, `loadCursor`, `explainLoad`)
  with a member no node reads — `wher` for `where` — loaded, and tracked,
  every row, and `null` or a string loaded everything too; such a
  specification is now `JD0032` naming the nearest member, as is an include
  entry that is neither `true` nor a plain object (a raw `TypeError` for
  `null` before) and a `maxDepth` inside an include, which bounds the whole
  graph from the root.
- The options of `load` and of a collection's `execute` and `query` ignored a
  misspelt member (`signl`, `profle`, `strictStreamin`); they are now
  `JD0013` naming the nearest member, as `all()` and `page()` already were,
  and `execute(doc, { strictStreaming: true })` is `JD0013` where it was a raw
  `TypeError`. `null` in place of those options — `execute(doc, null)`,
  `query(doc, null)`, `load(spec, null)` — was read as no options; it is now
  `JD0013` (options must be a plain object), as `all(null)` and
  `page(spec, null)` already were. The options of an entity query's `execute`,
  cursor and `explain`, of `loadCursor` and of a collection's `explain` are
  closed the same way (a cursor and `loadCursor` keep `tracking`), and on all
  of these calls a malformed `signal`, `deadline`, `strictStreaming` or
  `externals` value is `JD0013` where it was ignored — a `deadline` that is not
  a number was a raw `TypeError`.
- An entity query over a member name SQLite's path grammar cannot spell (an
  embedded `"`) threw an uncoded `Error` on SQLite; it now runs in the engine
  there, as a collection query does (`explain()` names `bind.path`, strict
  mode refuses `JD0010`), and a graph load over such a name is `JD0032`. A
  profile's mandatory predicate (`profile.predicates`) over such a name also
  threw that uncoded `Error` on SQLite; it runs in the database or not at
  all, so the query is now refused `JD0011` and the graph load `JD0032`.
- On SQLite a member name holding a backslash was read through JSON escapes:
  a patch could store an invalid escape that made every later read of the
  collection a raw `SyntaxError`, and a filter or a generated index column
  read another member. The path is now escaped. A file created before this
  release with an index over such a member is refused at open (`JD0002`,
  naming the generated column); rebuild the index with two planned
  migrations, one dropping it and one declaring it again.
- On PostgreSQL a literal comparison, a bound list and a string operator over a
  collection member or an entity's document member read the member's typed
  extraction alone — the indexed column itself — so the planner prices the
  value's true selectivity where a `CASE` over `jsonb_typeof` hid it: under a
  profile with `refuseFullScan`, a value the table's statistics show to be
  common is now refused `JD0011` as the sequential scan it always was, where
  the old estimate of one row admitted an index plan reading the same rows.
  A rare value still seeks; narrow the predicate or run that query without
  the profile.
- On PostgreSQL one statement now carries at most 128 leaf predicates, counted
  once the planner has regrouped (a membership list is one leaf; an `$or` of
  `$and` pairs or a top-level `$and` of `$ne` counts per leaf, as does each
  comparison between two bindings that refines a join, and the profile's
  mandatory predicate is included), because a longer chain is priced into an LLVM
  compile the server cannot interrupt. A query document past the bound runs in
  the engine where it was native (`predicate.termBound` in `explain()`,
  `JD0010` under strict mode, and under a profile `JD2007` past `maxRows` or
  `JD0011` under `refuseFullScan`), and a `load({ where })`, `explainLoad` or
  native `mutate()` past it, which ran natively before, is refused `JD0032` or
  `JD0038` naming the bound. Shorten the chain, spell equalities on one member
  as a list, or run the read through `execute()`, where the engine answers it.
- On PostgreSQL `explain().budget.estimatedRows` is now the planner's own
  estimate, `{ rows, source: 'postgresql-planner' }`, for a native plan, where
  it was `'unavailable'` (the `'available'` the declaration also named was never
  produced), and `explainLoad` asks the server for it, so it answers a promise
  where it answered a value: `await` it (SQLite's stays a value). `explain()` of
  a native plan makes one more round trip on PostgreSQL.
- On PostgreSQL an external operand compared with an entity column now answers as
  the engine does: a `$ne` against an external of the column's other type matches
  every present value (it matched none), a boolean column equals and orders
  against neither a string nor a number, and a boolean or object external sends
  the call to the engine, as it does on SQLite: strict mode refuses it `JD0010`
  and `refuseFullScan` `JD0011`, where it ran natively. A profile's mandatory
  predicate comparing a column with such an external is refused `JD0011`, as it is
  on SQLite; it filtered by a wrong answer before.
- A number that an integer column of an adopted table cannot take as its own type
  (a fraction, an infinity, a magnitude past 64 bits) compares as the integers the
  comparison admits (`qty < 2.5` is `qty <= 2`). On PostgreSQL `execute`, `load` and
  `mutate` refused it `JD2005` (`invalid input syntax for type integer`); an integral
  literal outside a `smallint` or `integer` column's own range still is.
- A graph load answered wrongly in three shapes. A `count: true` include counted
  every related row whatever the profile admitted (the related entity's allow-list
  and mandatory predicate now hold the count, as they hold the rows an include
  loads), so a profile's count shrinks to the rows it lets the caller read and is
  refused as the rows would be: `JD0011` when the profile does not list the
  related entity, `JD0032` when that entity's predicate names an external or
  pushes the load past the term bound. A
  many-to-many include with a `where`, or over an entity that a profile gives a
  predicate, was refused `JD2005` on both engines; it now filters inside its
  subquery. And on SQLite a relation holding both a `where` and a nested relation
  with its own `where` bound the two filters' values in the wrong order, so the
  load answered other rows than it asked for; each filter now takes its own.
- A `NaN` literal in a comparison is answered where the query is planned: it
  equals nothing, orders against nothing and differs from every present member,
  so `$ne` is the existence test and the other comparisons are constant `false`.
  On SQLite it bound as `NULL`, which a negation turned into an unanswered row,
  and on PostgreSQL it sorted above every number, so `$not` of it, `$ne` and a
  `load({ where })` answered other rows than the engine.
- A collection `$sum` or `$avg` over a `number` member answered SQLite's
  compensated or PostgreSQL's exact sum; it now runs in the engine, whose
  left-to-right addition is the documented answer (`plan.floatingAccumulation`
  in `explain()`, `JD0010` under strict mode) — slower where it was native.
  The pushed `$where` still narrows the fetch, but every selected row is now
  read and added in the engine where one aggregate row was read: a profile's
  `maxRows` bounds those rows (`JD2007` past it), and a live registration of
  such a sum re-runs the whole document on every invalidation instead of
  keeping a running total.
  An `integer` one stays native while every partial sum is exact, and a run
  past that bound is answered by the engine over the rows the pushed
  `$where` selects (`explain().fallback.construct` `'accumulation'`; a
  profile's `maxRows` and `refuseFullScan` bound those rows) or, under strict
  mode, refused `JD0010`. The sum is now
  folded as a double, so a total past `2^53` is no longer a `JD2003` on
  Node's SQLite binding, a group past int64 no longer a `JD2005`, and an
  average inside the bound no longer rounds twice on PostgreSQL; the int64
  overflow fallback is gone with them (`explain().fallback.construct`
  `'overflow'` and the reason `bind.overflow`): a run that overflowed is now
  the `'accumulation'` fallback, and strict mode refuses it, where the
  overflow fallback answered even under `strict: true`. A native temporal
  bucket's `$sum` or `$avg` over `integer` readings (a `$time-bucket`
  `$groupby`, `$resample`'s `sum` and `mean`) carries the same guard: such a
  bucket past int64 was a `JD2005` and past `2^53` a `JD2003` on Node's
  SQLite binding, and its average rounded twice on PostgreSQL; it is now
  answered as any other grouping is. A cursor over a whole integer `$sum` or
  `$avg` — a collection's, or a physical entity's column — is now `buffered`
  (`bind.accumulationWhole`), so `strictStreaming: true` declines it
  `JD0037`, as it declines the floating one. On PostgreSQL an `integer`
  member holding a JSON number past the double range, which only trusted
  SQL or another writer can store, is now refused by such a pushed sum or
  average (`JD2005`, class `overflow`, aborting an open transaction with
  `JD2088`) where it answered the engine's `Infinity`; SQLite still answers
  `Infinity`.
- A temporal bucket's `$sum` or `$avg` over a `number` reading (a
  `$time-bucket` `$groupby`, `$resample`'s `sum` and its default `mean`)
  answered the database's own sum, which is not the engine's left-to-right
  addition — over `1e16, 1, -1e16` the store answered `1` where the engine
  answers `0` — and on SQLite raised `JD2003` or `JD2005` over integer-valued
  readings the engine sums. It now runs in the engine
  (`series.floating-accumulation` in `explain()`, `JD0010` under strict mode)
  over the rows the series index still selects: slower where it was native,
  and a profile's `maxRows` now bounds those fetched rows (`JD2007` past it)
  rather than the buckets. A `$time-bucket` `$sum` or `$avg` over
  `['number', 'null']` that meets a `null` reading, which the store answered,
  is now the engine's `JQ2001`, as a collection's is; `$resample` still skips
  the `null`, and `$min`, `$max`, counts and `integer` readings stay native.
- An ordering over a member of more than one type (`type: ['integer',
  'string']`) was pushed, answering an order the engine refuses (`JQ2005`);
  a query now leaves it to the engine, and a graph load refuses it `JD0032`.
  A `$sum`, `$avg`, `$min` or `$max` over such a member — collection or
  entity, whole, grouped or in a temporal bucket — was pushed too, answering
  where the engine refuses the mixed sequence (`JQ2001`), and differently on
  SQLite and PostgreSQL; it now runs in the engine.
  On PostgreSQL a root `load({ orderBy })` over a document member compared
  the raw `jsonb` values — strings under the database's default collation, a
  JSON `null` apart from a missing member — where an include and a query
  order a string by code point and read the two as one empty key; the root
  load now orders as they do.
- Two query documents differing only in member order — of a `$for` or
  `$let` binding object, or of a `$return` object — no longer share a cached
  plan. On one store the second answered in the first one's row order and
  output member order, and a reversed correlated binding that reads a name
  bound after it answered the first document's rows where it refuses
  `JQ2006` — through `execute`, `explain`, transaction views, a collection's
  `query` cursor, `mode: 'rerun'` live registrations and the XQuery
  front-end's two clause orders. Two graph-load specifications differing
  only in the member order of an `include` shared a statement the same way:
  `load` and `loadCursor` answered the second in the first one's output
  member order. Each member order is now its own statement-cache entry
  (`store.stats().statementCache` counts a reordered document or
  specification, even one whose only change is clause order, as a miss), and
  a predicate pushed as a registered SQL function registers one function per
  member order.
- A collection query whose filter or return reads the collection root
  outside its binding — `{ $count: '$[*]' }` or `'$[0].id'` in a projection,
  a nested query over `$[*]`, the root inside a path filter
  (`$it.xs[?@ == $[0].n]`), a filter comparing with a count of the
  collection — was answered over what the plan handed the engine: one row
  at a time (a count of the collection answered 1 for every row), the rows a
  pushed filter or window kept, or on node:sqlite the row alone inside a
  registered SQL function; it now runs in the engine over the whole
  collection (under a profile, the rows its mandatory predicate keeps) and
  answers what the engine answers, `explain()` naming the reason (`'$'`)
  where a narrowing was dropped, so `strict: true` refuses it `JD0010` (the
  formerly native shape included), a profile's `maxRows` bounds and
  `refuseFullScan` refuses that whole read, and a live registration that
  would evaluate it a row at a time (rows, a window, an event-time view's
  operand filter) re-runs, the reason named, where `mode: 'incremental'`
  refuses it `JD0051`.
- A scalar `after` over a unique column that may hold NULL — a member the
  model declares nullable (`['string', 'null']`) or does not require; a key
  never does — ordered with its NULLs last (descending, or ascending with
  `$empty: 'greatest'`) answered the rows that hold a value and left every
  NULL row out of the walk without a word, since the cursor's comparison is
  neither true nor false for them. It is now `JD0032` naming `page()`, whose continuation
  carries the null placement. With the NULLs first the cursor stands, and a
  walk whose first page holds only NULL rows still cannot advance, because a
  row without a value carries none to resume from.
- A continuation compared its ordering as the text a serializer wrote, so one a
  host kept in a PostgreSQL `jsonb` column (which orders the members of an
  object by length) came back refused `JD0035`, the message naming the same
  ordering twice; its terms are compared member by member now and it resumes.
- `explainLoad` read no option it was given beyond `profile`, so a misspelt
  `profle` explained the load under no profile and said so by answering; it
  takes `profile`, the one option its declaration lists, and refuses another
  member `JD0013` naming the nearest one — a `signal` or a `deadline`, which it
  never read, included.

## 8. Stricter models, keys and staged writes

Model documents and store writes that were accepted with a member or a
value the store did not honor now refuse by code, before any statement:

- A model member outside its declaration's closed set
  ([MODEL-FORMAT §2](MODEL-FORMAT.md#2-the-model-document)) was ignored — a
  misspelt `unique` opened a store whose index was not unique, an entity
  `indexes` array was dropped (it now declares entity-level indexes,
  [MODEL-FORMAT §9.2](MODEL-FORMAT.md#92-the-x-entity-vocabulary-a-closed-set)),
  a root `$schema` passed; `openStore`,
  `normalizeModel` and `normalizeEntities` now refuse it `JD0005` at the member,
  naming the nearest one. An index `unique`, an `x-entity` `key`, `unique`,
  `index` or `version`, and a relation's `many` that are not booleans read as
  `false`; they are `JD0005` too. Run `normalizeModel` and `normalizeEntities`
  over a model before upgrading to find them. The canonical schema now admits
  an invariant's `when`, `columns` and `effects`, which it refused while the
  runtime accepted them.
- An invariant's refusal named `/entities/<E>/invariants`; its `docPath` now
  names the rule and the member (`/entities/<E>/invariants/0/enforcement`). An
  unknown member of a `physical` layout or of one of its columns, already
  `JD0005`, now points at the member too (`/entities/<E>/physical/bogus`,
  `/entities/<E>/physical/columns/<name>/bogus`) and names the nearest one.
- An `enforcement: "database"` rule on an entity without a `physical` layout
  opened with no trigger and was enforced by nothing; the store now installs
  its programs with the table and verifies them on every open (the
  store-owned rule bullets below say what an existing table needs).
- A relation to an entity with a `physical` layout opened and failed at its
  first `load({ include })` with a raw `JD2005`; it is now `JD0005` at open.
- Two schema objects a model planned under one name — an index of one
  entity and one of another (`A_b` with a unique `c` and `A` with a unique
  `b_c` both name `A_b_c`), two collections' indexes, a table and an index —
  met at open, where `CREATE … IF NOT EXISTS` skipped the second: its index
  went unenforced and the next open was `JD0002`. Every name a model plans is
  now one namespace (MODEL-FORMAT §2), and a collision is `JD0004` at the
  second object's member before any statement; rename one declaration.
- The namespace compares names with ASCII case folded, as SQLite does: an
  entity `A` and a collection `a` opened on SQLite as ONE table, and two names
  that differ only in case opened on PostgreSQL as two objects. Both are now
  `JD0004`; a database that holds such a pair keeps it until one declaration
  is renamed and its table migrated.
- An entity-level index name (`<Entity>_<name>`) longer than PostgreSQL's 63
  bytes is `JD0004` at its `name`, as a collection index's and a `unique`
  property's names already were, never a name the server truncates.
- A collection index's `where` was ignored, which made a unique index
  unconditional — it refused a cancelled row beside an active one. It is now
  a partial index (MODEL-FORMAT §2); a `where` over a member the collection
  does not index by its path, or whose type admits `null`, is `JD0004` at the
  `where`. A database an earlier release created under such a model holds the
  unconditional index and is `JD0002` at open: drop it and create it with
  its condition, as `jaren-db shape` prints the planned statement (SQLite's
  spelling), or plan a migration to the model from the same model without
  that `where`, which drops and recreates the index.
- The migration planner compared an index's uniqueness and columns only: an
  added partial index planned an unconditional `CREATE INDEX`, which the
  migration's own shape check then refused (`JD0023`), and a changed condition
  planned no step while the next open was `JD0002`. A plan now creates an index
  with its condition and drops and recreates one whose condition changed
  ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#3-planning-and-the-wideningnarrowing-rule)).
- `introspectModel` reported every composite or partial entity index as
  `unmapped-index` and read a one-column index as its property's `unique` or
  `index` whatever its name. It now derives the entity's `indexes` — a
  one-column index is a property's flag only under that property's own name,
  `<Entity>_<member>`, and only as the flag plans it — with a partial
  index's `where` wherever the condition reads back exactly, and reports
  `lossy-type` for a column type two schema types share (SQLite `INTEGER`,
  PostgreSQL `numeric` and `smallint`). A
  caller that branches on report rows meets these; `strict: true` refused
  every such database already (`document-members`). A derived model plans
  back to the declared one with no index change but with a rebuild for each
  `lossy-type` column whose declared type differs and a drafted transform
  for the schema, and on PostgreSQL it reopens a database whose entity has a
  `boolean` member only once that member is typed `boolean` again.
- PostgreSQL's open compared columns, index columns and foreign keys, and
  opened a database whose index gained, lost or changed a condition, whose
  index became `NULLS NOT DISTINCT`, descending or collated otherwise or
  gained an `INCLUDE` column or an operator class of its own, or whose
  generated column's expression changed outside the store. It now reads
  each index's condition and shape and each generated expression back from
  the catalog and compares them exactly, and such a database is `JD0002`
  until the change is reverted. An entity
  whose boolean member declares an `enum` could not open on PostgreSQL
  (`smallint = boolean`); its CHECK now lists the stored `1`/`0` on both
  engines.
- A write under a numeric key column of a string that names no number
  (`'0x10'`, `'NaN'`) reached the database: SQLite refused it `JD2005`, and
  PostgreSQL stored `'0x10'` under 16, replacing that document. It is now
  `JD2002` on both, before any statement.
- The unit of work bound such a key raw too: on PostgreSQL `remove('0x10')`
  and a save deleted row 16, and `link(16, 'tags', '0x10')` linked tag 16,
  while SQLite deleted nothing or failed the save `JD2005`. `remove`, `link`
  and `unlink` now refuse it `JD2002` as they stage it, and a membership array
  carrying one fails its save `JD2002` before any statement. `create()` with
  such a membership array linked tag 16 on PostgreSQL and failed `JD2005` on
  SQLite; it is now `JD2002` before its insert, and every membership refusal
  names the member the key came from (`the key "0x10" in 'tags'`).
- A duplicate key met by `saveChanges()` was the generic `JD2005`; it is now
  `JD2001`, as on `create()` and a collection insert — on PostgreSQL under a
  table name of 59 to 63 bytes too, whose key PostgreSQL names
  `<table, clipped>_pkey` (all three paths stayed `JD2005` there).
- On PostgreSQL a duplicate key is now the violation of the table's primary-key
  constraint as the catalog names it, which the store reads when it opens,
  not of a name that looks like a key's. A table renamed with `x-rename`
  (its key keeps the name it was created under: `Post_pkey` for `Post`
  renamed to `Article`) and an adopted table whose key has another name
  (`CONSTRAINT pk_items PRIMARY KEY`) read `JD2005` for a duplicate key; they
  read `JD2001`. A unique member named `pkey1` (indexed `<entity>_pkey1`) read
  a duplicate value as `JD2001` under a key that did not exist; it reads
  `JD2005` naming the member.
- A write colliding on its key and on another unique member at once read
  `JD2005` naming the member on SQLite under a `string` or `number` key
  (`create()`, a saved `add()`, a collection `insert()`), where PostgreSQL read
  `JD2001`; both read `JD2001` now, because SQLite reads the key the insert
  carried after such a failure. An adopted PostgreSQL table whose unique index
  is older than its key still reports that index first: `JD2005`.
- A duplicate composite key read `JD2005` on both engines; it reads `JD2001`
  naming every member (`a 'Pair' already exists under key {"a":1,"b":"x"}`).
- A caller of `classifyDriverError` or `wrapDriverError` that passes
  `unique: { table, column }` for a PostgreSQL violation was told `duplicate`
  for `<table>_pkey` (and its numbered and clipped forms); it is told
  `constraint` (`JD2005`) unless it also passes `constraint`, the name of the
  table's primary-key constraint.
- On SQLite a trigger of an adopted table whose own insert met the PRIMARY KEY
  of another table was reported as a duplicate key of the entity (`JD2001`,
  `a 'Item' already exists under key 1`, for a key no `Item` holds); only a
  PRIMARY KEY conflict on the table the write inserts into is the key's now, and
  the other table's is a constraint failure (`JD2005`) naming it.
- A duplicate key on an adopted PostgreSQL partitioned table read `JD2005`
  naming the partition's own constraint (`parts_1_pkey`), because every
  partition carries one; it reads `JD2001`. The open reads the key constraint
  of the table and of every partition below it in the store's schema, so a
  partition attached while the store is open reports `JD2005` until the next
  open.
- A text column of an adopted PostgreSQL table collated by a collation a user
  made and named like a code-point one (`"C"`, `POSIX`, `ucs_basic`,
  `pg_c_utf8`) in a schema other than `pg_catalog` was read as the server's
  own and ordered a load, a page and a continuation by that collation, where
  `execute()` orders by code point; it is compared under `COLLATE "C"` now,
  as every other collation that is not known to be code point is.
- `put()` after a pending `remove()` of the same key was returned, and the save
  deleted the row anyway; the put now cancels the removal and the save updates
  the row. A removal saved in a transaction that rolled back, under a key an
  `add()` staged after the save, made that add vanish; both are pending again,
  and the next save deletes, then inserts.
- The opposite rollback — an `add()` saved in a transaction, a `remove()` of
  that row staged after the save — kept both pending: the next save inserted
  and then deleted the row, a `put()` of the key was accepted and lost, and a
  versioned key failed every save `JD2040`. Both are now withdrawn, as
  `remove()` withdraws a pending add: nothing is pending and a `put()` of the
  key is `JD2006`. Such a rollback after the save of a delete-then-insert
  pair left every later save `JD2001`; the removal is now the last word and
  the save deletes the row.
- A `remove()` of a pending add kept the `link()`s and `unlink()`s staged
  under its key, and so did the rollback above for those filed by key: the
  next save wrote their join rows for a row it never inserted and failed
  `JD2005` on the foreign key, on both engines, until `discard`. They are now
  cancelled with the add.
- A parent removed with its children, saved, added back and rolled back
  failed every later save (`JD2005` on a restricting foreign key, `JD2040` on
  a cascading one) until `discard`: the delete run ahead of its re-insert
  met the children's references. Their removals now run ahead too,
  child-first.
- A save in a transaction that rolled back lost or misplaced words staged
  after it. An update the save wrote was lost when the transaction read the
  row again or `discard`ed it (the next save reported nothing to do); a
  `link()` or `unlink()` by the key the save allocated stayed filed under
  that key (SQLite linked whichever row the next save allocated it to,
  PostgreSQL failed every save `JD2005`, an `unlink` was lost on both); an
  edit carried the allocated key into the pending insert (SQLite: `JD2001`
  on every save) and the document `add()` returned no longer named it
  (`JD2003`); a `remove()` of a row the save updated, or one re-staged
  beside a later `add()` of a versioned key, kept a guard the rollback
  withdrew (`JD2040` on every save); a `link()` after the `add()` that
  follows a saved removal was dropped where the removed row held its
  target. Every later word now stays with its row
  ([MODEL-FORMAT §11.1](MODEL-FORMAT.md#111-snapshot-tracking-the-default)).
  Beside such a delete-then-insert pair, the update of a child moved to a
  parent that stays, or edited under a cascading reference, failed every
  save (`JD2005`, `JD2040`) until `discard`; it now runs before the delete.
  One moved to a parent the same save inserts failed every save `JD2040`
  under a cascading reference; it now follows that insert and precedes the
  delete it leaves, so it lands on a parent added in the same save, or on
  one deleted ahead and added back.
- One save of a few thousand single-row statements — updates, removals, or
  `link()` changes read against the join table — overflowed the stack on
  SQLite (an uncoded `RangeError`); the save runs its statements one after
  another without the stack growing with their number.
- A `put()` staged inside a transaction on a row the transaction's save
  deleted and a `create()` wrote again was lost to the restored removal
  when the transaction rolled back (where no row held the key, it was
  dropped); it now cancels that removal as a `put()` does, and the save
  updates the row (or meets its absence, `JD2040`). A `link()` staged on a
  row `create()` wrote inside the rolled-back transaction stayed staged and
  failed every save `JD2005`; it goes with the row.
- A row `create()` or `update()` wrote in a transaction that rolled back
  stayed tracked: a `put()` of it was accepted and every save failed
  `JD2040`. Its tracking goes with the rollback, and the `put()` is `JD2006`.
- `put()` of a pending insert whose document lacks the version member stored
  SQL `NULL`, and every later tracked update failed `JD2040`; the put keeps
  the version `add()` started the row at, and returns the document with it.
- The unit of work read decimal text as text: `unlink(2, 'tags', '16')` was a
  silent no-op, a `link()` of a held membership in another spelling failed
  every save on the join table's key, and `add({ id: '16' })` and
  `remove(16)` were two rows to the tracker. A key now names its number
  wherever the tracker files or compares one.
- A `link()` of a member already held, or an `unlink()` of one not held,
  stayed pending after the save that found it a no-op: `stats()` counted it,
  SQL the store did not plan was refused `JD2041` until `discard`, and a
  later save wrote it over a membership changed elsewhere. The save settles
  it.
- `create()` with a membership naming no row escaped on PostgreSQL as the
  driver's own error, and was `JD2005` without a `class` on SQLite; it is
  `JD2005`, class `constraint`, with the driver error as its `cause`, on
  both.
- An entity document without its key member, where the key is not
  `default: "auto"`, is `JD2002` before any statement: SQLite stored a single
  integer key's row under a rowid of its own choosing, which no tracked record
  named, and PostgreSQL refused the NULL `JD2005`. Under a `physical` layout
  `add()` accepted it and every save failed `JD2003`, the pending insert
  carrying no key to `discard` it by; it is `JD2002` there too, unless the
  key column is generated. Declare `default: "auto"` where the database
  allocates the key.
- Under a `physical` layout, `remove()`, `link()` and `unlink()` of a key the
  key column's codec refuses were accepted, and every later save failed
  `JD2003` until `discard`; they refuse it `JD2003` as they stage it, and a
  `get()` by such a key answers `undefined` rather than throwing.
- An invariant `assert` that does not compile escaped as the query engine's
  own `JQ` error with an empty `docPath`; it is `JD0005` at the rule's
  `assert`. A database rule on a `kind: "view"` layout and an `audit` into an
  entity without a writable column layout were refused only by `openStore`,
  with no `docPath`, while `normalizeEntities` and the migration planner
  accepted them; they are now `JD0005` at `enforcement` and `audit`, by every
  model check.
- A database rule comparing with a `$const` that quotes an object or a list (a
  nested `{ "$const": { "$const": 3 } }`) lowered it as its innermost value,
  which the query engine never finds equal, and one with a text holding U+0000
  planned a program no engine could install; both are now `JD0005` when the
  programs are planned: write the scalar itself, quoted by one `$const` at most.
- On PostgreSQL a database rule's text literal holding a backslash was written
  plainly, so a writer session with `standard_conforming_strings = off` read
  the backslash as an escape and could pass the rule by; it is now written as an
  escape string (`E'…'`), which changes that program's text, so a database that
  installed such a rule refuses to open (`JD0002`) until an explicit migration
  reinstalls the programs `planInvariants` plans.
- A database rule on a layout the store owns (an entity without `physical`) is
  no longer refused: the store creates its programs with the table — SQLite
  triggers, PostgreSQL functions and triggers — and verifies them on every
  open, so a table an earlier model created without them refuses to open
  (`JD0002`) until a migration planned from that model adds them
  (`planModelMigration`, which judges no stored row and creates the programs
  after the migration's transform steps, so a transform can carry stored
  rows into conformance). What such a rule cannot
  lower is `JD0005` at the member: a read of an epoch, document or relation
  member, `audit`, `effects` and `$exists-row`; `columns` keep their refusal.
  Such a rule judges the rows the database's own foreign-key actions write,
  where a store rule runs for none of them: switching a child's delete or
  update rule from `store` to `database` enforcement refuses a parent's
  `cascade` or `setNull` delete that went through before, in the child's
  rule's name ([MODEL-FORMAT §13.4](MODEL-FORMAT.md#134-database-enforcement)).
  `store.introspect()` reports the programs as `unmapped-object` rows and
  derives a model without the rules, which neither opens over that table
  (`JD0002`) nor migrates to the authored model (`JD0023`): open such a
  table with the model that declares its rules.
- On PostgreSQL a store-owned table with rules is created with its functions
  and triggers by plain statements, its `CREATE TABLE` among them, so an open
  whose rival commits the table after this open's probe retries into
  verification; and an open now refuses (`JD0002`) a trigger, or a rewrite
  rule (`CREATE RULE`), that the model does not declare on any table the
  store owns — an entity's, a join table's, a collection's — as SQLite's open
  already refused a trigger. Drop such a trigger or rule, or keep that table
  out of the store's model. That check is one catalog read per store-owned
  table on every PostgreSQL open, ruled or not.
- A store rule on a store-owned layout judged an insert's document as written:
  a member written `null` passed `{ "$eq": ["$.new.n", null] }` on the insert
  and failed every update of the same row, which reads the member back
  missing. A document is now judged as the store reads it back, on the insert
  as on the update, directly and tracked; test such a member with `$exists`.
- A store-owned entity whose member was named like the table's own document
  column (`doc`, on both engines), like its row identity column on PostgreSQL
  (`rid`), or like another member as SQLite compares names (`Id` beside `id`)
  never opened, and said so only in the engine's own words wrapped as `JD0002`
  (SQLite "duplicate column name", PostgreSQL "specified more than once").
  It is now `JD0004` at the member when the model is planned, naming
  the column it would share (MODEL-FORMAT §9.2). What each engine opened
  before still opens: `DOC` and `Id` on PostgreSQL, `rid` on SQLite.
- On PostgreSQL a physical entity's `delete()` that a database rule refused
  inside `store.transaction` spent the transaction (`JD2088` at its next
  statement and its commit); it is a savepoint of its own now, as an insert
  and an update already were, and the transaction goes on.
- On PostgreSQL a write in a savepoint of its own — one a database rule
  judges, a store rule's probing insert, update or delete, a tracked save, a native mutation
  — issued after an earlier failure had spent the transaction answered the
  server's own `25P02`; it is `JD2088` (class `aborted`), as a plain
  statement's was and as the commit is.
- On PostgreSQL a tracked save that changed a member inside a document
  member (`meta.b`) numbered its parameter `$0` when it assigned no column
  (`there is no parameter $0`) and aliased the last column's parameter when
  it assigned one or more (`inconsistent types deduced for parameter`), so
  such a save failed `JD2005`; it writes the member, alone or beside the
  columns and members the save assigns. SQLite was unaffected.
- On PostgreSQL a name the plan gives a table, a column or an index longer
  than 63 bytes (an indexed member past about 60 bytes, a long index,
  property or entity name) failed `openStore` with the dialect's raw
  `TypeError`; it is now `JD0004` at the model member, before any statement.
  SQLite still accepts it. So is, on PostgreSQL alone, an index the plan names
  as PostgreSQL names one of the table's own objects — a unique or indexed
  member, or a collection index, named `pkey`, `rid_seq` or `<key>_seq` beside
  an allocated key (`<table>_pkey`, `<table>_<column>_seq`): the open skipped
  creating it, so nothing enforced the member, and the next open failed
  `JD0002`. Rename the member or the index.
- `jobs.enqueue` ignored a misspelt option (`runat`: the job ran at once) and
  accepted options that were not an object and an `id` of any type; these are
  now `JD0013`. The `TypeError`s for a malformed `runAt` or `maxAttempts` stay.
- `store.live` of a document that names no entity root — a load
  specification, or a `@jarenjs/linq` `include()` chain — was a `TypeError`;
  it is now `JD0033`, as `store.execute` refuses the same document.
- A collection live query with a literal offset over an `orderBy` (nested
  windows included, and a `@jarenjs/linq` `skip()` with no `select` after
  it) is maintained (`live.mode.strategy` `window`) instead of re-run;
  `mode: 'incremental'` now accepts it, ties follow the window's key-text
  order rather than a re-run's row order, and it is charged as a top window
  is — every matching row an entry — so over more rows than
  `live.maxMaintained` it is `JD2060` where it re-ran (`mode: 'rerun'` still
  re-runs it).
- A collection live window with a negative `$subsequence` bound or a
  fractional limit was maintained with rows that differed from `execute`,
  and so were an ordered query inside a one-item array constructor, an
  ordered query whose return yields several items per row and a window whose
  return reads the collection root; they now re-run, the reason named. An
  ordered query whose return uses a registered operator no longer refuses
  registration with `JQ0002`: it re-runs, the operator named.
- A single-level live group whose return is not a key, an aggregate, or an
  object of key and aggregate members — arithmetic over aggregates, the rows
  themselves, a bare member path — is maintained (`live.mode.strategy`
  `group`) instead of re-run, and an aggregate over such groups with it;
  `mode: 'incremental'` now accepts them. They are charged as every
  maintained group is: each source row is an entry and so is each output
  item, and their bytes count against `live.maxBytes`, a copied row's bytes
  again inside the output. At the default `live.maxMaintained` of 10,000 a
  group of 10,000 rows with one output item, or one that grows to it, is
  therefore `JD2060` where it re-ran: register it with `mode: 'rerun'`,
  which keeps only the result, or raise `live.maxMaintained` (and
  `live.maxBytes`). A window over such a group still re-runs, now with the
  reason `a windowed group re-runs`.
- A live group — an object of key and aggregate members included — that
  reads a row bare (`$get` over a row, a nested query over the group's rows
  inside an aggregate, a row-valued key) skipped a write to a member it
  read and kept a stale result; it now depends on every member, as a group
  copying its rows does. Counting the rows (`{ "$count": "$it" }`) still
  reads none.
- A key deleted and inserted again in one transaction kept its old place in
  a live group or distinct projection whose dependencies skip the members
  that changed; it now moves to the end of the source order, as `execute`
  reads it, which costs one row-position read for every held row a skipped
  write touches.
- A live query whose document uses a registered operator, or a named zone
  in a group key or a projection — a rows projection, a group aggregating a
  registered operator, a group keyed by a zoned `$time-bucket`, a refined
  spatial rows return — now re-runs with the planner's reason instead of
  failing registration with `JQ0002`/`JQ0003`; on PostgreSQL a group
  aggregating a registered operator no longer fails registration either. A
  zoned `$where` still fails `JQ0003`, as `execute` does.
- A live whole-collection `$sum` or `$avg` over an `integer` member kept a
  running double sum past the bound in which every partial sum is exact, and
  could answer another total than `execute`, which adds in the order it
  reads the rows. From the write whose terms pass that bound — the largest
  magnitude times the number of terms past 2^53 − 1, a term that is not an
  integer (which an `integer` member stores as given, and whose rounding
  SQL compensates) counting as past it — the registration now re-runs, and
  `live.mode` reports `rerun` with the reason
  `'accumulation' — integer accumulation exceeded its runtime exactness bound`;
  one that demanded `mode: 'incremental'` refuses `JD0051`, or errors with it
  at that write. Past the bound beside a stored `null` term the re-run raises
  `JQ2001`, as `execute` does, where the running sum kept answering. A stored
  `null` term counted toward a live `$avg` and could be its `$min`; `$avg`,
  `$min` and `$max` now skip it, as `execute` does.
- An `@jarenjs/linq` emission of one `groupBy` followed by `select`/`where`
  steps is maintained (`group`) instead of re-run, and so is an aggregate
  over one (`{ "$sum": <emission> }`, the chain's `sum()`);
  `mode: 'incremental'` now accepts them. Such an emission depends on every
  member of a row and is charged as every maintained group is — each source
  row and each output item an entry — so past `live.maxMaintained` it is
  `JD2060` where it re-ran (`mode: 'rerun'` still re-runs it). A row deleted
  and inserted again with an equal value in one transaction keeps its old
  place in the result until a later change to that row reaches capture,
  which records no change for it, where the re-run took the new place at
  its next record. An emission that still re-runs names the group's own
  reason where it named the `'$for'` one: `a windowed group re-runs` for a
  `take` or `skip` after its last step,
  `the group filter did not translate: …` for a row filter the planner does
  not translate, `a spatial group re-runs: …` for a refined spatial one and
  `rows without a document key cannot be tracked` on an unkeyed collection;
  a group of groups and a chain that orders or deduplicates after `groupBy`
  re-run as before.
- A re-run or resnapshot live query — SQLite or PostgreSQL, collection or
  entity — whose document was registered unpacked (a FLWOR rather than a
  one-element array around it, as `toDocument()` hands a chain over) and
  whose result is ONE array value had that array's items as its rows; it
  now has the array as its one row, as every maintained strategy and
  `execute` of the packed document answer. A refusal still names its place
  in the document as registered.
- A live group, nested group or window whose document names the collection
  root inside a path filter (`$it[?@.n > $[0].n]`) was maintained over one
  group or one row at a time and answered otherwise than `execute`; it now
  re-runs, the reason named.
- A flat inner self join over indexed columns — one `$for` binding an entity
  under several aliases — is maintained over a synchronous connection
  (`live.mode.strategy` `join`) instead of re-run, and `mode: 'incremental'`
  there now accepts it (PostgreSQL resnapshots it, as every entity live
  query); an unindexed self join now names its missing index as the re-run
  reason, and a self join charges the shared rows once per alias against
  `live.maxMaintained`, so where a plain join over the same rows fits it can
  be `JD2060` (`mode: 'rerun'` still re-runs it).
- A live entity join whose `$where` or `$return` reads an entity root outside
  its `$for` — a nested query over `$.<Entity>[*]`, such as a correlated
  `$count` — was maintained (`join`) over each outer row's connected rows
  alone and answered otherwise than `execute`; it now re-runs with the reason
  `an entity root read outside the join bindings re-runs` and
  `mode: 'incremental'` refuses it `JD0051`, a graph projection naming the
  root inside a path filter now re-runs with the planner's reason, and a
  `$const` literal spelled like a root path no longer counts as a root read.
- An observer subscribed to a synchronous live query from inside another
  observer's callback also received the emission being delivered, although
  `live.result`, which it starts from, already held it — a mirror built that
  way applied the patch twice; an emission now reaches only the observers
  subscribed when it began.
- A live whole-collection `$min` or `$max` over a string member compared its
  terms by UTF-16 code unit, so beside an astral character (`'\u{1F600}'`
  against `'\uE000'`) it answered otherwise than `execute`; it now orders text
  by code point, as `execute` does.
- A maintained live window whose order term indexes an array from its end
  (`$it.history[-1]`) ranked every row as though the term were absent, and one
  ordered by a member named like an inherited method (`valueOf`,
  `constructor`) ranked a row lacking it by the inherited function; both
  answered otherwise than `execute` and now sort by the value `execute` reads.
- A live query or aggregate inside a one-item array constructor
  (`[[document]]`) was maintained one row per source row (`[["a"], ["b"]]`
  where `execute` answers `[["a", "b"]]`); it now re-runs, the reason named,
  and `mode: 'incremental'` refuses it `JD0051`.
- A live `mode` other than `'auto'`, `'incremental'`, `'rerun'` and
  `'resnapshot'` (a misspelt `'incremenal'`, `true`) registered as `'auto'`; it
  is now `JD0013`.
- A live query held the `externals` object it was registered with, so changing
  that object afterwards changed what maintenance evaluated; it now holds a
  copy, fixed at registration.
- A live graph projection or allowing-empty join whose return needs the store's
  registered operators or zone provider failed registration (`JQ0002`,
  `JQ0003`) where `execute` answered it; it now re-runs, the reason named.
- A live join whose rows reach one another along several equality edges
  counted every path toward its fan-out bound, so a join whose state fit
  `live.maxMaintained` could be refused or closed `JD2060`; each connected row
  now counts once.
- A maintained or re-run live result whose output turned from one non-finite
  number into another (`NaN` into `Infinity`) kept the old value and emitted
  nothing; the change now emits.
- A live group, window or join whose document holds a `$$`-escaped literal
  (`'$$USD'`) re-ran as though it read the collection root; it is now
  maintained.
- An asynchronous (resnapshot) registration that read exactly its
  `maxInputRows` before a statement that read nothing was refused `JD2060`; it
  now registers. A row past `maxInputBytes` that is the first its statement
  reads is `JD2060`, as any other row past it, where it was `JD2074`.
- On a store opened with a `profile` — any profile, `'safe'` included — a
  live registration was maintained past it: a row another tenant wrote
  reached `result` through the mandatory predicate, and an undeclared
  external, `maxRows`, `maxBytes` and the engine `limits` bound nothing
  maintenance evaluated, while a join whose whole-row initial read a member
  allow-list refused was `JD0011`; every registration there now re-runs
  through `execute`, with the reason
  `the store profile's predicates, member lists and limits apply to every read, which maintenance does not repeat`,
  so a demanded `mode: 'incremental'` is `JD0051` (a stricter refusal) and
  that join answers; and a live option a registration does not read — a
  per-call `profile`, which `execute` reads and a registration dropped, or
  a misspelt `mod` — is now `JD0013`, as is `null` in place of the options.
- A `physical.indexes` entry was never verified at open: a layout whose
  declared index had been dropped, made non-unique, re-columned or
  re-conditioned opened on both engines. Opening now verifies each declared
  index as it verifies the columns — present (by name as the engine compares
  names: ASCII case folded on SQLite, exact on PostgreSQL), as unique and as
  conditional as declared, a column keyed under each plain column term in
  order; a term's direction or collation, and a PostgreSQL `INCLUDE` column
  beside the keys, are not compared — and refuses `JD0002` naming the index
  and what differs; an index with a condition or an expression term is
  compared by its CREATE text on SQLite, token by token, so the spelling the
  application created it in (quoting, letter case, whitespace, parentheses
  around the condition) still verifies and another condition does not
  (MODEL-FORMAT §12). Recreate the index as declared — the statement the
  store plans, `explainMapping(model).entities.<E>.declaredIndexes[i].sql`,
  always verifies — or drop the declaration. A migration step that reads such a
  layout verifies its declared indexes too: a step that runs before a later
  step creates one names the layout without it as its `model`. A
  `kind: "view"` layout that declares `indexes` is `JD0005`.
- A store rule's `$add`, `$sub` or `$neg` over integers accepted a result
  outside ±(2^53 − 1), which the engine had rounded; it is now refused
  (`JD2096`), as a database rule's trigger refuses it (MODEL-FORMAT §13.4). A
  write whose arithmetic reads a missing or non-integer member is judged as
  before.
- An `$exists-row` keyed by anything but the target's key, or reading a layout
  the store owns, was `JD0005`; a verified unique index — a `physical.indexes`
  entry, a unique member, an entity index without a condition — and a
  store-owned target's key now key a probe (MODEL-FORMAT §13.2). A probe keyed
  by a partial unique index, or by one with an expression term, stays `JD0005`,
  now naming the index. A `null` literal against a member the probe is keyed
  by — its key, or a column of the index that keys it — planned and matched
  nothing (`code = NULL`); it is now `JD0005` at planning: a keyed member
  matches a value.

### Allocated entity keys on PostgreSQL

An entity key with `default: "auto"` is now a `bigserial` column on
PostgreSQL, and every foreign-key or join-table column referencing it is
`bigint` ([MODEL-FORMAT §9.5](MODEL-FORMAT.md#95-identity)). A model edit
that gains or drops `default: "auto"` on a key is planned on PostgreSQL now,
as steps in the migration document
([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities)):
gaining locks the key's table against every other session, checks that no
stored key is a number a `bigint` would round, converts every referencing
column and then the key to `bigint`, gives the key a sequence it owns as its
default (an identity column allocates by itself and takes none) and continues
it past the highest stored key; dropping removes the key's identity and
default, converts the key and then every referencing column to `numeric` and
drops the sequence the key owned, so an entity or a join table added by the
same edit can reference the key. A migration unapplied since an earlier
release planned the edit with no step must be planned again. Gaining refuses a
stored key that is not a whole number a `bigint` holds (a fraction, a number
beyond it) with `JD0023` naming the key and the value, and changes nothing:
correct or remove that key and run again. Three of the steps are `DO` blocks
(the lock a gain starts with is one), which the PostgreSQL statement check
admits only as the exact text the planner renders (any other `DO` is
`JD0021`). A conversion rewrites its tables under exclusive locks: run it with
the application's other sessions closed, and restart them after
([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities)).
The statements below are the same steps by hand, for a table the planner never
converted.

A table an earlier release created declared these `numeric` with no allocation,
so every insert that left the key to the database failed (`JD2005`, a null
key). Such a table still opens and keeps its explicit keys, and a write that
leaves the key to the database over a column that allocates nothing — a
`create()` or a staged `add()` — is refused `JD2002` by name before any
statement, where the database refused it (`JD2005`) after one. A column
allocates nothing when it has no default of any kind and is no identity: a
default the application wrapped, or a function of its own, is taken to
allocate. The store decides when it opens, so a store opened before the column
was converted keeps refusing, and says so, until it is reopened. To give the
column the allocation, run once per such key, in one transaction with the
store's schema on the search path — here `Post` keys by `pid`, `Comment.postId`
references it and `Post_Tag` is a many-to-many join table. The referencing
columns change first, because PostgreSQL refuses a `bigint` key that a
`numeric` column references:

```sql
BEGIN;
LOCK TABLE "Post" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "Comment" ALTER COLUMN "postId" TYPE bigint;
ALTER TABLE "Post_Tag" ALTER COLUMN "Post_key" TYPE bigint;
ALTER TABLE "Post" ALTER COLUMN "pid" TYPE bigint;
CREATE SEQUENCE "Post_pid_seq" OWNED BY "Post"."pid";
ALTER TABLE "Post" ALTER COLUMN "pid" SET DEFAULT nextval('"Post_pid_seq"');
SELECT setval(pg_get_serial_sequence('"Post"', 'pid'),
  GREATEST(nextval(pg_get_serial_sequence('"Post"', 'pid')), COALESCE((SELECT max("pid") FROM "Post"), 0) + 1), false);
COMMIT;
```

The `setval` finds the key's sequence by its column, whatever its name (a
rebuilt table's is `Post__rebuild_pid_seq`), and never moves it backwards.

A key holding a fraction would be rounded by the type change; right after the
lock, check that `SELECT count(*) FROM "Post" WHERE "pid" <> trunc("pid")`
answers 0, and `ROLLBACK` if it does not (the lock keeps a writer from adding
one in between).

The other way round, a database created while the key declared `auto` keeps
its `bigserial` key column and `bigint` references when an earlier release
migrated the edit that drops `auto`, which planned no step; opening it
under the new model failed `JD0002` (`BIGINT` against `NUMERIC`). Reopen it
with the model as it now stands — no statement is needed: the store accepts
the allocated columns for a key the caller supplies, every insert carries its
key, and the sequence stays on the column unused. Should the key declare
`auto` again, that sequence resumes where it stopped and never saw the
explicit keys written meanwhile: advance it past them with the `setval`
statement above first. An entity or a many-to-many relation that the same
edit adds, referencing the key, is created with a `numeric` column, which
PostgreSQL refuses to let reference the `bigint` key (`JD0002`, and
`JD0023` from `migrate()`: the foreign key "cannot be implemented"). Add it
while the key still declares `auto` — its column is then `bigint`, which
the store accepts once `auto` is dropped in a later open — or first give
the key what a model without `auto` creates: `ALTER COLUMN "pid" DROP
DEFAULT`, the key column, then each referencing column, `TYPE numeric`, and
`DROP SEQUENCE` of the sequence the key column owned (`Post_pid_seq`).

A key that was created without `auto` and is later declared
`default: "auto"` is the first case again: the table keeps the `numeric`
key column and references it was created with, with no sequence, and an
earlier release planned no step for that edit either. The store opens
it under the new model. SQLite allocates such a key from its rowid, past the
highest one. On PostgreSQL every `create()` or saved `add()` that leaves the
key to the database is refused `JD2002` (it failed `JD2005`, `null value in
column "id" … violates not-null constraint`) until the column is repaired by
hand with the recipe above, with its own table, key and referencing columns:
each referencing column to `bigint` first, then the key column to `bigint`, a
sequence owned by the key column, the key's default `nextval` of that
sequence, and `setval` past the highest key. A migration planned now for the
same edit does all of it.

### Moves between a column and the document on PostgreSQL

On PostgreSQL a migration that folded a number, an integer or a string member
into the document failed `JD0023` (`function jsonb_set(jsonb, unknown, numeric,
boolean) does not exist`), one that lifted a number, an integer or a boolean
out of it failed (`column "n" is of type numeric but expression is of type
jsonb`), a date-time's move to an epoch column failed (`cannot cast type jsonb
to timestamp with time zone`), and one that lifted a string stored its JSON
text, quotes included (`"x"`), as the column's value, without a word. Every one
of them runs now with the value and its JSON type intact
([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities)); a
member the document holds as another JSON type than its column's refuses the
lift `JD0023`, before any row changes and naming the member and the type found
(SQLite already refused a text in an integer column, and takes a boolean as 1
where PostgreSQL refuses it): correct the documents and run again. A column an
earlier string lift filled is repaired once, per column (only over values that
lift wrote: a string that really begins with a quote decodes too):

```sql
UPDATE "Post" SET "m" = "m"::jsonb #>> '{}' WHERE "m" IS NOT NULL;
```

A rebuild that retypes a member to text failed on PostgreSQL (`syntax error at
or near "COLLATE"`); it casts to the type's name now. On both engines a rebuild
that turns an epoch column into a plain one copies the instant's string from
the document and removes it there (an epoch column retyped to a number keeps
the epoch, as it did); SQLite copied the epoch's digits as text
(`"1791421323004"`) and left the document's string beside them. A SQLite column
an earlier rebuild filled so is repaired once, per column:

```sql
UPDATE "Post" SET "m" = jsonb_extract("doc", '$."m"'), "doc" = jsonb_remove("doc", '$."m"')
WHERE jsonb_extract("doc", '$."m"') IS NOT NULL;
```

## 9. Backups and snapshots

`backupTo` reported, published or left behind what it should not have
([MODEL-FORMAT](MODEL-FORMAT.md) states the contract):

- On Bun a backup sent one `{ totalPages, remainingPages: 0 }` event once
  the copy had finished; it now reports progress between steps, as Node
  does, and neither runtime sends an event after the final step: wait for
  the returned promise, not for a zero event.
- A step that met a busy source was reported again with the same
  `{ totalPages, remainingPages }`, thousands of times while a write was
  held; an event equal to the last one delivered is no longer delivered.
- A backup onto a path whose `-wal` held frames or whose `-journal` was hot
  published its copy, which then opened as the database that file belonged
  to; publication is now refused `JD2078` and nothing is deleted. Remove
  such a file only after confirming that no process has that database open.
  An empty or header-only `-wal` and a persist-mode `-journal` (its header
  zeroed) are never replayed and do not block publication.
- A target path that begins `file:` reached SQLite as a URI: relative, it
  failed `JD2078` and left its temporary under another name (Node), or was
  published literally (Bun); it is now a `TypeError` before any file is
  written. Write `./file:…` for such a relative path.
- An abort raised while a backup waited for the store gate (an open
  transaction) took effect only once the gate came free, or became
  `JD0012` past `queueTimeout`; it now takes the backup out of the queue at
  once, `JD2079`.
- On Bun a backup of a file was a compacted `VACUUM INTO` copy; it is now a
  page copy that keeps the source's free pages, so it is no smaller than
  the source, and an abort raised inside `onProgress` or a passed deadline
  stops it between pages.
- A store closed during a backup failed it `JD2063` and left the temporary
  file beside the target, its removal refused as `cleanupError`; the
  temporary is now removed.
- A copy that failed part-way (a full disk) left the temporary's `-journal`
  beside the target, and a `snapshotDatabase` that failed part-way left its
  target's; each is now removed with its file.
- On Node a backup started while a store transaction held a write failed
  `JD2078` (`not an error`); it now waits for that transaction, as the
  store's other calls do. Its first step now runs under the store gate:
  `backupTo` called from inside a transaction's callback, or under `{
  transactions: 'strict' }` while a transaction is open (`checkpoint:
  false` included), now waits or refuses exactly as the store's other calls
  do (`JD0012`), and a copy that finishes in one step (`rate` at least the
  page count) holds the gate for its whole extent, so a write issued
  meanwhile waits for it.
- On Bun a backup of a WAL database was a rollback-journal file (`VACUUM
  INTO` writes one); it is now a WAL-mode file, as a Node backup always
  was: opening it, even read-only, creates `-wal` and `-shm` beside it, and
  it cannot be opened where they cannot be created. Run `PRAGMA
  journal_mode=DELETE` on a backup bound for read-only media.
- `snapshotDatabase` on a connection the Node or Bun driver opened wrote a
  compacted `VACUUM INTO` copy; it now copies every page through the
  connection's online backup, inside one read transaction, and keeps the
  source's free pages: a snapshot is no longer compacted. Run `VACUUM` on
  the copy to compact it. Its schema cookie is now 1 where it was the
  source's plus one, so its `PRAGMA schema_version` still differs from the
  source's; a copy of a WAL database is still a rollback-journal file.
- `snapshotDatabase` inside an open transaction — called from a
  transaction callback before its first `await`, or after a `BEGIN` on the
  connection — failed with SQLite's `VACUUM` error (`cannot VACUUM from
  within a transaction`, no `JD` code); it now refuses with `JD0038` before
  touching the file system.
- A `snapshotDatabase` taken while a statement was in progress on the
  connection (an open iterator) failed (`cannot VACUUM - SQL statements in
  progress`); it now copies, and the statement goes on.
- A `snapshotDatabase` target that begins `file:` reached SQLite as a URI
  on Node, so the copy went to the file the URI names (or failed when that
  file existed) while the reserved path stayed empty; Bun took the name
  literally. A target `:memory:` copied into a discarded memory database and
  answered `pages: NaN` (`snapshotDatabase`), or published a file SQLite
  opens as a memory database under that name (`backupTo`). Each is now a
  `TypeError` before the call waits for the connection or writes anything;
  write `./file:…` or `./:memory:` for such a relative path.
- On Bun a `snapshotDatabase` that failed inside its copy (a full disk)
  threw `bun:sqlite`'s `SQLiteError` (`code: 'SQLITE_IOERR_WRITE'`); the
  copy now runs on `node:sqlite`, whose errors are `Error` with `code:
  'ERR_SQLITE_ERROR'`.
- A `backupTo` or `snapshotDatabase` target that collided with the copied
  database was accepted: its own file, a side file (`-wal`, `-shm`,
  `-journal`), the same file under another spelling or link, or a path one
  of whose own side files would be one of those. A backup published over
  the live database (later writes failed `JD2083`, or the database turned
  corrupt under automatic checkpoints and lost acknowledged writes) or over
  its log or journal, and a snapshot could delete a database named as its
  journal. Each is now refused `JD2078`: a backup at publication, its copy
  discarded; a snapshot before anything is written.
- `backupTo` reads its options as a closed set before it waits: an unknown
  member (a misspelt `signal` published a backup meant to be cancelled), a
  `signal` that is not an `AbortSignal` (it crashed the process while the
  store was busy), a `rate` above 2,147,483,647 (it failed `JD2078` after
  the checkpoint), a `checkpoint` outside `false`, `passive`, `full`,
  `restart` and `truncate` (judged only once the store was free), and
  options that are not a plain object are a `TypeError` coded `JD0013`,
  naming the member. The `TypeError`s for `rate`, `onProgress` and
  `checkpoint` carry that code too, with new messages.
- A target holding a NUL byte failed `JD2078`, or on Bun's `VACUUM INTO`
  route wrote a full copy at the name before the NUL; it is now a
  `TypeError` before anything is written.
- The default checkpoint boundary failed every backup `JD2078` while a
  statement was in progress on the store's connection, such as an open
  cursor, and called it retryable though every retry failed; it is now
  skipped, and the result's `checkpoint` is `null`. A mode passed
  explicitly still fails.
- On Node a write issued through a snapshot's own connection during its
  copy (an ungated statement) stalled the snapshot at full CPU forever, or
  failed it `not an error`; the write is now refused (`attempt to write a
  readonly database`) and the snapshot finishes.
- A relative `snapshotDatabase` target named a file in the working
  directory of the moment the file was reserved, after the call had waited
  for the connection; it is now the working directory of the call.
- On Bun a store closed right after `backupTo` started (in a microtask)
  failed `JD2078` with the platform's closed-database message; it now fails
  `JD2063`, as on Node.
- A backup whose temporary file's side-file name was too long for the file
  system reported a spurious `cleanupError` (`ENAMETOOLONG`); it no longer
  does.

## 10. Journal capture of foreign-key actions

Stores that capture through the write-path journal — `capture: { mode:
'journal' }`, and `auto` wherever the binding has no sessions (Bun, the Node
worker, pool and process hosts, some wasm builds, PostgreSQL) — now record
the database's own foreign-key actions ([LIVE-FORMAT](LIVE-FORMAT.md) §4):

- A delete's record now also names every row a `cascade` relation removed at
  any depth, the membership rows of each removed row and the foreign-key
  member of every row a `setNull` relation nulled, as session capture already
  did. A consumer that compensated for the missing rows can stop; one that
  rebuilds state from records committed before the upgrade should resnapshot
  once. Op order within a record stays unspecified: these rows now follow the
  delete's own `remove`, where membership removals used to precede it. A
  tracked save now reads each row it updates (and again after the update when
  the row no longer holds its tracked snapshot), so a row such a delete nulled
  earlier in the transaction is recorded as stored, not with the snapshot's
  stale member.
- A delete the database refuses no longer leaves membership removals behind in
  a transaction that catches the refusal: capture-only feeds no longer show
  them, and replicated stores no longer refuse that transaction `JD2104`.
  Neither does a `create()` carrying a membership the database refuses
  (`JD2005`, a join row naming no row): the created row and the join rows
  stored before the refused one are no longer recorded.
- On PostgreSQL such a delete first reads the rows it will change, locked as
  its own actions lock them: `FOR UPDATE` for a row it removes or a unique
  (one-to-one) member it nulls, `FOR NO KEY UPDATE` for any other row it
  nulls. A writer outside capture that would change or remove one of them now
  waits for the commit, and the delete waits for a writer already holding one
  of them, before its statement rather than during it; a writer that only
  references a nulled row is not waited for.
- Under replication, a delete refuses `JD2106` before it runs when its root and
  the rows it reaches exceed `replication.maxOperations`, the bound its
  envelope would exceed at commit (`replication operation bound exceeded`);
  rows this transaction created count too, though the envelope would not carry
  them. Their documents count against `maxBytes` the same way, a lower bound:
  an envelope within it can still refuse at commit (`JD2074`). The message,
  `a cascading delete exceeds replication capacity`, replaces
  `membership cascade exceeds replication capacity`.
- Journal replication now opens for models with cascading or set-null
  relations, where it refused `JD0051` with
  `journal replication cannot capture cascading or set-null child relations; use session capture`;
  the rows such a delete removes or nulls count against the same `JD2106`
  credits as its membership rows.
- Replay, by `apply` and by `reset` in either capture mode, now writes a row
  moved off a parent before the removals whose cascades would reach it, so the
  envelope of a transaction that moves a child to a new parent and deletes the
  old one applies and resets where it refused `JD2104` with
  `the stored logical row differs from the requested replicated value` and
  `reset did not store the requested logical state`.
- Replay now also runs the write that releases a value of an entity's unique
  slot (a one-to-one key, a unique member, a unique index; a partial one holds
  the rows its condition is true for) before the write that takes it, so an
  envelope passing unique values between entity rows applies and resets where a
  row taking a value before the row releasing it refused `JD2005`. An envelope
  no order can replay still refuses, `JD2005` or `JD2104`: one rotating values
  between rows, or one moving a row off a removed parent while that row takes a
  value the removal releases (a self-referencing table, or a cascading path back
  to the table). So does a collection document that takes a value before the
  document releasing it (`JD2005`). A reset now writes in canonical order
  instead of the order the replica stored its rows in.
- On the worker, pool and process hosts a store with the persisted log
  (`capture.log`) refused `JD2092` (`worker statement capacity 1024 exceeded`)
  after a few hundred commits — fewer with an `asyncLive` registration, whose
  every refresh read the log — because each commit's log statements kept their
  statement slots; they are released after each use now, as are the owner
  lease's renewals, and such a store keeps writing.

## 11. Declared intervals

A collection may declare a span member an **interval** — `intervals: [{
name, path, maxDuration? }]` ([MODEL-FORMAT §2](MODEL-FORMAT.md#2-the-model-document)).
A model that declares none keeps its documents, plans and tables byte for
byte; a model that declares one is stricter on purpose:

- The store refuses `JD2003` a document whose declared span is present but
  not an object of two safe-integer bounds with `start < end` (and `end -
  start <= maxDuration` where one is declared) — through `insert`, `put`
  and `patch`, whether or not `compileSchema` was injected. A document
  that would be refused cannot sit in a table that carries the CHECK, so
  such documents are repaired or removed before the collection is created
  declared.
- The table carries `CONSTRAINT "<name>_interval" CHECK (…)`, so a raw SQL
  writer on another connection is refused `JD2005`, class `constraint`
  (SQLite errcode 275, or 3091 where STRICT refuses the bound's type first;
  PostgreSQL SQLSTATE 23514).
- Every open verifies the CHECK — on SQLite through the table's CREATE
  text, on PostgreSQL by reading the constraint back from the catalog:
  present, validated and read as the declaration (the server's deparse is
  one text on 16, 17 and 18), with no CHECK beside it the model does not
  declare. A dropped, altered or renamed constraint, one added `NOT VALID`
  and an undeclared one are `JD0002` at open. On PostgreSQL the remedy is
  to restore it exactly (`ALTER TABLE … ADD CONSTRAINT … CHECK (…)`, and
  `VALIDATE CONSTRAINT` after a `NOT VALID`), or to drop the declaration:
  a collection declaring no interval reads none of its table's CHECKs, as
  before. On SQLite the CREATE text is compared whole, so a table that
  carries the CHECK opens only under a model that declares it, and one
  that lacks it only under a model that does not: the remedy is to put the
  CREATE text back as the model plans it.
- Adding a declaration to an existing table, changing it or removing it is
  a planned migration ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#3-planning-and-the-wideningnarrowing-rule)):
  on PostgreSQL one `ADD CONSTRAINT`, which checks every stored row as it
  is added, or one `DROP CONSTRAINT`; on SQLite one rebuild of the
  collection, which an atomic run cannot hold (`JD0026`, as for an
  entity's rebuild — run the chain without `atomic`). A link that adds or
  tightens a declaration over stored rows its CHECK would refuse is refused
  `JD0021` before any of its steps runs, naming the collection, the
  interval, the count and the first keys: repair those documents in a link
  of their own first. A table lacking the CHECK under a model that
  declares it, or carrying one that differs from the declaration, is
  `JD0002` at open on both engines, as before: migrate it, or restore the
  CREATE text (SQLite) or the constraint (PostgreSQL) by hand. A table
  carrying the CHECK under a model that no longer declares it is `JD0002`
  on SQLite, whose CREATE text is compared whole, but opens on PostgreSQL,
  where a collection declaring no interval reads none of its table's
  CHECKs (as before): the constraint then still refuses every writer
  `JD2005` where the store's own check (`JD2003`) is gone, `$overlaps`
  plans the pre-filter again, and `introspectModel` reads it back as a
  declaration — plan the removal (one `DROP CONSTRAINT` link) or drop it
  by hand.
- `introspectModel` derives the declaration back from the CHECK, the span's
  bounds required and typed `integer`, and reports no loss for it; a CHECK
  of another shape, under another name, or one added `NOT VALID` stays
  `unmapped-constraint`. On SQLite a CHECK declared with a `CONSTRAINT`
  name is reported under that name, where it was `check_N`.
- The declaration is held at normalization, `JD0005` at the member: `path`
  is a singular JSONPath to a member the schema types as an object of two
  required `integer` bounds (a `number` bound is refused — the CHECK's
  integer test would refuse the fractions it admits), each bound indexed by
  its own path, `name` an identifier unique among the collection's
  intervals whose `<name>_interval` fits 63 bytes, and `maxDuration` a
  positive safe integer of milliseconds.
- `$overlaps` over the declared span plans exactly — no disjunct, no
  residual, no registered predicate — and seeks the bound's index;
  `explain()` reports `prefilters: []` where it reported the half-open
  pre-filter, and `mode: 'native'` under a profile that registers nothing.

## 12. Statement slots on the worker, pool and process hosts

A host that keeps every prepared statement until told otherwise (the worker,
pool and process endpoints, up to `maxStatements`, 1024 by default) now holds
a bounded number of them on these paths however long the store lives:

- `store.jobs.page()` held one statement per page cursor for good and refused
  `JD2092` after about a thousand pages; the statement now leaves with its
  cursor — exhausted, returned or aborted.
- `checkpoint()`, `optimize()`, `integrityCheck()` and `foreignKeyCheck()`
  held one statement per call; each is prepared for that one call and
  released after it.
- A trusted statement (`tx.sql.prepare`) kept its slot after `close()`;
  `close()` now gives it back, once, and a statement a body never closes is
  released when its transaction settles.
- On the process host, once a store's life had prepared more statements than
  `maxStatements` (a few hundred journal-captured commits), a root read
  outside any transaction reported the owner's transaction settlement as
  `unknown`, and a connection loss during it as not retryable; the host's own
  bookkeeping now follows its endpoint, and the settlement stays `committed`.
- A one-shot statement's release is never refused by a full request queue: it
  has a cursor return's reserved capacity.
- The pool host's `metrics().workers[]` report each worker's `statements`.

## Measured costs

Exact identity stores complete canonical documents and model endpoints, so
storage and comparison costs grow with their size. A short fingerprint remains
useful for display; it does not replace this evidence. The migration pen adds <!--fact:bundle.migration-->27,586<!--/fact--> bytes to an otherwise empty
consumer bundle; the DB-client fixture is <!--fact:bundle.db-->925,082<!--/fact--> bytes. These are complete measured
fixture sizes, not the incremental price of identity alone.

The following native SQLite workload measures current receipts and repeat
checks. Reproduce both reports from the repository root:

```sh
node --no-warnings=ExperimentalWarning benchmark/migration-identity.js --write
bun benchmark/migration-identity.js --write
npm run docs:derive
```

The instrument records every sample, runtime and source hash. Documentation
derivation refuses stale sources or incomplete evidence. Keep the JSON reports
with the code that produced them.

<!--fact:migration.costs-->

10 SQL-only links; 500 calls per read/repeat loop; medians of 5 fresh-database samples. Every sample preserves exact application, normal-history and identity rows.

| Native runtime / SQLite | Apply all links ms | Status loop ms | No-op apply loop ms | Observation loop ms | Measured at |
|---|---:|---:|---:|---:|---|
| node 24.20.0 / 3.53.4 | 11.552 | 230.337 | 231.281 | 62.010 | 2026-10-09T00:35:37.205Z |
| bun 1.4.2 / 3.53.2 | 10.926 | 225.735 | 234.312 | 61.389 | 2026-10-09T00:35:40.059Z |

| Native runtime | Current document JSON bytes | Legacy-shaped JSON projection bytes | Side rows / key+value UTF-8 bytes | SQLite page growth bytes |
|---|---:|---:|---:|---:|
| node | 2521 | 1311 | 11 / 5147 | 24576 |
| bun | 2521 | 1311 | 11 / 5147 | 24576 |

Ten SQL-only links on a borrowed synchronous in-memory SQLite connection; shadow replay is disabled. Each sample uses a fresh database. Timed loops include result assertions; observations compare complete receipts. All samples are retained, with medians reported. Shared-host elapsed costs are not production latency or a causal comparison with the old protocol. Legacy projection bytes compare JSON serialization only; no legacy document executes. Page growth includes both history tables and application writes, not only receipt payload.

<!--/fact-->

For PostgreSQL logical backup and archived-WAL recovery measurements, see
[PostgreSQL operations](POSTGRESQL.md). Native SQLite crash and backup checks
cover receipt/adoption rollback and publication boundaries; they do not model
power loss or establish application-specific production recovery guarantees.
