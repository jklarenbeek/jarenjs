# The Jaren pens (normative)

> this file, the binder and the family's **normative reference**: what a
> pen is, the rules all of them keep, the shared `JL01xx` table, and the
> cross-pen views derived from the guides it indexes. **Read it when**
> you want a rule that is true of every pen, an index of the
> documents, or one place to look up a method without knowing which pen
> owns it

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119.

## 1. Scope and the pen rules

A **pen** is a by-code front-end to one of the suite's document formats:
named functions that build a standard document — a JSON Schema, a
`$model`, a `$jslt` stylesheet — the way the chain builds a query
document. `@jarenjs/linq` exports each pen under its own subpath
(<!--fact:coverage.subpaths-->`./ai`, `./app`, `./charts`, `./contract`, `./db`, `./flow`, `./forms`, `./jslt`, `./jtlt`, `./messages`, `./migration`, `./model`, `./project`, `./schema`<!--/fact-->); `.` stays the chain.

Coverage: <!--fact:coverage.pens-->14 public pen/client subpaths beside the chain; 69/69 owned schema keywords have dedicated emission routes.<!--/fact-->

**This document is the family's normative reference**: §1 states the
rules every pen keeps, §1.3 the error codes they share, and §4–§7 the
cross-pen views — the census, the refusal map, the measured price of each
subpath, and every pen's mapping table in one place — none of which is
written here, all of it derived from the documents beside it. Those
are **guides**: each opens with the problem its pen solves, builds one
document across its sections, and carries exactly one normative section
of its own, the mapping table its rows here come from. So the two
questions have two homes and neither is a copy of the other — "what is
true of every pen, and where do I look this method up" is answered here;
"how do I write one of these documents" is answered there. This section
is the index of those guides, and it is how a reader reaches any of them.

<!--fact:pens.index-->
| Document | Lines | What it writes, and when to open it |
|---|---:|---|
| [LINQ-FORMAT.md](LINQ-FORMAT.md) | 948 | this file, the binder and the family's **normative reference**: what a pen is, the rules all of them keep, the shared `JL01xx` table, and the cross-pen views derived from the guides it indexes. **Read it when** you want a rule that is true of every pen, an index of the documents, or one place to look up a method without knowing which pen owns it |
| [QUERY-PEN.md](QUERY-PEN.md) | 1,735 | the chain, `.` — query documents (`jaren-query`) and the provider seam. **Read it when** you are querying data, or implementing a provider that answers a query document |
| [SCHEMA-PEN.md](SCHEMA-PEN.md) | 1,205 | `./schema` — JSON Schema 2020-12: the structural keywords, the constraints and the annotations, each with a method of its own, plus `$query`, `$defs`/`$ref` recursion and the normalizer's per-field predicates. **Read it when** you are describing the shape of data — for validation, for a form, or as the base of an entity |
| [MODEL-PEN.md](MODEL-PEN.md) | 1,092 | `./model` — the `x-entity` vocabulary on JSON Schema, and the `$model` 0.1 document `openStore` accepts unchanged. **Read it when** you are declaring a store's entities, their keys and their relations |
| [JSLT-PEN.md](JSLT-PEN.md) | 955 | `./jslt` — `$jslt` 0.1 stylesheets: the envelope and its rules, whose bodies are captured over the matched value. **Read it when** you are transforming one document into another |
| [MIGRATION-PEN.md](MIGRATION-PEN.md) | 781 | `./migration` — `$migration` 0.1 documents: the two shape hashes and the ordered steps the runner takes. **Read it when** you are moving a store from one model to the next |
| [CONTRACT-PEN.md](CONTRACT-PEN.md) | 1,221 | `./contract` — `$contract` 0.1 documents: the operations, their schemas, their declared behavior and their REST binding. **Read it when** you are declaring an API and want its client, its server and its tools typed from one document |
| [FLOW-PEN.md](FLOW-PEN.md) | 1,033 | `./flow` — `jaren-fsm` 0.1 machines and `jaren-dag` 0.1 dataflows, every query-valued member captured. **Read it when** you are declaring a state machine or a dependency graph of tasks |
| [APP-PEN.md](APP-PEN.md) | 1,143 | `./app` — the `jaren-app` 0.1 document `createApp` runs, and the JSON Schema of its state beside it. **Read it when** you are declaring a whole application: state, view, actions, effects |
| [FORMS-PEN.md](FORMS-PEN.md) | 940 | `./forms` — the `x-form` vocabulary on JSON Schema, and `assertOnSubmit()`, the same rules' layer-3 `$query` twin. **Read it when** you are turning a schema into a form |
| [AI-PEN.md](AI-PEN.md) | 98 | `./ai` — the public action program over environment slots. **Read it when** you want typed fixtures or host-authored programs without a model client. |
| [MESSAGES-PEN.md](MESSAGES-PEN.md) | 105 | `./messages` — JSON message catalogs and message references. **Read it when** you want checked translation keys, placeholders and explicit completeness. |
| [JTLT-PEN.md](JTLT-PEN.md) | 83 | `./jtlt` — text templates with JSLT dispatch and query expressions. **Read it when** you want to author Markdown, XML or source text as portable JSON. |
| [PROJECT-PEN.md](PROJECT-PEN.md) | 75 | `./project` — Studio projects with named, typed files. **Read it when** you want a portable editor workspace containing documents written by several pens. |
| [CHARTS-PEN.md](CHARTS-PEN.md) | 94 | `./charts` — chart-definition documents for every chart kind. **Read it when** you want typed chart data and presentation options that `compileChart` consumes. |
| [DB-CLIENT.md](DB-CLIENT.md) | 893 | `./db` — the client: the store's typed front door, not a pen, and the package's one runtime edge. **Read it when** you are reading or writing rows: `load`, `include`, `link`/`unlink`, `live` |
<!--/fact-->

Every row of that table is derived, and none of it is written here: the
sentence is the document's own opening line, the length is the file's,
and `npm run docs:derive` writes the table out of the documents in this directory. The line counts are not decoration — they are what tells
a reader whether the document they are about to open is a ten-minute read
or an afternoon — and `test/docs/format-citations.test.js` holds each one
equal to the file it names, independently of the derivation.

A document missing from that table is a document a reader cannot reach:
the website opens these files through the binder and only through the
binder, so the index IS the directory listing, and a pen added to
`packages/linq/docs/` appears here the next time the derivation runs.

§2 to §5 are derived the same way, from the same documents. They
exist so that a reader with a cross-pen question — which pens raise
`JL0104`, what a subpath costs, which pen has a `named()` — has one
place to look, and so that the answer is never a second copy anybody has
to keep true: **a row in a derived block is edited in the document it
came from**, and `npm run docs:check` fails until this file
agrees with it again.

### 1.0 What is a pen, what is not, and why

A pen exists where a document is **authored by a person** and an engine
compiles it. That is the whole test, and it decides both lists below. A
format whose documents are produced by a parser, generated by a tool,
projected from another document, or exchanged on a wire is not authored,
so a builder for it would type nothing a caller writes; a schema for
data rather than for a program has no compile step to be faithful to.

| Document (grammar) | Home | Pen | Document |
|---|---|---|---|
| JSON Schema (+ `$query`, `errorMessage`/`$msgid`, `x-coerce`/`x-trim`) | `@jarenjs/validate` | **`./schema`** | [SCHEMA-PEN.md](SCHEMA-PEN.md) |
| `x-entity` on JSON Schema; `$model` 0.1 (`jaren-model`) | `@jarenjs/db` | **`./model`** | [MODEL-PEN.md](MODEL-PEN.md) |
| query documents (`jaren-query`) | `@jarenjs/json` | **the chain**, `.` | [QUERY-PEN.md](QUERY-PEN.md) |
| `$jslt` 0.1 (`jaren-jslt`) | `@jarenjs/json` | **`./jslt`** | [JSLT-PEN.md](JSLT-PEN.md) |
| `$migration` 0.1 (`jaren-migration`) | `@jarenjs/db` | **`./migration`** | [MIGRATION-PEN.md](MIGRATION-PEN.md) |
| `$contract` 0.1 (`jaren-contract`) | `@jarenjs/contract` | **`./contract`** | [CONTRACT-PEN.md](CONTRACT-PEN.md) |
| `$fsm` 0.1, `$dag` 0.1 (`jaren-fsm`, `jaren-dag`) | `@jarenjs/flow` | **`./flow`** | [FLOW-PEN.md](FLOW-PEN.md) |
| `jaren-app` 0.1 | `@jarenjs/app` | **`./app`** | [APP-PEN.md](APP-PEN.md) |
| `x-form` on JSON Schema | `@jarenjs/forms` | **`./forms`** | [FORMS-PEN.md](FORMS-PEN.md) |
| AI action program | `@jarenjs/ai` | **`./ai`** | [AI-PEN.md](AI-PEN.md) |
| message catalogs / MessageSpec | `@jarenjs/core`, validate/forms/contract | **`./messages`** | [MESSAGES-PEN.md](MESSAGES-PEN.md) |
| `$jtlt` 0.1 (`jaren-jtlt`) | `@jarenjs/json` | **`./jtlt`** | [JTLT-PEN.md](JTLT-PEN.md) |
| `jaren-project` | `@jarenjs/studio` | **`./project`** | [PROJECT-PEN.md](PROJECT-PEN.md) |
| `chart-definition` | `@jarenjs/charts` | **`./charts`** | [CHARTS-PEN.md](CHARTS-PEN.md) |

The authored-document formats above share the public JSON boundary. Message
catalogs preserve template strings; locale render functions remain executable
code at the existing renderer boundary, as MESSAGES-PEN documents.

Formats with **no pen, by decision**, each for the reason its row gives:

| Document | Why not |
|---|---|
| `$md`, `$mermaid`, the calc AST | parser OUTPUTS — nobody writes one by hand |
| `jaren-emit-model` | generated by `@jarenjs/emit`; the agreement suite consumes it |
| `jaren-workflow` | a PROJECTION of a machine; the fsm pen's documents are its executable superset |
| `jaren-vnode(-safe)` | an output vocabulary, produced by views |
| `jaren-contract-port` frames | wire frames, not authored documents |
| GeoJSON, JOSL data, calc state, financial inputs, site documents | data schemas — there is no engine compiling them as a program |
| LIVE options, JOBS payloads | option objects AROUND a query or dag document; `live` is a client terminal ([DB-CLIENT.md](DB-CLIENT.md)) |
| `ToolDef` (`{ name, description, inputSchema, execute }`) | its `inputSchema` is already the schema pen's document, and `execute` is typed by `Infer<>` over it |

### 1.1 The rules

1. **The document is the deliverable.** A pen emits exactly the published
   document: plain, deep-frozen JSON (`JSON.parse(JSON.stringify(x))`
   deep-equals `x`; no functions, no class instances), valid under the
   published grammar. `.schema` is the document, `toJSON()` returns it,
   so `JSON.stringify(builder)` and `structuredClone(builder.schema)` are
   the document. A pen imports no engine; the engine's compiler is the
   only judge of semantics. A pen refuses only what it cannot SPELL, or
   what the engine's own rule would refuse and the pen can see earlier —
   mirrored, never invented — with a coded `JL01xx` build error. There is
   no pen-private dialect, no `.transform()`-style function member and
   no re-implementation of a compile check.
2. **Types are phantoms; the pen is the only inference route.** `Infer<>`,
   `Input<>` and their kin exist at compile time only. A JSON literal is
   never inferred: `from(json)` types as `unknown` unless the caller
   asserts (`from<T>(json)`), and a reference by name (`ref<T>(name)`)
   likewise. Every type claim is pinned three ways over one corpus — the
   pen's type equals emit's declaration for the emitted document, and both
   correspond to the validator's verdicts — plus a runtime twin.
3. **Home and shape.** A pen lives at `packages/linq/src/<pen>/` and
   exports NAMED functions (`import * as s`), never a namespace object; a
   pen that extends another does so by subclassing through the base
   class's `with()`, never by patching an imported prototype. The only
   shared runtime machine is the chain's recording proxy — with the one
   root capture over it (`captureQuery`: a value at `$`, named externals)
   that every query-valued member is captured through, the JSON boundary
   (`requireJson`) and the builder brand. Every subpath has a tree-shaking
   probe: a pen-only bundle carries no chain module and no engine.
5. **A map is read by its own keys, and written by them.** Wherever a pen
   takes a name → value map — members, entities, operations, nodes,
   actions, modes — it reads the map's OWN enumerable keys and emits each
   as an own member. Two JavaScript hazards sit on that path and both are
   closed: a `__proto__:` key in an object LITERAL sets the prototype
   instead of adding a member, so such a map is refused (`JL0101`, naming
   the `{ ['__proto__']: … }` spelling that works); and writing a member
   back with a plain assignment would reassign the EMITTED object's
   prototype, so every pen writes through `setObjectMember`. A member
   named `__proto__` is therefore ordinary data, in a schema's
   `properties`, in a model's `entities`, in a contract's `operations`, in
   a dag's `nodes` and in an app's `actions` alike.
4. **Objects are closed by default.** `object()` emits
   `additionalProperties: false`; `.open()` removes it. The type follows
   emit's reading of the EMITTED document in both cases: an index
   signature only for an open object.

### 1.2 Immutability and identity

Every builder is immutable and frozen; every method answers a new
builder. `.schema` assembles once and memoizes; two builds of the same
spelling are one document (`deepStrictEqual`). A builder used in two
places emits twice, as JSON; a NAMED builder (`named(name, b)`) emits
once, into `$defs`, and is referenced by `$ref` from every place it is
reached — also when reached once, because a name is a statement of
intent and a stable `$defs` is what a contract's definitions and a
bundler read.

### 1.3 Error codes

Pen refusals are `LinqBuildError`s with these codes, in `LINQ_CODES` and
mirrored in QUERY-PEN §9 (one table, held equal by a test):

| Code | Condition |
|---|---|
| `JL0101` | a pen received a value it cannot spell, or a map it cannot read: a name → value map whose prototype a `__proto__:` literal replaced (§1.1 rule 5); a value that is not JSON (a function, symbol, bigint, `NaN`, `±Infinity`, `-0`, a class instance, a cycle — the constant rule of QUERY-PEN §5 applied to defaults, literals, examples and annotations), or not what the keyword takes (`min('x')`, a member that is not a builder); in the contract pen, also a member the pen's own surface does not know or a value outside a declared set (a `policy` member outside §3.1's table, a method outside §4's, a status outside its range) — the document's own closed vocabulary stays `compileContract`'s `JC0013`; in the app pen a member of its own surface it does not know, a `payload` that is not a builder, or a CALLBACK under a subscription's `with` (which is verbatim data and never evaluated); in the forms pen a member `x-form` does not define, or a `message` that is neither an inline string nor a MessageSpec |
| `JL0102` | a pen was asked for a construct the format cannot carry: a function `refine`/`transform` (cross-field rules are `check()`; transforms are application code), a coercion the normalizer would never run, closed objects under `allOf`, an annotation on `never()`, a draft the pen does not write; in the JSLT pen an `apply()` as a bare object member (the `[]` idiom, JSLT-FORMAT §6.3 — the engine would fail at run time on the second child), a `match` of `{}` (the compiler's `JT0003`, earlier), an `apply()` outside a body; in the contract pen a path template form CONTRACT-FORMAT §4.2 reserves (the compiler's `JC0008`, earlier, naming the same form), a member mapped to `path` the template does not declare, or a hand-written operation `kind` outside `read`/`command`/`subscribe`; in the flow pen a guard given as a plain STRING (FLOW-FORMAT §3 makes a non-`$` literal vacuously true, so a projected display annotation must not decide execution), or a state or node id no declaration carries (the compiler's `JF0004`/`JF0006`/`JF0013`, earlier, naming the id); in the app pen a patch path that is not a chain of member reads and subscripts (a JSON Pointer cannot be written for it), an `$event` field APP-FORMAT §3.1 excludes by construction (`target`, `files`, a touch list — `$event` must survive `JSON.stringify`), an initial state no `default()` describes, a subscription-member combination §5.3 calls `JA0008`, or a view binding an action `actions` does not declare (the loop's `JA2001`, earlier, naming the declared ones); in the forms pen `preview`, which the format registry DERIVES from the field's own `format` |
| `JL0103` | a `$defs` name collision (two distinct builders under one name), a `ref()` no definition answers, or a `lazy()` that does not return a named builder |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare: a `check()` external other than `root`/`path`, a `compute()` external at all, a `body()` external other than `root`/`path` and its declared parameters — or `root`/`path` declared as one, since the engine binds them; a flow guard, effect `with`, node query or edge `select` external at all, since both flow engines evaluate with one `$` and nothing else; an app action naming anything but `$event` and `$payload` (APP-FORMAT §3.1's whole ambient vocabulary), a subscription member naming anything but `$item`, and that only under `for` (§5.3's closed world); a form rule naming anything but the context's `root`, `value` and `pointer` |
| `JL0105` | a relation hop on the chain — the query pen (QUERY-PEN §4, relation navigation) — cannot lower: the relation's key column or the key it references is composite or undeclared; a many-to-many entry does not name its join row's columns (`{ joinTable, ownColumn, ownKey, targetColumn, targetKey }`), so there is no join root to lower through; the relation kind is not one this surface lowers; or the provider's relation table holds something that is not a relation record |
| `JL0106` | a migration step names an entity or collection the target model does not declare (`transform`, `assert`, `derive`); or a `transform` over a planned document finds no draft to replace, or two drafts for one name |
| `JL0107` | the client (`@jarenjs/linq/db`, [DB-CLIENT.md](DB-CLIENT.md)) was handed a member that is not the relation kind the operation needs: `include()` picks a declared relation member — a scalar member, or a name the model does not declare, is refused naming the declared ones; `link()`/`unlink()` attach many-to-many memberships only — a to-one or to-many relation is refused naming its kind |

The message names the fix; `docPath` is the JSON pointer of the node
being assembled where one exists (`/properties/lines/items`).

## 2. The census

What each document covers, counted from the document
itself. Every column has a gate behind it in a different file: the
mapping rows are held equal to the subpath's callable names, the worked
examples are executed against the JSON beside them, the refusal count is
held equal to the codes that pen's source raises — in both directions —
and the bundle is the byte count the tree-shaking probe builds.

<!--fact:pens.census-->
| Document | Subpath | Lines | Mapping rows | Worked examples | Refusals | Bundle |
|---|---|---:|---:|---:|---:|---:|
| [LINQ-FORMAT.md](LINQ-FORMAT.md) | — | 948 | — | — | — | — |
| [QUERY-PEN.md](QUERY-PEN.md) | `.` | 1,735 | 34 | 8 | 15 | 174,241 B |
| [SCHEMA-PEN.md](SCHEMA-PEN.md) | `./schema` | 1,205 | 82 | 10 | 4 | 36,717 B |
| [MODEL-PEN.md](MODEL-PEN.md) | `./model` | 1,092 | 28 | 6 | 3 | 45,143 B |
| [JSLT-PEN.md](JSLT-PEN.md) | `./jslt` | 955 | 17 | 8 | 3 | 19,856 B |
| [MIGRATION-PEN.md](MIGRATION-PEN.md) | `./migration` | 781 | 11 | 5 | 4 | 24,259 B |
| [CONTRACT-PEN.md](CONTRACT-PEN.md) | `./contract` | 1,221 | 38 | 6 | 3 | 48,859 B |
| [FLOW-PEN.md](FLOW-PEN.md) | `./flow` | 1,033 | 16 | 7 | 3 | 19,910 B |
| [APP-PEN.md](APP-PEN.md) | `./app` | 1,143 | 22 | 7 | 3 | 51,006 B |
| [FORMS-PEN.md](FORMS-PEN.md) | `./forms` | 940 | 18 | 6 | 3 | 40,873 B |
| [AI-PEN.md](AI-PEN.md) | `./ai` | 98 | 12 | 1 | 3 | 16,904 B |
| [MESSAGES-PEN.md](MESSAGES-PEN.md) | `./messages` | 105 | 9 | 2 | 1 | 18,363 B |
| [JTLT-PEN.md](JTLT-PEN.md) | `./jtlt` | 83 | 13 | 1 | 2 | 16,725 B |
| [PROJECT-PEN.md](PROJECT-PEN.md) | `./project` | 75 | 9 | 1 | 1 | 15,132 B |
| [CHARTS-PEN.md](CHARTS-PEN.md) | `./charts` | 94 | 21 | 1 | 1 | 17,014 B |
| [DB-CLIENT.md](DB-CLIENT.md) | `./db` | 893 | 41 | 4 | 2 | 633,786 B |
| **16 documents** | | **12,401** | **371** | **73** | | |
<!--/fact-->

A pen whose mapping rows are far below its worked examples is a pen
whose surface is being taught by example rather than named; the opposite
is a reference nobody has exercised. Both are visible here and nowhere
else.

## 3. Where each refusal is raised

§1.3 says what each shared code MEANS. This says who raises it — one row
per code, naming every document whose refusal section carries it. The
meanings are written by a person and the raisers are not: each document's
refusal section is held equal to the codes its own source directory
throws, so this table moves when a pen's source does.

<!--fact:pens.codes-->
| Code | Raised by |
|---|---|
| `JL0101` | [SCHEMA-PEN.md](SCHEMA-PEN.md), [MODEL-PEN.md](MODEL-PEN.md), [JSLT-PEN.md](JSLT-PEN.md), [MIGRATION-PEN.md](MIGRATION-PEN.md), [CONTRACT-PEN.md](CONTRACT-PEN.md), [FLOW-PEN.md](FLOW-PEN.md), [APP-PEN.md](APP-PEN.md), [FORMS-PEN.md](FORMS-PEN.md), [AI-PEN.md](AI-PEN.md), [MESSAGES-PEN.md](MESSAGES-PEN.md), [JTLT-PEN.md](JTLT-PEN.md), [PROJECT-PEN.md](PROJECT-PEN.md), [CHARTS-PEN.md](CHARTS-PEN.md), [DB-CLIENT.md](DB-CLIENT.md) |
| `JL0102` | [SCHEMA-PEN.md](SCHEMA-PEN.md), [MODEL-PEN.md](MODEL-PEN.md), [JSLT-PEN.md](JSLT-PEN.md), [MIGRATION-PEN.md](MIGRATION-PEN.md), [CONTRACT-PEN.md](CONTRACT-PEN.md), [FLOW-PEN.md](FLOW-PEN.md), [APP-PEN.md](APP-PEN.md), [FORMS-PEN.md](FORMS-PEN.md), [AI-PEN.md](AI-PEN.md) |
| `JL0103` | [SCHEMA-PEN.md](SCHEMA-PEN.md), [CONTRACT-PEN.md](CONTRACT-PEN.md) |
| `JL0104` | [SCHEMA-PEN.md](SCHEMA-PEN.md), [MODEL-PEN.md](MODEL-PEN.md), [JSLT-PEN.md](JSLT-PEN.md), [MIGRATION-PEN.md](MIGRATION-PEN.md), [FLOW-PEN.md](FLOW-PEN.md), [APP-PEN.md](APP-PEN.md), [FORMS-PEN.md](FORMS-PEN.md), [AI-PEN.md](AI-PEN.md), [JTLT-PEN.md](JTLT-PEN.md) |
| `JL0105` | [QUERY-PEN.md](QUERY-PEN.md) |
| `JL0106` | [MIGRATION-PEN.md](MIGRATION-PEN.md) |
| `JL0107` | [DB-CLIENT.md](DB-CLIENT.md) |
<!--/fact-->

A code in §1.3 that no document raises fails the derivation rather than
appearing with an empty cell: a shared refusal nobody can reach is either
a dead code or a document that forgot it, and both need a person.

## 4. What each subpath costs

The minified, tree-shaken ESM bundle a consumer takes when they import
one subpath and nothing else, as `scripts/check-tree-shaking.js` measures
it and each document publishes it. The rounded column is what
[docs/CONSUMING.md](../../../docs/CONSUMING.md) states.

<!--fact:pens.cost-->
| Subpath | Document | Bundle | Rounded |
|---|---|---:|---:|
| `@jarenjs/linq` | [QUERY-PEN.md](QUERY-PEN.md) | 174,241 B | 174 kB |
| `@jarenjs/linq/schema` | [SCHEMA-PEN.md](SCHEMA-PEN.md) | 36,717 B | 37 kB |
| `@jarenjs/linq/model` | [MODEL-PEN.md](MODEL-PEN.md) | 45,143 B | 45 kB |
| `@jarenjs/linq/jslt` | [JSLT-PEN.md](JSLT-PEN.md) | 19,856 B | 20 kB |
| `@jarenjs/linq/migration` | [MIGRATION-PEN.md](MIGRATION-PEN.md) | 24,259 B | 24 kB |
| `@jarenjs/linq/contract` | [CONTRACT-PEN.md](CONTRACT-PEN.md) | 48,859 B | 49 kB |
| `@jarenjs/linq/flow` | [FLOW-PEN.md](FLOW-PEN.md) | 19,910 B | 20 kB |
| `@jarenjs/linq/app` | [APP-PEN.md](APP-PEN.md) | 51,006 B | 51 kB |
| `@jarenjs/linq/forms` | [FORMS-PEN.md](FORMS-PEN.md) | 40,873 B | 41 kB |
| `@jarenjs/linq/ai` | [AI-PEN.md](AI-PEN.md) | 16,904 B | 17 kB |
| `@jarenjs/linq/messages` | [MESSAGES-PEN.md](MESSAGES-PEN.md) | 18,363 B | 18 kB |
| `@jarenjs/linq/jtlt` | [JTLT-PEN.md](JTLT-PEN.md) | 16,725 B | 17 kB |
| `@jarenjs/linq/project` | [PROJECT-PEN.md](PROJECT-PEN.md) | 15,132 B | 15 kB |
| `@jarenjs/linq/charts` | [CHARTS-PEN.md](CHARTS-PEN.md) | 17,014 B | 17 kB |
| `@jarenjs/linq/db` | [DB-CLIENT.md](DB-CLIENT.md) | 633,786 B | 634 kB |
<!--/fact-->

Read these as prices, not as scores. `./db` is the largest by an order of
magnitude because it is the one subpath that opens a store — a SQL
planner, a unit of work and a validator ride with it by construction —
and the chain's figure is mostly the query engine under it rather than
the fluent surface over it. Each document's Cost section says what its
own bundle carries and what the probe proves it does not.

## 5. Every pen's vocabulary, in one place

Every mapping table in the suite, in reading order, as the rows their own
documents carry. This is the section for a question that spans pens —
which pens have a `named()`, what `.optional()` emits where, whether the
flow pen spells an effect the way the app pen does — asked without
knowing which document to open first.

**A row here is edited in the document it came from.** Nothing in this
section is written here: `npm run docs:derive` splices each document's
mapping table in, and `npm run docs:check` fails until this
file agrees with all ten again. That is what lets each pen's document be
a guide with a shape of its own while the normative rows stay collected
in one place — neither is a copy of the other, so neither can drift from
it.

**The grouped re-export row.** Two pens are the schema pen with a
vocabulary added — `./model` and `./forms` — and neither restates the
rows it inherits. Both use one row kind for them, defined here so
the two tables below can be read as the same shape: one row per FAMILY of
names, a link to the schema pen's row for that family, and a third column
carrying the one thing that IS different in this pen. That third column
is a status for the model pen, whose re-exported builders gain behaviour
the moment an `x-entity` method is called on one, and the class that
comes back for the forms pen, where nothing gains behaviour and the class
is the whole difference. A grouped row is never an abridgement: the
completeness gate holds every callable name named somewhere in the
section, families included.

Only the rows travel. A table's surrounding prose, its refusals, its
types and its examples stay in the document that owns them, and each
group's heading links there. So **an unqualified `§N` inside a group is
that group's document's section, not this one's** — a row that says
"§8" under the query pen's heading means QUERY-PEN.md §8; a row that
names its document (`QUERY-FORMAT §6`, `MODEL-FORMAT §10.6`) means what
it says.

<!--fact:pens.vocabulary-->
### The Jaren query pen — [QUERY-PEN.md §4](QUERY-PEN.md)

| C# / LINQ | Emission | Status | Typing (element `T`) |
|---|---|---|---|
| `Where` | FLWOR `$where` | native | `(e: Expr<T>) => Expr<boolean>` → `Seq<T>` |
| `Select` | `$return` constructor | native | `(e: Expr<T>) => Expr<R>` → `Seq<R>` |
| `SelectMany` | `$return` of a `$for` phrase over the projection — the projected value is iterated ONE level (an array member's elements, a constructed array's members; a scalar is itself), and the FLWOR `$return` concatenates per tuple. Emitted as `{ "$for": { "it": <projection> }, "$return": "$it" }` (the nested phrase rebinds `it` legally) | native | `(e: Expr<T>) => Expr<R[]>` → `Seq<R>` |
| `OrderBy` / `OrderByDescending` | `$orderby` key spec (`$dir`; `$empty`/`$collation` via `options`) | native | `(e: Expr<T>) => Expr<K>` → `Seq<T>` |
| `ThenBy` / `ThenByDescending` | appended `$orderby` spec; must directly follow `orderBy*` (`JL0005`) | native | as `OrderBy` |
| `GroupBy` | `$groupby`; downstream items are `{ key, items }` | native | `(e: Expr<T>) => Expr<K>` → `Seq<{key: K, items: T[]}>` |
| `Join` | nested `$for` + `$where` `$eq` — the engine rewrites this shape to a HASH JOIN (compile-time, QUERY-FORMAT §6), which is why it is fast **when both keys are plain member paths** (`o => o.pid`, `i => i.id`); a key with an operator in it (`o => o.name.lower()`, `o => o.p.add(0)`) is not a probe key and the join runs as a nested loop. Both sides MUST derive from the same source, or from two providers sharing one `scope` (§8 — two entity sets of one store are two roots of ONE multi-entity input, and the store answers the equijoin in one statement); anything else is `JL0005`: a query document reads one input. On the async surface the join exists only over a provider, pushed whole (§10). The inner side's declared parameters ride along (§7) | native | `(inner: Seq<U>, ok, ik, (o: Expr<T>, i: Expr<U>) => Expr<R>)` → `Seq<R>` |
| `GroupJoin` | the matching group bound as an ARRAY value — `$let: { g: [ <correlated inner phrase> ] }` — so the result selector can index it (`g.at(0)`), fan it (`g.all()`), place it in a member (`{ matches: g }`) and aggregate over its members (`(u, g) => ({ n: g.count() })` counts the matches, `g.exists()` is whether there are any); same-source rule and parameter merge as `Join` | emulated | `(inner: Seq<U>, ok, ik, (o: Expr<T>, g: ArrayExpr<U> & AggregatableExpr) => Expr<R>)` → `Seq<R>` |
| `Skip` / `Take` | `$subsequence` | native | `(n: number)` → `Seq<T>` |
| `Distinct` | `$distinct` (deep structural equality — the grouping relation) | native | `()` → `Seq<T>` |
| `Reverse` | `$reverse` | native | `()` → `Seq<T>` |
| `Count` / `Sum` / `Average` / `Min` / `Max` | §8.8 aggregates (`Average` → `$avg`) | native | `count(): number`; `sum(): number`; `average/min/max(): number` (throw `JL2001` on empty; `min`/`max` follow the operand family) |
| `Any()` | `$exists` | native | `(): boolean` |
| `Any(pred)` / `All(pred)` | `$some` / `$every` quantifier phrase | native | `(pred): boolean` (`all` vacuously true on empty) |
| `Aggregate(seed, fn)` | `$fold` — the accumulator clause; the result is a sequence of exactly ONE accumulated value (`.first()` reads it) | native | `(seed: A, (acc: Expr<A>, e: Expr<T>) => Expr<A>)` → `Seq<A>` |
| `Aggregate(fn)` (unseeded) | — JSON cannot spell "the implicit first element" as a lambda seed | unsupported (`JL0006`) | — |
| `First` / `FirstOrDefault` | `[ $subsequence [expr, 0, 1] ]` window | native | `(): T` (`JL2001` on empty) / `(d?): T \| D` |
| `Single` / `SingleOrDefault` | `[ $subsequence [expr, 0, 2] ]` window | native | `(): T` (`JL2001`/`JL2002`) / `(d?): T \| D` (`JL2002` on 2+) |
| `Last` / `LastOrDefault` | `[ $subsequence [$reverse expr, 0, 1] ]` | native | as `First` |
| `ElementAt` / `ElementAtOrDefault` | `[ $subsequence [expr, i, 1] ]` | native | `(i): T` (`JL2003` out of range) / `(i, d?)` |
| `Concat` | `$seq` (a constant array's elements join the stream) | native | `(other: Seq<T> \| T[])` → `Seq<T>` |
| `DefaultIfEmpty` | `$default` | native | `(fallback?: T)` → `Seq<T>` |
| `OfType<S>` | `$valid` filter with a JSON Schema literal | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Cast<S>` | `$assert` per item | native | `(schema)` → `Seq<S>`; needs `compileTypeTest` (`JL0003`) |
| `Zip` | — no positional co-iteration in the grammar | unsupported (`JL0006`) | — |
| expression methods | `eq ne lt le gt ge` → `$eq…$ge`; `and or not`; `add sub mul div idiv mod neg`; `startsWith endsWith contains matches upper lower length concat substring replace` → §8.7; `count sum avg min max` → §8.8 (aggregates as expressions, e.g. over a group); `exists isEmpty`; `at all get` | native | on `Expr<…>`, per the typed-surface order |
| date family (§8.13) | the whole family, one method per operator. Components `year month day hours minutes seconds offset week weekYear quarter weekday`; instants `epoch datetime`; predicates `isDate isTime isDatetime isDuration`; arithmetic `startOf(unit) endOf(unit) dateAdd(duration \| amount, unit?) dateSub(…) dateDiff(to, unit) dateFormat(pattern)`. `dateAdd`/`dateSub`/`dateFormat` carry the prefix because `add`, `sub` and `format` are taken or ambiguous on this surface — the same reason §8.14 spells `geoArea`. There is no `now()`: §8.13 has no clock, and a fluent surface does not get to add one | native | on `DateTimeExpr` (the `DateTime` brand) and on `UnknownExpr` |
| series family (§8.16) | `overlaps(other)` → `$overlaps`; `timeBucket(every, origin?, context?)` → `$time-bucket`; `resample(spec)`, `rolling(spec)` and `asof(right, spec?)` → the three sequence operators. A **spec is a literal** and is embedded verbatim — it is read once when the query compiles, so a spec built from the row is `JL0005`, and every rule about what it may *say* stays in the compiler (`JQ0003`). Note that a member literally named `at` is read with `get('at')`: `at(index)` is path navigation on this surface | native | on `ArrayExpr`/fanned paths for the three sequence operators, on `Expr<…>` for the two scalar ones |
| spatial family (§8.14) | `bbox geoArea geoLength centroid` → `$bbox $area $length $centroid`; `distance within bboxIntersects` → `$distance $within $bbox-intersects`; `geohash(precision?)` → `$geohash` (optional arity, like `substring`); `geoParse geoText geohashBounds geohashNeighbours` → the conversion family; `geoSimplify(tolerance)` → `$geo-simplify`. A plain JSON polygon embeds as a literal (`p.at.within(poly)`); `.params({ region })` makes it an external instead | native | on `Expr<…>`, per the typed-surface order |
| vector family (§8.15) | `similarity(other)` → `$similarity`. The other operand is an array of numbers: a captured one embeds as a literal, `.params({ query })` binds it at call time. There is no `knn` method — k-nearest is `orderByDescending(...).take(k)`, which is the composition the emitted document already is | native | on `Expr<…>`, per the typed-surface order |
| relation navigation — to-one hop (`p.author`, `p.author.email`) | over a provider with a relation table (§3, §8): `{ "$for": { "r1": "$.User[*]" }, "$where": { "$eq": ["$r1.<targetKey>", "$it.<via>"] }, "$return": "$r1.email" }` — the target's key against the row's foreign key (`kind: "oneToOne"`, the key on the declaring entity). Zero or one item: an object member's one value (absent when there is none), an operand elsewhere (empty compares false; `exists()`/`isEmpty()` say which), and under `$orderby` a key that may be empty (`$empty` applies). The binding is `r1`, `r2`, … per capture | native by desugaring — the document is the phrase; a store runs it as a named residual (`explain()`, MODEL-FORMAT §10.6) | `Expr<Post>['author']` is `ObjectExpr<User>` — emit's optional relation member, nothing new |
| relation navigation — to-many hop (`u.posts`, `u.posts.all()`) | `{ "$for": { "r1": "$.Post[*]" }, "$where": { "$eq": ["$r1.<via>", "$it.<targetKey>"] }, "$return": "$r1" }` — the target's foreign key against the row's key (`kind: "oneToMany"`, the key on the target). As a VALUE the phrase is packed, `[ <phrase> ]`, the array of related rows a member holds (`{ posts: u.posts }`; `u.posts.at(0)` indexes it); fanned, `u.posts.all()` is the bare phrase, a sequence: `.all().count()` → `{ "$count": <phrase> }`, `.all().exists()` → `{ "$exists": <phrase> }`, `.all().title` returns `"$r1.title"` per row (`[u.posts.all().title]` packs the titles). `count()`/`exists()` on the value range over the rows too, as a group-join's group's do | native by desugaring, as above | `ArrayExpr<Post>`; `all()` is `FannedExpr<Post>` |
| relation navigation — chained, and from every row binding | hops nest: `p.author.posts.all().count()` is `{ "$count": { "$for": { "r1": "$.User[*]" }, "$where": …, "$return": { "$for": { "r2": "$.Post[*]" }, "$where": { "$eq": ["$r2.authorId", "$r1.id"] }, "$return": "$r2" } } }` — the inner phrase correlates with the outer binding; a hop off a fanned to-many (`u.posts.all().author`) is a sequence, one target per row; a join's `it2` hops from the inner row; a group-join's fanned group (`g.all().author`) binds each row first (`{ "$for": { "r1": "$g[*]" }, "$return": <hop over $r1> }`); the group itself is an array, not a row | native by desugaring, as above | as the target's `Expr<…>` |
| relation navigation — many-to-many (`u.labels`) | — the join table is not a queryable root in this version, so no phrase exists to lower to; `load({ include: { labels: true } })` reads the memberships | unsupported (`JL0105`, naming the join table) | — |

### The Jaren schema pen — [SCHEMA-PEN.md §2](SCHEMA-PEN.md)

**Primitives, literals and enums**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `string()` | `{ type: 'string' }` | `string` | native |
| `number()` | `{ type: 'number' }` | `number` | native |
| `integer()` | `{ type: 'integer' }` | `number` (integer-ness is a documented widening) | native |
| number `.int()` | `{ type: 'integer' }` — the same node, retyped; `number().int()` and `integer()` are one document | `number` | native |
| `boolean()` | `{ type: 'boolean' }` | `boolean` | native |
| `nil()` | `{ type: 'null' }` | `null` | native |
| `literal(v)` | `{ const: v }` | the literal | native |
| `enumOf(values)` | `{ enum: values }` — an UNTYPED enum, any mix of JSON values | the literal union | native; an empty or non-array argument is `JL0101` |
| string/number `.enumOf(values)` | `enum` beside the `type` — a typed enum (what a store maps to a column); values of another JSON type are `JL0101` | the literal union; with `.coerce()` the `Input` widens by the one source primitive that can reach a member (`1 \| 2 \| 3 \| string`) | native |
| `datetime()`, `date()` | `{ type: 'string', format: 'date-time' \| 'date' }` | `DateTime` | native |
| `time()`, `duration()` | `{ type: 'string', format: 'time' \| 'duration' }` | `string` | native |
| `any()` | `{}` | `unknown` | native |
| `never()` | `false` | `never` | native; no annotation and no check while `false` IS the document (`JL0102`); `nullable()` lifts both |

**Objects**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `object(props)` | `{ type: 'object', properties, required, additionalProperties: false }` — `required` lists every member not `optional()`, in declaration order, and is omitted when empty | a closed object: members required unless `optional()`; no index signature; `object({})` is `Record<string, never>` | native |
| `.open()` | drops `additionalProperties: false` | `& { [k: string]: unknown }` | native |
| `.optional()` | the member leaves `required` | `?:` (on both sides; a `default()`ed member is present on `Infer`) | native |
| `.nullable()` | `type: [t, 'null']` on a typed node; `enum: [..., null]` on `enumOf`/`literal`; `anyOf: [node, { type: 'null' }]` on the rest | `\| null` | native / emulated |
| `record(values)` | `{ type: 'object', additionalProperties: values }` | `{ [k: string]: V }` | native |
| `.minProperties(n)`, `.maxProperties(n)` | `minProperties`, `maxProperties` | — | native |
| `.dependentRequired(map)` | `dependentRequired`, cloned | — | native; anything but a name → array-of-names map is `JL0101` |
| `.propertyNames(b)` | `propertyNames` | — | native |
| `.patternProperties(map)` | `patternProperties` | on a closed object the index signature carries the pattern values widened over the members (`[k: string]: V \| members`); on an open one `unknown` | native |
| `.extend(props)` | the reshaped `properties`/`required` — a later spelling of a name REPLACES the earlier one and moves to the end | the reshaped members | emulated |
| `.pick(keys)`, `.omit(keys)` | the selected `properties`, in the original order | `Pick<>` / `Omit<>` | emulated; a name the object does not carry is `JL0101` |
| `.partial()` | every member `optional()`, so `required` disappears | every member `?:` | emulated |
| `.required(keys?)` | the named members required again; every member when no keys are given | the members no longer `?:` | emulated |

**Arrays and tuples**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `array(items)` | `{ type: 'array', items }` | `T[]` | native |
| array `.min(n)`, `.max(n)`, `.length(n)` | `minItems`, `maxItems`, both | — | native |
| array `.unique()` | `uniqueItems: true` | — | native |
| array `.contains(b)` | `contains` | — | native; a normalizer keyword inside it is `JL0102` |
| `tuple(items)` | `{ type: 'array', prefixItems, minItems: items.length }` | `[A, B, ...unknown[]]` — every position required, the rest open (emit's reading of an omitted `items`) | native |
| tuple `.rest(b)` | `items: b`; `rest(never())` is `items: false` | `[A, B, ...R[]]`; `[A, B]` | native |

**Strings**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| string `.min(n)`, `.max(n)`, `.length(n)` | `minLength`, `maxLength`, both | — | native |
| string `.pattern(p)` | `pattern` (a string, or a flagless `RegExp` by its source) | — | native; flags are `JL0102` |
| string `.format(f)` | `format` | `DateTime` for `'date-time'`/`'date'`, `string` otherwise | native |
| string `.email()`, `.uuid()`, `.uri()` | `format: 'email' \| 'uuid' \| 'uri'` | `string` | native |

**Numbers**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| number `.min(n)`, `.max(n)` | `minimum`, `maximum` | — | native |
| number `.gt(n)`, `.lt(n)` | `exclusiveMinimum`, `exclusiveMaximum` | — | native |
| number `.multipleOf(n)` | `multipleOf` | — | native; zero or a negative is `JL0101` |

**Composition**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `union(options)` | `{ anyOf }` — an option may be a builder or a hand-written JSON Schema (`true`/`false` included), wrapped as `from(json)` | `A \| B` | native |
| `discriminated(key, options)` | `{ oneOf }` — every option an object declaring `key` as a `literal()`/`enumOf()` member | `A \| B` | native; a missing tag is `JL0102` |
| `intersection(parts)` | `{ allOf }` | `A & B` | native; a closed object part is `JL0102` (the parts would reject each other's members — `open()` them, or `extend()`) |
| `when(cond)`, `.then(b)`, `.else(b)` | `{ if, then, else }` | `unknown` (emit records a conditional, never types it) | native |

**References and `$defs`**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `named(name, b)` | `$defs[name]` at the document root, `{ $ref: '#/$defs/name' }` where reached — once, however many places reach it | `Infer<b>` | native; a name outside `[A-Za-z_][A-Za-z0-9_.-]*` is `JL0101`; two distinct builders under one name are `JL0103` |
| `ref(name)` | `{ $ref: '#/$defs/name' }` | `T` as asserted (`ref<T>`) | native; a name no `named()` in the document answers is `JL0103` |
| `lazy(() => Named)` | as `named` — the recursion spelling | `T` as annotated on the recursive constant | native; a thunk that is not a function is `JL0101`; an unnamed or non-builder target is `JL0103` |
| `from(json)` | the JSON, verbatim (cloned, so the document is its own tree) | `T` as asserted (`from<T>`) | native; anything but an object or a boolean is `JL0101` |

**Annotations and messages**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.describe(text)`, `.title(text)` | `description`, `title` | — | native |
| `.example(v)` | one more entry of `examples`, in call order | — | native |
| `.meta(annotations)` | the keys verbatim, in the order first set | — | native; a pen-owned keyword is `JL0104` |
| `.message(spec)` | `errorMessage: spec` (the validator's string, map or `$msgid` forms) | — | native |
| `.annotate(key, value)` | one annotation keyword — the primitive the four above are written in terms of, and the one a subclass overrides | `this` | native; `never()` overrides it to refuse until `nullable()` widens it (`JL0102`) |
| `.annotation(key)` | nothing: it READS the annotation a builder already carries, or `undefined` — what a subclass consults before it folds one into a keyword it owns | the value as stored | native |

**Validation extensions**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.check(fn)` | `$query`: the callback captured through the chain's proxy — `fn(value, { root, path })`, the value at `$`, the two externals the validator binds; two checks conjoin with `$and` | — (a dropped constraint) | native; another external is `JL0104` |
| `.check(query)` | `$query`: a query document embedded verbatim | — | native; a value that is not JSON is `JL0101` |
| `.coerce()` | `'x-coerce': true` on a scalar — the normalizer's per-field predicate | `Input` widens to the transport forms: string `\| number \| boolean`, number/integer `\| string`, boolean `\| string`, null `\| string` | native; on a non-scalar or a nullable, `JL0102` |
| `.trim()` | `'x-trim': true` on a string | — | native; off a string, `JL0102` |

**The document, and the builder itself**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `document(root, { draft })` | the document, with `$schema` first for `'2020-12'`; without a draft, the root's document unchanged | — | native; another draft, or a draft on a boolean schema, is `JL0102` |
| `.schema` | the assembled document — a deep-frozen value, computed once and memoized | `JsonSchema \| boolean` | native |
| `.toJSON()` | the same document, so `JSON.stringify(builder)` is the document | `JsonSchema \| boolean` | native |
| `.state` | the frozen builder state (kind, children, keywords, annotations) — what a subclass reads, never a document | the state object | native |
| `.with(patch)` | nothing: a NEW builder of the same class with part of the state replaced. Every method above is written in terms of it, and a subclass keeps its own class through all of them | `this` | native |
| `.keyword(key, value)` | one constraint keyword, in the order first set | `this` | native |
| `schemaOf(value)` | nothing: the document of a builder, or the value as given — the one call a consumer needs to accept "a schema, by hand or by pen" | `unknown` | native |
| `requireJson(value, what)` | nothing: the JSON boundary every value entering a document crosses, exported so a pen built over this one uses the same door | `T` | native; a non-JSON value is `JL0101` |
| `createFactories(classes)` | nothing: the named factories above, built for one SET of builder classes. `@jarenjs/linq/model` and `@jarenjs/linq/forms` call it with their subclasses, which is why the wiring exists exactly once and no subpath patches another's prototype | the factory record | native |

**Content, containment and resource identity**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.id(uri)` | `$id` | `this` | native; string required |
| array `.minContains(n)`, `.maxContains(n)` | `minContains`, `maxContains` | `this` | native; non-negative integers |
| string `.contentEncoding(text)` | `contentEncoding` | `this` | native |
| string `.contentMediaType(text)` | `contentMediaType` | `this` | native |
| string `.contentSchema(builder)` | `contentSchema` | `this` | native; named definitions hoist |
| string `.formatMinimum(text)`, `.formatMaximum(text)` | `formatMinimum`, `formatMaximum` | `this` | native |
| string `.formatExclusiveMinimum(text)`, `.formatExclusiveMaximum(text)` | `formatExclusiveMinimum`, `formatExclusiveMaximum` | `this` | native |

**Applicators, references and legacy keywords**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.not(builder)` | `not` | `this` | native |
| `.unevaluatedProperties(builder)`, `.unevaluatedItems(builder)` | `unevaluatedProperties`, `unevaluatedItems` | `this` | native |
| `.dependentSchemas(map)`, `.dependencies(map)` | `dependentSchemas`, `dependencies` | `this` | native; legacy dependencies also accept arrays of distinct member names |
| `.anchor(name)`, `.vocabulary(map)` | `$anchor`, `$vocabulary` | `this` | native |
| `.dynamicRef(uri)`, `.dynamicAnchor(name)` | `$dynamicRef`, `$dynamicAnchor` | `this` | native; no inferred reference identity |
| `.recursiveRef(uri)`, `.recursiveAnchor(boolean)` | `$recursiveRef`, `$recursiveAnchor` | `this` | native |
| `.definitions(map)`, `.additionalItems(builder)` | `definitions`, `additionalItems` | `this` | native; legacy vocabulary |
| `.dollarData(pointer)`, `.data(map)` | `$data`, `data` | `this` | native |
| `.legacyNullable(boolean)` | `nullable` | `unknown` | native; distinct from `.nullable()` |

### The Jaren model pen — [MODEL-PEN.md §2](MODEL-PEN.md)

**The `x-entity` vocabulary**

| Method | Emits (an `x-entity` member) | `InferMeta` reading | Status |
|---|---|---|---|
| `.key()` | `key: true` — (part of) the primary key; several members make a composite one (MODEL-FORMAT §9.5) | marks the member `key`: `EntityKey` is its primitive, or the composite object over all of them | native; on a kind that can hold no column, `JL0102` |
| `.identity('uuid')` on a string, `.identity('auto')` on an integer | `key: true` **and** `default: 'uuid' \| 'auto'` — a store-allocated single key (§9.5) | marks it `key` **and** `generated`: optional on `input`, required on `doc` | native; off its kind, or beside a second `key()`, `JL0102` |
| `.unique()` | `unique: true` — a unique index over the member's column. On an ARRAY builder the schema pen already owns the name, and the base wins: it is `uniqueItems` there, unchanged ([SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples)) | — | native; on a kind that can hold no column, `JL0102` |
| `.index()` | `index: true` — a non-unique index over the member's column | — | native; on a kind that can hold no column, `JL0102` |
| `.version()` | `version: true` — the optimistic-concurrency token (§11.5), engine-owned: one plain integer column per entity | — | native; off an integer, `JL0102` |
| `.column('integer')` | `column: 'integer'` — an epoch-milliseconds column beside the RFC 3339 string, on a `datetime()`/`date()` member only (§9.3) | — | native; off a date-formatted string, `JL0102` |
| `.column('json')` | `column: 'json'` — the scalar stays in the JSONB document, which is the opt-out that preserves present-`null` (§9.3) | — | native |
| `.now()` | `default: 'now'` — an RFC 3339 stamp on insert, when the member is absent | marks it `generated`: optional on `input` | native |
| `.updated()` | `default: 'updated'` — a stamp on insert AND on every update | marks it `generated` | native |
| `.fill(value)` | `default: { value }` — a literal, filled when absent; the value crosses the JSON boundary (`requireJson`) | marks it `generated` | native; a value that is not JSON is `JL0101` |
| `.compute(fn)`, `.compute(query)` | `default: { query }` — captured over the document being written (`$`), or a query document verbatim | marks it `generated` | native; a captured rule that binds ANY external is `JL0104` |
| `.renamedFrom(name)` | `x-rename: name` on the ENTITY (or collection) declaration — a planning hint the migration planner reads, never part of the shape (MIGRATION-FORMAT §3) | — | native on the declaration's own builder; on a member, `JL0102` (the document has no place for one) |
| `.meta(annotations)` | as the schema pen ([SCHEMA-PEN.md](SCHEMA-PEN.md#28-annotations-and-messages)), minus one key | — | refused (`JL0104`) for `x-entity`: the pen owns that keyword |
| `.entity(patch)` | the patch, merged into `x-entity` — the primitive every row above is written in terms of, and the way to spell a member of the vocabulary that has no method of its own | — (it sets no flag; the named methods do — §5.2) | native; a member outside the closed vocabulary, `JL0102` |

**The relation members**

| Method | Emits | `InferMeta` reading | Status |
|---|---|---|---|
| `rel.hasMany(to, { via, onDelete })` | `relation: { to, many: true, via, onDelete }` — one-to-many; `via` names the foreign key on the TARGET entity | `doc`: `to[]`, optional; dropped from `input`; `relations[name] = { entity: to, doc, many: true }` | native |
| `rel.hasOne(to, { via, onDelete })` | `relation: { to, via, onDelete }` — one-to-one, and the many-to-one side; `via` names the foreign key on the DECLARING entity | `doc`: `to`, optional; dropped from `input`; `many: false` | native |
| `rel.belongsToMany(to, { through? })` | `relation: { to, many: true, through? }` — many-to-many through a join table | `doc`: `to[]`, optional; `input`: `Array<key \| doc>`, optional; `many: true` | native |

**Collections and their indexes**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `collection(schema, { key?, identity?, indexes?, renamedFrom? })` | `{ schema, key?, identity?, indexes?, 'x-rename'? }` — `key` is an RFC 6901 pointer, a captured member path (`(d) => d.id` → `/id`) or `null` (the store allocates, `identity` says how); the other options ride verbatim | `CollectionSpec<Infer<B>>`, carrying the document shape its paths are checked against | native; an option outside the four, a key that is neither pointer nor lambda nor `null`, an `indexes` that is not an array of `index()` entries, all `JL0101` |
| `index(path, options?)` | `{ name, path, unique?, derive?, precision?, dims?, physical? }` — `path` is a captured lambda (`(p) => p.cell` → `$.cell`), a non-empty array of them (a composite), or a JSONPath string; `name` defaults to `by_<segments>`; the rest ride verbatim for the store's model walk to judge (§2.1) | `IndexPath<D>` over the collection's shape: a member the shape lacks does not compile | native; an option outside the six is `JL0101`; a lambda that answers an operator result or a surface method is `JL0102` |

| `expressionIndex(expression, options?)` | `{ name, expression, unique? }` — an index over a COMPUTED value: a `{ call, args }` node whose arguments are member lambdas, JSONPath strings, JSON scalars or further calls; `name` defaults to `by_<call>_<members>` | the expression's member lambdas are checked against the collection's shape | native; a node outside the vocabulary, an option outside the two, and anything that looks like SQL text are all `JL0101` |

**The model document**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineModel({ entities?, collections? })` | `{ $model: '0.1', collections?, entities? }`, deep-frozen; each entity is `{ schema, 'x-rename'? }` | `ModelDocument<E, C>`, whose phantoms `InferMeta<>` and the migration pen read | native; neither member given, a member outside the two, a name that is not an identifier, or a declaration of the wrong kind, all `JL0101`; an undeclared relation target or a `collection()` under `entities`, `JL0102` |
| `document(root, { draft? })` | as [SCHEMA-PEN.md](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) — a standalone JSON Schema, with `x-entity` blocks riding as annotations. It writes a schema, never a `$model` | — | native |
| `schemaOf(value)` | as [SCHEMA-PEN.md](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) — the document of a builder, or the value as given | `unknown` | native |
| `withEntity(Base)` | nothing: a NEW class, `Base` plus §2.1's vocabulary. The eight exported classes are made with it at module scope, and a consumer subclassing one takes the same route | `B` — the base class's own type | native |

**The schema pen's vocabulary, re-exported**

| Method | Row | Status |
|---|---|---|
| `string()`, `number()`, `integer()`, `boolean()`, `nil()`, `literal(v)`, `enumOf(values)`, `datetime()`, `date()`, `time()`, `duration()`, `any()`, `never()` | [SCHEMA-PEN.md §2.1](SCHEMA-PEN.md#21-primitives-literals-and-enums) | native, plus `x-entity` when a §2.1 method is called on it |
| `object(props)`, `record(values)` | [SCHEMA-PEN.md §2.2](SCHEMA-PEN.md#22-objects) | native; an entity's own builder is an `object()` (or an `intersection()` of them), and it is where `.renamedFrom()` lands |
| `array(items)`, `tuple(items)` | [SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples) | native; an array or tuple member is JSONB, so it takes no column of its own (§6) |
| `union(options)`, `discriminated(key, options)`, `intersection(parts)`, `when(cond)` | [SCHEMA-PEN.md §2.6](SCHEMA-PEN.md#26-composition) | native; a union of several scalar types stays in the document (MODEL-FORMAT §9.3) |
| `named(name, b)`, `ref(name)`, `lazy(thunk)`, `from(json)` | [SCHEMA-PEN.md §2.7](SCHEMA-PEN.md#27-references-and-defs) | native; `x-entity` is read through an entity's `allOf`, `$defs` and `definitions` blocks and nowhere deeper (MODEL-FORMAT §9.2) |

### The Jaren JSLT pen — [JSLT-PEN.md §2](JSLT-PEN.md)

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `stylesheet(rules, { unmatched?, modes? })` | `{ $jslt: '0.1', unmatched?, modes?, rules }` — the envelope (§2.1), in that member order; the bare-array form is the rules array itself | `Stylesheet<In, Out>`: the FIRST rule's phantoms, or the author's (`stylesheet<In, Out>(…)`) | native; a non-array, another option, a rule that is not an object, a rule without `body`, a rule that is not JSON `JL0101` |
| `unmatched` | `unmatched: 'share' \| 'fresh' \| 'error'` (§5) | `Disposition` | native; another value `JL0101` |
| `modes` | `modes: { name: { unmatched } }` (§2.1) | — | native; another member, a mode that is not `{ unmatched }`, a map whose prototype a `__proto__:` literal replaced `JL0101` |
| `rule(match, body, { mode?, priority? })` | `{ mode?, match?, priority?, body }` — the rule object (§2.2), in that member order | `Rule<In, Out>` | native; a non-object options, another option `JL0101` |
| `match` as a JSONPath string | `match: '$..price'` (§3.1) | the honest top | native |
| `match` as `{ path?, schema? }` | the object; `schema` a schema-pen builder's document, or a schema verbatim | a builder types the body's value (`Infer<>`) | native; `{}` is `JL0102`; another member, a non-string `path`, a `schema` that is not JSON `JL0101` |
| `match` `null` or absent | no `match` member — the unconditional rule (default priority −1, §4) | the honest top | native |
| `mode` | `mode: 'toc'` (§7) | `string` | native; a non-string `JL0101` |
| `priority` | `priority: 2` (§4) | `number` | native; a non-finite number, or `-0`, `JL0101` |
| `body(fn, { externals? })` | the captured query document — `fn(v, x)` with `v` at `$`, `x.root`/`x.path` (§8.2) and the declared parameters as `$name` externals (§8.1); a returned literal is a constructor, a string starting `$` is escaped `$$` | `BodyDocument<In, Out>`: `In` from the annotated `v` (`(v: Expr<Book>) => …`), `Out` the unwrapped return; a declared parameter is `UnknownExpr` until `x` is annotated (`x: Externals<{ rate: number }>`) | native; a non-callback, a non-object options, another option, a non-array or non-identifier external `JL0101`; an undeclared external `JL0104`; `root`/`path` declared `JL0104` |
| a callback where a body is taken | `body(fn)` with no parameters | as above; the match's builder types `v` | native |
| a query document where a body is taken | the document, verbatim (a `body()` result, or by hand) | a `body()` document carries its phantoms; a hand-written one is `unknown` | native; not JSON `JL0101` |
| `apply(selector)` | `{ $apply: selector }` — the rule's own mode (§6.2); the selector an expression (`v.chapters.all()`), a path string verbatim (`'$.chapters[*]'`), or data (`[1, 2]` embeds as `$const`) | `UnknownExpr` — a dispatch to other rules | native; no selector `JL0101`; outside `body()` `JL0102` |
| `apply(selector, mode)` | `{ $apply: [selector, mode] }` — the argument-list form (§6.2) | `UnknownExpr` | native; a non-string mode `JL0101` |
| `[apply(…)]` as a member value | `[{ $apply: … }]` — the `[]` idiom (§6.3) | `unknown[]` | native |
| `apply(…)` as a bare member value | — | — | refused (`JL0102`): the engine fails at run time on the second child (`JQ2001`) |
| `op(name, operands)` | `{ [name]: operands }` — a registered operator (§13), spelled without judging it; one operand or a list | `UnknownExpr` | native; the engine's `JQ0002` decides; a name without `$` `JL0101`; outside any capture `JL0005` |

### The Jaren migration pen — [MIGRATION-PEN.md §2](MIGRATION-PEN.md)

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

### The Jaren contract pen — [CONTRACT-PEN.md §2](CONTRACT-PEN.md)

**The document**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineContract({ id?, version?, compat? }, operations)` | `{ $contract: '0.1', id?, version?, compat?, $defs?, operations }` in §12.1's root order, deep-frozen | `Contract<Ops>`; `ContractOf<typeof c>` is the operation map §5 reads | native; a head member the pen does not know, an `id` outside `[A-Za-z_][A-Za-z0-9_-]*`, a non-string `version`, a `compat` that is not an array of strings, or no operation at all, `JL0101` |
| `.document` | the deep-frozen `$contract` document — the same object every time | `ContractDocument` | native |
| `toJSON()` | the same document, so `JSON.stringify(contract)` is the contract | `ContractDocument` | native |

**The three operation kinds**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `read({ input?, output, errors?, policy?, http?, doc? })` | `{ kind: 'read', … }` in §12.1's operation order, declared members only | `OperationDeclaration<'read', S>`; `kind` is the literal | native; a member the spec does not take, a missing `output`, or a non-string `doc`, `JL0101` |
| `command({ … })` | `{ kind: 'command', … }` | `OperationDeclaration<'command', S>` | native; the same three |
| `subscribe({ … })` | `{ kind: 'subscribe', … }` — `output` is the SNAPSHOT schema (§17) | `OperationDeclaration<'subscribe', S>`; never opaque | native; the same three |

**The schema positions**

| Written as | Emits | Type reading | Status |
|---|---|---|---|
| a schema-pen builder | the builder's schema, its `named()` definitions hoisted to the contract's `$defs` and referenced `#/$defs/<name>` | `Infer<>` of the builder; `Input<>` for the accepted shape | native |
| a JSON Schema object, or `true` / `false` | copied verbatim, deep-cloned | `unknown` — a literal is never inferred (the binder's §1.1 rule 2) | native; a value that is neither an object nor a boolean, or one that is not JSON, `JL0101` |

**The errors map**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `errors: { <code>: … }` | `{ <code>: { status?, schema? } }`, in declaration order | the declared codes are the operation's `errors` union — `'conflict' \| 'not-found'` | native; a map that is not a plain object, a code outside `^[a-z][a-z0-9-]*$`, or an entry that is not a plain object, `JL0101` |
| `error({ status?, schema? })` | `{ status?, schema? }` in that order — `error()` with nothing emits `{}` | `ErrorDeclaration<E>` | native; another member, or a status outside 100–599, `JL0101` |

**The policy**

| Member | Takes | Emits |
|---|---|---|
| `task` | `switch`, `exhaust`, `concat`, `parallel` | the token |
| `idempotency` | `none`, `optional`, `required` | the token |
| `revision` | `"input:<json-pointer>"` | the string, verbatim |
| `cache` | `none`, `revision` | the token |
| `limits` | `{ maxBodyBytes }`, a positive integer | `{ maxBodyBytes }` |
| `errors` | `{ details }` — `none`, `paths`, `full` | `{ details }` |
| `retry` | `{ max, on }` — an integer ≥ 0 and an array of code strings | `{ max, on }`, the array copied |
| `stream` | `{ resume?, heartbeatMs?, maxPatchBytes? }` — `snapshot`/`replay`, an integer ≥ 1000, a positive integer | the declared members only |
| `audience` | `public`, `server` | the token |

**The HTTP binding**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `http({ method, path, in?, body?, status?, media? })` | the binding in §12.1's http order, declared members only | `HttpBinding<H>`; a non-JSON `media` makes the operation `opaque: true` | native; a member the binding does not take, a method outside the seven tokens, a non-string `body`, a status outside 200–299 or a non-string `media`, `JL0101`; a reserved path-template form or a member mapped to `path` the template does not declare, `JL0102` |

| Member | Takes | Note |
|---|---|---|
| `method` | one uppercase token of `GET HEAD POST PUT PATCH DELETE OPTIONS` | lowercase is refused; the format's table is uppercase |
| `path` | a path template (§4.2) | `{name}` and `:name` both accepted, and **written as declared** |
| `in` | input member → `path` \| `query` \| `header` \| `body` | only the members the §4.1 default does not already place |
| `body` | the input member whose value IS the request body | a non-empty string |
| `status` | 200–299 | the success status; `200` is the default and is never written |
| `media` | a media type | anything but `application/json` or a `+json` suffix makes the operation opaque (§4.5) |

**The three consumers**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `typedClient(client, contract)` | — (identity) | `TypedClient<C>`: `invoke` over the invokable operations, `subscribe` over the subscribe ones, `url` over all of them | native |
| `typedHttpClient(client, contract)` | — (identity) | `TypedHttpClient<C>`: `TypedClient<C>` plus `bytes` over `OpaqueOf<C>` — the opaque operations, whose success is a `ByteResponse` (a live stream) rather than the output type; for an `openHttpClient` client only, a local or port client has no `bytes` | native |
| `typedHandlers(contract, handlers)` | — (identity) | `TypedHandlerTable<C, Host = null, Carrier = 'http'>`: one handler per invokable operation, `(input, ctx) => output \| Failure`; `ctx` is `HandlerContext<Host, Carrier>` — the HTTP context by default, `Host` the host lifecycle's `ctx.host`, a carrier union a discriminated union to narrow on `ctx.carrier` (CONTRACT-FORMAT §7.7) | native; a missing or misspelled operation does not compile, and an HTTP-only member on a port/local context does not either |
| `typedTools(tools, contract)` | — (identity) | `TypedTool<C>[]`: `name` is the id with `.` → `_`, `execute` takes the operation's ACCEPTED input | native |

**What the pen does not judge**

| The document the pen writes | The compiler's refusal |
|---|---|
| a member the document's own closed vocabulary does not carry | `JC0013` (§4.4) |
| an operation id outside `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$` | `JC0003` |
| a `read` that declares `idempotency` | `JC0014` |
| a `GET` carrying a body-located member | `JC0016` |
| an opaque operation with a body-located member | `JC0017` |
| a `subscribe` bound to anything but `GET` | `JC0019` |
| a path variable that is not an input member | `JC0009` |
| two operations sharing a route shape | `JC0010` |

### The Jaren flow pen — [FLOW-PEN.md §2](FLOW-PEN.md)

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineFsm({ initial, states, transitions, context? })` | `{ $fsm: '0.1', initial, states, transitions }` | `Fsm<States, Events, Context>`; `StatesOf<>`, `EventsOf<>`, `ContextOf<>` read it | native; a member the pen does not know, a missing `initial` (pass `null`), a non-array `states`/`transitions`, an entry that is not a declaration, a transition that never named its target, a `context` that is not a builder `JL0101`; an undeclared state id `JL0102` |
| `state(id, { entry?, exit?, final? })` | `{ id, entry?, exit?, final? }`; a bare string in `states` stays §2's shorthand | `StateDeclaration<Id>` — `Id` is a literal | native; an empty id, another member, a non-boolean `final`, a non-array or non-`effect()` entry/exit `JL0101` |
| `on(from, event?, { payload? })` | one entry of `transitions`, `{ from, event?, guard?, to, effects? }` in §2's order; a wildcard writes no `event` | `Transition<From, To, Event, Payload>` — a wildcard names no event, so it adds nothing to `EventsOf<>` | native; an empty `from`, a non-string event, another option, a `payload` that is not a builder `JL0101`; an undeclared `from`/`to` `JL0102` |
| `.when(fn)` / `.when(document)` | the transition's `guard` (§3) | the scope is `Scope<unknown, Payload>`; annotate for `context` | native; a plain STRING `JL0102` (§3's vacuous-guard rule); a non-JSON document `JL0101`; any external `JL0104` |
| `.to(state)` | the transition's `to` | `Transition<From, To, …>` — `To` is a literal | native; an empty id `JL0101`; an undeclared id `JL0102` at `defineFsm()` |
| `.effects([...])`, `state(…, { entry, exit })` | the effects lists §4 fires in exit → transition → entry order | `EffectDeclaration[]` | native; a non-array, or an entry that is not `effect()`, `JL0101` |
| `effect(run, with?)` | `{ run, with? }` | `EffectDeclaration<Run>`; the scope is the honest top until annotated | native; an empty `run`, a non-JSON `with` `JL0101`; any external `JL0104` |
| `defineDag({ nodes, edges })` | `{ $dag: '0.1', nodes, edges }` | `Dag<Ids, Tasks>`; `NodesOf<>`, `TasksOf<>` read it | native; a member the pen does not know, no node, a `nodes` map whose prototype a `__proto__:` literal replaced, a value that is not a node or edge declaration `JL0101`; an edge on an undeclared id `JL0102` |
| `input()` / `output()` | `{ kind: 'input' }` / `{ kind: 'output' }` | `NodeDeclaration<'input'>` / `<'output'>` | native |
| `constant(value)` | `{ kind: 'const', value }` | `NodeDeclaration<'const'>` | native; `undefined`, or a value that is not JSON, `JL0101` |
| `query(fn \| document)` | `{ kind: 'query', query }` | `NodeDeclaration<'query'>` | native; nothing passed, or a document that is not JSON, `JL0101`; any external `JL0104` |
| `jslt(stylesheet)` | `{ kind: 'jslt', stylesheet }` — the JSLT pen's document ([JSLT-PEN.md](JSLT-PEN.md)), or one by hand | `NodeDeclaration<'jslt'>` | native; nothing passed, or a value that is not JSON, `JL0101` |
| `task(run, with?)` | `{ kind: 'task', run, with? }` | `NodeDeclaration<'task', Run>` — `Run` is a literal | native; an empty `run` `JL0101`; any external in `with` `JL0104` |
| `.checkpoint()` | `checkpoint: true`, written last (§7.6) | a new declaration; the one it came from is unchanged | native |
| `edge(from, to, { port?, select? })` | `{ from, to, port?, select? }` | `EdgeDeclaration<From, To>` | native; an empty end, an empty `port`, another member `JL0101`; any external in `select` `JL0104` |
| `typedTasks(graph, tasks)` | — (identity) | the registry `compileDag` resolves must carry one handler per declared task name | native; a missing or misspelled name does not compile |

### The Jaren app pen — [APP-PEN.md §2](APP-PEN.md)

**The document**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineApp({ state, initial?, schema?, view, actions?, subs? })` | `{ document: { $app: '0.1', state?, view, actions?, subs? }, stateSchema }` — only the members the author declared, deep-frozen | `AppResult<State, Actions>`; `StateOf<>` and `ActionsOf<>` read it back | native; a member the pen does not know, a missing `view`, a `schema` beside a builder state `JL0101`; an underivable initial state, or a view binding an undeclared action, `JL0102` |
| `state` | the initial value, from the builder's `default()`s (§1.2); the builder itself becomes `stateSchema` | `Infer<B>` | native |
| `initial` | the initial value verbatim, in place of the derivation | `Infer<B>` | native; a non-JSON value `JL0101` |
| `schema` | nothing — it TYPES a `state` given as a plain JSON value, and becomes `stateSchema` | `Infer<B>` | native; beside a builder state, `JL0101` (a builder state IS its schema) |
| `view` | the JSLT stylesheet verbatim — the pen's `stylesheet([rule(…)])` envelope ([JSLT-PEN.md](JSLT-PEN.md)) or APP-FORMAT §2's bare rule array | `unknown`: a view is a document the grammar judges | native |
| `actions` | the `actions` map, one captured action document per name | `keyof A & string` — the literal names, which is what `bind<>()` is checked against | native; a value that is not an `action()` `JL0101` |
| `subs` | the `subs` array, one `sub()` entry per element | `readonly SubDeclaration[]` | native; a value that is not a `sub()` `JL0101` |

**The transition**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `action(fn, { payload?, event? })` | one action document, captured over `$`, `$event`, `$payload` | `ActionDeclaration<Payload>`; `payload` and `event` are TYPES — the format carries no schema for either, and nothing is emitted for them | native; a non-builder `payload` `JL0101`; an excluded `event` field `JL0102`; a name §3.1 does not bind `JL0104` |
| `transition({ state?, patch?, effects? })` | the transition object of APP-FORMAT §3.2, in the order the runtime applies it | `Transition` | native; another member `JL0101` |
| `effect(run, with?)` | `{ run, with? }` (§5.1); `with` is a value in the ACTION's scope, not a callback | `EffectDeclaration<Run>` — `Run` is a literal | native; an empty `run` `JL0101` |

**The seven patch operations**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `add(path, value)` | `{ op: 'add', path, value }` — **sets a member, and REPLACES an array when the path names one** | `PatchOp` | native |
| `append(path, value)` | `{ op: 'add', path: '<path>/-', value }` — RFC 6902's array APPEND, the same op at the array's `-` position | `PatchOp` | native |
| `replace(path, value)` | `{ op: 'replace', path, value }` — the op a transition writes most, and the one an array ELEMENT needs | `PatchOp` | native |
| `remove(path)` | `{ op: 'remove', path }` | `PatchOp` | native |
| `move(from, path)` | `{ op: 'move', from, path }` — both lowered as pointers | `PatchOp` | native |
| `copy(from, path)` | `{ op: 'copy', from, path }` | `PatchOp` | native |
| `test(path, value)` | `{ op: 'test', path, value }` — a failing test aborts the WHOLE transition (`JA2004`), which is the format's own way to write a precondition | `PatchOp` | native |
| a path lambda `(st, x) => …` | the JSON Pointer the state shape describes: `st.todos` → `/todos`, `st.todos.at(2).done` → `/todos/2/done`, `st.get('a/b')` → `/a~1b` (RFC 6901 escaping) | `PatchPath<State, Payload>` — annotate to type it | native |
| a path lambda with a COMPUTED index | the pointer as a string EXPRESSION, `{ "$concat": ["/todos/", <index>, "/done"] }` — APP-FORMAT §3.2's "op members like `value` and `path` are themselves query expressions" | the same | native; anything that is not a chain of member reads and subscripts `JL0102` |
| a path as a string | the pointer verbatim, `+ '/-'` under `append()` | `string` | native; a string that does not start with `/` `JL0102` |

**The two doors in**

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `bind(name, { payload?, event?, preventDefault?, stopPropagation? })` | APP-FORMAT §4's object binding — `{ action, with?, event?, preventDefault?, stopPropagation? }`, in the format's member order | `Binding<Names>` — annotate the call (`bind<Action>('todo/add')`) and an undeclared name stops compiling | native; an empty name, an unknown member or a non-boolean control `JL0101`; a field §3.1 excludes `JL0102` |
| `sub(run, { with?, when?, withQuery?, key?, for? })` | one APP-FORMAT §5.3 entry, in the format's member order | `SubDeclaration<Run>` | native; an empty `run`, an unknown member or a callback under `with` `JL0101`; a combination §5.3 calls `JA0008` `JL0102`; `$item` outside a `for` `JL0104` |

### The Jaren forms pen — [FORMS-PEN.md §2](FORMS-PEN.md)

| Kind | Count | What the row does |
|---|---:|---|
| **re-exported unchanged** | 27 | links `SCHEMA-PEN.md` §2's row and states nothing of its own — the emission, the `Infer`/`Input` reading and every refusal are the schema pen's, and the only difference is the CLASS that comes back |
| **re-exported and extended** | 1 | the schema pen's behaviour plus what this pen adds, stated here |
| **forms-only** | 3 | this pen's own, stated here in full |

**Re-exported unchanged — 27 names**

| Names | Documented at | The class that comes back |
|---|---|---|
| `string()`, `number()`, `integer()`, `boolean()`, `nil()`, `literal(v)`, `enumOf(values)`, `datetime()`, `date()`, `time()`, `duration()`, `any()`, `never()` | [SCHEMA-PEN.md §2.1](SCHEMA-PEN.md#21-primitives-literals-and-enums) | `FormStringBuilder`, `FormNumberBuilder`, `FormBuilder`, `FormNeverBuilder` |
| `object(props)`, `record(values)` | [SCHEMA-PEN.md §2.2](SCHEMA-PEN.md#22-objects) | `FormObjectBuilder`, `FormBuilder` |
| `array(items)`, `tuple(items)` | [SCHEMA-PEN.md §2.3](SCHEMA-PEN.md#23-arrays-and-tuples) | `FormArrayBuilder`, `FormTupleBuilder` |
| `union(options)`, `discriminated(key, options)`, `intersection(parts)`, `when(cond)` | [SCHEMA-PEN.md §2.6](SCHEMA-PEN.md#26-composition) | `FormBuilder`, `FormWhenBuilder` |
| `named(name, b)`, `ref(name)`, `lazy(thunk)`, `from(json)` | [SCHEMA-PEN.md §2.7](SCHEMA-PEN.md#27-references-and-defs) | `FormBuilder` (a `named()` builder is one of its own) |
| `document(root, { draft })`, `schemaOf(value)` | [SCHEMA-PEN.md §2.10](SCHEMA-PEN.md#210-the-document-and-the-builder-itself) | — (both answer a document, not a builder) |

**Re-exported and extended — `meta()`**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.meta(annotations)` | the keys verbatim, in the order first set — exactly [SCHEMA-PEN.md §2.8](SCHEMA-PEN.md#28-annotations-and-messages)'s behaviour | — | native; a schema-pen-owned keyword is `JL0104` there, and `'x-form'` is `JL0104` HERE: the forms pen owns that keyword, and the fix is to spell it through `form()` |

**Forms-only — three names**

| Method | Emits | `Infer` / `Input` | Status |
|---|---|---|---|
| `.form({ visible?, enabled?, assert?, computed?, message? })` | one `x-form` annotation, its members in the README's own order whatever order the author wrote; a second call MERGES into the same annotation rather than replacing it | `this` — the builder's phantoms are untouched, because a rule is an annotation | native; a member `x-form` does not define, or a `message` that is neither a string nor a MessageSpec, `JL0101`; `preview` `JL0102`; a name the context does not bind `JL0104` |
| `withForm(Base)` | nothing: a NEW class, `Base` plus `form()` and the overriding `meta()`. The route by which a third pen — or a project's own vocabulary — carries `x-form` (§3.5) | `B` (the base class's own type) | native; a non-constructor argument is JavaScript's own `TypeError` from the `extends` clause, not a `LinqBuildError` |
| `assertOnSubmit(root)` | the root document with one `allOf` branch `{ $query, errorMessage }` per `x-form.assert` in it; a document with no assert answers ITSELF, because a needless `allOf` would be a second spelling of the same schema | `JsonSchema` | native; a value that is neither a builder nor an object schema is `JL0101` |

| Member | Kind | Emits | The reader's question |
|---|---|---|---|
| `visible` | EBV query | `x-form.visible` | should the field be shown? A broken rule fails **open** — it must never hide data |
| `enabled` | EBV query | `x-form.enabled` | should the field accept input? Fails **open**, same reason |
| `assert` | EBV query | `x-form.assert` | a cross-field preemptive assertion. Fails **closed**: an assertion that cannot be computed has not been satisfied |
| `computed` | query | `x-form.computed` | the field's derived value, mapped to plain JSON. A failure leaves the value absent |
| `message` | string or MessageSpec | `x-form.message`, verbatim | what an `assert` failure renders — an inline template, or `{ $msgid, message?, params? }` for the catalog |

### The AI program pen — [AI-PEN.md §2](AI-PEN.md)

| Factory / method | Emits | Type | Status |
|---|---|---|---|
| `program(slots?)` | empty `steps` | declared input names | native |
| `chunk(from, as, options?)`, `.chunk(...)` | chunk; strategy and size | result family | native |
| `grep(from, as, options)`, `.grep(...)` | grep; pattern, flags, limit | match-list slot | native |
| `select(from, as, query)`, `.select(...)` | select; query JSON | result slot | native |
| `stat(from, as)`, `.stat(...)` | stat | result slot | native |
| `peek(from, as)`, `.peek(...)` | peek | result slot | native |
| `map(from, as, prompt)`, `.map(...)` | map; bounded instruction | result family | native |
| `reduce(from, as, query, options?)`, `.reduce(...)` | reduce; query JSON and optional `outputSchema` | result slot | native |
| `answer(from, options?)`, `.answer(...)` | answer; optional chars, no as | terminal program | native |
| `.step(step)` | appends a public step | tracks its input/result names | native |
| `from(document)` | raw program | no binding-order inference | native |
| `.schema`, `.toJSON()` | frozen public JSON | program document | native |

### The messages pen — [MESSAGES-PEN.md §2](MESSAGES-PEN.md)

| Method | Emits | Type | Status |
|---|---|---|---|
| `catalog(source?, locale?)` | starts an empty draft; defaults to all/en | source key space | native |
| `.entry(id, template)` | adds or replaces one string entry | adds present id | native |
| `.entries(map)` | adds or replaces several entries | adds literal keys | native |
| `.complete()` | complete frozen catalog | every source id | native |
| `.partial()` | frozen subset | explicitly present ids | native |
| `.toJSON()` | complete frozen catalog | requires completeness | native |
| `from(document, options?)` | raw draft; options choose source/locale | literal keys where known | native |
| `inline(template)` | inline MessageSpec string | string | native |
| `message(id, options?)` | `{ $msgid, params?, message? }` | known id/parameter names | native |

### The JTLT pen — [JTLT-PEN.md §2](JTLT-PEN.md)

| Method | Emits | Type | Status |
|---|---|---|---|
| `text(string)` | literal text; doubles a leading `$` | string segment | native |
| `query(expression, options?)` | raw or captured query string/object | interpolated segment | native |
| `raw(expression, options?)` | `{ $raw: expression }` | unescaped interpolation | native |
| `json(expression, options?)` | `{ $json: expression }` | JSON serialization | native |
| `apply(selector, mode?, options?)` | `$apply` selector or selector/mode list | dispatch splice | native |
| `rule(body?, options?)` | body and optional match/mode/priority | rule | native |
| `.body(segments)`, `.match(spec)`, `.mode(string)`, `.priority(number)` | replacement rule member | same rule | native |
| `stylesheet(rules?, options?)` | `$jtlt`, optional output, rules | envelope | native |
| `bare(rules?)` | public rule array | shorthand | native |
| `.rules(rules)`, `.rule(rule)` | replace or append rules | preserves envelope/shorthand | native |
| `.output(method)` | output method; wraps a bare list in an envelope | text or XML | native |
| `from(document)` | raw template with member order preserved | template | native |
| `.schema`, `.toJSON()` | frozen public JSON | document | native |

### The project pen — [PROJECT-PEN.md §2](PROJECT-PEN.md)

| Method | Emits | Type | Status |
|---|---|---|---|
| `file(name, kind, text)` | `{ name, kind, text }`, preserving text | literal name/kind | native |
| `jsonFile(name, kind, document)` | same file, with serialized JSON text | literal name/kind | native |
| `defineProject(files?, options?)` | version, files, optional active/layout | names from files | native |
| `.files(files)` | replacement file list | replaces known names | native |
| `.file(file)` | appended file | adds its name | native |
| `.active(name)` | requested active name | existing name | native |
| `.layout(options)` | replacement layout | mode, ratio, autorun | native |
| `from(document)` | raw project envelope | arbitrary names | native |
| `.schema`, `.toJSON()` | frozen public document | project document | native |

### The chart pen — [CHARTS-PEN.md §2](CHARTS-PEN.md)

| Method | Emits | Type | Status |
|---|---|---|---|
| `pie(options?)`, `bar(options?)`, `line(options?)`, `scatter(options?)` | the named `type` and options | corresponding chart | native |
| `candlestick(options?)`, `radar(options?)`, `gauge(options?)`, `boxplot(options?)` | the named `type` and options | corresponding chart | native |
| `heatmap(options?)`, `treemap(options?)`, `streamgraph(options?)`, `sankey(options?)`, `map(options?)` | the named `type` and options | corresponding chart | native |
| `.options(object)` | supplied known members | same kind | native |
| `.title(text)`, `.stream(spec)` | `title`, `stream` | same kind | native |
| `.donut(value)`, `.slices(values)` | pie members | pie | native |
| `.stacked(value)`, `.orient(value)`, `.categories(values)` | bar members | bar | native |
| `.log(value)`, `.catLabel(text)`, `.valLabel(text)` | members on kinds that declare them | same kind | native |
| `.series(values)` | the kind's series shape | same kind | native |
| `.x(value)`, `.markers(value)`, `.sampling(value)` | line members | line | native |
| `.xLabel(text)`, `.yLabel(text)`, `.domain(spec)`, `.dateNames(names)`, `.timeFormats(formats)` | axis members on their declared kinds | same kind | native |
| `.xLog(value)`, `.yLog(value)`, `.refY(value)`, `.refLabel(text)` | scatter members | scatter | native |
| `.points(values)`, `.candles(values)` | the kind's point/candle data | same kind | native |
| `.axes(values)`, `.max(value)`, `.min(value)` | radar/gauge members | same kind | native |
| `.value(value)`, `.unit(text)`, `.tone(value)` | gauge values; map `value` is a property name | same kind | native |
| `.boxes(values)`, `.xLabels(values)`, `.yLabels(values)`, `.values(values)` | boxplot/heatmap members | same kind | native |
| `.aspect(value)`, `.items(values)`, `.xs(values)` | treemap/map/streamgraph members | same kind | native |
| `.nodes(values)`, `.links(values)` | sankey members | sankey | native |
| `.label(text)`, `.simplify(value)`, `.features(values)` | map members | map | native |
| `from(document)` | raw document, including extensions | declared chart shape | native |
| `.schema`, `.toJSON()` | frozen public document | chart definition | native |

### The Jaren linq client — [DB-CLIENT.md §2](DB-CLIENT.md)

**What is the store's and what is the client's**

| Member | Whose | What the client does |
|---|---|---|
| `open(model, { driver, …, validator? })` | the store's `openStore`, every option forwarded verbatim (`capture`, `live`, `jobs`, `profile`, … included) | wires `validator` as `compileSchema` — the default, `defaultValidator()`, is `new JarenValidator({ collectErrors: true })` with the string and date-time formats registered (the configuration MIGRATING-FROM-ZOD's recipe reproduces, so `s.string().email()` asserts out of the box); an explicit `compileSchema` wins; `validator: null` opens unvalidated, by name (`capabilities.validated === false`) |
| `client.entities.<Name>` | one frozen handle per declared entity, built at open (no Proxy; an unknown name is `undefined`, and for a pen model a compile error) | the store's typed entity set, every member — `create get update delete load explainLoad add put remove discard link unlink asNoTracking execute explain root scope relations` — plus §2.3's additions |
| `where`, `select`, `orderBy`, …, `toArray`, `first`, `count`, … | the chain: `fromAsync(handle)` ([QUERY-PEN.md](QUERY-PEN.md) §8, §10) | every `AsyncSequence` operator and terminal, delegated — nothing is duplicated, every read is the chain's document and pushes down; the handle is iterable (`for await`); two handles of one client share a `scope`, so a join's inner may be `fromAsync(otherHandle)` |
| `include(pick, spec?)` | the store's `load(spec)` (MODEL-FORMAT §10.4, §10.5) | opens a graph that EMITS the spec (§2.4, §3), typed `Loaded<>` by what it included |
| `link(own, member, target)`, `unlink(…)` | the store's membership API (MODEL-FORMAT §11.7) | reads the relation table first — the member must be a many-to-many relation (`JL0107`, naming the kind it is, or the members that are) — then records through the store; `saveChanges()` writes the join rows |
| `live(chain \| document, options?)` | the store's registration — `store.live` for an entity root, `collection.live` for a collection (LIVE-FORMAT §7) | hands over the chain's document and its `explain().bindings` as the externals (`options.externals` merge over them); the strategy, the reason and the maintenance are the store's |
| `client.collections.<name>` | the store's collection | the same chain start and `live`, typed from the pen's collection schema (§2.5) |
| `saveChanges()`, `transaction(fn)`, `close()`, `capabilities`, `store` | the store's | pass-throughs; `saveChanges` and `live` exist exactly when the model declares entities, as on the store; `store` is the escape hatch, typed `TypedStore` |

**The exported names**

| Name | Answers | Type reading |
|---|---|---|
| `open(model, options)` | a promise of the frozen client — `store`, `capabilities`, `entities`, `collections`, `transaction`, `close`, and `saveChanges`/`live` when the model declares entities | `Client<InferMeta<typeof model>>` for a pen model; `Client<E>` for `open<E>(json, …)`; the wide map for a bare JSON model |
| `defineReplication(header)` | a logical replication document builder — §2.7 | `ReplicationPen` |
| `defaultValidator()` | `new JarenValidator({ collectErrors: true })` with `stringFormats` and `dateTimeFormats` registered | `JarenValidator` |
| `createDbLedger(client, options?)` | the contract idempotency ledger (`claim`/`commit`/`fail`/`lookup`/`sweep`) over a declared collection of the client's store — §2.6 | `DbLedger`; structurally `@jarenjs/contract`'s `Ledger` |

**The entity handle**

| Group | Members |
|---|---|
| the unit of work | `create` `get` `update` `delete` `add` `put` `remove` `discard` `asNoTracking` |
| the store's reads | `load` `explainLoad` `execute` |
| the provider seam | `root` `scope` `relations` |
| membership | `link` `unlink` — the store's, behind §4.2's check |
| the chain | every `AsyncSequence` operator and terminal: `where` `select` `selectMany` `orderBy` `orderByDescending` `thenBy` `thenByDescending` `groupBy` `aggregate` `join` `groupJoin` `skip` `take` `distinct` `reverse` `concat` `defaultIfEmpty` `ofType` `cast` `zip` `mapAsync` `params` `toDocument` `toArray` `first` `firstOrDefault` `single` `singleOrDefault` `last` `lastOrDefault` `elementAt` `elementAtOrDefault` `count` `sum` `average` `min` `max` `any` `all`, and `Symbol.asyncIterator` |
| the client's own | `include` (§2.4) and `live` |
| in both | `explain` |

**The graph**

| Member | Emits | Note |
|---|---|---|
| `include(pick, spec?)` | one entry of `include` | `pick` is `(u) => u.posts`, or `u.get('posts')` for a name that collides with a proxy method |
| `where(predicate)` | `where` | consecutive calls conjoin under one `$and` |
| `orderBy(key, options?)`, `orderByDescending(key, options?)` | `orderBy` | replaces; `options` is `{ empty?, collation? }` |
| `thenBy(key, options?)`, `thenByDescending(key, options?)` | appends to `orderBy` | `JL0005` when no `orderBy` precedes it |
| `take(n)`, `skip(n)` | `take`, `skip` | the offset window |
| `after(cursor)` | `after` | the keyset continuation (§10.5) a `page()` over the same ordering emitted — typed by the declared ordering, so a bare key does not compile; the ROOT only |
| `maxDepth(n)` | `maxDepth` | the include depth bound (§10.4) |
| `asNoTracking()` | — | changes the load, never the document |
| `toSpec()`, `toJSON()` | the spec | plain deep-frozen JSON, a snapshot: mutating it changes nothing, and two builds are one document |
| `toArray()` | — | `load(spec)`: the store's one statement |
| `cursor(options?)` | — | `loadCursor(spec, options)`: one root graph per pull from that same statement, its includes attached and bounded per root; `return()` releases it; `{ signal?, tracking? }` — untracked unless `tracking: true` |
| `page(options?)` | — | `page(spec, options)`: one bounded page over the composite keyset — `{ items, continuation, hasMore, snapshot }`, never more than `limit` roots or `maxBytes` bytes; `{ limit?, after?, maxBytes?, consistency?, signal?, tracking? }`; a `take`/`skip` on the graph beside it is the store's `JD0032` |
| `explain()` | — | `explainLoad(spec)`: the SQL, the includes, the pagination strategy, the per-root bounds |

| Spec member | Emitted | Note |
|---|---|---|
| absent, or `true` | `true` | the rows |
| `{ count: true }` | `{ count: true }` | the number; any other member beside it is the store's `JD0032` |
| `where: (p) => p.stars.ge(3)` | `where: { $ge: ["$it.stars", 3] }` | the target row is `it`; translatability is the store's verdict (`JD0032`), and a relation hop is a plain path here and refused there |
| `orderBy: (p) => p.pid` | `orderBy: "$it.pid"` | a bare key, ascending |
| `orderBy: { key, desc?, empty?, collation? }` | `orderBy: { $key, $dir, $empty, $collation }` | as the chain spells `$orderby`; an array of either is an array |
| `take`, `skip` | `take`, `skip` | the window inside the subquery (a non-integer is the store's `JD0032`) |
| `maxRows`, `maxBytes` | `maxRows`, `maxBytes` | the per-root bounds (MODEL-FORMAT §10.4): rows of the relation per parent and serialised bytes per parent; crossing one is the store's `JD2073`, never a truncated graph. Defaults 1000 rows / 1 MiB (a `take` is the row bound of the include it windows); `Infinity` spells the unbounded case and emits as `null` |
| `include: { comments: spec }` | `include: { comments: <lowered> }` | over the TARGET's relation table (the scope carries every root's) |
| anything else | `JL0101` | the vocabulary is closed; `after` paginates the root, never an include |
<!--/fact-->
