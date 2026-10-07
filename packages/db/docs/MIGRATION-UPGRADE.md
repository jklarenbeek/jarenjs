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
table's name (`<table>__rebuild_pkey`), where a duplicate key read as `JD2005`
instead of `JD2001`; it restarted an allocated key's sequence at 1, so the next
allocations collided with copied keys and, once past them, could hand out
again keys the table had handed out before; and it renumbered `rid`, so an
entity read with no ordering could answer its rows in another order. A
rebuild now continues every sequence from the old table's next value and past
the copied values, keeps each row's `rid`, and gives the key `<table>_pkey`
where no other relation holds that name
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

A table an earlier release rebuilt needs no rename: the duplicate-key
classification reads `<table>__rebuild_pkey` (and the number PostgreSQL
appends to a taken key name, `Post_pkey1`) as the table's own key. Its
allocated key's sequence needs repair once, per key, with the store's schema
on the search path; here `Post` keys by `pid`:

```sql
SELECT setval(pg_get_serial_sequence('"Post"', 'pid'),
  GREATEST(nextval(pg_get_serial_sequence('"Post"', 'pid')), COALESCE((SELECT max("pid") FROM "Post"), 0) + 1), false);
```

It sets the next key past the highest key the table holds, and never moves
the sequence backwards. Keys deleted from the top of the table before that
rebuild were forgotten with its old sequence: if anything outside the table
still refers to one, advance the sequence past it by hand. The `rid` order
that rebuild gave the rows stays.

Three differences from SQLite remain. A rebuild of an entity that another
object depends on — a foreign key, another entity's or its own, or a view —
is refused `JD0023` naming the dependent as the server does, and the link
rolls back whole: PostgreSQL refuses to drop a table another object depends
on, and the rebuild re-points nothing. A table renamed with `x-rename` keeps
the key name PostgreSQL gave it under its old name (`Post_pkey` for `Post`
renamed to `Article`), which the duplicate-key classification does not read
as the renamed table's key: a duplicate key there still reads `JD2005` instead
of `JD2001`. And the classification goes by the constraint's name alone, so a
unique member whose index name has the shape of the table's key name — a
member named `pkey1`, `pkey2`, … or `_rebuild_pkey`, `_rebuild_pkey1`, …,
whose index is `<entity>_<member>` — reads a duplicate value as `JD2001`
instead of `JD2005`: by name, PostgreSQL's numbered key name (`Post_pkey1`) and
such a member's index are one. Reading the table's key constraint from the
catalog would tell them apart.

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

## 8. Stricter models, keys and staged writes

Model documents and store writes that were accepted with a member or a
value the store did not honor now refuse by code, before any statement:

- A model member outside its declaration's closed set
  ([MODEL-FORMAT §2](MODEL-FORMAT.md#2-the-model-document)) was ignored — a
  misspelt `unique` opened a store whose index was not unique, an entity
  `indexes` array was dropped, a root `$schema` passed; `openStore`,
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
  opened with no trigger and was enforced by nothing; it is now `JD0005` at its
  `enforcement`. Declare it `store`, or give the entity an explicit layout.
- A relation to an entity with a `physical` layout opened and failed at its
  first `load({ include })` with a raw `JD2005`; it is now `JD0005` at open.
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

### Allocated entity keys on PostgreSQL

An entity key with `default: "auto"` is now a `bigserial` column on
PostgreSQL, and every foreign-key or join-table column referencing it is
`bigint` ([MODEL-FORMAT §9.5](MODEL-FORMAT.md#95-identity)). A table an earlier
release created declared these `numeric` with no allocation, so every insert
that left the key to the database failed (`JD2005`, a null key). Such a table
still opens and keeps its explicit keys. To give it the allocation, run once
per such key, with the store's schema on the search path — here `Post` keys by
`pid`, `Comment.postId` references it and `Post_Tag` is a many-to-many join
table. The referencing columns change first, because PostgreSQL refuses a
`bigint` key that a `numeric` column references:

```sql
ALTER TABLE "Comment" ALTER COLUMN "postId" TYPE bigint;
ALTER TABLE "Post_Tag" ALTER COLUMN "Post_key" TYPE bigint;
ALTER TABLE "Post" ALTER COLUMN "pid" TYPE bigint;
CREATE SEQUENCE "Post_pid_seq" OWNED BY "Post"."pid";
ALTER TABLE "Post" ALTER COLUMN "pid" SET DEFAULT nextval('"Post_pid_seq"');
SELECT setval(pg_get_serial_sequence('"Post"', 'pid'),
  GREATEST(nextval(pg_get_serial_sequence('"Post"', 'pid')), COALESCE((SELECT max("pid") FROM "Post"), 0) + 1), false);
```

The `setval` finds the key's sequence by its column, whatever its name (a
rebuilt table's is `Post__rebuild_pid_seq`), and never moves it backwards.

A key holding a fraction would be rounded by the type change; check that
`SELECT count(*) FROM "Post" WHERE "pid" <> trunc("pid")` answers 0 first.

The other way round, a database created while the key declared `auto` keeps
its `bigserial` key column and `bigint` references when the model drops
`auto`, and the migration planner plans no step for that edit; opening it
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
key column and references it was created with, with no sequence, and the
migration planner plans no step for that edit either. The store opens
it under the new model. SQLite allocates such a key from its rowid, past the
highest one. On PostgreSQL every `create()` or saved `add()` that leaves the
key to the database fails `JD2005` (`null value in column "id" … violates
not-null constraint`) until the column is repaired by hand with the recipe
above, with its own table, key and referencing columns: each referencing
column to `bigint` first, then the key column to `bigint`, a sequence owned
by the key column, the key's default `nextval` of that sequence, and `setval`
past the highest key.

## Measured costs

Exact identity stores complete canonical documents and model endpoints, so
storage and comparison costs grow with their size. A short fingerprint remains
useful for display; it does not replace this evidence. The migration pen adds <!--fact:bundle.migration-->26,807<!--/fact--> bytes to an otherwise empty
consumer bundle; the DB-client fixture is <!--fact:bundle.db-->855,906<!--/fact--> bytes. These are complete measured
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
| node 24.20.0 / 3.53.4 | 9.391 | 225.797 | 224.477 | 59.872 | 2026-10-07T21:58:52.829Z |
| bun 1.4.2 / 3.53.2 | 10.111 | 211.455 | 213.404 | 54.476 | 2026-10-07T21:58:55.484Z |

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
