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

Schema validity is a **structural** property, not a safety one. A
grammar-valid vnode can still carry an `innerHTML` sink, an inline `on*`
handler or a `javascript:` URL, so validation alone does not make an
untrusted document safe to render — the default renderers trust their
input. Rendering an untrusted document requires the SAFE profile (§8).

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
   **props**; otherwise it is the first child. The tag
   `"jaren-widget"` is reserved: it marks a widget node (§7).
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

Prop values MUST be JSON values. Four names are renderer instructions:

- **`key`** — a string or number giving the element identity among its
  siblings (§5.3). Never rendered.
- **`on`** — an object `{ [eventType]: binding }` (§4). Never rendered.
- **`memo`** — a producer-owned subtree-stability marker (§5.5). Never
  rendered.
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

A **controlled form value** is authoritative. A patching renderer MUST
reassert `value`/`checked` on a form control against the control's
**live** DOM property, not against the previous vnode's value: a user
edit may have moved the live value since the last frame even when the
vnode value is unchanged, and the authoritative value MUST win. A
renderer SHOULD compare the live value first and write only on a genuine
difference, so an already-matching control is not rewritten (which
preserves the caret).

This reassertion MUST survive the sharing (§5.1) and `memo` (§5.5) fast
paths: a control inside a subtree those paths skip still holds
authoritative state, so a conforming renderer reconciles controls from
something other than the per-frame prop diff. The reference
implementation keeps a registry of controlled nodes and reconciles it
once per settled pass — which also lets a `select` resolve its value
after its options exist and a `multiple` select apply an array of
values. Composition/IME coordination is not yet specified (§8).

## 4. Events are data

The value of an `on` member is an opaque JSON **binding**. The view
layer MUST deliver the binding verbatim to the environment's event hook
(`onEvent(binding, nativeEvent)`) and MUST NOT interpret it. What a
binding means belongs to the layer above; in `@jarenjs/app` it is an
action name or `{"action": name, "with"?: payload, "event"?: [...],
"preventDefault"?: bool, "stopPropagation"?: bool}`
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

### 5.5 The memo marker

§5.1's fast path needs the *same object* on both sides, which a
producer that rebuilds its tree cannot always give. The `memo` prop is
the declared alternative: when two **same-node** element vnodes (§5.2 —
equal tag, equal `key`) both carry a `memo` prop and the two values are
equal by `Object.is`, a patching renderer MUST skip the subtree —
no prop diff, no descent — exactly as if the vnodes were reference
equal.

- The equality is `Object.is` over the raw prop values — producers use
  version counters, revision strings, or any stable token; an object
  identity works exactly like §5.1.
- `memo` is a **producer-owned correctness assertion**, `key`'s
  sibling: equal markers on same-identity nodes promise the subtrees
  render identically. A violated promise means stale output — the same
  class of producer error as a duplicate key. An absent `memo` on
  either side means the ordinary diff runs; `undefined` never matches.
- The skip shares §5.1's soundness condition in the reference
  renderer: while any widget is poisoned (§7.3) the marker is ignored,
  so a memo-stable subtree can never leave a poisoned widget inert.
- `memo` is never rendered and never serialized (§3, §6).

## 6. Serialization

`renderToString(vnode)` MUST produce markup equivalent to what a
patching renderer would build: text and attribute values escaped (`&`,
`<`, `>` in text; `&`, `"` in double-quoted attributes), void elements
(`br`, `img`, `input`, ...) without end tags, `key` and `on` producing
no output, boolean and style props serialized per §3. Serialization is
pure: no state, no DOM, safe in any runtime.

In trusted mode, a `textarea` carrying a `value` prop serializes that
value as escaped text content, overriding its children; nullish values
produce empty text. A leading newline is preserved through HTML parsing.
For a `select` with a `value` prop, serialization places `selected` on
the matching `option`, overriding authored selections and omitting the
select's ineffective `value` attribute. A single select marks its first
match; a `multiple` select accepts an array. Matching uses string values,
including an option's normalized text when it has no value attribute,
and works through `optgroup`. HTML cannot encode a single select's
`selectedIndex = -1`: with no match, the browser may select its default
option until the DOM renderer reconciles the control.
Safe mode keeps its attribute-only policy (§8).

Hydration in 0.1 is a client-side first render into the same container
(empty and rebuild). Adopting existing server-rendered DOM is a
roadmap item, not part of this contract.

## 7. Widgets

The escape hatch for irreducibly imperative islands — virtualized
grids, canvas, maps, third-party controls — mirroring the effect
registry of APP-FORMAT: JavaScript enters only at named, registered
boundaries. The format's side of the contract stays data; the
imperative side is a **registered widget**. The environment owns state
and orchestration; the widget owns its DOM.

### 7.1 The widget vnode

A widget node is an element vnode with the **reserved tag
`"jaren-widget"`**:

```json
["jaren-widget", {
  "name": "virtual-grid",
  "props": { "rows": "$.visibleRows", "rowHeight": 28 },
  "tag": "div",
  "key": "grid",
  "class": "grid-host"
}]
```

- **`name`** (REQUIRED) — the registered widget name, a non-empty
  string. An unregistered name is a configuration/producer error; the
  reference renderer throws.
- **`props`** (OPTIONAL) — the widget's JSON props, any JSON value;
  `null` when absent. Compared **by reference** across renders — the
  widget-level reading of §5.1's sharing contract: with the JSLT `memo`
  option, unchanged state yields reference-equal props, so an untouched
  widget is never poked.
- **`tag`** (OPTIONAL) — the host element's tag, default `"div"`
  (producers inside an `svg` subtree pick an SVG container like `"g"`).
- Every other prop (`key`, `class`, `style`, `on`, `id`, ...) applies
  to the **host element** exactly as on any element vnode (§3, §4).
- A widget node MUST NOT have vnode children — the widget owns the
  host's subtree and a patching renderer never descends into it.
  Children present is a producer error; the reference renderer throws.

**Why this tag** (non-normative, load-bearing): `$widget` is impossible
— in query/JSLT rule bodies a string leaf starting with `$` is a path
expression (QUERY-FORMAT §3.2, `JQ0004`), so every view stylesheet
would need `$$widget` escapes. `jaren-widget` is a valid custom-element
name, so a renderer that predates this section degrades to an inert,
harmless element; and the dash makes collision with real HTML tags
impossible.

### 7.2 The widget definition

A widget is registered JavaScript with this shape:

```js
{
  mount(host, props, emit),        // REQUIRED → returns a handle
  update(handle, props, prevProps),// OPTIONAL
  unmount(handle),                 // OPTIONAL cleanup
  ssr(props),                      // OPTIONAL → a vnode for serialization
}
```

- **`mount`** MUST be called with the host element **after** it is
  connected to the rendered tree (grids measure layout at mount). It
  returns an opaque handle threaded to `update`/`unmount`.
- **`update`** is called when the vnode's `props` **reference**
  changed. When `update` is absent and props changed, the renderer
  MUST fall back to `unmount` + a fresh `mount` into the same host.
- **`unmount`** MUST be called exactly once when the widget leaves the
  tree — including when an *ancestor* subtree is removed or replaced.
  This is where timers, listeners and observers die.
- **`emit(binding, nativeEvent?)`** — the function `mount` receives. It
  delivers `(binding, event)` **verbatim** to the environment's event
  hook, the identical contract to §4. A widget never invents its own
  action vocabulary: bindings arrive in its `props` (authored by the
  view stylesheet), and a widget that must attach runtime data (the
  clicked row id, the visible range) composes the binding it was given
  with that data — in `@jarenjs/app` terms, merges it into `with`. The
  single point of binding interpretation stays the layer above.

### 7.3 Registration and reconciliation

Widgets are registered on the renderer:
`createDomRenderer(container, { onEvent, widgets, document })`, with
`widgets` a `Record<string, WidgetDef>`; `renderToString` takes an
OPTIONAL `{ widgets }` (§7.4). Reconciliation semantics a patching
renderer MUST honor:

- **Create** — the host element is created from `tag`, the host props
  are applied (`name`/`props`/`tag` configure the widget and never
  reach the DOM; `on` wires exactly as in §4), and the mount is
  deferred: mounts run **after the patch completes**, in document
  order, when every host is connected. A mount MAY dispatch through
  `emit` synchronously; environments batch as usual, and the render
  boundary itself is serialized (§7.3.2).
- **Patch in place** — two widget vnodes with equal `key`: a changed
  `name` or host `tag` is a replace (destroy the old widget, create
  and mount the new one in a fresh host). Otherwise the host props
  diff normally, the renderer never touches the host's `childNodes`,
  and a changed `props` reference reaches the widget through `update`
  (or the unmount/remount fallback of §7.2). A reference-equal `props`
  MUST NOT call into the widget at all.
- **Destroy** — when a subtree containing widgets is removed or
  replaced, the renderer MUST call each widget's `unmount(handle)`
  exactly once, without descending into any widget's host subtree (the
  widget's own DOM may contain anything). The observable contract is
  **ownership-exactness**: cleanup MUST be independent of speculative
  or uncommitted desired-vnode state and exact for every resource the
  renderer actually acquired — a vnode is a description that may be
  old, new, or (after a mid-pass `destroy()`) only partially
  committed, so it cannot be the authority. The reference
  implementation walks the live DOM by its widget-host markers; a live
  acquisition registry or a precise partial-commit model conforms
  equally, provided the exactness holds. A throwing `unmount` MUST NOT
  prevent sibling widgets from unmounting: the walk finishes, then the
  first error surfaces. The walk snapshots each renderer-owned child
  list before invoking hooks, so an `unmount` that detaches its own
  host cannot shift a sibling out of the cleanup — though detaching,
  replacing or reparenting the renderer-owned host is OUTSIDE the
  widget's boundary (the widget owns the host's *subtree*; the host
  element and its position belong to the renderer), and hosts SHOULD
  NOT rely on it beyond this cleanup hardening.
- **Hook failure** — a throwing `mount` or `update` **poisons** the
  widget: sibling widgets and the frame still complete, the first
  error surfaces after the frame settles, and the NEXT render MUST
  replace it with a fresh lifecycle rather than keep patching it.
  Recovery MUST NOT depend on vnode reference identity: a producer
  that reuses the failed vnode (or a reference-equal ancestor — the
  JSLT memo does exactly this for unaffected subtrees) still recovers,
  so a conforming renderer suspends its `===` subtree fast path while
  any widget is poisoned. A poisoned widget never receives further
  `update` calls; `unmount` runs on the old instance only when its
  `mount` had succeeded (a mount that threw acquired nothing). A
  half-mounted handle receiving updates, or a widget left permanently
  inert by structural sharing, is non-conforming.

### 7.3.1 Renderer destroy

`createDomRenderer` returns a render function carrying a
**`destroy()`** member — the terminal teardown:

- every mounted widget in the rendered tree unmounts **exactly once**;
  widgets still queued for mount never mount;
- the container is left **empty** (`textContent = ''`);
- later `render` calls are exact no-ops (a scheduled flush racing a
  teardown cannot resurrect the DOM);
- `destroy()` is idempotent;
- a throwing widget `unmount` MUST NOT stop the teardown: the walk
  completes, then the first error surfaces — the same isolation rule
  as §7.3's destroy walk.

A host that merely wants a widget-free tree still renders a widget-free
frame; `destroy()` is for ending the renderer's life (`app.destroy()`
calls it). Thrown-value policy: the renderer never interprets what a
widget hook throws — the first thrown value of a frame or teardown
surfaces BY IDENTITY, whatever it is (`null` and `undefined`
included; parked failures are presence records, so no thrown value
can read as "nothing was thrown"). The `onFrame` option reports frame
settlement (`'live'` or `'destroyed'`) once per top-level render pass,
BEFORE a parked hook error is delivered — the channel a host uses to
run committed-frame work (the app loop's `afterRender`) without being
starved by error delivery. Dual-failure settlement: the parked hook
failure is copied and cleared BEFORE the frame callback runs, so a
throwing callback can neither hide it nor push it into a later frame;
the callback is isolated, and when both fail the parked hook failure
is primary — a host that must not lose its own callback failure
isolates that callback itself, exactly as `createApp` does. EVERY
failure of one frame stays observable regardless of how many walks or
hooks produced it: the first surfaces by identity, and from the second
on the frame delivers one framework-owned `AggregateError` over the
originals in occurrence order — separate sibling removals included; a
host-thrown value (an `AggregateError` of the host's own included) is
stored untouched as one element, never inspected. Capability
ACQUISITION is part of every widget boundary: reading `update`,
`unmount` or `ssr` off a definition executes host code when the
definition uses accessors or proxies, so the read shares the boundary
and policy of the call — a hostile `update` lookup poisons like a
throwing update, a hostile `unmount` lookup collects like a throwing
unmount (siblings unmount, the container empties), and a hostile `ssr`
lookup propagates from `renderToString` exactly like a throwing
`ssr()` (serialization is pure and offers no isolation). A `destroy()` entered from inside a widget
hook or nested render is still terminal: the active pass stops **immediately** — no
later sibling observes another `mount` or `update` in that frame, and
the no-`update` recycle fallback MUST NOT begin its fresh `mount` when
its `unmount` requested the destroy (the ended acquisition is recorded
so teardown does not unmount it a second time), and the fallback's
failure handling is PHASE-SENSITIVE: a failure before the old
instance's `unmount` had its exactly-once chance (a hostile `unmount`
lookup) leaves the old acquisition OWNED — the widget poisons with
update-failure semantics so replacement or terminal destroy still
releases the resource; only a failure after the teardown attempt takes
mount-failure semantics (nothing is left to release) — and the teardown runs
as the pass unwinds. Because teardown drains the renderer's live
resources rather than pairing a vnode against the DOM, it is exact
even when the aborted pass had structurally diverged from the
committed tree (insertions, removals, replacements or keyed moves
before or after the destroying widget): every successfully mounted
instance — a mount hook that itself requested the destroy included —
unmounts exactly once, pending mounts are canceled, the container ends
empty even when an unmount throws, and no internal traversal error is
ever produced. Terminal-cleanup errors carry provenance: a host may
register `onCleanupError` to receive the first unmount error after
every sibling cleaned up (the app loop uses this to assign its stable
cleanup code), instead of having it surface indistinguishably from a
render failure.

### 7.3.2 Render serialization

The public render boundary MUST NOT re-enter itself. A `render` call
made synchronously from inside a widget `mount`/`update` or an event
callback (an `emit` chain) queues behind the running patch instead of
nesting; multiple nested requests **coalesce to the latest vnode**
(every call carries the full desired tree, so intermediate trees are
redundant); the queued tree applies after the current frame, against
the committed baseline. Consequences a conforming renderer exhibits:

- no `update` is delivered before the widget's `mount` has returned
  its handle;
- every `update` receives the last committed props as its previous
  props, never a stale outer value;
- the app-integrated path (`createApp`'s FIFO transaction queue) and
  the direct renderer path observe the same ordering discipline: the
  app queue serializes *dispatches*, the renderer serializes *frames*.

### 7.4 Serialization

`renderToString(vnode, { widgets })`: a widget node serializes its
host element with the host props (widget-local members excluded),
containing the serialized `ssr(props)` vnode when the widget is
registered and has `ssr`, else empty content. Serialization stays pure
— no state, no DOM, no widget is mounted; the client-side first render
mounts widgets as usual (§6).

## 8. The safe profile

The default renderers **trust** their input (§1.1): every prop writes
through, so a producer that owns its stylesheet can reach `innerHTML`, an
`on*` handler or any DOM property, exactly as it could writing the DOM by
hand. A vnode from a source you do **not** control — a tenant, a remote
service, a model — is different, and schema validity does not close the
gap. A renderer therefore MUST offer a **safe mode** for untrusted
documents, selected by a `safe` option on both the patching and
serializing renderers.

Under the safe profile a renderer MUST:

1. **Restrict tags to an allow-list** of inert HTML and SVG elements, and
   MUST drop any element whose tag is not on it — including any tag whose
   name is not a bare identifier (`^[A-Za-z][A-Za-z0-9-]*$`), which closes
   structural injection through the tag. `script`, `iframe`, `object`,
   `embed`, `style`, `link`, `meta`, `base`, `foreignObject` and other
   document-embedding or script/style-carrying elements MUST NOT be on the
   allow-list.
2. **Reject a property whose name is not a bare identifier** (closing
   attribute-name injection), **whose name begins with `on`** (no inline
   handlers), **which is an HTML-parsing sink** (`innerHTML`, `outerHTML`,
   `srcdoc`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`), or **which is
   `is`** (it upgrades an element to a registered customized built-in when the
   markup is parsed, running host code).
3. **Sanitize URL attributes** (`href`, `src`, `action`, ...) through a
   deny-list that rejects `javascript:`, `vbscript:`, `file:` and
   document-carrying `data:`, and **drop inline styles** carrying
   `expression(` or a script-scheme `url()`.
4. **Strip `on` bindings and `jaren-widget` nodes**: an untrusted document
   MUST NOT bind host actions or mount imperative code. Safe-mode views are
   display-oriented.

A dropped element serializes to nothing and patches to an empty node; the
patching and serializing renderers MUST make the **same** decision for a
given node, so a document renders to the same safe result on the client
and the server. The reference implementation is one shared policy
(`createSafePolicy`) that both renderers call.

The companion schema
[`schemas/jaren-vnode-safe.schema.json`](../schemas/jaren-vnode-safe.schema.json)
expresses the structural half — the tag and property-name constraints —
as a validation-time gate. It cannot inspect a URL or style **value**, so
the runtime policy is authoritative; a host validating untrusted input
SHOULD do both.

Safe mode reduces an untrusted view to a display; it is **not a complete
sandbox**. The tag allow-list still admits anchors, forms, controls and media,
so native navigation, form submission, focus and network loads remain
possible. It is also a **renderer** policy: a host embedding it in a larger
runtime MUST NOT assume that runtime inherits it (`@jarenjs/app`, for
instance, does not forward `safe`, and an app document names host actions and
effects — so a safe *view* does not make an untrusted *app document* safe).

Out of scope for this version, and NOT to be assumed: caret/IME fidelity under
safe rewrites across browser engines, MathML, `multiple`-select and
composition behavior proven in all three engines, and a Trusted Types
integration. Safe mode is one layer under a Content-Security-Policy, not a
substitute for one.

## 9. Open items (roadmap, non-normative)

- **Fragment / multi-root documents** — a list at the root.
- **DOM-adopting hydration** (§6).
- ~~Memoized rule outputs~~ — **shipped**: the JSLT engine's `memo`
  option (on by default in `@jarenjs/app`) caches rule outputs by
  (location, value reference) with compile-time eligibility analysis,
  so unchanged *state* yields reference-equal *vnodes* across frames
  and §5.1 fires for whole branches.
- ~~Component escape hatch~~ — **shipped**: the registered-widget
  vocabulary of §7.
- ~~A renderer `destroy()`~~ — **shipped**: §7.3.1.
- **A `properties`-vs-`attributes` normative table** replacing the
  `name in node` heuristic of §3.
