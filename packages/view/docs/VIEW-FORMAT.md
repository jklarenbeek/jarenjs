# The Jaren View Format

**Version 0.1 — Specification**

Module: `@jarenjs/view`. This document is the language contract for the
Jaren vnode format — the JSON vocabulary user interfaces are written in —
and the behavioral contract every renderer of the format MUST honor. It
plays the role for views that [QUERY-FORMAT](../../json/docs/QUERY-FORMAT.md)
plays for queries and [JSLT-FORMAT](../../json/docs/JSLT-FORMAT.md) for
stylesheets: vnodes are the intended *output* vocabulary of JSLT rule
bodies, closing the XSLT triangle — match with JSONPath, type with JSON
Schema, produce vnodes.

## 1. Introduction

### 1.1 What this format is

A **vnode** is a plain JSON value describing a fragment of user
interface. There are no functions anywhere in a vnode document: event
handlers are data (§4), so a complete interface is serializable,
schema-validatable, diffable, and generatable by a constrained decoder.
The grammar is published as JSON Schema in
[`schemas/jaren-vnode.schema.json`](../schemas/jaren-vnode.schema.json).

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**,
**RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as
described in RFC 2119.

- A **producer** (a JSLT stylesheet, a hand-written view, a model)
  emits vnode documents and MUST emit documents valid per §2–§4.
- A **renderer** consumes vnode documents. Two renderer classes are
  specified: **patching** renderers that maintain a live tree (§5) and
  **serializing** renderers that emit markup (§6). The reference
  implementations are `createDomRenderer` and `renderToString`.

### 1.3 Terminology

- **Vnode** — any value of the format (§2).
- **Element** — a vnode of the form `[tag, props?, ...children]`.
- **Text** — a string or number vnode.
- **List** — an array vnode spliced into its parent's children.
- **Binding** — the opaque JSON value of one `on` member (§4).
- **Reconciliation** — patching a live tree from one vnode to the next.

## 2. The vnode document

A vnode is classified by shape, in this order:

1. **Text** — a `string` or a `number`. Renders as
   `String(value)`. Numbers are text so query results embed without
   conversion; `NaN` and infinities are producer errors.
2. **Skipped** — `null` and the booleans `true`/`false` render nothing
   and occupy no child position. This makes `{"$if": ...}` bodies and
   boolean short-circuits compose without wrapper nodes, and it means
   an *empty sequence* from a query (which `@jarenjs/json` maps to
   `undefined`) also renders nothing.
3. **Element** — an array whose first item is a string: `[tag,
   props?, ...children]`. The tag MUST be a non-empty string. If the
   second item is a plain object (not an array, not `null`) it is the
   **props**; otherwise it is the first child.
4. **List** — any other array. Its items are spliced into the parent's
   children **in place**, recursively. A list at the root of a document
   is a producer error in 0.1 (renderers MAY reject it): the root MUST
   be a text or element vnode.

The props-detection rule (element item 2) means an element whose first
child is itself an object-shaped value cannot omit props: write
`["div", {}, child]`. Producers SHOULD always write the props object;
`h()` does.

**Rationale for the tagged-array form** (non-normative): rule bodies in
JSLT are query documents where object members with `$`-prefixed names
are operators; an object-shaped element vocabulary (`{"tag": ...}` or
`{"$": ...}`) would collide with or shadow that namespace. Arrays with a
literal string head pass through the query engine untouched, and the
list form is exactly what an `[{"$apply": ...}]` array-constructor body
produces. The same tagged-pair shape underlies the JTLT front-end.

## 3. Props

Prop values MUST be JSON values. Three names are renderer instructions:

- **`key`** — a string or number giving the element identity among its
  siblings (§5.3). Never rendered.
- **`on`** — an object `{ [eventType]: binding }` (§4). Never rendered.
- **`style`** — a CSS declaration string, or an object of declarations.
  Object keys in camelCase are converted to kebab-case; keys starting
  with `--` pass through. `null`/`false` members are dropped.

Every other prop **writes through**:

- A patching renderer targeting the DOM SHOULD assign `node[name]` when
  the node has that property (form controls: `value`, `checked`, ...)
  and use attributes otherwise; elements in a foreign namespace (§5.4)
  always use attributes.
- `true` renders as a bare attribute, `false` and `null` remove the
  attribute / clear the property.
- Prop names are used as-is: producers write `class`, not `className`.

## 4. Events are data

The value of an `on` member is an opaque JSON **binding**. The view
layer MUST deliver the binding verbatim to the environment's event hook
(`onEvent(binding, nativeEvent)`) and MUST NOT interpret it. What a
binding means belongs to the layer above; in `@jarenjs/app` it is an
action name or `{"action": name, "with": payload}`
([APP-FORMAT](../../app/docs/APP-FORMAT.md) §4).

Because bindings are data, a producer builds event payloads at *render
time*: a JSLT rule that renders the node at `$path` can embed that
location — or any value in scope — inside the binding. This replaces
closure capture and payload-creator functions.

A patching renderer MUST rebind by data: attaching, changing or
removing a binding across renders MUST NOT accumulate native listeners.
The reference implementation stores the current `on` object on the DOM
node behind one shared proxy listener per event type.

## 5. Reconciliation

### 5.1 The sharing fast path

For any subtree where `oldVnode === newVnode`, a patching renderer
MUST skip reconciliation entirely — no descent, no prop diff. This is
the load-bearing clause of the format's performance story: the JSLT
engine guarantees that unchanged input flows to output by reference
(share disposition, rebuild-only-if-changed), and the JSON Patch
engine's copy-on-write guarantees the same for state. Reference
equality is therefore *evidence of no change*, end to end.

The corollary constraint: a renderer MUST NOT mutate or annotate
vnodes (no `.elm` backpointers, no normalization in place). Vnode
documents may be frozen, cached, or shared between subtrees.

### 5.2 Patch in place or replace

Two vnodes are **the same node** when both are text, or both are
elements with equal tag and equal `key`. Same nodes patch in place
(text: update the character data; element: diff props, reconcile
children). Different nodes replace: the old subtree is discarded and
the new one built fresh.

### 5.3 Children and keys

Child reconciliation MUST preserve the DOM node identity of keyed
elements that appear on both sides, moving them instead of recreating
them. The reference algorithm is a head/tail two-pointer sweep with a
lazily built key map for the middle; its guarantees, which every
implementation MUST match:

- keys are unique among siblings (duplicate keys are a producer error;
  behavior is unspecified);
- an element vnode with a key never patches against one with a
  different key or without one;
- unkeyed children reconcile positionally.

Mixed keyed/unkeyed sibling lists are legal but SHOULD be avoided;
reorder efficiency is only specified for fully keyed lists.

### 5.4 Namespaces

An element with tag `svg` and its descendants are created in the SVG
namespace. Re-entering HTML through `foreignObject` is not supported in
0.1.

## 6. Serialization

`renderToString(vnode)` MUST produce markup equivalent to what a
patching renderer would build: text and attribute values escaped (`&`,
`<`, `>` in text; `&`, `"` in double-quoted attributes), void elements
(`br`, `img`, `input`, ...) without end tags, `key` and `on` producing
no output, boolean and style props serialized per §3. Serialization is
pure: no state, no DOM, safe in any runtime.

Hydration in 0.1 is a client-side first render into the same container
(empty and rebuild). Adopting existing server-rendered DOM is a
roadmap item, not part of this contract.

## 7. Open items (roadmap, non-normative)

- **Fragment / multi-root documents** — a list at the root.
- **DOM-adopting hydration** (§6).
- **Memoized rule outputs** — a cache keyed by (rule, state-node
  reference) in the layer above, so unchanged *state* yields
  reference-equal *vnodes* across frames and §5.1 fires for whole
  branches; today §5.1 fires for shared/embedded subtrees.
- **Component escape hatch** — a registered-widget vocabulary for
  irreducibly imperative islands (canvas, third-party controls),
  mirroring the effect registry of APP-FORMAT.
- **A `properties`-vs-`attributes` normative table** replacing the
  `name in node` heuristic of §3.
