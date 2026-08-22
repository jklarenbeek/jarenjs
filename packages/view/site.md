---
package: "@jarenjs/view"
card:
  title: View
  blurb: >-
    UIs as JSON: the tagged-array vnode format, a keyed DOM patcher that
    skips unchanged subtrees in O(1), an SSR serializer and a
    registered-widget escape hatch for irreducibly imperative islands. The
    grammar ships as JSON Schema, so a constrained decoder cannot emit a
    structurally invalid interface — and an opt-in safe-render profile
    sanitizes an untrusted one. Running a view as data costs engine time
    against a hand-written build, and the benchmark publishes that price
    beside the win.
  perf: >-
    hand-written vnodes outbuild the mainstream frameworks; the stylesheet
    pays for views-as-data — both published
engines:
  - key: view
    suite: view
---

User interfaces as JSON: `@jarenjs/view` defines the vnode format (a keyed DOM
patcher and an SSR string renderer consume it), and `@jarenjs/app` runs the
loop — state, JSLT view, query-document actions, JSON Patch transitions,
effects and subscriptions at named JS boundaries.

The grammar ships as JSON Schema, so a constrained decoder cannot emit a
structurally invalid interface, and an opt-in safe-render profile sanitizes an
untrusted one. `VIEW-FORMAT.md` is the contract; the loop that drives a view is
`@jarenjs/app`, below.
