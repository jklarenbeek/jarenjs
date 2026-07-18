# @jarenjs/webnext

The jarenjs website rebuilt on the suite itself — **the site is one JSON app document** running on [`@jarenjs/app`](../app) and [`@jarenjs/view`](../view). No React, no framework: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, navigation is plain hash links feeding one subscription, and the playground's generated form renders through the standard forms stylesheet.

This package lives **beside** [`@jarenjs/website`](../website) on purpose: same routes (`#/`, `#/playground`, `#/benchmarks`, `#/docs`, `#/examples`), same deep-linkable tab params (`?engine=`, `?suite=`), same benchmark data files (synced from the website package by `scripts/sync-assets.js` — the generator `benchmark/website-data.js` stays the single source of truth), same GH Pages base path. Run both and compare:

```bash
npm run webnext:dev      # from the repo root (or: npm run dev in this package)
npm run dev --workspace=@jarenjs/website
```

When webnext reaches feature parity, it takes over the `website` name and the deploy pipeline; until then, anything not yet ported cross-references the deployed current site.

## Architecture

| Concern | Where | How |
|---|---|---|
| State | `src/app/state.js` | one JSON document: route, theme, benchmark cache, playground inputs |
| Actions | `src/app/actions.js` | query documents; `route/set` computes its fetch effects with `$if` — orchestration as data |
| View | `src/views/` | one JSLT envelope; pages are **modes**, dispatched via `$.ui.<page>` nodes that only exist for the active route |
| Derivations | `src/app/viewmodel.js` | the APP-FORMAT §5.2 boundary: nav, benchmark render-nodes, form view model, localized errors |
| Boundaries | `src/boundaries/` | the validator (compile cache, plain-JSON results), benchmark JSON → kind-tagged render nodes |
| Generic UI | `src/views/ui.js` | three rules (`cards`/`table`/`callout`) render every benchmark suite; adding a suite is a data transformation |
| Reactivity | `src/app/createSiteApp.js` | one subscriber on the transition **changed-path feed** revalidates the playground when `/pg/schemaText` or `/pg/data/*` change — debounced, like the old React hook, but driven by data |
| Styling | `src/styles.css` | hand-rolled CSS, same token palette as the current site, light + dark |

## Feature complete

- **Nine live playground engines.** The JSON Schema tab (live compile, generated form via the standard forms stylesheet, EN/NL report-time errors) plus eight **generic engines** — JSONPath, JSON Pointer, JSON Patch (patch/merge/write/diff, with the change feed on display), JSON Query, JSLT, JTLT, XQuery and JOSL — each an entry in `src/boundaries/engines.js`: input descriptors plus a `run(inputs) → render nodes` boundary. The generic rules in `src/views/playground.js` render any of them; adding an engine is adding a descriptor.
- **The experiment IDE.** Name any engine state and save it (`localStorage` behind the injected `storage` env); experiments list as chips, load back into the right engine (navigating there), and delete. The store is plain JSON — exportable, syncable later.
- **Benchmarks, all eight suites.** Overview, the searchable per-test JSON Schema table with a ratio-distribution bar chart, the full JSONPath compliance/profile tables, the JSON Query and JSLT scenario matrices with the actual program sources unfoldable per engine, JSON Pointer, JSON Patch and JOSL/TOML.
- **Docs & Examples.** Nineteen documentation sections as a content document (`src/content/docs.js`, kind-nodes — an LLM constrained to the schemas could write these pages), and the full example gallery with one-click **Open in playground**.
- **WebMCP.** When the browser exposes `navigator.modelContext`, the site registers its engines as agent tools (`jaren_validate`, `jaren_run_engine`, `jaren_navigate`, experiment tools…) — through the same boundaries the UI uses, with every tool input validated against its JSON Schema *by Jaren itself*. No modelContext → no-op.
- **PWA + mobile.** Installable (manifest + service worker: cached shell and assets, stale-while-revalidate benchmark data — the whole IDE works offline), with a mobile navigation drawer, single-column layouts, touch-sized controls and safe-area insets.

Tests live in `test/webnext/` at the repository root (`npm run test:webnext`) and drive the complete site headless — routing, every engine, the IDE round-trip, WebMCP tool execution, benchmark search against the real generated data, SSR — on the same DOM stub the view package uses. Production build: `npm run build` (Vite, no plugins); ~39 kB gzipped site chunk (including all example and docs content) + ~67 kB for the entire Jaren suite.
