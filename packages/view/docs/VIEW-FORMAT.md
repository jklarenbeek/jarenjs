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
grammar-valid vnode can still carry an `innerHTML` sink, an `on*` property
or a `javascript:` URL, so validation alone does not make an
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
   props?, ...children]`. The tag MUST be an **element name**: a
   letter, then letters, digits or hyphens (`^[A-Za-z][A-Za-z0-9-]*$`).
   Custom elements (`my-chart`) and SVG's camelCase tags
   (`linearGradient`) are element names; a custom element whose name
   uses `.`, `_` or a non-ASCII character is outside this grammar. If
   the second item is a plain object (not an array, not `null`) it is
   the **props**; otherwise it is the first child. The tag
   `"jaren-widget"` is reserved: it marks a widget node (§7).
4. **List** — any other array. Its items are spliced into the parent's
   children **in place**, recursively. A list at the root of a document
   is a producer error in 0.1 (renderers MAY reject it): the root MUST
   be a text or element vnode.

The props-detection rule (element item 2) means an element whose first
child is itself an object-shaped value cannot omit props: write
`["div", {}, child]`. Producers SHOULD always write the props object;
`h()` does.

A tag outside the element-name grammar is a producer error, and the
classic one is a list meant as text: `["Total:", 3]` and `[" ", ["b", {},
"x"]]` are elements by rule 3, not text followed by a node. Both trusted
renderers MUST refuse such a tag — the reference implementation throws a
`TypeError` whose message names the vnode's JSON Pointer in the
document it was handed — rather than writing `<Total:>` or `< >` into
markup or meeting the platform's own exception. A widget's host `tag`
(§7.1) is held to the same grammar. The safe profile drops the element
instead (§8), through the same predicate. A list that starts with
`null` splices text before an element: `[null, "Total:", 3]`.

A patching renderer meets such a refusal part-way through a frame, after
it wrote earlier siblings. The reference DOM renderer then tears its tree
down — every mounted widget unmounts, and the container empties — and
rethrows, so the next frame builds from its own vnode rather than from a
baseline the failed frame no longer matches. The throw carries every
failure of the failed frame: a widget hook failure parked before the
refusal, and an unmount failure of that teardown that no `onCleanupError`
takes, join the refusal in occurrence order under §7.3.1's rule — the
refusal alone surfaces by identity, two or more as one `AggregateError` —
and the next frame reports none of them. A hydrating renderer adopts
the server's markup on its first pass only; a tree rebuilt after a
failure is created.

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
  with `--` pass through. `null`/`false` members are dropped, and an
  object left with no declaration (`{}`) writes no `style` attribute in
  either renderer — a patching renderer removes the one a previous frame
  wrote.

Every other prop **writes through**:

- A patching renderer targeting the DOM SHOULD assign `node[name]` when
  the node has that property (form controls: `value`, `checked`, ...)
  and use attributes otherwise — the property table below names the
  values written as attributes even then; elements in a foreign
  namespace (§5.4) always use attributes.
- `true` renders as a bare attribute, `false` and `null` remove the
  attribute / clear the property.
- Prop names are used as-is: producers write `class`, not `className`.
- A prop named like a member every object inherits (`constructor`,
  `toString`, `valueOf`, `hasOwnProperty`) is an ordinary prop: both
  renderers write it as an attribute — never through the property, which
  would replace the node's own method — and remove it as one when a frame
  drops it. Upgrade note: the DOM renderer used to drop such a prop.

Four kinds of property are not left to the node's own property, and the
serializer and the patching renderer MUST write them identically — the
reference implementation keeps them in one **property table**
(`properties.js`) that both read:

- **Inline handlers.** A prop named like an HTML event handler content
  attribute (`onclick`, `onfocus`, `onpointerdown`, `onload`, ... — the
  GlobalEventHandlers, WindowEventHandlers and DocumentAndElementEventHandlers
  names of the HTML Standard, compared in any case, so `onClick` too) holds
  source text a browser compiles and runs. In trusted mode neither renderer
  writes a value there that is not a function: a string, a number, a list
  or `true` is omitted by the serializer and neither assigned nor set as an
  attribute by the patching renderer, and a patch to one clears whatever the
  frame before wrote for the prop (`null` and `false` already mean absent).
  A function value is a handler, and the patching renderer assigns it to the
  node's property as before. A name that merely begins with `on` (`online`,
  `once`, `onboarding`, `on-x`) is no handler and is an ordinary prop.
  Handlers are bound with `on` (§4), not with source text. Hydration removes
  an inline handler attribute that server markup carries for such a prop,
  then assigns a function handler. The safe profile (§8) strips every `on*`
  prop, whatever its name or value. Upgrade note: `renderToString` used to
  write these values as live attributes (`<button onclick="alert(1)">`) and
  the patching renderer, on a node with no such property or under a name
  like `onClick`, set them as one, so the markup of a document that carried
  one changes and its handler is gone (a document that needs one binds an
  action with `on`); the markup of a prop that only begins with `on` is
  unchanged.

- **Enumerated attributes.** HTML spells some on/off settings as
  enumerated attributes, and reflects `spellcheck`, `draggable`,
  `translate` and `autocorrect` through a *boolean* property: assigning
  the string `"false"` to it turns the setting on. These are written as
  attributes, always. A JSON `true` or `false`, or the strings `"true"`
  or `"false"`, become the attribute's own keyword; any other value is
  written as its string; `null` omits the attribute.

  | Attribute | `true` / `false` | HTML Standard |
  |---|---|---|
  | `contenteditable` (also `contentEditable`) | `true` / `false` | §6.8.1 |
  | `spellcheck` | `true` / `false` | §6.8.5 |
  | `writingsuggestions` (also `writingSuggestions`) | `true` / `false` | §6.8.6 |
  | `autocorrect` | `on` / `off` | §6.8.8 |
  | `translate` | `yes` / `no` | §3.2.6.3 |
  | `draggable` | `true` / `false` | §6.11.7 |

- **ARIA states.** An `aria-*` attribute given a JSON `true` or `false` is
  written as the keyword `"true"` or `"false"`: WAI-ARIA reads an empty
  value as "not set", so the HTML boolean form (`aria-selected=""`, or no
  attribute for `false`) said a selected cell was not selected. A string
  or number is written as its string and `null` omits the attribute, as
  before. Upgrade note: `false` now writes `="false"` where it used to
  remove the attribute, and `true` writes `="true"` where it wrote `=""`;
  a host that matches on the attribute's presence reads every such state
  as set.

- **Removal from a non-boolean property.** `null`, `false` or a removed
  prop on a property that is not boolean removes the attribute it
  reflects — never `node[name] = ''`, which throws for an input's
  `size`, writes `width="0"`, leaves a live `href=""` and makes a
  progress determinate. A property with no attribute of its name
  (`textContent`, `innerHTML`, `scrollTop`) is still cleared to `''`,
  and one that was never written is left alone. Boolean properties
  (`disabled`, `hidden`, `multiple`) are unchanged.

- **A value the property would convert.** `true` on a property that is
  not boolean is written as the empty attribute, and a string on a
  number-typed property as that string — the markup the serializer
  writes, which a hydrating renderer then keeps. Through the property,
  `download: true` names the file `true`, `title: true` shows `true`,
  `popover: true` is the `manual` popover where `popover=""` is `auto`,
  and `width: '100px'` writes `width="0"`. Numbers on reflected numeric
  properties also retain their attribute spelling: `size: 0` must not throw,
  and a negative or fractional width must not become an unsigned integer.
  Non-boolean values on boolean properties retain their attribute spelling
  too: `disabled: 0` and `disabled: ''` both produce a present attribute.
  Boolean properties are also updated against native dirty state (`selected`,
  `muted`); removing one clears both its property and attribute. Other numbers
  and strings on string properties are assigned. A string on a
  number-typed property that reflects no attribute (`scrollTop: '100'`)
  is therefore written as an attribute of that name, as the serializer
  writes it; a number reaches the property.

A **controlled form value** is authoritative. A patching renderer MUST
reassert `value`/`checked` on a form control against the control's
**live** DOM property, not against the previous vnode's value: a user
edit may have moved the live value since the last frame even when the
vnode value is unchanged, and the authoritative value MUST win. A
renderer SHOULD compare the live value first and write only on a genuine
difference, so an already-matching control is not rewritten (which
preserves the caret).

The authoritative state is what the serializer's markup says, so the live
control shows what server markup shows. An `input`'s `checked` is checked
when its attribute is present: any value but `null` and `false`
(`checked: 0`, `''` or `'false'` too), as `disabled: 0` is a present
attribute. An `input`'s `value` is its attribute's text: `true` is the
empty value and `false` writes none, so both are `''`. A `textarea`'s and
a `select`'s `value` is the text and the selection the serializer writes
(`String(value)`, `''` for `null`). Upgrade note: the patching renderer
used to check a box only for `checked: true` and to show `value: true` as
`"true"` and `value: false` as `"false"`; a document that wants the old
answer passes a boolean `checked` and a string `value`.

This reassertion MUST survive the sharing (§5.1) and `memo` (§5.5) fast
paths: a control inside a subtree those paths skip still holds
authoritative state, so a conforming renderer reconciles controls from
something other than the per-frame prop diff. The reference
implementation keeps a registry of controlled nodes and reconciles it
once per settled pass — which also lets a `select` resolve its value
after its options exist and a `multiple` select apply an array of
values. Trusted text controls defer authoritative writes through composition
and the final input event, then settle with a clamped caret range (§8).
Removal and destruction cancel pending settlement. Physical OS IME and
assistive-technology fidelity still require separate manual qualification.

The one exception a host can choose: `createDomRenderer(container, {
controlled: 'focus' })`. While a controlled text control is the document's
active element, its authoritative `value` write is **deferred** — the
operator's typing survives a background refresh — and reconciled when the
control loses focus, one task after `focusout` so a render the `change`
event scheduled lands first. It is the composition deferral above with a
second cause, not a second mechanism. Without the option, the
authoritative value always wins.

A text control is a `textarea`, or an `input` whose `type`, read at
reconcile time, is one the operator types into: `text` (or none),
`search`, `url`, `tel`, `email`, `password` or `number`. A focused range,
colour, date or radio input takes the state's value at once, so an
app-side clamp or a remote update shows while the operator holds the
control. `checked` and a `select`'s value are not deferred.

## 4. Events are data

The value of an `on` member is an opaque JSON **binding**. The view
layer MUST deliver the binding verbatim to the environment's event hook
(`onEvent(binding, nativeEvent)`) and MUST NOT interpret it. (The
interactive profile, §8.1, checks that it IS data and delivers a data
projection of the event instead of the native one.) What a
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
namespace. Children of an SVG `foreignObject`, `desc` or `title` re-enter
the HTML namespace, where an HTML parser reads the serializer's markup as
HTML (§6); a nested `svg` enters SVG again. Inside an `svg` a tag is built
in the case it is written, where an HTML parser reads the serializer's
markup in its own case (lower case, and the SVG names it knows, such as
`clipPath` and `linearGradient`, in their SVG case): write SVG names in
their SVG case, and `svg` in lower case, which alone switches the namespace.
A `Circle` there is built as an element that draws nothing, while a parser
reads `<Circle>` as a `circle`; outside an `svg`, `SVG` is built as an HTML
element, while a parser reads `<SVG>` as an `svg`. The safe profiles drop
both (§8: their allow-list matches a tag exactly). A widget host (§7) whose
`tag` is `svg` is built in the SVG namespace too. `xlink:*` and `xml:*` attributes use their
namespace URIs for setting and removal. Safe mode excludes `foreignObject`.
Upgrade note: a widget host on `svg` outside an `svg` used to be built in the
HTML namespace, where it draws nothing; the children of an SVG `desc` or
`title` used to be built as SVG elements, where a parser builds HTML ones from
the same document's markup (so hydration rebuilt them).

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

### 5.6 A form's controls and a document's named elements

A `form` answers a member looked up on it through its controls' names and
ids before its own: `<input name="insertBefore">` is the form's
`insertBefore`, `<input id="childNodes">` its `childNodes`, and a write to a
name only a control holds throws. A DOM renderer therefore MUST NOT reach a
form's children, attributes or listeners through the element. The reference
renderer reaches them, and the parent of any node it walks up from, through the `Node`, `Element` and `EventTarget` prototypes of the
document's `defaultView`, or, in a document without one (as
`createHTMLDocument` and `DOMParser` make), of the container's own prototype
chain. A form whose controls are named or id'd after any DOM member thus
mounts, patches, moves, hydrates and binds as the serializer writes it, in
every mode. A prop the form has no property of, named like one of its
controls (`['form', { foo: 'a' }, ['input', { name: 'foo' }]]`), is written as
the form's attribute. No other element answers a member through named
properties, and those are asked directly. The renderer keeps its own
bookkeeping on a node (an element's `on` bindings, a widget host's lifecycle,
a controlled control's state) under symbols, which no name or id can be, so a
control named `__jarenOn` or `__jarenWidget` is a control like any other.

`document` answers the `name` of its `img`, `form`, `embed`, `object` and
`iframe` elements, and the id of an `img` or `object`, over its own members
the same way: `<img name="createElement">` is `document.createElement`. The
reference renderer and the dialog helper make each node with the document's
own `createElement`, `createElementNS` or `createTextNode`; only where that
call throws because a named element holds the creator's name (a named
property is never a function) do they make it through the creator of the
`Document` interface on the document's own prototype chain, captured when
the renderer or dialog is created. Their other document members
(`getElementById`, `querySelectorAll`, `activeElement`, and the helper's
`body` and `defaultView`) are always read through that interface, so a patch
set on the `document` object itself for one of them, or on
`Document.prototype` after the renderer or dialog was created, is not called;
a patch of a creator is. A trusted document naming an element after any of
these members thus renders, reports and keeps a focused edit as under any
other name. A safe root namespaces such names (§8), so only a trusted
document can take a member over. A document whose chain has no `Document`
interface (a DOM double) is asked directly.

## 6. Serialization

`renderToString(vnode)` MUST produce markup equivalent to what a
patching renderer would build: text and attribute values escaped (`&`,
`<`, `>` in text; `&`, `"` in double-quoted attributes), void elements
(`br`, `img`, `input`, ..., the tag in any case) without end
tags, `key` and `on` producing
no output, boolean and style props serialized per §3, and an inline handler
value (`onclick: 'alert(1)'`) omitted as §3's property table says.
Serialization is pure: no state, no DOM, safe in any runtime.

Inside an `svg`, where an HTML parser reads foreign content, no element is
void: an `input`, `area`, `base`, `col`, `link`, `param`, `source`, `track`
or `wbr` is written with its end tag, which closes it as `</circle>` closes a
`circle`, so its next sibling is not read as its child. The elements whose
start tag ends the `svg` for a parser have no such markup: `b`, `big`,
`blockquote`, `body`, `br`, `center`, `code`, `dd`, `div`, `dl`, `dt`, `em`,
`embed`, `h1`–`h6`, `head`, `hr`, `i`, `img`, `li`, `listing`, `menu`,
`meta`, `nobr`, `ol`, `p`, `pre`, `ruby`, `s`, `small`, `span`, `strong`,
`strike`, `sub`, `sup`, `table`, `tt`, `u`, `ul` and `var`, in any case, and
a `font` that writes a `color`, `face` or `size` attribute (in any case). A
parser reads such an element, and every later sibling, outside the `svg`,
where the patching renderer builds them inside. The serializer refuses one
with a `TypeError` naming where it sits (the patching renderer builds it, as
for raw text it cannot carry), and both renderers drop one under a safe
profile (§8 rule 1). Under an SVG `desc`, `title` or `foreignObject` a parser
reads HTML again, so these rules do not apply there: an HTML void element is
written without an end tag, as outside `svg`. Upgrade note: inside an `svg`
these elements used to be written as HTML void elements, which a parser read
with the next sibling inside the `input`, or with the rest of the drawing
outside the `svg`, and the HTML elements of that list (`div`, `p`, `span`,
...) were written as they are, with the same effect.

The text of an HTML `style` or `script` element (its tag in any case) is
raw text, which an HTML parser never decodes, so it is written verbatim —
the characters the DOM renderer puts in its text node. Text that raw text
cannot carry — the element's own end tag as a parser recognizes one
(`</style` or `</script`, in any case, followed by whitespace, `/` or
`>`), or `<!--` in a script — is refused with a `TypeError` naming where
the element sits; it used to be escaped, which shipped `&gt;` and `&amp;`
to the browser as CSS or script source. Inside `svg` (back in HTML under
`foreignObject`, `desc` and `title`), where a parser reads `style` and
`script` as foreign elements and decodes their text, it stays escaped.
Upgrade note: under an SVG `desc` or `title` their text used to be escaped
too, where a parser reads raw text there.

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
The interactive profile serializes a `textarea`'s and a `select`'s `value`
in this form too (§8.1); `safe: true` keeps it an attribute (§8). Neither
renderer writes the live selection, or a textarea's live value, as markup,
so the DOM renderer's markup of a controlled `select` (and of a `textarea`
whose children are not its value) differs from the serializer's even where
both show the same value.

Both renderers accept a single vnode, a root list, or an empty/skipped root.
Lists flatten with the ordinary child rules and need no wrapper element.

`createDomRenderer(container, { hydrate: true })` adopts matching text and
element nodes on its first trusted render, patches props and handlers,
reconciles controlled values, repairs mismatches locally and removes surplus
nodes and attributes, including the inline handler attribute older server
markup wrote for a handler value (§3). Initial matching is positional by tag and namespace;
subsequent keyed patches preserve adopted identities. Widgets mount once on
fresh hosts because their server-side markup has no transferable handle.
Without `hydrate`, the first render rebuilds. Safe mode also rebuilds: existing
DOM does not inherit trust from a sanitized vnode. Hydration does not remove
listeners installed by another owner, so the host must own the adopted DOM.

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
  to the **host element** exactly as on any element vnode (§3, §4), with
  one exception: a host `input`, `textarea` or `select` is not a
  controlled control (the widget owns its live value), so its `value` and
  `checked` are written as the attributes the serializer writes, in every
  mode. Upgrade note: the patching renderer used to write neither.
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
  mount(host, props, emit, context), // REQUIRED → returns a handle
  update(handle, props, prevProps),  // OPTIONAL
  unmount(handle),                   // OPTIONAL cleanup
  ssr(props),                        // OPTIONAL → a vnode for serialization
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
- **`context`** — the fourth argument `mount` receives: a frozen `{
  widgets, document, controlled? }`, the renderer's own registry and
  document — and `controlled: 'focus'` when the renderer was created
  with it (§3) — one object per renderer. A widget that renders vnodes
  of its own (a dialog's content, §7.5) renders them with the registry
  it was mounted from and under the same controlled mode, so a nested
  widget needs no second registration and a field in a dialog keeps the
  operator's text as one in the page does. The argument is additive: a
  `mount` that takes three still works.

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
registered and has `ssr`, else empty content. A host on an HTML void
element (`tag: 'input'`, `'br'`, `'img'`, ..., in any case, outside `svg`
or under its `desc`, `title` or `foreignObject`) is written without an end
tag and without a fallback, and `ssr` is not read: a parser would read the fallback as the host's next siblings, and
`</br>` as a second `<br>`, where the DOM renderer builds one empty host.
Upgrade note: such a host used to be written with an end tag and its
fallback inside it. Inside an `svg` a host is not void, and one whose start
tag ends the `svg` (`br`, `div`, `span`, `font` with a `color`, ..., §6) is
refused or dropped as such an element is. Serialization stays pure
— no state, no DOM, no widget is mounted; the client-side first render
mounts widgets as usual (§6).

### 7.5 Native modal dialog owner

`createDialog(host, props, options?)` from
`@jarenjs/view/helpers/dialog` returns `{ update(props), dispose() }`.
It owns one native `<dialog>` and one nested vnode renderer inside a
connected, empty host; it never reparents that host. A native
`showModal()`/`close()` implementation is required. The browser's top
layer owns nesting and background inertness; no global focus manager
or background attribute rewrite is installed.

Required props are `id` (unique DOM id without whitespace), `title`
(nonempty visible text) and boolean `open`. Optional props:

| Prop | Behavior |
|---|---|
| `content` | Ordinary vnode JSON, reconciled while open. Closing disposes its nested widgets; reopening mounts fresh content. |
| `initialFocusRef` | Exact `data-ref` inside the dialog. If unavailable, the first eligible control or visible title provides focus. |
| `fallbackFocusRef` | Exact `data-ref` in the owner document, used when the saved opener is disconnected or cannot receive focus. |
| `closeLabel` | Visible close button text; default `Close`. Hosts supply localized text. |

The title receives `id + '-title'` and is associated through
`aria-labelledby`. The native dialog also carries `role=dialog` and
`aria-modal=true`. Text props are limited to 1024 code units; ids must
be unique across the owner document, including the derived title id.
Style the `jaren-dialog` class and its `::backdrop` in the host's CSS.
The native backdrop remains in use when no custom style is supplied.

Options are `onClose(reason, event)`, `onEvent(binding, event)` for
content bindings, and a `widgets` registry for nested content. Close
reasons are `escape`, `button` or `native` (for example a form with
`method=dialog`). Escape/close-button interactions request closure;
the host commits it with `update({ ...props, open:false })`. Native
form closure is reported after the browser closes the dialog. Owned
programmatic close events do not emit another request.

Keyboard qualification covers ordinary light-DOM controls with
nonpositive `tabindex`. Tab boundaries are recomputed on every key
press and hidden, disabled or inert controls are excluded. Native
modal isolation prevents a background dialog from taking focus.
Dynamic removal of the focused control restores initial/fallback
focus inside the active dialog. On close, the saved opener receives
focus when possible; otherwise the supplied fallback does. Without
a usable fallback, native browser focus settlement remains visible.
The helper does not cross shadow roots or iframe documents to search
for a `data-ref`. `findByRef(root, token)` is separately public at
`@jarenjs/view/helpers/focus` and is shared with app focus intents; it reads
the tree through the DOM's own accessors (§5.6), so a ref inside a form
whose controls are named `childNodes` or `getAttribute` is found.

`dispose()` is idempotent, closes the native modal, restores focus,
destroys nested owners and removes listeners/DOM even when a nested
cleanup throws. Repeated updates do not add listeners. Invalid
properties, duplicate ids or a nonempty/disconnected host throw
`ViewHostError` `JV1001`; missing native modal execution throws
`JV1002`. Both use core's shared `CodedError` family. A failed initial
mount removes every resource it acquired. The helper accepts trusted
host composition; render untrusted display documents with §8's safe
profile instead of granting them a modal widget.

Behavior follows the [W3C APG modal pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
and the [HTML dialog primitive](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element).
The browser matrix verifies keyboard/focus behavior separately from
physical screen-reader and assistive-technology testing.

## 8. The safe profile

The default renderers **trust** their input (§1.1): every prop writes
through (but for an inline handler value, §3), so a producer that owns its
stylesheet can reach `innerHTML` or any DOM property, exactly as it could
writing the DOM by hand. A vnode from a source you do **not** control — a tenant, a remote
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
   allow-list. Inside an `svg`, where an HTML parser reads foreign content
   (not under its `desc` or `title`), an element whose start tag ends the
   `svg` for a parser (`br`, `div`, `p`, `span`, `table`, ..., §6) is
   dropped too: no markup builds it where the patching renderer would, and
   the one place an `svg` shows HTML, `foreignObject`, is excluded from the
   profiles. Upgrade note: the patching renderer used to build one there
   as an inert SVG element, and the serializer wrote the allow-listed HTML
   ones (`div`, `p`, `span`, `b`, `table`, ...) as they are.
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
4. **Drop a prop value that is not a scalar**: a string, a number, a
   boolean or `null`, as the safe schema says. A list or an object would be
   written as its text, which neither the URL nor the style check reads (a
   list holding a `javascript:` URL), or cannot be made at all (an object whose
   `toString` is not a function). The one list is a `multiple` select's
   `value`, and the one object is `style`, whose own values are held to the
   same rule. Upgrade note: such a value was written as its text; it is now
   dropped and reported as an unsafe prop.
5. **Strip `on` bindings and `jaren-widget` nodes**: an untrusted document
   MUST NOT bind host actions or mount imperative code. Safe-mode views are
   display-oriented.
6. **Keep every form submission inside the document.** A `form`'s `action`,
   `method`, `target` and `enctype`, and a submitter's `formaction`,
   `formmethod`, `formtarget`, `formenctype` and `formnovalidate` (on any
   element), are dropped and reported, and every `form` is written with
   `method="dialog"` before its props: a submission sends nothing anywhere
   (outside a `dialog` it is a no-op; inside one it closes that dialog),
   while its `submit` event still fires. Upgrade note: a safe form used to keep
   a sanitized `action` and its `method`; it now submits nowhere.
7. **Namespace every id.** Every id the document declares, and every id
   reference it makes, is prefixed with the render's `idPrefix` (default
   `jaren-u-`; a host-supplied letter followed by letters, digits, `_` or
   `-`): `id`; the single references `for` (and `htmlFor`), `form`, `list`,
   `popovertarget`, `commandfor`, `interestfor`, `anchor`, `contextmenu`,
   `aria-activedescendant`; the reference lists `headers`, `itemref`,
   `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`,
   `aria-details`, `aria-errormessage`, `aria-flowto`; a `#fragment` `href`
   and `usemap`; `url(#…)` in the SVG `fill`, `stroke`, `clip-path`, `mask`,
   `marker-*` and `filter` attributes and in an inline `style`. `name` is
   prefixed on `form`, `img`, `embed`, `object` and `iframe`, the elements
   whose name becomes a property of `document` (and `window`). References
   inside the document therefore still resolve, and none can reach — or a
   declared id or name shadow — an element or property of the host's page.
   Both renderers apply the same prefix, so markup serialized with a prefix
   hydrates under the same prefix. A render that names no prefix takes a
   default: the serializer always writes `jaren-u-`; a DOM root takes the
   first of `jaren-u-`, `jaren-u2-`, `jaren-u3-`, … that no other live safe
   root of its document holds (a given prefix occupies its namespace too, and
   is never changed or refused), keeps it across frames and for a new
   renderer on the same container, and frees it on `destroy()` (a root whose
   container is out of the page, `isConnected` false, loses it when another
   root claims one). No default is a prefix of another, so two untrusted
   documents rendered into one page by one copy of the renderer never share
   a namespace; roots built off the page and attached later, or rendered by
   two separately bundled copies, are kept apart only by prefixes the host
   gives. A page's first untrusted document therefore
   serializes and renders alike; a host serializing several gives each its
   own prefix, the same one its DOM root is given, and uses no id of its own
   that starts with a prefix. A DOM root reports, through `onUnsafe` and once
   per id, a prefixed id it writes that the page already holds outside the
   root (`{ kind: 'id', name: 'jaren-u-name' }` for a host element beside a
   document declaring `name`, or a second root given the same prefix): both
   elements keep the id, nothing is refused, and references resolve to the one
   the page holds first. The content a granted widget renders in its root's
   namespace (a dialog's) counts as the root's own, as a duplicate inside one
   root does. It is looked up, by `getElementById`, as the id is written: an
   element the host adds later is not seen. A DOM root reports alike
   (`{ kind: 'name', name: 'jaren-u-logo' }`, once per name) a prefixed name
   of `document` it writes that an HTML element outside the root already
   holds, so that `document[name]` answers both. A name of `document` is the
   non-empty `name` of a `form`, `img`, `embed`, `object` or `iframe`, the
   non-empty id of an `object`, and the non-empty id of an `img` that has a
   non-empty `name` as well; any other element's id is none. So a page
   `object` whose id is the name the root writes is reported, as is a page
   name equal to the id of a named `img` of the root; an id the page holds as
   an id is the id report's alone. An `object` is looked for whatever it
   holds: Chromium and WebKit leave one showing an `object` or `embed` as its
   fallback off `document`, Firefox does not. The names a pass writes are
   looked up in one scan of the page as it ends, and an element the host adds
   later is not seen either (upgrade note: the `name` report used to compare
   the root's names with the page's names only). Upgrade note: a safe document's ids, id
   references and those names used to be written as given; a second live
   root on a page used to share `jaren-u-` with the first (pass
   `idPrefix: 'jaren-u-'` to keep that).

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
sandbox**. The tag allow-list still admits anchors, controls and media, so
native navigation, focus and network loads remain possible (a form submits
nowhere, rule 6). It is also a **renderer** policy. `@jarenjs/app` forwards `safe`
and `onUnsafe` and provides explicit effect/subscription/widget/event-field
grants (APP-FORMAT §8.2.1). Those grants bound named host access; they do not
isolate computation, navigation or network activity.

The browser suite exercises safe create→update→remove→reinsert, URL/style
reflection, controlled inputs, multiple selects and composition in Chromium,
Firefox and WebKit. Trusted controlled text writes defer through composition
and the final input event, then settle while retaining a clamped caret range.
Composition cleanup cancels pending settlement on removal or destruction.
Under `safe: true` controls retain the attribute-only display policy rather than
the trusted controlled-input policy; the interactive profile controls an `input`,
a `textarea` and a `select` (§8.1).

Native OS IME fidelity and assistive-technology behavior still require manual
audits. MathML and Trusted Types integration remain outside this version.
Safe mode is one layer under a Content-Security-Policy, not a substitute for one.

### 8.1 The interactive profile

A host that must render an untrusted *interactive* document without a
sandboxed frame selects `safe: 'interactive'` on either renderer. It is the
safe profile — rules 1–4, 6 and 7 above are the **same decisions**, made by the same
policy object, with the same results and the same reports — except for rule 5,
where it keeps three things:

1. **Data-only `on` bindings on gesture events.** A binding is kept when its
   event type is one of `click`, `dblclick`, `mousedown`, `mouseup`,
   `pointerdown`, `pointerup`, `keydown`, `keyup`, `input`, `change`,
   `submit`, `reset`, `blur` or `focusout` (matched exactly: event types are
   case-sensitive), and its value is JSON data: a string, a finite number, a
   boolean, `null`, or a plain list or object of those, at most 64 levels
   deep and 65536 values in all. A function, a getter (never run), a
   symbol-keyed member, an object with a prototype of its own (a class
   instance, a `Date`, a `Map`), a hole or an extra member on a list,
   `undefined` and a non-finite number are not data. An `on` member that is
   not a plain object binds nothing. Every other type and every other value
   is dropped and reported as `{ kind: 'event', name: <type> }` (`'on'` for
   the member itself). The types left out fire without a deliberate gesture
   — `load` and `error`, `toggle` on an open `details`, CSS animation and
   transition events, the `focus`/`focusin` that `autofocus` fires, hover and
   pointer movement, `wheel` and `scroll` — or carry a host object as their
   payload (`paste`, `drop`).
2. **The widgets the host granted.** `capabilities: { widgets: [name, ...] }`
   names the registered widgets a document may render (absent: none; a name
   not registered in `widgets` is a `TypeError`). A granted widget renders
   only with props that are data (as above), no vnode children, and a host
   `tag` the tag allow-list admits; otherwise it is dropped and reported
   (`widget`, or `tag` for the host tag), on every frame, without throwing.
   Its host-element props pass rules 2–4, 6 and 7, its `ssr` fallback is serialized
   under the profile, and the bindings it `emit`s are held to the data rule
   (an `emit` that fails it is reported as `{ kind: 'event', name: 'emit' }`).
   The fourth `mount` argument carries `safe: 'interactive'`, the granted
   `capabilities`, `idPrefix` and `onUnsafe`, and holds only the granted
   widgets in `widgets`, so a widget that renders vnode content of its own
   (§7.5's dialog does, and so do the studio's document widgets) renders it
   under the same profile, grants and id namespace — a widget does that by
   spreading the context into its renderer's options when `context.safe` is
   set. The dialog's own `id` joins the namespace too.
3. **Controlled form controls.** An `input`'s own `value` and `checked`
   are written as their attributes, exactly as under `safe: true` (the
   markup and the serializer's output do not change), and are then
   authoritative (§3): the DOM renderer reasserts the live value to what the
   attribute says at the end of every pass — the attribute's text for
   `value` (`''` when it is absent or empty), its presence for `checked` —
   so app state resets a field the user edited, through composition, the
   caret and `controlled: 'focus'` as in trusted mode (one difference: the
   attribute is still written, so a field the user has not edited yet shows
   a new value at once, even focused). The document writes only the value it
   owns; what a user typed reaches it only through the event projection
   below, and a password field's value never does — so a controlled password
   field can only be cleared, and a document leaves `value` off one. A
   `file` input's value is never assigned (a script cannot choose a file,
   and the assignment throws), whatever its `type` was on an earlier frame.
   A `Value` spelling, an inherited member and a granted widget's host
   element stay attribute-only. A `textarea`'s and a `select`'s `value`
   (an inherited one too, as trusted mode reads it) is controlled in the
   trusted form, of the value rule 4 keeps: the serializer writes a
   textarea's text and `selected` on the matching options (§6), the DOM
   renderer writes no `value` attribute (a parser ignores one) and
   reasserts the live value and selection, a textarea through composition
   and `controlled: 'focus'` as above. A stripped value (an object) is
   reported and reads `''`. The DOM renderer's markup of a controlled
   `select` is not the serializer's (§6).

**What the handler receives.** Under the profile a `submit` event's default is prevented before the
binding is delivered, so a submission reaches the app only as data. `onEvent(binding, event)`
receives, in place of the native event, a frozen object with no prototype
holding the event's `type`, its keyboard, modifier, button and pointer fields
(`key`, `code`, `repeat`, `location`, `isComposing`, `shiftKey`, `ctrlKey`,
`altKey`, `metaKey`, `button`, `buttons`, `detail`, `clientX`/`Y`,
`offsetX`/`Y`, `pageX`/`Y`, `movementX`/`Y`, `pointerId`, `pointerType`,
`pressure`, `isPrimary`; a member that is not a string, finite number or
boolean reads `null`), a frozen `target` slice (`value`, `checked`,
`selectionStart`, `selectionEnd`), and `preventDefault()` and
`stopPropagation()`, which act on the native event. No node, window or event
object is reachable from it. What a user typed — `key`, `code` and the whole
`target` slice — reads `null` when the target is a password field, and when
the event rose from inside a widget's subtree, which is the host's DOM, not
the document's. A binding is delivered verbatim and never evaluated.

**What it keeps from the safe profile.** Hydration still rebuilds the
server's markup, and the serializer writes no trace of a binding. Under `safe: true`, or any other truthy value, nothing changes: every
binding and widget is stripped, and `capabilities` is not read.

| | trusted | `safe: true` | `safe: 'interactive'` |
|---|---|---|---|
| tags | any element name | inert allow-list | inert allow-list |
| prop names | any | bare identifiers; no `on*`, HTML sinks or `is` | the same |
| URL attributes | as written | `sanitizeUrl` deny-list | the same |
| inline `style` | as written | CSS vectors dropped | the same |
| prop values | any | scalars (a select's `value` list, `style` object) | the same |
| `on` bindings | any, verbatim | stripped | data only, gesture events only |
| `onEvent`'s event | the native event | (never called) | a frozen data projection |
| widgets | any registered | stripped | granted by name, data props, allowed host tag |
| forms | as written | `method="dialog"`, no destination | the same; a `submit`'s default is always prevented |
| ids and id references | as written | in the render's `idPrefix` namespace | the same, shared with granted widgets' content |
| controlled inputs | property writes | attributes only | an `input`'s attributes, reasserted as its live `value`/`checked` (not `file`); a `textarea`'s and a `select`'s `value` in the trusted form, reasserted |

**What it does not defend.** It narrows what a document can do inside the
host's page; it does not move the document out of it. Rule 3 denies script and
document schemes, not origins, so a document can still load
`https://elsewhere/?…` through an image, a link, a form or a style — and an
interactive document can put what a user types into such a URL without a
submit: a URL attribute is checked for its scheme only, whatever the
document wrote into it. It can still overlay and imitate the host's
interface, and a binding may stop an event from bubbling out of the
document's elements (listeners in the capture phase still see it). The
browser may still fill the host origin's saved credentials into a document's
form; a handler never sees a password field's value and the form submits
nowhere (rule 6), but a username field's value is ordinary input.
A granted widget is host code fed untrusted props: it must treat them as
untrusted. **A sandboxed frame on an opaque origin remains the stronger
isolation**; use the profile where a frame is not possible, under a
Content-Security-Policy that restricts `img-src`, `form-action`,
`connect-src` and `style-src`.

## 9. Open items (roadmap, non-normative)

- ~~Memoized rule outputs~~ — **shipped**: the JSLT engine's `memo`
  option (on by default in `@jarenjs/app`) caches rule outputs by
  (location, value reference) with compile-time eligibility analysis,
  so unchanged *state* yields reference-equal *vnodes* across frames
  and §5.1 fires for whole branches.
- ~~Component escape hatch~~ — **shipped**: the registered-widget
  vocabulary of §7.
- ~~A renderer `destroy()`~~ — **shipped**: §7.3.1.
- ~~A `properties`-vs-`attributes` normative table~~ — **shipped**: §3's
  property table decides the two kinds where the `name in node`
  heuristic wrote the wrong thing — enumerated attributes, and removal
  from a non-boolean property — and both renderers read it.
