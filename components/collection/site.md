---
package: "@jarenjs/collection"
card:
  title: Collections
  blurb: >-
    Virtual lists and grids with stable keys, bounded geometry and injected row providers.
  perf: >-
    viewport work independent of logical row count
---

`@jarenjs/collection` renders virtual lists and grids from injected row accessors.
Core owns range math; the component owns rendering, measurement and interaction;
app coordinates bounded provider requests. Resident arrays remain resident arrays.

```js
import { createCollection } from '@jarenjs/collection';
const rows = createCollection({ count: 1000, keyAt: String,
  getItem: (i) => ({ label: `Row ${i}` }), renderCell: (row) => row.label });
rows.viewport({ width: 320, height: 440 });
rows.view();
rows.dispose();
```
