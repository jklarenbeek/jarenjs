# @jarenjs/website

The jarenjs website — **the site is one JSON app document** running on [`@jarenjs/app`](../app) and [`@jarenjs/view`](../view). No React, no framework: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, navigation is plain hash links feeding one subscription, and the playground's generated form renders through the standard forms stylesheet. The site is its own best demo: everything it claims about the suite, it does with the suite.

```bash
npm run dev                  # in this package
npm run benchmark:generate   # refresh public/benchmarks/*.json from the benchmark workspace
npm run deploy               # benchmark:generate + build + gh-pages publish
```

## What it does

- **Nine live playground engines.** The JSON Schema tab (live compile, generated form via the standard forms stylesheet, EN/NL report-time errors) plus eight **generic engines** — JSONPath, JSON Pointer, JSON Patch (patch/merge/write/diff, with the change feed on display), JSON Query, JSLT, JTLT, XQuery and JOSL — each an entry in `src/boundaries/engines.js`: input descriptors plus a `run(inputs) → render nodes` boundary. The generic rules in `src/views/playground.js` render any of them; adding an engine is adding a descriptor.
- **The Studio (`#/studio`).** A user- or AI-authored `@jarenjs/app` document — state + JSLT view + actions as one JSON value — hosted as an isolated nested app next to the site's own: the jaren-app meta-schema gates every boot, the nested app gets **no effects and no subs**, and iteration is RFC 6902 patch-based (`jaren_studio_write` / `jaren_studio_patch` / `jaren_studio_read` / `jaren_get_templates` in the assistant toolbox). Three boot-tested seed templates (form + validation, charts dashboard, routed mini-site); documents save as experiments, share as links and download as JSON. The honest "one prompt → website".
- **The experiment IDE.** Name any engine state and save it (`localStorage` behind the injected `storage` env); experiments list as chips, load back into the right engine (navigating there), and delete. The store is plain JSON — exportable, syncable later.
- **Benchmarks, all eight suites.** Overview, the searchable per-test JSON Schema table with a ratio-distribution bar chart, the full JSONPath compliance/profile tables, the JSON Query and JSLT scenario matrices with the actual program sources unfoldable per engine, JSON Pointer, JSON Patch and JOSL/TOML. Data comes from `benchmark/website-data.js` writing into `public/benchmarks/`; ratio > 1 always means "Jaren is N× faster".
- **Docs & Examples.** Twenty documentation sections as a content document (`src/content/docs.js`, kind-nodes — an LLM constrained to the schemas could write these pages), and the full example gallery with one-click **Open in playground**.
- **WebMCP.** When the browser exposes `navigator.modelContext`, the site registers its engines as agent tools (`jaren_validate`, `jaren_run_engine`, `jaren_navigate`, experiment tools…) — through the same boundaries the UI uses, with every tool input validated against its JSON Schema *by Jaren itself*. No modelContext → no-op.
- **PWA + mobile.** Installable (manifest + service worker: cached shell and assets, stale-while-revalidate benchmark data — the whole IDE works offline), with a mobile navigation drawer, single-column layouts, touch-sized controls and safe-area insets.

## Architecture

| Concern | Where | How |
|---|---|---|
| State | `src/app/state.js` | one JSON document: route, theme, benchmark cache, engine inputs, experiments |
| Actions | `src/app/actions.js` | query documents; `route/set` computes its fetch effects with `$if` — orchestration as data |
| View | `src/views/` | one JSLT envelope; pages are **modes**, dispatched via `$.ui.<page>` nodes that only exist for the active route |
| Derivations | `src/app/viewmodel.js` | the APP-FORMAT §5.2 boundary: nav, benchmark render-nodes, engine panels, form view model, localized errors |
| Boundaries | `src/boundaries/` | the validator, the engine table, benchmark JSON → kind-tagged render nodes, WebMCP |
| Generic UI | `src/views/ui.js` | one rule per node kind (`cards`/`table`/`callout`/`code`/`error`/`bars`/`details`/`search`/`more`) renders every data-driven section |
| Reactivity | `src/app/createSiteApp.js` | one subscriber on the transition **changed-path feed** revalidates the schema playground and re-runs engines — debounced, driven by data |
| Styling | `src/styles.css` | hand-rolled CSS, light + dark |

Tests live in `test/website/` at the repository root (`npm run test:website`) and drive the complete site headless — routing, every engine, the IDE round-trip, WebMCP tool execution, benchmark search against the real generated data, SSR — on the same DOM stub the view package uses. Production build: `npm run build` (Vite, no plugins); ~39 kB gzipped site chunk (including all example and docs content) + ~67 kB for the entire Jaren suite.
