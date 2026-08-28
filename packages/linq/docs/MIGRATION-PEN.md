# The Jaren migration pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

```js
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
```

writes `$migration` 0.1 documents ([MIGRATION-FORMAT](../../db/docs/MIGRATION-FORMAT.md)):
the two shape hashes and the ordered steps the runner takes unchanged.
Identity stays the shape hash — `from`/`to` are
`hashContent(canonicalizeJson(model))` with the `x-rename` planning
hints stripped, the store's own rule, and a test holds the pen's hash
equal to the store's `shapeHash` over every corpus model. The planner
still plans: `jaren-db plan` renders the DDL and leaves the data
transform it cannot infer as a draft; `fromPlanned(planned, { from, to })`
takes that document up so a `transform` typed old row → new row REPLACES
the draft, in place. The pen never clears a `draft` flag — a draft left
alone still refuses to run (`JD0021`, the runner's rule) — and it imports
no store and no engine: the transform's body is the JSLT pen's capture,
the hash is `@jarenjs/core`'s over `@jarenjs/json`'s canonical form.

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineMigration({ id, from, to, note? })` | `{ $migration: '0.1', id, from, to, note?, steps }` — `from`/`to` the two models' shape hashes, exactly `shapeHash` (pinned) | `Migration<From, To>`, the two model documents' phantoms | native; not a `$model` document, an empty `id`, another member `JL0101` |
| `.ddl(sql, note?)` | `{ kind: 'ddl', sql, note? }` — one rendered statement (§2) | — | native; an empty statement `JL0101` |
| `.sql(sql, note?)` | `{ kind: 'sql', sql, note? }` — one data statement spelled directly (§9.4) | — | native |
| `.transform(name, (row, x) => …)` | `{ kind: 'jslt', collection: name, stylesheet: [{ match: '$', body }] }` — one root rule, the body captured through the JSLT pen's `body()` over the WHOLE row, `x.root`/`x.path` the externals the engine binds (§8.2 of JSLT-FORMAT) | `row` is `Expr<Old>` (`InferMeta<typeof from>[name]['doc']`); the result must spell `New` — a dropped, mistyped or foreign member does not compile; the honest top (`get()`) is admitted where a precise value is | native; a table the target model does not declare `JL0106`; an undeclared external `JL0104` |
| `.transform(name, stylesheet(…))`, `.transform(name, rules)` | the rules ARRAY — a `jslt` step carries the array, so the envelope's `unmatched`/`modes` have no place in it | a typed stylesheet's or first rule's `Out` must be `New`; a hand-written rule is the honest top | native; a disposition or a mode table `JL0102`; not JSON `JL0101` |
| `.assert(name, (row) => …, { expect? })` | `{ kind: 'query', collection: name, assert: { $for: { it: '$[*]' }, $where: <predicate>, $return: '$it' }, expect? }` — the format's own `$for` over the rows; the predicate names the VIOLATION (`expect: 'empty'`, the default, absent from the document) or the witness (`expect: 'ebv'`) | `row` is the members the two shapes share — a precondition sees old rows, a postcondition new ones, and what both agree on is what neither lies about; annotate (`(row: Expr<User>) => …`) when one shape is meant | native; another `expect` `JL0101`; an external `JL0104` |
| `.assert(name, query, { expect? })` | the query document verbatim | — | native |
| `.derive(name, columns)` | `{ kind: 'derive', collection: name, columns }` — a backfill of stored derived columns (§2.1), the columns verbatim | — | native; no columns `JL0101` |
| `.step(raw)` | any planner-emitted step, verbatim — the escape that keeps `rebuild` (§10) authorable without the pen re-implementing it; a `draft` flag rides untouched | `MigrationStep` | native; an unrecognised kind or a missing member (the runner's `JD0023` rules, seen early) `JL0101` |
| `fromPlanned(document, { from?, to? })` | the planner's document, taken up: `.transform(name, …)` replaces its draft for `name` in place; the other methods append | the models type the transforms and are checked against the document's hashes | native; a model that is not the planned one `JL0102`; two drafts for one name, or no draft and no target model `JL0106` |
| `.document`, `toJSON()` | the deep-frozen `$migration` document | `MigrationDocument` | native |

Three rules the table implies, spelled out:

- **Identity stays the shape hash.** A database stores hashes, not
  models; the pen computes what the store computes, from the same two
  functions, with the same hint stripped — and the pin over every corpus
  model is what keeps the two equal.
- **The planner still plans; the pen types the human part.** The
  workflow: a model module → `jaren-db plan --model ./model.js` (diffs
  the committed `model.snapshot.json` against the model, writes the
  migration with `--out`, advances the snapshot) → a migration module
  built with `fromPlanned(planned, { from, to })` and a typed `transform`
  → `jaren-db check` in CI (an unplanned model change, a pending
  migration or drift exits 1) → `jaren-db apply`. `jaren-db` loads model
  and migration modules beside JSON and refuses one that is not pure.
- **A step's table is one the target model declares.** The runner would
  fail the statement on a table that does not exist; the pen says so
  first (`JL0106`) — for `transform`, `assert` and `derive` alike, when
  it knows the target. Over a planned document alone it knows only the
  drafts, so a transform for another table is spelled with `step()`.

## 3. Worked examples

Every `js` fence exports exactly one migration, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`.

A migration by hand between two model-pen models — the DDL the planner
would render, a typed transform, an assertion:

```js
import * as m from '@jarenjs/linq/model';
import { defineMigration } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string() }) } });
const v2 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string(), handle: m.string() }) } });

export const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .ddl('ALTER TABLE "User" ADD COLUMN "handle" TEXT')
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }))
  .assert('User', (u) => u.handle.isEmpty());
```

```json
{ "$migration": "0.1", "id": "0002-handles", "from": "1410er5", "to": "eedea8",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "handle": { "$lower": "$.name" } } } ] },
    { "kind": "query", "collection": "User",
      "assert": { "$for": { "it": "$[*]" }, "$where": { "$empty": "$it.handle" }, "$return": "$it" } }
  ] }
```

The bridge — the document `jaren-db plan --model ./model.js` wrote,
with its draft replaced by a typed transform:

```js
import * as m from '@jarenjs/linq/model';
import { fromPlanned } from '@jarenjs/linq/migration';

const v1 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string() }) } });
const v2 = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string(), handle: m.string() }) } });

// what the planner wrote: the DDL it rendered, and the transform it
// could not infer, left as a draft that refuses to run
const planned = {
  $migration: '0.1', id: '0002-handles', from: '1410er5', to: 'eedea8',
  steps: [
    { kind: 'ddl', sql: 'ALTER TABLE "User" ADD COLUMN "handle" TEXT', note: "add column 'handle' on 'User'" },
    { kind: 'jslt', collection: 'User', stylesheet: [], draft: true,
      note: "the document schema of entity 'User' changed; fill in the transform (or delete this step if every stored document already validates) and remove \"draft\"" },
  ],
};

export const typed = fromPlanned(planned, { from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
```

```json
{ "$migration": "0.1", "id": "0002-handles", "from": "1410er5", "to": "eedea8",
  "steps": [
    { "kind": "ddl", "sql": "ALTER TABLE \"User\" ADD COLUMN \"handle\" TEXT",
      "note": "add column 'handle' on 'User'" },
    { "kind": "jslt", "collection": "User",
      "stylesheet": [ { "match": "$",
                        "body": { "id": "$.id", "name": "$.name", "handle": { "$lower": "$.name" } } } ] }
  ] }
```

## 4. Refusals

The migration pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/migration/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |
| `JL0106` | a step naming an entity or collection the target model does not declare |

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import type { DocOf } from '@jarenjs/linq/migration';
import type { Expr } from '@jarenjs/linq';
import { model as v1 } from './models/v1.js';   // the previous model module, kept beside the current one
import { model as v2 } from './model.js';

const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
//                     ^ Expr<DocOf<typeof v1, 'User'>> — the OLD row
//                                                        ^ must spell the NEW row: a dropped `handle` does not compile
fromPlanned(planned, { from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
```

The honest limit: from a JSON snapshot (`from: snapshot`) the old row is
`unknown` and `u` the honest top, because a JSON literal is never
inferred (LINQ-FORMAT §1.1, rule 2). Two routes keep the type: keep the previous
model module beside the current one, as above; or ask the CLI for emit's
declaration of the snapshot — `jaren-db snapshot --model ./model.js
--types ./model.d.ts` — and annotate the row from it, `(u: Expr<User>)
=> …`. A body's extra member is caught on a direct annotation of the
spelling (`Spell<New>`); a contextually typed callback result is not
excess-checked by TypeScript, and the closed target schema refuses the
member at run time.

## 6. What it cannot spell

Every construct the migration pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/migration` builds to **23,196 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the canonicalizer and its pointer encoder — what a shape identity needs — and no chain module, no schema or model module and no other engine.
