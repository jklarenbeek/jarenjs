# @jarenjs/linq

**Write it once, in typed JavaScript. Keep it as data.**

Every engine in this repository runs a JSON document. The validator runs
a schema, the store runs a model and a query, the transformer runs a
stylesheet, the flow engine runs a state machine, the app runtime runs a
whole application, the form evaluator runs a form. That is a rare
strength, and until now it came with a price: a document can be stored,
versioned, diffed, sent to a browser, handed to a model and pushed down
to a database — everything a closure cannot do — but you had to write
it by hand, as JSON, with nothing checking it until it ran.

This package removes the price. You write the query, the schema, the
model, the migration, the contract, the stylesheet, the state machine,
the dataflow, the application, the form, chart, project, text template,
message catalog or AI program as ordinary typed JavaScript,
and what comes back is the document — exactly the one its engine
already takes, byte for byte, with its types derived beside it. The
chain is the pen; the document is the deliverable.

```js
import { fromAsync } from '@jarenjs/linq';
import * as m from '@jarenjs/linq/model';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';

// One function. It never says where the users live.
const adults = (users) => fromAsync(users).where((u) => u.age.gt(21)).orderBy((u) => u.name);

await adults(rows).toArray();     // over an array: runs in memory, in the @jarenjs/json engine
adults(rows).toDocument();        // { $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] }, $orderby: { $key: '$it.name' }, $return: '$it' }

const model = m.defineModel({ entities: {
  User: m.object({ id: m.string().identity('uuid'), name: m.string(), age: m.integer() }),
} });
const db = await open(model, { driver: nodeDriver() });
await adults(db.entities.User).toArray();   // User[] — the same function, the same document, pushed down to SQL
```

Look at what the second line answers: not a closure, a value. That
value can be saved next to the rows it queries, replayed a year later,
shipped to a browser and run there, put in a pull request where a
reviewer can read it, or handed to a language model as the thing to
produce. The last line runs it against a database without a line of
SQL — and nothing is hidden: the chain's `explain()` shows the document
it sent, and the store's `explain(document)` shows what that became,
`SELECT … FROM "User" WHERE "age" > ? ORDER BY "name"`.

Coverage: <!--fact:coverage.pens-->14 public pen/client subpaths beside the chain; 69/69 owned schema keywords have dedicated emission routes.<!--/fact-->

## What you gain

- **One idiom across document formats.** `(u) => u.age.gt(21)` is a
  query predicate. The same shape is a schema's cross-field `check()`,
  a form's `assert`, a state machine's guard, a stylesheet rule's body,
  an app action's patch. Every callback is recorded by one proxy over
  one expression vocabulary — one [mapping table](docs/QUERY-PEN.md) —
  so what you learn writing your first query is what writes everything
  else in this repository.
- **Types you did not generate.** `Infer<>` reads a schema, `InferMeta<>`
  a model, `ContractOf<>` a contract; they come out of the builder as you
  write it. A gate holds them equal to the declarations `@jarenjs/emit`
  generates from the same documents, so the generate step becomes
  optional — keep it or delete it, they agree.
- **Mistakes move to the earliest place they can be caught.** A
  transition into a state you never declared, a field your migration
  transform forgot, a view binding an action `actions` does not list —
  these stop compiling, or refuse at build time with a code that names
  the fix (`JL0101`–`JL0107`). Not at dispatch, not in production, not
  in a log.
- **Data you can do anything with.** A closure can be called. A
  document can also be inspected, serialized, diffed, cached, signed,
  sent, stored and executed somewhere else. Every pen answers the
  document, and the chain answers it on demand with `toDocument()`.
- **One chain, everywhere data lives.** In memory, over an async cursor
  or stream, or pushed down to SQL through `@jarenjs/db`: the same chain
  emits a byte-identical document through every driver (test-pinned),
  so a streaming answer equals the in-memory answer by construction, and
  a query written against an array is already a query against the store.
- **Small, and honest about the rest.** A pen imports no engine — a
  schema-only bundle carries no chain and no validator — and
  `npm install @jarenjs/linq` installs nothing else. What a pen costs is
  measured and printed [below](#what-a-pen-costs); where the store's
  front door loses to Prisma, Drizzle or Kysely is a published table,
  not a footnote.

## The map

| You want to write | Import | The engine that runs it, unchanged | Start here |
| --- | --- | --- | --- |
| a query | `@jarenjs/linq` | `@jarenjs/json` in memory; `@jarenjs/db` pushed down | [the chain](#the-chain) · [QUERY-PEN](docs/QUERY-PEN.md) |
| a JSON Schema | `@jarenjs/linq/schema` | `@jarenjs/validate` | [schema pen](#by-code-the-schema-pen) · [SCHEMA-PEN](docs/SCHEMA-PEN.md) |
| a database model | `@jarenjs/linq/model` | `@jarenjs/db`'s `openStore` | [model pen](#by-code-the-model-pen) · [MODEL-PEN](docs/MODEL-PEN.md) |
| a transform | `@jarenjs/linq/jslt` | `@jarenjs/json/jslt` | [JSLT pen](#by-code-the-jslt-pen) · [JSLT-PEN](docs/JSLT-PEN.md) |
| a migration | `@jarenjs/linq/migration` | `jaren-db` | [migration pen](#by-code-the-migration-pen) · [MIGRATION-PEN](docs/MIGRATION-PEN.md) |
| an API contract | `@jarenjs/linq/contract` | `@jarenjs/contract` — client, server and AI tools | [contract pen](#by-code-the-contract-pen) · [CONTRACT-PEN](docs/CONTRACT-PEN.md) |
| a state machine, a dataflow | `@jarenjs/linq/flow` | `@jarenjs/flow` | [flow pen](#by-code-the-flow-pen) · [FLOW-PEN](docs/FLOW-PEN.md) |
| an application | `@jarenjs/linq/app` | `@jarenjs/app` | [app pen](#by-code-the-app-pen) · [APP-PEN](docs/APP-PEN.md) |
| a form | `@jarenjs/linq/forms` | `@jarenjs/forms` | [forms pen](#by-code-the-forms-pen) · [FORMS-PEN](docs/FORMS-PEN.md) |
| an AI action program | `@jarenjs/linq/ai` | `@jarenjs/ai` | [AI-PEN](docs/AI-PEN.md) |
| a message catalog | `@jarenjs/linq/messages` | `@jarenjs/core/message` | [MESSAGES-PEN](docs/MESSAGES-PEN.md) |
| a text template | `@jarenjs/linq/jtlt` | `@jarenjs/json/jtlt` | [JTLT-PEN](docs/JTLT-PEN.md) |
| a Studio project | `@jarenjs/linq/project` | `@jarenjs/studio` | [PROJECT-PEN](docs/PROJECT-PEN.md) |
| a chart | `@jarenjs/linq/charts` | `@jarenjs/charts` | [CHARTS-PEN](docs/CHARTS-PEN.md) |
| typed handles on the store | `@jarenjs/linq/db` | the front door, not a pen | [the front door](#the-front-door-jarenjslinqdb) · [DB-CLIENT](docs/DB-CLIENT.md) |

The rules every pen keeps — what a pen may spell, what it must refuse,
how its document and its types are held equal to the engine's — are one
binder, [docs/LINQ-FORMAT.md](docs/LINQ-FORMAT.md). Every worked example
in every pen document is executed by a test, so what a document shows
is what runs.

## If you are a model reading this

You can produce every document in this repository two ways: emit the
JSON directly, or write the pen's JavaScript and let it emit the JSON.
Prefer the pen whenever you can run code, because it fails early and
specifically. The vocabulary is closed and each method is a row in a
mapping table, so there is nothing to guess; a method that is not in the
table is `JL0001`–`JL0007` at build time, a shape a format cannot carry
is `JL0101`–`JL0107`, and every message names the fix. Three rules keep
you out of the traps:

1. **Spell comparisons and logic as methods.** `u.age.gt(21)`,
   `a.and(b)`, `x.not()`, `s.eq('')`. A proxy cannot overload
   JavaScript's own operators: `u.age > 21` throws a plain `TypeError`,
   and `a && b` or `cond ? x : y` evaluate against the proxy object and
   produce a wrong document silently.
2. **Reach for the builder where you would write a schema.** Every pen
   that carries a schema takes a schema-pen builder in that position —
   a contract's `input`, a machine's `payload`, an app's `state`.
3. **Read the pen document before its format.** The pen document is the
   mapping table for what you are writing; the format document is what
   the engine reads. Start with the table's row, and copy its example —
   a test executed it.

## The chain

`.` is the chain: you write `from(users).where(u =>
u.age.gt(21)).orderBy(u => u.name)`, and what exists afterwards is data
— inspectable, serializable, executable by the `@jarenjs/json` engine in
memory, streamed over a cursor, or pushed into a database by any
provider.

```js
import { from } from '@jarenjs/linq';

const adults = from(users)
  .where((u) => u.age.gt(21))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, name: u.name }));

adults.toArray();     // runs in memory, deferred until now
adults.toDocument();  // { $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] }, … }
```

**The C# comparison, stated honestly.** The operator names, deferred
execution and the query-as-data idea are LINQ's. What differs: capture
is a recording proxy, never source-text inspection, so callbacks must
use the expression surface (`u.age.gt(21)`, not `u.age > 21` — a
JavaScript proxy cannot overload `>`); the operator vocabulary is the
query engine's, closed and documented in the
[mapping table](docs/QUERY-PEN.md); and `IQueryable`'s role is
played by the provider seam below.

- **Deferred and immutable.** A `Sequence` holds a stage list; nothing
  runs until a terminal (`toArray`, `first`, `count`, …). Every
  operator returns a new sequence.
- **Typed where it counts.** Hand-authored declarations type the
  common path precisely and degrade to honest `unknown` — never a
  wrong type — with runtime twins pinning every claim.
- **The async story (the obvious objection, answered).** `fromAsync`
  runs the same operator set over cursors and streams — joins only over
  a provider, pushed whole, because a single-pass stream cannot be read
  twice — and async is a
  boundary, not a colour (the same chain emits a byte-identical
  document through both drivers, test-pinned). Element-wise async
  work happens in exactly one place, `mapAsync`, with a REQUIRED
  concurrency bound and the `parallel`/`concat`/`switch`/`exhaust`
  vocabulary; barrier operators buffer and run through the one engine
  so streaming answers equal in-memory answers by construction.
- **Geography is spellable.** The whole §8.14 family is on the
  expression surface: `p.location.within(region)`,
  `p.location.distance(here)`, `p.route.geoLength()`,
  `p.location.geohash(6)`, and the conversion pair `geoParse`/`geoText`
  that reads a WKT column and writes one back. A plain GeoJSON object
  embeds as a literal; `.params({ region })` binds it at call time
  instead, which is the shape a spatial index can be probed with. The
  spatial measurements are `geoArea`/`geoLength` because `length` on
  this surface is already `$string-length` — the mapping table says so
  in its own row.
- **Time is spellable.** The whole RFC 3339 date family is on the surface —
  `e.on.startOf('month')`, `e.on.dateAdd(3, 'day')`, `e.on.week()` — and so are
  the five time-series operators: `rows.all().resample({ every: 'PT1H', fill:
  'locf' })`, `rows.all().rolling({ width: 60000 })` and
  `left.all().asof(right, { by: '$.symbol' })`. A series spec is a literal and
  is embedded verbatim, so every rule about what it may say stays in the
  compiler rather than being restated here.
- **Meaning is spellable too.** `m.embedding.similarity(query)` emits
  §8.15's `$similarity`, and k-nearest is the chain it already looks
  like — `.orderByDescending(..., { empty: 'least' }).thenBy(m => m.id)
  .take(10)` — because ordering and windowing are stages, not a `knn`
  method. `.params({ query })` binds the query vector at call time, so
  one compiled document serves every question.
- **The provider contract.** Any object with
  `execute(queryDocument, { externals })` is a provider; one carrying
  `root` binds its items through that root, and two sharing a `scope`
  may be joined in one document. `@jarenjs/db` implements it — a chain
  over a SQLite-backed collection or an entity set
  (`from(store.sync.entity('Post'))`, `fromAsync(store.entity('Post'))`)
  pushes to SQL — the chain imports no store; the package's one runtime
  edge is the client subpath's (`@jarenjs/linq/db`, below) and it runs
  one way, toward the store; two entity sets
  of one store join in ONE statement; the store itself, serving several
  roots, is refused by name (`JL0007`). A provider carrying a relation
  table (`relations` — an entity set does) lets a declared relation
  NAVIGATE: `p.author.email` and `u.posts.all().count()` are hops,
  lowered at capture to the correlated phrases the engine and the store
  both run, so the document never carries a relation name and
  `explain().hops` lists what was navigated; a many-to-many hop is
  `JL0105` until the join table is a queryable root. An asynchronous provider is
  `fromAsync`'s: the document arrives whole and `execute` may answer a
  promise. `mapAsync` splits a provider chain into a pushed prefix and a
  local residual, and `explain()` shows the split.

## By code: the schema pen

`@jarenjs/linq/schema` writes standard JSON Schema 2020-12 documents —
the structural keywords, the constraints and the annotations, each with
a method of its own, plus `$query` cross-field rules, `$defs`/`$ref`
recursion and the normalizer's per-field predicates — with
`Infer<>`/`Input<>` types a gate proves equal to `@jarenjs/emit`'s
generated declarations. Reach for it when you are describing the shape
of data: for validation, for a form, or as the base of an entity.

```js
import * as s from '@jarenjs/linq/schema';
import type { Infer } from '@jarenjs/linq/schema';
import { JarenValidator } from '@jarenjs/validate';

const User = s.object({
  id: s.string().uuid(),
  name: s.string().min(1),
  created: s.datetime(),
  age: s.integer().optional(),
}).check((u) => u.created.year().ge(1970));   // a cross-field rule, captured into $query

User.schema;                       // { type: 'object', properties: {…}, required: [...], additionalProperties: false, $query: {…} }
type User = Infer<typeof User>;    // { id: string; name: string; created: DateTime; age?: number }

const isUser = new JarenValidator().compile(User.schema);   // @jarenjs/validate takes the document unchanged
isUser(input);                                              // true | false, the validator's verdict
from(rows).ofType(User);                                    // Sequence<User> — the chain takes a builder where it took a document
```

How to read it: every method writes one keyword, so the builder and the
document are the same thing read from two sides — `JSON.stringify(User)`
is the document, frozen, and `User.schema` is the same value. Objects are
closed by default (`.open()` admits more), `.optional()` is what leaves a
property out of `required`, and a `check()` is a rule over several
fields, recorded by the same proxy the chain uses. A pen imports no
engine, so a schema-only bundle carries no chain and no validator. What
a pen cannot spell it refuses at build time with a coded error
(`JL0101`–`JL0107`) naming the fix — there is no `.transform()` and no
function `refine`: cross-field rules are `check()`, transforms are
application code. The mapping table, the worked examples a test
executes and every refusal are [docs/SCHEMA-PEN.md](docs/SCHEMA-PEN.md);
the rules every pen keeps are [docs/LINQ-FORMAT.md](docs/LINQ-FORMAT.md).

## By code: the model pen

`@jarenjs/linq/model` is the schema pen with the store's vocabulary
subclassed onto it — the `x-entity` members `@jarenjs/db` reads
(`key()`, `unique()`, `index()`, `version()`, `identity('uuid' |
'auto')`, `default()`, `column('integer' | 'json')`), the three relation
spellings, and `defineModel({ entities, collections })`, which emits
exactly the `$model` 0.1 document `openStore` takes. Reach for it when a
store's entities, keys and relations should be declared once and typed
everywhere: `InferMeta<>` is the `EntityMetaMap` `typedStore<E>` wants,
with no generate step.

```js
import * as m from '@jarenjs/linq/model';
import type { InferMeta } from '@jarenjs/linq/model';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

export const model = m.defineModel({ entities: {
  User: m.object({
    id: m.string().identity('uuid'),
    email: m.string().email().unique(),
    posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  }),
  Post: m.object({
    pid: m.integer().identity('auto'),
    title: m.string(),
    authorId: m.string(),
    author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
  }),
} });

model;                                  // { $model: '0.1', entities: {…} } — the document itself, shape-hashed as the store hashes it
const store = await openStore(model, { driver: nodeDriver() });   // @jarenjs/db takes it unchanged
type Meta = InferMeta<typeof model>;    // the EntityMetaMap typedStore<E> wants — no generate step
```

How to read it: an entity is a schema-pen object whose members carry
store annotations; a relation is a member like any other, spelled
`rel.hasOne` / `rel.hasMany` / `rel.belongsToMany`, and it is what lets a
chain over this store navigate `p.author.email` as a hop. The value
`defineModel` returns IS the `$model` document, and its shape hash equals
the store's own, so a model written this way is a model the migration
engine already understands. `InferMeta<>` is the point: `@jarenjs/db`'s
typed surface wanted an `EntityMetaMap` that `@jarenjs/emit` had to
generate from a model file, and a repo gate holds the pen's type equal
to that generated map — so the codegen step is optional rather than
load-bearing. The mapping table, member by member, is
[docs/MODEL-PEN.md](docs/MODEL-PEN.md); what the model document itself
means is [MODEL-FORMAT.md](../db/docs/MODEL-FORMAT.md).

## By code: the JSLT pen

`@jarenjs/linq/jslt` writes `$jslt` 0.1 stylesheets: rule bodies are
callbacks captured over the matched value, with `root`/`path` and the
declared parameters as typed externals, and `apply()` spells the
apply-templates operator. Reach for it when one document is being
transformed into another and the rules should be typed rather than
hand-written JSON.

```js
import { stylesheet, rule, apply } from '@jarenjs/linq/jslt';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const book = stylesheet([
  rule({ schema: { type: 'object', required: ['isbn'] } },
    (v) => ({ title: v.title, children: [apply(v.chapters.all())] })),   // apply-templates over every chapter
  rule({ schema: { type: 'object', required: ['heading'] } },
    (v) => ({ name: v.heading })),
]);

const transform = compileJsltStylesheet(book, { compileTypeTest: createTypeTestCompiler() });   // @jarenjs/json/jslt takes it unchanged
transform({ isbn: '1', title: 'T', chapters: [{ heading: 'A' }] });   // { title: 'T', children: [{ name: 'A' }] }
```

How to read it: a `rule` is a match (a path, or a `schema` the type-test
compiler judges) and a body; the body's callback is recorded over the
matched value, so `v.title` becomes the `$` path the engine reads and
`v.chapters.all()` a query over the array. `apply()` hands the matched
values back to the stylesheet, which is how the second rule runs once
per chapter. `rule()`/`stylesheet()` write the rule object and the
envelope byte-equal to the format's own Appendix A, and the pen refuses
the one shape the engine only catches at run time — an `apply` as a bare
object member (`JL0102`). The mapping table and the worked examples are
[docs/JSLT-PEN.md](docs/JSLT-PEN.md).

## By code: the migration pen

`@jarenjs/linq/migration` writes `$migration` 0.1 documents between two
models, hashing their shapes exactly as the store does, with the data
transform typed old row → new row. Reach for it when `jaren-db plan` has
drafted a migration and a human has to fill the part the planner could
not: `fromPlanned(planned, { from, to })` lets a typed `transform`
replace the draft, and a draft left alone still refuses to run.

```js
import { fromPlanned } from '@jarenjs/linq/migration';
import { model as v1 } from './models/v1.js';   // the previous model, kept beside the current one
import { model as v2 } from './model.js';

export default fromPlanned(planned, { from: v1, to: v2 })
  .transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
//                     ^ the old row, typed        ^ the new row, checked: a dropped `handle` does not compile
```

How to read it: a migration is the two models' shape hashes plus a list
of steps. `defineMigration({ id, from, to })` writes one from scratch and
`.ddl()`, `.sql()`, `.transform()`, `.assert()`, `.derive()` and
`.step()` write the step kinds MIGRATION-FORMAT names; `fromPlanned`
starts from the document `jaren-db plan` wrote instead — the planner
still plans, the pen types the human part. `jaren-db` loads model and
migration modules beside JSON, plans from the committed
`model.snapshot.json`, refuses a module that is not pure and, in CI, a
model that moved without a plan (`jaren-db check`). The mapping table
and the worked examples are
[docs/MIGRATION-PEN.md](docs/MIGRATION-PEN.md).

## By code: the contract pen

`@jarenjs/linq/contract` writes `$contract` 0.1 documents — the
operations two ends exchange, their schemas, their policy and their HTTP
binding. Reach for it when one declared API should type all three
consumers: `ContractOf<typeof shop>` is the operation map, and
`typedClient`, `typedHandlers` and `typedTools` carry it onto a client,
a handler table and an AI toolbox.

```js
import * as s from '@jarenjs/linq/schema';
import { defineContract, command, error, http, typedClient } from '@jarenjs/linq/contract';
import { compileContract } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';

const Product = s.named('Product', s.object({ id: s.integer(), name: s.string() }).open());

export const shop = defineContract({ id: 'shop' }, {
  'product.save': command({
    input: s.object({ id: s.integer(), product: Product }).open(),
    output: Product,
    errors: { conflict: error({ status: 409 }) },
    http: http({ method: 'PUT', path: '/api/products/{id}' }),
  }),
});

shop.document;   // { $contract: '0.1', id: 'shop', $defs: { Product: {…} }, operations: {…} } — @jarenjs/contract takes it unchanged
const api = typedClient(openHttpClient(compileContract(shop.document), { baseUrl }), shop);
const outcome = await api.invoke('product.save', { id: 1, product });   // Outcome<Product>: ok | conflict, both typed
```

An HTTP client takes `typedHttpClient` instead: the same typed client
plus `bytes` over the opaque operations (`OpaqueOf<typeof shop>`), whose
success is a live response stream rather than a JSON value.

How to read it: an operation is a kind (`read`, `command`, `subscribe`),
its input and output schemas by the schema pen, its named errors and its
binding. A `named()` schema is hoisted into the contract's own `$defs`
and referenced from every operation that uses it, and every member is
written in the order CONTRACT-FORMAT §12.1 fixes, so the pen's document
and the compiler's own public projection differ by nothing but the
defaults the compiler materializes. The types come with it and never
run the TypeScript projection: the same `shop` that typed the client
types the server's `typedHandlers` table and an AI toolbox's
`typedTools`. The mapping table and the worked examples are
[docs/CONTRACT-PEN.md](docs/CONTRACT-PEN.md).

## By code: the flow pen

`@jarenjs/linq/flow` writes the two `@jarenjs/flow` documents — a
`jaren-fsm` 0.1 machine and a `jaren-dag` 0.1 dataflow. State ids, event
names and node ids are literal types, so a transition into an undeclared
state or an edge from an undeclared node is a compile error; guards,
effect props, node queries and edge selectors are captured callbacks,
never a path typed as a string.

```js
import { defineFsm, on, state } from '@jarenjs/linq/flow';
import * as s from '@jarenjs/linq/schema';
import { compileFsm, fsmToApp } from '@jarenjs/flow';

const Approval = s.object({ fresh: s.boolean() });

const review = defineFsm({
  initial: 'draft',
  states: ['draft', 'review', state('published', { final: true })],
  transitions: [
    on('draft', 'submit').to('review'),
    on('review', 'approve', { payload: Approval }).when((x) => x.payload.fresh).to('published'),
    on('review').to('draft'),                    // a wildcard, listed last: document order is the priority
  ],
});

compileFsm(review).step('review', 'approve', { payload: { fresh: true } });   // { state: 'published', final: true, … } — @jarenjs/flow takes it unchanged
fsmToApp(review);                                                            // and so does the app projection
```

How to read it: `on(from, event)` opens a transition, `.when()` guards
it with a callback over the payload and the context, `.to()` closes it;
a transition without an event is a wildcard, and document order is the
engine's priority order. A guard is recorded, never typed as a string,
which is also how the pen refuses the one trap FLOW-FORMAT §3 names
itself — a plain-string guard that is vacuously true (`JL0102`). A
dataflow is written the same way with `defineDag`, `node` and `edge`.
The mapping table and the worked examples are
[docs/FLOW-PEN.md](docs/FLOW-PEN.md).

## By code: the app pen

`@jarenjs/linq/app` writes the `jaren-app` 0.1 document `createApp` runs
— a whole interactive application as one JSON value — and answers the
state's JSON Schema beside it for `validateState`. Reach for it when the
state shape, the view, the actions and their patch pointers should be
one typed declaration: the initial state comes from the state schema's
own `default()`s, and a patch path is a lambda over the state that
lowers to a JSON Pointer.

```js
import { action, append, bind, defineApp, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';

const { document, stateSchema } = defineApp({
  state: s.object({ todos: s.array(s.string()).default([]), draft: s.string().default('') }),
  view: [rule('$', (v) => ['main', {},
    ['button', { on: { click: bind('todo/add', { payload: v.draft }) } }, 'add']])],
  actions: {
    'todo/add': action((st, x) => transition({ patch: [append((c) => c.todos, x.payload)] })),
  },
});

document;      // { $app: '0.1', state: { todos: [], draft: '' }, view: [...], actions: {…} } — the initial state from the schema's defaults
createApp(document, { node, validateState: new JarenValidator().compile(stateSchema) });   // @jarenjs/app takes it unchanged
```

How to read it: the view is JSLT rules over the state (the same pen),
`bind()` names the action a DOM event dispatches with its payload, and
an action's callback is captured over APP-FORMAT §3.1's three names
(`$` the state, `$payload`, `$event`), so a patch value and an effect's props
are the SAME expression when they should be. A patch path is a lambda
over the state that lowers to a JSON Pointer — `(c) => c.todos.at(2).done`
is `/todos/2/done`, and a computed index becomes the pointer expression
`{ "$concat": ["/todos/", "$payload.i", "/done"] }`. Two refusals the
loop can only report per dispatch land at build time instead: a view
binding an action `actions` does not declare (`JA2001`), and an `$event`
field §3.1 excludes because `$event` must survive `JSON.stringify`
(`JL0102`). The mapping table and the worked examples are
[docs/APP-PEN.md](docs/APP-PEN.md).

## By code: the forms pen

`@jarenjs/linq/forms` is the schema pen plus the `x-form` vocabulary —
`form({ visible, enabled, assert, computed, message })` on every builder
— and `assertOnSubmit()`, which answers the same rules' layer-3 `$query`
twin in one call. A rule is an annotation: nothing about what the schema
validates moves, and the rules are callbacks over `c.root`, `c.value`
and `c.pointer`, never a path typed as a string.

```js
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';
import { buildFormModel, compileFormRules } from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';

const invoice = f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: 'VAT id is required for companies',
  }),
});

invoice.schema;                                              // a JSON Schema whose vatId carries x-form: { visible, assert, message }
compileFormRules(buildFormModel(invoice.schema));            // @jarenjs/forms: per keystroke — visibility, enablement, the message
new JarenValidator().compile(assertOnSubmit(invoice));       // @jarenjs/validate: on submit — the same rule, as a $query assertion
```

How to read it: `form()` writes the `x-form` annotation beside the
keywords the schema already has, so `Infer<>` reads exactly as it does
on `./schema` and a validator that ignores `x-form` validates the same
data. Each rule's callback is recorded over the three names the form
evaluator binds — `c.root` the whole document, `c.value` this field,
`c.pointer` its location — and `assertOnSubmit()` rewrites the `assert`
rules into the `$query` keyword so the server checks on submit what the
form showed per keystroke. The mapping table and the worked examples
are [docs/FORMS-PEN.md](docs/FORMS-PEN.md).

## The front door: `@jarenjs/linq/db`

`open(model, { driver })` opens `@jarenjs/db`'s store and fronts it with
handles typed from the model pen — no cast, no generate step. Every read
is the chain and pushes down; `include` emits the store's one-statement
`load` spec; `link`/`unlink` reach the store's membership API; `live` is
the store's registration with the chain's bound params; and `explain()`
names what ran at every level — the chain's document and hops, the
graph's SQL and pagination strategy, the store's residual reasons.

```js
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
import { model } from './model.js';                          // defineModel(…) from the model pen

const db = await open(model, { driver: nodeDriver() });     // validated by default: formats assert
const hot = await db.entities.Post
  .where((p) => p.stars.ge(3)).orderBy((p) => p.pid).toArray();   // Post[], pushed down to SQL
const users = await db.entities.User
  .include((u) => u.posts, { where: (p) => p.stars.ge(3), take: 2 })   // one statement, whatever the depth
  .include((u) => u.labels, { count: true })
  .toArray();                                                // posts: Post[], labels: number
db.entities.User.link(users[0], 'labels', 'admin');          // 'labels' only: the many-to-many members
await db.saveChanges();                                      // the unit of work: get, mutate, save
const live = await db.live(db.entities.Post.where((p) => p.stars.ge(3)));   // { result, subscribe, close, mode }

await db.transaction(async (tx) => {                         // a client of its own, inside the transaction
  tx.entities.Post.add({ title: 'draft', stars: 0, authorId: users[0].id });
  await tx.saveChanges();                                    // its own unit of work: nobody else sees it
});
```

`createDbLedger(db)` is the third export: the `@jarenjs/contract`
idempotency ledger over a declared collection of the store the client
opened — root claims under an immediate transaction so two processes
see one `new`, a transaction client's settlements inside the host's own
transaction, a persisted generation fence (`JL2007` for a stale ref) —
with no edge from the contract package to a store
([DB-CLIENT §2.6](docs/DB-CLIENT.md#26-the-ledger)).

How to read it: `db.entities.Post` is a chain root typed from the model,
so `p.stars` is a number in the editor and `p.author.email` is a
declared hop; `include` is a typed `load` spec and answers a two-level
graph in ONE statement; a write is the unit of work — get an entity,
mutate it, `saveChanges()` — and `live` re-answers a chain when the
store changes.

Every large read is a real cursor or a bounded page. A `for await`
over a chain pulls one row per item from an open statement and a
`break` releases it (three rows of twenty thousand cost three rows);
`graph.cursor()` yields one root graph per pull with its includes
attached, every include bounded per root (`maxRows`, `maxBytes`, a
coded refusal — never a truncated graph); and `graph.page({ limit,
after, maxBytes })` — `db.entities.Post.graph()` opens a graph with
nothing included — pages over a composite keyset with the primary key
appended, answering `{ items, continuation, hasMore, snapshot }`
whose continuation is typed by the declared `orderBy`/`thenBy` and is
unsigned and structural: the host signs it. The store's `explain()`
says what each read will do (`streaming`, `barrier`, `budget`) before
it runs:

```js
for await (const post of db.entities.Post.where((p) => p.stars.ge(3))) {   // one row per pull
  if (post.stars > 100) break;                                              // the statement is released here
}
const page = await db.entities.Post.graph()
  .orderByDescending((p) => p.stars).thenBy((p) => p.pid)
  .page({ limit: 20, maxBytes: 65536 });                                    // { items, continuation, hasMore, snapshot: false }
const next = await db.entities.Post.graph()
  .orderByDescending((p) => p.stars).thenBy((p) => p.pid)
  .page({ limit: 20, after: page.continuation });                            // the same ordering, or JD0035
```

`transaction` hands its callback a client of the same shape, over the
store INSIDE the transaction, with a unit of work of its own — so two
request handlers on one client hold two records for the same entity key
and neither sees the other's pending state. The outer `db.entities.X` is
by construction an unrelated caller: from inside, it waits for the commit
and then names itself `JD0012` rather than joining a transaction it is
not part of. One client is safe for a handler per request. The
transaction client is pinned to its EXACT scope — a handle kept past its
callback refuses `JD2070` instead of following a later transaction — and
forwards the store's `tx.savepoints` (MODEL-FORMAT §5.2), so a callback
can create, roll back to and release a named checkpoint mid-transaction
without throwing for control flow:

```js
await db.transaction(async (tx) => {
  await tx.savepoints.create('before-optional-import');
  tx.entities.Post.add({ title: 'optional', stars: 0, authorId: users[0].id });
  const report = await tx.saveChanges();                     // landed inside the transaction
  if (report.fallbacks > 0) {                                // …until the caller changes its mind
    await tx.savepoints.rollbackTo('before-optional-import');  // the add is pending again
  }
  await tx.savepoints.release('before-optional-import');     // the checkpoint is spent; the rest commits
});
```

This subpath is the package's one runtime edge: it
imports `@jarenjs/db`, `@jarenjs/validate` and `@jarenjs/formats` as
OPTIONAL peer dependencies, so `npm install @jarenjs/linq` alone
installs nothing new and the `.` entry carries not one byte of them
(a tree-shaking gate holds it). What is the store's and what is the
client's — the surface, the refusals, and what the door costs, measured
against Prisma, Drizzle and Kysely — is
[docs/DB-CLIENT.md](docs/DB-CLIENT.md).

## What a pen costs

A pen builds a **definition** — once, at module load — and the engine
compiles the document it emitted. That is the only place its price is
paid, and `benchmark/db.js` measures it as ns per build beside the
hand-written literal each pen must emit byte for byte — <!--fact:linq.penBuildCost-->schema 55.7×, model 89.4×, JSLT 61.2× a hand-written literal, and the migration pen 1.4× a hand-written document carrying the same two shape hashes<!--/fact-->.

Multiples that size are what typed builders, `$defs` hoisting, a
deep-freeze and a coded refusal per mistake cost against typing the JSON
yourself; against a request they cost nothing, because no request builds
a definition. The one pen that is nearly free is the migration pen, and
for a plain reason: a `$migration` document IS its two shape hashes, so
a hand-written one has to canonicalize and hash both models too.

The chain's price is a different shape and is published beside it: a
chain re-captures and re-emits its document on every call, so the
in-memory row in the same benchmark reports the loop, the chain and the
pre-compiled document as three separate figures.

## What this is not

Not a storage engine — the store is `@jarenjs/db`'s: its model, its
tables, its translator, its unit of work and its migrations live there,
and `@jarenjs/linq/db` is that store's front door, not a second engine
(it adds no storage semantics and duplicates no algorithm; every read it
makes is a query document or a `load` spec the store already runs, and
the store never imports this package).
Not expression trees over arbitrary methods — the vocabulary is the
query engine's, and an unknown METHOD fails loudly at build time with
a coded error (`JL0001`–`JL0007`; the pens' and the client's refusals are `JL0101`–`JL0107`)
rather than guessing. JavaScript's own
operators are the one thing a proxy cannot trap: `&&`, `||`, `!`, `?:`
and `===` evaluate against the proxy object and yield a wrong document
silently (use `.and()`/`.or()`/`.not()`), and `u.age > 21` or `u.age + 1`
throw a plain `TypeError` — the format doc's §3 lists them. Not a
general lazy-iterable library — if you don't want a query document,
you don't want this package.

The normative mapping — every operator, its emitted phrase, and the
deliberate deviations — is [docs/QUERY-PEN.md](docs/QUERY-PEN.md);
internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.linq-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/linq` | JavaScript | declared |
| `@jarenjs/linq/schema` | JavaScript | declared |
| `@jarenjs/linq/model` | JavaScript | declared |
| `@jarenjs/linq/jslt` | JavaScript | declared |
| `@jarenjs/linq/migration` | JavaScript | declared |
| `@jarenjs/linq/contract` | JavaScript | declared |
| `@jarenjs/linq/flow` | JavaScript | declared |
| `@jarenjs/linq/app` | JavaScript | declared |
| `@jarenjs/linq/forms` | JavaScript | declared |
| `@jarenjs/linq/db` | JavaScript | declared |
| `@jarenjs/linq/package.json` | metadata | — |
| `@jarenjs/linq/charts` | JavaScript | declared |
| `@jarenjs/linq/project` | JavaScript | declared |
| `@jarenjs/linq/jtlt` | JavaScript | declared |
| `@jarenjs/linq/messages` | JavaScript | declared |
| `@jarenjs/linq/ai` | JavaScript | declared |
<!--/fact-->

Explicit cross-provider joins use `federate({ sources, maxRows, maxBytes,
maxTotalRows, maxTotalBytes })`. Connected joins across three or more sources,
including successive fluent `.join()` calls, preserve the engine's result
order while sharing cumulative admission credits. See
[QUERY-PEN §12.1](docs/QUERY-PEN.md#121-the-federation-boundary-federate) for
planning, buffering limits and cleanup guarantees.
