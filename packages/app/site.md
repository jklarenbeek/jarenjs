---
package: "@jarenjs/app"
card:
  title: App
  blurb: >-
    Whole applications as one JSON document: state, a JSLT stylesheet for
    the view, query documents for actions, JSON Patch transitions and
    subscriptions with an EBV liveness query. Everything compiles once at
    createApp; the running loop only calls specialized closures.
  perf: >-
    this site and the Studio are both app documents
engines:
  - key: app
---

An application is one JSON document: initial state, a JSLT stylesheet for the
view, query documents for the actions, JSON Patch transitions between them, and
effects and subscriptions at named JS boundaries. Everything compiles once at
`createApp`; the running loop only calls specialized closures.

```json
{ "state": { "count": 0 },
  "view": [ { "match": "$", "body":
    ["main", {},
      ["h1", {}, "Count: ", "$.count"],
      ["button", { "on": { "click": "inc" } }, "+"]] } ],
  "actions": { "inc": { "patch": [
    { "op": "replace", "path": "/count", "value": { "$add": ["$.count", 1] } } ] } } }
```

The page you are reading is such a document. `VIEW-FORMAT.md` and
`APP-FORMAT.md` are the contracts.
