# @jarenjs/view

User interfaces as JSON documents. This package defines the **Jaren vnode format** — the output vocabulary a view produces the way XSLT produces HTML — and ships the two renderers that consume it:

- a **keyed DOM patcher** (`createDomRenderer`): diff the previous vnode against the next, touch only what changed, reuse keyed nodes across reorders;
- an **SSR string renderer** (`renderToString`): the same JSON to an HTML string, no DOM required.

It is the only package in the Jaren suite that touches the DOM, and it knows nothing about schemas, queries or state — a vnode is plain JSON, wherever it came from. In practice it comes from a [JSLT stylesheet](../json/docs/JSLT-FORMAT.md) compiled by [`@jarenjs/json`](../json), and the loop around it lives in [`@jarenjs/app`](../app). Its only runtime dependency is the pure, zero-dependency [`@jarenjs/core`](../core); no `eval`, CSP-safe.

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

Four props are special: `key` (reconciliation identity), `on` (event bindings — opaque JSON handed to the renderer's `onEvent` hook, never functions), `memo` (a subtree-stability marker — see the performance contract), and `style` (string or object). Everything else writes through to the DOM as a property when the node has one, as an attribute otherwise; `true` renders a bare attribute, `false`/`null` remove it.

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
render.destroy();                // terminal teardown, idempotent
```

`render.destroy()` unmounts every mounted widget exactly once (pending mounts are canceled), empties the container, and turns every later `render` call into an exact no-op — including a scheduled flush that fires after destruction. The render boundary is **serialized**: a `render` entered synchronously from inside a widget hook or event callback (an `emit` chain) never nests — it queues behind the running patch, multiple nested requests coalesce to the latest vnode, and the queued tree is applied against the committed baseline, so no widget sees `update` before its `mount` returned or receives stale previous props.

### On the server

```javascript
import { renderToString } from '@jarenjs/view';

renderToString(['p', { class: 'note' }, 'a < b'])
// '<p class="note">a &lt; b</p>'
```

Text and attribute values are escaped, void elements render without end tags, `key` and `on` produce no markup. Hydration is a client-side first render into the same container (the container is emptied and rebuilt — DOM adoption is on the roadmap).

### With JavaScript in the middle

`h(tag, props, ...children)` builds the same JSON a stylesheet would, for hand-written views and tests. The shape helpers (`isTextNode`, `isElementNode`, `propsOf`, `keyOf`, `childrenOf`, `isSameNode`) are exported for anyone building another renderer over the format.

### Widgets — the imperative escape hatch

Some islands are irreducibly imperative: a virtualized grid, a canvas, a map, a third-party control. The reserved tag `jaren-widget` mounts a **registered widget** into a host element the patcher owns but never descends into ([VIEW-FORMAT §7](docs/VIEW-FORMAT.md)):

```json
["jaren-widget", {
  "name": "virtual-list", "key": "list", "class": "viewport",
  "props": { "rows": "$.rows", "rowHeight": 28 }
}]
```

```javascript
const render = createDomRenderer(container, {
  onEvent: (binding, event) => dispatch(binding, event),
  widgets: {
    'virtual-list': {
      mount(host, props, emit) { /* build DOM, measure, listen */ return state; },
      update(handle, props, prevProps) { /* re-window the visible rows */ },
      unmount(handle) { /* timers, listeners and observers die here */ },
      ssr: (props) => ['ul', { class: 'list' }],   // declarative fallback
    },
  },
});
```

`name`/`props`/`tag` configure the widget (the host tag defaults to `div`); every other prop — `key`, `class`, `on`, ... — applies to the host element as usual, and the widget node has no vnode children (the widget owns the host's subtree). `props` is compared **by reference**: with the JSLT memo option, unchanged state yields reference-equal props, so an untouched widget is never called. `mount` runs after the host is connected (grids can measure) and returns a handle threaded to `update`/`unmount`; `unmount` runs exactly once when the widget leaves the tree, even when an ancestor subtree is replaced. A throwing `mount` or `update` **poisons** the widget instead of corrupting it: siblings and the frame still complete, the first error surfaces after the frame settles, and the next render that revisits the widget replaces it with a fresh lifecycle (`unmount` runs on the old instance only when its `mount` had succeeded). `emit(binding, event)` delivers ordinary event bindings to `onEvent` — a widget composes runtime data (the clicked row id) into the binding its props carry instead of inventing an action vocabulary. `renderToString(vnode, { widgets })` serializes the host around the widget's `ssr(props)` vnode — still pure, nothing mounts.

### Shared view helpers — `@jarenjs/view/helpers`

The `./helpers` subpath is the single home for the small view-layer helper kernel that the suite's visual components (`@jarenjs/calc`, `@jarenjs/md`, `@jarenjs/mermaid`) share, so no component re-implements them:

- **SVG builders over `h()`** — `svgRoot(className, width, height, theme, children, key?)`, `group`, `rect`, `circle`, `line`, `path`, `polyline`, `polygon`, `textAt`, `textLines`, plus the geometry guard `num` and the path-string builder `polylinePath`. `svgRoot` takes the root `class` and (via `theme.cssVars`) the CSS variables from the caller.
- **`sanitizeHref(url)`** — the strict URL **allow-list** (http/https/mailto/`#`/`/`/`.`) for link hrefs from a constrained producer, such as a Mermaid `click` directive. It rejects a scheme-less relative reference like `image.png`.
- **`sanitizeUrl(url)`** — the URL **deny-list** for hrefs and image sources authored in ordinary content: it rejects only `javascript:`, `vbscript:`, `file:` and `data:` other than a raster image, and passes everything else, relative references included. This is what `@jarenjs/md` filters link destinations through. Both return the trimmed URL or `null`, and `null` means *drop the attribute*.
- **`resolveTheme(themes, prefix, nameOrOverrides?)`** — the prefix-driven mechanics behind each component's `createTheme`: a name-or-overrides object resolved to `{ name, tokens, cssVars }`, stamping every token as `--<prefix>-<kebab-case-key>`. Components keep their own token tables; the resolution logic lives here once. The pure `kebabCase` transform it uses comes from [`@jarenjs/core/string`](../core). One documented quirk (behavior preserved, test-asserted): when passed an *overrides object* that carries a `theme` key, that key is spread into the returned `tokens` and therefore surfaces as a `--<prefix>-theme` CSS variable — the base-selecting key leaks into the output rather than being stripped.

- **`createProjectionMemo({ compile, toVnode, docToVnode, memoLimit? })`** — the memo pair a component's `view()` projection is built on: an LRU-memoized `compile(source)` (string-keyed, default limit 32) and a reference-stable `view(sourceOrDoc)` that projects a source string through the compile memo or an already-parsed document through a WeakMap keyed on its identity. `@jarenjs/md` and `@jarenjs/mermaid` build their component-layer `view()` on it — reference stability is what lets an unchanged input patch in O(1).

Import the whole barrel (`@jarenjs/view/helpers`) or a single module (`@jarenjs/view/helpers/svg`, `@jarenjs/view/helpers/theme`).

## Performance contract

The patcher's first check is `oldVnode === newVnode` — a reference-equal subtree is skipped in O(1), unexamined. This is designed to meet the JSLT engine's structural sharing and its `memo` option (an unchanged input subtree flows to the output by reference; `@jarenjs/app` compiles every view with `memo: true`), so views re-render in time proportional to what changed, not to the size of the page. Vnodes are never mutated or annotated by the renderer: frozen documents, cached documents and shared subtrees are always safe.

Measured, not claimed — run `npm run benchmark:view` for your own numbers, and the [benchmarks page](https://jarenjs.github.io/#/benchmarks?suite=view) publishes the latest full run with its date and machine. On a 1000-row table (output equality with preact asserted before timing): an **unchanged document re-renders in O(1)** — the memoized transform returns the previous output by reference and the patcher skips it whole. For a one-row copy-on-write update the memo cuts the end-to-end frame (view + patch) by roughly **1.6×**. Producing vnodes from scratch costs about **8× a hand-written `h()` call** (a generic JSLT dispatcher versus preact's direct constructor, with hyperapp's about 2× preact's) — the honest price of views-as-data, and the reason the re-render path, not the build path, is where this engine competes. SSR lands within ~2–3× of `preact-render-to-string` on byte-identical output.

When a producer cannot preserve the reference — it rebuilds its tree but knows a region did not change — the **`memo` prop** says so declaratively (VIEW-FORMAT §5.5): two same-node vnodes carrying equal `memo` values skip reconciliation exactly like reference-equal ones. It is a producer-owned assertion, `key`'s sibling: equal markers promise identical subtrees, and a violated promise means stale output. Measured on a reallocated parent over 10 000 shared children, the marker removes the whole per-child scan: about **448 µs** to walk the children looking for `===` skips versus about **41 µs** with the marker — **10.9×**, and the gap widens with the child count (`npm run benchmark:view`). `@jarenjs/charts`' streaming sessions are the reference consumer.

Children reconcile with a head/tail sweep plus a key map for the middle: keyed siblings move their real DOM nodes instead of recreating them; unkeyed siblings patch positionally. Event bindings are data stored on the node behind one shared proxy listener per event type — re-rendering rebinds by assignment, never through `addEventListener`.

## Development

Unit tests live in `test/view/` at the repository root (`npm run test:view`), including the minimal DOM stub they run against. See the repository [README](../../README.md) for the full suite documentation and [ROADMAP](../../docs/ROADMAP.md) for planned work: fragment roots, DOM-adopting hydration, and the memoized rule-output layer that turns JSLT sharing into cross-frame skipping.
