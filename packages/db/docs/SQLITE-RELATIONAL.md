# Native SQLite programs on an existing connection

`@jarenjs/db/relational` provides structural SQL authoring, physical table DDL,
and guarded migrations. `relational(connection)` requires an available
synchronous SQLite connection from `@jarenjs/db/node` or `@jarenjs/db/bun`.
It opens no store and uses the supplied connection and transaction. Expressions
are closed `$sql` nodes built by `sql`; strings are bound values, never SQL
fragments. Identifiers are quoted as single names. `planRelational` returns
`{ sql, params, access }` for review without reading the database.

## Choose the expression semantics

| Surface | Null, text and numeric semantics | Execution |
|---|---|---|
| LINQ / JSON query over mapped entities | Jaren equality, codepoint text comparison, declared codecs; present null remains null | Qualified native plan; `strict: true` refuses any required residual, including unsupported external bindings |
| `sql` expressions and `relational` | SQLite three-valued logic, native affinities, explicit BINARY/NOCASE/RTRIM, native aggregates | One native statement; no decoded-row fallback |

For example, Jaren equality regards two present nulls as equal, while SQLite
`=` yields SQL NULL and `IS` supplies a null-safe comparison. Jaren sum over an
empty sequence is zero and a present null is a type error. SQLite `sum` skips
null and returns null without inputs; `total` returns floating zero. SQLite
floating accumulation and ASCII NOCASE are deliberate choices on this surface.
No mapping must omit a null member to use native SQL.

```js
import { relational, sql } from '@jarenjs/db/relational';
const r = relational(connection);
const c = sql.column;
const query = {
  from: { table: 'staging', as: 's' },
  columns: {
    id: c('id', 's'), raw: c('body', 's'),
    price: sql.cast(sql.call('json_extract', [c('body', 's'), '$.price']), 'REAL'),
  },
  where: sql.binary('IS', c('supplier', 's'), sql.param('supplier')),
  orderBy: [{ by: sql.collate(c('sku', 's'), 'NOCASE'), nulls: 'first' }],
};
for (const row of r.iterate(query, { externals: { supplier: null } })) {
  consume(row); // original raw text and native byte values are preserved
}
```

`all`, `get`, `iterate` and `execute` settle synchronously. `iterate` uses the
shared cursor lifecycle, releases its statement on early return or failure,
and reports `streaming`/`barrier` from the driver. `all` intentionally collects
the result. SQLite may itself sort or build temporary query structures.

Selections support table and subquery sources, inner/left/cross joins, correlated
`sql.scalar`/`sql.exists`, CASE, IN/NOT IN, DISTINCT, grouped and distinct
aggregates, HAVING, UNION/UNION ALL and ordered windows. The declaration file
lists the closed operators and functions, including trim/coalesce, LIKE, JSON
extraction/type inspection, casts and SQLite date functions. Neither arbitrary function names
nor a raw-expression escape hatch is accepted.

`sql.call('json_type', [document, path])` distinguishes a missing path (SQL NULL)
from JSON null (text `'null'`) and reports SQLite's native scalar/container type
names. Omitting the path inspects the whole document. SQL-null input stays null;
malformed JSON raises SQLite's error. It composes with CASE and synchronous
cursors without decoding or rewriting the original column. See
[SQLite JSON type inspection](https://www.sqlite.org/json1.html#the_json_type_function).

## Exact writes and bytes

```js
const result = r.execute({
  op: 'update', table: 'claims',
  set: { revision: sql.binary('+', c('revision'), 1), status: 'done' },
  where: sql.binary('AND',
    sql.binary('=', c('revision'), sql.param('expected')),
    sql.binary('=', c('owner'), sql.param('owner'))),
}, { externals: { expected: 3, owner: 'worker-1' } });
// result.affected is SQLite's direct statement count, excluding trigger writes.
```

UPDATE emits exactly the supplied assignments. `reporting: 'matched'` is the
native surface's default and executes identical assignments, so UPDATE OF and
immutability triggers run. `reporting: 'changed'` adds a BINARY, null-safe
comparison to suppress unchanged rows. UPDATE and DELETE require an explicit
`where`; literal `1` authorizes every row. Predicates and arithmetic belong to
one statement. The existing entity updater retains changed-row behavior;
`entity.mutate` adds explicit matched reporting and expression assignments.

INSERT accepts `values` or a `source` selection with ordered target `columns`.
A source may read another table or an intermediate legacy shape. `ignore: true`
uses INSERT OR IGNORE. `conflict` accepts ordered column/expression targets, an
optional partial-index `where`, and `action: 'nothing'` or `'update'` with an
exact `set` and optional `updateWhere`. Use `sql.column(name, 'excluded')` for
incoming values. Conflict-target expressions contain literal schema values so
SQLite can match its index. No read-then-write emulation occurs.

`Uint8Array` and Node `Buffer` values bind as bytes; returned binary values stay
bytes. Subarray offsets and zero bytes survive without hex strings or JSON
arrays. Combine metadata, image, conflict and history writes inside the existing
synchronous transaction; failure rolls back all of them. Optional `returning`
collects rows using SQLite RETURNING timing, before subsequent AFTER-trigger
changes. Unlike bounded entity mutation documents, this explicit native surface
has no automatic result row/byte limit; use a bounded selection or streaming read
when handling large results.

## Physical schema ownership

```js
import { defineTable, planTable, planTableMigration, applyTableMigration } from '@jarenjs/db/relational';
const history = defineTable({
  name: 'history', primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'INTEGER', identity: 'autoincrement', nullable: false },
    { name: 'body', type: 'TEXT', nullable: false },
    { name: 'revision', type: 'INTEGER', default: 1, nullable: false },
  ],
  indexes: [{ name: 'history_revision', terms: [{ by: c('revision'), direction: 'desc' }] }],
  triggers: [{ name: 'history_immutable', timing: 'before', event: 'update',
    steps: [{ raise: { action: 'abort', message: 'immutable history' } }] }],
});
const ddl = planTable(history).createSql;
const migration = planTableMigration(connection, history, { id: 'history-v2', allowRebuild: true });
// Inspect migration.statements and migration.finish before applying the plan.
applyTableMigration(connection, migration);
```

Columns retain declaration order and exact INTEGER/REAL/TEXT/BLOB/NUMERIC/ANY
types. Definitions support ordered primary keys, rowid or AUTOINCREMENT identity,
nullability, database defaults, generated columns, STRICT/WITHOUT ROWID, named
UNIQUE/CHECK/foreign-key constraints and delete/update actions. A column can also
declare `references: { table, columns: [name], onDelete, onUpdate, deferred }`.
Index terms
support expressions, direction and collation, with an optional partial predicate.
Triggers support BEFORE/AFTER, INSERT/UPDATE/DELETE, UPDATE OF, OLD/NEW conditions,
mutation steps and RAISE. Schema expressions use the same structural emitter,
with quoted inline literals because SQLite disallows schema parameters.

Entity `.physical(...)` metadata can also supply column `type`, `defaultValue`,
`collation`, `identity`, `check`, `generatedExpression` and `stored`, plus table
`constraints`, `indexes`, `triggers`, `strict` and `withoutRowid`.
`planEntity(...).createSql` now emits explicit table DDL for complete writable
declarations; views and incomplete generated/default definitions remain adoption
metadata. `openStore` still verifies physical tables without creating them.
Identical physical models produce an empty `planModelMigration`; changed
physical tables use the live-schema `planTableMigration` API.

## Guarded upgrades

Planning inspects the existing schema without modifying it. A differing existing
table requires `allowRebuild: true` when using `planTableMigration`; use the narrow
schema operations below to append a column without rebuilding. Every removed
column needs `dropColumns`; removing an existing explicit
index/trigger requires `dropObjects`. Unmentioned indexes and triggers survive.
An optional `copy` maps writable non-key target columns to structural expressions;
new columns otherwise use their defaults. The plan retains the source schema and
an exact canonical checksum. Applying an edited plan or a stale source refuses.
A target already matching the reviewed plan is a no-op on repeat.

Execution creates a replacement, copies natively, verifies row counts and
unchanged values/storage classes, drops/renames atomically, restores indexes and
triggers, and checks foreign keys and the target schema. Primary-key columns,
unshadowed hidden rowids, raw text, bytes and AUTOINCREMENT high-water marks are
preserved. A key change, rowid-ownership change or ambiguous rowid alias refuses.
No migration history table or model adoption is needed.

Rebuilds require SQLite's foreign-key transition outside a transaction. For a
nested upgrade use `withForeignKeysSuspended(connection, () => { ... })` as the
outer scope, then nested `connection.transaction`/migration calls share savepoints.
The helper owns an IMMEDIATE transaction, checks references, and restores
`foreign_keys` and `legacy_alter_table` after success or failure. Its callback must
settle synchronously. A rebuild inside an already open FK-enabled transaction
refuses before DDL. Node/Bun regressions cover populated history and references,
failed copies, repeat reopening, nested rollback, and process death after DROP
with WAL recovery. These tests do not establish power-loss durability.

## Additive and object operations

`planSchemaChange(connection, operation)` returns a reviewable
`{ version, operation, sql, source, settings, checksum }`. It reads the main schema
and relevant connection settings without executing DDL. `applySchemaChange`
checks that source and settings again under an IMMEDIATE transaction before
executing the single statement. It returns `{ changed }`, the number of schema
operations that changed the catalog, rather than the number of affected rows.
Both methods require the same available synchronous SQLite ownership as rebuilds.

```js
import { planSchemaChange, applySchemaChange, sql } from '@jarenjs/db/relational';
const addition = planSchemaChange(connection, {
  op: 'addColumn', table: 'entries', column: {
    name: 'revision', type: 'INTEGER', nullable: false, default: 1,
    check: sql.binary('>=', sql.column('revision'), 1),
  },
});
// Review addition.sql and addition.source before execution.
applySchemaChange(connection, addition);
applySchemaChange(connection, planSchemaChange(connection, {
  op: 'dropIndex', name: 'obsolete_index', ifExists: true,
}));
```

The closed operations are `addColumn` (`table`, `column`), `dropIndex` (`name`,
optional `ifExists`), `renameTable` (`table`, `to`) and `dropTable` (`table`,
optional `ifExists`). Identifiers address **main** explicitly; a temporary table
with the same spelling cannot redirect an operation. A dot inside a name is a
literal character. Attached database operations are not part of this surface.
The column definition and expression renderer are shared with `planTable`.

ADD COLUMN appends a declaration and preserves existing rowids, values, storage
classes, column order, indexes and triggers. It does not derive a complete table
definition, normalize unknown constraints or copy the table. Literal defaults
are supported; identity columns, STORED generated columns and expression defaults
refuse. Ordinary NOT NULL additions require a non-null default. REFERENCES
additions require a NULL default (or no default), and a single referenced column.
SQLite checks existing rows for a new CHECK or generated NOT NULL constraint;
those checks can scan the table even though the operation does not copy it.
See [SQLite ADD COLUMN restrictions](https://www.sqlite.org/lang_altertable.html#alter_table_add_column).

Drop operations fail on absence unless `ifExists: true` is supplied. A missing
object then returns `changed: 0`. DROP INDEX affects the named index, not its
table or triggers. DROP TABLE removes the table and its owned indexes/triggers;
SQLite's active foreign-key actions still apply. RENAME follows SQLite's current
dependency rewriting behavior and the reviewed `legacy_alter_table` setting.
See [DROP TABLE](https://www.sqlite.org/lang_droptable.html) and
[RENAME TABLE](https://www.sqlite.org/lang_altertable.html#alter_table_rename).

These are **single-source plans**, not durable migration receipts. Replan after
any schema change. Reapplying a successful ADD/RENAME plan refuses as stale;
it does not infer completion from a same-named object. An ordered migration must
check its trusted schema/version receipt before planning the next operation and
record completion in the same transaction. Unknown members or unsupported column
declarations refuse with `JD0005`; modified/stale plans refuse with `JD0021`.
Native object, data-constraint and dependency errors are left to SQLite. A
checksum detects accidental plan edits; it does not authorize untrusted plans.

## Explicit identity-changing upgrades

The ordinary rebuild planner continues to refuse key reassignment or row loss.
A reviewed upgrade can use the primitive operations under
`withForeignKeysSuspended`, with its own explicit data policy:

1. Check the durable migration receipt or the exact supported legacy schema.
2. Create a distinct replacement table with `planTable`.
3. Use relational insert-select with a scoped correlated selection, deterministic
   identity choice and explicit exclusion predicate. Assert selected, inserted
   and excluded counts, and any business-specific preservation requirements.
4. Plan/apply `dropTable` for the original and then `renameTable` for the
   replacement. Create the required indexes/triggers and validate dependents.
5. Record completion inside the same transaction so another opening does no work.

Create the replacement before dropping the original; renaming the original first
can redirect dependent references. Plan each primitive inside the FK scope, after
the preceding schema operation. The helper checks references before commit and
restores connection settings. The caller must review incoming key references,
views, triggers, immutable neighbors and each row disposition. Conflicts fail and
roll back; there is no inferred permission to discard rows. The installed native
[qualification fixture](../../../test/db/fixtures/schema-upgrade.mjs) demonstrates
scoped minimum-ID selection, explicit exclusions, rollback, repeated reopening
and recovery after actual process death at DROP.

## Read-only inspection and disk snapshots

`readSchema` from `@jarenjs/db/model` inventories tables without adopting them,
but excludes engine bookkeeping. For a scanner that must include framework tables,
select table names directly from `sqlite_schema` with `relational`, or use the
public `connection.dialect.introspect.tables()` statement. A native selection can use `sql.call('typeof', [sql.column(name)])` and
`sql.column('rowid')` to inspect actual text storage in otherwise unknown shapes.
Declared affinity does not determine a value's storage class. WITHOUT ROWID tables
and shadowed rowid aliases require an explicit different identity selection.

Both host driver entries export `snapshotDatabase(connection, newPath)`. It
reserves a new destination, refuses any existing file (even empty), includes
committed WAL data through VACUUM INTO, syncs the output and cleans up a failed
copy. It allocates no database-sized JavaScript image. SQLite page caches and
its temporary storage govern native working memory. The copy runs synchronously
inside the asynchronous filesystem operation; it is not an incremental-progress
or interruption API. A snapshot inside an active transaction fails and cleans up.
Explicit keys, retained histories and bytes survive; [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html)
may renumber unaliased rowids, so this is not a page-identical archival copy. Bun store backups
use the same disk-backed path; Node store backup keeps its online-backup binding.

## Lightweight engines

Use `@jarenjs/db/query`, `/model` and `/entity` for existing-connection consumers;
`/relational` needs neither entity normalization nor a query plan cache.
`compileEntityModel(model)` returns `{ entities, mapping }` from one normalization,
avoiding the duplicated work of separate `normalizeEntities` and `explainMapping`
calls. No global strong model cache is introduced. Keep connection/query caches
bounded and reuse compiled metadata. Smaller import graphs alone do not prove
the complete application meets its RSS budget; measure application memory with
representative workloads.

Entity mutation engines retain prepared statements by their complete emitted SQL
in the bounded core LRU cache. Bound values, output projections and row/byte limits
belong to each execution; changing a payload does not retain another document and
another copy of the same statement. Distinct SQL stays isolated. This reduces
retained payload memory, at the cost of rebinding/compiling an identical mutation
document on each call. The synthetic retention probe at
`test/db/fixtures/mutation-memory.mjs` reports both varying-payload and identical
mutation timings, heap and RSS on Node (`--expose-gc`) and Bun. Such samples do not
replace a complete application's resource gate. Metadata remains caller-owned;
keep one compiled mapping per used model, one query state per connection, and
release facade/cache references on close. Driver cursors remain ephemeral.
