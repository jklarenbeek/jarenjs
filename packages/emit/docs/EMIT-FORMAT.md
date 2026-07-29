# The Jaren emit type model — format 0.1

The contract between a schema analysis and an artifact emitter.

This document is normative for producers and consumers of the model; the
machine-checkable form is
[`jaren-emit-model.schema.json`](../schemas/jaren-emit-model.schema.json), and
the package's test suite validates every model it produces against it.

## 1. Why the model is a separate, published stage

A JSON Schema graph cannot be walked top-to-bottom by a template:

- `$ref` points sideways, and may point in a cycle;
- a subschema may be anonymous, while a declaration needs a name;
- `allOf` is intersection, `anyOf`/`oneOf` are unions, and `if`/`then` is
  neither;
- roughly half the vocabulary constrains a value without narrowing its type.

The model is the result of resolving all four. It is a **flat, ordered list of
named declarations** in which every reference is by name — so a cyclic schema
produces an acyclic model — and every constraint that a type cannot carry is
recorded rather than dropped.

Publishing it, rather than keeping it as an emitter's private state, is what
makes a third-party emitter a first-class citizen: the bundled TypeScript and
Markdown emitters read exactly this and nothing else.

## 2. The document

```json
{ "$emit": "0.1",
  "source": "user.json",
  "root": "User",
  "declarations": [] }
```

- `$emit` (REQUIRED) — the format version, the string `"0.1"`.
- `declarations` (REQUIRED) — the declarations, in **emission order**.
- `source` (OPTIONAL) — where the model came from; emitters may put it in a
  generated banner. `null` when unknown.
- `root` (OPTIONAL) — the declaration corresponding to the source schema's
  root. `null` for a bundle with no single root.

## 3. Declarations

```json
{ "kind": "declaration",
  "name": "User",
  "type": { "kind": "object", "members": [] },
  "constraints": [],
  "doc": ["A user"] }
```

`name` is unique across the document and is a safe identifier: it matches
`[A-Za-z_$][A-Za-z0-9_$]*`. A producer derives it from the schema's own
vocabulary where one exists (a `$defs` key, a `$ref`'s last pointer token) and
otherwise from the path that reached the node. **Names are deterministic**: the
same input document produces the same names in the same order, because a
generated artifact that churns between runs cannot be reviewed in a diff.

## 4. Members

```json
{ "kind": "member",
  "name": "id",
  "type": { "kind": "primitive", "primitive": "string" },
  "required": true,
  "default": 0,
  "constraints": [],
  "doc": [] }
```

`name` is the property name **verbatim** — it is data, not an identifier, and
an emitter quotes it if its target language requires that. `default` is
present only when the source schema declares one. Members appear in the order
the schema declared them.

## 5. Type references

Every type reference carries a `kind`, so an emitter dispatches on shape
rather than on position. That is what lets a stylesheet match with a schema
match and stay correct under re-dispatch.

| `kind` | members | meaning |
|---|---|---|
| `unknown` | — | nothing is known; the honest top type |
| `never` | — | nothing satisfies this (`false` schema) |
| `primitive` | `primitive` | one of `string`, `number`, `boolean`, `null` |
| `literal` | `value` | exactly this JSON value |
| `ref` | `ref` | the declaration with that `name` |
| `array` | `items` | a homogeneous list |
| `tuple` | `items`, `rest?` | positional items, optionally followed by a rest type |
| `record` | `value` | a map from string keys to `value` |
| `object` | `members`, `index?` | declared members, plus an optional index signature |
| `union` | `options` (≥ 2) | any one of |
| `intersection` | `parts` (≥ 2) | all of |

A producer MUST collapse the degenerate forms: a union or intersection of one
is that one type, and a union containing `unknown` is `unknown`. A consumer is
therefore entitled to assume `options` and `parts` have at least two entries.

**`index` covers the declared members.** When an object has both members and
an index signature, the index type is widened to include every member's type,
because TypeScript — and any other target with the same rule — rejects an
index signature that does not.

## 6. Constraints and documentation

```json
{ "constraints": [{ "keyword": "minLength", "value": 3 }],
  "doc": ["Display name",
          "Schema constraints this type cannot express: minLength=3"] }
```

`constraints` is the **structured** record of everything the source schema
asserted that the type does not enforce. `doc` is the same information already
flattened to lines, together with the schema's `description`, so an emitter
prints lines rather than deciding what belongs in a comment.

Both are always present; an empty array means there is nothing to say, and an
emitter MUST then produce no comment at all. That absence is deliberate: it
lets a template express "only when present" by dispatching a path that yields
the empty sequence, without a conditional.

**A producer MUST NOT drop a constraint silently.** The whole reason a
generated type is trustworthy is that what it cannot say, it says it cannot
say.

## 7. Determinism

Two compilations of the same input MUST produce byte-identical models.
Concretely, a producer:

- keeps schema declaration order for members and `$defs`;
- keeps discovery order for declarations;
- derives names from the document, never from a counter that depends on
  traversal timing;
- does not serialize a `Set` or `Map` whose order depends on insertion history
  across merges.

## 8. What the format deliberately does not model

- **`if`/`then`/`else` and `not`.** Neither has a sound type-level reading —
  the first is a conditional type in principle and unreadable in practice, the
  second has no equivalent at all. A producer emits `unknown` and records
  nothing, rather than inventing a union that would be wrong in one direction
  or the other.
- **Cross-document `$ref`.** A model compiles the document it was given.
  Following a ref into another document would mean owning a resolution scope,
  which is `@jarenjs/validate`'s job, not this format's.
- **Distinct accepted and normalized variants.** `@jarenjs/validate/normalize`
  makes the input and output shapes of a contract differ, and a model that
  carried both would let an emitter produce the `Accepted`/`Normalized` pair a
  typed contract boundary wants. Format 0.1 does not, and adding it is the
  next thing this format should grow.
