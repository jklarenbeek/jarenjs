# Native plans over adopted columns

The executable census in `test/db/fixtures/adoption-sql.json` retains its SQL
reference alongside public documents. Five read families execute as one native
statement: settings projections, environment joins, correlated counts, nullable
grouped sums/counts, and compound-key point reads. Receipt history retains its SQL
reference because the source table has no declared primary key. Inventing an
entity identity would change the adoption contract.

## Reads

Use `store.execute(document, { strict: true })` to require a native plan;
`{ pushdown: false }` executes the decoded-row reference path. The JSON language
is unchanged: projections use object/array constructors, correlations use nested
`$for` and `$count`, and groups use `$groupby`. LINQ chains emit the same documents.
For example, a projection with a correlated count is:

```js
const document = [{
  $for: { c: '$.Catalog[*]' },
  $orderby: '$c.sku',
  $return: { sku: '$c.sku', inventories: { $count: {
    $for: { i: '$.Inventory[*]' },
    $where: { $eq: ['$i.sku', '$c.sku'] }, $return: '$i'
  } } }
}];
const rows = await store.execute(document, { strict: true });
const explanation = await store.explain(document);
```

Native correlations require one inner entity root, equality edges to outer
bindings, a bare inner return, and supported scalar predicates. Windows, grouping
and ordering inside a correlation, and arbitrary computed inner returns remain residual. Mandatory profile filters
apply to correlated roots too. Scalar column projections preserve declared NULL
policies. Codecs needing transformed representations remain decoded-row work.

Grouping is restricted to one root and reconstructible keys/aggregates. A nullable
SQL sum needs an explicit query expression: test existence of non-null values,
then sum those values, otherwise return literal null. An ordinary JSON sum over
an empty sequence remains zero. Compound physical identities without explicit
group ordering remain residual; the first-seen order cannot be replaced with
independent SQL minima. Unsupported shapes give a reason in `explain`; strict
mode refuses them with `JD0010`.
Physical integer sums/averages also prove the group's magnitude/count bound
inside SQL. When intermediate exactness cannot be guaranteed, ordinary execution
uses the existing decoded evaluator and reports that diversion; strict execution
refuses `JD0010`. This can cost an additional statement and full decoded scans.
Floating sums/averages and date/datetime grouping remain residual. Physical text
comparisons explicitly use codepoint collation, independent of a column's declared
collation; an incompatible index may therefore stop helping that query.

Safe identity/object projection chains, including a projected join followed by
filtering and ordering, flatten without crossing windows, grouping or inner
ordering. Standalone min/max over supported scalar columns and sum/avg over safe
integer columns now lower natively, preserving empty-sequence and present-null
errors. Missing or unbindable external values refuse strict execution and both
cursor APIs before any decoded fetch; a nullable slot accepts explicit null.

`explain` reports the emitted SQL, scan narrative, profile bounds and last
execution's admitted statement/returned-row/serialized-wire-byte counts. These
are application admission costs. SQLite does not expose visited-row counts or
statement time enforcement; a correlated subquery can visit many rows despite
returning a small projection. Use indexes and inspect the scan narrative. Profile
row limits bound fetched results; byte limits bound each decoded result item.

## Mutations

The asynchronous entity set exposes `mutate(document)`. It compiles and caches a
closed document into one parameterized SQLite data statement, inside the same
guarded transaction used by the entity writer. It supports adopted writable
column layouts. Hybrid entities, PostgreSQL physical layouts, arbitrary SQL,
store-enforced before/after invariants and unsupported expression shapes refuse
with `JD0038`. Database constraints and invariant triggers retain enforcement.

```js
const result = await store.entity('Inventory').mutate({
  op: 'update', key: { environment: 'test', sku: '0012' },
  expectedRevision: 1, set: { quantity: 4 },
  returning: ['quantity', 'revision'], maxRows: 16, maxBytes: 16384
});
```

The operations are:

| Operation | Required document members | Meaning |
|---|---|---|
| `update` | `key` and/or `where`, `set` and/or `expressions`; `expectedRevision` for a versioned entity | Exact assignments with an atomic predicate. Default changed reporting suppresses identical writes; `reporting: 'matched'` executes them. A declared version increments once on a write. |
| `upsert` | `values`, `conflict`; `update` or `onConflict: 'nothing'` | Ordered logical conflict columns may name a non-primary UNIQUE identity; `conflictWhere` matches a partial index. Default changed reporting suppresses identical updates. |
| `delete` | `key` and/or `where`; `expectedRevision` for a versioned entity | One conditional or bulk delete, with the same transactional output bounds. |
| `insert-select` | `source`, `where`, `select`, `conflict`, `onConflict: 'nothing'` | Same-entity scalar/literal projection, bounded source rows, conflict-ignore insertion. Source and target path codecs and NULL policies must match. |

`returning` is a nonempty list of logical stored members (default: all). `maxRows`
defaults to 100 and `maxBytes` to 1048576; both must be finite positive safe
integers. The result is `{ mode: 'native', affected, rows, admitted }`.
`admitted` names one data statement, returned rows and full decoded-row bytes,
including columns omitted by `returning`. SQL transaction control is separate.

Insert-select materializes at most `maxRows + 1` source rows and refuses overflow
before insertion, even if all rows would conflict. Output bounds and codec/schema
validation run inside the transaction; failure rolls back rows and trigger effects.
The byte bound checks decoded output, not a database allocation interrupt.
The statement's `RETURNING` view follows SQLite timing; later AFTER-trigger
modifications are not an extra readback. Changed-reporting same-input literal replay yields no effective write, revision
increment or additional trigger effects. Matched reporting and arithmetic
expressions intentionally may write on repeat.

Mutations are untracked. Re-read affected rows before subsequent tracked editing;
a previously tracked revision remains stale and retains normal conflict checks.
Use `tx.entity(name).mutate(document)` to compose writes, receipts and jobs in one
transaction. An outer failure rolls everything back. `entityCore` on a synchronous
connection also settles these mutations synchronously. `where` accepts a native
Jaren predicate or structural `sql` expression; `expressions` maps exact logical
assignment names to `sql` expressions, with logical columns resolved to physical
names. A member cannot appear in both `set` and `expressions`.

For cross-table insert-select, expression conflict updates, raw JSON text, bytes
and complete SQLite null/collation semantics use the explicit
[native SQLite surface](SQLITE-RELATIONAL.md). It shares expression emission with
entity mutations while retaining its own native SQL result contract.

## Bounded ranges and live qualification

The headless adapter is exported by `@jarenjs/linq/db`; its structural contract is
[COLLECTION-PROVIDER.md](../../app/docs/COLLECTION-PROVIDER.md). It uses existing
entity cursors, keyset pages and committed capture, with no app import.
Initial qualification is captured hybrid entity roots. Physical keyset identities
and physical capture retain their explicit refusals. Live notifications are
source resets; offset windows retain their existing rerun classification.
