# @jarenjs/view

User interfaces as JSON documents. This package defines the **Jaren vnode format** — the output vocabulary a view produces the way XSLT produces HTML — and ships the two renderers that consume it:

- a **keyed DOM patcher** (`createDomRenderer`): diff the previous vnode against the next, touch only what changed, reuse keyed nodes across reorders;
- an **SSR string renderer** (`renderToString`): the same JSON to an HTML string, no DOM required.

It is the only package in the Jaren suite that touches the DOM, and it knows nothing about schemas, queries or state — a vnode is plain JSON, wherever it came from. In practice it comes from a [JSLT stylesheet](../json/docs/JSLT-FORMAT.md) compiled by [`@jarenjs/json`](../json), and the loop around it lives in [`@jarenjs/app`](../app). Zero dependencies, no `eval`, CSP-safe.

The vnode grammar is published as JSON Schema in [`schemas/jaren-vnode.schema.json`](schemas/jaren-vnode.schema.json) — hand it to a constrained decoder and a language model cannot emit an invalid interface. The normative contract is [docs/VIEW-FORMAT.md](docs/VIEW-FORMAT.md).

## The format in one glance

```json
["main", {},
  ["h1", { "class": "title" }, "Todos"],
  ["ul", {},
    [["li", { "key": 1, "on": { "click": { "action": "toggle", "with": 1 } } }, "Buy milk"],
     ["li", { "key": 2 }, "Ship it"]]
  ],
  ["input", { "value": "", "on": { "input": "type" } }]
]
```

- **text** — a string or number renders as text;
- **element** — an array whose first item is a string tag: `[tag, props?, ...children]`;
- **list** — an array whose first item is *not* a string is spliced into its parent's children (exactly the shape a JSLT `[{"$apply": "$.todos[*]"}]` body produces);
- **skipped** — `null` and booleans render nothing, so `{"$if": ...}` conditions compose without wrapper nodes.

Three props are special: `key` (reconciliation identity), `on` (event bindings — opaque JSON handed to the renderer's `onEvent` hook, never functions), and `style` (string or object). Everything else writes through to the DOM as a property when the node has one, as an attribute otherwise; `true` renders a bare attribute, `false`/`null` remove it.

## Usage

### In the browser

```javascript
import { createDomRenderer } from '@jarenjs/view';

const render = createDomRenderer(document.getElementById('app'), {
  onEvent: (binding, event) => {
    // `binding` is the vnode's `on` JSON, verbatim — dispatch it yourself,
    // or let @jarenjs/app do this wiring for you
  },
});

render(['h1', {}, 'Hello']);
render(['h1', {}, 'Goodbye']);   // patches the text node in place
```

### On the server

```javascript
import { renderToString } from '@jarenjs/view';

renderToString(['p', { class: 'note' }, 'a < b'])
// '<p class="note">a &lt; b</p>'
```

Text and attribute values are escaped, void elements render without end tags, `key` and `on` produce no markup. Hydration is a client-side first render into the same container (the container is emptied and rebuilt — DOM adoption is on the roadmap).

### With JavaScript in the middle

`h(tag, props, ...children)` builds the same JSON a stylesheet would, for hand-written views and tests. The shape helpers (`isTextNode`, `isElementNode`, `propsOf`, `keyOf`, `childrenOf`, `isSameNode`) are exported for anyone building another renderer over the format.

## Performance contract

The patcher's first check is `oldVnode === newVnode` — a reference-equal subtree is skipped in O(1), unexamined. This is designed to meet the JSLT engine's structural sharing (an unchanged input subtree flows to the output by reference), so views that share unchanged branches re-render in time proportional to what changed, not to the size of the page. Vnodes are never mutated or annotated by the renderer: frozen documents, cached documents and shared subtrees are always safe.

Children reconcile with a head/tail sweep plus a key map for the middle: keyed siblings move their real DOM nodes instead of recreating them; unkeyed siblings patch positionally. Event bindings are data stored on the node behind one shared proxy listener per event type — re-rendering rebinds by assignment, never through `addEventListener`.

## Development

Unit tests live in `test/view/` at the repository root (`npm run test:view`), including the minimal DOM stub they run against. See the repository [README](../../README.md) for the full suite documentation and [ROADMAP](../../ROADMAP.md) for planned work: fragment roots, DOM-adopting hydration, and the memoized rule-output layer that turns JSLT sharing into cross-frame skipping.
