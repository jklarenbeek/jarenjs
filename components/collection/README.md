# @jarenjs/collection

For a complete storage-to-view application, follow the [public adoption composition](../../docs/ADOPTION-EVIDENCE.md). The injected coordinator owns bounded pages while complete membership and exports belong to the source; AT, physical devices and native OS IME remain separate qualifications.

Virtual lists and grids with bounded viewport work, sparse measurements and stable keys.
The headless engine uses `@jarenjs/core/virtual`; `./component` adapts it to the
existing view widget lifecycle. Applications inject row access and rendering.

```js
import { createCollection } from '@jarenjs/collection';
const collection = createCollection({
  count: 1000, keyAt: String, getItem: (index) => ({ label: `Row ${index}` }),
  renderCell: (row) => row.label
});
collection.viewport({ width: 320, height: 440 });
const vnode = collection.view();
collection.dispose();
```

See [architecture](ARCHITECTURE.md) and [the collection contract](docs/COLLECTION.md).

`createDragInteraction` supplies stable-key move/copy intent and async authority
fencing. `mountCollectionDrag` and `createDraggableCollectionWidget` in
`@jarenjs/collection/component` add pointer, dedicated touch handles, keyboard,
portal overlays and bounded auto-scroll over the existing virtualizer. See
[the drag contract](docs/COLLECTION.md#drag-intent-and-authoritative-commands).

The words the collection shows a reader — the grid's accessible name, the
placeholder of a row still loading, the drag overlay and the drag
announcements — are the English catalog `collectionMessagesEn`. Pass a
compiled locale catalog as `messages` (to `createCollection`,
`mountCollection` and `mountCollectionDrag`, or later through `update`) and
they render through it, falling back to English per id; an explicit `label`
or `loadingLabel` still wins.

## Public exports

<!--fact:exports.collection-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/collection` | JavaScript | declared |
| `@jarenjs/collection/component` | JavaScript | declared |
| `@jarenjs/collection/package.json` | metadata | — |
| `@jarenjs/collection/styles/collection.css` | asset | — |
<!--/fact-->
