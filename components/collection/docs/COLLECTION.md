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

## Drag intent and authoritative commands

`createDragInteraction` from `@jarenjs/collection` owns a single drag with a stable
`source:{key,revision}`, `target:{container,key,column}` and `mode:'move'|'copy'`.
Source revisions are finite numbers or strings; every target identity is a string.
Indices and DOM objects never enter this intent. The engine requires
`resolveSource(key)`, `validTarget(target)` and `commit(intent,{signal})`; an optional
`validate(intent,{signal})` can check asynchronous permission before dispatch.

`begin(key,{input,point,copy})` arms pointer/touch input and immediately activates
keyboard input. Pointer movement must meet `activationDistance` before dragging.
`move(point,target,copy)` changes only transient intent. `revalidate()` resolves
current source revision and target availability; source changes or invalid targets
cancel. `drop()` validates and then dispatches one command. Repeated drops do not
dispatch again. Permission denial, a false command result or a rejected promise
cancels without any optimistic source mutation. The authoritative host owns all
policy, revision checks and actual movement.

`state()` returns a detached serializable snapshot with phase, identity, point,
generation and pending status. `cancel(reason)` and idempotent `dispose()` fence
late replies and abort their signals. A cancelled asynchronous callback retains
the single pending credit until it settles, so repeated cancellation cannot
accumulate new authority calls on that engine. Cancellation after dispatch does
not undo a server command: the host must honour the signal or reconcile its
authoritative result. The engine never applies a late reply to source data.

## Owned collection drag adapter

`mountCollectionDrag(containers,options)` from `@jarenjs/collection/component`
attaches to already-mounted collections. Each container supplies a unique `id`,
its `mounted` handle, `columnKey(index)` and `indexOfColumn(key)`. Options supply
the engine policy above and `locateSource(key) => {container,key,column}` for its
current cell. `disabled(target)` may additionally reject a cell. Resolvers are
synchronous and must be bounded; unloaded or unmounted targets are unavailable.

```js
import { mountCollectionDrag } from '@jarenjs/collection/component';

const drag = mountCollectionDrag([{
  id: 'catalog', mounted: grid,
  columnKey: (index) => columns[index].id,
  indexOfColumn: (key) => columnIndex.get(key) ?? -1
}], {
  resolveSource: (key) => records.get(key), // { key, revision }
  locateSource: (key) => positions.get(key), // stable container/row/column keys
  validTarget: (target) => permittedCells.has(target.key),
  commit: (intent, { signal }) => commands.moveOrCopy(intent, { signal })
});
// A cell renderer supplies a dedicated, focusable handle:
const handle = ['button', {
  'data-jc-drag': record.key, style: { touchAction: 'none' }
}, 'Move item'];
// The owning widget or route disposes the adapter with its collections.
drag.dispose();
```

Pointer input uses capture and client-coordinate hit testing. Touch activation
requires a dedicated `data-jc-drag` handle whose computed `touch-action` is `none`;
the remainder of the collection keeps ordinary browser scrolling. No global
touch-scroll suppression or long-press heuristic is installed. Pointer coordinates
come from actual cell rectangles, so nested scrolling, pinned headers, transforms
and CSS zoom do not require storing logical indices as positions. A keyed DOM move
can reacquire capture for the same connected source; actual capture loss cancels.

Space or Enter on a focused handle starts keyboard dragging. Arrows resolve the
next current row/column key; horizontal motion follows the collection direction.
Tab switches containers, Alt selects copy, and Enter/Space drops. Escape cancels.
Text controls and composition retain their native editing keys; Escape can cancel
an active pointer drag when a text control still has focus, while composing input
remains untouched. A polite status region announces target, result and cancellation.
Focus returns to the original connected element, or a surviving collection if it
was removed. Native OS IME and assistive-technology behaviour still need manual
qualification; synthetic events do not establish those results.

The overlay is text in an owned portal, outside the grid's clipped containers.
It uses the browser top layer when popovers are available and otherwise a fixed
positioned portal. A custom `portal` owns its own CSS coordinate context. Only
one overlay and one animation frame belong to an adapter. Auto-scroll visits a
bounded chain of scrollable ancestors, stops at limits and on cancellation, and
re-resolves targets after movement. Existing row/column pin budgets include the
drag source and focus together. A pin or DOM-credit refusal cancels the drag.

`mounted.subscribe(listener)` observes layout, reset and disposal;
`mounted.retain(() => ({rows,columns}))` contributes transient indices resolved
from stable keys inside the same pin budget. Both return idempotent unsubscribe
functions. These host resources stay outside app state. Their own finite admission
limits refuse excess rather than silently keeping more listeners or pins.

The drag handle exposes `interaction`, `cancel`, `update`, `stats` and idempotent
`dispose`. `update` replaces authority callbacks; geometry, portal and scheduling
ownership are fixed for a mount. Window blur, pointer cancellation, lost capture,
source reset, removed source and collection disposal clear the gesture. Disposal
attempts every acquired cleanup even if an observer throws. Stats count owned
listeners, subscriptions, frames, overlays, status nodes and pending authority.

`createDraggableCollectionWidget(options)` combines one collection and its drag
adapter with the existing WidgetDef lifetime. Supply `id`, `collection`,
`columnKey`, `indexOfColumn` and `drag`; a factory may derive them from props and
the host emit callback. Updating props refreshes policy and collection state.
A changed container identity requires a new widget key. Multi-container widgets
own one `mountCollectionDrag` handle and dispose it before their mounted collections.
