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
errors: [{ code, message, docPath }] }` — the shape an editor's error
strip reads.

| kind | the file is | validated by |
|---|---|---|
| `app` | a `jaren-app` document | the composed app meta-schema (jslt + query by `$ref`) **plus a headless render audit** — a document that validates but throws on its first frame is still broken |
| `jslt` | a JSLT stylesheet | **compiled** by the engine with the operator registry |
| `query` | a query document | **compiled** by the engine with the operator registry |
| `state` / `data` | any JSON value (an input) | structural JSON only |
| `schema` | a JSON Schema | must be an object/boolean and compile |
| `fsm` / `dag` | a `jaren-fsm` / `jaren-dag` machine | its published flow grammar |
| `model` | a `jaren-model` store definition | the `jaren-model` grammar |

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
`validateFile(file, { operators })`.

## Assembly — files → runnable artifacts

`assembleArtifacts(project)` composes the files into the runnable set. v0.1
ships the **whole-document** contract: a runnable file (`app`, `fsm`,
`dag`, `model`, `jslt`, `query`, `schema`) is its own artifact
(`{ name, kind, role, doc, sourceFiles }`); `state`/`data` files are
inputs, not artifacts. **Fragment assembly** — composing separate `state`
+ `view` + `actions` files into ONE `jaren-app` document (the true
HTML/CSS/JS split) — is the model's headline enhancement and layers on
top without changing this contract (a future `sourceFiles` will list more
than one name).

## `layout` is frozen

`layout` is `{ mode: "classic" | "right" | "top", ratio: number,
autorun: boolean }`, defaulted to `{ classic, 0.5, true }`. It rides the
share link and the eject, so its shape is fixed at v0.1.

## `classifyChange` — reboot vs. hot-update

`classifyChange(prev, next)` reports, **per artifact**, whether a change
is `structural`, `state-only`, or `none`. It compares a structural key —
an `app` document *minus its `state`* — via the suite's own `contentKey`.
An IDE reads it to decide: a `state-only` edit hot-dispatches into a
running app (the user keeps scroll and inputs); a `structural` edit
reboots. Keeping this datum in the tested engine, and the policy in the
widget, is deliberate.

## Errors

Only the envelope raises a coded `StudioError`; a single file's grammar
problem is reported by `validateFile`, never thrown.

| code | meaning |
|---|---|
| `JS0001` | the project document is invalid (bad JSON, or fails the envelope schema) |
| `JS0002` | a file name is duplicated in the project |

## Status

v0.1 is the headless **engine**: parse, per-file validate, assemble,
classify. The IDE **component** — the file rail, the debounced editor,
the run stage, the AI author/operate surface, and the `.zip` eject — is
the next order. Syntax highlighting is a later concern.
