# Native plans over adopted columns

The executable census in `test/db/fixtures/adoption-sql.json` retains its SQL
reference alongside public documents. Five read families execute as one native
statement: settings projections, environment joins, correlated counts, nullable
grouped sums/counts, and compound-key point reads. Receipt history retains its SQL
reference because the source table has no declared primary key. Inventing an
entity identity would change the adoption contract.

## Reads

Use `store.execute(document, { strict: true })` to require a native plan;
`{ pushdown: false }` executes the decoded-row reference path. Under `strict`, a member
name the dialect cannot spell as a path (one holding a `"` or a control
character, even in a literal `$get`) is refused `UnrepresentablePath` like any
other unspellable path, where the engine would run it without `strict`. The JSON language
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
bindings, a bare inner return or one singular member path of it, and supported
scalar predicates. Such a hop counts, tests existence or emptiness, takes part
in a comparison, and — where its equalities cover the inner entity's declared
key — orders rows or fills a projected member; `$some` and `$every` over one
entity array are one `EXISTS` (MODEL-FORMAT §10.1). A hop counted or tested
for existence may return a second hop that reaches at most one row (a
many-to-many hop's join row, then its target row), which becomes an
`EXISTS` inside the first. Windows, grouping
and ordering inside a correlation, any other hop out of a hop, and arbitrary computed
inner returns remain residual. Mandatory profile filters
apply to correlated roots too. Scalar column projections preserve declared NULL
policies. Codecs needing transformed representations remain decoded-row work.

A join pairs rows by equalities between mapped columns, and only where the
database pairs them as the engine does: both columns of ONE comparison family —
the family the column stores and the engine decodes (a number against an
integer, a string against a string), never a union's first type — a schema type
that claims another kind than its codec decodes is refused at the model
(MODEL-FORMAT §12) — neither a boolean, and not both
able to read a NULL as a present `null`, which the engine equates with another
and SQL does not. A NULL that reads back as no member pairs alike in both, so a
nullable member still joins natively against a key or against another nullable
member. A foreign key no property declares compares as the key it references. An
equality that fails the rule is no edge: a root it alone would connect is a
product the engine builds, and beside a real edge it is a conjunct the engine
decides. The comparisons that refine an edge, and a hop's correlation, follow
the family rule and refuse any column that can read a NULL.

An equality or inequality of two columns of one binding follows the same
reading of NULL: a column whose policy reads a NULL back as a present `null`
holds one whatever its schema omits, and the comparison is the engine's, which
pairs two nulls and differs a null from every present value where SQL does
neither. An ordering of the pair, and a pair of columns that admit no null,
stay native.

Grouping lowers over one root, or on SQLite, unordered, over a connected join of
roots, with reconstructible keys/aggregates. A join is grouped through a derived
table that numbers its rows in the engine's nested-loop order, every root's
identity in binding order, so a group comes out where its first row does; keys
and aggregates read either root, and a count of any root is the count of the
group's rows. Only the groups in that order lower there: an ordered grouping, a
window over groups, the nullable form of a sum and a return that reads a whole
root stay in the engine. A sum, mean or extreme over a column that stores a
boolean, and a grouping ordered by a key that stores one or whose NULL reads
back as a present `null`, stay in the engine, which refuses the boolean or the
`null` where SQL folds or orders it. A sum, mean or extreme over a column whose
NULL reads back as a present `null` lowers: the statement counts that
aggregate's NULLs beside it, and the runtime raises the engine's `JQ2001` when
a group holds one, where SQL alone would skip it. On PostgreSQL such a column
is not qualified for native reads at all, so there the aggregate stays in the
engine under `entity.projection`. A nullable
SQL sum needs an explicit query expression: test existence of non-null values,
then sum those values, otherwise return literal null. An ordinary JSON sum over
an empty sequence remains zero, beside the nullable form of the same sum in one
grouping: each is an aggregate of its own. Groups an order leaves tied come out by first
appearance, and over a compound physical identity that is the smallest key
tuple, which independent SQL minima do not give: such a grouping (no order, an
aggregate, a key left out) remains residual, while an order naming every group
key ranks the groups apart and lowers. Unsupported shapes give a reason in
`explain`; strict mode refuses them with `JD0010`.
Physical integer sums/averages also prove the group's magnitude/count bound
inside SQL. When intermediate exactness cannot be guaranteed, ordinary execution
uses the existing decoded evaluator and reports that diversion; strict execution
refuses `JD0010`. This can cost an additional statement and full decoded scans.
Floating sums/averages and date/datetime grouping remain residual. Collection
sums and averages follow the same rules: a `number` member stays in the engine
(`plan.floatingAccumulation`; so does one declared `integer` and also `number`,
in either order, and an adopted column whose codec is not `integer`), which
adds the rows the pushed `$where` still
selects through its index, and an `integer` one folds as a double beside the same
magnitude/count bound, its run answered by the engine past it over those same
selected rows (`explain().fallback.construct` `'accumulation'`); a term past the
bound is left out of the fold, so over the values the store writes no accumulator
overflows and the statement never fails, inside a PostgreSQL transaction or out of
one (a JSON number past the double range, written by trusted SQL, is refused on
PostgreSQL: MODEL-FORMAT §7). A temporal bucket's sum or
average over a `number` reading stays in the engine too
(`series.floating-accumulation`, a pinned series still seeking its index), and
a native one over `integer` readings carries the same bound. Groups ordered by
an integer sum or average lower beside that bound: a group with no value
orders as `0` (a sum) or as the empty key (an average), equal values keep
their first appearance, and a group past the bound sends the call to the
engine. A floating one stays in the engine, and so does a window over groups
ordered by either (`plan.windowedAccumulation`), because the bound of a group
the window leaves out is never read. On PostgreSQL an entity grouping lowers
over one adopted table with no document column; over a store-owned table, and
over any join, the engine groups (`bind.entityGrouping`). An entity ordering over a
document member reads it as its declared type, so a number orders numerically on
PostgreSQL as on SQLite, in a query's `$orderby`, a load's include and a root
load alike; a member declared with more than one type orders in the engine (a
load refuses it). Physical text
comparisons explicitly use codepoint collation, independent of a column's declared
collation — and the decoded evaluator fetches a root in that key order too, on
PostgreSQL as on SQLite; an incompatible index may therefore stop helping that query.

`$distinct` is the grouping of its items. The database groups a scalar by its value
and its JSON type, which is how the engine's equality tells `'1'` from `1`, `true`
from `1` and `null` from an absent member, and holds `2` and `2.0` equal as one number
(the string `'2.0'` is apart from `2`); the groups come out in the order the engine meets
the rows. A collection's distinct lowers over a singular
member path the schema declares as scalars alone — strings, numbers, integers and
booleans, each optionally `null`, however many of them a union lists — or over an object
constructor of such paths and literals, nested objects included (each absent path is an
absent member of its item). It lowers unordered, ordered by the projected path alone, or
ordered by other paths that ordering lowers over: the statement then numbers the rows in
that order, as the join above does, and takes each group at its first row, so a row
without the key stays in the ordering where `$empty` places it. A literal window over it
lowers. A group key that holds a number is read as the number the engine parses (a double
on SQLite, the numeric itself on PostgreSQL), so `2` and `2.0` are one key and a whole number
beyond 2^53, which a client that writes doubles leaves as an integer text, is a key like any
other: the driver is never asked for it as an integer. The statement groups every row it
reads, and the planner cannot know how many groups there are: with nearly as many groups
as rows the statement does the engine's own work and a sort besides, and can be slower than
the engine. SQLite groups an object or an array by its text, which keeps the order its
members were written in, and PostgreSQL's jsonb text keeps the spelling of a number (`1.0`),
where the engine compares them member by member and numbers by value. So a leaf that may
hold either (an object, an array, a member with no type, a union that lists either, a path
reached by a negative index), an array constructor (its elements are not named, so rows with
different leaves can answer one array), an operator, the document and a path with several
items stay in the engine (`plan.distinctProjection`), as does a constructor, or a distinct
ordered by other paths, beside a conjunct that runs as a registered function
(`plan.registeredFunction`). An entity's distinct lowers the same way over mapped columns of
text, integer, number and boolean types, alone or in an object constructor, over one binding
or a connected join, with no ordering of its own; any other shape stays in the engine
(`entity.distinct`), and on PostgreSQL it lowers over one adopted table with no document
column (`bind.entityGrouping` otherwise).

A count over an object or array constructor of member paths, literals and
operators that cannot raise is one `COUNT(*)` that reads no row: `$default` over
member paths and literals, `$upper`, `$lower` and `$string-length` over a member
the schema types exactly `string` (reached by no negative index; an adopted
column must also store text, under no date codec, and read no NULL as a present
`null`), and `$count` and `$exists` over a member path. The engine evaluates the return of every row, so any other
operator, a union or an epoch column keeps the count in the engine, which raises
where a row does; so
does a window over an operator projection of an entity, which has no row
residual (a collection's window over such a constructor is pushed: MODEL-FORMAT
§10.6).

The engine evaluates a `$where`'s conjuncts in order, stopping at the first false
one, so on a collection, from the first conjunct that can raise — one the planner leaves to the
engine, or one that runs as a registered function — no later conjunct narrows the
rows (`predicate.afterRaising`): it runs as a registered function, which the
statement evaluates after the earlier one, or stays in the engine, because an index
seek on it would never visit a row the earlier one raises on. A conjunct the engine
decides that cannot raise leaves the later ones narrowing: an `$eq` or `$ne` of
literals, member paths and the operators a pushed count accepts, an `$exists` or an
`$empty`, and an `$and`, `$or` or `$not` of those. The conjuncts before it keep
narrowing, a seek staying a seek, so the selective conjunct goes first. A window
beside a registered function stays in the engine too (`plan.registeredFunction`): the
statement stops once the window is full, and the engine evaluates every row. The
engine also evaluates the filter on every row before a cursor yields its first item,
so a `query()` cursor over a statement whose registered function can raise reads the
statement whole first (`streaming: 'buffered'`, the barrier `bind.raisingFunction`;
`strictStreaming` declines it, `JD0037`) and raises before any item where the engine
does; a cursor whose functions cannot raise still pulls one row per item. The engine
evaluates the return of every row before that first item too, so a cursor whose return
runs in the engine per row (`mode: 'row'`) and can raise on one reads the statement
whole first as well (the barrier `bind.raisingProjection`, construct `$return`); a
return that cannot raise — an operator a pushed count accepts, over the operand it
accepts, or a constructor of such operators, member paths and literals — still pulls
one row per item.

A string literal reaches the database through the driver as UTF-8, which has no
spelling for a lone surrogate: it arrives as U+FFFD and the database compares that
in its place, so a comparison or a string operator over one stays in the engine
(`predicate.loneSurrogate`; on SQLite it runs as a registered function, which reads
the literal as written), as does a disjunction that holds one. An entity conjunct
that holds one inside a hop to a related entity (a `$count`, `$exists` or `$empty` of
the hop, or a comparison of the member it returns) stays in the engine on both
dialects. A graph load and a native mutation have no engine path, so a predicate
comparing one refuses (`JD0032`, `JD0038`) and the statement never runs. PostgreSQL's
text and
jsonb hold no U+0000, so there a literal holding one, or a membership list item
holding U+0000 or a lone surrogate, sends a collection's or an entity query's
document to the engine (`bind.serverText`); such a list rides the statement on
SQLite, whose JSON reads the escape as it read the stored document. An external is
bound by the same rule when the call runs: a string external holding a lone
surrogate — and on PostgreSQL one holding U+0000, or a membership list holding
either — diverts the call to the engine (`bind.external`), while on SQLite a list
holding one still binds. SQLite's `$ends-with` compares bytes, so a
U+0000 in the pattern or in the stored value answers as the engine does. A lone
surrogate that SQLite stores reads back from a native statement as U+FFFD, one of the
[named deviations](#named-deviations) below.

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

## Named deviations

The `pushdown: false` engine is the oracle: a native plan answers what it
answers, value or error code. These are the cases where it does not, each
kept on purpose and named here; every other difference is a defect. In the
last four the native plan answers where the engine raises a type or decoding
error, and wherever the engine answers, the two agree; in the first the two
read one stored string differently.

- **A lone surrogate stored on SQLite reads back as U+FFFD.** A document
  holding `"\uD800"` (SQLite stores it; PostgreSQL refuses the document)
  reads back from a native projection, group key or distinct as three
  U+FFFD, where the engine and the live strategies read the surrogate itself.
  Reading it exactly would test every text leaf of every such statement,
  which slows the reads of text that never holds one. Keep lone surrogates
  out of stored text, or run the read with `pushdown: false`.
- **A pushed string operator answers false for a stored `null`.** Collection
  `e` keyed `/id`, `s` typed `['string', 'null']` with an index on `$.s`,
  rows `{ "id": "a", "s": "abc" }` and `{ "id": "b", "s": null }`:
  `{ "$for": { "e": "$[*]" }, "$where": { "$starts-with": ["$e.s", "a"] }, "$return": "$e.id" }`
  answers `"a"` natively (with `strict: true` too), and the engine raises
  `JQ2001` (`expected a string, got null`). `$ends-with` and `$contains` do
  the same, over a plain column, an epoch column or a document member. A
  member typed `string` alone answers false the same way for a stored `null`
  or number, which only a store that validates nothing can hold. Running the
  nullable shape in the engine would cost the prefix search its index seek,
  make `strict` refuse it and count every fetched row against a profile's
  `maxRows`. A guarded native form that counts the null rows beside the seek
  was built and set aside: SQLite evaluates a registered-function term for
  rows an earlier `IN (SELECT …)` term already excludes, so it raised a false
  `JQ2001`, and the count reads every row lacking the member, turning a seek
  on a sparse member into a table scan. A member of several kinds besides
  `null` (`['string', 'integer']`) and an adopted column with `null: 'null'`
  are the engine's and raise. To get one answer from both, say what a `null`
  means: `{ "$and": [{ "$ne": ["$e.s", null] }, { "$starts-with": ["$e.s", "a"] }] }`
  answers `"a"` natively and in the engine, and stays native.
- **A native `$resample` window never reads the rows outside it.**
  Collection `sample` (`series` string, `at` integer, `value` number, index
  `["$.series", "$.at"]`), rows `{ "series": "a", "at": 1767225600000, "value": 1 }`,
  `{ "series": "a", "at": 1767225660000, "value": 2 }` and, outside the window,
  `{ "series": "a", "at": 1767226200000, "value": "x" }`:
  `{ "$resample": [{ "$for": { "s": "$[*]" }, "$where": { "$eq": ["$s.series", "a"] }, "$return": "$s" }, { "every": 60000, "aggregate": "max", "start": 1767225600000, "end": 1767225720000 }] }`
  answers natively
  `[{ "at": 1767225600000, "value": 1, "count": 1 }, { "at": 1767225660000, "value": 2, "count": 1 }]`,
  and the engine raises `JQ2001` (`row 2, value: neither a finite number nor null`).
  The statement applies `start` and `end`, so a row outside them that the
  temporal kernel refuses (no instant, no reading) is never met; the engine
  validates every row first. Inside the window the statement counts the rows
  that carry no reading and hands such a question to the engine
  ([ARCHITECTURE](../ARCHITECTURE.md), "A group with no instant"). Probing the
  rows outside the window would cost what the window saves. A store that
  validates its writes (a `compileSchema` hook) cannot hold such a row.
- **A native statement never reads a column it does not name.** An adopted
  SQLite table `d (id INTEGER PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL)`
  holding `(1, '2026-01-01', 1)` and `(2, 'not a date', 2)`, mapped as entity
  `D` with `day` under the `date` codec: `{ "$for": { "it": "$.D[*]" }, "$return": "$it.n" }`
  answers `[1, 2]` natively, and the engine raises `JD2003` (`column 'day'
  refuses a lossy or invalid date value`), because it decodes the whole row.
  A `$count` of that `$for`, a selection (`$where` over `n`) and a
  `$distinct` of it answer the same way. The engine's class is wider than this
  example: invalid text in a `date` or `datetime` column, a PostgreSQL
  `double precision` NaN or Infinity, an integer above 2^53. Reading every
  column would cost every native statement the columns it does not need. A
  `$count` of the bare binding (`{ "$count": "$.D[*]" }`) and any document
  that reads the column (`{ "n": "$it.n", "day": "$it.day" }`) raise `JD2003`
  natively too. To keep such rows out of the table, constrain the column in
  the database (a CHECK that `day` holds a date).
- **A native count or window over a constructor never evaluates the rows it
  skips.** Collection `c` (`o` number with an index on `$.o`, `u` typed
  `string`) on a store with no validation hook, rows `{ "id": "a", "o": 1, "u": "x" }`,
  `{ "id": "b", "o": 2, "u": 5 }` and `{ "id": "c", "o": 3, "u": "y" }`:
  `{ "$count": { "$for": { "it": "$[*]" }, "$return": { "k": { "$upper": "$it.u" } } } }`
  answers `3` natively, and
  `{ "$subsequence": [{ "$for": { "it": "$[*]" }, "$orderby": ["$it.o"], "$return": { "k": { "$upper": "$it.u" } } }, 0, 1] }`
  answers `{ "k": "X" }`; the engine raises `JQ2001` (`expected a string, got
  a number`) on row `b` for both. The schema types `u` exactly `string`, so
  the planner proves the constructor cannot raise and counts the rows (one
  `COUNT(*)` that reads none) or stops the statement once the window is full;
  a row the schema forbids is never evaluated. For the same reason a `query()`
  cursor over that return streams and yields the items before the row it
  raises on. Evaluating every row would cost the count and the window what
  they save. A store that validates its writes (a `compileSchema` hook)
  cannot hold such a row; on one that does not, `pushdown: false` answers as
  the engine.

## Mutations

The asynchronous entity set exposes `mutate(document)`. It compiles each closed
document into one parameterized native data statement and reuses statements by
their complete SQL in a bounded cache. Bindings, projections and output limits
remain local to each call; earlier payload-bearing documents are not retained.
Execution uses the same guarded transaction as the entity writer. It supports adopted writable
SQLite and PostgreSQL column layouts. Hybrid entities, arbitrary SQL,
store-enforced before/after invariants and unsupported expression shapes refuse
with `JD0038`, as does a `where` comparing a string that holds a lone surrogate,
which the database would read as U+FFFD; an assignment, a value or a key holding
one is refused `JD2003`, as the entity writer refuses it
([MODEL-FORMAT §9.3](MODEL-FORMAT.md#93-the-hybrid-mapping)). Database constraints
and invariant triggers retain enforcement.
PostgreSQL verifies its explicit schema and exact scalar codecs before adoption;
see [native column adoption](MODEL-FORMAT.md#postgresql-column-adoption).
Its mutation result is limited on the server to `maxRows + 1` rows, so an
overflow witness causes rollback without sending every affected row to the
client. Server work and transactional trigger effects can exceed that result
window; the effective statement timeout also applies. A single large row can
exceed a receive-frame byte budget before the client refuses it.

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
Initial qualification is captured hybrid entity roots. Physical keyset pages
qualify for integer, bigint, text and uuid identities on both engines (MODEL-FORMAT §10.5);
physical capture retains its explicit refusal. Live notifications are
source resets: an entity offset window still resets rather than being
maintained, while a collection offset window over an `orderBy` is a
maintained live window (LIVE-FORMAT §7).
