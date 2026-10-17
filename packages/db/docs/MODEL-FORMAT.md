# The Jaren model format (`jaren-model`)

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Canonical schema: [`schemas/jaren-model.schema.json`](../schemas/jaren-model.schema.json)
(draft 2020-12), with the mechanically derived draft-07 twin beside it.

Section allocation is fixed so no two documents ever claim the same
section number: §§1–7 the storage subset, §8 the safe profile, §9
entities, §10 relational translation, §11 the unit of work.

## 1. Scope

`readSchema(connection)` inventories physical facts independently of model
representability. SQLite keys include rowid aliases and ordered composite keys;
columns retain defaults, nullability and key ordinals, foreign keys retain groups
and update/delete actions. `tables[].sql` and `objects[].sql` retain source DDL,
including collations, generated expressions, predicates and trigger programs.
PostgreSQL catalogs retain available object definitions; unavailable source table
DDL is explicitly `null`. `introspectModel()` also returns an `inventory` with
`derived` or `preserve` dispositions. A disposition never authorizes a drop.
Application triggers appear as `unmapped-object` losses with their owner and SQL,
and so do the rule programs of a store-owned entity (§13.4): the derived model
declares no `invariants`, so it neither opens over that table (`JD0002`, an
undeclared trigger) nor migrates to the authored model (the plan's `CREATE`s
meet the installed programs and fail `JD0023`); the model that declares the
rules is the one that opens it. The two triggers that write a collection's
container key (§3), its key column and the unique index over it are read back
exactly as a store creates them for the unique indexes over the members the
table holds — the derived model plans them again — and are no loss; one
written otherwise is reported as its own loss (`unmapped-object`,
`unmapped-column`, `unmapped-index`).
A collection's declared interval comes back from its CHECK as the `intervals`
entry that declared it, the span typed an object of two required `integer`
bounds, which is no loss; a CHECK of another shape or name, or one added
`NOT VALID`, is `unmapped-constraint`.
Repeated inspection is read-only; `strict: true` refuses losses with `JD0002`.

The loss rows are the contract for what the model vocabulary cannot say;
introspection never infers intent to make one go away. A collection's partial
index, an entity's partial index whose condition does not read back into the
query grammar, a direct SQL expression index and a CHECK outside the complete
scalar enum grammar stay sorted loss rows: such a predicate or expression has
no equivalent model declaration, and emitting an unconditional index in its
place would strengthen what the database promises. A boolean stored as an
integer and a numeric precision that storage erased cannot be told apart
without metadata the database does not keep, and a PostgreSQL schema's keys,
types, constraints, opclasses, functions, row-level security and identity
sequences are inventoried without being read as application intent. To adopt
such a table, author the declarations it needs — on SQLite in the explicit
structural vocabulary of [native SQLite programs](SQLITE-RELATIONAL.md) — in
the model that opens it, rather than deriving them.

A **model document** declares the collections of a store: each
collection is a JSON Schema for its documents, a key declaration, and
a set of declared indexes. `openStore(model, { driver, ... })` opens
(or creates) a database through an injected **driver**, applies the
physical mapping through a **dialect**, and gives transactional,
schema-validated reads and writes.

This is version `0.1` — the storage subset. Every collection is an
entity with no relations and a single JSON document column. Later
versions add vocabulary to THIS format; they do not add a second
format. Querying, migrations, entities and change capture are outside
this document's scope and own their reserved sections below.

The store runs over SQLite — on Node (`@jarenjs/db/node`), on Bun
(`@jarenjs/db/bun`), and in a browser against an injected wasm handle
(`@jarenjs/db/wasm`) — and promises nothing else.

## 2. The model document

```json
{
  "$model": "0.1",
  "collections": {
    "users": {
      "schema": { "type": "object", "required": ["id", "email"],
                  "properties": { "id": {"type": "string"},
                                  "email": {"type": "string", "format": "email"},
                                  "age": {"type": "integer"} } },
      "key": "/id",
      "indexes": [
        { "name": "by_email", "path": "$.email", "unique": true },
        { "name": "by_age", "path": "$.age" }
      ]
    }
  }
}
```

- `$model` MUST be `"0.1"`.
- `collections` MUST carry at least one collection; names MUST be
  identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
- `schema` MUST be an object schema — it is what stored documents
  validate against (§5) and the type source for indexed paths (§3).
- `key` is an RFC 6901 pointer to the caller-supplied key member, and
  MUST select at least one member — or `null` when the store
  allocates keys (§6).
- `indexes[].path` is a JSONPath expression that MUST be **singular**:
  it selects exactly one member per document. Wildcards, slices,
  filters, descendants and function calls are not indexable; a
  non-singular path is rejected at open with `JD0004` naming the
  expression. A composite index takes a non-empty array of paths.
- Index names MUST be identifiers, unique within their collection.
- `indexes[].unique` is `true` or `false` (the default).
- `indexes[].where` makes the index **partial**: it holds only the
  documents a bounded condition is true for, so a unique index refuses a
  second document only where both satisfy it. The condition is a query
  expression over top-level members (`$.<member>`, or `$['<member>']` for
  any name, §9.2) the collection
  already indexes by their path, each of one scalar schema type that
  excludes `null` — a generated column holds SQL NULL for a JSON null
  and for a missing member alike, which the query engine tells apart —
  and scalar literals: `$eq`, `$ne`, `$lt`, `$le`, `$gt`, `$ge`, `$eq`
  against a non-empty `{ "$seq": [...] }` of literals, `$exists`,
  `$and`, `$or` and `$not`. It answers as the query engine does over a
  stored document that holds each member it reads with the schema's type:
  a member the document lacks is never equal, unequal or ordered, and
  text compares by code point on both engines. A store without a
  validation hook (§5) can hold a document whose member is `null` or of
  another type, and the condition reads that member as a missing one —
  where the engine sees a value (SQLite's column also keeps a mistyped
  scalar as its text) — so the guarantee assumes conforming documents, as
  §5's query answers do. A `null` literal, a `$seq` item of a type the
  member does not hold, arithmetic, any other member, a condition nested
  deeper than 64 levels, one that lowers to a constant as written (`true`,
  or a comparison across types such as `{ "$eq": ["$.status", 3] }`), and
  a `where` on a derived index are `JD0004` at the `where`. PostgreSQL
  keeps a condition inline in its catalog row (about 8 kB compressed): a
  list of long literals past that is refused by the server at every open
  (`JD0002` naming the server's reason). The same lowering serves an
  entity index (§9.2). A changed `where` migrates as the index's own
  `DROP INDEX` and `CREATE INDEX`
  ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#3-planning-and-the-wideningnarrowing-rule)).
- `indexes[].derive` declares a **derived** index: the columns are
  computed FROM the selected member rather than being the member.
  See §2.1.
- `intervals[]` declares a member an **interval**: `{ "name", "path",
  "maxDuration"? }`. `path` is a singular JSONPath selecting a member the
  schema types as an object whose `start` and `end` are both required
  and both `integer`, each bound indexed by its own path (`$.span.start`,
  `$.span.end`) — the generated columns the CHECK reads and the plan
  seeks. Every stored span of the collection is then a half-open interval
  of two safe integers, `start < end` (and, with `maxDuration`, a
  positive integer of milliseconds, `end - start <= maxDuration`), or the
  member is absent: the store refuses anything else before the statement
  (`JD2003`, with or without the validation hook of §5), and a CHECK on
  the table named `<name>_interval` refuses it from every other writer
  (`JD2005`, class `constraint`; §3.2 lists the shapes and each engine's
  spelling). A dropped, altered, renamed or — on PostgreSQL —
  unvalidated CHECK is `JD0002` at open. `$overlaps` over the declared
  span plans exactly: two comparisons the bound's index seeks, no
  residual — and, with `maxDuration`, a third that bounds the start from
  below, so the plan binds both bounds of the start at every window;
  reading the index between them is the engine's choice (§3.2). `name`
  is an identifier, unique among the collection's
  intervals, naming a constraint of at most 63 bytes; an unindexed bound,
  a bound typed `number` (the CHECK's integer test would refuse the
  fractions it admits), a path to no such member, a duplicate name and a
  `maxDuration` that is not a positive safe integer are `JD0005` at the
  member. Adding, changing or removing the declaration on an existing
  collection is a planned migration — on PostgreSQL the CHECK added or
  dropped in place, on SQLite one rebuild of the collection — refused
  `JD0021` before any step where stored rows violate it
  ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#3-planning-and-the-wideningnarrowing-rule)).

What the declaration buys is measured by `benchmark/series.js` over a
year of fifty thousand stored spans asked one one-hour question at three
days of the year. The mapped pre-filter scans every window alike — the
comparison between two columns that keeps an inverted span for the engine
binds no index — and the exact plan seeks the start index from the
window's end and reads every span that started before it, so on SQLite it
wins early in the year and loses late in it — the declared plan is <!--fact:series.spanVerdict-->32.5× faster at day 10, 2.4× faster at day 180 and 1.4× faster at day 355<!--/fact-->.
A `maxDuration` is the late window's cure: no span meeting a window began
more than that long before it, so the plan bounds the start from below as
well and the seek reads the window's neighbourhood alone, whatever the
day — with the duration bounded the plan is <!--fact:series.spanBoundedVerdict-->433.3× faster at day 10, 493.5× faster at day 180 and 650.3× faster at day 355<!--/fact-->.
PostgreSQL chooses per window — a bitmap read of one bound's index where
the window is selective, a sequential scan where it is not — and at no
measured window was the exact plan slower than the scan it replaces; with
the duration bounded it read the start index between both bounds at every
measured window, the middle one included.

<!--fact:series.spanTable-->
| window | spans met | mapped pre-filter (scan) | declared interval (seek) | the declaration is | with `maxDuration` (two-sided seek) | the bound is |
|---|---:|---:|---:|---|---:|---|
| day 10 | 38 | 30 ms | 0.92 ms | 32.5× faster | 0.069 ms | 433.3× faster |
| day 180 | 38 | 34 ms | 14 ms | 2.4× faster | 0.068 ms | 493.5× faster |
| day 355 | 20 | 37 ms | 26 ms | 1.4× faster | 0.056 ms | 650.3× faster |
<!--/fact-->

On PostgreSQL `#>` resolves the key `"0"` of an object where the span's path
has an array step (`$.spans[0]`), so a path whose container the schema leaves
open is read off the document under a guard that requires each such step's
parent to be the container it means: the bound columns, the CHECK and the
native plan's exact `$overlaps` hold a document whose `spans` is an object
keyed so to be no span, as SQLite and the query engine do, and the store's own
check reads an index step off an array alone on every engine. A comparison or
an ordering over such a path reads the bound column, which reads the member as
the guarded document does, where the table holds it so; one a table holds
without the guard is read through the guarded document. Where the schema declares the container's type (`type: 'array'`) the
bound columns and the CHECK are spelled without the guard, and a document of
the other kind is non-conforming. A table holds either spelling and is
accepted as it is (a change of how the model declares the container plans
nothing, a move of the path between an index step and a name rebuilds the
bound columns and the CHECK); one an earlier release created holds the unguarded text and reads an
object's key `0` there until the link `planColumnUpgrade` plans from the catalog
rebuilds them ([MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#upgrading-the-definitions-a-table-holds)),
or the interval and its bound indexes are dropped by a migration and declared again.

An invalid model document is `JD0005` with a `docPath` pointing at the
offending member. Model checking happens before any database work.

**Every declaration is a closed set**, and the runtime and the canonical
schema (`schemas/jaren-model.schema.json`, `additionalProperties: false`
at each) agree on it: the root takes `$model`, `collections` and
`entities`; a collection `schema`, `key`, `identity`, `indexes`,
`intervals` and `x-rename`; an index `name`, `path`, `expression`,
`unique`, `where`, `derive`, `precision`, `dims` and `physical`; an
interval `name`, `path` and `maxDuration`; an entity `schema`,
`indexes`, `physical`, `invariants` and `x-rename` (§9); an entity index
`name`, `path`, `expression`, `unique` and `where` (§9.2); an invariant
the members of §13. Any other member — `uniqe` for `unique`, a
`$schema` — is `JD0005` at the member itself
(`/collections/c/indexes/0/uniqe`), naming the nearest member and the
declaration's set, checked before any other rule of that declaration.
An unknown member used to be ignored: a misspelt `unique` opened a store
whose index was not unique.

**Every name a model plans is one namespace.** Tables (a collection's, an
entity's, a join table), indexes (`<collection>_<name>`,
`<Entity>_<name>`, `<Entity>_<member>` for a one-column `unique` or
`index` and for a foreign key), R\*Tree tables and their triggers, and on
PostgreSQL the relations the server creates for a table unasked
(`<table>_pkey`, a serial column's `<table>_<column>_seq`) are compared
with ASCII case folded on both engines, as SQLite compares names. Two
objects that meet in one name are
`JD0004` at the second, before any statement: met at open instead, the
second `CREATE … IF NOT EXISTS` was skipped — an index went unenforced,
or an entity and a collection whose names differ only in case shared
one table. A name PostgreSQL would truncate (over 63 bytes) is `JD0004`
at the member that names it.

**A time series needs no new declaration.** A composite index whose
LAST path is a finite numeric epoch member is the whole physical
feature a temporal plan reads:

```json
{ "indexes": [{ "name": "by_series_at", "path": ["$.series", "$.at"] }] }
```

There is no `derive` kind for it, no column type and no host function.
The columns before the instant are the prefix an equality has to pin
for the index to seek, exactly as for any other composite index, and
the schema is the type source as always: type the instant `integer` and
a bucket ladder is pushed as integer arithmetic; type it `number` and
the ladder stays a core refinement, because a truncating division over
a real would put an instant in the wrong bucket. On SQLite an `integer`
instant is read in the order its index seeks it only where the schema
bounds it within ±(2^53 − 1) on both sides — `{ "type": "integer",
"minimum": 0, "maximum": 8640000000000000 }` for milliseconds — and is
otherwise read as the double, so that two spellings of one double past
2^53 tie as in the engine, and a range or an as-of window sorts every row
it reads (ARCHITECTURE.md, "An ordering, a group key and a distinct read
a number as the double"). Which shapes are pushed, and the reason each
refinement is one, are in ARCHITECTURE.md's "The temporal plan".

### 2.1 Derived indexes (spatial and vector storage)

A generated column must be a scalar (§3), and a GeoJSON position is an
array of numbers while a geometry is an object. No path over spatial
data is therefore indexable as written. `derive` supplies the missing
vocabulary: it says what is computed from the member — an indexable
scalar for the spatial kinds, and for an embedding (an array of
hundreds of numbers, which no B-tree could seek) the packed form a
fetch-and-rank plan reads whole.

```jsonc
"indexes": [
  { "name": "by_cell", "path": "$.at",        "derive": "geohash", "precision": 7 },
  { "name": "by_box",  "path": "$.geometry",  "derive": "bbox" },
  { "name": "by_vec",  "path": "$.embedding", "derive": "vector",  "dims": 768 }
]
```

| `derive` | `path` selects | `precision` / `dims` | columns | type |
|---|---|---|---|---|
| `"geohash"` | a position `[lon, lat]`, a `Point`, or any value with a representative position (the mean of its vertices) | `precision` 1..12, **required** | one, `<column>` | `TEXT` |
| `"bbox"` | any GeoJSON value | — | four: `<column>_w`, `<column>_s`, `<column>_e`, `<column>_n` | `REAL` |
| `"vector"` | an array of exactly `dims` finite numbers, typed `array` by the schema | `dims` 1..8192, **required** | one, `<column>_v<dims>` — a COLUMN, not an index (below) | `BLOB` |

`derive` is a CLOSED set of those three values. An open "expression"
member would be a second query language inside the model document,
which this format does not have and will not grow.

**`physical` — the shape a `bbox` index takes on disk.** `derive` says
what is COMPUTED; `physical` says how it is STORED, and the two are
separable:

```jsonc
{ "name": "by_box", "path": "$.geometry", "derive": "bbox", "physical": "rtree" }
```

| `physical` | shape | index |
|---|---|---|
| `"columns"` (the default, and what an absent member means) | the four derived columns | one B-tree over them, in `(w, e, s, n)` order |
| `"rtree"` | the same four columns, plus an R\*Tree virtual table `<collection>_<column stem>_rtree` and three triggers that keep it in sync | the virtual table; **no B-tree over the columns** |

`physical` is a CLOSED set of those two values and is refused anywhere
but on a `derive: 'bbox'` index (rule 7 below). The **logical** meaning
of `derive: 'bbox'` is identical either way — same rows, same answers,
proven entry by entry by the spatial corpus in all three executors — and
that is the whole reason it is spelled separately from the derivation.

Three things follow, and none of them is optional:

- **The sync is three DECLARED triggers, not a second write path.** A
  trigger is inside the writing transaction by construction, no write
  path can bypass it (`insert`, `upsert`, a translated patch, the patch
  fallback, a delete and a migration backfill all fire it), and it
  belongs to the collection table — so an rtree-mapped file opened with
  a `columns` model reports `JD0002` naming the trigger, and the reverse
  direction likewise, through the drift check that was already there.
  The trigger body READS the derived columns, so the box keeps ONE
  definition and the same trigger text works on the stored-column branch
  (§3.1) unchanged.
- **The virtual table is named from the COLUMN STEM, not the index
  name**, because rule 5 lets two indexes share one column set: there is
  one R\*Tree per column set, never one per index. Two indexes over one
  column set asking for two shapes is `JD0004`.
- **`$bbox-intersects` stops being EXACT under this mapping.** An
  R\*Tree stores coordinates as 32-bit floats rounded OUTWARD, so the
  stored box is a superset of the row's — by about 3 cm in longitude and
  84 cm in latitude at Dutch latitudes. That is safe for a pre-filter (a
  superset has no false negatives, which is what the implied conjunct
  needs) and it is not a decision, so the exact box test keeps a
  refinement and `strict: true` is `JD0010` where the column mapping
  reported a native plan. `ARCHITECTURE.md`'s truth table carries the
  per-mapping cell.

**What it costs, both halves** (`benchmark/spatial.js`, the store's own
rows over 50 000 points): the same `$within` measures <!--fact:spatial.rtreeStore-->0.48 ms against 2.1 ms — 4.3× in the R\*Tree's favour<!--/fact-->, and loading them
costs <!--fact:spatial.rtreeLoad-->761 ms against 457 ms for 50,000 documents in one transaction — 1.7× the write cost<!--/fact-->. Isolated from the store on a raw
connection, the same probe is <!--fact:spatial.rtree-->0.33 ms against 1.9 ms — 5.8× in the R\*Tree's favour<!--/fact-->. Read speed bought with write cost and a
second table: choose it deliberately, per index, which is why it is
neither automatic nor a store-wide option.

**`vector` — one packed column, never a B-tree.** The column holds the
member **l2-normalized** and packed as little-endian IEEE 754 binary32:
`4·dims` bytes, computed by `@jarenjs/core/vector` (`l2Normalize`, then
`packVector`) — the same kernels the query engine compares with, and
the one place this package reaches for them. It is normalized because
over unit vectors the dot product IS the cosine: the engine computes
`$similarity` (QUERY-FORMAT §8.15) as the cosine of the RAW members,
and a plan that ranks over the column computes the dot product of the
stored forms — `cos(raw) ≡ dot(normalized)` is the agreement the two
must keep, entry by entry, and the reason the column stores the
normalized form rather than the bytes of the member as written.

Three things follow:

- **No B-tree is created over the column**, and the `indexes` entry
  therefore names a column, not an index: nothing seeks a blob of
  floats, and a ranking plan reads the column whole and orders in the
  engine. The verification set (§3) carries the column and no index.
- **It is a stored column on every driver** — §3.1 says why, and why
  that is a deliberate divergence from the spatial kinds.
- **`dims` is the identity of the column.** Two widths over one path
  are two columns (`<column>_v768` beside `<column>_v1536`), exactly as
  two geohash precisions are; and the width is what makes a stored
  vector comparable at all — a column that accepted any width would be
  ranking vectors from different models against each other, which
  produces plausible garbage rather than an error.

**What it buys, and what it costs.** Measured against the same query
over a collection with no such column — the whole embedding parsed out
of the stored JSON per row — the column is worth <!--fact:vector.jsonDoc-->15.6× the plan at 10,000 × 768<!--/fact-->
on the read, and costs <!--fact:vector.write-->10.2 s against 4.9 s for 50,000 documents in one transaction — 2.1× the write cost<!--/fact-->
on the way in, because every write pays a JSON round trip of the member
plus the normalize and the pack. On
disk it is <!--fact:vector.storage-->3,072 B packed against 16,141 B as a JSON number array inside the document — 5.3× smaller<!--/fact-->
per vector — smaller than the member, and *added* to it, since the
document still carries what the column is derived from. Choose it the
way `physical: 'rtree'` is chosen: per index, with both halves in view
(`benchmark/vector.js`; the store's README carries the whole table, the
losses and the brute-force ceiling).

**What the write path does with a member that is not a vector of
`dims`** — absent, the wrong width, a non-finite component, not an
array — is store the document and write `NULL` to the column (§3.2).
The write is never refused on the column's account: refusing would
make a schema-valid document unstorable. The declaration that DOES
refuse a wrong-width vector at the write is the collection's own
schema, and a model that declares `dims` should constrain the member
to match:

```jsonc
"embedding": { "type": "array", "items": { "type": "number" },
               "minItems": 768, "maxItems": 768 }
```

With `compileSchema` injected, a document whose embedding has 767
components is then `JD2003` at the write; without it, the document
stores and is simply unrankable. Both are honest; only the second is
silent, and the schema is where the author chooses.

Every rule below is `JD0004` with a `docPath` at the offending member:

1. **`precision` is required for `geohash`, and refused anywhere
   else.** There is no safe default, in either direction — the table
   below is the reason: precision 9 is a ~4.8 m cell (a very large
   index for city-scale work) and precision 4 is ~20 km. The right
   value follows from the query radius, which the model cannot know.
2. **A derived index is never `unique`.** Two distinct positions share
   a cell — and share a box edge — by construction, and a vector column
   is one nothing seeks.
3. **The path must still be singular, and there must be exactly one of
   it.** `derive` changes what is computed from the member, never how
   the member is selected: a wildcard path is refused exactly as it is
   for an undecorated index, and a composite (array) path is refused
   because a derivation reads ONE member.
4. **The schema is still the type source.** A `derive` over a path the
   collection's schema types as `string`, `integer`, `number` or
   `boolean` is refused: the mistake is worth catching at open rather
   than at the first query that quietly returns nothing. A path the
   schema does not type is accepted — there is nothing to contradict —
   but **a spatial predicate is only PUSHED onto a column whose member
   the schema types as an array or an object** (a union of the two is
   fine; one that also admits `null` is not), because §8.14 raises for
   a non-geographic operand and a pushed filter would simply not see
   the row. Declaring the type is what turns a derived index from
   storage into a plan.
5. **Two indexes with the same `(path, derive, precision)` — or
   `(path, derive, dims)` — share one column set**, extending §3's rule
   for undecorated paths. Two `geohash` indexes over one path at
   DIFFERENT precisions are two column sets, and legitimately so: a
   coarse bucketing index and a fine proximity one are different
   indexes; two vector widths likewise.
6. **A `bbox` index covers its four columns in `(w, e, s, n)` order** —
   not the order they are declared in. An intersection test reads
   `w <= ? AND e >= ? AND s <= ? AND n >= ?`, so the two longitude
   bounds sit together at the front of the index where a leading-column
   range can use them; `(a,b)` and `(b,a)` are different indexes (§3).
   Under `physical: 'rtree'` that B-tree is **not created at all** — the
   virtual table is the index, and paying for both would be paying
   twice.
7. **`physical` belongs to a `bbox` index and to nothing else.** It is
   refused on a `geohash` index (an R\*Tree carries numbers and a cell
   is text), on a `vector` index (which has one shape on disk, §3.1),
   on an undecorated index (which has only one shape), and for any
   value outside `{"columns", "rtree"}`. It is a property of the
   COLUMN SET, so two indexes sharing one set must agree about it.
8. **`dims` is required for `vector`, and refused anywhere else** — on
   a `geohash` or `bbox` index and on an undecorated one — and must be
   an integer 1..8192. `precision` is refused on a `vector` index for
   the mirror reason: a vector has a width, not a cell size.
9. **A `vector` index needs a member the schema types `array` and
   nothing else** — `"type": "array"` or `["array"]`; a member the
   schema does not type, or types `object`, or `["array", "null"]`, is
   refused. Rule 4's leniency for an untyped spatial member does not
   carry over: a column over a member the schema lets be a string is a
   column that lies about some documents, and every refusal here says
   how to declare the member (`items`, `minItems`, `maxItems`).

*Why the model and not an `openStore` option:* the store must know which
shape to expect in order to **verify without altering** (§3). With the
choice in the model, the file and the model agree by construction; with
it at a call site, a caller who forgets the option gets `JD0002` on a
database that is perfectly correct. *Why not automatic whenever the
driver can:* it would change the physical shape of every existing
spatially-indexed database on a version bump, and the write cost above
is not something a store may opt a consumer into.

Approximate geohash cell size by precision (the kernel's
`geohashCellSize` computes the degree figures; the metric ones are at
the equator):

| precision | cell (lon × lat) | precision | cell (lon × lat) |
|---|---|---|---|
| 1 | 5009 km × 4976 km | 7 | 153 m × 152 m |
| 2 | 1252 km × 622 km | 8 | 38 m × 19 m |
| 3 | 157 km × 155 km | 9 | 4.8 m × 4.7 m |
| 4 | 39.1 km × 19.4 km | 10 | 1.2 m × 59 cm |
| 5 | 4.9 km × 4.9 km | 11 | 14.9 cm × 14.8 cm |
| 6 | 1.2 km × 607 m | 12 | 3.7 cm × 1.9 cm |

A geohash prefix is **bucketing, not proximity**: two points metres
apart can sit in different cells, so a proximity probe tests the cell's
neighbourhood (`geohashNeighbours`) rather than the single cell.

## 3. Physical mapping

Each collection maps to one table, rendered entirely by the dialect —
no SQL text exists outside a dialect. On SQLite:

- a `key` column (`PRIMARY KEY`, typed from the key declaration),
- a `doc` column holding the document as JSONB in a `BLOB` column of a
  `STRICT` table,
- one **virtual generated column** per distinct indexed path, typed
  from the collection's schema at that path (`string` → `TEXT`,
  `integer` → `INTEGER`, `number` → `REAL`, `boolean` → `INTEGER`,
  undeclared → `ANY`; a type that lists several types besides `null`,
  `['number', 'string']`, → `ANY` too, since a column of the first type
  would refuse a document that holds another),
  one derived column set per spatial `derive`
  (§3.1), one stored `BLOB` column per `derive: 'vector'` width, and
- one index per `indexes` entry, named `<collection>_<index name>`,
  over the generated columns of its paths — except a `vector` entry,
  which names its column and creates no index (§2.1).

Index paths are analyzed through the query engine's published AST: a
path is indexable exactly when the analysis reports it singular and
every segment is a plain member or index selection. The collection's
schema is the type source — the mapping needs no engine-side type
inference.

Two indexes over the same path share one generated column. On
PostgreSQL, whose generated columns carry a real type, a declared index
over one member of several scalar kinds also gets one index per kind
besides its column's, over the member read at that kind and named
`<collection>_<index name>$<kind>`, which no declared name can take; beside
a unique index they are unique, and a unique composite, conditional or
guarded index gets them too (one per combination of its members' kinds,
`$<kind>$<kind>`), so it refuses a duplicate of every kind its member holds
as SQLite does ([POSTGRESQL.md](POSTGRESQL.md)). On SQLite the generated column over a member
of several types, or of none, is the engine's untyped one, which holds a JSON
boolean as the integer `0` or `1`; a unique index keys, after its columns,
whether each such member is a boolean (`(json_type("doc", '$."q"') IN ('true',
'false'))`), so `true` and `1` are two keys, as the query engine compares them
and as PostgreSQL keys them, and a seek over its columns reads it as before.
A column of one type (`REAL` for `number`, `INTEGER` for `integer` and
`boolean`, `TEXT` for `string`) holds a value of another kind than its own as
its type reads it (`true` and `"1"` as the `REAL` `1.0`, `1` and `true` as
the `TEXT` `'1'`), since the store does not validate a member against its
type by default; a unique index keys, after such a column, `''` for a value of
the column's own kind and any other value as its text (a number as the double
it reads as, a string quoted, any other value as its JSON type), so a document
is refused beside another only where the query engine compares their members
equal, and a seek over its columns reads it as before.
That column holds an object or an array as the bytes it was written in, so a
unique index over it also has a key for a container whose members are in one
order: a plain column per such member (`kx_q`, NULL for every value but a
container) that two triggers write after every insert and every update of the
document — its nodes, each as its path (each member's name as it reads
decoded), its type and, for a string, its text or, for a number, the double it
reads as, sorted by path — and one unique index
beside the declared one per combination of its such members keyed by that
column (`<collection>_<index name>$container`, `$container$value` for a
composite), over the rows that hold a container there, under the declared
condition. Two containers are one key exactly when the query engine compares
them equal (`{"a": 1, "b": 2}` and `{"b": 2, "a": 1.0}`; `[1, 2]` and `[2, 1]`
are two), whoever writes the row and however it escapes a name (`{"\u0041": 1}`
is `{"A": 1}`). On PostgreSQL a unique index beside one over a member whose
column holds a scalar keys each container kind its union lists as `jsonb`,
whose equality is that one (`$object`, `$array`), and a column that holds a
container keys every kind by its value. A member
name the dialect's JSON path grammar cannot carry (an embedded `"` or
a control character, on SQLite) is `JD0004`. A backslash in a name is
written escaped, so the path names the member literally — never the
member a JSON escape spelled in the name would decode to.

A name the plan gives a table, a column or an index is held whole or
refused. PostgreSQL keeps 63 bytes of an identifier and truncates a
longer one silently, so two names that share a prefix would be one: on
PostgreSQL a planned name past 63 bytes — `gx_<member>` for an indexed
member, `<collection>_<index name>`, an entity's table, columns,
`<entity>_<property>` indexes, join tables and their `<Entity>_key`
columns (§9.3) — is `JD0004` at the model member it comes from, before
any statement; a join table, a join column and the column of a `via`
reference the schema does not declare come from no member of their own
and name their entity (`/entities/<Entity>`). SQLite holds a
name of any length. An index name PostgreSQL already gives one of the
table's own objects — its primary key's index `<table>_pkey`, a serial
column's sequence `<table>_<column>_seq` (`rid`, an allocated key) — is
`JD0004` at the member or index too: the table is created first, so the
index would never be. A foreign key's or a check constraint's name
(`<table>_<column>_fkey`, `_check`) is no relation and takes none.
PostgreSQL clips the names it gives a table's own objects to its bound, so
a table named in 59 to 63 bytes keys by `<table, clipped>_pkey`; a
duplicate key under that name is `JD2001`, as under any other (§7).

**Opening an existing database verifies, never alters.** If a declared
collection's table already exists it MUST match what the model would
create; any disagreement is `JD0002` naming the first difference.
Reshaping a live database requires an explicit migration;
`openStore` MUST NOT attempt it.

"Match" means every physical property that decides behaviour, not just
the names and types:

- structurally — column names, declared types and generated flags; index
  names, uniqueness, and covered columns **in their declared order**
  (`(a,b)` and `(b,a)` are different indexes: one serves an `a`-prefix
  lookup and the other does not);
- by DECLARED TEXT — the stored `CREATE` statement is compared against
  the planned one, which is where the properties no pragma reports live:
  `PRIMARY KEY`, `NOT NULL`, `DEFAULT`, `CHECK`, `STRICT`, a generated
  column's expression, an index's partial predicate, and each index
  term's collation and direction. A table that lost its primary key, or
  whose `gx_a` now reads `$.b`, keeps every name and type it had;
- for entities, the whole foreign-key TUPLE — source and target column,
  `ON DELETE` and `ON UPDATE`. Comparing counts accepted
  `ON DELETE SET NULL` becoming `ON DELETE CASCADE`, which deletes
  different rows;
- an index the database has and the model does not declare is also
  drift: it changes deletion semantics and the plans the optimizer picks.

Managed named-column comparison explicitly permits safe column reordering:
SQLite's `ALTER TABLE … ADD COLUMN` appends, and these consumers address
columns by name. The comparison retains constraint order, keeps columns with
inline defaults or other order-sensitive clauses in their order relative to
each other, and stays strict for unfamiliar forms. Complete reviewed
physical targets and direct `schemaShapeOf`/`comparableDeclaredSql` calls
preserve physical column order by default. Literal and quoted-identifier
bytes always remain significant; whitespace inside them is never formatting.
See [the comparison policy](MIGRATION-FORMAT.md#12-drift).

### 3.1 Derived columns, and the capability branch

A derived column (§2.1) needs a function SQLite does not have, so its
mapping BRANCHES on what the driver declares. That is what the
capability table (§4) is for: a driver that cannot do a thing says so
rather than degrading silently.

| capability | value | mapping | drivers |
|---|---|---|---|
| `deterministicIndexableFunctions` | `true` | a **virtual generated column** whose expression calls a deterministic function the store registers at open — `jaren_geohash(<member>, <precision>)`, `jaren_bbox_w(<member>)`, … over `json(("doc" -> '<path>'))` | `node`, `wasm` |
| `deterministicIndexableFunctions` | `false` | a **stored column** the store writes on every insert, upsert and patch, computed in JavaScript from the same kernel call | `bun` |
| `rtree` | `false` | a `derive: 'bbox'` column set that declared `physical: 'rtree'` (§2.1) is planned, created and verified as the **B-tree over its four columns**, and `explain().prefilters[].via` reports `'columns'` beside `store.capabilities.rtree === false` | any build without `ENABLE_RTREE` |

The two branches are independent: the `physical` mapping composes with
either derived-column mapping, and the sync triggers read the derived
columns either way, so their text is identical on both.

**The vector column does not branch.** A `derive: 'vector'` column is
the stored `BLOB` column under BOTH rows of the table — the store
writes it on every insert, upsert and patch, on every driver, computed
in JavaScript through the same seam a migration backfill uses — and
**no function is ever registered for it**. That is a deliberate
divergence from the spatial kinds, for three measured reasons:

- a virtual generated column is a host-function call per row, measured
  at 150× against a stored read in the spatial work — and a vector's
  call would re-derive a whole array per row, not a scalar;
- a stored column is readable without any registration, so a plain
  `SELECT`, a backup and a foreign tool can never hit `unknown
  function` over it, which the first consequence below shows a virtual
  column can;
- `bun` has no function API at all, so one mapping is the only way
  every driver stores, verifies and reads the same column.

Two things follow that are NOT true of a spatial column: a database
created under `node` opens under `bun` with no drift on the vector
column's account (the same declared text on both), and the migration
planner emits the backfill step for it under either `derived` setting
(MIGRATION-FORMAT §2.1).

Three consequences, each normative:

- **The registered function MUST be deterministic** in the strong
  sense: the same document bytes give the same cell, forever. It reads
  the member and never the clock, a random source or store state. That
  is not a style rule. An INDEX over a registered function makes the
  table unreadable from a connection that has not registered an
  identical function — not merely wrong, unreadable: a bare `SELECT`
  fails with `unknown function`. That hazard is exactly why the mapping
  is capability-gated rather than always-on, and why the store, the
  migration runner and the shadow database each register these
  functions before any statement over such a table.
- **A derived value is a function of the STORED document.** JSON has no
  `NaN` and no `Infinity`, so the write path computes from the member
  as it will be held rather than from the object handed in. Without
  that the two mappings would answer differently for one document.
- **The same model document produces two different physical shapes**
  for a spatial column, and *match* is by declared text (above). A
  database created under `node` and opened under `bun` therefore
  reports `JD0002` naming the derived column — correctly: the column
  really is different. The physical mapping is a property of the driver
  that CREATED the file, and moving a file between the two is a
  migration, not an open.
- **The R\*Tree fallback is a REPORT, not a degradation.** §4 promises
  that a model declaring a spatial index is portable across all three
  drivers and that the physical shape it produces is not, so refusing at
  open on a build without the module would break a stated property of
  the format for the sake of tidiness. The answers do not change — the
  refinement is what makes them identical — and the surface a consumer
  reads says which shape ran. A store that reported `via: 'rtree'` while
  running columns, or that said nothing at all, is the one behaviour
  this format forbids.

### 3.2 When a derived column is `NULL`

A derived column is SQL `NULL` when the document has no member at the
index path, and when the member has no bounded position — a value with
no positions at all, or one whose coordinates are not positions, which
is what a non-finite coordinate becomes: JSON cannot carry `NaN`, so it
arrives as `null` and is no longer a number.

A string also has no position: an untyped member can store WKT or even the
string `"[1,2]"` without interpreting it as a coordinate array. Virtual and
stored columns both derive `NULL`. Existing SQLite expressions that passed raw
SQL strings to `json()` need the explicit column repair described in
[MIGRATION-FORMAT §3](MIGRATION-FORMAT.md#repairing-a-legacy-spatial-member-expression).

The consequence is stated here rather than discovered later: **a row
whose derived column is `NULL` is not found by ordinary predicates pushed to
that column.** Neighbourhood membership retains those rows as candidates and
re-runs its predicate: `$index-of` raises for an empty search item, so discarding
the row would hide that error. Guard the geohash with `$exists` before the
membership test when unbounded rows should be excluded. For the other spatial predicates the planner promotes
(ARCHITECTURE.md, "The implied conjunct") that is not a divergence —
§8.14 measures a value by its representative position, and that
position is missing in exactly the cases the box is, so `$within`,
`$bbox-intersects` and `$distance` answer `false`/empty for such a row
anyway. Where it does bite is the ERROR behaviour: §8.14 raises
`JQ2001` for an operand that is not geography at all (a string, a
stored `null`), and a row the pushed filter never fetched cannot
raise. The promotion therefore requires the schema to type the member
as an array or an object and nothing else; a store that wants the
engine's refusal instead keeps `compileSchema` injected.

**The same rule, for an interval.** `$overlaps` (§8.16) promotes over a
member the schema types as an object whose `start` and `end` are both
REQUIRED and both numeric — and only numeric, since an RFC 3339 bound
is a good instant to the engine and no epoch column compares against
it. Both bounds must map to declared columns; an unmapped pair pushes
nothing and `strict: true` names it (`JD0010`). What the pushed
comparison may assume of a stored span is the model's to say:

- Under a **declared interval** (`intervals`, §2) every stored span is
  a half-open one of two safe integers, or the member is absent. The
  store refuses a `null`, scalar or array span, a half span, a `null`,
  boolean, textual, fractional or out-of-range bound, an empty or
  reversed span and one longer than `maxDuration` before the statement
  (`JD2003`), with or without the validation hook, and the table's CHECK
  `<name>_interval` refuses the same shapes from every other writer —
  on SQLite by `json_type` over the document (`IS 'integer'`, since a
  half span's absent bound compares as NULL and a CHECK passes a NULL
  comparison, and since the INTEGER column reads a JSON boolean as 1;
  a textual bound that spells no integer, or a fractional one, meets
  STRICT's type refusal first, errcode 3091, while a text that spells an
  integer is coerced into the column and the CHECK refuses it, as it
  refuses every other shape, errcode 275), on PostgreSQL by
  `jsonb_typeof` and the generated numeric columns (`IS NOT NULL`,
  equal to their own `trunc`; SQLSTATE 23514), both within the safe
  integers. So the pushed conjunction is the operator itself — exact, no
  residual, no document read per row, and a fetch the bound's index
  seeks. With `maxDuration` the fetch is a two-sided seek: a span no
  longer than it that reaches past the probe's start began after `from -
  maxDuration`, so the plan binds that as a lower bound on the start
  column beside the probe's end — `start > from - maxDuration AND start <
  to AND end > from` — and the plan carries both bounds whatever the
  window; reading the index between them is the engine's choice, SQLite's
  at every window and PostgreSQL's where its statistics favour the index
  over a scan (a fractional probe start is floored first, so the
  subtraction stays exact and bounds no less); a probe whose lower bound
  would fall below the least safe integer, which every stored start
  already satisfies, plans without it.
- Undeclared, the schema alone cannot forbid an inverted span (no
  keyword compares two members), so the statement keeps every row whose
  own span is empty or reversed and the operator raises over them,
  exactly as it would have — a comparison between two columns, which no
  index bounds, so the fetch scans. A store without the hook also holds
  a `null`, scalar or half span, whose bound column is NULL: the pushed
  form's guard drops such a row where the engine would have raised, and
  the declaration is what closes that.

Under `physical: 'rtree'` the same rule is enforced in SQL, by the
`WHEN <stem>_w IS NOT NULL` guard on the sync triggers: **a document
with no bounded position is ABSENT from the virtual table**, so the
pushed subquery simply does not list it — the same answer the column
mapping's leading `IS NOT NULL` produces. The guard is load-bearing and
not defensive: an R\*Tree coerces a `NULL` (or a text) coordinate to
`0.0` without complaining, so without it every unbounded document would
be indexed at `[0, 0]`.

Traversal and validity stay separate concerns, as they do in the
kernel: a value that carries SOME positions is bounded by the positions
it has. A `LineString` whose second vertex did not survive as a
position is bounded by its first — a document the GeoJSON meta-schema
refuses in the first place — and both mappings agree about it.

**A `vector` column is `NULL` when the member is not a vector of
exactly `dims` finite numbers:**

| the stored member | column |
|---|---|
| absent | `NULL` |
| an array of another width (767 where `dims` is 768) | `NULL` |
| a component that is not finite — JSON has no `NaN`, so it arrives as `null` | `NULL` |
| not an array: a string, an object, a typed array (which JSON holds as an object), an array of arrays | `NULL` |
| the zero vector | **stored** — `4·dims` zero bytes; it has no direction and scores 0 against everything, which the query format publishes as a score, not a refusal |
| an array of `dims` finite numbers | the packed, l2-normalized form |

The document itself stores in every row of that table; the write is
never refused on the column's account (§2.1). The consequence for the
k-nearest plan (ARCHITECTURE.md, "The k-nearest plan") is stated here:
**a row whose vector column is `NULL` scores nothing, so it is never
among the rows the column's cut keeps** — unrankable, not wrong. That
agrees with the engine on every row of the table above but one:
`$similarity` over an absent, wrong-width or non-finite member answers
the empty sequence (QUERY-FORMAT §8.15), and under `$empty: 'least'`
such a row sorts LAST, where only a window wider than the scored rows
reaches it — and there the plan fetches every row and the engine orders
the tail itself. The one row that differs is the non-array member (a
string, an object): §8.15 raises `JQ2001` for it where the column holds
`NULL`, so a window that never reaches the tail never raises for it and
one that does raises as the engine would. That is why rule 9 (§2.1)
makes the column exist only over a member the schema types `array` and
nothing else; a store that wants the refusal for every row keeps
`compileSchema` injected. What the column cannot do is refuse a
wrong-width vector at the write — that is the schema's job, and §2.1
shows the declaration.

## 4. The driver contract and the synchronous fast path

A driver is `{ name, dialect, open(path, options) }`; `open` returns a
`Connection` or a promise of one:

```
Connection = {
  synchronous,                 // boolean
  capabilities,                // read once at open — see below
  exec(sql), prepare(sql), transaction(fn), close(),
  registerFunction(name, options, fn) | null,
  registerAggregate(name, spec) | null,
  session(table) | null
}
Statement = { run(params), get(params), all(params), iterate(params), finalize?() }
```

Every method MAY return a value or a promise; the store never assumes
either. Parameters bind positionally as arrays. `finalize` is optional:
a binding that keeps prepared statements beyond their last reference (a
worker, up to its `maxStatements`) releases one there. The store calls
it after the final use of an evicted statement, or after a temporary
EXPLAIN or scan-guard probe settles. Pending preparation and reads retain
their borrow; cleanup does not replace the operation's answer or error.

**Capabilities** are read once at open — from the library's version
report, its compile options, and the binding's declaration — and are
the single source of truth for feature gating. The table covers at
least: `version`, `jsonb`, `generatedColumns`, `returning`, `upsert`,
`savepoints`, `rtree`, `fts`, `sessions`, `userFunctions`,
`deterministicIndexableFunctions`, `alterTableFull`, plus two slots
that are **empty (`false`) on every SQLite driver**:
`statementTimeout` and `rowEstimates`. SQLite exposes no interrupt, no
progress handler and no row-estimate API; a driver that cannot do a
thing MUST say so here rather than degrade silently. The slots exist
so a driver that has the facts can fill them without a contract
change: the PostgreSQL driver fills `rowEstimates`, because its planner
answers a row estimate for a statement (§8).

On the Bun binding, `userFunctions`,
`deterministicIndexableFunctions` and `sessions` are `false` by
construction: `bun:sqlite` exposes no `function`, no `aggregate` and
no `createSession`. `deterministicIndexableFunctions` is the capability
the derived-column mapping branches on (§3.1), so a model that declares
a spatial index is portable across all three drivers and the physical
shape it produces is not.

Closing a Bun connection finalizes its live prepared statements before
closing the database, so releasing a file does not wait for garbage
collection. Statement tracking uses weak references and does not retain
past queries for the connection's lifetime.

`rtree` is read from the library's compile options (`ENABLE_RTREE`) and
is the second mapping branch: a `derive: 'bbox'` index that declares
`physical: 'rtree'` (§2.1) opens on a build without the module as the
B-tree over its four columns, and `explain().prefilters[].via` names
the shape that actually ran. That is this table's posture applied to a
mapping rather than to a method — the store says which shape it used,
and never claims one it did not.

A library below SQLite **3.45** fails at open with `JD0001` naming
the version found.

**The public store API is asynchronous.** Every store and collection
method returns a promise, because a browser store over OPFS is
asynchronous no matter what backend sits behind it. Where — and only
where — `connection.synchronous` is `true`, the store also carries
`store.sync`:

```js
store.sync.collection('users').get(key)   // the same read, no promise
store.sync.transaction(fn)
```

`store.sync` is **absent** on an asynchronous driver — not a set of
throwing stubs — so feature-testing it is honest. The asynchronous
surface allocates exactly one promise per call (the internal
composition is sync-capable and adds none); the measured difference is
the price of portability, published with the benchmarks rather than
waved away.

**Connection configuration is a closed, validated set, read back
after it is applied.** `openStore` configures exactly eight
connection pragmas, each by its own option: `busyTimeout` (ms,
default **5000**), `journalMode` (`delete` | `truncate` | `persist` |
`memory` | `wal` | `off`, default **`wal`** on a writable file),
`synchronous` (`off` | `normal` | `full` | `extra`), `walAutocheckpoint`
(pages, `0` disables), `journalSizeLimit` (bytes, `-1` for none),
`cacheSize` (pages, or negative KiB), `mmapSize` (bytes) and
`tempStore` (`default` | `file` | `memory`). An option naming any
other pragma is refused `JD0006` — `foreign_keys` among them, which the
model requires ON and verifies per connection — and a value outside a
pragma's set is API misuse. A driver's capability table declares the
pragmas its binding applies (`configurablePragmas`); a request outside
that declaration is `JD0007`, as is an explicit `journalMode` on a
read-only store, whose journal-mode write the engine refuses. After the
open sequence every declared pragma is read back and the read values
are what `store.capabilities.pragmas` carries; a requested value the
engine did not take is `JD0008` and the store does not open. A
`:memory:` database keeps journal mode `memory` whatever is asked and
answers nothing for `mmap_size`, so those two are not written there and
the report says what the engine answers (`'memory'`, `null`).
`store.capabilities.busyTimeoutMs` and `store.capabilities.journalMode`
are the same two read-back values under their long-published names.

**A SQLite file's text encoding is checked at open.** Every native text
comparison, order and page assumes SQLite's `BINARY` collation is code point
order, which only a UTF-8 file makes true: a UTF-16 file compares the bytes of
its UTF-16 text. Opening a store over a file or database whose `PRAGMA encoding`
is not UTF-8 (`UTF-16le`, `UTF-16be`) is refused `JD0002` naming it, as a plain,
an adopted and a read-only store alike, and the connection the open acquired is
closed. A build compiled without UTF-16 answers that pragma with no row and
reads only UTF-8, so it is a UTF-8 database here. PostgreSQL orders text under
the collation the dialect spells (§10.5), so it has no such check.

**The store's OWN options are a closed set too.** `driver`, `path`,
`readOnly`, `queueTimeout`, `compileSchema`, `capture`, `replication`,
`jobs`, `live`, `adopt`, `transactions`, `expressions`, `operators`,
`functions`, `extensions`, `profile`, `statementCacheBound`,
`zoneProvider`, `runtime`, `holdTimeoutMs`, `isolation`, `owner`,
`reads` and `sessions`, beside the pragmas above — anything else
is `JD0009`, named and with the nearest option suggested, before the
driver opens. A misspelt option is otherwise dropped in silence, and
`{ captur: true }` opened a store with no capture at all, which the
host discovers in production rather than at the call.

**So are their values**, checked at the same moment — before the driver
opens, so a refusal creates no file and holds no handle. `queueTimeout`
is a whole number of milliseconds from 0 to 2147483647 (the timer's
range: `Infinity` used to become a 1 ms wait); `readOnly` and `adopt`
are `true` or `false`; `capture` and `jobs` are `true`, `false` or their
options object (`'false'`, `0` and `''` used to switch the feature ON,
and `jobs: null` threw a raw `TypeError`); `live` and `replication` are
their options object; `transactions` is `'wait'` or `'strict'`; `reads`
is `'serialized'` or `'parallel'` (§5.1); `sessions` is a whole number from
1, at most the driver's `maxConnections`, on a PostgreSQL driver and
without `replication` (§5.1). Each is `JD0009` naming the option and what
it holds.

The nested `capture`, `capture.log`, `jobs`, `live` and `replication`
objects also refuse unknown members before opening. Capture mode is `auto`,
`session` or `journal`; cache and live bounds are positive safe integers.
Compiler registries and the zone provider are checked by the query compiler's
own grammar at this boundary. Replication identity and its bounds are checked
before acquisition too, preserving their existing refusal codes.

`statementCacheBound` defaults to 128 and counts retained semantic query
plans; it also bounds the separate relational SQL cache (§5.3). Evicting a
plan retires its main and auxiliary statements after their active reads
settle. A lazy materializing cursor remains usable after eviction and
releases any statements it prepares for that retired plan. A valid document
that cannot be cached uses temporary statements. Streaming cursors continue
to own their own statements, independently of the plan cache.

This setting is not a physical statement limit. A remote connection's
`maxStatements` must also accommodate fixed schema/CRUD statements, each
plan's auxiliary reads, the finite KNN identity-fetch cache, each entity's
up to 64 cached native mutation statements (an evicted one is released once
its use settles), active cursors and reads still finishing after eviction.
Set the plan bound with this working capacity in mind. Repeated
explanations and full-scan refusals release their temporary EXPLAIN
statements; a refused scan remains `JD0011`.
Counter polling, membership writes and journal reads, and replication's internal
SQL also release their per-operation statements. A bounded read keeps its statement
until its cursor has drained or been returned, including on a refused row or byte
bound. Failed cursor admission releases an unowned ephemeral preparation without
retiring a retained statement or an existing cursor's handle.

Shipped drivers declare whether they can supply shared readers before opening.
An injected driver's optional `supportsSharedReads` is either a boolean or a
`(path, options) => boolean | undefined` hint: false refuses a parallel-read
request before acquisition; true and undefined still require the opened
connection to prove its actual readers.

Opening retries classified busy failures of its idempotent initialization
sequence, yielding between attempts so a competing opener can finish. The
configured `busyTimeout` bounds admission of retries, with at most 32 total
attempts; zero admits only the first attempt. This elapsed-time window is
independent of the injected logical clock. It does not interrupt an admitted
native statement, which retains its own busy timeout. Exhaustion closes the
acquired connection and rejects `JD0002` with the original busy cause. This
startup policy does not replay ordinary application writes.

**Maintenance is a typed operation, never raw SQL.** Four store members
run what an operator runs on a production database, each under the
store gate (so none interleaves an in-flight write) and each answering
the engine's own row as typed data: `checkpoint({ mode })` runs
`PRAGMA wal_checkpoint` (`passive` | `full` | `restart` | `truncate`,
default `passive`) and answers `{ busy, logFrames, checkpointedFrames }`
— the engine's numbers, `-1` on a database that is not in WAL mode; a
second passive checkpoint reports the same counts as the first (the
frames stay in the log until a writer restarts it) and a second
`truncate` reports zeros. `integrityCheck({ limit })` answers
`{ ok, problems }`, the engine's rows verbatim — corruption is the
result, never a throw. `foreignKeyCheck()` answers
`{ ok, violations: [{ table, rowId, parent, fkid }] }`. `optimize()`
answers `{ ran: true }`, because `PRAGMA optimize` reports nothing and
this store invents no statistics. `store.capabilities.maintenance`
carries one boolean per operation: `false` where the driver's binding
does not declare it and, for `checkpoint` and `optimize`, on a
read-only store (the engine would answer a checkpoint there with a
silent no-op) — and a call is refused `JD2077` exactly where the report
says `false`. A driver failure inside an operation is `JD2078` with
the original as `cause`. None of them touches the change log's durable
watermark (LIVE-FORMAT §5).

**A backup is published whole or not at all.** `backupTo(targetPath,
{ rate, onProgress, signal, deadline, checkpoint })` copies a live
store page by page through SQLite's online backup and answers
`{ path, pages, checkpoint }`. The copy is written to a temporary
sibling of the target (`<target>.jaren-tmp-<suffix>`, in the same
directory so the rename is one file system's) and renamed onto the
target only once the platform reported the copy complete; a
cancellation, a copy failure (a full disk included), a rename failure,
or a store closed during the copy (`JD2063`, at publication: the copy
itself runs to its end) removes the temporary file with every side file
the copy left (`-journal`, `-wal`, `-shm`) and leaves the target
untouched. The rename is refused (`JD2078`, nothing
deleted) while a side file of the target would be replayed into the
published file, which would then open as the database that file belongs
to: a `-wal` that holds frames (anything past its 32-byte header) or a
hot `-journal` (one that begins with the journal magic). Such a file
belongs to an open database or to one whose writer did not finish —
`backupTo` must never target a database another connection has open,
and such a file is removed only by whoever has confirmed that no
process has that database open. An empty or header-only `-wal` and a
`-journal` whose header a clean commit zeroed (journal mode `persist`)
are never replayed and do not block publication. A target that is a
symbolic link is replaced by the published file, as any rename does; a
target path that begins `file:`, is `:memory:` or holds a NUL byte is
refused (`TypeError`) before any file is written, because SQLite would
read it as a URI, a memory database or a shorter name. A target that
collides with the store's own database — the file itself or one of its
side files, by any spelling or link, or a path one of whose own side
files would be one of those — is refused `JD2078` at publication: the
copy is discarded and none of the store's files changes (the binding
compares files by device and inode, and names that may not exist yet by
directory and name). The options are a closed set: an unknown member, a
`signal` that is not an `AbortSignal`, a `rate` outside 1 to
2,147,483,647, a `deadline` that is not a finite number and a
`checkpoint` that is neither `false` nor one of `passive`, `full`,
`restart`, `truncate` are a `TypeError` coded `JD0013`, naming the
member, before the backup waits for anything. A `checkpoint` mode
(default `passive`; `false` skips it, and a read-only store skips it by
default) fixes the snapshot boundary first, under the store gate. The
default one is advisory, since the copy reads committed log frames either
way: when the connection cannot checkpoint now (a statement in progress
on it, such as an open cursor, or another connection's lock) it is
skipped and `checkpoint` answers `null`; a mode the caller names still
fails the backup (`JD2078`). Each file operation resolves a relative
target against the working directory of its moment, so a host that
changes it during a backup may leave the temporary file behind; a
process killed mid-backup leaves it too (with its `-journal`), for the
host to remove — the target itself is never partial.

Where the copy runs is the binding's. The Node binding copies on the
store's own connection, on the platform's thread pool: the copy starts
under the store gate — so its first step never meets a write the
store's own transaction holds — and leaves it at the first progress
event; writers then proceed, the store's writes during the copy are
carried into it, and the copy is the store as it stood at completion.
Another connection's commit restarts that copy, so a source written more
often than one copy takes may never finish: pass a `deadline`.
The Bun binding copies on a dedicated read-only `node:sqlite` connection
to the same file (Bun ships it on the same SQLite library), inside one
read transaction, and holds the store gate for the whole copy: the
store's calls wait, and the copy is the store as it stood when the copy
began. Another connection's writes meet that read transaction too:
under a rollback journal they wait for the whole copy and fail once
their busy timeout passes; under WAL they proceed, but no checkpoint
passes the copy's snapshot until it ends. The dedicated connection opens
the file SQLite reports for the database: a path renamed or replaced
under an open Bun store copies what that path holds now, or fails.
Bun's platform runs every step before it returns, so that connection and
its copy run in a worker: the calling thread runs timers, I/O and other
work while it copies, and each step's event reaches `onProgress` there. Both page copies are page-identical to the source: free
pages are kept, and only page 1's change counter (bytes 24–27), schema
cookie (bytes 40–43: SQLite's backup gives every new copy the cookie 1)
and version-valid-for number (bytes 92–95) may differ — except that under a
rollback journal the Node copy may carry the store connection's own
image of a free page, whose bytes then differ from the file's (the
database it holds is the same). A page copy of a WAL database is itself
a WAL-mode file: opening it, even read-only, creates `-wal` and `-shm`
beside it, so a copy bound for read-only media first takes
`PRAGMA journal_mode=DELETE`. A Bun database without a file (memory,
temporary), a Bun runtime without `node:sqlite`, and a `bun:sqlite` on
another SQLite library than `node:sqlite`'s copy with one `VACUUM INTO`
statement instead: one step, no event, free pages dropped — and refused
by SQLite (`JD2078`) while a statement is in progress on the store's
connection, such as an open cursor. The two libraries are compared
before `node:sqlite` opens the file.

`onProgress` receives `{ totalPages, remainingPages }` after a step
that leaves pages to copy (so `remainingPages >= 1`) — never after the
final step, never synthesized — and an event equal to the last one
delivered is not delivered again: a step that meets a busy source is
reported again by the platform with the same pair, and the cancellation
check still runs on every such report. A restart caused by another
connection's write may raise `remainingPages`. Completion is the
resolved `{ path, pages, checkpoint }`; a copy of one step (a source of
at most `rate` pages, or the `VACUUM INTO` copy) reports no event, and
a throw inside `onProgress` fails the backup `JD2078` with the throw as
`cause`. The capability is `store.capabilities.maintenance.backup` —
the Node and Bun drivers'; every other binding reports `false` and
refuses `JD2077`. What is NOT decided here: where backups go, how they
are named, encrypted, rotated or retained — the host's policy.

**Cancellation is honoured where the driver can honour it, and the
report says where.** Every operation that runs more than one unit of
work takes `{ signal, deadline }` and checks them BETWEEN units, on the
clock the store's runtime record supplies — never inside a statement,
because no shipped SQLite binding exposes an interrupt.
`store.capabilities.cancellation` states the granularity per
lifecycle: `query: 'row'` (a call before it runs, a cursor or page at
every row boundary — `JD2072`), `queue: true` (a call still waiting for
the open transaction leaves the queue — `JD2064`), `migration: 'step'`
(between migrations, between steps and between the batches of a data
step — `JD2080`; the migration in flight rolls back whole), `maintenance:
'statement'` (before the one statement each operation issues —
`JD2081`), `backup: 'page'` (between the pages the platform reports —
`JD2079`, also while the backup still waits for the store gate; on
Bun, whose copy runs in a worker, an abort raised anywhere — inside
`onProgress`, by a microtask, a timer or an I/O callback — stops it at
the worker's next step, or before publication once its last page is
copied — and a
one-step copy is checked before and after), and `midStatement:
false` — a filled slot, not an absent
one; a driver that grows an interrupt flips exactly that member. A
passed deadline is `JD2075` in every lifecycle. A cursor's own report
is part of the same honesty: `capabilities.lazyIteration` is probed at
open, and on a binding whose statements carry no lazy iterator (the
driver composes `iterate` over `all()`) every cursor reports
`streaming: 'buffered'` with a `{ construct: 'driver' }` barrier,
`explain()` says the same, and `strictStreaming` refuses (`JD0037`) —
never a row stream the driver cannot deliver.

The runtime builtin behind a binding is imported lazily inside
`open()` — never at module scope — so every driver subpath loads under
every runtime; on a runtime without the builtin, `open` fails with
`JD0003`. The root `@jarenjs/db` subpath never references a runtime
builtin at all.

## 5. Writes and transactions

```js
const store = await openStore(model, { driver, compileSchema });
const users = store.collection('users');

await users.insert(doc);            // JD2001 when the key exists
await users.put(doc);               // upsert
await users.patch(key, jsonPatch);  // RFC 6902, read and written in one transaction
await users.delete(key);            // resolves false when nothing was stored
await users.get(key);               // resolves undefined when absent
await users.all();                  // every document, always an array
await users.put(doc, undefined, { expect: { path: '/revision', value: 3 } });  // JD2040 unless it holds
await store.transaction(fn);        // savepoint-nested, returns fn's value
```

**Writes validate through the injected hook.** `compileSchema` has the
`compileTypeTest` signature: it takes a collection's schema and
returns a validation function; the function returns `true`/`false` or
`{ valid, errors }`. A rejected write is `JD2003` carrying the hook's
`errors` when it produced any. Without a hook, writes are unvalidated
and `store.capabilities.validated === false` — a declared downgrade.
The cost of running without one: the database constraints only see the
key and the indexed members; everything else is stored as given.
Stated more sharply, because it changes ANSWERS and not only what is
stored: a typed generated column carries SQLite affinity, so a value
that violates the collection schema — the string `'020'` under an
`integer` path — reads as the integer `20` in the column while the
document still holds text, and a pushed `$eq: ['$it.n', '20']` finds
a row the engine, which compares the JSON value, does not. On an
unvalidated store the native and residual paths agree only over
documents that conform to the schema; with the hook injected no other
document is ever stored.
`@jarenjs/db` never runs a validator of its own; what it imports from
`@jarenjs/validate` is only the pure same-document `$ref`/`$anchor`
resolution in `@jarenjs/validate/normalize`, for model compilation.

**`patch` is a read-modify-write in one write transaction.** The stored
document is read inside the write's own transaction — at the root a
transaction of its own (SQLite's `BEGIN IMMEDIATE`, where writers
serialize; on PostgreSQL a plain one whose read locks the row `FOR
UPDATE`, never the store's writer lock of §5.1), a savepoint inside a
caller's transaction. The patch is applied to that document with the
copy-on-write engine, and the RESULT is validated (`JD2003`) before it
is written, so the document validated is the document written, and a
leading `test` is a true compare-and-set: two stores racing
`[{ op: 'test', path: '/revision', value: r }, { op: 'replace', path:
'/revision', value: r + 1 }, …]` commit one patch and refuse the other
(`JP2004`), where both used to succeed and one wrote over the other. A
patch whose result equals the stored document writes nothing — no
statement, no change for capture, no commit another connection sees. An
operation's `value` counts as the JSON it is written as — an undefined
member is no member, a Date its ISO text — so a patch that sets a value
the document already holds in that form is such a patch. The
operations are then translated to the dialect's JSON-set primitives so a
one-field update does not rewrite a large document. Translatable in
0.1: `replace`, `add` of an object member, `add` at an array's end,
and `remove`. Anything else — `test`, `move`, `copy`, a mid-array
insert — falls back to a whole-document write. The fallback is
**counted and exposed** at `collection.stats()`
(`{ patchTranslated, patchFallback }`), measured rather than assumed.
A malformed patch document raises the json family's own coded errors
unchanged; a patch value JSON cannot serialize (such as a bigint or a cycle)
is `JD2003` before the write; `patch` on an absent key is `JD2006`.

**`expect` makes a keyed write conditional.** `put(doc, key?, { expect
})`, `patch(key, ops, { expect })` and `delete(key, { expect })` take a
precondition `{ path, value }` — `path` a JSON Pointer, `value` the JSON
value the stored document holds there, compared structurally as the JSON
it is written as (an undefined member is no member, a Date its ISO text,
`NaN` is `null`; a bigint or a function, which no document holds, is
`JD0013`) — or a non-empty list of them. It is judged against the stored document inside
the write's own transaction, the same one a patch reads in; a document
that does not hold it, or nothing stored, refuses the write **`JD2040`**
and writes nothing (`patch` of an absent key stays `JD2006`). Without
`expect`, `put` and `delete` remain one statement each. A write's
options are a closed set (`JD0013`): `insert` reads none, and an unknown
member, a path that is not a JSON Pointer or a missing `value` is
refused before any statement — on a capturing store too, before its
capture transaction begins.

**`all()` reads every document.** `collection.all(options?)` answers
every stored document as an array, one entry per document, in the order
`execute('$[*]')` visits them — on the synchronous twin and inside a
transaction alike; it reads the cursor's `externals` (which bind the store
profile's predicate, §8), `signal`, `deadline`, `profile` and
`strictStreaming`, nothing else (`JD0013`), and a `signal` that aborts
while the call waits in the store's queue takes it off the queue
(`JD2064`), as it does for `execute`, `explain`, `load` and `page`. `execute('$[*]')`
answers the engine's SEQUENCE instead: `undefined` for an empty
collection, the bare document for one, and for one array-valued
document exactly what two documents would give. `query('$[*]')` is the
same items as a cursor, one per pull.

**`transaction(fn)` nests via savepoints.** `fn` receives the store
and may itself call `transaction`; each level is one savepoint. A
throw rolls back exactly its own level and rethrows — an outer
transaction that catches the error continues and its own work
commits. Retry is explicit only (`retry`, §5.1) — nothing retries by
itself.
If `COMMIT` or `RELEASE` itself fails, for example on a deferred foreign
key constraint, that level rolls back before another caller acquires
the connection. A rollback failure accompanies the original failure in
an `AggregateError`, retaining the primary failure's code, class and
driver cause when the store classifies it.

**On an asynchronous driver a refused write rejects.** Every write —
`insert`, `put`, `patch`, `delete`, the entity set's `create`/`update`/
`delete` and the queue's `enqueue` — answers its coded error (`JD2001`,
`JD2003`, `JD2005`, …) through the promise it returned: never a
synchronous throw, and never an unhandled rejection beside a result
that looks like success.

### 5.1 Transaction ownership

A SQLite connection holds ONE savepoint stack, so two transactions that
overlap in time on one connection cannot both be correct: `RELEASE`
discards everything opened after its target, so whichever finished first
would take the other's savepoint with it, and the second would then fail
with *no such savepoint* over rows it had already committed. Unique
savepoint names do not help — the stack is a stack.

So a **top-level transaction owns its connection until it settles**, and
an overlapping one waits its turn. Two concurrent request handlers
sharing a store both commit, and both report success.

**On PostgreSQL a store can run on several sessions.** `openStore(model,
{ sessions: N })` — `@jarenjs/db/postgres` only, from 1 to the driver's
`maxConnections`, without replication; anything else is `JD0009` before
anything opens — holds N sessions, each a connection with its own
savepoint stack. A root call or a root transaction checks out a free
session for its extent, first come first served under `queueTimeout`
(`JD0012`; `transactions: 'strict'` refuses when none is free), so
independent transactions overlap in time and the database settles what
they do to each other: a serialization failure or a deadlock is a busy,
retryable refusal that `retry` absorbs, and `mode: 'immediate'`
transactions take the writer lock in turn. A call made inside a
transaction's synchronous extent stays on its session, as on one — except
a call on the store's own unit of work (below), which runs on the first
session and so never joins a transaction on another one: inside a body,
use `tx.entity` and `tx.saveChanges`. A
transaction's handle used from another transaction's flow is `JD2070`, and
a hold limit rolls back its own transaction only. Every transaction has a
unit of work of its own (as `unitOfWork: 'own'`), and its trusted SQL
invalidates only that one. The store's own unit of work — root entity
handles, tracked reads, `saveChanges`, root relational writes — is served
on the first session, one call at a time; ordinary calls leave that
session free while another one is. A paused root cursor holds one
session, never the store. Capture's journal belongs to each transaction,
and its allocation lock orders them: on a store with capture every
transaction (a root write included, and one that only reads) takes it when
it begins, so transactions run one at a time and only root reads gain the
concurrency; jobs and live queries need nothing more. `capabilities.connections` reports N, and the
default — one session — is everything above, unchanged.

**The store the callback receives is the transaction.** `tx.collection`,
`tx.entity`, `tx.sync`, `tx.jobs` and `tx.saveChanges()` run as the
transaction's owner, and `tx.transaction()` nests through its savepoint:

```js
await store.transaction(async (tx) => {
  await tx.collection('docs').put(doc, 'a');     // inside this transaction
  await tx.transaction(async (inner) => {
    await inner.collection('docs').put(other, 'b');  // nested savepoint
  });
});
```

**A root transaction may take the store's writer lock up front.**
`store.transaction(fn, { mode: 'immediate' })` takes the store's single
writer lock before the body runs: on SQLite it begins with `BEGIN
IMMEDIATE` instead of a deferred savepoint; on PostgreSQL it runs `BEGIN`
and then a transaction-scoped advisory lock of the store's own class,
keyed by its schema ([POSTGRESQL.md](POSTGRESQL.md#the-writer-lock-and-the-lock-family)
lists the family). The guarantee is the same on both: a read-then-write
body sees every earlier immediate commit and cannot lose an update to
another immediate transaction, and `capabilities.immediateTransactions`
is `true`. On SQLite a body that reads before it writes — a ledger claim:
read the record, decide, insert — otherwise meets the read→write upgrade
`SQLITE_BUSY` when another connection commits between its read and its
write, the one busy the busy handler cannot retry; with the lock taken
first that wait is an ordinary busy wait the `busyTimeout` covers, and
two processes claiming one key see one `new`. On PostgreSQL two immediate
bodies on two stores run one after the other. At `read committed` (the
server default) the second reads the first one's commit: two concurrent
read-then-write increments of `n = 0` leave `2`, with no retry. At
`repeatable read` and `serializable` the second body's snapshot is taken
by the lock statement itself, before the wait, so the same conflict
surfaces as 40001 — busy and retryable, which `retry` absorbs. There the
lock orders immediate transactions among themselves only: a plain
collection write or a deferred transaction takes row locks and never
waits for it, so no plain write serializes every writer. A lock wait is
bounded by the session's lock timeout (55P03: busy, retryable) and is not
counted against `holdTimeoutMs`. The default `'deferred'` is unchanged,
`tx.transaction()` inside either mode is a savepoint, `signal` and
`unitOfWork` behave the same; the synchronous twin reads the same options
(`unitOfWork: 'own'` gives its body a tracker of its own, as the
asynchronous root's does) and refuses thenable callbacks. On SQLite the
open path already brackets every first-open object — collection, entity
and join tables, indexes, the change log and its state row, the job
tables — the same way (§2.4).

**`isolation` is a floor.** `openStore(model, { isolation })` sets the
default of every `store.transaction` and `store.sync.transaction`, and a
call's own `isolation` overrides it: `'read committed'`, `'repeatable
read'` or `'serializable'`, weakest first. The backend runs the level
asked for or a stronger one and reports the level it ran as
`tx.isolation` (also on `tx.sync` and the typed client);
`capabilities.isolation` lists the levels it can run. PostgreSQL runs all
three. Nothing asked keeps a plain `BEGIN` and the session's own
`default_transaction_isolation`, read at open
(`capabilities.postgres.defaultIsolation`); a level asked is spelled into
the `BEGIN` — or the session's default instead, where an operator raised
it above the floor. SQLite runs every transaction serializably (one
writer at a time, and a reader that would write after another writer
committed is refused busy), so it accepts any floor and reports
`serializable`. Under `serializable` two concurrent read-then-write
transactions produce one commit and one busy, retryable refusal
(`JD2005`, 40001); with `retry` both commit. The store's own transactions
— a keyed write's convergence, a job claim, capture's journal — run at
the session's default. A nested transaction runs at its root's level and
refuses `isolation` (`JD0014`); a malformed level is `JD0013` on a
transaction and `JD0009` at open.

**A store can own its database.** `openStore(model, { owner: { id,
leaseMs } })` opens the store as its database's single writable owner: a
second store that asks for ownership while this one holds the lease is
refused `JD2061` by name — `owner` is the holder's id and `expiresAt` when
its lease ends — instead of writing beside it. On SQLite the lease is one
row of an engine table, renewed every third of `leaseMs` (default 30 s)
and deleted at `close()`, and a crashed holder's lease expires; on
PostgreSQL it is a session lock held for exactly the store's session. The
lease is cooperative (an open without `owner` neither takes nor checks
it), a read-only open never takes it (`owner` with `readOnly` is
`JD0009`), an adopted SQLite store needs the owner table (`JD0015`), and a
store whose lease another holder took refuses every later call. A call is
checked again once the store's gate admits it, so one that waited in the
queue past the lease's expiry refuses rather than write beside the next
owner, and a call after `close()` refuses `JD2063` however long after.
`capabilities.owner` says which mode is in force; [HOSTS.md](HOSTS.md#the-owner-lease)
has the constraint on `leaseMs`, the table statement and the platform
status.

**`retry` re-runs a transaction as a whole — explicitly, boundedly, and
only when that is safe.** `store.transaction(fn, { retry: { attempts,
baseMs?, maxMs? } })` — `attempts` 1–32 (1 is no retry), the backoff
between attempts full jitter from `baseMs` (default 5 ms) up to `maxMs`
(default 250 ms, or `baseMs` when that is larger), the store's
`runtime.random` drawing it. An attempt is
retried only after a failure that says it may be (`class: 'busy'`,
`retryable: true` — SQLite's busy and locked, PostgreSQL's 40001, 40P01,
55P03) whose commit outcome is known; never after a connection loss, a
lost worker generation, a failed rollback (`TransactionFailure`), a hold
expiry or the callback's own error. Each attempt is a complete top-level
transaction through the gate (FIFO, a fresh `queueTimeout`, the same
`signal`) on a **fresh unit of work of its own** — a failed attempt's
restored pending inserts would otherwise be saved beside the next
attempt's, which is how re-running a callback by hand used to insert
two rows; `unitOfWork: 'shared'` with `retry` is therefore `JD0014`. The
callback sees its attempt as `tx.attempt` (1-based; also on `tx.sync`
and the typed client). An abort during the backoff rejects with the
signal's reason and makes no further attempt. The error that ends a
retried transaction carries `attempts`.

**`holdTimeoutMs` bounds how long a body may hold the connection.** Per
store (`openStore(model, { holdTimeoutMs })`, the default) or per call
(`store.transaction(fn, { holdTimeoutMs })`, which wins): milliseconds
on the monotonic clock, counted from the moment the BODY starts — after
queue admission, after the transaction began and after the writer lock
is held, so neither the queue (`queueTimeout`) nor a lock wait (the
driver's lock timeout) counts. At
the limit the transaction is rolled back and the connection handed on —
another transaction proceeds while the body may still be awaiting — and
every handle it gave out refuses **`JD2098`** (a handle operation
already under way on an asynchronous host finishes first: its statements
land in the transaction that is then rolled back, and none of a later
one ever reaches the connection). When the body settles, `transaction()`
rejects with `JD2098` carrying `holdTimeoutMs` and `elapsedMs` (when the
rollback began — after the operations under way finished), so a caller
never runs beside its own body. With change capture on, the clock starts
inside capture's scope: what capture does before the body (PostgreSQL's
journal takes its advisory lock there) is a wait too. Nothing of
the body is committed. A nested transaction or a capture scope still
open at the limit settles into nothing. On in-thread SQLite a
synchronous statement blocks the event loop, so the limit acts after it
returns (`capabilities.cancellation.midStatement` stays `false`).
Handle admission and body settlement also check the monotonic deadline:
synchronous work and chains of microtasks cannot bypass it while the
timer waits for the event loop. A body that finishes past its limit rolls
back even if it caught an earlier handle's `JD2098`.
`retry` and `holdTimeoutMs` act on the asynchronous root only: the
synchronous twin cannot wait and a nested transaction inherits its
root's — both are `JD0014` there. A `store.transaction` (or
`store.sync.transaction`) called from inside an open transaction's own
synchronous extent is nested by the driver, so it IS a nested
transaction: it takes the nested option set and opens no root of its
own.

**A transaction's options are one closed set, on every surface.**
`store.transaction`, `store.sync.transaction`, a nested `tx.transaction`
/ `tx.sync.transaction` and the typed client's `client.transaction` read
`mode`, `signal`, `unitOfWork`, `retry`, `holdTimeoutMs` and `isolation`
— nothing else. Anything but a plain
object, an unknown member (named, with the nearest one: `{ mod:
'immediate' }` is refused, where it used to run *deferred*) or a malformed
value is **`JD0013`**, before the body runs. A nested transaction reads the
same set and refuses what its savepoint cannot honour, **`JD0014`**:
`unitOfWork` and `isolation` are the root transaction's to choose (a
savepoint writes through the unit of work around it, at its level), and
`mode: 'immediate'` inside a
transaction that did not take the writer lock asks for a lock no
savepoint can take — begin the root immediate. A `mode` the root already
holds, or a weaker one, is accepted. Only the asynchronous root queues, so
only it can abandon a wait with its `signal`; on the synchronous twin and
a nested transaction a signal that has already aborted refuses the
transaction before it begins (`JD2064`), and one that aborts later has
nothing to abandon. The typed client defaults `unitOfWork` to `'own'`,
and an explicit `unitOfWork: undefined` keeps that default.

**A transaction handle lives exactly as long as its own scope.** Every
`tx` view is pinned to the exact scope that created it, and every
stateful member — connection work, unit-of-work bookkeeping like
`add()`, `tx.stats()`, `tx.collection(name).stats()`, a lazy `query()`
cursor's `next()` — checks that pin before reading tracker state or
issuing a statement. `tx.introspect()` reads the database on the
transaction's own connection (the root's takes the gate, which from
inside the transaction is a wait for itself). A handle
retained past its callback, or an OUTER handle used while an async
inner savepoint is current, refuses **`JD2070`** naming the live
callback's handle as the fix; it never falls through to the root and
never follows a newer scope. Inside an inner transaction, use the inner
callback's own handle (synchronous nesting is unaffected — nothing can
interleave while a synchronous body is on the stack). `tx.stats()`
reports the work captured by its exact scope, and root `store.stats()`
always reports the root's, whichever scope happens to be current.

**A transaction view does not own the store lifetime.** The view
carries no `close` member, at runtime or in the declarations: closing
the connection under the view's own savepoint could only corrupt, so
the root store (or client) remains the only owner of connection
lifetime.

**Jobs have the same two spellings.** Root `store.jobs.*` finite calls
(and every worker's own claim/renewal/checkpoint/settlement I/O, no
matter where the worker was created) take the store gate, so an
unrelated job write can never join an open application transaction's
fate. `tx.jobs.*` runs as the exact scope — the transactional-outbox
spelling: an enqueue or settlement there co-commits with the domain
transaction and rolls back with it. A checkpoint store keeps the
root-or-scope ownership of the jobs view that created it.

**Capture is transparent to transaction options.** `{ capture: true }`
changes how committed records are translated, never queue cancellation
or tracker ownership: `store.transaction(fn, { signal, unitOfWork })`
behaves identically with and without capture — an aborted queued
callback still never runs (`JD2064`), and `unitOfWork: 'own'` still
gives the callback a tracker of its own without consuming the root's
pending state.

Nesting is asked for in one of two ways, and the difference is not
cosmetic:

- **Synchronously** — a `transaction` called while an owning callback is
  still on the stack nests, because nothing can interleave there. This is
  `store.sync.transaction` inside `store.sync.transaction`, and it is why
  a store-level synchronous call inside a synchronous callback runs as the
  owner rather than waiting.
- **Through the scope** — an `async` callback has already awaited, so the
  stack cannot say whether a request is its own nested work or an
  unrelated caller. Nest through the store the callback RECEIVED.

**A store-level handle is never inside another caller's transaction.**
`store.collection`, `store.entity`, `store.saveChanges()`, `store.execute`,
`store.dataVersion` and the whole `store.sync` surface hold the connection
for their own extent, so their statements cannot fall inside a transaction
they are not part of and share a rollback they know nothing about. One
store is therefore safe for a handler per request: an unrelated writer
waits for the commit and keeps its own fate. The one exception is the
synchronous rule above: a store-level call made on a transaction's own
synchronous extent — before its callback first awaits — runs as that
transaction's owner, so its writes commit or roll back with it, and the
callback's own handle stays usable beside it.

What that costs, stated plainly:

- A store-level call made while another caller holds the connection —
  its transaction, or on an asynchronous host a store-level call still in
  flight — **waits** on the connection's gate, under `queueTimeout`
  (default 5 s, the busy-timeout default). `openStore(model, { transactions:
  'strict' })` refuses at once instead, for a host that would rather see
  the contention than pay for it. The mode governs store-level calls — reads, writes,
  cursor pulls, root jobs — not transactions: a second top-level
  `store.transaction` still queues behind the first under `queueTimeout`,
  as it must to keep one savepoint stack per connection.
- A store-level call **awaited from inside its own transaction** is a
  self-wait: the store cannot tell it from an unrelated caller, so it
  queues and, at `queueTimeout`, becomes `JD0012` whose message names
  `tx.collection` / `tx.entity` / `tx.entities` as the fix. Bounded and
  named, never a hang.
- `store.transaction(fn, { signal })` abandons a call that is still
  **queued** — the callback never runs, and `JD2064` says so. A
  transaction that has already taken the connection runs to its own end.
- A store-level **cursor** — `collection.query()`, `entity.cursor()`,
  `entity.loadCursor()` — takes the gate **per pull**, not for its life:
  constructing it touches no connection, each `next()` holds the
  connection for exactly the source work one item needs (the first pull
  prepares and opens the statement) and releases before it settles, and
  `return()` is admitted the same way — a release the gate refuses (a
  contended `'strict'` store, a queue timeout) still resets the statement
  off-gate and answers `{ done: true }`, and an abort resets it at once,
  because a statement left open until a stranger commits is the worse
  outcome. So a consumer paused between pulls blocks no transaction, and
  a pull made while one is open waits for its commit and observes
  committed state only — never a row a stranger's transaction later rolls
  back. Every cursor iterates a statement of its own, so two cursors over
  one document never invalidate each other. A pull abandoned while queued
  is `JD2064`; an aborted cursor is `JD2072` at its row boundary; a
  passed deadline is `JD2075`; a settled cursor answers `{ done: true }`
  whatever the clock or the gate say. A transaction view's cursors are
  pinned to their exact scope instead (`JD2070`), as above, and belong to
  it: a cursor the body left open is closed when the body settles, before
  the scope commits or rolls back, and a retained cursor's `return()`
  still releases.
- `store.live()` and `collection.live()` register **under the gate through
  their initial query**: the registration is local but the first result is
  a statement, so it waits for an open transaction like every other
  store-level read and never publishes rows that transaction rolls back
  (LIVE-FORMAT §7). A registration that is refused leaves no live query
  behind. A live query registered from INSIDE a transaction (`tx.live`,
  `tx.collection(name).live`) initializes from that transaction's rows and
  shares its fate: committed, it stays and is maintained; rolled back, it
  is closed with the rows that never existed.

**A pool-backed store can read in parallel.** `openStore(model, { reads:
'parallel' })` admits the classified root reads beside the gate instead of
through it: a collection's `get`, `all`, `execute`, `explain` and
`query()`; an entity set's untracked reads (`asNoTracking().get` and
`.load`), its `execute` and `explain`, and its `page`, `cursor` and
`loadCursor` unless asked to track; `store.execute` and `store.explain`;
and the reads and cursors of `store.relational`. Each runs on a reader of
its own inside one read transaction, so it reads one committed snapshot:
it never waits for an open transaction, never joins one, and never sees a
row that transaction has not committed. A cursor holds its read from its
first pull until it settles — exhausted, released, aborted, or the store
closing — so every pull reads the same snapshot; a buffered cursor gives
the read back once its first pull filled the buffer. Everything else keeps
the gate: writes, transactions, live registration, root jobs, and every
TRACKED read (`get`, `load`, and a page or cursor with `tracking: true`),
because it registers what it read in the unit of work. A parallel read
waits for a free reader for at most `queueTimeout` (`JD2091`); a read that
finds every reader held runs on the writer when the writer is free, and a
cursor, which would keep the writer for its whole life, never does.
`transactions: 'strict'` keeps its meaning for the gated calls — a
parallel read has no transaction to queue behind. The option is accepted
only where there are readers to run on (`@jarenjs/db/node-pool` on a
file, with `readers` above zero — or read-only, when every worker reads);
anywhere else it is `JD0009`, naming the driver. `capabilities.parallelReads` reports `'parallel'`, or
`'serialized'` — the default, and the behaviour described above.

**A unit of work's fate is its transaction's.** A tracked `saveChanges()`
inside a transaction writes its statements immediately — inside the
transaction the database does hold them, and every later read, plan and
optimistic guard in that unit of work agrees with that. What waits for
the commit is the right to *keep* the advance: if the enclosing
transaction rolls back, the tracker's snapshots are withdrawn to what
they were before the save, so a caller's retry plans the same statements
again instead of reporting a success it never had. A nested savepoint
that rolls back withdraws only what was registered inside it.

`@jarenjs/linq/db` projects all of this: `client.transaction(async (tx) =>
…)` hands the callback a typed client whose `tx.entities.X` and
`tx.collections.Y` are the transaction's, with a unit of work of its own
by default so two handlers never see each other's pending state
(`unitOfWork: 'shared'` opts back into the client's). The typed client
forwards `tx.savepoints` (§5.2) unchanged, and `tx.store` is the
underlying `TransactionStore`.

### 5.2 Named savepoints: partial rollback without a sentinel exception

Structured nesting already gives partial rollback around a callback: an
inner `tx.transaction(fn)` is one savepoint, and an outer callback that
catches its error continues. What it cannot express is
checkpoint-and-continue from a LATER point without throwing for control
flow. A live transaction view carries that as `tx.savepoints`:

```js
await store.transaction(async (tx) => {
  await tx.savepoints.create('before-optional-import');
  await tx.collection('docs').put(optionalDoc, 'optional');

  if (!accepted) {
    await tx.savepoints.rollbackTo('before-optional-import');
    // the checkpoint remains active and may be rolled back to again
  }

  await tx.savepoints.release('before-optional-import');
});
```

The synchronous twin is `tx.sync.savepoints`, answering values. Root
`Store`, root `Client`, workers and checkpoint stores expose **none** of
it: only the transaction that owns the connection may move its stack,
and a stale or cross-scope view is `JD2070` before any label is even
looked at.

- **The label never reaches SQL.** It is a map key and diagnostic for
  that exact transaction; the driver generates the same monotonic
  `jaren_sp_*` identifier structured nesting uses, so both savepoint
  kinds share one engine stack and cannot cross-release one another. A
  structured inner transaction gets its own exact namespace — it cannot
  target an outer label, and the `JD2070` rule keeps the outer view
  from destroying an async inner savepoint.
- **A blank, duplicate or unknown label is `JD2071`**, raised before
  any statement, so the database and the settlement/capture marks are
  untouched.
- **`rollbackTo` follows the engine's semantics exactly.** The target
  savepoint stays active (a second rollback to it is defined) while
  every checkpoint created after it is invalidated; the rows after the
  target are gone. In-memory effects follow the database: settlement
  effects registered after the checkpoint run their rollback halves in
  reverse — a `saveChanges()` advance after the checkpoint is
  withdrawn, its entity intention pending again, so a corrected
  `saveChanges()` retries it (and an enclosing rollback still withdraws
  that later advance). Direct collection writes and `tx.jobs` writes
  are undone by SQLite itself. Session capture observes the engine's
  final changeset; journal capture truncates to the checkpoint's mark —
  the two modes agree.
- **`release` keeps the rows.** It removes the target and every later
  checkpoint without running rollback effects: those rows remain part
  of the owning transaction, and their tracker withdrawals stay
  registered until outer settlement. An outer commit or rollback
  invalidates whatever names the callback left active.
- No observer delivery or persisted capture record occurs before the
  owning transaction commits, exactly as everywhere else.

### 5.3 Relational statements through the store

`relational(connection)` runs structural SQL documents over a bare
connection ([SQLITE-RELATIONAL](SQLITE-RELATIONAL.md)). A store carries the
same engine — one planner, one emitter, one result rule — admitted the way
every other store operation is admitted:

| Surface | Reads | Cursor | Writes |
|---|---|---|---|
| `store.relational` | under the store gate, prepared read-only, so a pool reader serves a read no transaction pins | admitted per pull, as the root collection cursor is; a PostgreSQL native cursor holds the session until it is released | one top-level transaction of its own, `mode: 'immediate'` |
| `store.sync.relational` | under the synchronous gate | per pull | a top-level immediate transaction |
| `tx.relational`, `tx.sync.relational` | as the exact scope | pinned to the scope | a savepoint of the transaction |

- **Documents, results and codes are the engine's.** A malformed
  document is `JD0038`; every driver failure is classified (`JD2005`
  with its `class`, never a raw driver error). `lastInsertRowid` is
  present only after an insert that inserted a row of a rowid table on
  SQLite — never after an insert that inserted nothing, an upsert (it
  may have updated; `returning` names the row), an insert into a
  `WITHOUT ROWID` table, or on PostgreSQL. SQLite's last rowid belongs
  to the connection, so each of those would report another row's.
- **Admission is the store's.** A root call on a strict store refuses
  at once while another caller holds the connection, and the synchronous
  surface always does (`JD0012`); the asynchronous root queues under
  `queueTimeout`. A transaction's engine refuses once its scope settled
  (`JD2070`) or its hold limit passed (`JD2098`), and its calls count as
  in flight for that limit. A failed write inside a transaction rolls
  back to its savepoint and the transaction carries on — on PostgreSQL
  too, where a failed statement would otherwise abort it (`25P02`).
- **Writes follow the rules trusted SQL follows, from one function.**
  Pending tracked changes refuse (`JD2041`), because a later save would
  write over what the statement wrote. A read-only store refuses
  (`JD2095`). A store-only invariant (§13) refuses a write to **its
  entity's table** (`JD2095`) and no other: the document names its
  table, where `tx.sql` names none and so refuses whenever any
  store-only invariant exists. Journal capture refuses a relational
  write (`JD0051`): the journal is written by the store's own writers
  from before and after images the engine does not read. Session capture
  records it like any statement on a store table — the changeset is
  SQLite's own — and a write to a table the store does not own is not
  part of its stream. `tx.sql` still refuses under any capture. Every
  write invalidates the tracked entities it may have changed.
- **What stays refused.** Physical entities (§12) refuse capture at
  open: their adopted application triggers write rows capture cannot
  see, so a relational write on an adopted file is never captured.
  Triggers and cascades a relational write fires are the application's
  own SQL; a store-only invariant is enforced by the store's writers and
  is not re-checked on the rows they write.
- **Statements are prepared once per text.** The engines of one store
  share one bounded cache (`statementCacheBound`), keyed by the SQL text
  and its access: a document with externals plans one text for every
  binding. A statement the bound evicts is finalized once no call runs
  on it — a worker keeps every statement it prepared until told
  otherwise, so an unfinalized one held a slot of its `maxStatements`
  forever. Pending preparation and execution keep their borrow until they
  settle; cleanup failures do not replace the operation's answer or error.
  A failed preparation is discarded so a later call can retry. Cursors prepare
  their own. A table's rowid-ness is read from
  the catalog on every reported insert, never remembered: a table
  recreated `WITHOUT ROWID` changed its answer. Virtual tables (FTS5,
  R*Tree) keep rowids and report them.
- **A signal refuses up front everywhere.** An already-aborted `signal`
  is `JD2064` on the root (which may also be waiting in the queue), on a
  transaction's engine and on the synchronous surfaces — thrown where the
  surface answers values.

## 6. Identity

Key allocation is declared, never guessed (three strategies, platform
primitives only):

| declaration | strategy | `insert` returns |
|---|---|---|
| `"key": "/id"` | caller-supplied: the key is read from the document at the pointer | the extracted key |
| `"key": null, "identity": "uuid"` | `crypto.randomUUID()`, stored in the key column only | the allocated UUID |
| `"key": null, "identity": "integer"` | database-allocated integer key | the allocated integer |

A caller-keyed document whose pointer resolves to nothing or to a
non-scalar is `JD2002`; so is an explicit key argument that is not a
string or a number, and a number that is not finite (NaN and ±Infinity
have no key spelling). On a numeric key column a string that is no decimal
number (`'abc'`, `'0x7'`) names no row on either engine: `get` answers
`undefined`, `delete` `false`, `patch` `JD2006` — PostgreSQL never sees it.
A write under such a key (`insert`, `put`, an entity's `create` or `add`)
is `JD2002` on both engines before any statement: no read could find the
row, and PostgreSQL's numeric input would have stored `'0x10'` under 16 —
replacing the document kept there — and `'NaN'` under a key nothing reads.
It used to reach the database: SQLite refused it `JD2005`, PostgreSQL wrote
it. The unit of work refuses it alike: `remove`, `link` and `unlink` (own
key or target) as they stage it, and a membership array when the save plans
it — PostgreSQL deleted row 16 for `remove('0x10')` and linked it for
`link(16, 'tags', '0x10')`, while SQLite deleted nothing. So does `create()`
with a membership array carrying one, before its insert (PostgreSQL linked
tag 16, SQLite failed the join row `JD2005`); a key a membership names is
refused naming the member (`the key "0x10" in 'tags'`). Decimal text
(`'16'`, `' 7'`) still names its number — in the unit of work too, which
files and compares a key as the number it names: `remove(16)` after
`add({ id: '16' })` cancels it, `unlink(2, 'tags', '16')` removes the
membership to tag 16, and a `link()` of a membership held, in either
spelling, changes nothing (the unlink was a silent no-op, and such a link
failed every save on the join table's key). Text spelling a number no
double holds exactly (`'9007199254740993'`), or none (`'1e400'`), is no
key the engines agree on: PostgreSQL stores the exact value and reads back
another (or `null`), SQLite fails every later load `JD2003` or refuses the
write `JD2005` — keep a numeric key within the safe integer range. An
entity document whose key member is absent is `JD2002` before any
statement unless the key is `default: "auto"` (or a generated column of a
`physical` layout): SQLite stored a single integer key's row under a rowid
of its own choosing, which no tracked record named, PostgreSQL refused the
NULL `JD2005`, and a `physical` layout's codec refused it at every save of
a pending insert no key could discard. Under a `physical` layout the key
column's codec decides (§12): a key it refuses is its `JD2003` where
`remove` stages it — the save failed on it every time until `discard` —
and a read by it answers absent (a `physical` entity is no membership's
endpoint, so no `link` names one). An instant key kept as an epoch column
(`column: "integer"` on a `date-time` or `date` key, §10.3) names its row by
the instant: every statement binds the key as its column holds it — `get`,
`update` and `delete`, alone or as part of a composite key, the unit of work,
a foreign key or membership that references the row, and replication's
writer — so `'2026-03-01T00:00:00Z'`, `'2026-03-01T00:00:00.000Z'` and the
epoch `1772323200000` name one row, and the unit of work files them as one.
A text no such key could hold (an offset form, junk) names no row, and is
refused (`JD2003`) where `remove` or `link` stages it. Such a row used to be
stored and then named by no statement: SQLite's `get` answered `undefined`,
`update` refused `JD2006` and `delete` answered `false`, PostgreSQL refused
`JD2005`, as did a membership naming the row and, under replication, every
create (`JD2104`); a referencing member read back as the epoch, and session
capture rendered the row under its epoch. A member that references such a key
declares `column: "integer"` itself; without it the member's column holds
the epoch while the member is a string, and a write naming the row is
refused (`JD2005`).
For allocated identities, `put(doc, key)` updates
a known document and `put(doc)` allocates. On a caller-keyed collection
the document's key is the key: `put(doc, key)` whose `key` names another
key than the document carries is `JD2002` — it used to write under the
document's key and answer that, while journal capture read its
before-image under the one passed.

**A key names one row, in one spelling.** A number reaching a TEXT key
column — an untyped key schema, `["string", "integer"]`, or a typed
`string` on an unvalidated store — is bound as its canonical JSON text
(`7` as `'7'`, `1.5` as `'1.5'`) on every driver, in every read and
write, and so in the path both capture modes record. It used to be the
driver's choice: node:sqlite bound a number as a REAL, which a TEXT
column stores as `'7.0'`, while Bun stored `'7'` — a file both runtimes
wrote could hold one key as two rows, and an index-only migration was
refused as "a transform changed the key". A file an earlier node write
left still works: a read of a numeric key also finds a row under the
spelling the running SQLite gives that number as a float (`'7.0'`) — but
only when the row's document holds that number at its key member, so a
string key spelled `'7.0'` stays a key of its own (and on a collection
without a key member, where no document can say, every spelling is a key
of its own) — and a write first
moves such a row onto the canonical text, in the same transaction (which
takes the writer lock before its first read), so the file converges as it
is written. The float spelling depends on the SQLite that wrote it:
SQLite 3.51 (Node 24.14 and 25.5) rounded to fifteen digits
(`'1.23456789012346e+15'`, `'0.3'` for `0.1 + 0.2`), 3.52 and later keep
seventeen. A row a fifteen-digit SQLite wrote for a number that needs
more is not found by the other version's lookup — the statement below
converges it whatever SQLite runs it. A key the file
already holds under BOTH spellings is refused on write — `JD2001`,
naming both rows — rather than merged in silence: keep the row you want,
delete the other. Session capture reports that one-time move as what it
is (a `remove` of the old path beside the write's `add`); journal
capture reports the write.

To converge a whole file at once, run this statement once per collection
whose documents carry numeric keys — `<table>` is the collection's name
and `<member>` its key pointer as a JSON path (`/id` is `$.id`):

```sql
UPDATE "<table>" SET "key" = "doc" -> '<member>'
WHERE json_type("doc", '<member>') IN ('integer', 'real')
  AND "key" <> ("doc" -> '<member>');
```

It rewrites rows whose document's key member is a JSON number (a string
key such as `'1.0'` is left alone). `->` preserves the numeric text in the
document, including fractional and large numbers, without converting it
through SQLite's REAL-to-TEXT spelling. Jaren writes this document text
with `JSON.stringify`, so it is already canonical for the stored number;
externally authored documents need their numeric spelling normalized first.
A duplicate makes it refuse as a whole (the
primary key rejects the moved row and nothing changes), and a second run
changes nothing.

## 7. Error codes

`DbCompileError` (`JD0xxx`, problems opening a store) and
`DbRuntimeError` (`JD2xxx`, problems reading or writing one) build on
the suite's coded contract: a stable `code`, a bare `reason`, a
composed `message`, a `docPath` into the model document where one
exists — and, on runtime errors, the `collection` and (where known)
the `key` as own properties. Database errors are wrapped, never leaked
raw: the reason keeps the original text, `cause` keeps the original
error. Both classes extend `CodedError` from `@jarenjs/core/errors`, in
their declarations as at runtime, so a `CodedError` binding or an
`instanceof CodedError` test takes them. *Upgrade: the declarations used
to extend `Error`, and their optional `docPath` is now `string |
undefined`, as on every coded error.*

| code | raised when |
|---|---|
| `JD0001` | the SQLite library is below the supported floor |
| `JD0002` | the existing database disagrees with the declared model (a SQLite file whose text encoding is not UTF-8 included), or the open failed in the driver |
| `JD0003` | the driver binding is unavailable on this runtime |
| `JD0004` | a declared index cannot be mapped to a column, or a planned table, column or index name is longer than the engine holds (PostgreSQL: 63 bytes, refused when the model is planned; §3), or an index would take a name PostgreSQL gives one of the table's own objects (`<table>_pkey`, `<table>_<column>_seq`; §3), or a store-owned entity's member would take the name of the table's own document column (`doc`), of its row identity column on PostgreSQL (`rid`), or of another member's column as the engine compares names (SQLite folds ASCII case; §9.2), or a collection, entity or join table named like one of the engine's own tables (`_jaren_migrations`, `_jaren_jobs`, `_jaren_changes`, `_jaren_owner`, …; §9.4) |
| `JD0005` | the model document is invalid |
| `JD0006` | an open option named a pragma this store does not configure |
| `JD0007` | the pragma cannot be applied on this driver or store |
| `JD0008` | a pragma did not take: the read-back disagrees with the request |
| `JD0009` | an open option is outside the closed set `openStore` reads, or its value is malformed |
| `JD0010` | strict mode refused a residual |
| `JD0011` | the profile refused the document |
| `JD0012` | work waited too long for the connection a transaction or another call held |
| `JD0013` | an option passed to a store operation is not one it reads, or is malformed |
| `JD0014` | a transaction guarantee was requested where it cannot act |
| `JD0015` | owner was asked of an adopted store whose database has no owner table |
| `JD0030` | an unknown x-entity member was declared |
| `JD0031` | relation declarations contradict each other, or two many-to-many declarations that are not inverses name one join table (§9.4) |
| `JD0032` | the include specification is invalid |
| `JD0033` | an entity query names no entity array |
| `JD0034` | a tracked cursor needs a bare entity return |
| `JD0035` | the continuation does not belong to this ordering |
| `JD0036` | a snapshot page needs an immutable ordering |
| `JD0037` | strictStreaming refused a plan that buffers |
| `JD0038` | the native mutation document is unsupported or invalid |
| `JD0039` | a member that takes a query document was handed a chain |
| `JD0040` | the save spans a relation cycle |
| `JD0041` | a query document, or an external a comparison reads, is not JSON: a non-plain object with no own member to read, at its root or inside it, or a `bigint` external a comparison reads |
| `JD0050` | live queries require change capture |
| `JD0051` | the demanded live mode is unavailable |
| `JD0052` | the live-query bound was reached |
| `JD0053` | the live event-time declaration is invalid |
| `JD2001` | insert found the key already present, or the key is stored under two spellings |
| `JD2002` | a usable key could not be resolved for the write, or an explicit key disagrees with the document, or a patch rewrites the document's key member |
| `JD2003` | a value or staged operation violates its data contract |
| `JD2004` | an undeclared collection was requested |
| `JD2005` | a database operation failed |
| `JD2006` | patch found no document at the key |
| `JD2007` | the result exceeded the profile row bound |
| `JD2040` | an optimistic precondition did not hold: the row changed under an update, or an expect did not match |
| `JD2041` | tracked changes are pending; save or discard them first |
| `JD2050` | a changeset could not be decoded |
| `JD2051` | the change log is not enabled |
| `JD2060` | the maintained live state exceeded its bound |
| `JD2061` | another context owns the database, or another owner holds its lease |
| `JD2062` | the store closed with job handlers still in flight |
| `JD2063` | the store is closed |
| `JD2064` | the call was aborted while it waited for the open transaction |
| `JD2065` | the job is not leased — it is unknown, or already settled |
| `JD2066` | the lease was superseded by a newer claim or renewal |
| `JD2067` | the lease expired before the call |
| `JD2068` | a settling call needs the lease the claim returned |
| `JD2069` | a resumed run does not match the workflow or input it was checkpointed under |
| `JD2070` | the transaction handle does not belong to the live scope |
| `JD2071` | the savepoint label is blank, duplicate or unknown |
| `JD2072` | the call was aborted before its next row |
| `JD2073` | an include exceeded its per-root bound |
| `JD2074` | an item exceeds the page byte bound |
| `JD2075` | the deadline passed before the next unit of work |
| `JD2076` | an item exceeds the profile byte bound |
| `JD2077` | the maintenance operation is unavailable on this store |
| `JD2078` | the maintenance operation failed |
| `JD2079` | the backup was cancelled |
| `JD2080` | the migration was cancelled between steps |
| `JD2081` | the maintenance operation was cancelled |
| `JD2082` | the database or its disk is full |
| `JD2083` | the database is read-only |
| `JD2084` | a disk I/O error |
| `JD2085` | the database file is corrupt or not a database |
| `JD2086` | a seek anchor came back with a type the plan did not declare |
| `JD2087` | the connection to the database was lost |
| `JD2088` | the transaction was aborted by an earlier failure in it |
| `JD2089` | the statement was cancelled by the server |
| `JD2090` | worker generation lost (a worker that did not become ready in time included), PostgreSQL cleanup deadline expired, or a statement reached a parallel read that had ended; no automatic write replay |
| `JD2091` | bounded host admission or identity capacity exhausted, or acquisition expired |
| `JD2092` | a host frame or compatibility result exceeds its declared row/byte bound |
| `JD2093` | malformed worker protocol request |
| `JD2094` | invalid or uncommitted durable snapshot; reopen the last committed version |
| `JD2095` | trusted SQL, a relational write, or synchronous callback authority refused |
| `JD2096` | persistence invariant rejected the mutation; constraint class |
| `JD2097` | supervised native operation cancelled or past its response deadline; owner exit and transaction fate are reported separately |
| `JD2098` | the transaction held its connection past its hold limit and was rolled back |
| `JD0060` | a replication envelope or snapshot is invalid |
| `JD2100` | a replica sequence or causal dependency has a gap |
| `JD2101` | an envelope identity names different content or an unknown local origin |
| `JD2102` | the replica identity or model revision disagrees |
| `JD2103` | a resolver fails its synchronous decision contract |
| `JD2104` | a logical row or snapshot disagrees with its causal history |
| `JD2105` | an explicit snapshot reset is required, or reset would discard acknowledged history |
| `JD2106` | a replication operation or snapshot exceeds its configured bound |

The table above is proven in sync with the runtime `DB_CODES` table by
a test.

**`JD2061` has two sources.** A browser context that finds the database
owned by another context (LIVE-FORMAT §11) — and the owner lease (§5.1):
an open with `owner` while another store holds the lease (busy, retryable;
`owner` names the holder and `expiresAt` says until when — on PostgreSQL,
whose lock names no one, both are `null`), and every later call of a store
whose lease another holder took (not retryable: the store is no longer the
owner, close it) or whose lease lapsed on its own clock — before the call,
or while it waited in the store's queue — and could not be renewed yet
(retryable). `JD0015` is the owner lease on an adopted SQLite
store: adoption creates nothing, so the reason names the one statement
that creates the owner table.

**One classification of driver failures.** Every path that meets a
driver error — a collection or entity write, the job queue, the query
path, a maintenance operation, the backup, the open sequence, a
migration run —
consults one table (`classifyDriverError`), so the same failure arrives
under the same code with the same `class` and `retryable` verdict
whichever path met it: `busy` (SQLITE_BUSY/LOCKED → `JD2005`,
retryable), `full` (`JD2082`), `readonly` (`JD2083`), `io` (`JD2084`),
`corrupt` (`JD2085`), `cantopen` and `constraint` (`JD2005`), `duplicate`
(a collision on the key's own constraint → `JD2001`), `overflow` (`JD2005`: a
numeric result past the range of its type, such as an integer a PostgreSQL
`bigint` column cannot hold), `data` (`JD2003`, not retryable, when Node's SQLite binding
refuses to represent a stored integer as a JavaScript number), and the fallback
`error` (`JD2005`).

The key's own constraint is the table's PRIMARY KEY, whatever number of
members it keys by; a composite key's `JD2001` names every member
(`a 'Pair' already exists under key {"a":1,"b":"x"}`). On SQLite a PRIMARY KEY
conflict is the key's only on the table the write inserts into: a trigger of an
adopted table whose own insert meets another table's key is a constraint
failure, `JD2005`, naming that table. On PostgreSQL it is
the constraint the catalog names for that primary key, which the store reads
when it opens — the table probe answers it, once more after the store creates
the table, and a physical entity takes it from the catalog rows its open
already reads — and a violation is the key's when the server names that
constraint, matched exactly and never by a pattern. A table renamed by a
migration keeps the name its key was created under, an adopted table brings
its own, and a unique member may carry a name shaped like a key's (a member
named `pkey1` is indexed `<table>_pkey1`): a collision on that member is a
constraint failure, `JD2005`, naming it. A caller outside the store, which
read no key constraint, gets no `JD2001` from a PostgreSQL violation. A key
constraint renamed under an open store is read again at the next open, and so
is a partition attached to a partitioned table: the rows of such a table live
in partitions that each carry a key constraint of their own, which the server
names when a key is found twice, so the open reads the constraint of the table
and of every partition below it in the store's schema, and a partition attached
later reports `JD2005` naming its own until the next open.

An engine reports only the first unique constraint a row fails, so a write
colliding on its key and on another unique constraint at once — `create()` of
a stored row with its own unique values is one — is `JD2001` on both engines.
PostgreSQL checks the primary key of a table the store creates first, because
its index is the table's oldest. SQLite may name a unique member or a unique
entity index first, so on every insert path (an entity's `create()`, the unit
of work's batch, a collection's `insert()`) a UNIQUE failure that does not
name every key column is followed, on the same connection, by one read of the
keys the insert carried (inside the caller's transaction when it has one): a
stored key is `JD2001`, otherwise the unique failure stands as `JD2005` naming
the member. The read runs only after such a failure, and a key the database
allocated is never carried and never read.
One remainder: an adopted PostgreSQL table whose unique index is older than its
key reports that index first, so a write colliding on both is `JD2005` naming
the index ([POSTGRESQL.md](POSTGRESQL.md)). No pushed `$sum` or `$avg` over an `integer` member —
in a collection, an entity or a native temporal bucket — raises `overflow`
or `data` over the values the store writes, which are JavaScript numbers and
so within the double range: it folds as a double beside its exactness guard
(§10.6) and leaves any term past `2^53 − 1` out of the fold, so neither
engine's accumulator can overflow and no statement fails, inside a
transaction or out of one; a run past the guard is the `'accumulation'`
fallback, which strict mode refuses. A JSON number past the double range
that reached a document another way (trusted SQL, another writer) reads
back as `Infinity`: SQLite then answers the engine's `Infinity`, while
PostgreSQL's guard cannot read it as a double and refuses the call
(`JD2005`, class `overflow`), which inside a transaction aborts it
(`JD2088`). A returned classification owns its mutable metadata;
editing it cannot change how later failures are classified. A classified error
carries `class`, `retryable` and the driver's error as `cause`; a
lifecycle that owns its failure code (`JD2078` for maintenance and
backup, `JD0002` at open, `JD0023` for a migration — MIGRATION-FORMAT
§6) keeps the code and still carries the class.

The ENGINE is discriminated by the evidence the error itself carries,
never by a table threaded down from the caller: a SQLite binding
attaches a numeric result code, a PostgreSQL one attaches a
five-character SQLSTATE. Both land in the classes above, and three
conditions a single-writer file database does not have get their own:
`connection` (`JD2087`, retryable — SQLSTATE class 08 and the
administrator's own terminations), `aborted` (`JD2088` — SQLSTATE
`25P02`, a statement issued after an earlier failure inside the same
transaction) and `cancelled` (`JD2089` — SQLSTATE `57014`). A
serialization failure or a deadlock (`40001`, `40P01`) is `busy` and
retryable, which is the same verdict, and the same caller branch, a
locked SQLite file gets.
An engine error thrown inside a pushed user function (`JQ…`) is not a
driver error: it passes through untouched, relocated onto the caller's
document path (`/$where/…`, never the hatch's `/$return/…`).

## 7A. Model-declared index expressions

An index may name a computation instead of a member:

```json
{
  "name": "by_lower_email",
  "expression": { "call": "lower", "args": [{ "member": "$.email" }] },
  "unique": true
}
```

`expression` is mutually exclusive with `path` and with `derive`
(`JD0004`): an expression names the members it reads itself, and a
derived spatial column IS an expression this format spells for you.

**The vocabulary is closed — three node kinds and no fourth**, and none
of them is SQL text:

| node | meaning |
|---|---|
| `{ "member": "$.a.b" }` | a singular JSONPath expression into the stored document |
| `{ "value": 1 }` | a JSON string, number or boolean. A `null` or a compound has no place in an index expression |
| `{ "call": "lower", "args": [ … ] }` | a function the HOST declared, applied to its arguments in order |

Argument order is significant: `sub(a, b)` and `sub(b, a)` are
different expressions and different columns. An expression nests at
most eight deep.

**A function is DECLARED by the host, never created by the store.**
`openStore(model, { expressions })` takes one declaration per name:

```jsonc
{
  "lower": {
    "arity": 1,
    "deterministic": true,           // required, and never inferred
    "apply": (value) => …,           // an engine that registers functions calls this
    "sql": "lower"                   // one that cannot calls this IMMUTABLE function
  }
}
```

Why a declaration rather than an escape hatch: **an index over a
function is a schema dependency.** A database whose column is computed
by `lower(…)` cannot be written from a connection that has no `lower`,
and a raw-SQL index would have had exactly that hazard with none of the
checking. Here the model names the function, every store that opens the
model is handed the same declaration, and a store that cannot honour
one refuses at open — `JD0004`, before a single statement:

- a name this store was not given
- an arity the expression does not match
- a function not declared `deterministic`
- no `apply` where the engine computes the value itself
- no `sql` name where the engine calls its own — and that name is an
  identifier, never SQL text

**How each engine computes it.** SQLite registers `apply` as a
deterministic function under a namespaced name (`jaren_x_lower`) — so a
model's `lower` never shadows the engine's own — and the column is
`GENERATED ALWAYS AS (jaren_x_lower(<member>)) VIRTUAL`. PostgreSQL
registers nothing: the column is `GENERATED ALWAYS AS (lower(<member>))
STORED` over the immutable function the host promised the server has.
Both read the member as its own SCALAR, so `lower` of a string is the
same answer on both.

One column serves every index that declares the same canonical
expression, and the canonical form — order-preserving — is what the
shape hash and the migration diff read. `store.introspect()` reads the
expression back out of the SQL the dialect wrote (each dialect reads its
own), so a declared expression index survives the round trip; without
the declarations the column is REPORTED as unmapped rather than guessed.

PostgreSQL keeps no CREATE text, so every open reads each generated
column's expression back out of the catalog and compares it with the
planned expression as a whole — every path, guard, operator, collation,
call and literal — after undoing only what the server rewrites
cosmetically (a type on every literal, `ELSE NULL`, parentheses, quoted
names such as `"left"(…)`, the path array's quoting, how the reading
session spells a backslash). A column whose expression differs in
anything else, or that does not read, is `JD0002`; a planned expression
that could not be read back is refused where it is planned (`JD0004`).
SQLite compares the CREATE text itself.

**An entity index over an expression** (§9.2) takes `expression` in
place of `path` (both are `JD0004`), and its root is a call: a lone
member is a `path` index and a lone value keys nothing. Each member it
reads is one top-level member, `$.<member>` or `$['<member>']`, whose
column holds a string — a mapped string scalar, or a foreign key's
column over a string key. A member the document holds, a nested path, a
relation, an epoch member (its column holds milliseconds) and an
`integer`, `number` or `boolean` member (its column holds a type of its
own: a boolean `1` or `0` where `apply` takes `true`) are `JD0004` at
the `expression`, naming the member.

On PostgreSQL the index keys the declaration's `sql` function over the
columns, with no column of its own:

```sql
CREATE UNIQUE INDEX "User_by_lower_email" ON "User" (lower(("email" COLLATE "default")))
```

Each column is read as a collection's expression reads its member — its
text under the database's default collation, where the column holds it
under `"C"` — so one declaration answers alike over a collection and an
entity. The server computes the function on every connection, so the
index holds for the store and for a raw SQL writer alike, which inserts
and deletes rows as before; a violation is `JD2005`. A missing member is
SQL NULL, and the function's answer over it is keyed as any other (a
`NULL` key never meets another in a unique index). Every open reads each
key back out of the catalog and compares it with the planned key as a
generated column's expression is compared, and refuses (`JD0002`)
another function or argument, another collation of a member, a key
under a nondeterministic collation (a case-insensitive one refuses
values the model keys apart, and the server's deparse of a key does not
spell it), a lost `unique` and a changed condition. The planner creates,
drops and recreates the index (a changed expression or condition is a
drop and a create); `planModelMigration` and `planInvariants` take the
declarations as `expressions`, as `openStore` does, and without the
function refuse `JD0004` at the `call`. A function the server has not
for the arguments the expression passes (`left(text, bigint)` over a
literal past the 4-byte integers) is refused `JD0004` at the
`expression` when the index is created, naming the server's message.
The server folds an unquoted `sql` name to lower case and writes a
call's schema only where its search path would not find the function,
so the open compares names as the server spells them: `LOWER`,
`pg_catalog.lower` and `lower` are one function, and so are `fold` and
`<schema>.fold` in the store's own schema (on a store over the
connection's own search path, whose schemas the open does not know, a
call compares by its bare name), while a schema the path does not hold
stays part of the name. `introspect({ expressions })`
reads the key back into the expression, a number constant the server
keeps cast (`'-1'::integer`, `(5)::numeric`) included; without the
declarations it is an `unmapped-index` row. Of two declarations that
name one server function, introspection reads the one spelled as the
server spells it. Replication orders an envelope's writes by the
columns of a unique index, never by an expression's key: a value the
function folds together, taken by one write before another releases it,
keeps the envelope's order and is refused `JD2005`
([REPLICATION-FORMAT](REPLICATION-FORMAT.md#applying-and-exporting)).

**On SQLite an entity index over an expression stays `JD0004`** at its
`expression`, naming the index, the members it reads and the repair.
SQLite maintains an index over a function only on a connection that
registered it, so every other writer of the table — the raw SQL client a
database rule exists for included — could no longer insert or delete a
row; nothing in the file carries a function. No SQLite built-in stands
in for a declaration: the store cannot prove one answers as `apply`
(SQLite's `lower` folds ASCII alone), and a collection's index over the
same declaration calls `apply`. Index the member itself, declare the
expression index on a collection, or keep the entity on PostgreSQL. A
layout an application owns (§12) keys an expression term of its own in
`physical.indexes`.

## 8. The safe execution profile

A query document that arrives from a tenant, a remote client or a
language model can reach a database. Parameter binding makes injection
structurally impossible; it does nothing about resource exhaustion or
cross-tenant reads. A **profile** composes five independent bounds:

```js
const store = await openStore(model, { driver, profile: 'safe' });
// narrowed per call (a per-call profile can only narrow the store's):
collection.query(doc, { profile: { maxRows: 200 } });
// or, on a store opened with no profile, per call alone:
collection.query(doc, { profile: { maxRows: 200, externals: ['min'] } });
```

`'safe'` is the default table; a profile object overrides members over
it. On a store opened with a profile, that profile is a FLOOR under a
per-call one, so a call can narrow what the store admits and never widen
it: a member the call leaves out is the store's;
the call's `predicates` are conjoined with the store's (`$and`) for a root
both name, never in place of them; `maxRows`, each engine limit and each
graph cap may only be lowered; `externals`, `functions`, `collations`,
`collections` and each root's `members` may only name a subset of the store's;
and `refuseFullScan` may only be turned on. A member that would widen the
store's — a larger bound, `null` for a bound the store sets, a name outside
the store's list, `refuseFullScan: false` where the store refuses — is
refused `JD0011`, naming the member, the value asked and the store's value,
rather than clamped: the caller asked for more than the store allows. A
per-call `'safe'` spells every member of the `'safe'` table, so it is refused
on a store whose profile is narrower. On a store opened with no profile, a
per-call profile is normalized over the `'safe'` defaults, as it always was.
So `execute(doc, { profile: { maxRows: 50 } })` keeps the store's
mandatory predicate and allow-lists and lowers its row bound to 50. The defaults: engine limits
`{ sequenceItems: 100000, resultItems: 10000, steps: 1000000, depth: 32 }`,
`maxRows: 1000`, no externals, no host functions, no collations, all
of the store's collections, no mandatory predicates, no scan refusal,
and no graph caps (`maxIncludedRows`, `maxDepth`, `maxBytes` all
`null`), and no member allow-list (`members: null`).

**One profile, every engine.** A profile — the store's, or the call's
through `ExecuteOptions.profile` on `execute`, `query`, `cursor`,
`loadCursor`, `page` and `explain` alike — applies identically to
collection execution, entity execution (`entity.execute`, the chain's
cursor), graph loading (`load`, `loadCursor`, `page`, every include
subquery) and store-root execution (`store.execute`); a live
registration on a store opened with a profile re-runs through `execute`
whatever its shape (LIVE-FORMAT §7; over an asynchronous connection a
resnapshot, with the profile's limits narrowed to its credits), so the
profile binds every result it holds. It bounds every read a caller makes
through a query document or a point read: a point read (`get`, collection or
entity) answers a row only when the root's mandatory predicate, bound to the
read's own `externals`, keeps it (below). It does not bound the change
feeds — `store.observe`, change capture and replication — which deliver every
tenant's records, nor the trusted SQL surface `store.relational`: they are
host surfaces (below). `collections` is
the one allow-list and names collections AND entity roots; a document
that reads a name outside it is `JD0011` on every engine, with the
same reason. `predicates` is keyed by collection or entity name, and
an entity's predicate is conjoined into every fetch of that entity —
the native statement, each root the residual fetches, the load's root
and every include subquery over that entity. A join table's rows belong
to the entities it relates (§10.7): under a profile that holds a
predicate for either, a join row is readable only where the row it names
on that side is, so every fetch of the join-table root wears the
existence of that row under the side's predicate —
`EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = "Label_User"."User_key"
AND <User's predicate>)` — beside any predicate the profile keys by the
join table itself; it binds the side's externals as a read of the side
does, and a live query over the root re-runs on a write to the side. A
predicate may name an
external, which `execute()` binds from the call's `externals` — so it
isolates tenants only when the host, not the caller, supplies those
externals. One rule admits them on every surface that binds one — a
collection's `execute`, `query`, `explain` and `all`, an entity query, a
point read, and the full scan a call whose own external the database
cannot take diverts to — and one the database cannot bind as the engine
compares it is refused `JD0011` rather than dropped from the fetch: a
missing one; a `null`, a boolean, an object or an array — alone, or as an
item of a membership list — that an equality, an inequality or the
membership compares with a member that can hold one (on a collection, its
schema type admits `null` or `boolean`, or names no scalar type; on an
entity, a boolean column, or a list item `null` where the column's policy
reads a NULL as a present `null`), where the engine matches the stored
value and the database does not; a string the database would not
receive as written, which the predicate compares in its place and so keeps
another tenant's rows: one holding a lone surrogate, which a driver binds
as U+FFFD (as an item of a membership list, whose JSON escape SQLite reads
as written, on PostgreSQL only), and on PostgreSQL one holding U+0000; and
one holding a function or a symbol, which no database binds; and a list
holding an infinity, which its JSON binds as `null` where the engine's
`Infinity` equals a number another writer stored past the double range. Against a member that cannot hold it the
comparison matches nothing on either side, and the call answers — a
boolean, an object or an array in place of a single value too, which SQLite
binds as a value of no JSON kind. A predicate's integer past 2^53 keeps
the rows the engine keeps: SQLite, which reads a stored JSON integer as the
exact integer its digits spell, compares that integer with the interval of
integers that round to the external's double, bound as its two edges, and
PostgreSQL, which holds every JSON number as the decimal its writer spelled,
in a document member and in an entity's `number` or `integer` column alike,
compares it with the interval of decimals that round to that double, each
edge with the side its tie falls on, so a document keeps or loses its row as
the engine decides whatever digits its writer spelled the number by
(`1152921504606847000`, `1152921504606846976` or `1152921504606846976.5` for
2^60); on SQLite a column that holds the double (a `number` member's) takes
the number as it is. The statement is the one a safe integer binds, so it seeks
as that one does, and a document's own such external runs in it too
([ARCHITECTURE](../ARCHITECTURE.md#the-type-truth-table)). A predicate's
infinity keeps the engine's rows as well (on PostgreSQL it is the interval of
decimals at and past the midpoint between the largest double and 2^1024),
where a document's own infinity runs in the engine. One the
predicate would read otherwise than the JSON value it stands for (a `Date`
by its instant, a `Map` as `{}`), or a `bigint`, is refused `JD0041` (§10.1). `explain()` given externals
refuses what the run it explains refuses; given none, it answers the plan
with every external unbound. `all()` binds them from its own `externals`,
`all({ externals })`, and without one a predicate names it is refused
`JD0011`. A load binds none, so
a load under such a profile refuses `JD0032`, as a load whose own `where`
names one does. `maxRows` bounds every
fetch on every engine (`JD2007`), the residual's input rows included:
each root an entity residual fetches carries `LIMIT maxRows + 1`. The
graph caps are hard maxima an include's own declaration cannot exceed:
`maxIncludedRows` refuses an include that declares more rows per root
(or `Infinity`), `maxDepth` refuses a deeper load, and `maxBytes`
refuses any one item — a document, an entity row, a loaded root graph —
larger than that many serialised bytes (`JD2076`).

**The call options are a closed set.** A collection's `execute` and
`query` read `externals`, `strict`, `pushdown`, `profile`, `signal`,
`deadline` and `strictStreaming`; any other member is `JD0013` naming
the nearest one, as on `all()` and `page()`, so a misspelt `profile`
never runs unbounded. `strictStreaming: true` on `execute` is `JD0013`
too: a whole answer has no stream to hold to. An entity's `load` reads
`signal`, `deadline` and `profile`, and its specification is closed as
well (§10.4). The same holds for every other read call: a collection's
`explain` and an entity query's `execute` read the set above, an entity
cursor and an entity `explain` read it and the `tracking` its set reads,
and `loadCursor` reads `signal`, `deadline`, `profile` and `tracking`.
Each of these calls also refuses a malformed value of a control it reads
(`JD0013`): a `signal` that is not an `AbortSignal`, a `deadline` that is
not a finite number, a `strictStreaming` that is not a boolean, and
`externals` that are not a plain object. A `page` reads `limit`, `after`,
`maxBytes`, `consistency`, `lookahead`, `signal`, `deadline`, `profile` and
its set's `tracking` (§10.5); it is a graph load, one native statement that
binds no externals and has no residual, so a cursor's `externals`,
`strict`, `pushdown` and `strictStreaming` are `JD0013` there.

**The member allow-list.** `collections` says which roots a document
may read; `members` says which MEMBERS of a root it may read. It is
keyed by collection or entity name, and each value is a list in the
model's own singular index-path spelling:

```js
collection.query(doc, { profile: {
  members: { docs: ['$.id', '$.n'], User: ['$.id', '$.age'] } } });
```

A root the list does not name is unrestricted; a root the MODEL does
not declare is `JD0011` before any statement runs, because a policy
that applies to nothing is a policy failing open. Allowing a member
allows everything UNDER it (`$.address` allows `$.address.city`) and
none of its siblings (`$.address.city` does not allow `$.address`,
which would answer the rest of the address). One collector reads every
member path a document references — in `$where`, in `$orderby`, in
`$return`, in a join condition, in a registered operator's operands —
so a denial is the same `JD0011` wherever the member was named, and it
names the root, the member and the place in the caller's document.

Reading a root item WHOLE is refused, not narrowed: `$return: '$it'`,
an alias of the binding through `$let`, and a wildcard with no singular
prefix each answer members the list does not allow, and no list can
cover them. For the same reason a graph `load()`, `page()` or
`loadCursor()` over a policed entity is refused — it answers whole
documents by definition — and the refusal names the members that ARE
allowed, which the document query engine can project.

**Enforced, or refused — never approximated.** A budget the engine
can COUNT is enforced during execution: rows returned, rows
materialised, residual-input rows, included rows per root, depth,
bytes, and the engine limits. A budget SQLite cannot measure is
refused at preflight on plan shape instead: `refuseFullScan` declines
a native plan whose own `EXPLAIN QUERY PLAN` shows a full-table scan,
and declines an entity residual outright, because the residual reads
every row of every referenced root before the engine decides — that
is a full-table scan by shape, so it is refused before any fetch
rather than estimated. Visited-row and elapsed-time budgets exist
only where a driver supplies a progress or interrupt hook; the
shipped SQLite drivers supply neither, and `explain().budget` reports
`time: 'unavailable'` and `estimatedRows: 'unavailable'` rather than
a number nothing measured. On PostgreSQL `estimatedRows` of a native
plan is `{ rows, source: 'postgresql-planner' }`: the planner's own
estimate of the rows the statement's top plan node produces
(`EXPLAIN (FORMAT JSON)`, run beside the plain `EXPLAIN` of
`scanNarrative`), an estimate and never a count, which no budget
reads. It stays `'unavailable'` for a plan the engine answers, for a
statement a slot of which the call left unbound, and on SQLite
([PostgreSQL](POSTGRESQL.md)); `explainLoad` asks the server for it
there, so it answers a promise on PostgreSQL and a value elsewhere.

**`signal` and `deadline`.** `ExecuteOptions.signal` cancels: a call
already aborted issues no statement (`JD2072`), and a cursor or page
releases its statement at the next row boundary. `deadline` is an
epoch-millisecond instant checked before a statement runs and at
every row boundary of a cursor or page (`JD2075`) — a row-boundary
check, never a statement interrupt, for the reason above. The clock it
is checked against is the store's runtime record's `now`
(`@jarenjs/core/runtime`; the platform clock with no record), so a
caller under an injected clock computes deadlines from that clock.

**Provenance.** Every `explain()` — collection, entity, graph —
carries `budget`: the profile that applied and from where (`{ source:
'call' | 'store', name: 'safe' | 'custom' }`, or `null`), every bound
it imposed (`rows`, `includedRows`, `depth`, `bytes`, `limits`), the
scan verdict (`'refused-by-shape'` or `'unbounded'`), and the two
driver slots by name (`time`, `estimatedRows`). A budget nobody can
prove was applied is not a budget.

1. **Engine limits.** The four engine limits ride into every residual
   compilation, so the JavaScript portion of a query is bounded by the
   engine's own enforcement and fails with the engine's own codes. A window or
   a count the statement answers (a collection's window over a constructor of
   operators that cannot raise, §10.6, or a count of one) leaves the engine only
   the window's rows, each evaluated alone, and the count none: `maxRows` and
   `maxBytes` bound it, and a `resultItems`, `sequenceItems` or `steps` limit
   smaller than the window no longer refuses it.
2. **The mandatory row bound.** Every non-aggregate fetch carries a
   database-side `LIMIT` of `maxRows + 1`. A fetch that crosses
   `maxRows` — a result set, a residual's candidate set, a diverted
   full scan, or a k-nearest plan's candidate scan — is the coded
   `JD2007` and the result is refused WHOLE. It is never silently
   truncated. The k-nearest case is worth stating on its own, because
   the number bounded is not the one the query asked for: the plan
   scores every row the pushed `WHERE` admits before it can know which
   `k` are nearest, so "the two nearest" over an unfiltered collection
   of ten thousand is a ten-thousand-row fetch and a profile at
   `maxRows: 1000` refuses it. Narrow it with a predicate, or raise the
   bound for that query deliberately.
3. **Reference containment.** The document may reference only the
   externals, host functions and collations the profile declares, and
   only collections the profile allows; an undeclared reference is the
   compile error `JD0011`, never a runtime surprise. No UDF
   registration happens under a profile. Optionally
   (`refuseFullScan: true`), a plan whose `EXPLAIN QUERY PLAN`
   narrative shows a full-table SCAN of the collection is refused with
   `JD0011` — a structural gate, because SQLite exposes no row
   estimates to bound by.
4. **Mandatory predicates.** `predicates: { users: { $eq:
   ['$it.tenant', 'acme'] } }` conjoins the predicate into EVERY plan
   for that collection at the plan's root, after translation — the
   native statement, the residual's candidate fetch and the diverted
   full scan all wear it, so no document shape (`$or` at the top, a
   negation, a quantifier, a residual, a window, an aggregate) can
   produce a fetch without it. A predicate MUST translate natively; a
   host-configured predicate that cannot is a `TypeError` at first
   use, because there is no residual to hide it in — on a collection and
   an entity alike, one comparing a string literal that holds a lone
   surrogate, which the database would read as U+FFFD and so keep the
   rows holding U+FFFD in its place. A read of a join-table root
   translates the predicate of each side that bounds it, so an
   untranslatable one is the same `TypeError` there. On PostgreSQL, whose text and
   jsonb hold no U+0000, a predicate comparing a string literal holding
   one, or a list item holding U+0000 or a lone surrogate, has no
   statement: every query surface that would fetch with it (`execute`,
   `query`, `explain`, `all`, a cursor, a load) refuses `JD0011`, and a
   point read, which the engine judges, answers as on any store.

   A point read is judged by the same predicate. `get` on a collection or an
   entity — tracked or `asNoTracking()`, synchronous or asynchronous, on the
   store or inside a transaction — answers the row of its key only when the
   root's predicate keeps it, and `undefined` otherwise, which no caller can
   tell from a key that holds nothing (and a tracked entity `get` of such a row
   registers no snapshot). A predicate that names an external — the
   tenant-isolation spelling above — is bound from the read's own options,
   `get(key, { externals: { tenant } })`, as a query binds it from its
   `externals`; a read whose externals the query engines refuse by the rule
   above — one left unbound, a value its member can hold that the database
   compares otherwise than the engine, or a string the database would not
   receive as written — is refused `JD0011` before the row is
   read, so the refusal does not tell a key another tenant holds from one that
   holds nothing, and one a comparison would read otherwise than the JSON
   value it stands for (a `Date`, a `Map`), or a `bigint`, is
   refused `JD0041`, as on `execute`. A value its member cannot hold keeps no
   row, as the query keeps none; an integer past 2^53 is judged by the engine,
   as every point read is. The predicate runs in the engine over the one document, which
   agrees with the database's answer by the pushdown contract, so a row a query
   keeps is a row `get` keeps; the statement is the key seek it is on a store
   with no profile (the predicate costs the database nothing). The engine
   `limits` and `maxRows` are bounds on a query document and do not apply to
   it. A root the member allow-list names refuses `get` with `JD0011`, as it
   refuses a graph `load`: a point read answers the whole document. A root the
   profile keeps no predicate or member list for reads as stored. The store's
   own writes read the stored row — a patch's and a put's precondition, an
   entity update, a rule's old row — because a profile bounds what a caller
   reads, not what the store writes: a tracked `put` of a key whose `get`
   answered `undefined` still replaces the stored row. `get` takes no per-call
   `profile`, so the store's is the only one that applies to it.

   **The change feeds are host surfaces.** `store.observe`, the capture log
   (`changesSince`, `changes`) and replication deliver every record the store
   commits, whichever tenant's rows it touched, and take no profile. A read
   profile does not bound them because they are not a caller's read of rows:
   a feed reports what was WRITTEN, in commit order, to a consumer the host
   wires up — a cache, a replica, an audit log, a search index — that must
   see every change to stay correct, and a record it skipped would silently
   desynchronise it. A predicate also cannot judge a record as it stands: one
   record is a commit's RFC 6902 patch over `/<table>/<key>/…` pointers, which
   can touch several tenants' rows at once, a `remove` carries no document,
   and a row whose `tenant` member was rewritten would leave a tenant's view
   without a record saying so. A host that relays a feed to a tenant bounds
   it at the relay: it subscribes once, keeps for each connection only the
   operations whose rows the tenant may read — judged by the key, through
   `get(key, { externals })` with the tenant the connection authenticated (the
   value it binds as that tenant's query `externals`), or by its own mapping
   of keys to tenants for a removed row — and never hands the feed itself to a
   caller. A live query (`live()`) is not a feed: it re-runs its document
   through `execute` under the store's profile (above). The same holds for
   the store's trusted surfaces over the physical tables — `store.relational`
   (structural SQL, [SQLITE-RELATIONAL](SQLITE-RELATIONAL.md#through-a-store)),
   and `backupTo`: they read every row, whatever profile
   the store was opened with, and a host never hands them to a caller whose
   reads the profile bounds.

**Read-only stores.** `openStore(model, { readOnly: true })` opens the
connection read-only at the DRIVER, so every write is refused by the
database itself (`JD2083`, class `readonly`, wrapping `SQLITE_READONLY`), not merely by
the API surface — a translation bug cannot become a write. On PostgreSQL
the driver sets the session's `default_transaction_read_only` for the
store's life (restored at close), so every transaction the store runs is
`READ ONLY` and a write is the server's 25006, the same `JD2083`; a patch
reads its row under a row lock there, which a read-only transaction
refuses too, so on PostgreSQL even a patch that would change nothing is
`JD2083`, where SQLite answers it. A read-only
store verifies the declared shape and creates nothing (`JD0002` when a
table is missing), and leaves the file's journal mode untouched.

**The non-claims, stated plainly.** This profile does NOT claim:

- a statement timeout on the SQLite drivers — `node:sqlite` and
  `bun:sqlite` expose no interrupt and no progress handler, the
  `statementTimeout` capability is `false`, and a long-running
  database-internal computation (a native aggregate over a large
  table) is bounded by nothing here. PostgreSQL's effective server timeout is
  reported separately; it does not turn a row-boundary AbortSignal into an
  interrupt. See [PostgreSQL host ownership](HOSTS.md#postgresql-sessions).
- a row-estimate bound — SQLite's plan output is prose and
  PostgreSQL's estimate is a planner estimate that can be far from the
  count, so the structural SCAN refusal is the honest substitute on both.
- safety for arbitrary untrusted SQL — none can be expressed.
- tenant isolation without the mandatory predicate — a shared database
  is NOT safe for mutually hostile tenants unless the profile carries
  one.

The containment story on SQLite is exactly this composition: engine
limits (bounding the residual portion), the mandatory `LIMIT`, the
optional SCAN refusal, the allow-lists, and the mandatory predicates.
Each bound is proven to fire by the hostile-input suite, and the store
is proven usable after every refusal.

### 8.1 Registered operators run in the residual

A store MAY open with a registry (`createJsltRegistry()` from
`@jarenjs/json/jslt`, or raw `functions` / `extensions` maps), and its
operators — `$npv`, `$mean`, `$sqrt`, … — become engine vocabulary a
query or entity document may use:

```js
import { createJsltRegistry, financePack, statsPack } from '@jarenjs/json/jslt';
const store = await openStore(model, {
  driver,
  operators: createJsltRegistry().use(financePack).use(statsPack),
});
store.capabilities.operators; // ['$npv', '$irr', …, '$mean', …]
```

A registered operator is a vocabulary extension of the **engine**, and
the engine runs against a store in JavaScript over the fetched rows —
the **residual**. So in this ring every registered operator is
**correct everywhere and accelerated nowhere**: the planner recognises
its name (it is not the unknown-operator error `JQ0002`), keeps it in
the residual, compiles the residual with the same registered
`{ functions, extensions }`, and `explain()` names it as the reason the
query did not translate natively — never silently:

```js
store.collection('deals').explain(doc).residual.reasons;
// [{ construct: '$npv', reason: "registered operator '$npv' runs in the
//    residual (Ring 2 — correct, not pushed to SQL)" }, …]
```

The result is identical to the same document run over the same rows by
the in-memory engine — differential-tested — and to the direct core
function. The pushable subset of these operators can be accelerated into
SQL where the driver allows — §8.2 — but that is an optimisation layered
over this residual, never a change to the answer.

**Profile interaction.** A first-class registered `op`/`agg` (a native
operator like `$npv`) is host-provided machinery — the store owner
registered it, not the foreign document — so it is **allowed by default**
under a profile, exactly as the internal `$apply` is. What the profile
still governs:

- the mandatory bounds apply to the residual as always: a registered-
  operator query fetches at most `maxRows + 1` candidate rows and is
  refused with `JD2007` past `maxRows`; the mandatory predicate still
  conjoins into the candidate fetch; engine limits still bound the JS;
- the profile's `functions` allow-list still governs a registered `fn`
  reached through `$call` — a `$call('clamp', …)` name must be declared
  in `functions`, or it is the compile error `JD0011`, because a `fn` is
  a host function like any other. Only the first-class `op`/`agg`
  operators are exempt.

Without a registry the store is byte-identical to before: a document
using `$npv` fails `JQ0002`, and `capabilities.operators` is `[]`.

### 8.2 SQL pushdown of the pushable-scalar subset (driver-gated)

A pack marks each entry `pushable: 'scalar'` (a per-row scalar function —
the math ops), `'aggregate'`, or `false`. Where the driver has user
functions, a `pushable:'scalar'` operator used in a **WHERE predicate**
is registered as a SQLite **deterministic UDF** and the plan emits the
call (`… WHERE jaren_p_<hash>(json_text(doc))`), so SQLite drives the row
iteration and the operator runs inside the callback — instead of every
candidate row crossing into the residual. It is the same compiled engine
fragment either way, so the answer is identical by construction; the
only question is where the loop runs.

The per-driver capability matrix — read once at open, on
`store.capabilities`:

| capability | node:sqlite | bun:sqlite | wasm |
|---|---|---|---|
| `userFunctions` (scalar UDF) | ✅ | ❌ | probed |
| `aggregateFunctions` (aggregate UDF) | ✅ | ❌ | probed |
| `pushableOperators` | the scalar subset | `[]` | scalar subset if `userFunctions` |

On **bun:sqlite** there is no UDF API, so `pushableOperators` is `[]` and
every registered operator is the residual (§8.1) — no failure, the same
result, reported by capability. What has a native spelling never needed the
function: a comparison of two member paths the schema types as scalars
(`string`, `number`, `integer`, `boolean`, each optionally with `null`),
across JSON type families, and a literal `$get` over the binding or over a
member the schema types `object`, plan native on every driver in a collection
query — two present values are equal when they are of one family and equal
there, differ otherwise, and order only as two numbers or two strings, and an
absent member answers `false` for every operator — so `bun:sqlite` and
PostgreSQL answer them in the database and `node:sqlite` no longer registers a
function for them. A comparison of two paths when either is typed as an object
or an array, or not typed, a `$get` over an untyped target, and a string
operator (over a path or a `$get`) over a member that can hold another kind keep the
function on `node:sqlite` and the residual elsewhere, named
(`predicate.joinTerritory`, `predicate.operands`, `predicate.existence`,
`predicate.stringSubject`); an untyped path against a literal or an external
plans native as it always did. An entity query keeps its plain comparison of
two members of one non-null number or string family and refuses every other
pair as before. A **profiled (untrusted) document never
triggers host-side registration** — the UDF hatch is gated on `profile
=== null`, exactly as the engine-internal hatch is; a profiled `$sqrt`
predicate runs in the residual.

**When it wins — measured, published honestly.** The push narrows *before*
rows cross into JavaScript, so it wins exactly when something else
narrows too (20 000 rows, node:sqlite, median ms):

| shape | pushed | residual | verdict |
|---|---|---|---|
| solo `$sqrt` predicate, ~20 % match | 22 | 21 | ~even |
| solo `$sqrt` predicate, ~90 % match | 41 | 23 | residual **1.75×** |
| indexed `$eq` **and** `$sqrt` (5 % pass the index) | 5.2 | 21 | push **3.9×** |
| `$sqrt` predicate with `LIMIT 10` | 0.03 | 21 | push **615×** |

So a `$sqrt` predicate beside a selective native predicate or a `LIMIT`
is a large win; a `$sqrt` predicate that is the *sole* filter of a full
table scan is a wash to a modest loss (the UDF re-parses each row in the
callback). **The push is not gated behind a cost heuristic**, because
SQLite exposes no row estimates (`capabilities.rowEstimates` is `false`)
to build one on — a crude guess would be dishonest. It pushes
deterministically and this profile is published so the shape of the win
is known; add a narrowing predicate or a `LIMIT` and the push pays.

**`pushable: 'aggregate'` — the whole-sequence fold, in SQL.** A pack
entry marked `'aggregate'` is lowered to a registered **SQL aggregate**
where the driver has one (`capabilities.aggregateFunctions`): the plan
emits `… SELECT jaren_a_<hash>(<the member's column>)`, SQLite drives
the accumulation, and the SAME pure function the residual would call
folds the values it collected. `$mean`, `$median`, `$variance` and
`$stddev` of the statistics pack carry the token.

The token is a promise about the FOLD, and three rules enforce it:

- **order-insensitive.** A SQL aggregate visits rows in an order
  nothing specifies, so only a summary whose value depends on the
  multiset alone may be declared pushable.
- **one sequence operand.** A SQL aggregate's final step sees only what
  the row steps accumulated, so a second operand does not reach a fold
  over zero rows. An entry declaring anything but a single
  `'seq<number>'` operand and a `'number'` result is a `TypeError` at
  `openStore`, naming the operator — loud, rather than a silent
  non-promotion. `$percentile`, whose second operand is the percentile,
  is therefore `pushable: false` and folds in the engine.
- **a numeric member that cannot hold `null`.** SQL cannot tell a
  stored `null` from an absent member and the engine's sequence can, so
  the promotion needs a schema-typed numeric path that admits no `null`,
  as the core `$sum` and `$avg` do (which push only over an `integer`
  path, §10.6). An absent member contributes nothing on either side.

A registered fold inside a `$groupby` return is not promoted — the
grouped SQL fold currently handles the built-in aggregate set only — and
neither is an aggregate under a window. Both answer what the engine answers,
and `explain()` names the reason. As with the scalar hatch, a profiled document triggers no
registration: the same `$mean` under a profile folds in the residual,
and `strict: true` refuses it by name (`JD0010`).

**The same profile for a spatial predicate.** A `$within` against a
LITERAL region takes the hatch only on a collection that declares **no**
derived spatial index on the member: where one is declared the
promotion (§2.1, `explain().prefilters`) takes the conjunct first and
the hatch is consulted only for a refused one, and an external region
never qualifies — a deterministic function must not close over
changing state. Measured on the same terms as the `$sqrt` rows
(`benchmark/spatial.js`: 50 000 stored points, ~0.5 % selectivity,
mean of 20 executions after a warm one; the residual comparator
pushes everything BUT the spatial conjunct):

<!--fact:spatial.udfTable-->
| shape | pushed (ms) | residual (ms) | verdict |
|---|---|---|---|
| solo `$within` over a full scan | 101 | 76 | ~even |
| indexed `$eq` **and** `$within` (~5 % pass the index) | 6.2 | 56 | push **9.0×** |
| `$within` with `LIMIT 10` | 104 | 73 | ~even |
<!--/fact-->

So the spatial hatch <!--fact:spatial.udfVerdict-->earns its row: 9.0× beside the selective conjunct and 0.7× under the LIMIT<!--/fact-->,
by the same rule as `$sqrt`: a sole `$within` over a full scan is a
loss (the UDF re-parses every row in the callback, and the exact
containment test is dearer than a square root), a `$within` beside
something that narrows first is a large win. The solo shape is the one
a derived index answers — declare `derive: 'bbox'` on the member and
the same predicate becomes a box seek plus a refinement over the rows
it returns, which is faster than either column above.

**The honest ceiling.** A `pushable:false` operator (a whole-series
`$npv`, an `$sma`) is never a UDF — it stays the residual, `explain()`
lists no `udfs` for it, and neither does a `pushable:'aggregate'` entry
whose shape the store refuses (above). A registered aggregate lowers
only as the top-level fold of a whole selection: inside a `$groupby`'s
`$return` the closed BUILT-IN set is what SQL groups by, and a
registered summary there stays the engine's.

## 9. Entities, the `x-entity` vocabulary, relations

### 9.1 Scope, and the phase-A relationship

An **entity** is a generalisation of a collection, not a replacement:
a collection is an entity whose every property is JSONB and which
declares no relations, and one physical engine sits underneath both.
A model document MAY declare `collections`, `entities`, or both, and
a phase-A store document opens unchanged under the entity engine
(test-asserted). Entities live under `entities`, keyed by identifier
names:

```json
{
  "$model": "0.1",
  "entities": {
    "User": {
      "schema": {
        "type": "object",
        "required": ["id", "email"],
        "properties": {
          "id":      { "type": "string", "x-entity": { "key": true, "default": "uuid" } },
          "email":   { "type": "string", "format": "email",
                       "x-entity": { "unique": true } },
          "created": { "type": "string", "format": "date-time",
                       "x-entity": { "default": "now", "column": "integer", "index": true } },
          "profile": { "type": "object" },
          "posts":   { "x-entity": { "relation": { "to": "Post", "many": true,
                       "via": "authorId", "onDelete": "cascade" } } }
        }
      }
    }
  }
}
```

The schema stays a valid JSON Schema throughout: strip every
`x-entity` member and it accepts and rejects exactly the same values
(test-asserted over a corpus). The vocabulary is invisible to the
validator by the same argument as `x-form`. A model document may also
be written by code — `@jarenjs/linq/model`'s `defineModel()` emits
exactly this document ([MODEL-PEN.md](../../linq/docs/MODEL-PEN.md)), and this section stays its
one specification.

### 9.2 The `x-entity` vocabulary (a closed set)

| member | on | meaning |
|---|---|---|
| `key` | a property | this property is (part of) the primary key; several form a composite key |
| `unique` | a property | a unique index over the property's column |
| `index` | a property | a non-unique index over the property's column |
| `default` | a property | applied on write, in JavaScript (§9.6): `"now"` (insert stamp), `"updated"` (insert AND every update), `"uuid"`, `"auto"` (single INTEGER key, database-allocated), `{ "value": … }` (a literal), `{ "query": … }` (a query document over the document being written) |
| `column` | a property | storage override: `"integer"` on a `date-time`/`date` string stores epoch milliseconds in a real column (index-friendly range predicates); `"json"` keeps a scalar in the JSONB document (the opt-out that preserves present-`null`, §9.3) |
| `relation` | a property | `{ to, many?, via?, through?, onDelete? }` — §9.4 |
| `version` | a property | the optimistic-concurrency token (§11.5): a plain integer column, one per entity, never the key — engine-owned and bumped on every successful write |

**`unique` and `index` are the one-column shorthand; an entity's
`indexes` member declares the rest.** A rule such as "one active shift
per employee per day" is one composite, partial, unique index, which
both engines create, enforce for every writer — the store and a raw SQL
client alike, a violation being `JD2005` of class `constraint` — and
verify on every open:

```json
{
  "Shift": {
    "schema": { "type": "object", "required": ["id", "employeeId", "day"],
      "properties": { "id": { "type": "string", "x-entity": { "key": true } },
        "employeeId": { "type": "string" }, "day": { "type": "string" },
        "status": { "type": "string" } } },
    "indexes": [{ "name": "one_active", "path": ["$.employeeId", "$.day"], "unique": true,
      "where": { "$eq": ["$.status", { "$seq": ["active", "pending"] }] } }]
  }
}
```

SQLite creates `CREATE UNIQUE INDEX "Shift_one_active" ON "Shift"
("employeeId", "day") WHERE "status" IN ('active', 'pending')` — a
plain membership, from which the engine proves the index serves a query
that names the same list — and PostgreSQL the same index. A second
active or pending shift of one employee-day is refused; a cancelled
shift and one without a status are not. §13's invariants could not say
this: a rule reaches another row only through `$exists-row` (§13.2),
keyed by that row's primary key, and a check in application code
inside the writing transaction lets a concurrent writer slip past it.

- An entity index is a closed object: `name`, `path`, `unique` and
  `where`; any other member is `JD0005` at the member. `derive`,
  `precision`, `dims` and `physical` are recognized first and refused
  `JD0004` — they need a generated column, which an entity table never
  has. `expression` in place of `path` keys a declared function over
  string members: an index PostgreSQL keeps and SQLite refuses `JD0004`
  (§7A).
- `name` is an identifier, unique within the entity; the index is
  named `<Entity>_<name>`, in the one namespace every name a model
  plans shares (§2) — the same name as a `unique` or `index`
  property's `<Entity>_<member>` is `JD0004`.
- `path` is `$.<member>`, or a non-empty array of them for a composite
  index in that order, over members with a column of their own: a mapped
  scalar, a foreign key's `via` column, an epoch (`column: "integer"`)
  member. A member the document keeps, a nested path and a relation are
  `JD0004` naming the member: map it as a column.
- A member of any name — `日本`, `é`, `123`, `a b`, one holding a quote, a
  bracket or a backslash — is written in the bracket spelling,
  `$['<member>']` or `$["<member>"]`, a quote or a backslash in the name
  escaped as a JSONPath (RFC 9535) quoted name escapes it (`$['it\'s']`,
  `$['a\\b']`). The model reads every index path, condition operand and rule
  operand through the query language's own path grammar, so any spelling of
  one member it reads (`$.日本` included) names that member, and two spellings
  of one member are one path. The generated SQL quotes the member's column as
  an identifier on both engines, and a model whose members are all identifiers
  plans the SQL it planned before.
- `where` is the condition of §2's partial index, over the same
  members minus the epoch ones (the column holds milliseconds, the
  condition would compare the member's text), each written `$.<member>` or
  `$['<member>']`; a member named `op` is read there as any other (in a rule
  `$.op` is the operation), and `$.old.<member>` and `$.new.<member>` are a
  rule's records, which an index condition refuses. Every operand is read as
  stored: a member a row lacks is SQL NULL, never equal, unequal or
  ordered; a boolean compares the stored `1` or `0`, on both engines.
- The mapping keeps one-column entries apart: `explainMapping()`'s
  `entities[E].indexes` lists the `unique` and `index` properties
  exactly as before, and the entity-level indexes are
  `entities[E].entityIndexes` (`{ name, columns, unique, where? }`; one
  over an expression has no `columns`, and carries its `expression` and
  the columns it `reads`). A
  composite or partial unique index never anchors a pagination cursor
  (§10.5): it is not a unique column.
- Every open verifies the index: SQLite compares the stored CREATE
  text, and PostgreSQL, which keeps none, reads the condition back out
  of its catalog through one exact condition reader and compares it with
  the planned one, and checks the index is the plain ascending B-tree the
  plan creates (no `NULLS NOT DISTINCT`, no key order, collation or
  operator class of its own, no `INCLUDE` column, no deferred check). A
  changed, dropped or added condition — a
  `NOT` without the `COALESCE` the rendering writes, a literal another
  decimal spells — and a condition that does not read, is `JD0002`.
- A changed index — its uniqueness, its members or its condition — is a
  migration: the planner drops and recreates it, a table rebuild
  recreates it with its condition, and adding a unique index over rows
  that violate it is the engine's refusal (`JD0023`, class `constraint`)
  ([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities)).
  `introspectModel` derives the index back: a one-column index named
  `<Entity>_<member>` that is exactly the index the flag plans is that
  property's `unique` or `index`, and any other one an `indexes` entry,
  its condition read back only where it renders to exactly what the
  database holds, in the reader's canonical form (a boolean as the stored
  `1` or `0`, a one-item list as `$eq`, nested `$and`/`$or` flattened, a
  member that is no identifier as `$["<member>"]` — equal in meaning and
  rendered SQL). A `unique` or `index` flag on such a member reads back as
  the flag. An index no model declares — an
  `INCLUDE` column, an operator class, collation or key order of its own,
  a name another planned object takes with case folded — stays an
  `unmapped-index` row. The derived model types a member as its column
  reads back, so a `lossy-type` column plans a table rebuild back to the
  declared type, and on PostgreSQL a derived `boolean` member (`smallint`,
  read as an `integer`) reopens the database only once it is typed
  `boolean` again (`JD0002` until then).
- A layout an application owns (§12) declares its indexes in
  `physical.indexes`; `indexes` beside `physical` is `JD0004`. The mapping
  reports them as `entities[E].declaredIndexes` (`{ name, unique, partial,
  columns, members, sql, where?, expressions? }`): each term's column by its
  physical name and by the member it maps (an expression term, or a column
  the layout does not map, `null` in both), whether the index declares a
  condition, the statement whose text SQLite compares, the declared
  condition itself and, where a term is an expression, each term's `$sql`
  expression (`null` beside a column term): the `$sql` terms PostgreSQL
  renders to compare (§12).

**An unknown member of `x-entity` is `JD0030` with a `docPath`.** A
silently ignored mapping directive is a data-loss bug waiting to
happen, so this vocabulary is deliberately stricter than the
validator's ignore-unknown posture — the strictness is local to the
one namespace this package owns. The flags `key`, `unique`, `index`
and `version`, and a relation's `many`, are `true` or `false`: any other
value is `JD0005` at the member (`'true'` used to read as `false`,
dropping a property from a composite key or an entity's version guard).
The entity declaration around the schema is closed as well (§2).

The vocabulary is closed in POSITION as well as in name: `x-entity` is
read on an entity's top-level property schemas, including their `allOf`
branches and resolved local `$ref` targets. Within a property schema, a mapping
block at an unread position — under nested `properties`, `items`, `anyOf`, or an
unused local `$defs`/`definitions` entry — is `JD0030` at its `docPath`.

Only schema keyword positions declare mapping blocks. Property, pattern and
definition names are data: `properties: { "x-entity": { "type": "string" } }`
declares an ordinary property. Values under `const`, `enum`, `default`,
`examples` and other annotations likewise keep their literal members; an
`"x-entity"` key inside such a value is not a mapping directive. The migration
planner preserves these names and values when comparing document schemas
([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities)).

### 9.3 The hybrid mapping

Stated once, mechanically applied, and returned as data by
`explainMapping(model)` so it can be golden-tested and printed:

| Schema shape | Storage |
|---|---|
| scalar (`string`/`number`/`integer`/`boolean`) at the top level | a real typed column |
| `format: date-time`/`date` with `column: "integer"` | an epoch-milliseconds `INTEGER` column; the document keeps the RFC 3339 string, the column carries the derived epoch |
| `enum` of scalars | a column plus a `CHECK (column IN (…))` — a `null` member of the enum is left to the column's nullability, never written into the list. The set names the column's type, so `{ "enum": ["draft", "open"] }` with no `type` is a `TEXT` column; a set MIXING JSON types has no one column type and goes to the document, like a union |
| a union of several scalar types (`['string', 'integer']`) | the JSONB document — a column has one affinity and a union has several; `['integer', 'null']` is that scalar, nullable |
| a nullable member spelled as a union, `{ "anyOf": [{ "type": "string" }, { "type": "null" }] }` | the JSONB document, while `{ "type": ["string", "null"] }` gets a nullable column — the mapper reads the spelling, not the value set (below) |
| nested object / array, or `column: "json"` | the JSONB document column, queryable by path exactly as in phase A |
| relation | a foreign-key column, or a join table for many-to-many (§9.4) |

A column takes its member's name, so a member named like the table's own
document column (`doc`), like its row identity column on PostgreSQL
(`rid`), or like another member as the engine compares names (SQLite folds
ASCII case: `Id` beside `id`) is `JD0004` at the member when the model is
planned, never the engine's own duplicate-column error (§7).

**The two nullable spellings map differently, and stay that way.** Forms,
the contract diff and the contract transport read `type: [T, 'null']` and
a two-branch `anyOf`/`oneOf` with a null-only branch as one meaning, through
`@jarenjs/core/schema`. The mapper does not, because its reading is
persisted: the union keeps the member in the document, and the type array
gives it a column. An upgrade never moves a member between them. Changing a
member's spelling is a physical migration, so plan it as one.
`planModelMigration` writes it both ways. Union → type array adds the
column and moves the value out of the document. Type array → union folds
the value back into the document and drops the column. Each plan ends with
a draft transform step for the changed document schema.

`STRICT` tables throughout. The physical row is the key column(s),
the mapped scalar columns, and one JSONB `doc` column holding
everything else; a read merges them back. **The absent-versus-null
rule, plainly**: for a column-mapped scalar, JSON `null` and absence
both store as SQL `NULL` and read back as ABSENT. A property that
needs present-`null` semantics declares `column: "json"` and stays in
the document. The rule reaches the WRITE's return value, not only the
read: `create()`, `update()` and `add()` answer the document a read
would answer, so a `null` handed in for a column-mapped scalar is
absent from what comes back — a returned object never names a member
no read will show. An epoch column (§9.3's `column: "integer"` row)
keeps its string in the document, present-`null` included.

**A column stores well-formed text.** A driver binds a string to a column
as UTF-8, which has no spelling for a lone surrogate (one half of a UTF-16
pair without the other): the column would hold U+FFFD in its place, and a
read would answer another string than was written. A write that would put
one in a column — a mapped scalar, a key, a foreign key, a `physical`
layout's column, through `create`, `update`, `saveChanges()`, a physical
transform's output or a native mutation's assignment, value or key — is
therefore refused `JD2003` naming the member, and nothing is written (a
save holding one such record writes none of its records); a key no write
can store names no row, so a read by it answers absent, and `remove` or
`link` refuses it (`JD2003`) where it stages it. A collection's key column
is such a column too: `insert` and `put` of a key holding a lone surrogate
are refused `JD2003`, and `get`, `patch` and `delete` by one answer
`undefined`, `JD2006` and `false`, as for a key that holds nothing — never
the document of the key spelled with U+FFFD. A member the document holds keeps
the surrogate (its JSON escape is well-formed text), and SQLite stores
U+0000 in a column as written (PostgreSQL refuses it, `JD2005`).

**What an epoch column is for, exactly.** It is an index-friendly
PRE-FILTER, not a second source of truth. The stored RFC 3339 string in
the document is the value; the column is the instant derived from it.
So a range predicate compiles to BOTH — the column narrows the rows
through its index, and the document string decides the comparison:

```sql
WHERE "r"."startsAt" >= ?                                  -- the index
  AND jsonb_extract("r"."doc", '$."startsAt"') >= ?        -- the answer
```

An ORDERING over such a member compiles to the document string alone,
and this is deliberate rather than an oversight. Ordering has no
"narrow, then decide" form: whatever the `ORDER BY` names IS the
order. The two disagree whenever the stored strings are not in one
canonical form — `2026-01-01T12:00:00+01:00` sorts after
`2026-01-01T11:30:00Z` by codepoint and before it by instant, and
`…T12:00:00Z` and `…T12:00:00.000Z` are one instant and two strings.
Ordering by the column would therefore answer a different order than
the same member's predicates compare by, and than a collection or an
in-memory residual sorts by. The engine's order for a `string` member
is its codepoint order, everywhere, whatever column shadows it.

The consequence to plan for: an ordering on an instant member does not
use that member's index. A list that wants "most recent first" from an
index orders by a plain `integer` column the application owns and
writes monotonically (a creation sequence), and uses the instant
member in predicates, where the shadow column does its work.

### 9.4 Relations and referential integrity

Declared on one side, inferred on the other; when both sides declare,
the inverses MUST agree (`JD0031` on any contradiction).

What counts as "the same edge" is decided by `via`, not by the pair of
entity names: two declarations pair up when they name the same
foreign-key property, and a pair is one `many` side and one `one`
side. Two `many` sides, or two `one` sides, on one `via` is `JD0031`,
and a paired edge must agree on `onDelete`.

Between one pair of entities, a `many` declaration facing a `one`
declaration with a DIFFERENT `via` is `JD0031` as well (the pair
disagrees on its key) — the check is per entity pair, so **two
one-to-many edges between the same two entities declare their inverse
on ONE side only**. The author-and-editor model is written with both
edges on `User` (`authored` by `authorId`, `edited` by `editorId`) and
the foreign-key properties on `Post`, or with both edges on `Post` and
none on `User`; declaring `Post.author` AND `User.edited` makes
`User.authored` face `Post.editor` and is refused. Two declarations of
the SAME kind with different `via`s are two independent edges — which
is how a legitimate cycle is written (`Post.author` by `authorId` and
`User.featured` by `featuredPostId`, one-to-one each way).
Many-to-many pairs must agree on the join table, and a many-to-many
facing a foreign-key relation is `JD0031`. A join table holds one edge: its
two inverse declarations at most, so the same pair declared twice under the
implicit name, or two pairs given one `through`, is `JD0031` naming both
relations (each edge takes a `through` of its own).

- **one-to-many** — `{ to, many: true, via, onDelete }`: `via` names
  the foreign-key property on the TARGET entity (`authorId` on
  `Post`). If the target declares that property it MUST be a
  column-mapped scalar of the key's type; otherwise the column is
  inferred.
- **one-to-one** — `{ to, via, onDelete }` (no `many`): `via` names
  the foreign-key property on the DECLARING entity, and its column is
  unique. A lone declaration is always one-to-one; the same key is the
  many-to-one side only when the target declares the inverse
  `{ many: true, via }`, which drops the uniqueness.

Every foreign-key column is indexed (unique for a one-to-one). An
`index` or `unique` declared on that column is the SAME index, never a
second one: `unique` wins, and `unique` on the key of a one-to-many
edge is `JD0031` (children share their parent).
- **many-to-many** — `{ to, many: true, through? }` (no `via`): a
  join table, named `through` when given, otherwise the deterministic
  `<A>_<B>` with the entity names sorted — implicit names are exactly
  the thing teams later regret, so the explicit name exists. Its two
  foreign keys cascade on delete (join rows die with either side; not
  configurable in this version). The name of a collection, an entity or a
  join table is never one of the engine's own tables (`_jaren_migrations`,
  `_jaren_migration_identity`, `_jaren_changes`, `_jaren_changes_state`,
  `_jaren_jobs`, `_jaren_job_checkpoints`, `_jaren_owner` and the replication
  tables), compared with ASCII case folded: `JD0004`.

`onDelete` is REQUIRED wherever a foreign-key column is created —
`"cascade"`, `"restrict"` or `"setNull"` — never defaulted silently.
`"setNull"` over a foreign-key property the entity's schema lists in
`required` is `JD0005` at the relation's `onDelete`: the database's set-null
would store a row that schema rejects, and `get` would answer it without the
member. Referential integrity is real SQLite foreign keys:
`PRAGMA foreign_keys = ON` is set AND VERIFIED per connection (it
defaults off), a violating write fails with the wrapped database
error, and the declared on-delete behaviour is observed by test.

### 9.5 Identity

Per entity, by the key properties (platform primitives only):
caller-supplied (any scalar key, composite included);
`default: "uuid"` on a single string key (`crypto.randomUUID()`);
`default: "auto"` on a single integer key (the database allocates —
an index-locality choice, documented as NOT a sortable-id guarantee).
Composite keys are ordinary: mark several properties `key: true`;
reads and deletes take `{ prop: value, … }`.

**An `auto` key is allocated on both engines, differently.** SQLite
allocates through the key's `INTEGER PRIMARY KEY` (the rowid), PostgreSQL
through a `bigserial` key column; a foreign-key or join-table column that
references such a key is `bigint` there, so the constraint stays
implementable. SQLite hands out the largest key plus one: a number a
rolled-back insert drew is handed out again, and a key written explicitly
is never met. A PostgreSQL sequence lives outside the transaction: a
rolled-back insert leaves a gap, and it does not see a key written
explicitly — the allocation that reaches one is `JD2001` ("under the key
the database allocated") and the next moves past it, so explicit keys
beside allocated ones belong outside the range the sequence will reach. A
PostgreSQL edit that gains or drops `auto` is planned
([MIGRATION-FORMAT §9](MIGRATION-FORMAT.md#9-relational-changes-entities); SQLite
plans nothing, its rowid allocates either way): gaining locks the key's table,
converts every column that references the key, then the key, to `bigint`,
gives the key a sequence it owns as its default (an identity needs none), and
continues the sequence past the highest stored key; dropping removes the key's
identity and default, converts the key and then every referencing column to
`numeric`, and drops the sequence the key owned, so an entity or a join table
the edit adds can reference the key. A stored key a conversion would
round (a fraction, a number beyond a `bigint`) refuses the gain, naming the
key and the value (`JD0023`), and nothing changes. A PostgreSQL table an
earlier release created declared the key `numeric` with no allocation, and one
an earlier release migrated keeps whatever allocation it had: either opens,
explicit keys work, and a write that leaves the key to the database over a
column with no default and no identity (a default of any kind is taken to
allocate) is refused by name (`JD2002`) before any statement; the open decides,
so a store opened before the column was converted says to reopen
([upgrade](MIGRATION-UPGRADE.md#allocated-entity-keys-on-postgresql)).

### 9.6 Defaults

Applied on write in JavaScript, never by SQL `DEFAULT`, so the value
the application sees and the value stored are the same — and the
behaviour is identical on every driver. `"now"` stamps an RFC 3339
UTC string on insert when the property is absent — the calendar date
alone (`YYYY-MM-DD`) on a `format: date` property, so the stamp
validates against its own format; `"updated"` stamps
on insert AND on every update, always; `{ "value": … }` fills a
literal when absent; `{ "query": … }` evaluates a query document over
the document being written. Defaults run BEFORE validation, so the
injected hook sees the completed document — with one member exempt: a
store-allocated key (`default: "auto"`) is allocated by the database
AFTER validation, so a write validates against the schema with that
key dropped from `required` (the generated input type marks it
optional for the same reason); the document the store answers carries
it, and the read shape keeps it required. A `version` property is
engine-owned and never defaulted by the caller: an insert without one
writes `0` — not SQL `NULL`, which no `WHERE version = ?` guard could
match — and every successful write bumps it (§11.5). A migration that
adds a `version` property to an entity already holding rows starts
those rows at `0` for the same reason (MIGRATION-FORMAT §3).

A **nullable column-mapped scalar** is dropped from `required` for
write validation as well, and for a reason the key's carve-out shares:
§9.3 stores JSON `null` and absence alike as SQL `NULL` and reads both
back ABSENT, so the storage keeps no distinction a write could be held
to — and requiring it would refuse the store's own read-modify-write,
since the document a read answers omits the member. A nullable member
that stays in the DOCUMENT (`column: "json"`) keeps its `required`
entry, because there `null` round-trips as `null`.

### 9.7 Error-code additions

The entity engine adds four codes to the package's single table (§7):
`JD0030` — an unknown or unread `x-entity` member; `JD0031` — relation
declarations whose inverses contradict; `JD0033` — an entity query
document that binds no entity array (§10.1); `JD0034` — a cursor asked
to track (`tracking: true`) over a document that yields no entity
document to register: a projection, a count or a window (§10.1, the
cursor). Everything else raises the
existing codes: `JD0005` for structural model defects (a key, index or
version property without a column of its own, a default on a relation,
`default: "auto"` off the key, a self-referencing many-to-many, a
foreign key onto a composite key), `JD2001` for a duplicate key on
`create()` exactly as on a collection `insert`, and `JD2005` for
database-refused writes including foreign-key violations.

## 10. Relational translation

Phase B's planner extension: entity query documents translate to
selections and joins over the hybrid tables, and graph loading is one
statement. The residual rule is unchanged — anything not proven
translatable runs the set residual over the fetched entity root,
`explain()` says so, and `strict: true` refuses it (`JD0010`).

### 10.1 Entity query documents

`store.execute(document)` queries the **multi-entity root**: the
engine-side value is `{ <EntityName>: [documents…], … }` and bindings
range over `$.<Entity>[*]`. A document that binds no entity array at
all — a `$for` over a member the model does not name, or over a
scalar — is `JD0033` at compile, never an empty answer. The
array-constructor spelling `["$.<Entity>[*]"]`, which `@jarenjs/linq`
emits so that an item that is itself an array stays one item
(QUERY-PEN §3), names the same whole-entity source; the planner
reads through it for collections (`["$[*]"]`) and entities alike.

Every collection and entity view carries its own source under the
symbol **`STORE_SOURCE`** (exported by `@jarenjs/db`): a frozen
`{ kind: 'collection' | 'entity', name, store }`, the same on the store's
view, a transaction's and the synchronous twin, and on any surface spread
from one. `store` names the database the store reads, compared by value:
`sqlite:` and the file's canonical name as SQLite reports it (absolute,
symbolic links resolved), or `postgres:` and the server address, port,
database and schema the store's connection reads. A shared-cache
in-memory SQLite database (`file:NAME?mode=memory&cache=shared`, or
`file::memory:?cache=shared`) opened by the Node or Node worker driver is
held by this process's SQLite library, so every such store over the name
reads it: `sqlite-memory:` and the URI's VFS parameter (`null` when it
names none) and decoded name as JSON, `sqlite-memory:[null,"NAME"]`. Two
stores over one database are one source and two databases are two. A
private in-memory SQLite database has no name a second store could share:
its stores carry a symbol of their own, so two of them are always two
sources; so do the stores of a shared-cache URI through any other driver,
which holds a database of its own under the name (the child process
driver, a wasm module; `bun:sqlite` opens the URI as a file of that name,
named by its path). Two stores over one database can still carry two
names, and a chain from one is then refused on the other as from another
database, never answered from the wrong rows: one SQLite file through two
hard links (the second open fails `JD0002` in WAL mode, the default; a
rollback journal mode opens both), and one PostgreSQL server reached
through two addresses (over a unix socket the server reports no address,
and over the IPv4 and the IPv6 loopback two different ones). The server's `system_identifier` does not name it
instead: a streaming standby, a restored base backup or a copied data
directory carry the primary's, so it would name two diverged servers one
database. The stores of a shared-cache in-memory database used to carry
a symbol each, as a private one's do. A chain
built over a view reports the view, so a reader handed the chain can tell
which rows its document names without having built the view itself:
`@jarenjs/linq`'s handles refuse a chain over another collection or
entity, or over the same-named one of a store over another database, by
it ([DB-CLIENT §6](../../linq/docs/DB-CLIENT.md)).

A member that takes a query document — a collection's `execute`, `query`,
`explain` and `live`, an entity set's `execute`, `explain` and `cursor`, the
store's `execute`, `explain` and `live`, on every view — refuses a
`@jarenjs/linq` chain with `JD0039` naming the member. A chain is told
by its `toDocument()` method, which no query document carries (JSON
holds no function). It used to be read as a document with no clauses, so
`store.collection('orders').execute(chain)` answered `{}` and
`query(chain)` `[{}]`, and an entity member refused it with `JD0033`. A
call that meant the chain passes its document, `chain.toDocument()` with
`{ externals: chain.explain().bindings }`, or hands the chain to the
`@jarenjs/linq` handle it was built from, which takes it.

A query document is JSON, and the compiler reads a document by its own
enumerable members, so the same members refuse an object they cannot
read that way — one whose prototype is neither `Object.prototype` nor
`null` and which has no own enumerable member — with `JD0041` naming the
member (`collection('orders').execute takes a query document, which is
JSON, and was handed a Date instance — …`):
`store.collection('orders').execute(new Date())` answered `{}`, as did a
`Map` or a `RegExp`, and an entity member refused one with `JD0033`. A
class instance with fields is read by those fields, at the root as inside
a document, and a null-prototype object is a plain one; both are taken
as before. Inside a document, a value of that kind with no own enumerable member (a `Date`,
a `Map`, a `Set`, a `RegExp`) is `JD0041` with the `docPath` naming where
it stands, on every member and in every dialect (`a query document holds
a Date instance, which it reads as {} — … at /$where/$gt/1`): it was read
as `{}`, so a `$where` comparing with a `Date` matched no row and a
`$return` holding one answered `{}`. Write the JSON value the object
stands for — a `Date` as its `toISOString()`, the form a `date-time`
member holds. A class instance inside a document is still read by its
own fields.

An external is a call's own value, so the same members check it per
call, against the compiled document: an external the engine compares or
equates — a direct operand of `$eq`, `$ne`, `$lt`, `$le`, `$gt`, `$ge`,
`$distinct` or `$index-of`, or a grouping key (`$since`, `$ids[*]`,
`$window.from`), or one a variable is bound to first (`$let`, `$for` and
its window, a quantifier, a grouping key, a `$fold` accumulator's initial
value) and compared through it (`$s` after `$let: { s: '$since' }`), or
one an operator hands through to the comparison as it is (`$head`,
`$tail`, `$reverse`, `$subsequence` with literal bounds, `$get` with a
literal key, each operand of `$seq`, each member of an array or object
constructor compared whole), in the document or in the store profile's
predicate over a root it reads, followed through the path it reaches
(name, index, wildcard, slice, filter and descendant segments; a filter
selects as the engine does, and a value it compares or hands to a path
function on the way, `length(@.at)`, is read too) — that holds such
a value, at its root or inside it, is `JD0041` naming the member, the
external and the comparison's `docPath`, on every member above and on
every view
(`collection('ev').execute external '$since' holds a Date instance,
which a comparison reads as its instant: it equals and orders against a
Date alone, never JSON text such as a stored date-time — pass the JSON
value it stands for, a Date as its toISOString() at /$where/$gt/1`). The
engine reads a `Date` by its instant and a `RegExp` by its source and
flags ([QUERY-FORMAT §2.1, §8.4](../../json/docs/QUERY-FORMAT.md)), and a
`Map` or a `Set` as `{}`, so
`execute(document, { externals: { since: new Date(…) } })` with
`$gt ['$e.at', '$since']` keeps no row, with or without pushdown, on
SQLite and PostgreSQL: the stored member is text, which no `Date` equals
or orders against. Pass `since.toISOString()`, the value a `date-time`
member holds. A `Date` that meets only `Date`s (a `$distinct` over
`Date`s, two `Date` externals compared) answers right in the engine and
is refused all the same, as the check does not read what the other
operand holds; their ISO strings answer alike. A `RegExp` is refused the
same way (`… holds a RegExp instance, which a comparison reads as its
source and flags: it equals the same pattern alone and orders against
nothing — …`). *Upgrade: the reason used to say a comparison reads a
`Date` or a `RegExp` as `{}`; the code and every refused call are as
before.* Every other use answers as before: an
external the query returns, or hands to a registered function, is
passed through by reference (the function receives the `Date` itself);
one the document never compares is not read; a plain or null-prototype
object, a class instance read by its fields, an array and a primitive
compare as JSON; a value a filter or an operator leaves behind (`$tail`
dropping it, `$get` of another member) and one a filter only tests the
existence of, or counts, is not read. One reached through a filter that
reads the input document (`$xs[?@.k == $[0].k]`), through `$if`,
`$coalesce` or `$default`, through `$subsequence` or `$get` with a computed
bound or key, through `$entries`, a nested phrase's return or a path into
a constructor, or one an operator computes a value from (a function's
result), is not followed and is compared as the engine reads it (a `Date`
by its instant, so equal to no stored text; a `Map` as `{}`). A `bigint` such a position reads is `JD0041` the same way
(`… external '$min' holds a bigint, which a comparison reads as no number —
pass the number it stands for, Number(value) at /$where/$gt/1`): the engine
compares it with no number, so `$gt ['$e.n', '$min']` with `min: 2n` matched
no row and `$ne` every row; returned, or handed to a function, it is passed
through as before.

An entity set is a provider (QUERY-PEN §8): `store.entity(name)` and
`store.sync.entity(name)` carry `execute(document, options)` and
`explain(document, options)` — the document is over the multi-entity
root and goes to the entity translator whole, exactly as
`store.execute` runs it — plus `root` (`"$.<Entity>[*]"`, the one
spelling `collectEntityRoots` reads, so a chain binds its items through
it) and `scope` (one identity per store, shared by every set, so two
sets may be joined in one document). The store itself carries `roots`,
the entity names, because it has no single root: a chain over it is
refused by name (`JL0007`) rather than answering the mixed rows or
counting the sets, and a document naming no entity array stays
`JD0033`. A chain's element terminal hands over the one-item window
`[<phrase>]` (QUERY-PEN §6); the planner reads through the window as
it reads through the packed source — the phrase inside plans as if
bare, and the store answers its rows as the ONE array item the engine
would (`[]` for none, `[row]` for one, never singleton-unwrapped;
`explain().wrapped` says so) — so `toArray()` over an entity set runs
the translator, and a two-root equijoin returning a bare binding runs
as one statement.
This is the shape the differential oracle
can actually prove — the in-memory engine sees exactly the documents
the entity sets return (`test/db/oracle/relations/`). Relation-NAME
navigation (`$.author.name`) is deliberately not query-document sugar:
the engine has no embedded `author` member to walk, so no oracle could
vouch for it. Name-based navigation lives on the `load` surface
(§10.4), where results and statement counts are the proof — and, by
code, on a query producer that lowers a hop to what the engine CAN walk.

For that, every entity set carries **`relations`**, the relation table
a producer may read: a frozen plain record, one entry per declared
relation member of the entity, `{ to, kind, via?, fkEntity?, fkTargets?,
joinTable?, targetKey }` — `to` the target entity, `kind` one of
`oneToOne`/`oneToMany`/`manyToMany`; for a foreign-key relation `via`
the key property, `fkEntity` the entity holding it, `fkTargets` the
entity it references and `targetKey` the key property it references
there (the column a hop's equality compares `via` with; `kind` says
which side holds the key: `oneToOne` the declaring entity, `oneToMany`
the target); for a many-to-many `joinTable` and the target's `targetKey`.
The store (`store.relations`) and every set's `scope` (`scope.relations`)
carry the same tables keyed by entity name, so a producer holding one
set can follow a hop into another root. `relationTables(entities)` is
the one function that derives them. The document format is unchanged:
`@jarenjs/linq`'s chain reads the table and lowers `p.author.email` to
`{ $for: { r1: '$.User[*]' }, $where: { $eq: ['$r1.id', '$it.authorId'] },
$return: '$r1.email' }` (QUERY-PEN §4, relation navigation) — a
document a hand could have written, which this translator and the
engine both run and the oracle proves (`15-linq-hops.json`).

To the translator that phrase is a **navigation hop** when it is one plain
FLWOR over a declared entity array, correlated with the row by column
equalities: its `$where` holds those equalities and predicates over the
related entity alone, its `$return` is the binding or one singular member
path of it, and it has no `$orderby`, `$let`, `$groupby`, window, second
binding or hop of its own. A correlation qualifies only when both sides are
mapped columns of one comparison family, neither boolean, neither admitting
`null` — in its schema type or in its column's policy, `null: 'null'` reading
a NULL as a present `null` — because the engine equates the string `"1"`
with no integer and `null` with `null`, where SQL does neither. A foreign key
no property declares has no type to compare in a correlation, and a join
(§10.2) reads it as the key it references where a hop does not. Such a hop
is a correlated subselect of the row's own statement:

- a comparison of the member a hop returns with a literal or an external,
  in either operand order, is existential — true when any related row's
  member compares true, and no operand pair raises — so it is
  `EXISTS (SELECT 1 FROM <related> WHERE <correlation> AND <the comparison
  the member plans to anywhere else>)`;
- `$exists` and `$empty` of a hop are `EXISTS` and `NOT EXISTS`; a hop that
  returns a member counts only the rows that carry it, so the emptiness of a
  member-less author is true, not only that of a missing one;
- `$count` of a hop compared with a number is `(SELECT COUNT(*) …) <op> n`,
  a fraction or a magnitude past 64 bits folding as it does for an integer
  column; a count is always present, so against any other scalar only
  `$ne` holds and the comparison is a constant, and an external keeps the
  count in the engine;
- `$some` and `$every` over one entity array are one `EXISTS` of the rows
  the condition selects, and one `NOT EXISTS` of the rows it does not; the
  answer is the boolean;
- a `$let` bound to a bracketed hop and read only as `$count` of `$g[*]` —
  the group join that counts its children — is that count;
- a hop that is an order key or a projection leaf is a scalar subselect, and
  only when its equalities cover the related entity's declared key, so that
  it reaches one row at most. A hop that finds none, or whose member is
  absent, orders by the `$empty` placement and leaves its member out of the
  projected object, as the engine does — a hop that reaches no row (a
  dangling key, a NULL key, a related row a profile hides) leaves it out
  whatever the column's policy says of a NULL it does read, which is a
  present `null` under `null: 'null'` and a refusal (`JD2003`) under
  `reject`, as anywhere else; `explain().order` reports such a key against
  the hop's own binding.

Every subselect reads its related entity under that entity's mandatory
profile predicate, once for each place the statement reads it — a value
leaf reads it twice, for the member and for its type — and the leaves of
the filter inside it count toward the dialect's term bound as many times as
the statement carries them. A profile that refuses full-table scans sees the
scan inside a subselect as it sees a join's. A hop read only for its count or
its existence may return a second hop out of its own row that reaches at most
one row (its equalities cover that entity's key) and returns that row bare —
a many-to-many hop's join row, then the target row it names (§10.7): the
statement counts or tests the first hop's rows that reach such a row, so a
join row whose target row is gone is not counted, as the engine does not
count it. A hop that is none of the above
stays in the engine, named by `explain()` and refused under `strict`
(§10.6): a hop out of a hop (but for that count or test), an inner ordering, a correlation by an
inequality, equalities across comparison families or over members that admit
`null` (`entity.hopShape`), and a hop read as a value without the key proof
(`entity.hopValue`). A hop with no correlation to the row is no hop of it: in
a `$where` its conjunct belongs to no binding (`entity.conjunctBinding`),
anywhere else it is `entity.hopShape`.

Per binding, predicates resolve through three reference flavors:

- **entity-column** — a mapped scalar column. Total forms, no
  `json_type` guard: a column-mapped property has no present-`null`
  (§9.3), so presence IS `IS NOT NULL`. Cross-type literals decide at
  plan time (`false`, or presence for `$ne`), and so does a number an
  integer column cannot take as its own type — a fraction, an infinity, a
  magnitude past 64 bits: it compares as the integers the comparison
  admits (`x < 2.5` is `x <= 2`; `x = 2.5` is `false`).
- **entity-epoch** — a derived instant column (§10.3).
- **entity-doc** — any other path rides the JSONB document with the
  phase-A guarded truth table, aliased per binding.

Externals bind against entity columns (with the phase-A `valueTypeOf`
guard); a boolean, an object or a missing external diverts to the
residual at bind time, exactly as phase A does, while a `null` one binds
and differs from every value the column holds. Externals against document
paths stay residual.

**Membership** is `$eq` between a member and a list — a `$seq` of scalar
literals, every item of an external (`'$ids[*]'`), or an `$or` of
equalities comparing one member with literals — and it plans to ONE
predicate whose list binds as one JSON value however long it is: 5,000
ids are one statement with one parameter, and the column's index seeks
them. A column compares only the list items of its own kind (a text
column its strings, a numeric column its numbers); a `null` in a literal
list is the present-null test and a `true`/`false` the boolean one, so
the answer is `$eq`'s. A bound list binds when every item it reaches is
a string or a finite number — a `null`, boolean, object or array item
diverts the call at bind time, and so, on PostgreSQL, does a string item
holding U+0000 or a lone surrogate — and against a boolean column or a
document path a bound list stays residual.

An `$or` regroups by member once each of its items is translated,
nested `$or`s flattened first: two or more equalities of one member
against string or number literals become that one membership list
(strings and numbers together; each kind is compared only by its own
kind, as a literal list is), and two or more rays (`$lt`, `$le`, `$gt`,
`$ge`) of one member, one JSON type and one direction become one bound
— the least lower or the greatest upper by the engine's own order
(numbers by value, strings by code point), the inclusive operator
winning a tie — so a chain alternating equalities on one member with
ranges on another binds two values however long it is. A group takes
the place of its first item; every other item — a boolean or `null`
literal, an external, a `$ne`, a spatial or interval predicate with its
pre-filter — keeps its place and its order; mixed types, opposite
directions and different members never share a bound; and an `$or`
holding an item the planner refuses (a compound literal, an operator
over a member) stays whole in the engine with that item's reason:
nothing is split between the statement and the engine, and so does one
holding a comparison against a string with a lone surrogate, which a
driver binds as U+FFFD (`predicate.loneSurrogate`). Two literal
comparisons keep their place although their member regroups: one
against an infinity, which no bound could carry exactly, and an equality on
an entity's instant column, whose own comparison narrows the column's
index by an epoch range that a list of document strings cannot (its
rays still fold, and the folded bound keeps that range). A NaN literal
reaches no group: it equals nothing, orders against nothing and differs
from every present member, so the planner answers it where it plans it —
a constant `false`, or the existence test for `$ne` — and binds no value
for it. A long `$and`,
or an `$or` nothing regroups (`$and` pairs), nests in halves (depth
log₂ n), so 5,000 leaves prepare and explain where a flat chain met
SQLite's expression-depth limit near 1,000 terms. A dialect may bound
the leaf predicates one statement carries (`maxPredicateTerms`:
PostgreSQL 128, SQLite none), counted once the planner has regrouped —
the chain that folds to one list is one leaf however long it is, and
the count takes in every filter the statement holds, the profile's
mandatory predicate and every comparison that refines a join included —
and a document past the bound is the
engine's, named `predicate.termBound` (§10.6).

### 10.2 Joins

Bindings connected by equalities between their column references
become an INNER equijoin graph — exactly the engine's
cross-product-plus-filter semantics. Result order is deterministic:
any `$orderby` keys first, then all bindings' row identities in
binding order, which is the engine's nested-loop order. `explain()`
reports the join (`{ left, right }`) and the `EXPLAIN QUERY PLAN`
narrative; the paired foreign key carries an index (every foreign key
does — unique for a strict one-to-one, plain otherwise), so the probe
side of the join is a `SEARCH`, never a second scan.

An equality is a join edge only where the database pairs the rows as the engine
does, and that takes three things. Both sides are mapped columns of ONE
comparison family: the family the column stores and the engine decodes (an
integer against a number, a string against a string), never the first type of a
union (`['integer', 'string']` over a text column), never a boolean, and never a column of
no declared type — except a foreign key no property declares, which compares as
the key it references. SQLite compares a string column with an integer one by
affinity, pairing `'1'` with `1`, and PostgreSQL has no such operator
(`JD2005`), where the engine pairs nothing. And the two sides are not both able
to read a NULL as a present `null`: a column whose policy is `null: 'null'`
gives the engine a `null` it equates with another, and SQL pairs none. A NULL
that reads back as no member (every store-owned column, and an adopted one
declared `null: 'absent'`) is an empty sequence in the engine and an unknown in
SQL, which pair alike, so a nullable member still joins natively against a key
or against another nullable member. An equality that fails the rule is no edge:
a binding it alone would connect is in the same case as a binding nothing joins
to (`entity.joinKey`), and beside a real edge it is a conjunct that belongs to
no binding (`entity.conjunctBinding`). The comparisons that refine an edge —
`$ne`, `$lt` and the rest between two columns — and a hop's correlation follow
the same family rule and refuse any column that can read a NULL, in either way,
since a difference of a `null` is true in the engine and unknown in SQL.

An unordered grouping of the rows of a join (`$groupby` over two or more
bindings) lowers on SQLite to one statement. The join is a derived table that
numbers its rows in the engine's nested-loop order — every binding's physical
key columns, or its row identity, in binding order — so a group comes out where
its first row does, whatever the keys of its bindings are; the statement groups
the keys' value/type pairs and orders them by the least number of each group. A
key or an aggregate reads either binding, and `$count` of any binding is the
number of the group's rows. The derived table is named so that no table name
prefixes it in a scan narrative, and the profile's predicates and a
`refuseFullScan` check read the one statement as they read a join. Only the
groups in that order lower: an ordered grouping, a window over groups, the
nullable form of a sum and a return that reads a whole binding stay in the
engine, as do a floating sum or average, a date-codec key or aggregate, and a
sum, mean, extreme or ordering over a column that reads a NULL as a `null` or
stores a boolean (§10.6); such a column as a group KEY lowers. On PostgreSQL the
engine groups a join of any layout (`bind.entityGrouping`).

An entity `$distinct` is a grouping whose keys are the leaves of its return: one
mapped column, or an object constructor of columns and literals (nested objects
included; an array constructor, an operator, a document member, an epoch or date
column, a hop, a count, the binding itself and a constructor with no column stay
in the engine under `entity.distinct`). Each key is read as the value the column stores
beside its JSON type, so two rows are one group where the engine decodes them to
equal values, and the groups come out in first-appearance order: by the binding's
key, or over a connected join by the number of the row in the nested loop (the
derived table above), so a compound physical key whose first appearance is a key
tuple stays in the engine as a grouping's does (`entity.groupOrder`). A bare
column excludes the rows where it is absent; a constructor yields an item for
every row. A literal window applies to the distinct items. An ordering of its
own (`$orderby`) stays in the engine. The guards of an entity grouping are
qualified on PostgreSQL for one adopted table with no document column, so a
store-owned table and a join are the engine's there (`bind.entityGrouping`).

A navigation hop (§10.1) is a join's correlated cousin: it never multiplies
the outer rows, only filters, counts or decorates the row it hangs from, so
the join graph and the result order are the ones the bindings give.

Projection trees of singular member paths and constants lower over one or
several bindings. Counts over those trees count their items; a single-path
count or window first excludes rows where that path is absent, and a hop
leaf excludes the rows whose related row does not carry the member. A count
over an object or array constructor whose operators cannot raise is a
`COUNT(*)` too, with no projection read: it yields one item per row, and the
operators are `$default` over member paths and literals, `$upper`, `$lower` and
`$string-length` over a member the schema types exactly `string` (reached by no
negative index) and whose column, if it has one, stores text and reads no NULL
as a present `null`, `$count` and `$exists` over a member path, `$concat` over
literals and members typed only as scalars or `null`, and `$add`, `$sub`, `$mul`
and `$div` over number literals and members typed exactly `number` or `integer`
that read no NULL as a present `null` (§10.6). On an entity a window over
such a projection stays in the engine. Boolean
predicates may span bindings when each leaf uses one binding's proven total
forms. The mandatory column equalities still establish the join graph;
a disjunction is never treated as a mandatory join edge. Compatible path
comparisons within one binding also lower for non-null numbers and strings.

On the `load` surface the join KIND is derived from the schema
(§10.4): a `oneToOne` include reports `inner (fk required)` when the
`via` property is in `required`, `left (fk optional)` otherwise —
one of the quiet advantages of models being JSON Schema.

### 10.3 Instants (the epoch column)

A `column: "integer"` date property stores the RFC 3339 string in the
document and a derived epoch-milliseconds column beside it (§9.3).
Two rules keep that column honest:

- **The write contract.** A present string value must parse in the
  property's own family and be Z-normalized (`date` properties:
  `YYYY-MM-DD`; `date-time` properties: any precision, `Z` suffix).
  Anything else — an offset form, junk — is refused (`JD2003`): an
  offset would let the epoch order sit hours away from the codepoint
  order of the document string, which is the order the engine
  compares.
- **The comparison form.** An ordering comparison against a literal of
  the column's family compiles to a ±1 s epoch RANGE on the column —
  Z-normalized strings sharing a second prefix sit within one second,
  so the range is a superset — plus the exact document-string
  comparison that decides. The index narrows
  (`EXPLAIN QUERY PLAN … USING INDEX`), the text answers, and mixed
  stored precisions cannot diverge from the engine. `$ne`, string
  operators, presence tests and non-family literals simply ride the
  guarded document forms. `$orderby` over an instant path sorts the
  document string, never the integer column, for the same reason.
- **The key.** On a key, the column is the row's identity: a statement
  that names the row binds the key's epoch, and capture renders the row
  under the string its document keeps (§6).

### 10.4 One-statement graph loading

`store.entity(name).load(spec)` compiles an include tree to correlated
subqueries projected as JSON — `json_group_array(json_object(…))` for
to-many, a scalar `json_object` for to-one, a correlated `COUNT(*)`
for `count: true` — and executes **one statement regardless of depth
or parent count**, asserted by a counting driver
(`test/db/statement-count.test.js`); N+1 is a test, not a promise.

```js
store.entity('User').load({
  where:   { $gt: ['$it.age', 10] },       // over the root entity
  orderBy: '$it.name',
  take: 20, after: cursor,                 // §10.5
  include: {
    posts: {
      where:   { $ge: ['$it.stars', 3] },  // INSIDE the subquery
      orderBy: { $key: '$it.stars', $dir: 'desc' },
      take: 2,
      include: { comments: true },         // nesting
    },
    followers: { count: true },            // the count, not the rows
  },
})
```

Per-relation `where`/`orderBy`/`take`/`skip` apply INSIDE the subquery
(`LIMIT`/`OFFSET` per parent row) — the point where naive loaders fall
back to N+1; `after` (§10.5) paginates the ROOT alone, since a keyset
cursor is one position in one ordered set, and on an include it is
`JD0032`. Clauses compile against
the child's own reference flavors; an untranslatable clause is a
refusal (`JD0032`) naming the include path, never a silent residual.
A load binds no externals, so a `where` that names one is `JD0032` by
name: spell the values in — a membership list (`{ $eq: ['$it.sku',
{ $seq: [...] }] }`, §10.1) binds as one value however long it is — or
query through `execute()` with externals.
Include depth is bounded (default 3, override with `maxDepth`);
exceeding it is `JD0032` with the bound printed. A cyclic include
specification is rejected. Unknown relation names are `JD0032` too.
The specification is a closed vocabulary: a plain object whose root
reads `where`, `orderBy`, `take`, `skip`, `include`, `after` and
`maxDepth`, and whose include entries are `true` or a plain object
reading `where`, `orderBy`, `take`, `skip`, `include`, `count`,
`maxRows` and `maxBytes`. Any other member — `wher` for `where` — is
`JD0032` naming the nearest one, as is a specification that is not a
plain object, so a misspelt filter never loads (and tracks) every row;
`load` and `page`, `loadCursor` and `explainLoad` read it alike. A
member name the dialect's path grammar cannot spell (a `"` on SQLite)
is `JD0032` too, since a load has no residual to run it in.

**Every include is bounded per root.** One root graph is the unit a
graph cursor yields and a page counts, and "one root" is no bound at
all if one root may aggregate a million related rows. So a to-many
include carries `maxRows` — related rows per parent — and every
row-projecting include carries `maxBytes` — serialised bytes of the
relation per parent, measured on the JSON text the database projects.
A relation that crosses either bound is the coded refusal **`JD2073`**
naming the root (entity and key), the member and the bound that was
hit — never a truncated graph, which a caller could not tell from a
whole one. The refusal names the two supported alternatives: read
`{ count: true }` when the size is the question, or page that relation
separately. A bound always exists: an include with none declared
inherits the store defaults, `INCLUDE_ROWS_DEFAULT` (1000 rows) and
`INCLUDE_BYTES_DEFAULT` (1 MiB); an include with a `take` has that
window as its row bound. The unbounded case is spelled, never
inherited — `maxRows: Infinity` (`null` in the JSON spec) — so loading
a relation whole is a decision rather than an oversight. The to-many
subquery carries `LIMIT maxRows + 1`, so the bound is detected at the
bound instead of after aggregating the whole relation; a `count`
include is a number and carries neither. Under a profile a `count`
include counts what the profile lets the caller read: the related
entity's allow-list refuses it (`JD0011`) and its mandatory predicate
holds the count to the rows it admits, as it holds the rows an include
loads. `explainLoad().bounds` lists the bounds every include ran under.

**The graph cursor.** `store.entity(name).loadCursor(spec, options)` —
`graph.cursor(options)` on the client — yields one root graph per
pull, its includes attached and bounded as above, from the same one
statement `load` runs: the include rows ride inside each root row as
the JSON the database projected, so the window is the row itself and
there is no second statement per level to hold or release. `return()`
releases the statement exactly once; `signal` cancels at a row boundary
(`JD2072`). The cursor registers nothing with the unit of work unless
`tracking: true` is spelled per call — a snapshot per yielded root is a
tracker that grows with the result.

### 10.5 Pagination

`$orderby` + `$subsequence` translate to `ORDER BY` + `LIMIT/OFFSET`
on the query surface. On the `load` surface `skip` compiles to offset,
and `after` — a cursor — to **keyset pagination** (`WHERE …` over the
last row's order keys) instead of a growing `OFFSET`; `explainLoad()`
reports which strategy ran (`keyset` / `offset` / `none`) — offset
degrading quietly on large tables is a well-known footgun, and naming
it is cheap.

**The single-column form.** `after: <value>` with a single ascending or
descending ordering over a UNIQUE column — the key, or any `unique:
true` column — compiles to `WHERE col > ?` / `< ?`. A scalar cursor
over a non-unique column, a document path, or a multi-key ordering is
refused (`JD0032`), because such a cursor either skips rows or repeats
them wherever the value ties. A unique column that may hold NULL — a member
the model declares nullable or does not require; a key never does — holds many
of them, and a value positions no row among them: ordered with its NULLs
after its values (descending, or ascending with `$empty: 'greatest'`) the
cursor's comparison would never visit them, so it is refused `JD0032` and
`page()`, whose continuation carries the null placement, is the form to use.
With the NULLs first the cursor stands, but a row without a value carries none
to resume from, so a walk whose first page holds only NULL rows cannot advance.

**The composite keyset.** The orderings a list actually wants —
`(updatedAt, id)`, `(createdAt, id)`, `(priority desc, id)` — have a
non-unique first column. `page()` and a structural `after` compile them
as the lexicographic expansion over the declared terms
`(k1 dir1, k2 dir2, …)` with **the primary key appended** as the
tie-breaker whether or not the caller named it (it is the one column
guaranteed unique, and a tie on every declared key would otherwise be a
skipped row or a repeated one):

```sql
(k1 > v1) OR (k1 = v1 AND k2 > v2) OR (k1 = v1 AND k2 = v2 AND pk > vpk)
```

with `<` for a descending term, and the `ORDER BY` ending in the key
column(s) rather than the row identity. **Null placement agrees with
the plan**: every term's null order (`NULLS FIRST`/`LAST`, from `$dir`
and `$empty`) is spelled in the expansion too — after a null value come
the non-nulls when nulls sort first and nothing when they sort last;
after a non-null value come the greater (or lesser) values and, when
nulls sort last, the nulls — because SQL's `col > ?` is neither true
nor false for `NULL`, and a comparison alone would visit a null-keyed
row twice or never. Only mapped columns carry a keyset; a document path
in the ordering is refused (`JD0032`).

**The row value.** When every term of the identity cannot hold NULL —
a key column, or a mapped column the catalog declares `NOT NULL`, read
at open; for a managed entity the key columns only — and every term
shares one direction, the expansion is spelled as one row value,
`(k1, k2, pk) > (v1, v2, vpk)` (`<` descending), which is exactly the
expansion and which an index over the identity can serve as a single
condition. A term that can hold NULL keeps the expansion, where its
null branch is spelled — a NULL element would make the row value
neither true nor false, and such a row would be skipped silently — and
so do terms whose directions differ (a descending term with the
ascending key appended). A one-term identity is the plain comparison it
always was. The identity, the continuation and the `ORDER BY` are the
same under either form; `explainLoad().sql` shows which was spelled.

**Over a physical table** (§12) the keyset is the same model with one
identity per term: the continuation names PROPERTIES and carries their
decoded values, while the SQL names the physical columns and compares
each as its codec compares. A renamed key column (`item_id` for `id`),
a composite key and a bigint above 2^53 (bound as its exact decimal
string) therefore page without skipping or repeating a row, and a
primary-key order reports `snapshot: true`. Integer, bigint, text and
`uuid` identities qualify on both engines; every other codec refuses
`JD0032` naming it. A native `uuid` column on PostgreSQL orders as the
code-point order of its lowercase text, which is what an entity decodes.
On SQLite a `uuid` is text in whatever case the table stores and the
entity decodes it to lowercase, so the decoded value does not compare as
the stored one, and a continuation built on it would skip rows. Such a
term carries the **stored text** instead: the continuation's `key` (or
`keys` entry) is the spelling the row holds, the identity marks the term
`"stored": true`, and the statement compares and orders it by code point
(`COLLATE BINARY`, whatever collation the column declares, so an index
under another collation cannot serve it). A page over
the key therefore returns every row once, in the order of the stored
text — for a table holding uuids in several cases, not the order of
their decoded values — and a continuation without the mark, or a bare
key (the decoded value a caller reads off the entity), is `JD0035`. An
explicit `load({ orderBy })` over a `uuid` column stays refused on
SQLite (`JD0032`): a load and `execute()` order alike, and the engine
orders the decoded value. A table that holds two spellings of one uuid
(`A0…` and `a0…`) holds two rows: they load as two rows of one decoded
key (the measured fixture: four rows, three decoded keys), and page once
each by stored spelling. Opening does not refuse such a table; it is a
hazard of the data, not of the page. A text term orders
and compares by code point whatever collation the column declares — in
`load({ orderBy })` exactly as in `execute()`: on SQLite `COLLATE
BINARY` over a UTF-8 database, so a NOCASE index cannot serve that order
(a UTF-16 database compares BINARY over its UTF-16 bytes, which is not code
point order, so opening a store over one is refused `JD0002`, §4); on PostgreSQL the
bare column where its collation is a code-point one of the server's own in
`pg_catalog` (`C`, `POSIX`,
`ucs_basic`, `pg_c_utf8`, or the database default of a libc-provider
database collated `C` or `POSIX`) and `COLLATE "C"` otherwise — a collation a
user made and named `C` in another schema included — which is
correct and which no index serves — the price is visible in
`explainLoad().sql`. On SQLite every text key a page reads must
round-trip through the file's text encoding: one that does not
(malformed UTF-8) refuses `JD0032` before a continuation is built on
it, where it used to page forever, and a nullable text order column's
`NULL` has no text to prove and pages by its null placement. On
PostgreSQL no per-row proof runs: a text keyset requires the `UTF8`
database encoding, read at open, from which the driver returns every
stored text exactly, and any other encoding refuses `JD0032` naming it.
A view refuses `JD0032` too: it enforces no primary key, so two of its
rows can share the declared key, and a continuation past one would skip
the other. `explainLoad()`'s `order` names the declared terms by
property and appends the key a physical table's order ends with.

**The continuation** a page emits is unsigned, structural and opaque:

```jsonc
{ "order": [{ "column": "updatedAt", "desc": true, "nullsFirst": false },
            { "column": "id", "desc": false, "nullsFirst": false }],
  "keys": [v1],         // the declared order-key values, as the document carries them
  "key": vpk }          // the row's primary key (a record for a composite key)
```

`order` is the ordering's identity: a continuation replayed against a
different ordering is the refusal `JD0035`, never a wrong page (the terms are
compared member by member, not as the text a serializer wrote, so a
continuation kept in a PostgreSQL `jsonb` column, which orders the members of
an object by length, is the one that was handed out); a
continuation whose `keys` do not match the declared key count, or
whose `key` is not the entity's key shape, is `JD0035` too, on every page of a
walk (the cached statement is shared by every continuation of one shape, so the
check is the page's own). Only a
term that resumes from the text its table stores (a SQLite `uuid`,
above) carries `"stored": true` in `order`, and its value is that text.
Signing, tenant scoping, expiry and wire encoding are the **host's**: the store
has no principal and no key, so any signature it invented would be
security theatre — a host that ships a continuation to an untrusted
client signs it first. The optional
[`@jarenjs/contract/continuation-node`](../../contract/docs/CONTRACT-FORMAT.md#20-scoped-continuations-at-a-node-host)
helper supplies bounded HMAC envelopes with injected scope, query/order
identity, key lookup and time. Open the envelope before passing its structural
cursor back to `page`; Store still validates that cursor and retains `JD0035`.

**The page.** `store.entity(name).page(spec, { limit, after, maxBytes,
consistency, signal })` — `graph.page(options)` on the client — drains
the graph cursor in keyset mode and answers `{ items, continuation,
hasMore, snapshot }`: never more than `limit` roots (default
`PAGE_LIMIT_DEFAULT`, 100) nor more than `maxBytes` serialised bytes
(none unless given; every root is bounded by §10.4 regardless), the
continuation of the last delivered root, and `hasMore` decided by one
peek past the page. A `take` or `skip` in the spec beside `page()` is
refused (`JD0032`): the page windows by its limit. **The
`item_too_large` rule**: an item that alone exceeds `maxBytes` when
nothing has been delivered yet is the coded refusal `JD2074`, raised
without advancing the continuation — a caller that retries meets the
same refusal, which is the honest answer, never a loop and never a
silent breach; an item that does not fit beside earlier ones ends the
page before it (`hasMore: true`). A page registers no snapshots unless
`tracking: true` is spelled. A walk shares its statements: the first page
and each shape of continuation (which order keys are NULL) are one
statement-cache entry apiece, and the continuation's values are bound on
every page, so a walk of any length compiles at most a few plans and leaves
the cache's other plans where they are.

**Snapshot versus live.** A page reports `snapshot: true` only when
every order key is immutable — and the primary key is the one column
the engine itself guarantees never moves (`update()` refuses to rewrite
it). Ordering a live table by a mutable column such as `updatedAt` is
**live pagination**, and the page says so (`snapshot: false`): later
inserts land where their keys sort, but an existing row whose order
key changes between two pages can move across the cursor — it may be
seen twice, or not at all — and no cutoff on later writes prevents
that. `consistency: 'snapshot'` over such an ordering is refused
(`JD0036`) rather than mislabelled; the default `'live'` reports the
truth either way. A caller who needs a snapshot orders by the key.

### 10.6 What remains residual

Reported by `explain()` with reasons, refused under `strict`, and —
because joins make residuals more expensive — accompanied by the
`EXPLAIN QUERY PLAN` narrative (SQLite exposes no row estimates;
a number appears only where `capabilities.rowEstimates` is filled):

- a binding nothing joins to — the cartesian product a nested-loop plan
  must never emit by accident; every binding past the first attaches by
  a column equality to one already joined (an edge, §10.2: one stored
  comparison family, no boolean, not two columns that read a NULL as a
  `null`), and a graph that does not close is the engine's;
- a non-equality predicate used as the only join anchor, an equality that is
  no edge beside a real one, or a boolean predicate whose individual leaf
  cannot be assigned to one binding;
- collection grouping with untyped keys, keys that may hold an object or an
  array or are reached by a negative index, row-binding returns, or ordering by
  anything except an orderable key or a count, minimum, maximum, integer sum
  or integer average expression; entity grouping over a floating sum or
  average or a date-codec key or aggregate, over an aggregate or an ordered
  key that stores a boolean, over two ordered keys that read a NULL as a
  present `null`, or one beside an ordering aggregate of such a column (on
  PostgreSQL, over any column of that policy), over a
  join that is ordered, windowed, returns the nullable form of a sum or reads
  a whole binding, or over one binding's compound physical key whose order
  leaves two groups tied (`entity.groupOrder`), and, on PostgreSQL, over a
  store-owned table or any join (`bind.entityGrouping`); aggregates over
  groups beyond a count of singleton constructors containing keys, literals
  and row counts; windows over group returns that may omit an item, and over
  groups ordered by an integer sum or average (`plan.windowedAccumulation`);
- projection trees containing an operator other than `$default` over member
  paths and literals, `$upper`, `$lower` and `$string-length` over a member the
  schema types exactly `string`, `$count` and `$exists` over a member path,
  `$concat` over literals and members typed only as scalars or `null`, and
  `$add`, `$sub`, `$mul` and `$div` over number literals and members typed
  exactly `number` or `integer` that read no NULL as a present `null`,
  whole entity binding references or non-singular paths; windows over those
  projections, counts of them, and on an entity every window over an operator
  projection (the entity planner has no row residual; `plan.countProjection`,
  `flwor.projection`, `entity.projection`). The engine evaluates the return of
  every row, so an operator that can raise keeps the document in the engine: a
  window or a count that never evaluated the rows it skips would answer where
  the engine raises. Over an object or array constructor of member paths,
  literals and those operators (a collection's also of the document itself) a
  collection's window is pushed (`LIMIT`/`OFFSET`, the constructor run per
  fetched row), and a count of it, on a collection or an entity, is a
  `COUNT(*)`; a collection's window or count stays in the engine where a pushed
  conjunct runs as a registered function (`plan.registeredFunction`), which the
  database may leave unevaluated on a row the engine evaluates and raises on;
- a collection's conjunct after one that can raise — one the engine decides,
  or one that runs as a registered function — which runs as a registered function itself
  where the driver registers one, else in the engine (`predicate.afterRaising`):
  the engine evaluates a `$where`'s conjuncts in order, stopping at the first
  false one, and an index seek on the later one would never visit a row the
  earlier one raises on; the conjuncts before it keep narrowing, and so do the
  ones after a conjunct proven total (an `$eq` or `$ne` of literals, member
  paths and the operators a pushed count accepts, an `$exists` or `$empty`,
  and an `$and`, `$or` or `$not` of those);
- a comparison or a string operator against a string literal holding a lone
  surrogate, which a driver binds as U+FFFD (`predicate.loneSurrogate`; a graph
  load, `JD0032`, and a native mutation, `JD0038`, have no engine path and refuse
  it), and on PostgreSQL a collection's or an entity query's literal holding
  U+0000, or a membership list item holding U+0000 or a lone surrogate — over a
  collection's document, an entity's document or an entity's column — which the
  server cannot hold (`bind.serverText`; a graph load, `JD0032`, and a native
  mutation, `JD0038`, refuse it; NATIVE-PLANS names the stored lone surrogate a
  native projection reads as U+FFFD);
- a navigation hop out of shape (`entity.hopShape`): a hop out of a hop
  (but for a count or an existence test of one that reaches at most one row,
  §10.1), one with an inner `$orderby`, `$let`, grouping or window, one correlated
  by an inequality, or with equalities across comparison families or over
  members that admit `null` (an uncorrelated hop in a `$where` belongs to
  no binding: `entity.conjunctBinding`); and a hop read as
  a value (`entity.hopValue`) — an order key, a projection leaf — whose
  equalities do not cover the related entity's declared key, or that
  returns the binding itself: where one related row is not guaranteed the
  engine raises (`JQ2005`, `JQ2001`), so it keeps the error (§10.1);
- a statement that must order a table's rows, over a table that takes every
  spelling of SQLite's row identity (`rowid`, `oid` and `_rowid_`) as a column
  (`bind.identity`): the database resolves a name to a column before it
  resolves it to the row, so no spelling is left that reads the insertion
  order; a table that takes fewer reads the first it leaves free;
- `$distinct` (`plan.distinctProjection`, on an entity `entity.distinct`) over
  anything but singular member paths the schema declares as scalars alone —
  strings, numbers, integers and booleans, each optionally `null` — alone or as
  the members and nested members of an object constructor with literals: an
  object, an array, a member with no type, a union that lists either, a path
  reached by a negative index (which counts from the end of an array, where the
  last element of a short tuple is a prefix item), an array constructor (its
  elements are not named, so rows with different leaves can answer one array),
  an operator, the document itself, a path with several items and a constructor
  with no leaf. SQLite groups an object or an array by its text, which keeps the
  order its members were written in, and PostgreSQL's jsonb text keeps the
  spelling of a number (`1.0`), where the engine compares them member by member
  and numbers by value. Scalars lower unordered, ordered by the projected path alone
  (the groups come out in that order), or ordered by other paths ordering lowers
  over, which number the rows in that order and take each group at its first row;
  a collection's order key reached by a negative index, and a constructor or an
  ordering by other paths beside a conjunct that runs as a registered function
  (`plan.registeredFunction`), stay in the engine. On an entity only mapped
  columns of text, integer, number and boolean types lower, with no ordering of
  its own (§10.2);
- a comparison of two paths when either is not typed as a scalar (an object, an
  array, a member with no type), which compares deeply; a `$get` over an
  untyped target, with a key that is no literal string, or feeding a string
  operator over a member that can hold another kind; and, in an entity query,
  a comparison of two paths that do not hold one and the same non-null number
  or string family (`predicate.joinTerritory`);
- externals against document paths; booleans and `null` at bind time;
  a bound membership list against a boolean column, and one holding a
  `null`, a boolean, an object or an array at bind time; a string external
  holding a lone surrogate, which a driver binds as U+FFFD, and on PostgreSQL
  one holding U+0000, or a membership list holding either, which the server
  cannot hold, at bind time (`bind.external`; on SQLite a list holding a lone
  surrogate binds, its JSON escape read as written);
- on a dialect with a term bound (PostgreSQL: 128 terms per statement, a
  leaf predicate being one and an inequality or a negated comparison
  between a document member and an external operand four, a member's
  membership in an external list sixteen (four in its own column), counted once the
  planner has regrouped, over every filter the statement carries, every
  comparison that refines a join and the profile's mandatory predicate), a
  document past it — an `$or` of more than 64 `$and` pairs, a top-level
  `$and` of more than 128 `$ne` against literals, more than 32 against
  externals or more than 8 distinct external lists — named `predicate.termBound`; a graph
  load (`JD0032`) and a native mutation (`JD0038`), which have no engine
  path, refuse it by name, and under a profile the residual is refused
  where its fetch is (`JD2007` past `maxRows`, `JD0011` under
  `refuseFullScan`);
- everything phase A already listed (§8 of `QUERY-FORMAT.md`
  notwithstanding, the truth table is the contract).

Collection group keys may include null or boolean values, but ordering those
keys stays residual to preserve `JQ2005`. Group ordering is stable under ties.
Literal windows over singleton group constructors lower directly, and the
proven constructor count wraps the grouped statement in `COUNT(*)`.

A collection `$sum` or `$avg` — over the whole selection or in a
`$groupby` return — over a `number` path runs in the engine, named
`plan.floatingAccumulation`: the engine adds left to right in doubles,
while SQLite sums with Kahan–Babuška compensation and PostgreSQL in
exact `numeric`, so over `0.1, 0.2, 0.3` a pushed sum would answer `0.6`
where the engine answers `0.6000000000000001`, and over `1e16, 1, -1e16`
`1` where it answers `0` — as an entity's floating sums already did.
One over an `integer` path pushes beside a guard: every partial sum is
exact while the largest magnitude times the number of terms stays
within `2^53 − 1`, and a group or total that crosses it is answered by
the engine over the rows the plan selects — the fetch the floating twin
reads, so a profile's `maxRows` and `refuseFullScan` bound the SELECTED
rows, not the collection. `explain().fallback` then reads
`{ construct: 'accumulation', runs, reason }` (`bind.accumulation`, the
reason an entity grouping names after the same fallback), and strict
mode refuses such a run (`JD0010`). The terms fold as doubles and a term
past the bound is left out of the fold, so over the values the store
writes the pushed statement itself never fails, on either engine (a JSON
number past the double range is §7's exception). Because any run can take
that fallback, a cursor over a whole integer `$sum` or `$avg` — a
collection's, or a physical entity's column — is `buffered`
(`bind.accumulationWhole`), and `strictStreaming` declines it (`JD0037`)
as it declines the floating twin. A native temporal bucket's `$sum` or
`$avg` over `integer` readings carries the same guard and the same
fallback. Over a reading the schema does not type `integer` a temporal
bucket's `$sum` or `$avg` — a `$time-bucket` `$groupby`, and
`$resample`'s `sum` and `mean` — runs in the engine as the
collection's does, named `series.floating-accumulation`
(`explain().series.reasons[].code` is `floating-accumulation`), and
strict mode refuses it (`JD0010`). The fetch keeps its narrowing — a
pinned series still seeks the series index (`explain().series.mode` is
`hybrid`, its refinement `resampleSeries`, with the index and its
pinned prefix) — so the engine adds only the rows the document
selects; `$min`, `$max`, counts and `integer` readings stay native.

Groups ordered by an integer `$sum` or `$avg` — a collection's, and an
entity's over one binding — come out in the order of the aggregate the
statement selects, beside the guard above: a group with no value sums to `0`
and averages to the empty key, which `$empty` places; groups the order
leaves tied come out by first appearance, the group's earliest row; a group
past the guard sends the call to the engine, whose order that is. A
collection's floating sum or average orders in the engine, named
`plan.floatingAccumulation` (an entity grouping's is `entity.projection`);
so does a member declared `integer` that may also hold a `number` (whichever
type is listed first) and an adopted column whose codec is not `integer`,
since neither is a sum of whole numbers. A window over a collection's groups
ordered by either is the engine's too, named `plan.windowedAccumulation`: the
guard is read on the groups a statement returns, and a group the window
leaves out could rank elsewhere in the engine's order (an entity grouping
under a window is `entity.projection`). The nullable form of a sum
(`$if` over `$exists` of the non-null values) and the plain sum of the same
member are two aggregates of one grouping: a group with no value is `null`
in the first and `0` in the second, which is the one an order reads. A group
key orders as its own kind on every dialect, a number by value and a string
by code point; PostgreSQL reads an ordered key at that kind (`numeric`,
`COLLATE "C"`) rather than from the text the decoder reads, so neither the
digits of a number nor the database's collation decide. An entity grouping over a compound physical key
orders its tied groups by the smallest key tuple, which the minima of the
key columns taken one by one do not give: one whose order leaves two groups
tied — no order, an aggregate, a key left out — is the engine's
(`entity.groupOrder`), and an order that names every group key ranks every
pair of groups apart and lowers. A grouping over a join takes the first
appearance from the number of its rows (§10.2), which orders by every key
column of every binding, so a compound key needs no such refusal there. The runtime guards of an entity grouping
(`_safe`, `_valid`) are qualified on SQLite and over a PostgreSQL table with
no document column, an adopted one; a store-owned PostgreSQL table plans the
set residual under `bind.entityGrouping`. An entity grouping under a window
is the engine's on every dialect.

A `$time-bucket` `$groupby` whose aggregated path admits `null` is the
engine's as well, named `series.nullable-reading`
(`explain().series.reasons[].code` is `nullable-reading`; `strict` refuses
it): the engine's aggregate over a sequence holding `null` raises `JQ2001`,
where a database skips the `null` — over `2, null, 4` a pushed `$sum` would
answer `6`, `$avg` `3`, `$min` `2` and `$max` `4`. A `$sum` or `$avg` over
`['number', 'null']` was already the engine's under
`series.floating-accumulation`. The `$resample` spelling skips the `null`
natively and in the engine alike. Everywhere else an ordering or an
aggregate over a path that admits `null`, or over a boolean path, is a named
residual too, so the two paths keep answering alike.

An ordering over a member declared with more than one type
(`['integer', 'string']`) is a named residual as well, since the engine
compares no number with a string (`JQ2005`); a graph load, which has no
residual, refuses it (`JD0032`). So is a `$sum`, `$avg`, `$min` or `$max`
over such a member — whole, grouped or in a temporal bucket, over a
collection or an entity — since SQL would read it as its first type where
the engine refuses the mixed sequence (`JQ2001`).

A string operator (`$starts-with`, `$ends-with`, `$contains`) over a member
declared with several kinds besides `null` (`['string', 'integer']`) is the
engine's too (`predicate.stringSubject`), and so is one over an adopted
column whose policy reads a NULL back as a present `null`: the engine raises
`JQ2001` on the number or the `null`. **A named deviation:** a member typed
`string` and `null` alone (`['string', 'null']`: a plain column, an epoch
column, a document member) keeps the native form, so a stored `null` answers
false there where the engine raises `JQ2001`. Running the common nullable text
shape in the engine costs its prefix search the index seek (about 30 times on
SQLite, 15 on PostgreSQL), makes `strict` refuse it and counts every fetched
row against a profile's `maxRows`. [NATIVE-PLANS](NATIVE-PLANS.md#named-deviations)
lists it, with its exact input and both answers, beside the store's other
named deviations.

### 10.7 The join table as a query root

A declared many-to-many join table is a **read-only query root**:
`$.<JoinTable>[*]` binds like any entity array and answers rows carrying
exactly its two key columns — `<A>_key` and `<B>_key`, the names the DDL
creates — and nothing else, because a join row has no document of its
own. It joins to the entities it relates like any other binding, so
`Person → Person_Tag → Tag` is one statement over three roots.

It is a ROOT and not an entity: `store.entity('<JoinTable>')` is
`JD2004`, memberships are still written through `link`/`unlink` and the
unit of work, and nothing about the table's lifecycle changes. The two
namespaces are one, so a join table whose name is also a declared
entity's is refused at open (`JD0005`) — `$.X[*]` may mean one thing.

A join row belongs to the two rows it names, so a store profile that bounds
either entity bounds the root (§8): under `predicates: { User: { $eq:
['$it.tenant', '$tenant'] } }` a read of `$.Label_User[*]` answers only the
memberships of the users the call's tenant admits — on every surface that
reads it (`execute`, a count, a correlated count or existence test from
`Label`, a join, `explain`, a cursor, a live query, the client's join
handle), natively and in the engine alike — and a read that leaves
`$tenant` unbound is refused `JD0011`, as a read of `User` is. An
allow-list (`collections`) that leaves the join table out refuses the root
by name.

Because the root exists, a many-to-many **hop** lowers: a chain's
`u.labels` becomes two links — the join row that names the membership,
then the target row it names — instead of the `JL0105` refusal it was.
Read only for its count or its existence (`u.labels.all().count()`,
`u.labels.all().exists()`, and its negation, "the users without a label"),
the hop is one native statement on SQLite and PostgreSQL: a correlated
count or `EXISTS` over the join row, with the target row it names tested
inside it (§10.1), so a join row a writer that did not enforce the foreign
key left behind its deleted target is not counted, as the engine does not
count it. Read as a value (`u.labels`, the array of related rows), it
stays in the engine.
A relation entry that does not name its join row's columns
(`{ joinTable, ownColumn, ownKey, targetColumn, targetKey }` — §10.1)
still refuses with that code, because there is then nothing to lower
through.

A membership question is one document over the root, and it runs as one
native statement on SQLite and PostgreSQL that answers what the engine
answers (`pushdown: false`):

```js
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const store = await openStore({ $model: '0.1', entities: {
  User: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
  Label: { schema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', 'x-entity': { key: true } }, color: { type: 'string' } } } } } },
{ driver: nodeDriver() });
for (const id of ['u1', 'u2', 'u3']) await store.entity('User').create({ id });
for (const [name, color] of [['admin', 'red'], ['dev', 'blue']]) await store.entity('Label').create({ name, color });
store.entity('User').link('u1', 'labels', 'admin');
store.entity('User').link('u1', 'labels', 'dev');
store.entity('User').link('u2', 'labels', 'dev');
await store.saveChanges();

// the pairs whose label is blue: the join root joined to Label
await store.execute({ $for: { j: '$.Label_User[*]', l: '$.Label[*]' },
  $where: { $and: [{ $eq: ['$j.Label_key', '$l.name'] }, { $eq: ['$l.color', 'blue'] }] },
  $return: { user: '$j.User_key', label: '$l.name' } });
// → [{ user: 'u1', label: 'dev' }, { user: 'u2', label: 'dev' }]

// how many users hold each label: a correlated count over the root
await store.execute({ $for: { l: '$.Label[*]' }, $return: { label: '$l.name',
  users: { $count: { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.Label_key', '$l.name'] }, $return: '$j' } } } });
// → [{ label: 'admin', users: 1 }, { label: 'dev', users: 2 }]
```

`@jarenjs/linq`'s client reaches the same root through the member that
names it — `client.entities.User.memberships.labels`, a chain source over
`$.Label_User[*]` whose rows are typed by the two keys
([DB-CLIENT §2.8](../../linq/docs/DB-CLIENT.md)). Its handle carries the
source `{ kind: 'join table', name: 'Label_User', store }` under
`STORE_SOURCE` (§10.1).

The join table's primary key is its two columns, the sorted entity's
first (`Label_key`, then `User_key`), and the store indexes the other
column (`Label_User_User_key`, named `<table>_<column>` as an entity's
column index is, or the table's name clipped beside a short hash where
PostgreSQL would truncate that name): a filter on either column seeks,
and so do the cascade from the second entity and a hop from it. A join
table an earlier release created has no second index; it opens, reads and
writes as it is, and `planColumnUpgrade` plans the statement that creates
the index (MIGRATION-FORMAT §3).
A join table declares no column beyond its two keys, so a membership that
carries data of its own (when it was attached, a role) is an entity of
its own with two one-to-many edges.


## 11. The unit of work

Read entities, produce changed plain JSON, call `saveChanges()`: the
minimal set of parameterised statements runs inside ONE transaction,
ordered so no foreign key is violated mid-flight, with optimistic
concurrency where a version property is declared. Change tracking is
copy-on-write diffing — **no proxies exist on any read path**, and the
assertion is a test, not a promise.

### 11.1 Snapshot tracking (the default)

A materialised entity — from `create`, `get`, `update` or `load`
(root AND included children) — is plain, **deep-frozen** JSON,
registered under its identity. The frozen document itself is the
snapshot: the tracker retains exactly one reference per entity, no
copies. Mutation is replacement:

```js
const ada = await users.get('u1');            // frozen, tracked
users.put({ ...ada, age: 37 });               // the next version
users.add({ id: 'u9', name: 'new' });         // pending insert
users.remove('u2');                           // pending delete
const report = await store.saveChanges();     // one transaction
```

- `put(next)` requires the key to be tracked (`JD2006` otherwise) and
  validates through the injected hook. `add()` completes defaults and
  validates immediately; an `auto` key stays absent until the save
  allocates it. `remove()` of a pending add cancels it, with the
  `link()`s and `unlink()`s staged under its key before the add or after
  it (§11.7) — the save used to write their join rows for a row it never
  inserted, a foreign-key `JD2005`. Documents
  handed to `add`/`put` are adopted and deep-frozen — everything they hold
  freezes, whether or not the document itself already was, so a member the
  caller kept a reference to cannot change what the save writes. Staging is
  last-write-wins: `add()` twice under one key keeps the second document
  (like `put`), where the explicit `create()` twice is `JD2001` (§7).
  An `add()` after a pending `remove()` of the same key refuses `JD2003`
  without changing that removal: use `put()`/`update()` for a replacement,
  or save the removal before staging an insert. A `put()` of a tracked row
  whose removal is pending IS that replacement: it cancels the removal and
  the save updates the row (it used to be returned while the save deleted
  the row anyway), and a `remove()` after it is the last word again. The
  explicit `update()` is an immediate statement (§11.2) and leaves a
  pending removal staged.
- A re-read refreshes a CLEAN record's snapshot; a DIRTY record stays
  authoritative — the read still returns the fresh row. `discard(key)`
  drops tracking without scheduling anything — a pending `remove(key)`
  included; it is the recovery step after a `JD2040` conflict (discard,
  re-read, reapply, save again), on a guarded delete as on an update.
  A row the database changes through a foreign-key action of a save — a
  `setNull` reference cleared under a deleted parent — keeps the snapshot
  it is tracked under: a later `put()` is diffed against that snapshot, so
  a member it held there (the reference to a parent added back) is not
  written again. Re-read such a row after the save, then stage the change.
- A save inside a transaction that later rolls back withdraws exactly
  what it advanced: the records it wrote become pending again (an `auto`
  key's allocated identity is dropped with its row), and the removals and
  membership changes it ran are staged again — while anything staged
  after the save (`add`, `put`, `remove`, `link`, `unlink`) stays as it
  was staged, the later word on a membership target winning. A key the
  save deleted and an `add()` staged after it inserted holds both again
  (the add used to vanish under the restored removal): the next save
  runs that delete ahead of its inserts, then the insert (§11.4), so the
  row ends as the add left it. The opposite pair is a `remove()` of a
  pending add: a row the save inserted and a `remove()` staged after the
  save deleted are both withdrawn, with the memberships staged against
  that insert, so the tracker holds what `add(); remove()` leaves —
  nothing, a later `put()` of the key is `JD2006`, and a removal the save
  ran under the key comes back. (The row was inserted, then deleted, by the
  next save, and a later `remove()` of a versioned key failed every save
  `JD2040`.) The memberships withdrawn with it include those staged under
  either of its keys — the one the caller gave, or the one the save
  allocated — before the save or after it.
  One rule holds all of this: after a rolled-back save the tracker holds
  exactly what it held before the save plus whatever was staged after
  it, each later word with the row it belongs to. A word names its row by
  the key the save gave it — the key an INSERT allocated, the record a
  re-read filed in place of the one the save advanced — and the rollback
  takes that key back, so the word moves onto the row as it stood before
  the save. An edit of a row the save inserted is the pending insert's
  document again, without the `auto` key the save allocated (on SQLite the
  next save inserted it under that key and gave the same key to another
  insert, `JD2001`), and the document `add()` returned still names that
  insert. A `link()` or `unlink()` by the allocated key is filed against
  the pending insert (it stayed filed under the dropped key: SQLite linked
  whichever row the next save allocated it to, PostgreSQL failed every
  save `JD2005`, and an `unlink` was lost on both). A `remove()` of a row
  the save updated is guarded by the version the row had before the save
  (it carried the save's own, `JD2040` on every save). A re-read or a
  `discard()` after the save drops only what was staged after it: the
  update or removal the save ran is pending again (a staged update the
  transaction read again used to be lost, the next save reporting nothing
  to do). A `link()` staged after the `add()` that follows a saved removal
  attaches to the added row, a target the removed row held included: the
  delete takes the old row's join rows along. A row `create()` or
  `update()` wrote inside the rolled-back transaction, with nothing staged
  on it since, is no longer tracked, so a `put()` of it is `JD2006`, as of
  a key never read (it was accepted, and every save failed `JD2040`); the
  `link()`s and `unlink()`s staged on a row `create()` wrote go with it
  (they failed every save `JD2005`). A `put()` staged after the save on the
  row the save deleted — written again by a `create()` inside the
  transaction — is the replacement of a row whose removal is pending: it
  cancels the restored removal and the next save updates the row (the
  removal won, and the put was lost); where no row held the key, the put
  stays staged and the save meets the row's absence (`JD2040`) rather than
  dropping it. An `add()` staged after the save over a key the save wrote,
  then a `remove()` of it, leaves nothing for that key, as `add();
  remove()` does: the rollback no longer brings back what the save had
  written there (the next save inserted or updated it again).
- `asNoTracking()` returns a read-only surface (`get`, `load`) whose
  results are plain UNfrozen data, registered nowhere — a 100k-row
  report retains no snapshots (proven by a forced-GC live-set test).
- Query results (`store.execute`, linq) are plain data, never tracked:
  a projection has no identity to track.

### 11.2 Explicit updates (the other mode)

`set.create(doc)`, `set.update(key, changes)` and `set.delete(key)`
skip tracking: one immediate statement, last-write-wins by contract.
`create` applies defaults, validates, inserts, and — for a
many-to-many relation whose member the document carries as an array
of target keys — writes the join rows in the same transaction, which
rolls back whole when a membership names a row that does not exist; a
duplicate key is `JD2001`. `update` takes the document's own members
only: a relation member (`posts`) is `JD2003` exactly as on `create`,
and a membership array (`labels`) — which `create` writes — is
`JD2003` on `update` as well, because an explicit update never writes
join rows or child rows and never echoes back a member it did not
store; a change to a key member is `JD2003` too (the key column would
go stale — delete and create). An explicit update
still bumps a declared version property, so optimistic savers observe
the row changed. This is the path reactive layers and job runners use.

### 11.3 The diff-to-statement table

`saveChanges()` diffs snapshot against current with the suite's own
diff engine (`createJSONPatch`) and maps each operation:

| Diff operation | Statement |
|---|---|
| a top-level mapped scalar (or foreign-key) member | one column assignment (`SET col = ?`; removal writes `NULL` — reads absent, §9.3) |
| a top-level instant member (`column: "integer"`) | the epoch column AND a `jsonb_set` of the document string, one statement |
| a path inside the JSONB document | a `jsonb_set` / `jsonb_remove` chain over the `doc` column (the §5 patch translation) |
| a many-to-many relation member | join-table `INSERT`/`DELETE` rows from the KEY-SET difference (element internals belong to the child entity) |
| the version member | dropped — engine-owned, always written as snapshot + 1 |
| a one-to-many / one-to-one relation member EDIT | refused (`JD2003`): projections are not stored state |
| anything else (`move`, a mid-array insert, …) | the whole-row fallback — full column set + full document, **counted** in the report |

All assignments for one entity coalesce into ONE `UPDATE`. Relation
members never enter the stored document (`split` strips them on every
write path).

### 11.4 Ordering and batching

Statements run: inserts parent-first (topological over the foreign-key
edges among the inserted entities) → updates → join-table rows (both
endpoints exist by then) → deletes child-first. An update may
reference a parent inserted in the same save. A foreign-key cycle —
self-references included — among the entities being inserted or
deleted is **`JD0040`** naming the cycle; break the save in two. One
delete runs first: the removal a rolled-back save staged again under a
key an `add()` staged after it now holds (§11.1) precedes every insert,
child-first among its kind, so that key is deleted, then inserted. The
removals of the rows that reference a row deleted that way come along,
transitively and child-first: a row read before its `remove()` by the
reference in its snapshot, a row removed unread by its entity's reference
alone. A `restrict` reference would refuse the delete ahead, and a
`cascade` one would delete the row under its own guarded delete (`JD2040`)
— a parent removed with its children, saved, added back and rolled back
failed every later save that way until `discard`. A `setNull` reference
keeps its place: the delete ahead only clears it. The update of a row
that references a row deleted ahead — by the reference it holds or the
one it writes — takes its place by the references it changes. One whose
changed references name rows that exist before the deletes ahead (a
parent that stays, or none) runs before them, as the updates of any save
run before its deletes: a child moved to a parent that stays leaves the
deleted row first, and one edited under it meets the delete as a straight
save has it meet it (a moved child met the delete first and failed every
save, `JD2005` or `JD2040`). One that changes a reference to a row this
save inserts — a new parent, or one deleted ahead and added back — follows
that insert, which runs first (after the delete ahead of its own key), and
still precedes the delete of the row it leaves: a child moved between two
parents both deleted ahead and added back lands on the one added back,
where it was cascaded away or set null, and one moved to a parent added
in the same save lands there, where it failed every save `JD2040`. Where
no order serves every such update — two children swapped between two
parents both deleted ahead and added back — the updates that need an
insert keep their place after every insert and meet the deletes ahead
first: a restricting reference refuses (`JD2005`), a cascading one deletes
the row under its update (`JD2040`), a set-null one clears the reference
the update then writes. Save such moves on their own first.

Same-shape inserts of one entity coalesce into multi-row `VALUES`
statements, bounded by `min(100 rows, ⌊900 parameters / row width⌋)`
(`BATCH_ROW_BOUND`, `BATCH_PARAM_BUDGET`). Generated keys come back
through `RETURNING` in one round trip; ascending keys pair with
insertion order (asserted by test). Measured on this machine: 2000
inserts = 20 statements at ~22 ms versus 2000 single-row statements at
~31 ms in one transaction — the wall-clock gap is modest in-process,
the 100× statement reduction is the point for anything remote.

### 11.5 Optimistic concurrency

Declare a token with `version: true` (§9.2). A row inserted without
one starts at `0` — never SQL `NULL`, which no guard could match
(§9.6) — so the first tracked save after `create()`/`add()` carries
`WHERE version = 0`. Every `saveChanges()`
update and guarded delete carries `WHERE version = ?` (the SNAPSHOT
version) and writes snapshot + 1; a zero-row result is **`JD2040`**
carrying the entity and key, and the whole save rolls back. Without a
version property there is no concurrency check and the report says so:
`concurrency.unversioned` names every touched entity that has none —
never a silent last-write-wins the reader believes is protected. (A
row that vanished entirely still conflicts an update: zero rows is
zero rows.) An unguarded delete of a missing row is a no-op. On SQLite,
which allocates the largest key plus one, the key a rolled-back save
allocated — or the highest row's, deleted by another writer — can be
allocated again, so a `remove()` by such a stale key beside an `add()`
deletes the row that save inserts under it (inserts run before deletes);
a PostgreSQL sequence never repeats a key, and the delete finds nothing.
Discard a key a rollback dropped rather than removing by it. A `put()`
replacing a pending insert's document keeps the version `add()` started
the row at when the replacement carries none (it stored SQL `NULL`, and
every later tracked update failed `JD2040`).

`JD2040` means one thing across the store: an optimistic precondition
did not hold. For an entity it is the version guard above; for a plain
collection it is a write's `expect` (§5), judged in the write's own
transaction. Pending tracked changes refusing a statement the store did
not plan are a different fact and code, `JD2041` (§5.3).

### 11.6 Failure semantics and the return shape

`saveChanges()` is all-or-nothing inside one transaction. On ANY
failure the tracker is left exactly as it was before the call — the
same save can be retried once the cause is gone; a half-applied
tracker is worse than a rollback. A save whose statements all succeed
advances snapshots (bumped versions, generated keys) and clears pending
work **immediately**, even inside an enclosing transaction — inside it
the database does hold those rows, and every later read, plan and
optimistic guard must agree. The scope that owns the connection holds
the exact undo delta: an enclosing rollback (or a named-savepoint
rollback past the save, §5.2) withdraws the advance, a nested rollback
withdraws only its own effects, and outer commit keeps it.

The return value is data, not a boolean:

```js
{
  inserted, updated, deleted,          // row counts
  joinInserted, joinDeleted,           // membership rows
  fallbacks,                           // whole-row writes, counted
  statements: [{ sql, rows }, …],      // what actually ran
  concurrency: { checked, unversioned: [names] },
  elapsedMs,
}
```

### 11.7 Membership: `link` and `unlink`

A many-to-many membership is attached or detached one row at a time
through the unit of work, without carrying the whole membership array:

```js
users.link('u1', 'labels', 'admin');           // a key, or a document carrying the key
users.unlink(ada, 'labels', { name: 'dev' });  // the own side is a key or a document too
const report = await store.saveChanges();      // { joinInserted: 1, joinDeleted: 1, … }
```

- `link`/`unlink` are local, synchronous bookkeeping, like `add`/`put`/
  `remove`; nothing reaches the database until `saveChanges()`.
- The member MUST be a many-to-many relation of the entity — `JD2003`
  otherwise, naming the relation's kind or the missing declaration. The
  target is read exactly as a membership array's element is: a key, or
  a document carrying the target's key (`JD2003` when it carries none).
  A key on either side that names no number under a numeric key column
  is `JD2002` as the call stages it (§6).
- The own side needs the entity's key — or, for a pending insert whose
  `auto` key the save allocates, the document `add()` returned: the delta
  is filed against that insert, and the join row takes the key its INSERT
  returns. A document carrying no key that names no pending insert is
  refused (`JD2003`: "save the entity first, then attach"); a pending
  insert with a caller-supplied key may be linked in the same save, since
  join rows run after the inserts (§11.4).
- The baseline is the join table **as read at save time**, not a
  snapshot: linking a member that already exists and unlinking one that
  does not are no-ops, so a save repeated with the same calls changes
  nothing (asserted). The last word on one target wins — `unlink` after
  `link` means unlink. Such a no-op is settled by the save that finds it
  so, whether or not the save writes anything else: it stayed pending,
  counted by `stats()`, refusing SQL the store did not plan (`JD2041`) and
  writing over a membership changed elsewhere meanwhile. An enclosing
  rollback stages it again. A target key in decimal text names its number
  (§6).
- A `link`/`unlink` beside a `put` carrying the SAME member's membership
  array folds into that array's key-set difference (§11.3): one intent
  per entity, own key and member, never two statements racing for one
  row.
- A tracked snapshot's loaded membership array is not rewritten by a
  saved `link`/`unlink` — a projection stays what it was read as;
  re-read (`load({ include })`) to see the membership. `discard(key)`
  drops the key's pending membership changes together with its
  tracking, and a failed save leaves them pending, as §11.6 promises.
  A `remove()` of a pending add cancels the changes filed under its own
  key (§11.1), not a `link()` naming it as the TARGET — nor does a
  `discard()` of the add, or the rollback of a `create()` that wrote the
  target inside a transaction: that join row's foreign key fails the save
  `JD2005` until the linking side's change is `unlink`ed or `discard`ed.
- The report counts the rows written under `joinInserted`/`joinDeleted`
  and `stats().tracker.pendingMemberships` counts the pending
  (entity, key, member) records.

Worker/pool options, synchronous cursors, wasm session probing and the browser
persistence ladder are specified in [execution hosts](HOSTS.md).

## 12. Existing column layouts

An entity's optional `physical` member declares an existing column-only layout.
Omitting it retains the hybrid mapping. Opening a physical entity MUST verify
its existing table or view and MUST NOT create it. `adopt: true` also prevents
creation of hybrid tables and infrastructure. Inspection, adoption and explicit
migration are separate operations.

`adopt: true` with `jobs: true` can attach the existing current SQLite job
tables and claim index without executing DDL. The engine checks its own schema
declaration, preserving SQL literal values; a missing or differently shaped
object refuses `JD0002` and requires an explicit migration. Adoption never
provisions or upgrades the queue. Capture and replication still refuse in
adopted mode; existing application triggers do not imply complete live capture.

```json
{
  "$model": "0.1",
  "entities": {
    "Setting": {
      "schema": { "type": "object", "properties": {
        "id": { "type": "string", "x-entity": { "key": true } },
        "value": {}, "updated": { "type": "string" }
      } },
      "physical": { "table": "app_settings", "columns": {
        "id": { "name": "key", "codec": "text", "null": "reject" },
        "value": { "name": "value", "codec": "json", "null": "absent" },
        "updated": { "name": "updated_at", "codec": "datetime", "null": "reject", "default": "database" }
      } }
    }
  }
}
```

Every stored property MUST have a distinct physical column name, an explicit
codec and SQL NULL policy. `physical.keys` orders the declared key properties;
without it, property declaration order applies. The physical primary key must
agree in order. `kind: "view"` requires declared logical keys and refuses writes.
Join tables can be declared as ordinary entities with ordered composite keys;
relation navigation across physical layouts is not qualified, so a model
whose entity with a layout declares a relation, or whose relation targets
an entity with a layout, is `JD0005` at open (the second one used to open
and fail at its first `load({ include })` with a raw `JD2005`). A layout's
indexes are its own (`physical.indexes`, items `{ name, terms, unique,
where }` in the relational `$sql` grammar), and opening verifies each one
as it verifies the columns, on both engines: the index exists — by name as
the engine compares names, ASCII case folded on SQLite, exact on
PostgreSQL, where a quoted mixed-case name is another object — is as
unique and as conditional as declared, and keys a column under each plain
column term in the declared order (`JD0002` names the index and what
differs; a dropped index no longer reopens clean). A plain term's direction
or collation is not compared, a PostgreSQL `INCLUDE` column beside the keys
is a fact like an undeclared index, and a unique table constraint's index
is the engine's own on SQLite (`sqlite_autoindex_…`, which no declaration
names; PostgreSQL names it after the constraint). What that shape cannot
see — a condition's text, an expression term — SQLite compares as the
CREATE text it keeps, token by token: identifier quoting and ASCII case,
keyword case, whitespace and the parentheses around the whole condition
do not count, so an index the application created in its own spelling
verifies, while another operator, literal, column or list is `JD0002`
(the message shows both texts); the statement the store plans,
`explainMapping(model).entities.<E>.declaredIndexes[i].sql` (§9.2), is
one spelling that always verifies. PostgreSQL, which keeps no CREATE
text, reads the condition back out of its catalog (`pg_get_expr`), and
the key it holds under each expression term (`pg_get_indexdef`), and
compares each with the declared one as its own relational rendering writes
it, both read into one form, so a spelling the server reads as the same
condition or expression verifies: `AND` and `OR` operands in any order, a list as `IN`,
`= ANY (ARRAY[…])` or an `OR` of equalities (and `NOT IN`, `<> ALL` or an
`AND` of inequalities), a comparison either way round (`5 < n` and
`n > 5`), `NOT` over a comparison, a list or a NULL test, `IS [NOT]
DISTINCT FROM NULL` beside `IS [NOT] NULL`, a boolean beside `= true`,
redundant parentheses, the server's casts — `'a'::text`, and a column
cast to a wider type of its kind, `(v)::text` over a `varchar`,
`(n)::numeric` over an `integer`, which an explicit cast of that kind
reads as too — and its literal spellings (`1.50` and `1.5`, `'5'` beside
an integer, `'t'` beside a boolean). Another operator, literal, column,
list or conjunct is `JD0002`, the message showing the server's text and
the rendering, and so is an expression term over another function,
operator, literal or column, or the plain column (`upper(code)` or `code`
where the layout declares `lower(code)`); an expression term's direction,
operator class and collation are not compared, as a plain term's are not.
A condition or key either side does not read is not compared and verifies
by the index's shape alone: a literal the server rewrites by its type (a
date, a uuid), a function outside the relational vocabulary or one the server respells
(`TRIM`), a quantified comparison other than `= ANY` and `<> ALL`, an
`IS [NOT] TRUE` test, a table-qualified column (which the server never
writes), and a declaration PostgreSQL has no rendering of (`GLOB`). An
index the layout does not declare
is a physical fact. A unique index over plain column terms without a
condition keys an existence probe (§13.2). A `kind: "view"` layout declares
no indexes (`JD0005`), and a layout with `physical.schema` declares no
programs at all. A migration step that reads a layout verifies its declared
indexes too, so a step that runs before a later step creates one names the
layout without it as its `model`, as it does for rule programs. The
entity-level `indexes` member (§9.2) plans indexes over a store-owned
table, and beside `physical` it is `JD0004`.

| Codec | Public representation | Required SQLite affinity |
|---|---|---|
| `text` | string | TEXT |
| `integer` | safe integer | INTEGER |
| `number` | finite number, safe when integral | REAL |
| `boolean` | boolean | INTEGER |
| `json` | JSON value | TEXT |
| `date`, `datetime` | validated RFC 3339 text | TEXT |
| `epoch-ms` | canonical UTC date-time text | INTEGER |
| `bigint` | signed integer decimal string within SQLite's integer range | INTEGER |
| `decimal` | exact decimal string, including trailing zeros | TEXT |
| `blob-hex` | lowercase hexadecimal string | BLOB |
| `uuid` | canonical lowercase UUID string | TEXT |
| `local-timestamp`, `instant` | fixed six-digit fractional timestamp, local or UTC Z | TEXT |

A property's schema `type` must admit the kind its codec decodes: a string
for every codec of the table that decodes a string, a number (`integer` or
`number`) for `integer` and `number`, a boolean for `boolean`; a nullable or a
union type admits it through any of its members, `json` takes any type, and a
property that declares no `type` is not judged. A property typed another kind
(`string` over a `boolean` column) is `JD0005` at
`/entities/<E>/physical/columns/<name>/codec`, because the planner reads the
property's type where the ordering and aggregate gates read what the column
stores, and a native string operator over the column answered where the engine
raises. A migration reads its baseline and the model of an applied step as
history, where the rule is not applied, so an application whose history carries
such a model still plans and applies the migration that retypes the property
(`planPhysicalMigration`, `migrate`'s `baseline` and step models); the target
model is held to it. Unsafe narrowing refuses `JD2003`. A byte handle never enters the JSON-facing entity;
[the native SQLite channel](SQLITE-RELATIONAL.md#exact-writes-and-bytes) preserves
Uint8Array/Buffer values on the same synchronous connection.
`null: "null"` maps SQL NULL to present JSON null; `"absent"` omits the property;
`"reject"` refuses it. With the JSON codec, JSON null is stored as the text `null`,
so SQL NULL can independently mean absence. `default: "database"` omits an absent
insert column and reads back the database result. `generated: true` gives column
writes to the database. A generated integer identity uses the existing
`x-entity.default: "auto"` declaration. Direct updates with identical values and
identical tracked saves produce no effective writes.

Mapped query documents use the qualified native subset in [NATIVE-PLANS](NATIVE-PLANS.md).
Present-null scalar equality/ranges preserve Jaren semantics. Unsupported codecs
and shapes retain explicit residuals; strict mode also rejects unsupported bound
externals before fetching rows. Scalar graph loads use mapped names.
Physical `page` and structural `after` continuations qualify for integer,
bigint, text and `uuid` identities on both engines, a SQLite `uuid` by the
text its table stores (§10.5); other codecs refuse `JD0032` by name, and an
explicit `take`/`skip` load remains available.
Capture/live/replication for adopted application triggers is not qualified and
is refused, rather than advertised as a complete change stream. PostgreSQL
supports explicit native scalar adoption as described below.

### PostgreSQL column adoption

Pass an explicit trusted `schema` to `postgresDriver`. A matching
`physical.schema` qualifies table references; it MUST equal the driver's schema.
`adopt: true` verifies the existing keys, types and generated/default ownership
without creating tables or replacing application programs. A schema is a name
boundary, not authorization. The host supplies database privileges, roles and
any RLS settings, and restores its settings before releasing the session.
Views are read-only; their host-selected security mode governs visibility.

| Codec | PostgreSQL type | Exact public contract |
|---|---|---|
| `text`, `datetime` | text, varchar | existing string meaning; datetime remains text |
| `uuid` | uuid | canonical lowercase UUID string |
| `integer`, `bigint`, `epoch-ms` | smallint, integer, bigint | safe number, signed 64-bit string, or canonical UTC timestamp respectively |
| `number` | double precision | finite number, safe when integral; real is refused |
| `boolean` | boolean | boolean, independent of the client's boolean parser |
| `json` | json, jsonb | JSON value; SQL NULL follows the declared null policy |
| `blob-hex` | bytea | lowercase hexadecimal string |
| `decimal` | numeric, numeric(p,s) | exact decimal string; constrained numeric requires exactly s fraction digits |
| `date` | date | year 0001–9999 RFC 3339 date |
| `local-timestamp` | timestamp without time zone | `YYYY-MM-DDTHH:mm:ss.ffffff`, no timezone |
| `instant` | timestamp with time zone | `YYYY-MM-DDTHH:mm:ss.ffffffZ`, normalized to UTC |

Native decimal negative zero refuses; PostgreSQL does not preserve its sign.
Negative scales and scales greater than precision refuse. Timestamp precision
below six permits only zeros beyond the native precision. BC dates, infinities
and years outside 0001–9999 refuse `JD2003`. These restrictions prevent implicit
rounding or temporal reinterpretation. Text projections bypass global client
numeric, UUID, byte, JSON and timestamp parser overrides; no global parser or
session timezone change is required. Domains, enums, arrays and extension types
need a qualified codec and otherwise refuse `JD0002`.

`identity: "always" | "by-default"` verifies native identity ownership;
`x-entity.default: "auto"` permits an absent integer identity on insert.
`default: "database"` requires an actual default or identity, and
`generated: true` must agree with the catalog. Optional `type` must match
PostgreSQL's catalog spelling, including precision. Schema-qualified adoption
refuses inline default/check/generated/collation programs and declared table
DDL; those require an explicit reviewed migration. Existing programs are
inventoried and preserved. Declared database invariant triggers require a
qualified dialect lowering and otherwise refuse before adoption.

Text, safe integer, double and boolean columns with reject/absent NULL policy
have native predicate/projection execution. Safe integer sums/averages and
supported scalar min/max use the shared native runtime guards; floating sums
and averages retain decoded evaluation to preserve accumulation order.
Other scalar shapes retain a
reported decoded residual or strict refusal. A physical keyset continuation
pages integer, bigint, text and uuid identities (§10.5): a text term compares
as the bare column where its collation is a code-point one and under
`COLLATE "C"` otherwise, and requires the `UTF8` database encoding, read at
open. An explicit `orderBy` over a `uuid` column with the `reject` or `absent`
NULL policy orders natively, as `execute()` orders its decoded text; a text or
uuid column with the `null` policy stays refused for the typed path. The shared native mutation engine supports bounded update, delete,
upsert and same-entity insert-select; returned row/byte overflow rolls back the
statement and its transactional trigger effects. Exact decimals, bytes and JSON
use codec-aware changed reporting. Structural SQL through
`relational(connection)` is asynchronous on PostgreSQL and uses
the same expression grammar with native operators, functions and types.
Its cursors use the connection's finite limits; dispose the engine before
closing the host-owned connection. SQL expressions explicitly select native
SQL semantics, including native collation, numeric and NULL behavior.

`readSchema(connection).catalog` supplements the portable table view with
schema-qualified native definitions and metadata: constraints, opclasses,
views, functions, triggers, policies, identity sequences and user types.
Unrepresented native objects receive preservation dispositions in
`introspectModel`; inventory is not permission to reconstruct or drop them.
Sequence metadata describes configuration, not a transactional current value.
Scoped table inspection does not claim a complete external dependency closure.
The server's numeric and timestamp behavior is specified in
[PostgreSQL numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html)
and [date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html).

### Physical migration rows and acceptance

Physical mappings can participate in migration `jslt` and `query` steps.
The step's optional `model` selects its current layout; absent it, the
final model is used. The runner verifies that layout before reading mapped
columns. Transforms keep scalar/composite keys fixed and assign only changed
writable columns, preserving unchanged raw text/JSON/BLOB storage and avoiding
unrelated `UPDATE OF` triggers. Omitted database-default/generated values
remain owned by the database. Changed generated fields, read-only writes and
unknown output fields refuse.

Migration table scans use bounded pages with text, integer or bigint key
codecs; view assertions use bounded offset pages, and views remain read-only.
This internal migration cursor does not enable the public physical `page`/
`after` APIs. Text keys must round-trip through the database encoding and
native binding. Malformed text refuses `JD0021` before its batch is exposed,
rolling back the active migration. Node supports leading-BOM text keys.
Bun 1.4 strips a leading BOM when binding a cursor parameter; the migration
reader detects that limitation and refuses those keys with `JD0021`.
That is a binding limitation, not a claim that ordinary reads corrupt them.

A mapping covers declared fields and invariants, not every schema object
an application owns. For complete startup acceptance, supply a reviewed
`physicalTarget` inventory of the intended owned tables and their programs.
Changed physical declarations are a `JD0021` policy refusal in
`planModelMigration`; use an explicit guarded table plan and the existing
migration lifecycle. See [the runnable lifecycle](MIGRATION-FORMAT.md#runnable-physical-lifecycle).

## 13. Persistence invariants

An entity may declare `invariants`: each has `name`, `on` (insert/update/delete),
`assert` (a Query expression), and explicit `enforcement` (`database` or `store`).
The evaluator receives `{ old, new, op }`; the missing record is null. A rule
passes only on boolean true. Failed rules use `JD2096`, with constraint
classification. A rule's members are the closed set below: an unknown one,
and every one the model checks refuse, is `JD0005` whose `docPath` names the
rule and the member (`/entities/Entry/invariants/1/enforcement`) — an
`assert` that does not compile (the engine's reason quoted; it used to
escape as the engine's own `JQ` error with an empty `docPath`), a database
rule on a view (at `enforcement`, §13.4), what a database rule on a
store-owned layout cannot lower (an `audit` or `effects` at that member, a
probe or a member with no column of its own at `assert`, §13.4) and an
`audit` into an entity with no writable column layout (at `audit`, §13.5)
among them. A database rule the trigger lowering cannot translate (an
operator outside the bounded subset, a column codec it cannot compare,
§13.4) is refused when the programs are planned — by `openStore` and
`planInvariants` — still `JD0005` naming the reason, but with no member.

| Member | Meaning |
|---|---|
| `name` | an identifier, distinct within the entity |
| `on` | the operations it judges: a non-empty subset of `insert`, `update`, `delete` |
| `assert` | a Query expression over `{ old, new, op }`, which may use `$exists-row` (§13.2) |
| `enforcement` | `database` (a trigger program, §13.4) or `store` (the store's own writes, §13.3) |
| `when` | on a rule that includes `update`: `changed` (the default) or `assigned` (§13.1) |
| `columns` | on a rule that includes `update`: the members whose assignment fires it (§13.1) |
| `audit` | a database effect: `{ entity, values }` inserts a row (§13.5) |
| `effects` | database effects of an update: `[{ "increment": "<member>" }]` (§13.5) |

A rule judges the row it fires on, and reads another row only through
`$exists-row`, by that row's key (§13.2). That no two rows share a value
under a condition — one active shift per employee and day — is not a
rule but an entity's partial unique index (§9.2): both engines enforce it
for every writer, introspection derives it back, and the migration
planner diffs it.

### 13.1 Updates: changed, assigned, columns

By default an update rule judges an UPDATE that **changes** the row: an
assignment that leaves every value as it was (`SET total = total`) runs no check
and writes no audit row. A version member, a generated column and an
incremented member never count as a change. `when: "assigned"` judges every
UPDATE of the row, even to the same value — an unconditional update guard is
`{ "on": ["update"], "when": "assigned", "assert": false }`.

`columns: [<member>, …]` judges an UPDATE that **assigns** one of those members,
whatever else it sets and whether or not the value moves (SQL's `UPDATE OF`); an
UPDATE that sets only other columns does not fire it. It names writable mapped
columns of a physical layout and implies `assigned` (`when: "changed"` beside it
is refused). Rules naming the same columns share one program.

The store writes a physical row only when it changes, and then assigns only the
members that change, with the version bump and update stamps — `update()` and a
tracked save alike — so an immutable-column guard (`{ "on": ["update"],
"columns": ["createdAt"], "assert": false }`) refuses a write to that member and
no other. A value that stores as the one already there (a uuid in other letter
case, `null` over an absent member) is no change, nor is the version alone; a
change inside a json member assigns that member alone. `changed` and `assigned`
therefore coincide for the store's own writes, except a write that sets only an
incremented member (§13.5), which assigns it without counting as a change; they
differ for other SQL writers (raw SQL, a native mutation with
`reporting: "matched"`), which only a database rule meets.

On a store-owned layout (§13.4) a database rule's change test counts every
column the table maps but the version — a key's, a member's, a foreign
key's — and the document column that holds the rest of the row, so a write
that changes a document member is a change and one that writes back the
document already stored is none. SQLite compares that column's bytes,
PostgreSQL its `jsonb` value: a rewrite that only reorders a document's
members is a change on SQLite and none on PostgreSQL. A store rule there is
judged as §13.3 says of a document, with no change test of its own.

### 13.2 Existence probes

`{ "$exists-row": { "entity": "<Entity>", "match": { "<member>": <value>, … } } }`
is true when the target entity holds a row whose members equal the values. A
value is `$.old.member`, `$.new.member` (a member of any name written
`$.new['<member>']`, §9.2) or a scalar literal; a text literal
that starts with `$` is written `$$`, as in any query (`"$$draft"` is the text
`$draft`). `match` covers the target's whole primary key, or every column of
one unique index of the target that its open verifies — a `physical.indexes`
entry (§12), or a store-owned layout's unique member or entity index (§9.2) —
over plain column terms and without a condition, so a probe is one indexed
read: a partial unique index, or one with an expression term, proves no row
unique by the matched members alone and never keys a probe (`JD0005`, naming
the index). The keyed members compare with `=`, as the target column
compares — under its declared collation on SQLite, which is what the index
the probe is keyed by proves unique — and a `null` literal against one
refuses at planning (a key holds no null, and a unique index admits any
number of them, so such a probe would match nothing); the other members
compare null-safely, so a `null` literal matches SQL NULL, and text by code
point whatever the column's collation. The target is another table — the physical layout of
another entity, or the layout the store owns for one (§9), whose key columns
hold no SQL NULL and whose other columns read it as a missing member — not a
view, which has no primary key to read by, and not the rule's own table, even
through a second entity mapped to it: PostgreSQL runs row triggers at the end
of a statement and SQLite per row, so a probe of the rule's own table would
see a multi-row statement's other rows differently. A path names a member the
rule's own entity has — a column of its layout, or a stored property of a
document — whose column has the target column's codec (an integer into a
number column is exact), and a literal is a value the target column holds, so
the database, its other engine and the store compare one value one way;
anything else refuses at planning. A database rule's match value reads a
`null` or `reject` column: a member that an `absent` column (§13.4) leaves
missing has no value to match. A matched member whose target column reads SQL
NULL as absent serves as a keyed member — `=` never meets SQL NULL, and a
`null` literal against it refuses — and as no other; a store-owned target's
epoch, document and boolean members (kept as 0 or 1, which no probe value is)
refuse at planning. A database rule on a store-owned layout still reads no
other row (§13.4).
`$exists-row` asks for a row of another table; `$exists` (§13.4) asks whether
a member of the rule's own record is present. A probe composes with `$not`,
`$and` and `$or` — "the parent is a draft, or it is gone" is

```json
{ "$or": [
  { "$not": { "$exists-row": { "entity": "Order", "match": { "id": "$.old.order" } } } },
  { "$exists-row": { "entity": "Order", "match": { "id": "$.old.order", "status": "draft" } } }
] }
```

Store enforcement answers a probe with the same SQL the database's trigger runs,
its values bound, inside the write's transaction.

### 13.3 Store enforcement

Store enforcement covers direct and tracked model writes and a migration's
physical transform; arbitrary external SQL is outside that population. Trusted
SQL writes refuse while store rules are present, and native mutations refuse an
entity with store rules. Each rule is checked at its own statement, inside the
write's transaction, so a tracked save's rule sees what the statements ahead of
it wrote. A physical row's insert and update rules are checked after the write,
against the row as it was — read just before the statement, not the copy a unit
of work holds, and on PostgreSQL locked (`FOR UPDATE`) for the rest of the
transaction, so a concurrent writer's change lands before that read, never
between it and the statement — and the row now stored: an update that changes nothing a
database rule counts runs no `changed` rule, and a `columns` rule runs when the
statement assigns one of them (§13.1). A delete rule is checked after the
delete, against the row it removed; a key with no row removes nothing and runs
no rule. A row the database's own foreign-key actions remove or null under a
store delete — a `cascade` child at any depth, a `setNull` member — is judged
by its entity's store rules as that entity's own `delete()` or `update()` of
it is: read before the delete, inside its transaction and locked as the
actions will lock it (on PostgreSQL `FOR UPDATE`, `FOR NO KEY UPDATE` for a
row whose member that is no unique key is nulled), and judged after the
delete, once the parent's own rule passed, so a rule's `$exists-row` reads the
database as the delete left it. A removed row meets its delete rules, `$.old`
the row as read; a nulled row meets its update rules, `$.old` the row as read
and `$.new` that row with the foreign-key member or members null — which a
store-owned layout reads back missing, so `$exists` of the member is false,
as a database rule reads it. A rule that refuses refuses the whole delete with
its own `JD2096` and message, and nothing is written, even inside a
transaction that catches the refusal. That holds for `delete()`, a tracked
save's removal and a delete inside a transaction, under every capture mode; a
delete whose actions reach no row a store rule judges reads none of them for
its rules (journal capture reads them to record them, LIVE-FORMAT §4). The
replay a replica applies runs no store rule, on its own rows or on theirs. A document's insert and update rules are checked before its own
statement, against the document the unit of work holds, membership arrays
included, as the store reads it back: a member written `null` that the table
keeps in a column reads back missing, so a rule judges it missing on the
insert as on every update after it; a save that changes only a document's memberships writes the join
table, not its row, and runs its update rules after the save's other
statements. A document entity's `update()` rewrites the whole document on
every call, so its update rules are checked on every call.

### 13.4 Database enforcement

Database enforcement requires a writable column layout: an explicitly owned
one (`physical: { table, columns }`, §12), whose programs an explicit
migration installs, or the layout the store owns (§9), whose programs the
store installs with its table. A `kind: "view"` layout takes no writes and is
refused (`JD0005`, "database rules require a writable explicit column
layout", at the rule's `enforcement`).

On a store-owned layout a rule reads the columns the table maps for its
members — a scalar member's and a foreign key's — each as the table declares
it: on PostgreSQL an `integer` or a `number` member is `numeric` (an
allocated key `bigint`), whose value must be a safe one, and whole for an
`integer`; a `number` compares as the double the store reads back, so
`0.1000000000000000000001` in its column compares as `0.1`; a `boolean` is
`smallint` 1 or 0; text is `text COLLATE "C"`. A key column holds no SQL
NULL; any other column's SQL NULL is a missing member (an `absent` column,
below), which is how a member the application writes as `null` reads back.
Refused at the member (`JD0005`): a rule that reads an epoch member, whose
column holds milliseconds while the rule compares the member's text
(`…12:00:00.500Z` against `…12:00:00Z`), a member the document holds (an
array, an object, a union, `column: "json"`) or a relation, at `assert`; an
`audit` or `effects`, at that member, since journal capture cannot see what a
trigger writes and such an entity may run capture, live queries or
replication; `$exists-row`, at `assert`; and `columns` keep their own refusal
("a document is written whole").

A fresh open creates the programs with the table — on SQLite through the
same `IF NOT EXISTS` statements as the table, on PostgreSQL, which has no
`CREATE TRIGGER IF NOT EXISTS`, by plain statements, the table's own
`CREATE TABLE` among them, so an open whose rival commits the table between
this open's probe and its create retries into verification — and every open
verifies them: SQLite by their CREATE text, PostgreSQL field by field (below),
where any other trigger on a table the store owns, ruled or not, is drift
(`JD0002`), as on SQLite, and so is a rewrite rule (`CREATE RULE`) on it,
which changes what a write does as an undeclared trigger does. A table
dropped outside the store (`DROP TABLE` by hand) takes its triggers with it
but not its PostgreSQL functions, which the next open of that entity meets
when it creates the table again (`JD0002`, the function "already exists with
same argument types"): drop the functions with the function items' `drop`
statements (`planInvariants`; the trigger items' `drop` fail, their table being
gone), or, instead of the hand drop, drop the entity through a planned
migration, which removes them with the table. A table that exists without a
rule's programs is drift too: a rule added to a populated table is a planned migration
(MIGRATION-FORMAT §9), which judges no stored row and creates the programs
after its transform steps, so a transform can carry stored rows into
conformance before the rule arrives. A rule's change test there
counts the document column too (§13.1). A store rule on such a layout still
covers the store's own writes only.

A database rule judges every write of its row, the rows the database's own
foreign-key actions write included — a `cascade` child's delete rule, a
`setNull` member's update rule — as a store rule (§13.3) judges them too: a
child's database rule refuses its parent's delete, in the
child's rule's name, and the parent's row stays with the child's. The
refusal is reported for the write that ran — its `collection` and `docPath`
are the parent entity's — and its message names the child's rule
(`jaren invariant:kept`): that message is the attribution both engines
give (SQLite's `RAISE` carries nothing more; PostgreSQL names the raising
function only in the `where` field of the error under `cause`).

Database enforcement also requires a bounded query expression, which one
row-predicate compiler lowers to SQL that gives the query engine's answer over
the row as stored, with the one exception below. Its operands are scalar
literals, `$.op`, and `$.old.member` / `$.new.member` references to `text`,
`integer`, `number`, `boolean`, `date` and `datetime` columns, a member of any
name written `$.new['<member>']` (§9.2). A literal is read
as the query language reads it: a text that starts with `$` is written `$$`,
and `$const` quotes one level as written, so a quoted object or list (a nested
`$const` included) is no scalar and refuses, as does a text holding U+0000,
which SQL text cannot carry; any other `$` expression (a variable, a path with
an index or a wildcard, a nested member) refuses. A column's `null` policy (§12) says what its SQL NULL is, and so
what a rule reads there: on a `null` column a JSON null, so equality is
null-safe (a `null` literal matches it, and `$ne` of `2` and a null holds); on
an `absent` column a missing member, which every comparison finds false — `$ne`
and a value of another type included; such a column never holds a JSON null,
so a `null` literal or a `null` item of a list against it refuses at planning
(`$eq` with it never holds, and `$ne` would only restate `$exists`, which says
it directly); a `reject` column holds no SQL NULL. What lowers, per policy:

| Shape | `null` column | `absent` column | `reject` column |
|---|---|---|---|
| `$eq`, `$ne` | null-safe (across JSON types, the exception below); a `null` literal is legal | false while the member is missing; a `null` literal refuses | the value's comparison |
| `$lt`, `$le`, `$gt`, `$ge` | false against SQL NULL | false while the member is missing | the value's comparison |
| `{ "$eq": [<path>, { "$seq": [<literal>, …] }] }` | true when the value is one of the literals; a `null` item matches SQL NULL | as `null`, false while missing; a `null` item refuses | true when the value is one of the literals |
| `{ "$exists": "<path>" }` | true (a null is present) | true when the member is present | true |
| `{ "$add": [a, b] }`, `{ "$sub": [a, b] }`, `{ "$neg": a }` as an operand | refuses at planning (a JSON null is no number) | no value while an operand is missing, so its comparison is false | the integer result, held to ±(2^53 − 1) |

`$and`, `$or`, `$not` and `$exists-row` (§13.2) compose them; every leaf is
true or false, never SQL NULL, so `$not` negates the engine's answer. In the
trigger a list is `IN (…)` (with `OR … IS NULL` for a `null` item), and a leaf
over an `absent` column holds only where that column `IS NOT NULL`.

A comparison's operand may be a sum, a difference or a negation — `$add`,
`$sub`, `$neg` — of `integer` columns and safe-integer literals, nested at
will. The engine counts integers exactly inside ±(2^53 − 1), so each operand
and each result is held to that range as a domain of the write: a result past
it refuses the write (`jaren invariant:<rule>`) rather than wrapping or
rounding, under store enforcement (§13.3, `JD2096`) as under the trigger,
where the query engine alone would answer with a rounded double — the one row
on which the two enforcements and the engine part, by design. A missing
operand (an `absent` column's SQL NULL) leaves the arithmetic without a value,
so its comparison is false, as the engine answers a missing member; a `null`
column's JSON null is no number to the engine, whose arithmetic over one is a
type error rather than a verdict, so such an operand refuses at planning —
declare the column's SQL NULL `absent`. On PostgreSQL a physical integer
column is widened to `bigint` inside the arithmetic, which no sum of two safe
integers leaves; a store-owned `numeric` is read as it is. The engine's other
arithmetic (`$mul`, `$div`, `$idiv`, `$mod`) and a `number` operand are
refused: the engine's double rounding and division are not SQL's.

Refused at planning (`JD0005`, naming the reason): `$ne` and an ordered
comparison against a `$seq` (the engine reads them as true when any one item
compares); an empty `$seq` (it matches nothing); a `$seq` compared with
anything but one member path; a `$seq` item that is not a literal its column
holds — the codec's JSON type, a safe integer in an `integer` column, a finite
number that is not an unsafe integer in a `number` column (a `date` or
`datetime` literal compares as its text); `$exists` in any form but one member
path (its array form tests a literal, which always exists); an arithmetic over
a `number`, `text`, `boolean`, `date` or `datetime` column, over a column whose
SQL NULL is a JSON null, or with a literal that is no safe integer; `$mul`,
`$div`, `$idiv` and `$mod`; `$starts-with` — a prefix test needs a code-point
prefix spelling on each engine and an oracle of its own, which no release has
built — and every other operator. A rule such as
`{ "$le": ["$.new.start", "$.new.end"] }` declares an interval constraint
without claiming interval indexing.

What stays outside the lowering is a boundary, not a gap: a probe of the
rule's own table (PostgreSQL runs row triggers at statement end and SQLite per
row, so a multi-row statement's other rows differ between them); an arbitrary
trigger program (a `TableTrigger` stays SQLite SQL, which PostgreSQL does not
run); an aggregate over other rows (no bounded expression reads them —
`$exists-row` reads one row by a verified key); and SQLite's change test,
which compares each column under its declared collation (below): comparing by
code point would change the text of every installed update program, so it
waits for a reviewed migration of installed programs.

The exception: `$eq` and `$ne` between two `null` columns of different JSON
types (a `text` and an `integer` column, say) compare by type alone, so where
both hold SQL NULL the rule finds them unequal, while the query engine finds two
nulls equal. Installed programs are verified by their text (below), so this
spelling stays until a reviewed migration of installed programs changes it;
test the nulls explicitly instead (`{ "$eq": ["$.new.t", null] }` is null-safe).

`planInvariants(model, { dialect })` returns reviewable statements in install
order, each with the `drop` statement that removes it; for a physical layout
an explicit migration installs them, one `ddl` step each (MIGRATION-FORMAT,
"Installing database rules"), a store-owned layout's are the ones its table
is created with, and opening verifies those programs (`JD0002` names what is
missing or changed). One document plans for both engines:

- **SQLite** — one AFTER trigger per table and operation, plus one `AFTER UPDATE
  OF` trigger per distinct `columns` set (`_jaren_rule_<length>_<table>_<op>`,
  `…_update_of_<hash>`; two sets whose hash meets refuse at planning). A
  failure is `RAISE(ABORT, 'jaren invariant:<rule>')`. Opening compares each
  trigger's stored CREATE text, and refuses a UTF-16 database (`JD0002`),
  whose `BINARY` order is not code point order.
- **PostgreSQL** — per program, a PL/pgSQL trigger function and the row trigger
  that calls it: two items, `type: "function"` then `type: "trigger"`, because a
  PostgreSQL migration step is one statement. Both live in the driver-owned
  schema (`searchPath`, required); every table a program names carries that
  schema, and every function runs with `search_path = pg_catalog, pg_temp`, so
  no schema a writer puts ahead of `pg_catalog` can supply its operators, casts
  or collations. A function body is parsed in the session that runs it, whose
  `standard_conforming_strings` decides whether a backslash in a plain literal
  escapes, so a text literal that holds a backslash is written as an escape
  string (`E'C:\\temp'` for the text `C:\temp`) that every session reads alike;
  any other literal keeps its plain spelling. `TRUNCATE` runs no row trigger,
  so a table whose deletes a
  rule judges gets one more program, a `BEFORE TRUNCATE` statement trigger that
  refuses it in the delete rule's name. A name past PostgreSQL's 63-byte
  identifier limit becomes `_jaren_rule_<hash of the table>_<op>`; two tables
  that meet in one such name refuse at planning. A failure raises SQLSTATE
  **`23J01`** (class 23, integrity constraint violation) with the message
  `jaren invariant:<rule>`. The server stores a trigger deparsed, so opening
  reads each program back field by field — the trigger's timing, events,
  level, `UPDATE OF` columns, `WHEN` condition, enablement and deferral, and its
  function's schema, name, language, return type, arguments, settings,
  security and verbatim source.

`JD2096` is reported only for such a raise: on SQLite a message that starts
with `jaren invariant:` (result code 1811), on PostgreSQL SQLSTATE `23J01` with
that message — never for an error that merely quotes the marker, as an
input-syntax error quoting a value does.

A program runs its assertions in declaration order, then its audit inserts in
declaration order. Assertions see the allocated identity and generated columns.
A failed assertion aborts the entire statement, including its trigger effects.
Inside a transaction a store write that a database rule judges, and one a
store rule probes for, is its own savepoint (a physical entity's insert and
update always are), so a refused rule leaves the transaction body usable on
both engines. On PostgreSQL any other failed statement spends the
transaction unless it ran in a nested transaction — a plain insert's duplicate
key, a refused trusted `tx.sql` statement: the next statement is `JD2088` (a
store write in a savepoint of its own included: the savepoint it can no
longer open answers so), and a body that catches the failure and returns is
refused `JD2088` at its COMMIT, with nothing committed.
Existing application triggers keep their engine's ordering relative to these
programs. Equality uses JSON-style scalar types and null equality; an ordered
comparison involving SQL NULL is false, and so is one over a boolean, as in the
query engine; `$not` negates that boolean. Text compares by code point on both
engines (SQLite `BINARY`, PostgreSQL `COLLATE "C"`), a `date` column as its
`YYYY-MM-DD` text. A rule's change test (§13.1) is the exception on SQLite: it
compares each column as stored, under the column's declared collation, so on a
`COLLATE NOCASE` column a rewrite that changes only letter case is no change,
and an outside writer's other spelling of one json or uuid value is one;
PostgreSQL compares by codec, and the store compares the values it reads back.
SQLite's `INSERT OR REPLACE` and `UPDATE OR REPLACE` delete a conflicting row
without running its delete trigger while `recursive_triggers` is off, as
increments need it (§13.5), so such a writer passes a delete rule by. Store
validation and codec checks are not a substitute for database constraints on
external inputs.

References to a property of the unavailable old/insert or new/delete record
refuse database lowering, because absence differs from SQL NULL. A referenced
column must hold a value its codec reads back — SQLite's storage class of the
codec's type, a safe integer, a finite number within ±(2^53−1), a date of years
1–9999 — or the write is refused.

### 13.5 Database effects: audit and increment

An optional database `audit: { entity, values }` inserts into an
application-owned mapped table after the accepted mutation, after identity
allocation; an `entity` the model lacks, or one without a writable column
layout (store-owned, or a view), is `JD0005` at the rule's `audit`. Values use old/new scalar references to `null` or `reject` columns (an `absent` one has no value to insert where its member is missing, and refuses). Self-referential or chained
audit effects refuse — judged by table, so a second entity mapped to the rule's
own table is that table; all effects share the writer transaction. On
PostgreSQL an integer audit member fed by a `number` column or a non-integer
literal refuses at planning, because an assignment cast would round it. On
SQLite a writer's conflict clause governs every statement of the trigger but
its `RAISE`: under `UPDATE OR IGNORE` an audit insert that fails a constraint is
dropped while the row change stands, and under `OR REPLACE` it replaces the
audit row it meets — so an audit table carries no UNIQUE or CHECK constraint
beyond its key, or such writers stay away from the audited table.

`effects: [{ "increment": "<member>" }]` on a rule that includes `update` moves
a revision by one on each update the rule fires for, unless the writer set it:
`NEW.member = OLD.member + 1` when the UPDATE left the member alone. PostgreSQL
runs it in a BEFORE UPDATE program, so the row is written with its revision;
SQLite as the last statement of the AFTER UPDATE trigger, an update of the same
row that its own trigger cannot fire again while `recursive_triggers` is off,
which opening verifies on the store's connection. That second UPDATE is a write
of its own: an application's AFTER UPDATE trigger on the table runs once more
for it, and a writer that switches `recursive_triggers` on for its own
connection runs the rule's program again over the row it has just written. The member is a non-key, non-null integer column the
database owns like a version: it never counts as a change, it cannot be a rule
column, and no update rule of the entity may read `$.new.member` (PostgreSQL's
AFTER programs see the new revision, SQLite's trigger the writer's). A rule
with effects names no `columns`. The store's own version bump is a writer's, so
a version member that is also incremented moves once per store write; an
external SQL writer without such a rule must supply its own revision discipline.

Audit rows and increments are writes the database makes. Journal capture never
sees them (LIVE-FORMAT: triggers are not enrolled, and physical-table adoption
refuses capture). Ordinary entity writes read the stored row back, including an
incremented revision. Native `mutate({ ..., returning })` follows the engine's
`RETURNING` timing: SQLite reports the statement's row before an AFTER trigger
increments it, while PostgreSQL includes its BEFORE-trigger increment. Read the
row afterward when the final stored revision is needed; native mutation adds no
implicit read to its admitted statement budget (see [NATIVE-PLANS](NATIVE-PLANS.md)).
Existing unrecognized triggers remain application-owned physical objects
requiring preservation dispositions.

## Native column mutation documents

Asynchronous entity sets expose `mutate(document)` for conditional updates, conflict-aware upserts and bounded same-entity insert-select. The closed grammar, no-op/revision behavior, output bounds and transactional qualifications are specified in [NATIVE-PLANS](NATIVE-PLANS.md).

Explicit physical DDL metadata and live-schema migration planning are specified
in [SQLITE-RELATIONAL](SQLITE-RELATIONAL.md#physical-schema-ownership). Opening a
physical entity retains adoption-only behavior. Public plans create complete
ordered declarations; an incomplete generated/default definition or view remains
adoption metadata. SQLite expressions preserve a separate, explicit semantic
contract for raw text, bytes, nulls, collations and floating totals.
`planSchemaChange`/`applySchemaChange` expose explicit native ADD COLUMN, DROP
INDEX, RENAME TABLE and DROP TABLE with source/settings guards. They do not infer
identity remapping or row deletion; that policy stays in an explicitly reviewed
transaction. Entity mutation statement reuse is keyed by emitted SQL, while
bindings, output projections and resource limits belong to each execution.
