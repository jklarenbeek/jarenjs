# PROJECT-FORMAT.md — the `jaren-project` document (v0.1)

A **project** is a jaren application seen as an IDE would see it: a small
tree of typed files, each one concern — a view, the actions, the state,
a schema, a data model, queries, a flow machine — the way HTML, CSS and
JavaScript are separate files. The document is a **thin envelope**; each
file's meaning lives in its own grammar, not in the envelope.

```jsonc
{
  "project": "0.1",
  "files": [
    { "name": "app.json",      "kind": "app",   "text": "…a jaren-app document…" },
    { "name": "series.query",  "kind": "query", "text": "{ \"$npv\": [\"$.rate\", \"$.cf[*]\"] }" },
    { "name": "seed.data",     "kind": "data",  "text": "{ \"cf\": [-1000, 300, 400] }" }
  ],
  "active": "app.json",
  "layout": { "mode": "classic", "ratio": 0.5, "autorun": true }
}
```

The envelope is published as a JSON Schema (`schemas/jaren-project.schema.json`
+ a draft-07 twin) and validated by `parseProject`, which returns a
frozen, normalized project (the layout defaulted, `active` resolved to a
real file).

## The file kinds

Each file declares a `kind`; its `text` is a JSON document validated
against **that kind's grammar at its own boundary** — never composed into
one meta-schema. `validateFile(file)` returns `{ valid, kind, total,
errors: [{ code, message, docPath }], warnings }` — the shape an editor's
error strip reads. `warnings` has the same item shape and never makes a
file invalid; today only an `app` file can carry one (`JS0005`–`JS0007`).
`describe(project)` carries each file's `errors` and `warnings`, and the
IDE's error strip lists a file's warnings after its errors, marked as
warnings; the file rail marks a valid file that carries one apart from
an invalid file.

| kind | the file is | validated by |
|---|---|---|
| `app` | a `jaren-app` document | the composed app meta-schema (jslt + query by `$ref`, admitting the operator registry's operators) **plus a headless render audit** — a document that validates but throws on its first frame is still broken, and so is one whose view renders an element written as an object (`JS0004`, see below) |
| `jslt` | a JSLT stylesheet | **compiled** by the engine with the operator registry |
| `query` | a query document | **compiled** by the engine with the operator registry |
| `state` / `data` | any JSON value (an input) | structural JSON only |
| `schema` | a JSON Schema | must be an object/boolean and compile |
| `fsm` / `dag` | a `jaren-fsm` / `jaren-dag` machine | its grammar (admitting the operator registry's operators) and its compiler, with the registry and the type-test compiler a `query` file compiles with; named tasks are checked without execution |
| `model` | a `jaren-model` store definition | its grammar, normalization and SQLite collection/entity planning |
| `contract` | a `jaren-contract` document | `compileContract`, with coded diagnostics |

**Why per-file, not one composed schema.** The published `jaren-query` /
`jaren-jslt` grammars are *closed* — their operator vocabulary is
enumerated. A data query that uses a host-registered operator (`$npv`,
`$sqrt`) validates only when the studio's operator packs are mounted, so
`jslt`/`query` files are **compiled with the registry** rather than checked
against the closed grammar: registered operators pass, and a real mistake
comes back as its own coded code with a JSON Pointer (`JQ0002 — at /x:
unknown operator '$flter'`). Composing every file into one gate would make
that impossible; keeping each file on its own boundary is the honest
design, not a compromise. A host embeds its own vocabulary with
`validateFile(file, { operators })`; an `app`'s render audit renders its
first frame with that registry too, so a function the host registers
(`{"$call": ["twice", 21]}`) renders there as it does in the host.

**An app computes with the registry's operators.** An `app` file's
meta-schema reads its query and JSLT grammars with one more phrase per
operator the registry mounts, each with the operand shape its compile
accepts (`{"$sqrt": 16}`, `{"$pow": [2, 10]}`), so a view, an action or a
subscription that uses a pack operator validates under a registry that
mounts the pack — the built-in math/finance/stats packs when the host
passes none. An operator the registry does not mount is refused as an
unknown operator, `JQ0002` at its own place, and a document that names
none of the registry's operators is read against the published grammars.
The document host validates, audits and boots an app under the registry
it is handed (`loadStudioDocument(doc, { operators })`,
`createApp`'s `operators`), and the project stage hands it the registry
the files validate under, so an app that validates also runs.

**A flow computes with the registry's operators too.** An `fsm` file's
guards and effect props, and a `dag` file's query and jslt nodes, task
`with` members and edge `select`s, are read against the same composed
grammars and compiled with the registry (`compileFsm` and `compileDag`'s
`operators`), so a guard such as `{"$gt": [{"$sqrt": "$.context.n"}, 3]}`
validates under a registry that mounts the math pack. A run of the file
(`runProjectFile`) and the project's flow host step the machine and run
the graph under the registry the files validate under; an operator it
does not mount is refused as `JQ0002` at its own place, as before. The
schema operators are read as a `query` file reads them: a guard or node
such as `{"$valid": ["$.context.n", {"type": "number"}]}`, and a jslt
node's schema match, compile with the same type-test compiler
(`compileFsm` and `compileDag`'s `compileTypeTest`), and the runs and the
flow host step and run them with it.

**An unknown operator is named, not its consequences.** The `app`, `fsm`
and `dag` grammars place a query in a branch (an action is an awaiting
action or a query document), so an operator outside the vocabulary makes
every branch fail and the grammar reports what each branch missed — `must
have required property '$await'` for an action using `$lower-case`. When
such a file fails its grammar, `validateFile` compiles its query-bearing
members (an app's actions, subscriptions and view; an fsm; a dag) with the
operator registry, and an unknown operator the compiler names replaces the
grammar errors at, under and above its owner member: `JQ0002 — at
/actions/search/state/q: unknown operator '$lower-case' (did you mean
'$lower'?)`. Grammar errors elsewhere in the file stay.

**What the app render audit reads.** Beyond a first frame that throws,
the audit reads the view with the view format's own vnode rules
(VIEW-FORMAT §2: text, skipped values, `[tag, props?, …children]`
elements, lists), over the stylesheet's literal elements — so a branch
the first frame does not take, such as the body of a `$for` over an
empty list, is read too — and over the first frame itself:

- an object carrying `tag` or `type` together with `props`, `attrs` or
  `children`, where the view renders a vnode child (or as the root), is
  refused `JS0004` at its place. §2 has no object vnode: both renderers
  draw any object there as nothing. Objects elsewhere — the state, a
  widget's props, an operator's operands — are data and are not read;
- any other object where the view renders a vnode child (or as the root)
  is warned `JS0006`: it renders as nothing too (the DOM renderer refuses
  one at the root), but an object of no element shape is as often a value
  the author means to drop, so the file stays valid;
- an element written as an object with a `tag` (`["ul", {"tag": "li",
  "children": […]}]`) in an element's props position is warned `JS0007`:
  the renderer reads it as that element's attributes, which renders, so
  the file stays valid. `type` alone is not read as the shape there,
  because it is an HTML attribute (`["input", {"type": "text", …}]`);
- an authored text literal in a child position that holds another
  template language's expression is warned `JS0005`: `${…}`, `{{…}}`,
  `{%…%}`, a leading `for .` or `if .` (Schibsted JSLT, with or without
  `[` and parentheses), or a call `name([…])`. It renders as literal
  text, which can be what the author meant, so the file stays valid. A
  state string shown through a path is the reader's data and is never
  warned about.

## Assembly — files → runnable artifacts

`assembleArtifacts(project)` returns `{ artifacts, errors }`. Each runnable
file (`app`, `fsm`, `dag`, `model`, `jslt`, `query`, `schema`, `contract`)
produces `{ name, kind, role, doc, sourceFiles }`; `state`/`data` are inputs.
Assembly resolves JSON and references; `describe(project)` additionally
validates assembled documents and reports each file's errors.

A file can supply absent top-level members through `imports`, an object
mapping member names to exact project filenames. For example:

```json
{
  "name": "app.json", "kind": "app", "text": "{}",
  "imports": { "view": "app.view", "actions": "app.actions", "state": "app.state" }
}
```

Each source's entire JSON value becomes the destination member. Sources may
themselves import members. The allowed destination members are:

| Destination kind | Importable members |
|---|---|
| `app` | `view`, `actions`, `state`, `subs` |
| `fsm` | `states`, `transitions`, `initial` |
| `dag` | `nodes`, `edges`, `output` |
| `model` | `collections`, `entities` |

`resolveProjectFile(project, name)` returns `{ doc, sourceFiles }`, with
dependencies in traversal order, deduplicated. Missing sources, cycles,
unsupported members and a member supplied both locally and by import raise
`JS0003`. Source files are never mutated. `renameProjectFile` updates all
references atomically. `writeProjectArtifact` writes edits back into their
source files, preserving untouched text and refusing conflicting writes to a
shared source. It compares values as `classifyChange` does, so a reorder below
a slot kind's top level is an edit that is written, two import sites differing
only there conflict, and a file whose top-level slots an editor merely rebuilt
in another order keeps its text. Deletion leaves dependent files with explicit reference errors.

The website keeps an app visible while editing a fragment directly imported
by exactly one app. Imported state changes hot-update that app; structural
changes reboot it. Ambiguous owners require selecting the intended app.

## Input and model routing

Optional file members `input`, `model` and `collection` select execution inputs.
`input` names a `data` or `state` file; absent it, pure runners use the first
`data` file, then the first `state` file, then JSON null. `model` explicitly
names a model file for a query. It never implicitly selects the first store.
`collection` chooses a collection; a model with exactly one collection can
omit it. `projectFileContext` resolves these references and refuses wrong
kinds or missing names. The IDE exposes selectors beside the editor.

The website runs collection models in private in-memory SQLite workers, one
owner per model filename. Queries referencing that model share its rows;
other models and the separate data page do not. Switching files stops the
view's live subscription but retains the worker. Committing a changed model
or seed recreates its store; deleting a model, replacing a project or
destroying the app releases its worker. Invalid drafts retain the committed
stage. Runtime rows are transient and are not saved or shared.

A model's **explicit** `input` is a seed object mapping collection names to
arrays of documents, inserted before the first query. No implicit data file
seeds a store. The stage supports inserts, deletes, query results, SQL plans
and live query results. Entity-only models validate and can be authored, but
the website's execution controls currently require a collection.

FSM and DAG files mount the Flow diagram editor, including palette,
inspector, undo/redo and run controls. Diagram edits write back through
assembly. FSM effects are recorded, not dispatched to host services; only
the editor's registered local DAG tasks execute. Teardown cancels pending
runs and ignores late completions. The standalone `#/flow` route remains
available using the same editor.

## `layout` is frozen

`layout` is `{ mode: "classic" | "right" | "top", ratio: number,
autorun: boolean }`, defaulted to `{ classic, 0.5, true }`. It rides the
share link and the eject, so its shape is fixed at v0.1.

The IDE honours `autorun`: when false, edits keep the last committed stage
until **Run** is pressed. The toolbar toggle changes the saved layout.
The splitter resizes the editor horizontally in `classic`/`right` and
vertically in `top`; pointer cancellation restores the previous ratio.

**Download** exports the complete `jaren-project` envelope, including every
file and the active file/layout, and works for projects without an app.
**App JSON** separately exports the designated app document and reports
when none exists, resolving any imported members first. **Offline ZIP**
exports a standalone runner, `project.json`, every original file's text, and
bundled runtime, fonts and SQLite assets. Unzip and serve the directory over
localhost (the included README gives a Python command); no package install
or internet connection is required. Runtime versions come from the exporting
build and are recorded in `runtime/versions.json`. Authored external asset
URLs remain external. Live rows and host credentials are excluded.

The headless `@jarenjs/studio/export` entry accepts the host's runtime asset
bytes and produces a deterministic ZIP. It refuses unsafe archive paths;
source filenames are represented in `project.json` and mapped to numbered
files, so arbitrary project names cannot escape the archive directory.

## `classifyChange` — reboot vs. hot-update

`classifyChange(prev, next)` reports, **per artifact**, whether a change
is `structural`, `state-only`, or `none`. A change of artifact kind is
structural even when the JSON text stays the same. It compares an app's
entire document except `state` (other artifacts' whole documents) via the
suite's collision-free `semanticKey`, member order included (a query's
`$for` bindings nest and `$let` binds in key order, so a reorder-only edit
is `structural`, never `none`) except at the top level of an `app`, `fsm`,
`dag` or `model` document: those members are slots the project assembles in
its own order (local members, then imports), so moving one is no change; a
remaining document change, a reorder inside `state` included, is
`state-only`. Every filename, including `__proto__`, is an own member of
the result map.
An IDE reads it to decide: a `state-only` edit hot-dispatches into a
running app (the user keeps scroll and inputs; the stage compares the state
with its member order, so a view reading it through `$entries` re-renders);
a `structural` edit reboots. Keeping this datum in the tested engine, and the policy in the
widget, is deliberate.

## Errors

Envelope and reference operations raise coded `StudioError`s. `validateFile`
and `describe` report file problems as diagnostics.

| code | meaning |
|---|---|
| `JS0001` | the project document is invalid (bad JSON, or fails the envelope schema) |
| `JS0002` | a file name is duplicated in the project |
| `JS0003` | an import or execution reference cannot be resolved, or an artifact write conflicts |
| `JS0004` | reported by `validateFile` for an `app`: the view renders an element written as an object (`{"tag": "li", "props": …}`, `{"type": …, "children": …}`), which renders as nothing; a vnode is an array `["li", {attrs}, …children]` |
| `JS0005` | a **warning** `validateFile` reports for an `app`: an authored text literal holds another template language's expression (`${…}`, `{{…}}`, `{%…%}`, a leading `for .`/`if .`, a call `name([…])`); it renders as literal text, so the file stays valid |
| `JS0006` | a **warning** `validateFile` reports for an `app`: the view places an object of no element shape where a vnode renders (`["div", {}, {"class": "x"}]`); it renders as nothing, so the file stays valid |
| `JS0007` | a **warning** `validateFile` reports for an `app`: the view writes an element as an object with a `tag` in an element's props position (`["ul", {"tag": "li", "children": […]}]`); it is read as attributes, so the file stays valid |

## Status

v0.1 is the headless **engine** — parse, per-file validate, assemble,
classify — plus the IDE **component** that mounts it: the file rail, the
debounced editor with its typing buffer, the run stage, the three layout
modes with a drag splitter, the phone pane switcher, save/load/share, and complete file validation and export. The creation menu shares the engine’s ten-kind vocabulary and valid starter files. External authoring integrations publish through the same revision-checked public editor controllers.

The stage displays the nested app's latest boot/runtime failure and clears
it on restart. Remaining constraints live in
[ROADMAP.md](../../../docs/ROADMAP.md). The editor is a plain
`<textarea>` with no syntax highlighting or imperative editor chrome (the
[README](../README.md#complete-reusable-editors) says why).
