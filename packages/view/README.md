# @jarenjs/view

User interfaces as JSON documents. This package defines the **Jaren vnode format** — the output vocabulary a view produces the way XSLT produces HTML — and ships the two renderers that consume it:

- a **keyed DOM patcher** (`createDomRenderer`): diff the previous vnode against the next, touch only what changed, reuse keyed nodes across reorders;
- an **SSR string renderer** (`renderToString`): the same JSON to an HTML string, no DOM required.

It is the only package in the Jaren suite that touches the DOM, and it knows nothing about schemas, queries or state — a vnode is plain JSON, wherever it came from. In practice it comes from a [JSLT stylesheet](../json/docs/JSLT-FORMAT.md) compiled by [`@jarenjs/json`](../json), and the loop around it lives in [`@jarenjs/app`](../app). Its only runtime dependency is the pure, zero-dependency [`@jarenjs/core`](../core); no `eval`, CSP-safe.

The vnode grammar is published as JSON Schema in [`schemas/jaren-vnode.schema.json`](schemas/jaren-vnode.schema.json) — hand it to a constrained decoder and a language model cannot emit a document outside the *grammar*. That is a **structural** guarantee, not a safety one: a grammar-valid vnode can still carry `innerHTML`, an inline `on*` handler or a `javascript:` URL, so validation alone does **not** make an untrusted document safe to render. Rendering an untrusted view — from a tenant, a remote service, a model — requires the [safe profile](#untrusted-views-the-safe-profile) below; the default renderers trust their input, exactly like writing the DOM by hand. The normative contract is [docs/VIEW-FORMAT.md](docs/VIEW-FORMAT.md).

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

## Untrusted views: the safe profile

The default renderers **trust** their input. A vnode is plain JSON, and the
default `createDomRenderer`/`renderToString` write whatever it says — including
`innerHTML`, inline `on*` handlers and `javascript:` URLs. For a
source-authored view that is exactly right; it is the equivalent of writing the
DOM by hand, and it is why the grammar's guarantee is *structural*, not a
sanitizer. Validating a document against the vnode schema proves it is
well-formed, **not** that it is safe to render.

When a view arrives from somewhere you do not control — a tenant, a remote
service, a language model — pass `{ safe: true }`:

```js
renderToString(untrustedVnode, { safe: true });
createDomRenderer(container, { safe: true, onUnsafe: (i) => log(i) });
```

Both build the **same** policy ([`createSafePolicy`](src/safe.js)), so the
client and the server neutralize an attack identically. In safe mode:

- **tags** are restricted to an allow-list of inert HTML and SVG elements —
  `script`, `iframe`, `object`, `style`, `link`, `foreignObject` and the rest
  are dropped, and so is any tag whose *name* is not a bare identifier (which
  closes structural injection through a tag like `div><img …`);
- **property names** must be bare identifiers too (closing attribute-name
  injection), may not begin with `on`, and may not be an HTML-parsing sink
  (`innerHTML`, `outerHTML`, `srcdoc`, …);
- **URL attributes** (`href`, `src`, …) are filtered through the `sanitizeUrl`
  deny-list; **inline styles** carrying `expression(` or a script-scheme
  `url()` are dropped;
- **`on` event bindings and `jaren-widget` nodes are stripped** — an untrusted
  document must not bind the host's actions or mount imperative JavaScript, so
  safe-mode views are display-oriented.

A companion schema,
[`schemas/jaren-vnode-safe.schema.json`](schemas/jaren-vnode-safe.schema.json),
gates the structural half (tag and property *names*) at validation time as
defense in depth. It cannot read a `javascript:` scheme out of a string, so
the **runtime policy is authoritative**: validate with the safe schema *and*
render with `{ safe: true }`.

**What safe mode is, and is not.** It reduces the attack surface of an
untrusted *view* to a display: it strips script, raw-HTML sinks, inline and
`on` handlers, widgets, and unsafe URLs, and the client and server strip
identically. It is **not a complete sandbox** — the allow-list still includes
anchors, forms, controls and media, so native navigation, form submission,
focus and network loads remain possible; treat safe mode as one layer under a
Content-Security-Policy, not a replacement for one. It also applies to the
**renderer only**: [`@jarenjs/app`](../app) does not pass `safe` through, and
an app document names host actions, effects and subscriptions, so a safe
*view* does not make an untrusted *app document* safe — run only self-authored
app documents. Still open, and tracked in the roadmap: caret/IME fidelity
across engines, `multiple`-select and composition behavior proven in real
Chromium/Firefox/WebKit, and a Trusted Types integration.

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

Measured, not claimed — run `npm run benchmark:view` for your own numbers, and the [benchmarks page](https://jarenjs.github.io/#/benchmarks?suite=view) publishes the latest full run with its date and machine. Two different costs get measured on a 1000-row table (output equality with React and preact asserted before timing), and keeping them apart is what makes the numbers readable:

- **The format.** A vnode is a tagged array — an array literal plus a plain object — and the renderer, patcher and SSR accept it from any producer. A **hand-written view building tagged arrays directly is the fastest element builder in the table: ~1.8× faster than React's production `createElement`**, ~2.5× faster than preact's `h()`. Writing views by hand is fully supported; the stylesheet is opt-in per view.
- **The engine.** A JSLT stylesheet is a view as *data* — schema-validated, serializable, storable, and renderable from an untrusted source through the [safe profile](#untrusted-views-the-safe-profile) — and running that document through the generic dispatcher costs **~20× the hand-written build**. That is the published price of a capability none of the rivals has a mode for: a JSX view is code by construction, so there is no data-driven React number to compare against.
- **The re-render path.** An **unchanged document re-renders in O(1)** — the memoized transform returns the previous output by reference and the patcher skips it whole — and the vnode-level `memo` marker gives hand-written producers the same subtree skip (~12× over the child scan). For a one-row copy-on-write update the memo cuts the stylesheet frame ~1.5× against its own no-memo path; at this table size the hand-written view plus a full diff is still the fastest frame outright, and that is on the page too. SSR lands within ~1.6–2.8× of `preact-render-to-string` depending on the route, on byte-identical output.

When a producer cannot preserve the reference — it rebuilds its tree but knows a region did not change — the **`memo` prop** says so declaratively (VIEW-FORMAT §5.5): two same-node vnodes carrying equal `memo` values skip reconciliation exactly like reference-equal ones. It is a producer-owned assertion, `key`'s sibling: equal markers promise identical subtrees, and a violated promise means stale output. Measured on a reallocated parent over 10 000 shared children, the marker removes the whole per-child scan: about **448 µs** to walk the children looking for `===` skips versus about **41 µs** with the marker — **10.9×**, and the gap widens with the child count (`npm run benchmark:view`). `@jarenjs/charts`' streaming sessions are the reference consumer.

Children reconcile with a head/tail sweep plus a key map for the middle: keyed siblings move their real DOM nodes instead of recreating them; unkeyed siblings patch positionally. Event bindings are data stored on the node behind one shared proxy listener per event type — re-rendering rebinds by assignment, never through `addEventListener`.

## Development

Unit tests live in `test/view/` at the repository root (`npm run test:view`), including the minimal DOM stub they run against. See the repository [README](../../README.md) for the full suite documentation and [ROADMAP](../../docs/ROADMAP.md) for planned work: fragment roots, DOM-adopting hydration, and the memoized rule-output layer that turns JSLT sharing into cross-frame skipping.
