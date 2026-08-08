# @jarenjs/website

The jarenjs website — **the site is one JSON app document** running on [`@jarenjs/app`](../app) and [`@jarenjs/view`](../view). No React, no framework: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, navigation is plain hash links feeding one subscription, and the play validator's generated form renders through the standard forms stylesheet. The site is its own best demo: everything it claims about the suite, it does with the suite.

```bash
npm run dev                  # in this package
npm run benchmark:generate   # refresh public/benchmarks/*.json from the benchmark workspace
npm run deploy               # benchmark:generate + build + gh-pages publish
```

## What it does

- **Play (`#/play`).** The suite's single-engine explorer, hosted from [`@jarenjs/play`](../../components/play): thirteen live engines — JSON Schema (with a two-way generated form and localized errors), JSONPath, JSON Pointer (absolute + relative), JSON Patch (apply / merge / diff), JSON Query, JSLT, JTLT, XQuery, Markdown, Mermaid, JOSL, CSV and Charts — each a pure descriptor + curated examples, run live as a saveable/shareable session, calm by default with an opt-in "Explain" drill-down. The site owns **no bespoke engine UI**; it injects the visual renderers, the validator and the operator packs through the package's seams (`src/boundaries/play.js`).
- **The Studio (`#/project`).** The [`@jarenjs/studio`](../../components/studio) project IDE: a `jaren-project` — a small tree of typed files (app / jslt / query / schema / state / data), each validated against its OWN grammar — with a file rail, a pen bar of seed templates, a drag splitter and a live stage. A user- or AI-authored `@jarenjs/app` document is the project's `app` file — state + JSLT view + actions as one JSON value — hosted as an isolated nested app next to the site's own: the jaren-app meta-schema gates every boot, the nested app gets **no effects and no subs**, a structural edit reboots while a state-only edit hot-updates (scroll and inputs survive), and iteration is RFC 6902 patch-based (`jaren_studio_write` / `jaren_studio_patch` / `jaren_studio_read` / `jaren_get_templates` in the assistant toolbox). Three boot-tested seed apps (form + validation, charts dashboard, routed mini-site) ship as one-app project templates beside the multi-file seeds; the app document downloads as JSON. The honest "one prompt → website". The retired `#/studio` URL redirects here.
- **The experiment IDE.** The project surface saves named projects (`localStorage` behind the injected `storage` env); play sessions save through their own store. Legacy experiments still load — a saved studio document opens as a single-app project, and a retired-`#/playground` engine experiment translates into the equivalent play session. The store is plain JSON — exportable, syncable later.
- **Benchmarks, all fourteen suites.** Overview, the searchable per-test JSON Schema table with a ratio-distribution bar chart, the full JSONPath compliance/profile tables, the JSON Query and JSLT scenario matrices with the actual program sources unfoldable per engine, JSON Pointer, JSON Patch, JOSL/TOML, Formats, CSV, Markdown, Mermaid, View, Charts and Geo. Data comes from `benchmark/website-data.js` writing into `public/benchmarks/`; ratio > 1 always means "Jaren is N× faster".
- **Docs & Examples.** Twenty-seven documentation sections as a content document (`src/content/docs.js`, kind-nodes — an LLM constrained to the schemas could write these pages), and the curated example library lives in `@jarenjs/play` (the rail on `#/play`).
- **WebMCP.** When the browser exposes `navigator.modelContext`, the site registers its engines as agent tools (`jaren_validate`, `jaren_run_engine`, `jaren_navigate`, the studio's `jaren_project_files`/`_write`/`_run` and `jaren_studio_*`, experiment tools…) — through the same boundaries the UI uses, with every tool input validated against its JSON Schema *by Jaren itself*. No modelContext → no-op. The two working surfaces are covered symmetrically on purpose: `jaren_get_state` answers with the engine panes on `#/play` and with the file tree on `#/project`, so an agent can serve either without guessing at what it cannot see.
- **PWA + mobile.** Installable (manifest + service worker: cached shell and assets, stale-while-revalidate benchmark data — the whole IDE works offline), with a mobile navigation drawer, single-column layouts, touch-sized controls and safe-area insets.

## Architecture

| Concern | Where | How |
|---|---|---|
| State | `src/app/state.js` | one JSON document: route, theme, benchmark cache, the play session, experiments |
| Actions | `src/app/actions.js` | query documents; `route/set` computes its fetch effects with `$if` — orchestration as data |
| View | `src/views/` | one JSLT envelope; pages are **modes**, dispatched via `$.ui.<page>` nodes that only exist for the active route |
| Derivations | `src/app/viewmodel.js` | the APP-FORMAT §5.2 boundary: nav, benchmark render-nodes, the play view model, localized errors |
| Boundaries | `src/boundaries/` | the validator, the play seams, the shared transform runners, benchmark JSON → kind-tagged render nodes, WebMCP |
| Generic UI | `src/views/ui.js` | one rule per node kind (`cards`/`table`/`callout`/`code`/`error`/`details`/`search`/`more`) renders every data-driven section |
| Reactivity | `src/app/createSiteApp.js` | one subscriber on the transition **changed-path feed** re-runs the play engine and the Project IDE — debounced, driven by data |
| Styling | `src/styles.css` | hand-rolled CSS, light + dark |

Tests live in `test/website/` at the repository root (`npm run test:website`) and drive the complete site headless — routing, the play surface, the IDE round-trip, WebMCP tool execution, benchmark search against the real generated data, SSR — on the same DOM stub the view package uses. Production build: `npm run build` (Vite, no plugins); ~39 kB gzipped site chunk (including all example and docs content) + ~67 kB for the entire Jaren suite.

## Browser tests

The headless suite above runs against a DOM stub. `packages/website/e2e/`
additionally runs a **Playwright** suite against the **built** site in real
Chromium, Firefox and WebKit — this package is the repository's production
`createApp` consumer, so it is where the app and view runtimes meet a real
engine's scheduling, event loop and history stack.

```bash
npm run test:browser         # from the repository root: builds the site, then runs all three engines
```

What it asserts: boot with landmark semantics, client-side navigation
mount/unmount lifecycle, keyboard activation of the router, rapid
widget/view route churn with history back, the assistant and studio flows,
and mobile layout — every test also asserting **zero page errors** under
real engine scheduling. The `browser` CI job runs all three engines on
every push.

`e2e/mobile.spec.js` is where the phone contract is pinned, because CSS
is the only thing that can prove it: at 390 × 844 every studio
(`#/play`, `#/project`, `#/flow`, `#/data`) must show **exactly one pane**
behind its segmented switcher, with finger-sized segments and no
horizontal overflow, and the `visualViewport` keyboard seam must reserve
`--kb-inset` under the focused editor. The state half of that protocol —
`data-pane`, `aria-pressed`, and the panes staying mounted while hidden —
is cheaper to assert headlessly and lives in `test/website/panes.test.js`;
the shape itself is written down once in [DESIGN.md](../../docs/DESIGN.md) §5.

> **Local runs on a host without Playwright's shared libraries** (common on
> Fedora-family and other non-Debian distributions) fail at browser launch,
> not in the test. Run the suite inside an Ubuntu container instead — e.g.
> `distrobox enter ubuntu-playwright -- npm run test:browser`. CI uses the
> Playwright image and needs no such workaround.

This suite covers the **lifecycle** half of the app/view real-browser
matrix. The **accessibility** half — dialog focus traps and focus
restoration under an actual screen reader, AT semantics,
`prefers-reduced-motion` — is not covered yet and is tracked in
[ROADMAP.md](../../docs/ROADMAP.md); [APP-FORMAT](../app/docs/APP-FORMAT.md) §8.5
states the contracts it will have to prove.
