# The Jaren model format (`jaren-model`)

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Canonical schema: [`schemas/jaren-model.schema.json`](../schemas/jaren-model.schema.json)
(draft 2020-12), with the mechanically derived draft-07 twin beside it.

Section allocation is fixed so no two documents ever claim the same
section number: §§1–7 the storage subset, §8 the safe profile, §9
entities, §10 relational translation, §11 the unit of work.

## 1. Scope

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
- `indexes[].derive` declares a **derived** index: the columns are
  computed FROM the selected member rather than being the member.
  See §2.1.

An invalid model document is `JD0005` with a `docPath` pointing at the
offending member. Model checking happens before any database work.

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
a real would put an instant in the wrong bucket. Which shapes are
pushed, and the reason each refinement is one, are in ARCHITECTURE.md's
"The temporal plan".

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
rows over 50 000 points): the same `$within` measures <!--bm:spatial.rtreeStore-->0.46 ms against 2 ms — 4.3× in the R\*Tree's favour<!--/bm-->, and loading them
costs <!--bm:spatial.rtreeLoad-->718 ms against 399 ms for 50,000 documents in one transaction — 1.8× the write cost<!--/bm-->. Isolated from the store on a raw
connection, the same probe is <!--bm:spatial.rtree-->0.3 ms against 1.9 ms — 6.4× in the R\*Tree's favour<!--/bm-->. Read speed bought with write cost and a
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
of the stored JSON per row — the column is worth <!--bm:vector.jsonDoc-->15.0× the plan at 10,000 × 768<!--/bm-->
on the read, and costs <!--bm:vector.write-->10.6 s against 5.0 s for 50,000 documents in one transaction — 2.1× the write cost<!--/bm-->
on the way in, because every write pays a JSON round trip of the member
plus the normalize and the pack. On
disk it is <!--bm:vector.storage-->3,072 B packed against 16,141 B as a JSON number array inside the document — 5.3× smaller<!--/bm-->
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
  undeclared → `ANY`), one derived column set per spatial `derive`
  (§3.1), one stored `BLOB` column per `derive: 'vector'` width, and
- one index per `indexes` entry, named `<collection>_<index name>`,
  over the generated columns of its paths — except a `vector` entry,
  which names its column and creates no index (§2.1).

Index paths are analyzed through the query engine's published AST: a
path is indexable exactly when the analysis reports it singular and
every segment is a plain member or index selection. The collection's
schema is the type source — the mapping needs no engine-side type
inference.

Two indexes over the same path share one generated column. A member
name the dialect's JSON path grammar cannot carry (an embedded `"` or
a control character, on SQLite) is `JD0004`.

**Opening an existing database verifies, never alters.** If a declared
collection's table already exists it MUST match what the model would
create; any disagreement is `JD0002` naming the first difference.
Reshaping a live database is the migration story — a later capability —
and `openStore` MUST NOT attempt it.

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

Physical column ORDER is deliberately **not** drift. SQLite's
`ALTER TABLE … ADD COLUMN` can only append, so a migrated table and a
freshly built one legitimately disagree there, and this store never reads
a column positionally.

### 3.1 Derived columns, and the capability branch

A derived column (§2.1) needs a function SQLite does not have, so its
mapping BRANCHES on what the driver declares. That is what the
capability table (§4) is for: a driver that cannot do a thing says so
rather than degrading silently.

| capability | value | mapping | drivers |
|---|---|---|---|
| `deterministicIndexableFunctions` | `true` | a **virtual generated column** whose expression calls a deterministic function the store registers at open — `jaren_geohash(<member>, <precision>)`, `jaren_bbox_w(<member>)`, … over `json(jsonb_extract("doc", '<path>'))` | `node`, `wasm` |
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

The consequence is stated here rather than discovered later: **a row
whose derived column is `NULL` is not found by a predicate pushed to
that column.** For the spatial predicates the planner promotes
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
Statement = { run(params), get(params), all(params), iterate(params) }
```

Every method MAY return a value or a promise; the store never assumes
either. Parameters bind positionally as arrays.

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
change.

On the Bun binding, `userFunctions`,
`deterministicIndexableFunctions` and `sessions` are `false` by
construction: `bun:sqlite` exposes no `function`, no `aggregate` and
no `createSession`. `deterministicIndexableFunctions` is the capability
the derived-column mapping branches on (§3.1), so a model that declares
a spatial index is portable across all three drivers and the physical
shape it produces is not.

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

**Concurrency defaults are decided here.** A file-backed store opens
with `PRAGMA busy_timeout` set to **5000 ms** and journal mode
**WAL**, both overridable through `openStore`'s `busyTimeout` and
`journalMode` options; `:memory:` stores set neither. The values in
effect are visible on `store.capabilities.busyTimeoutMs` and
`store.capabilities.journalMode` (`null` for in-memory stores).

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
await users.patch(key, jsonPatch);  // RFC 6902, applied in the database
await users.delete(key);            // resolves false when nothing was stored
await users.get(key);               // resolves undefined when absent
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

**`patch` validates the result, then updates in place.** The patch is
applied to the stored document with the copy-on-write engine and the
RESULT is validated (`JD2003` rejects before any SQL). The operations
are then translated to the dialect's JSON-set primitives so a
one-field update does not rewrite a large document. Translatable in
0.1: `replace`, `add` of an object member, `add` at an array's end,
and `remove`. Anything else — `test`, `move`, `copy`, a mid-array
insert — falls back to a whole-document write. The fallback is
**counted and exposed** at `collection.stats()`
(`{ patchTranslated, patchFallback }`), measured rather than assumed.
A malformed patch document raises the json family's own coded errors
unchanged; `patch` on an absent key is `JD2006`.

**`transaction(fn)` nests via savepoints.** `fn` receives the store
and may itself call `transaction`; each level is one savepoint. A
throw rolls back exactly its own level and rethrows — an outer
transaction that catches the error continues and its own work
commits. There is no implicit retry.

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

Nesting is asked for in one of two ways, and the difference is not
cosmetic:

- **Synchronously** — a `transaction` called while an owning callback is
  still on the stack nests, because nothing can interleave there. This is
  `store.sync.transaction` inside `store.sync.transaction`.
- **Through the scope** — an `async` callback has already awaited, so the
  stack cannot say whether a request is its own nested work or an
  unrelated caller. Nest through the store the callback RECEIVED:

  ```js
  await store.transaction(async (tx) => {
    await store.collection('docs').put(doc, 'a');   // joins this transaction
    await tx.transaction(async () => { … });        // nests inside it
  });
  ```

  Reaching back through the outer `store.transaction` from inside a
  callback queues behind the transaction the caller is part of, so it
  waits for itself; after `queueTimeout` (default 5 s, the busy-timeout
  default) that becomes `JD0012` naming the fix rather than hanging.

**One residual, stated plainly.** A bare statement issued while a
transaction is open JOINS that transaction and shares its fate, because
SQLite has no per-statement transaction scope and every operation inside
a callback reaches the connection the same way an unrelated caller does.
Work that must be in the transaction is therefore safe; an unrelated
writer on a SHARED store is not. Give each concurrent writer its own
store when independent writes must not share a rollback. Closing this
— scope-bound `tx` handles, with store-level calls waiting on the gate
while a foreign scope is open — is an open ROADMAP item (`@jarenjs/db`,
"Strong same-store transaction ownership"); until it lands, one store
shared by independent request handlers is unsafe for bare writes.

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
string or a number. For allocated identities, `put(doc, key)` updates
a known document and `put(doc)` allocates.

## 7. Error codes

`DbCompileError` (`JD0xxx`, problems opening a store) and
`DbRuntimeError` (`JD2xxx`, problems reading or writing one) build on
the suite's coded contract: a stable `code`, a bare `reason`, a
composed `message`, a `docPath` into the model document where one
exists — and, on runtime errors, the `collection` and (where known)
the `key` as own properties. Database errors are wrapped, never leaked
raw: the reason keeps the original text, `cause` keeps the original
error.

| code | raised when |
|---|---|
| `JD0001` | the SQLite library is below the supported floor |
| `JD0002` | the declared model disagrees with the existing database |
| `JD0003` | the driver binding is unavailable on this runtime |
| `JD0004` | a declared index cannot be mapped to a column |
| `JD0005` | the model document is invalid |
| `JD0010` | strict mode refused a residual |
| `JD0011` | the profile refused the document |
| `JD0012` | work waited too long for the open transaction to settle |
| `JD0030` | an unknown x-entity member was declared |
| `JD0031` | relation declarations contradict each other |
| `JD0032` | the include specification is invalid |
| `JD0033` | an entity query names no entity array |
| `JD0040` | the save spans a relation cycle |
| `JD0050` | live queries require change capture |
| `JD0051` | the demanded live mode is unavailable |
| `JD0052` | the live-query bound was reached |
| `JD0053` | the live event-time declaration is invalid |
| `JD2001` | insert found the key already present |
| `JD2002` | a usable key could not be resolved for the write |
| `JD2003` | the write failed schema validation |
| `JD2004` | an undeclared collection was requested |
| `JD2005` | a database operation failed |
| `JD2006` | patch found no document at the key |
| `JD2007` | the result exceeded the profile row bound |
| `JD2040` | the row changed under an optimistic update |
| `JD2050` | a changeset could not be decoded |
| `JD2051` | the change log is not enabled |
| `JD2060` | the maintained live state exceeded its bound |
| `JD2061` | another context owns the database |
| `JD2062` | the store closed with job handlers still in flight |
| `JD2063` | the store is closed |

The table above is proven in sync with the runtime `DB_CODES` table by
a test.

## 8. The safe execution profile

A query document that arrives from a tenant, a remote client or a
language model can reach a database. Parameter binding makes injection
structurally impossible; it does nothing about resource exhaustion or
cross-tenant reads. A **profile** composes four independent bounds:

```js
const store = await openStore(model, { driver, profile: 'safe' });
// or per call:
collection.query(doc, { profile: { maxRows: 200, externals: ['min'] } });
```

`'safe'` is the default table; a profile object overrides members over
it. A per-call `profile` REPLACES the store's for that call — it is
normalized over the `'safe'` defaults, not over the store's profile —
so a store-level mandatory predicate or allow-list does not carry into
`execute(doc, { profile: { maxRows: 50 } })`: spell the whole profile
per call, or set it once on the store and pass none. The defaults: engine limits
`{ sequenceItems: 100000, resultItems: 10000, steps: 1000000, depth: 32 }`,
`maxRows: 1000`, no externals, no host functions, no collations, all
of the store's collections, no mandatory predicates, no scan refusal.

1. **Engine limits.** The four engine limits ride into every residual
   compilation, so the JavaScript portion of a query is bounded by the
   engine's own enforcement and fails with the engine's own codes.
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
   use, because there is no residual to hide it in.

**Read-only stores.** `openStore(model, { readOnly: true })` opens the
connection read-only at the DRIVER, so every write is refused by the
database itself (`JD2005` wrapping `SQLITE_READONLY`), not merely by
the API surface — a translation bug cannot become a write. A read-only
store verifies the declared shape and creates nothing (`JD0002` when a
table is missing), and leaves the file's journal mode untouched.

**The non-claims, stated plainly.** This profile does NOT claim:

- a statement timeout on the shipped drivers — `node:sqlite` and
  `bun:sqlite` expose no interrupt and no progress handler, the
  `statementTimeout` capability is `false`, and a long-running
  database-internal computation (a native aggregate over a large
  table) is bounded by nothing here. A driver whose capability is
  filled gets a real timeout without a contract change.
- a row-estimate bound — SQLite's plan output is prose, so the
  structural SCAN refusal is the honest substitute.
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
result, reported by capability. A **profiled (untrusted) document never
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

<!--bm:spatial.udfTable-->
| shape | pushed (ms) | residual (ms) | verdict |
|---|---|---|---|
| solo `$within` over a full scan | 94 | 80 | ~even |
| indexed `$eq` **and** `$within` (~5 % pass the index) | 5.7 | 52 | push **9.1×** |
| `$within` with `LIMIT 10` | 1.9 | 77 | push **41.0×** |
<!--/bm-->

So the spatial hatch <!--bm:spatial.udfVerdict-->earns its row: 9.1× beside the selective conjunct and 41.0× under the LIMIT<!--/bm-->,
by the same rule as `$sqrt`: a sole `$within` over a full scan is a
loss (the UDF re-parses every row in the callback, and the exact
containment test is dearer than a square root), a `$within` beside
something that narrows first is a large win. The solo shape is the one
a derived index answers — declare `derive: 'bbox'` on the member and
the same predicate becomes a box seek plus a refinement over the rows
it returns, which is faster than either column above.

**The honest ceiling.** A `pushable:false` operator (a whole-series
`$npv`, an `$sma`) is never a UDF — it stays the residual, `explain()`
lists no `udfs` for it. Aggregate-UDF pushdown (`db.aggregate` step/final
over `GROUP BY`) is **not emitted**: no shipped pack marks an entry
`pushable:'aggregate'` (the finance/stats aggregators fold a *per-document*
sequence — that is a per-row scalar to SQL, already covered by the scalar
path where marked — not a cross-row column), and cross-row aggregate
pushdown additionally waits on `$groupby` pushdown, itself a deliberate
residual today. The `aggregateFunctions` capability is probed and
reported regardless, so the day a pack marks `'aggregate'` the driver
gate is already in place.

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
exactly this document (PENS-FORMAT §3), and this section stays its
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

**An unknown member of `x-entity` is `JD0030` with a `docPath`.** A
silently ignored mapping directive is a data-loss bug waiting to
happen, so this vocabulary is deliberately stricter than the
validator's ignore-unknown posture — the strictness is local to the
one namespace this package owns.

The vocabulary is closed in POSITION as well as in name: `x-entity` is
read on an entity's top-level properties (and through their `allOf`,
`$defs` and `definitions` blocks) only. A block nested anywhere else —
under a property's `properties`, `items`, `anyOf`, … — is never walked
for mapping directives, so one found there is `JD0030` at its `docPath`
rather than a key, an index or a relation that silently never existed.

### 9.3 The hybrid mapping

Stated once, mechanically applied, and returned as data by
`explainMapping(model)` so it can be golden-tested and printed:

| Schema shape | Storage |
|---|---|
| scalar (`string`/`number`/`integer`/`boolean`) at the top level | a real typed column |
| `format: date-time`/`date` with `column: "integer"` | an epoch-milliseconds `INTEGER` column; the document keeps the RFC 3339 string, the column carries the derived epoch |
| `enum` of scalars | a column plus a `CHECK (column IN (…))` — a `null` member of the enum is left to the column's nullability, never written into the list |
| a union of several scalar types (`['string', 'integer']`) | the JSONB document — a column has one affinity and a union has several; `['integer', 'null']` is that scalar, nullable |
| nested object / array, or `column: "json"` | the JSONB document column, queryable by path exactly as in phase A |
| relation | a foreign-key column, or a join table for many-to-many (§9.4) |

`STRICT` tables throughout. The physical row is the key column(s),
the mapped scalar columns, and one JSONB `doc` column holding
everything else; a read merges them back. **The absent-versus-null
rule, plainly**: for a column-mapped scalar, JSON `null` and absence
both store as SQL `NULL` and read back as ABSENT. A property that
needs present-`null` semantics declares `column: "json"` and stays in
the document.

### 9.4 Relations and referential integrity

Declared on one side, inferred on the other; when both sides declare,
the inverses MUST agree (`JD0031` on any contradiction).

What counts as "the same edge" is decided by `via`, not by the pair of
entity names. Two declarations pointing at each other pair up when
they name the same foreign-key property, and a pair is one `many` side
and one `one` side — two `many` sides, or two `one` sides, on one
`via` is `JD0031`, and a paired edge must agree on `onDelete`. A
`many` declaration facing a `one` declaration with a DIFFERENT `via`
is a contradiction too (`JD0031`: the pair disagrees on its key),
while two declarations of the SAME kind with different `via`s are two
independent edges — which is how a legitimate cycle is written
(`Post.author` by `authorId` and `User.featured` by `featuredPostId`,
one-to-one each way). Many-to-many pairs must agree on the join
table, and a many-to-many facing a foreign-key relation is `JD0031`.

- **one-to-many** — `{ to, many: true, via, onDelete }`: `via` names
  the foreign-key property on the TARGET entity (`authorId` on
  `Post`). If the target declares that property it MUST be a
  column-mapped scalar of the key's type; otherwise the column is
  inferred.
- **one-to-one** — `{ to, via, onDelete }` (no `many`): `via` names
  the foreign-key property on the DECLARING entity, and its column is
  unique.
- **many-to-many** — `{ to, many: true, through? }` (no `via`): a
  join table, named `through` when given, otherwise the deterministic
  `<A>_<B>` with the entity names sorted — implicit names are exactly
  the thing teams later regret, so the explicit name exists. Its two
  foreign keys cascade on delete (join rows die with either side; not
  configurable in this version).

`onDelete` is REQUIRED wherever a foreign-key column is created —
`"cascade"`, `"restrict"` or `"setNull"` — never defaulted silently.
Referential integrity is real SQLite foreign keys:
`PRAGMA foreign_keys = ON` is set AND VERIFIED per connection (it
defaults off), a violating write fails with the wrapped database
error, and the declared on-delete behaviour is observed by test.

### 9.5 Identity

Per entity, by the key properties (D11 — platform primitives only):
caller-supplied (any scalar key, composite included);
`default: "uuid"` on a single string key (`crypto.randomUUID()`);
`default: "auto"` on a single integer key (the database allocates —
an index-locality choice, documented as NOT a sortable-id guarantee).
Composite keys are ordinary: mark several properties `key: true`;
reads and deletes take `{ prop: value, … }`.

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
injected hook sees the completed document. A `version` property is
engine-owned and never defaulted by the caller: an insert without one
writes `0` — not SQL `NULL`, which no `WHERE version = ?` guard could
match — and every successful write bumps it (§11.5).

### 9.7 Error-code additions

The entity engine adds three codes to the package's single table (§7):
`JD0030` — an unknown or unread `x-entity` member; `JD0031` — relation
declarations whose inverses contradict; `JD0033` — an entity query
document that binds no entity array (§10.1). Everything else raises the
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
(LINQ-FORMAT §5), names the same whole-entity source; the planner
reads through it for collections (`["$[*]"]`) and entities alike.
This is the shape the differential oracle
can actually prove — the in-memory engine sees exactly the documents
the entity sets return (`test/db/oracle/relations/`). Relation-NAME
navigation (`$.author.name`) is deliberately not query-document sugar:
the engine has no embedded `author` member to walk, so no oracle could
vouch for it. Name-based navigation lives on the `load` surface
(§10.4), where results and statement counts are the proof.

Per binding, predicates resolve through three reference flavors:

- **entity-column** — a mapped scalar column. Total forms, no
  `json_type` guard: a column-mapped property has no present-`null`
  (§9.3), so presence IS `IS NOT NULL`. Cross-type literals decide at
  plan time (`false`, or presence for `$ne`).
- **entity-epoch** — a derived instant column (§10.3).
- **entity-doc** — any other path rides the JSONB document with the
  phase-A guarded truth table, aliased per binding.

Externals bind against entity columns (with the phase-A `valueTypeOf`
guard); a boolean, `null` or missing external diverts to the residual
at bind time, exactly as phase A does. Externals against document
paths stay residual.

### 10.2 Joins

Two bindings joined by one equality between their column references
become an INNER equijoin — exactly the engine's
cross-product-plus-filter semantics. Result order is deterministic:
any `$orderby` keys first, then BOTH bindings' row identities in
binding order, which is the engine's nested-loop order. `explain()`
reports the join (`{ left, right }`) and the `EXPLAIN QUERY PLAN`
narrative; the paired foreign key carries an index (every foreign key
does — unique for a strict one-to-one, plain otherwise), so the probe
side of the join is a `SEARCH`, never a second scan.

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

Per-relation `where`/`orderBy`/`take` apply INSIDE the subquery — the
point where naive loaders fall back to N+1. Clauses compile against
the child's own reference flavors; an untranslatable clause is a
refusal (`JD0032`) naming the include path, never a silent residual.
Include depth is bounded (default 3, override with `maxDepth`);
exceeding it is `JD0032` with the bound printed. A cyclic include
specification is rejected. Unknown relation names are `JD0032` too.

### 10.5 Pagination

`$orderby` + `$subsequence` translate to `ORDER BY` + `LIMIT/OFFSET`
on the query surface. On the `load` surface, `after` (a cursor) with a
single ascending or descending ordering over a UNIQUE column — the
key, or any `unique: true` column — compiles to **keyset pagination**
(`WHERE col > ?` / `< ?`) instead of a growing `OFFSET`; `skip`
compiles to offset. `explainLoad()` reports which strategy ran
(`keyset` / `offset` / `none`) — offset degrading quietly on large
tables is a well-known footgun, and naming it is cheap. A cursor over
a non-unique column, a document path, or a multi-key ordering is
refused (`JD0032`).

### 10.6 What remains residual

Reported by `explain()` with reasons, refused under `strict`, and —
because joins make residuals more expensive — accompanied by the
`EXPLAIN QUERY PLAN` narrative (SQLite exposes no row estimates;
a number appears only where `capabilities.rowEstimates` is filled):

- three or more bindings;
- non-equality join predicates, and disjunctions spanning bindings;
- `$groupby`, except the `$time-bucket` ladder the series plan pushes
  (README, *Time series*) — the engine's post-group cardinality
  rebinding deserves its own order; the count-of-related-rows case
  ORMs are bad at is already native via `count: true` includes;
- projections (`$return` objects) — over one binding or across a join;
- externals against document paths; booleans and `null` at bind time;
- everything phase A already listed (§8 of `QUERY-FORMAT.md`
  notwithstanding, the truth table is the contract).

Two deviations between a pushed answer and the engine's are DECLARED
rather than refused, because in both the database is right by its own
arithmetic:

- `$sum`/`$avg` over `number` paths — SQLite sums with Kahan–Babuška
  compensation and the engine sums naively, so over `0.1, 0.2, 0.3`
  the store answers `0.6` and the residual `0.6000000000000001`: equal
  to within an ulp, never equal by `===` (the differential oracle
  draws dyadic fractions, which are exact on both sides).
- a `$time-bucket` `$groupby` whose aggregated path admits `null`
  (`['number', 'null']`): the pushed `AVG` skips a `null` reading
  exactly as the series kernel — and therefore the `$resample`
  spelling — does, while the engine's `$avg` over a sequence holding
  `null` raises `JQ2001`; under this one spelling the store answers
  where the in-memory engine refuses. Everywhere else an ordering or
  an aggregate over a path that admits `null`, or over a boolean path,
  is a named residual, so the two paths keep answering alike.


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
  allocates it. `remove()` of a pending add cancels it. Documents
  handed to `add`/`put` are adopted and frozen.
- A re-read refreshes a CLEAN record's snapshot; a DIRTY record stays
  authoritative — the read still returns the fresh row. `discard(key)`
  drops tracking without scheduling anything; it is the recovery step
  after a `JD2040` conflict (discard, re-read, reapply, save again).
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
deleted is **`JD0040`** naming the cycle; break the save in two.

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
zero rows.) An unguarded delete of a missing row is a no-op.

### 11.6 Failure semantics and the return shape

`saveChanges()` is all-or-nothing inside one transaction. On ANY
failure the tracker is left exactly as it was before the call — the
same save can be retried once the cause is gone; a half-applied
tracker is worse than a rollback. Only a committed save advances
snapshots (bumped versions, generated keys) and clears pending work.

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
