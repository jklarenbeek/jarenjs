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

Ported so far: the shell (header/nav/theme/footer), Home, Benchmarks (overview, JSON Schema summary, JSON Pointer, JSON Patch, JOSL/TOML — deep-dives cross-reference), and the flagship **JSON Schema playground**: live compile per keystroke, generated form via `createFormView` + `buildFormViewModel`, JSON data pane, EN/NL report-time error localization. Docs, Examples and the other eight playground engines are placeholders linking the current site.

Tests live in `test/webnext/` at the repository root (`npm run test:webnext`) and drive the complete site headless — routing, fetching, form round-trips, localization, SSR — against the same DOM stub the view package uses. Production build: `npm run build` (Vite, no plugins); the site chunk is ~9 kB gzipped, the entire Jaren suite ~64 kB.
