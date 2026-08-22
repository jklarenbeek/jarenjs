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

### 4.1 The extension seam

Unknown keywords normally vanish from the model — only the listed
constraint groups are carried. A producer MAY be told to preserve
named extension keywords instead:

```js
compileEmitModel(schema, { extensions: ['x-entity'] })
```

Every property member whose schema declares a listed keyword gains

```jsonc
{ "kind": "member", "name": "posts",
  "extensions": { "x-entity": { "relation": { "to": "Post" } } }, … }
```

with the value copied **verbatim and uninterpreted** — the compiler
learns "keep these keywords", never what they mean. Keywords are read
from the property schema node itself: a vocabulary that wants to ride
this seam declares its members inline, not behind `$ref`. `extensions`
is absent when no listed keyword is present, and the option is absent
by default, so models without it are byte-identical to before.

This is the contract for vocabulary-aware artifacts: a downstream
package post-processes the MODEL DOCUMENT (replace member types,
adjust `required`, add declarations) and hands the result back to any
renderer. `@jarenjs/db` renders entity-aware TypeScript from
`x-entity` this way, and `x-form` is the obvious second customer —
the seam serves any vocabulary, which is why it lives here and not in
either consumer.

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
| `optional` | `item` | a tuple position that may be absent; only valid inside `tuple.items`, after every non-optional position |
| `record` | `value` | a map from string keys to `value` |
| `object` | `members`, `index?` | declared members, plus an optional index signature |
| `union` | `options` (≥ 2) | any one of |
| `intersection` | `parts` (≥ 2) | all of |

A producer MUST collapse the degenerate forms: a union or intersection of one
is that one type, and a union containing `unknown` is `unknown`. A consumer is
therefore entitled to assume `options` and `parts` have at least two entries.
A tuple with no positional items MUST also collapse: with a `rest` type it is
an `array` of that type, and without one it is the empty tuple — a consumer
never has to print a rest with nothing in front of it.

**Tuples mirror what the schema enforces, not what it suggests.** JSON Schema
`prefixItems` constrains the positions that exist; `minItems` says how many
must; an omitted rest schema leaves the array open. A producer therefore
marks only the first `minItems` positions non-optional and emits an `unknown`
rest for an omitted one — a closed, all-required tuple is emitted only when
the schema actually closes it.

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

## 7. Accepted and normalized variants

`@jarenjs/validate/normalize` makes a contract's input and output shapes
differ: a defaulted member is optional for the caller and present afterwards,
and a coerced member accepts its transport form on the way in. A model
compiled with normalization options carries **both**, so a typed contract
boundary can name them separately.

```json
{ "$emit": "0.1", "variants": true, "declarations": [
  { "kind": "declaration", "name": "Config", "variant": "normalized", "…": "…" },
  { "kind": "declaration", "name": "ConfigInput", "variant": "accepted",
    "variantOf": "Config", "…": "…" } ] }
```

- `variants` on the document is `true` exactly when variant pairs were
  derived. Without normalization options there are no `variant` members at
  all, and each declaration is simply the schema's shape.
- The **normalized** declaration keeps the plain name. It is the shape *after*
  normalizing, which is what the rest of a program handles.
- The **accepted** declaration takes a suffix (`Input` by default) and names
  its counterpart in `variantOf`.

**A twin is emitted only when the type actually differs.** A producer computes
that bottom-up — a type differs if anything it contains differs — so a schema
with one defaulted field does not double every declaration in the document.
Everything unaffected is referenced by its single shared name from both sides.

**Two normalizations produce a difference, and only two.** `useDefaults` moves
a member from optional to required across the boundary. `coerceTypes` widens
the accepted side to the types the normalizer will convert *from*. `trimStrings`
is string-to-string and `removeAdditional` removes members no type declared, so
neither justifies a second declaration.

A producer MUST derive the accepted side from the **same** switch resolution
the normalizer uses, including predicate options. A variant that disagrees
with the normalizer is worse than no variant: it is a type that certifies an
input the normalizer will not accept.

The same rule extends to *where* normalization runs. `compileNormalizer`
deliberately does not descend `anyOf`/`oneOf` — which branch applies is only
known after validating — so inside a union branch no default materializes and
no coercion applies. A producer MUST NOT let variant semantics leak into
union branches: a branch references the schema's **as-declared** reading.
When a referenced type differs under normalization, that reading is its own
`Plain`-suffixed declaration, shared by both sides of the pair; when it does
not differ, the branch shares the single plain-named declaration.

Three consequences worth stating because each was once wrong:

- a **`required` member with an enabled default** is still optional on the
  accepted side — the normalizer materializes it before validation runs;
- a **`const`/`enum` with an enabled coercion** widens its accepted side by
  the source primitives that can actually reach a member of the literal set
  (an integer enum admits `string`; a string enum of words admits nothing
  extra, because no number ever becomes `"admin"`);
- coercion widens only nodes with a **single string-valued `type`**, because
  that is the only place `coerceToType` runs.

## 8. Determinism

Two compilations of the same input MUST produce byte-identical models.
Concretely, a producer:

- keeps schema declaration order for members and `$defs`;
- keeps discovery order for declarations;
- derives names from the document, never from a counter that depends on
  traversal timing;
- does not serialize a `Set` or `Map` whose order depends on insertion history
  across merges.

## 9. What the format deliberately does not model

- **`if`/`then`/`else` and `not`.** Neither has a sound type-level reading —
  the first is a conditional type in principle and unreadable in practice, the
  second has no equivalent at all. A producer ignores them for the type and
  **records them as dropped constraints** (§6), rather than inventing a union
  that would be wrong in one direction or the other. The same recording
  applies to the other silently-widening keywords: integer-ness (`type:
  "integer"` emits as `number`), `dependentSchemas`/`dependencies`,
  constraining `unevaluated*` values, and the key restrictions of
  `patternProperties` (the index signature carries their value types, but no
  type restricts which keys a pattern admits).
- **Type inference from applicators.** `properties` or `items` on a node with
  no `type` does not make it an object or an array — the validator accepts a
  primitive without reading either. A producer emits the described container
  shape as one union arm and the remaining JSON kinds beside it.
- **Cross-document `$ref`.** A model compiles the document it was given.
  Following a ref into another document would mean owning a resolution scope,
  which is `@jarenjs/validate`'s job, not this format's. Within the document,
  the resolved forms are exactly the ones `compileNormalizer` resolves — `#`,
  `#/pointer` and plain `#anchor` (outside embedded `$id` resources) — and a
  `$ref`'s siblings compose with its target as an intersection, per 2019-09+.
  That composition is unconditional, like the normalizer's: a draft-07
  document in which a validator lets `$ref` shadow its siblings should not
  put constraining siblings there — they are dead keywords to that validator,
  and this producer takes them at their word.
- **`removeAdditional` and `trimStrings` as type differences.** Neither
  changes a *declared* type: trimming is string-to-string, and stripping
  removes members the type never declared. Only `useDefaults` and
  `coerceTypes` earn a variant (§7).
