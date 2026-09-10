# The Jaren migration pen

> `./migration` — `$migration` 0.1 documents: the two shape hashes and
> the ordered steps the runner takes. **Read it when** you are moving a
> store from one model to the next

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

Your model changed and the database has rows in it. Somebody has to write
the step that carries those rows across, and the part of that step no
planner can infer — the data transform — is the part you would most like
the compiler to check. That is this pen: the planner renders the DDL, you
write the transform against the OLD row shape and the NEW one, and the
document that comes out is what `migrate()` runs.

```js
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
```

writes `$migration` 0.1 documents — the `jaren-migration` grammar
`packages/db/schemas/jaren-migration.schema.json` publishes (with a
draft-07 twin beside it), whose one specification is
[MIGRATION-FORMAT.md](../../db/docs/MIGRATION-FORMAT.md) §2 — and
`@jarenjs/db`'s `migrate()` takes what this pen emits unchanged. The
document is two shape hashes and an ordered list of steps; the order is
the contract.

**The running example.** §3 is one project's `migrations/` directory read
in order — the migration that adds a member, the one that rewrites it,
the one that backfills a derived column, the same first migration as the
planner actually leaves it, and one over a column-mapped date. §5 reads
the types the transforms are checked against off the same models.

Four things are worth naming before the tables:

- **Identity is the shape hash, and the pen computes what the store
  computes.** `from` and `to` are
  `hashContent(canonicalizeJson(model))` with the `x-rename` planning
  hints stripped (`packages/linq/src/migration/define.js:45-75`) — the
  store's own rule, from the same two functions. A test holds the pen's
  hash equal to `@jarenjs/db`'s `shapeHash` over every model-pen corpus
  model, rename hint included, and asserts that a model differing only by
  a hint hashes the same (`test/linq/migration-pen.test.js`, "identity is
  the shape hash"). A database records shapes, never version numbers a
  human has to remember to bump; a migration whose `from` does not match
  the recorded shape refuses to run (`JD0020`).
- **The planner still plans; the pen types the human part.**
  `jaren-db plan --model ./model.js` diffs the committed
  `model.snapshot.json` against the model, renders the DDL through the
  dialect, and leaves the data transform it cannot infer as a step marked
  `"draft": true` (MIGRATION-FORMAT §3). It cannot infer a transform and
  MUST NOT pretend to. `fromPlanned(planned, { from, to })` takes that
  document up so a `transform` typed old row → new row REPLACES the
  draft, in place. The pen never sets and never clears a `draft` flag: an
  untouched draft still refuses to run (`JD0021`, the runner's rule), and
  a test asserts exactly that.
- **The engine is somewhere else.** Nothing under
  `packages/linq/src/migration/` imports `@jarenjs/db`,
  `@jarenjs/validate`, `@jarenjs/emit` or the query engine — a test
  asserts it file by file. A transform's body is captured through the
  JSLT pen's `body()` ([JSLT-PEN.md](JSLT-PEN.md)); an assertion's
  predicate through the chain's recording proxy; the hash is
  `@jarenjs/core`'s over `@jarenjs/json`'s canonical form. Everything
  else about a migration — the shadow replay, the widening check against
  real data, history and checksums, batching — is the runner's, and §6
  says so plainly because a reader who believes otherwise will lose data.
- **Immutability and identity are the binder's rules, and this pen keeps
  them.** Every step method answers a NEW `Migration`; `.document` is
  assembled once, memoized and deep-frozen, and `toJSON()` returns it —
  stated in full, for every pen, in
  [LINQ-FORMAT.md](LINQ-FORMAT.md) §1.2.

The workflow the pen sits in, end to end:

```
a model module  →  jaren-db plan --model ./model.js --out ./migrations
                   (diffs the snapshot, renders the DDL, drafts the transform)
                →  a migration module: fromPlanned(planned, { from, to })
                   with a typed .transform(…) replacing the draft
                →  jaren-db check      (in CI: an unplanned model change, a
                                        pending migration or drift exits 1)
                →  jaren-db apply
```

`jaren-db` loads model and migration MODULES beside JSON and refuses one
that is not pure (MIGRATION-FORMAT §11). The two models a migration names
are the model pen's ([MODEL-PEN.md](MODEL-PEN.md)) — the previous one
kept beside the current one, which is also what keeps the transform
typed (§5).

## 2. The mapping table

Every name `@jarenjs/linq/migration` exports that a caller writes, and
every method reachable on the builder it hands back. The one class it
also exports, `Migration`, is §5's: a caller meets it as a type and as an
`instanceof` narrow, never by calling it — its constructor is private.

Status: **native** (emits the named step), **refused** (a coded error
naming the reason).

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineMigration({ id, from, to, note? })` | `{ $migration: '0.1', id, from, to, note?, steps }` — `from`/`to` the two models' shape hashes, exactly `shapeHash` (pinned) | `Migration<From, To>`, the two model documents' phantoms | native; not a `$model` document, an empty `id`, another member `JL0101` |
| `.ddl(sql, note?)` | `{ kind: 'ddl', sql, note? }` — one rendered statement (§2) | — | native; an empty statement `JL0101` |
| `.sql(sql, note?)` | `{ kind: 'sql', sql, note? }` — one data statement spelled directly (§9.4); a dry run always prints it with its note | — | native; an empty statement `JL0101` |
| `.transform(name, (row, x) => …)` | `{ kind: 'jslt', collection: name, stylesheet: [{ match: '$', body }] }` — one root rule, the body captured through the JSLT pen's `body()` over the WHOLE row, `x.root`/`x.path` the externals the engine binds (JSLT-FORMAT §8.2) | `row` is `Expr<Old>` (`DocOf<From, name>`); the result must spell `New` — a dropped, mistyped or foreign member does not compile; the honest top (`get()`) is admitted where a precise value is | native; a table the target model does not declare `JL0106`; an undeclared external `JL0104` |
| `.transform(name, stylesheet(…))`, `.transform(name, rules)` | the rules ARRAY — a `jslt` step carries the array, so the envelope's `unmatched`/`modes` have no place in it | a typed stylesheet's or first rule's `Out` must be `New`; a hand-written rule is the honest top | native; a disposition or a mode table `JL0102`; not JSON `JL0101` |
| `.assert(name, (row) => …, { expect? })` | `{ kind: 'query', collection: name, assert: { $for: { it: '$[*]' }, $where: <predicate>, $return: '$it' }, expect? }` — the format's own `$for` over the rows; the predicate names the VIOLATION (`expect: 'empty'`, the default, absent from the document) or the witness (`expect: 'ebv'`) | `row` is the members the two shapes share — a precondition sees old rows, a postcondition new ones, and what both agree on is what neither lies about; annotate (`(row: Expr<User>) => …`) when one shape is meant | native; another `expect` `JL0101`; an external `JL0104`; an undeclared table `JL0106` |
| `.assert(name, query, { expect? })` | the query document verbatim | — | native |
| `.derive(name, columns)` | `{ kind: 'derive', collection: name, columns }` — a backfill of stored derived columns (§2.1), the columns verbatim | `readonly DeriveColumn[]` | native; no columns `JL0101`; an undeclared table `JL0106` |
| `.step(raw)` | any planner-emitted step, verbatim — the escape that keeps `rebuild` (§10) authorable without the pen re-implementing it; a `draft` flag rides untouched | `MigrationStep` | native; an unrecognised kind or a missing member (the runner's `JD0023` rules, seen early) `JL0101` |
| `fromPlanned(document, { from?, to? })` | the planner's document, taken up: `.transform(name, …)` replaces its draft for `name` in place; every other method appends | the models type the transforms and are checked against the document's hashes | native; a model that is not the planned one `JL0102`; two drafts for one name, or no draft and no target model `JL0106` |
| `.document`, `.toJSON()` | the deep-frozen `$migration` document — assembled once and memoized, so `a.document === a.document` | `MigrationDocument` | native |

**This table is complete, and deliberately short.** Ten callable names
against eleven rows: the step vocabulary of `$migration` 0.1 is six kinds
(`ddl`, `jslt`, `query`, `derive`, `sql`, `rebuild`), five of them have a
method here and the sixth is `step()`. What makes this pen worth reading
is not the size of its surface but what each step is checked against —
§4 is the richest refusal section in the family relative to the pen's
size, and it is the reason.

Three rules the table implies, spelled out:

- **Identity stays the shape hash.** A database stores hashes, not
  models; the pen computes what the store computes, from the same two
  functions, with the same hint stripped — and the pin over every corpus
  model is what keeps the two equal. A `x-rename` hint is a PLANNING
  instruction, not shape, so a model that keeps carrying a satisfied hint
  hashes the same as one without it and plans nothing (MIGRATION-FORMAT
  §3 — a rename is idempotent across `plan` runs).
- **A step's table is one the target model declares.** The runner would
  fail the statement on a table that does not exist; the pen says so
  first (`JL0106`) — for `transform`, `assert` and `derive` alike,
  whenever it knows the target. Entities and collections both count as
  declared. Over a planned document alone it knows only the drafts, so
  every other name is the runner's to judge and a transform for another
  table is spelled with `step()`.
- **Steps are appended in the order they are called**, and `transform`
  over a planned document is the one exception: it replaces the draft for
  that name IN PLACE, so the planner's ordering — DDL before the data
  step it depends on — survives.

## 3. Worked examples

Every `js` fence below exports exactly one migration, and the `json`
fence that follows it is the document the pen emits — executed by
`test/linq/pen-docs.test.js`, which imports each fence from the workspace
and reads its `toJSON()`. Every document here also validates against both
published artifacts, the 2020-12 one and its draft-07 twin.

One project's `migrations/` directory, in the order the files are
numbered: `0002` gives every user a handle, `0003` shouts their names,
`0004` backfills a derived column, then `0002` again as the planner
actually leaves it, and `0005` splits a date out of a timestamp. Read in
order they are one database's history.

One caveat about every fence here, because it is the thing a reader will
misread: each declares only the entities the step touches, so the fences
stay readable. A real migration's `from` and `to` are the hashes of the
WHOLE model at those two points — that is what the database recorded and
what `migrate()` compares against.

**0002, by hand.** A migration between two model-pen models: the DDL the
planner would render, a typed transform, a precondition:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: {
  User: m.object({ id: m.string().key(), name: m.string(), age: m.integer().optional() }),
} });
const v2 = m.defineModel({ entities: {
  User: m.object({ id: m.string().key(), name: m.string(), age: m.integer().optional(), handle: m.string() }),
} });

export const handles = defineMigration({ id: '0002-handles', from: v1, to: v2, note: 'every user gets a handle' })
  .ddl('ALTER TABLE "User" ADD COLUMN "handle" TEXT', "add column 'handle' on 'User'")
  .transform('User', (u) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower() }))
  .assert('User', (u) => u.name.isEmpty());
```

```json
{
  "$migration": "0.1",
  "id": "0002-handles",
  "from": "x7457y",
  "to": "hn656j",
  "note": "every user gets a handle",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT",
      "note": "add column 'handle' on 'User'" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "age": "$.age",
                                  "handle": { "$lower": "$.name" } } } ] },
    { "kind": "query", "collection": "User",
      "assert": { "$for": { "it": "$[*]" }, "$where": { "$empty": "$it.name" },
                  "$return": "$it" } }
  ]
}
```

`x7457y` and `hn656j` are not literals a human types: they are what
`shapeHash(v1)` and `shapeHash(v2)` answer, and they change the day
either model's shape does — which is the point. The transform's callback
runs ONCE, at build, against the chain's recording proxy: `u.id` records
`$.id`, `u.name.lower()` records `{ $lower: '$.name' }`, and what is left
behind is the `body` above. The assertion names the VIOLATION — no user
may have an empty name — because `expect` defaults to `'empty'` and is
absent from the document when it does.

**0003.** The same `User`, transformed with a stylesheet written through
the JSLT pen rather than a lambda, and an `ebv`
assertion — the other direction, where the matching rows are the witness:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';
import { stylesheet, rule } from '@jarenjs/linq/jslt';

const v2 = m.defineModel({ entities: {
  User: m.object({ id: m.string().key(), name: m.string(), handle: m.string() }),
} });

export const shouty = defineMigration({ id: '0003-shout', from: v2, to: v2 })
  .transform('User', stylesheet([
    rule('$', (u) => ({ id: u.id, name: u.name.upper(), handle: u.handle })),
  ]))
  .assert('User', (u) => u.handle.exists(), { expect: 'ebv' });
```

```json
{
  "$migration": "0.1",
  "id": "0003-shout",
  "from": "eedea8",
  "to": "eedea8",
  "steps": [
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": { "$upper": "$.name" },
                                  "handle": "$.handle" } } ] },
    { "kind": "query", "collection": "User",
      "assert": { "$for": { "it": "$[*]" }, "$where": { "$exists": "$it.handle" },
                  "$return": "$it" },
      "expect": "ebv" }
  ]
}
```

`from` and `to` are the same hash, and that is legal: a migration that
only rewrites data moves no shape. What reaches the step is the
stylesheet's RULES array — the `$jslt` envelope does not; a `jslt` step
carries an array and nothing else (MIGRATION-FORMAT §2), which is why an
envelope carrying `unmatched` or `modes` is refused rather than silently
truncated (§4.2).

**0004** touches the other half of the same database — the collection
that holds coordinates. A backfill: a `sql` data step, a `derive`
recompute, and a `rebuild`
handed through verbatim:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';

const model = m.defineModel({ collections: {
  places: m.collection(m.object({ id: m.string(), cell: m.array(m.number()) }), {
    key: '/id',
    indexes: [m.index((p) => p.cell, { name: 'gx_cell_gh7', derive: 'geohash', precision: 7 })],
  }),
} });

export const backfill = defineMigration({ id: '0004-cells', from: model, to: model })
  .sql('UPDATE "places" SET "doc" = json_remove("doc", \'$.legacy\')', 'drop the legacy member')
  .derive('places', [{ name: 'gx_cell_gh7', derive: 'geohash', precision: 7, segments: [{ name: 'cell' }] }])
  .step({
    kind: 'rebuild',
    table: 'places',
    create: ['CREATE TABLE "places__rebuild" ("id" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT'],
    copy: 'INSERT INTO "places__rebuild" ("id", "doc") SELECT "id", "doc" FROM "places"',
    indexes: [],
  });
```

```json
{
  "$migration": "0.1",
  "id": "0004-cells",
  "from": "vxjj1b",
  "to": "vxjj1b",
  "steps": [
    { "kind": "sql", "sql": "UPDATE \"places\" SET \"doc\" = json_remove(\"doc\", '$.legacy')",
      "note": "drop the legacy member" },
    { "kind": "derive", "collection": "places",
      "columns": [ { "name": "gx_cell_gh7", "derive": "geohash", "precision": 7,
                     "segments": [ { "name": "cell" } ] } ] },
    { "kind": "rebuild", "table": "places",
      "create": [ "CREATE TABLE \"places__rebuild\" (\"id\" TEXT PRIMARY KEY, \"doc\" BLOB NOT NULL) STRICT" ],
      "copy": "INSERT INTO \"places__rebuild\" (\"id\", \"doc\") SELECT \"id\", \"doc\" FROM \"places\"",
      "indexes": [] }
  ]
}
```

`derive` is idempotent by construction — a derived value is a pure
function of the document, so a replay writes what the first run wrote —
and it is what a STORED derived column needs, because such a column
arrives `NULL` and a query pushed to a `NULL` column silently returns
fewer rows (MIGRATION-FORMAT §2.1). The `rebuild` rides through `step()`
because §10's procedure is the planner's to render: the pen would have to
re-implement it to type it, and LINQ-FORMAT §1.1 rule 1 forbids that. It
is still checked — a `rebuild` without `create`, `copy` or `indexes` is
`JL0101` (§4.1).

**0002 again, as the planner actually leaves it.** This is the route you
take in practice, and the one the first fence skipped: the document
`jaren-db plan --model ./model.js` wrote, with
its draft replaced by a typed transform:

```js
import * as m from '@jarenjs/linq/model';
import { fromPlanned } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: {
  User: m.object({ id: m.string().key(), name: m.string(), age: m.integer().optional() }),
} });
const v2 = m.defineModel({ entities: {
  User: m.object({ id: m.string().key(), name: m.string(), age: m.integer().optional(), handle: m.string() }),
} });

// what `jaren-db plan --model ./model.js` wrote: the DDL it rendered, and
// the transform it could not infer, left as a draft that refuses to run
const planned = {
  $migration: '0.1',
  id: '0002-handles',
  from: 'x7457y',
  to: 'hn656j',
  steps: [
    { kind: 'ddl', sql: 'ALTER TABLE "User" ADD COLUMN "handle" TEXT', note: "add column 'handle' on 'User'" },
    { kind: 'jslt', collection: 'User', stylesheet: [], draft: true,
      note: 'the document schema of entity \'User\' changed; fill in the transform (or delete this step if every stored document already validates) and remove "draft"' },
  ],
};

export const typed = fromPlanned(planned, { from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower() }));
```

```json
{
  "$migration": "0.1",
  "id": "0002-handles",
  "from": "x7457y",
  "to": "hn656j",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT",
      "note": "add column 'handle' on 'User'" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "age": "$.age",
                                  "handle": { "$lower": "$.name" } } } ] }
  ]
}
```

The draft is GONE — replaced, at its own index, so the DDL still runs
first — and its `note` went with it, because a note explaining what the
author still has to do is false once they have done it. The step count
does not change, and the id and both hashes are the planner's. The two
routes to a document are the same document:
`test/linq/migration-pen.test.js` asserts that replacing a planner's
draft and replaying that planner's non-draft steps through `step()`
before the same `transform` produce `deepStrictEqual` documents. Had the
author never written the transform, the draft would have ridden through
untouched and `migrate()` would have refused the whole migration
(`JD0021`) — which the same file asserts against a seeded store.

**0005.** A transform over a COLUMN-MAPPED member — the pair that decides whether
a reader trusts this pen with real data:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';

const before = m.defineModel({ entities: {
  Event: m.object({ id: m.string().key(), stamp: m.datetime().column('integer') }),
} });
const after = m.defineModel({ entities: {
  Event: m.object({ id: m.string().key(), stamp: m.datetime().column('integer'), day: m.date().column('integer') }),
} });

export const days = defineMigration({ id: '0005-days', from: before, to: after })
  .ddl('ALTER TABLE "Event" ADD COLUMN "day" INTEGER')
  .transform('Event', (e) => ({ id: e.id, stamp: e.stamp, day: e.stamp.substring(0, 10) }));
```

```json
{
  "$migration": "0.1",
  "id": "0005-days",
  "from": "1r3h9t3",
  "to": "vwfxn7",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"Event\" ADD COLUMN \"day\" INTEGER" },
    { "kind": "jslt", "collection": "Event",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "stamp": "$.stamp",
                                  "day": { "$substring": [ "$.stamp", 0, 10 ] } } } ] }
  ]
}
```

**A transform over a column-mapped member migrates the column.** The
stylesheet is written against the DOCUMENT — `$.stamp` is the RFC 3339
string, and `day` is spelled as one — and the runner splits what it
returns back into columns and document under the TARGET model's mapping
(MIGRATION-FORMAT §2). `day` is declared `column('integer')`, so the row
that goes in as `{ stamp: '2026-08-29T10:00:00Z', day: '2026-08-29' }`
lands in SQLite as `stamp = 1787997600000, day = 1787961600000`, with
both strings still in the document. Nothing in the transform mentions a
column, and nothing should: the mapping is the model's. The runtime twin
of this claim — a seeded store, migrated, then read with raw SQL — is in
`test/linq/migration-pen.test.js`.

## 4. Refusals

The migration pen raises these four `LinqBuildError` codes and no
others — `test/linq/pen-docs.test.js` holds this list equal, in both
directions, to the codes `packages/linq/src/migration/` throws. The full
condition each code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3. **`JL0106` is this pen's alone**:
no other pen in the family raises it.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, an option it does not know, or a step whose kind or required members the runner's own structural check would reject |
| `JL0102` | a construct a `jslt` step cannot carry, or a model that is not the one the planner planned |
| `JL0104` | an external a captured transform body or assertion predicate named |
| `JL0106` | a step naming an entity or collection the target model does not declare; or a `transform` over a planned document that finds no draft to replace, or two |

Every message below is the one the pen raised when the spelling beside it
was run, with the code prefix (`JL0101: `) removed. Where a row lists
several spellings, the message shown is the first one's — the shared
predicates interpolate the method name, so the others differ only in the
word the message opens with. `docPath`, where the refusal carries one, is
the JSON pointer of the node being assembled and is appended to the
message text as well (`… at /expect`).

Throughout, `m()` is `defineMigration({ id: 'r', from: v1, to: v2 })`
over §3's first two models, whose target declares `User` and nothing
else.

### 4.1 `JL0101` — the value, the option and the step

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineMigration(null)` | `defineMigration() takes { id, from, to, note? }` | the four members |
| `defineMigration({ id: '', from: v1, to: v2 })` | `defineMigration() id is a non-empty string, got a string` — `docPath` `/id` | `'0002-handles'` |
| `defineMigration({ id: 'x', from: {}, to: v2 })` | `defineMigration() from is a $model 0.1 document (defineModel(…), or its JSON), got an object without $model: '0.1'` | `defineModel(…)`, or a snapshot |
| `defineMigration({ …, extra: 1 })` | `defineMigration() does not take 'extra'` | `id`, `from`, `to`, `note` |
| `defineMigration({ …, note: 1 })` | `defineMigration() note is a string, got 1` — `docPath` `/note` | a string |
| `m().ddl(42)`, `m().sql('')` | `ddl() takes one rendered SQL statement as a non-empty string, got 42` | one rendered statement |
| `m().ddl('SELECT 1', 1)` | `ddl() note is a string, got 1` | a string, or no note |
| `m().transform('User', 42)` | `transform() takes a callback (row, x) => …, a stylesheet(…) document or a rules array, got 42` | one of the three spellings |
| `m().transform('User', [() => 1])` | `transform() rules received a Array instance, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | `rule('$', (u) => …)`, or a JSON rules array |
| `m().transform('User', { $jslt: '0.1', rules: 1 })` | `transform() stylesheet rules are an array, got 1` — `docPath` `/rules` | an array of rules |
| `m().transform('no-such', fn)` | `transform() names an entity or collection by identifier ('users'), got a string` | an identifier |
| `m().assert('User', p, { expect: 'maybe' })` | `assert() expect is 'empty' or 'ebv' (MIGRATION-FORMAT §2), got a string` — `docPath` `/expect` | `'empty'` or `'ebv'` |
| `m().assert('User', p, { other: 1 })` | `assert() does not take 'other'` | `{ expect }` |
| `m().assert('User', undefined)` | `assert() takes a predicate (row) => … or a query document over the rows` | a predicate |
| `m().derive('User', [])` | `derive() takes a non-empty array of derived-column records ({ name, derive, segments }), got a Array instance` | the columns the planner emitted |
| `m().step({ kind: 'nope' })`, `m().step(42)` | `step() takes a migration step with a recognised kind (ddl, jslt, query, derive, sql, rebuild), got kind a string` | one of the six kinds |
| `m().step({ kind: 'rebuild', table: 'User' })` | `step() 'rebuild' needs 'create' (MIGRATION-FORMAT §2)` — `docPath` `/create` | the rendered parts |
| `m().step({ kind: 'sql' })` | `step() 'sql' needs 'sql' (MIGRATION-FORMAT §2)` — `docPath` `/sql` | the statement |
| `m().step({ kind: 'jslt', collection: 'User' })` | `step() 'jslt' needs 'stylesheet' (MIGRATION-FORMAT §2)` — `docPath` `/stylesheet` | a rules array |
| `m().step({ kind: 'query', collection: 'User' })` | `step() 'query' needs 'assert' (MIGRATION-FORMAT §2)` — `docPath` `/assert` | a query document |
| `m().step({ kind: 'derive', collection: 'User', columns: [] })` | `step() 'derive' needs 'columns' (MIGRATION-FORMAT §2)` — `docPath` `/columns` | a non-empty array |
| `fromPlanned({ id: 'x' })`, `fromPlanned(42)` | `fromPlanned() takes a $migration 0.1 document — { $migration, id, from, to, steps } — as jaren-db plan writes it` | the planner's document |
| `fromPlanned({ …, extra: 1 })` | `fromPlanned() document carries 'extra', which the migration format does not declare` — `docPath` `/extra` | the six head members |
| `fromPlanned(planned, { nope: 1 })` | `fromPlanned() does not take 'nope'` | `{ from, to }` |
| `fromPlanned(planned, 42)` | `fromPlanned() options are { from?, to? }, got 42` | an options object |

`step()`'s structural rows are MIRRORED from the runner's own `JD0023`
rules, not invented here: the pen sees the same missing member the runner
would, and says so at build rather than half-way through a transaction.
That is LINQ-FORMAT §1.1 rule 1's "the engine's own rule, seen earlier"
in its clearest form.

### 4.2 `JL0102` — the construct, and the model that is not the planned one

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m().transform('User', stylesheet([], { unmatched: 'error' }))` | `transform() takes a stylesheet's rules — a jslt step carries the rules array (MIGRATION-FORMAT §2), so 'unmatched' has no place in it; write the rules without it` — `docPath` `/unmatched` | `stylesheet([rule('$', fn)])`, or the rules array |
| `m().transform('User', stylesheet([], { modes: { toc: … } }))` | the same message, with `'modes'` | one root rule per step |
| `fromPlanned(planned, { from: v2 })` | `fromPlanned() from model has shape 'hn656j', but the planned migration's from is 'x7457y' — the model given is not the one the planner planned from` — `docPath` `/from` | the model the planner planned from |
| `fromPlanned(planned, { to: v1 })` | `fromPlanned() to model has shape 'x7457y', but the planned migration's to is 'hn656j' — the model given is not the one the planner planned to` — `docPath` `/to` | the model the planner planned to |

The stylesheet rows are a real limit of the STEP, not a limit of the JSLT
pen: a stylesheet is an envelope with a disposition and a mode table, and
a `jslt` step is an array of rules. Refusing it is what keeps the
truncation from being silent. The `fromPlanned` rows are the other kind —
a check the pen can make because both hashes are in front of it, and one
whose failure means the author edited a model after planning against it.

### 4.3 `JL0104` — the externals a capture may not name

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m().transform('User', (u, x) => ({ …, handle: x.rate }))` | `a body() rule cannot bind 'rate' — its query evaluates with exactly 2 externals, 'root' and 'path'; anything else has nothing to bind to — a stylesheet parameter is declared first: body(fn, { externals: ['rate'] })` | `x.root` and `x.path` |
| `m().assert('User', (u, x) => x.limit.gt(1))` | `an assert() predicate cannot bind 'limit' — a query assertion runs over the table's rows with no externals (MIGRATION-FORMAT §2)` | compare against a literal, or against another member |

The two are deliberately different, and the difference is the engine's:
a `jslt` step's body is evaluated by the stylesheet engine, which binds
`root` and `path` (JSLT-FORMAT §8.2); a `query` step's assertion is
evaluated over the table's rows with nothing bound at all. A migration
document is a value that has to mean the same thing in CI, on a laptop
and on a server — a parameter it could read from the environment is
exactly what it must not have.

### 4.4 `JL0106` — the table, and the draft

This pen's own code. Two conditions, and no other pen raises either.

**A step naming a table the target model does not declare.** Checked for
`transform`, `assert` and `derive`, whenever the target model is known.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `m().transform('Post', fn)` | `transform() names 'Post', which the target model does not declare — it declares 'User'` | a declared name — the message lists them |
| `m().assert('Post', p)` | `assert() names 'Post', which the target model does not declare — it declares 'User'` | as above |
| `m().derive('Post', columns)` | `derive() names 'Post', which the target model does not declare — it declares 'User'` | as above |
| `fromPlanned(planned, { to: v2 }).transform('Nope', fn)` | `transform() names 'Nope', which the target model does not declare — it declares 'User'` | as above |
| a target model declaring neither entities nor collections | `transform() names 'User', which the target model does not declare — it declares nothing` | give the target model its tables |

A collection counts as declared exactly as an entity does — the pen reads
both members of the target model (`src/migration/define.js:98-104`) — so
a migration over a phase-A collection store needs no special spelling.

**A `transform` over a planned document with no draft to replace, or
two.** Only `fromPlanned` can reach these: `defineMigration` starts with
no steps, so there is never a draft.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `fromPlanned(planned).transform('Nope', fn)` — no models given | `transform() over 'Nope': the planned migration drafts no transform for it and no target model was given — pass { to } to fromPlanned(), or spell the step with step()` | `fromPlanned(planned, { from: v1, to: v2 })`, or `.step({ kind: 'jslt', … })` |
| `fromPlanned(twoDrafts).transform('User', fn)` | `transform() cannot tell which draft to replace: the planned migration carries 2 draft transforms for 'User'` | edit the planned document down to one draft per table, or replace them with `step()` calls |

The first is not a mistake so much as a missing fact: without a target
model the pen knows only which tables the planner drafted, so a name it
has never seen could be a typo or could be perfectly good. It refuses and
names both ways out rather than guessing. The second cannot arise from
`jaren-db plan`, which drafts at most one transform per table; it arises
when a planned document is edited or two are concatenated, and a pen that
picked one would be picking which of the author's two transforms to
throw away.

Note what is NOT checked: with no target model, `ddl`, `sql`, `assert`,
`derive` and `step` take any identifier, and the runner judges. That is
the honest position — the pen refuses what it can see, and it cannot see
a model it was not given.

## 5. The types

§3's first migration, as a project actually keeps it: the previous model
in a module beside the current one, and the transform checked against
both.

```ts
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import type { DocOf, MigrationDocument } from '@jarenjs/linq/migration';
import type { Expr } from '@jarenjs/linq';
import { model as v1 } from './models/v1.js';   // the previous model module, kept beside the current one
import { model as v2 } from './model.js';

const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
//                     ^ Expr<DocOf<typeof v1, 'User'>> — the OLD row
//                                          ^ must spell the NEW row: a dropped `handle` does not compile
const document: MigrationDocument = handles.document;
```

### 5.1 Two model documents, four readings

`Migration<From, To>` carries the two model documents as type parameters,
and every method reads one of four things off them
(`packages/linq/types/migration.d.ts`):

| Type | What it reads | Where it is used |
|---|---|---|
| `DeclaredNames<M>` | `keyof E \| keyof C` of the target's phantoms — `string` for a document the type cannot read | the `name` parameter of `transform`, `assert`, `derive` |
| `DocOf<M, N>` | `InferMeta<M>[N]['doc']` — the model pen's document shape for one table; the honest `unknown` for a collection, a JSON snapshot, or a name the model does not type | the transform's row in, and the row it must spell |
| `Spell<T>` | how a value of `T` may be written: itself, an expression yielding it, the honest top (`UnknownExpr`), or — for an object — a literal spelling each member the same way | the transform callback's result |
| `SheetFor<S, New>` / `RulesFor<R, New>` | a typed stylesheet's or first rule's `Out` against the new row; `unknown` (accepted) when the rule is hand-written | the two non-callback `transform` overloads |

The row an `assert` predicate sees is `MemberExpr<DocOf<From, N> |
DocOf<To, N>>` — the members the two shapes SHARE. A precondition runs
over old rows and a postcondition over new ones, and the pen cannot know
which this one is, so what both agree on is what neither lies about;
annotate (`(u: Expr<NewUser>) => …`) when one shape is meant.

### 5.2 The honest limits, and the two routes past them

**From a JSON snapshot the old row is `unknown`.** A JSON literal is
never inferred (LINQ-FORMAT §1.1, rule 2), so `from: snapshot` gives the
callback the honest top and `u.get('name')` is how it is read. Two routes
keep the type: keep the previous model MODULE beside the current one, as
the example above does; or ask the CLI for emit's declaration of the
snapshot — `jaren-db snapshot --model ./model.js --types ./model.d.ts` —
and annotate the row from it, `(u: Expr<User>) => …`.

**A body's extra member is caught on a direct annotation, not in the
callback.** `Spell<New>` rejects a member the new row does not have, but
a contextually typed callback RESULT is not excess-checked by TypeScript;
`test/consumer/linq-migration.ts` pins both halves, the negative on a
`const extra: Spell<NewUser> = …` annotation. At run time the target
model's closed schema refuses the member, and the widening check turns
that into `JD0021` with the whole migration rolled back.

**The honest top is admitted wherever a precise value is.** `u.get(
'legacyHandle')` type-checks as the new row's `handle`, because the
runtime validator is the judge there and a type that refused it would
make a legitimate migration unwritable.

### 5.3 The exported class

`Migration<From, To>` is the one export a caller does not call: its
constructor is private, `defineMigration` and `fromPlanned` are the two
ways to get one, and every step method answers a new one. A caller meets
it as a type (`const typed: Migration<typeof v1, typeof v2> = handles`)
and as an `instanceof` narrow — `test/linq/migration-pen.test.js` uses
both. The document types beside it are ordinary interfaces:
`MigrationDocument`, `MigrationStep` and its six arms (`DdlStep`,
`SqlStep`, `JsltStep`, `QueryStep`, `DeriveStep`, `RebuildStep`), and
`DeriveColumn`. `JsltStep` declares `draft?: boolean` with the comment
that says the whole rule: the runner refuses it, and the pen never sets
or clears it.

### 5.4 What the pins hold

| File | What it proves |
|---|---|
| `test/consumer/linq-migration.ts` | `DocOf<>` equal to the two hand-written row shapes; the old row in and the new row out; eleven negatives — a member only the new shape has, a dropped required member, a member of the wrong type, a member the new row does not have (on a direct `Spell<>` annotation), an undeclared table, the identity where the shapes differ, a stylesheet whose output lacks a member, a typed rule whose output is not the new row, a `fromPlanned` transform dropping a member, an assertion reading a member only one shape has, and an `expect` outside the two — plus the snapshot's honest top and the `fromPlanned` overloads |
| `test/linq/migration-pen.test.js` | the runtime twin: every corpus migration emits its hand-written document byte-equal and deep-frozen, validates against both artifacts, builds twice to one document and one checksum, and hashes its shapes exactly as `shapeHash` does; `fromPlanned` replacing exactly the draft; an untouched draft still refusing at run (`JD0021`); and the v1 → v2 migration applying to a seeded store, shadow replay included, with the column-mapped member written to its column |

## 6. What it cannot spell

This pen's limits are unusual for the family: almost nothing is refused
as unspellable, because a migration document is mostly rendered SQL and
the pen's job is to carry it. What it cannot do is REASON about that SQL,
and the honest statement of that is the section. §6.4 closes it with the
cases where the answer is not to reach for this pen at all.

### 6.1 The physical step kinds ride verbatim

 `ddl` and `sql` are strings —
the pen checks that a statement is a non-empty string and nothing more.
It does not parse SQL, does not know the dialect, and cannot tell an
`ALTER TABLE` from a `DROP TABLE`. `rebuild` goes further: it has no
method at all, only `step()`, because MIGRATION-FORMAT §10's procedure
(create the new shape, copy, drop, rename, rebuild the indexes) is
rendered by the planner against a dialect, and a pen that typed it would
be re-implementing the planner. The alternative for all three is the same
one the format intends: let `jaren-db plan` render them, and take the
document up with `fromPlanned`.

### 6.2 `defineMigration` does not validate a migration against a database

This is the sentence a reader most needs, because believing otherwise
loses data. What the pen checks is in §4 and nothing else. Everything
below is `@jarenjs/db`'s `migrate()`, and none of it has happened when
`.document` returns:

- **The from-shape against the database.** A migration whose `from` does
  not match the shape the database recorded refuses to run (`JD0020`).
  The pen computes the hash; only the runner compares it to a database.
- **The shadow replay.** Before the real store is touched, the WHOLE
  chain — baseline, applied and pending — replays on a shadow database:
  every DDL statement runs, every stylesheet and assertion compiles and
  executes, and the end shape is verified against the target model
  (MIGRATION-FORMAT §4). A step the pen accepted and SQLite rejects fails
  there, with the real store untouched.
- **The widening/narrowing check against real data.** At the end of the
  run, inside its transaction, every stored document is validated against
  the target schema. A document that no longer validates is `JD0021` and
  the whole migration rolls back. A transform that forgets a new required
  member compiles, emits, passes the shadow — and fails here, which is
  the only place it CAN fail, because the answer depends on the rows.
  `test/linq/migration-pen.test.js` pins exactly that.
- **Assertions.** A `query` step's verdict is a fact about the data. The
  pen writes the query; the runner runs it, on the shadow and then for
  real.
- **History, checksums and drift.** `JD0022` for an applied migration
  that disagrees with the history record, and `jaren-db check`'s drift
  detection, are the CLI's and the runner's (MIGRATION-FORMAT §5, §12).

### 6.3 Two the format itself does not carry

Down migrations are not
shipped in 0.1 — a JSLT transform is not generally invertible, and a
reverse step that silently loses data is worse than a restore from backup
(MIGRATION-FORMAT §7); the recommended path is to branch the shape,
migrate forward and drop the old table once verified. A rename is
DECLARED, never inferred, with `.renamedFrom()` on the model pen's
builder ([MODEL-PEN.md](MODEL-PEN.md) §2.1) — a diff cannot tell a rename
from a drop plus a create, and guessing risks silent data loss.

### 6.4 When not to reach for this pen

- **The planner's document already runs.** If `jaren-db plan` produced no
  draft — a pure DDL change, an index added, a column widened — the
  document it wrote is finished. Commit it. This pen exists for the step
  the planner left blank, and reaching for it to retype a document that
  was already correct adds a build step and a chance to diverge.
- **The migration is one SQL statement and no data moves.** `.ddl()`
  around a string you would otherwise commit as JSON buys the shape hash
  and nothing else, and the shape hash is what `plan` computes anyway.
- **The transform cannot be spelled as a query.** A body is captured
  through the JSLT pen and lowers to `$jslt`, so it can only do what the
  query language has operators for (§4.3, and
  [JSLT-PEN.md](JSLT-PEN.md) §6). A transform that needs to call out —
  a hash, a network lookup, a library — is a `sql` step against a table
  you populate beforehand, or a program run outside the migration
  entirely.
- **You want to undo something.** There are no down migrations in 0.1
  and §6.3 says why. Branch the shape and migrate forward; a restore from
  backup is a better answer than a reverse step that loses a column
  quietly.
- **The document is generated per environment.** A `$migration` is
  identified by two shape hashes and applied once, recorded in history.
  Anything that would make the document differ between two databases of
  the same shape — an environment name in a statement, a conditional step
  — is not a migration, it is deployment configuration, and it belongs
  outside the document.

## 7. Cost

`@jarenjs/linq/migration` builds to **<!--fact:bundle.migration-->24,259<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
(<!--fact:bundle.migration.kb-->24<!--/fact--> kB) beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md).

The probe is a gate, not a report: building a two-step migration as a
consumer would, it asserts four things and fails the build on any of
them:

- **no chain module** — none of `sequence.js`, `document.js`, `async.js`,
  `concurrency.js`, `provider.js`, `sources.js` or `schema-of.js`
  contributes a byte;
- **no schema pen and no model pen** — not one byte of
  `packages/linq/src/schema/` or `packages/linq/src/model/`;
- **no engine and no store** — not one byte of `@jarenjs/validate`,
  `@jarenjs/emit`, `@jarenjs/db`, `@jarenjs/formats` or `@jarenjs/refs`,
  and nothing of `@jarenjs/json` beyond `canonical.js` and `pointer.js`,
  which are what a shape identity is made of;
- **a ceiling** of 24,000 bytes; and the other direction, that the chain
  and the schema pen carry no byte of `packages/linq/src/migration/`.

**A migration module imports the model pen's phantoms, not its
runtime.** That second assertion is the interesting one, because a
migration is written against two models and typed by them: the
declarations import `ModelDocument` and `InferMeta` from the model pen's
`.d.ts` (`packages/linq/types/migration.d.ts:28`), and a type import
costs nothing at run time. What reaches the bundle is `defineMigration`,
the step spellings, the JSLT pen's `body()` with the shared recording
proxy behind it, and the canonicalizer — and the two model documents
themselves arrive as data, deep-frozen JSON that the consumer's own model
module built. So a consumer who ships migrations to a browser does not
ship the model pen with them; a consumer who OPENS a store does, and pays
`./model`'s <!--fact:bundle.model-->45,575<!--/fact--> bytes for it.
