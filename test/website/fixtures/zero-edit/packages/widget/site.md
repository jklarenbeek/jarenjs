---
package: "@jarenjs/widget"
card:
  title: Widget
  blurb: >-
    A package that was added to the repository after the website was written,
    and describes itself to it in this document.
  perf: >-
    measured by the suite it names, like every other card
engines:
  - key: widget
    suite: markdown
---

The workspace wrote this section beside its own code, and the site renders it
without knowing the package exists.

```js
import { widget } from '@jarenjs/widget';
widget();
```
