# Collection contract

## Engine and rendering

`createCollection(options)` from `@jarenjs/collection` needs `count`, `keyAt(index)`,
`getItem(index)` and `renderCell(row,column,index)`. Keys are unique stable strings;
`null` denotes an unloaded placeholder. Duplicate loaded keys throw `TypeError`.
Accessors visit only the credited viewport and pins. The engine imports core/view
only and has no DOM, app, database or worker import.

Geometry options include `rowSize` (44), `columnSize` (160), `columnCount` (1),
`overscan` (2), `columnOverscan` (1), `maxRows` (128), `maxColumns` (32) and
`maxCells` (840). Row and column windows are independent. `rowPins`, `columnPins`,
`rowPinBudget` (2) and `columnPinBudget` (2) include focus pins in the same limits.
Pinned rows/columns remain at the leading viewport edge. With base windows R/C,
row/column mounts are at most R+rowPins and C+columnPins; all cells must also fit
`maxCells`. Credit exhaustion returns an empty explicit refusal, never a partially
rendered success. Hidden viewports have no rows, cells or focus pins.

The row and column axes independently accept `maxMeasurements`, `measurementBytes`,
`maxColumnMeasurements` and `columnMeasurementBytes`. Eviction reverts a size to
its estimate. `measure(index,key,size,axis='row')` preserves the stored keyed row
anchor, including compensation for evicted measurements. `update(next)` reindexes
retained measurements via `indexOf(key)`; it must run after the host changes source
order. Changing `rowSize` or `columnSize` invalidates corresponding measurements.

`viewport({top,left,width,height})`, `layout()`, `view(interaction,id)`, `stats()`,
`position()`, `options()`, `pin(rows,columns)`, `snapshot()`, `restore(anchor)` and
idempotent `dispose()` form the controller API. `scrollToOffset`, `scrollToIndex`
and `scrollToKey` return outcomes; missing key lookup returns `unsupported-seek`.
The optional column argument of `scrollToIndex` scrolls both axes. Indices locate
rows in the current query and are never persisted as entity identity. A missing
anchor key falls back to its clamped previous position; a changed query starts at
zero. A new snapshot re-resolves the stable key in the same query.

## DOM ownership and accessibility

Import `mountCollection`, `createCollectionWidget` and `mountProviderCollection`
from `@jarenjs/collection/component`, and link `@jarenjs/collection/styles/collection.css`.
`mountCollection(host, options)` owns its element, scroll listener, keyboard/click/
focus/composition handlers, resize observers and frames. `requestFrame`,
`cancelFrame` and `observe(element, callback) => unsubscribe` can be injected by the
host. `dispose` is adapted to the existing widget `unmount` hook, preserving the
renderer lifecycle. Failed mounts clean acquired resources too.

```js
import { createCollectionWidget } from '@jarenjs/collection/component';
const widgets = { collection: createCollectionWidget({
  count: rows.length, keyAt: (i) => rows[i].id, indexOf: (key) => index.get(key) ?? -1,
  getItem: (i) => rows[i], renderCell: (row, column) => columns[column].render(row),
  columnCount: columns.length, label: 'Catalog'
}) };
const vnode = ['jaren-widget', { name: 'collection', props: { height: 440 } }];
```

The DOM adapter's conservative `maxExtent` defaults to 8,000,000 CSS pixels per
axis; larger extents return `error / scroll-extent` before reaching CSS layout.
The pure engine can compute larger ranges; this is an explicit browser refusal.
`direction: 'rtl'` normalizes negative browser scroll offsets and aligns columns
with logical inline positions. `height` controls the viewport; its host controls
width. `measured:true` observes content; `measureRow(element,index)` can supply
host-specific height measurement. The default measures the tallest cell content
plus cell padding. `maxMeasurementWork` (64) bounds measured rows per pass; resize
notifications coalesce into one frame. The same keyed renderer handles controlled
inputs, so scroll and measurement patches preserve node identity and selection.

`role` is `grid` by default or `listbox`. Grid cells carry logical row/column
indices; list options carry logical position/set size. `totalKnown:false` exposes
unknown total as -1 rather than loaded count. `label` names the collection.
`createCollectionInteraction(options)` is the headless counterpart: arrows,
Home/End (Ctrl for the whole grid), PageUp/Down, Space selection, Enter activation
and Escape return focus. Arrow direction follows RTL. Editing targets and
composition bypass collection shortcuts. Browser-native editing keys retain their
normal caret behavior.

`focusIndex` realizes a loaded key or records a pending transient index while
retaining existing focus. The DOM exposes `aria-activedescendant` only after the
referenced element exists. Loading exposes `aria-busy`; source refusal clears
pending realization. `removedKeys` tells interaction to resolve a removal fallback.
`onRealize`, `onActivate`, `returnFocus`, `onIntent` and `onChange` are host hooks;
only bounded observations and JSON intent need enter app state.

Selection contains stable `keys`, or query/snapshot-scoped `mode:'all'` with
`exclusions`, or one range with stable `fromKey`/`toKey` endpoints. Shift ranges
survive asynchronous endpoint realization. `maxSelectedKeys` (4096) bounds explicit
keys/exclusions. `state`, `selected`, `toggle`, `selectAll`, `clear`, `restore`,
`cancelPending` and `update` expose the model. Range membership for rendered rows
uses the host's current key lookup; exports resolve endpoints over the full ordered
snapshot. Key selection survives eviction and query changes; scoped all/range
selection cannot be exported against another identity. Authoritative writes must
still recheck membership/revision.

## Data and complete output

`mountProviderCollection(host,coordinator,options)` uses exactly the same controller
and interaction. The host injects `createCollectionCoordinator(provider)` from
`@jarenjs/app`. The component requests missing visible ranges, publishes loading/
refusal state, and preserves edit pages within the coordinator's existing credits.
Eviction cannot destroy an active editor; if its pinned page prevents admission,
the coordinator returns `pinned-page-credits` until the host releases the pin.

The mounted provider handle exposes `mounted`, `coordinator`, `next`, `snapshot`,
`output`, `print` and async idempotent `dispose`. `next` is the continuation
operation for unknown-total sequential sources. Printing and exporting use the same
complete snapshot stream, with the host supplying a transactional sink; neither
reads mounted DOM. The source must advertise `completeExport`. See the normative
[app provider contract](../../../packages/app/docs/COLLECTION-PROVIDER.md).

Actual assistive technology, physical touch and native OS IME qualification remain
separate from automated browser evidence; see [measurements](MEASUREMENTS.md).
