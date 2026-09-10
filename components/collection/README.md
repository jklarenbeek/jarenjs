# @jarenjs/collection

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

## Public exports

<!--fact:exports.collection-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/collection` | JavaScript | declared |
| `@jarenjs/collection/component` | JavaScript | declared |
| `@jarenjs/collection/package.json` | metadata | — |
| `@jarenjs/collection/styles/collection.css` | asset | — |
<!--/fact-->
