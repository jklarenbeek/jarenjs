# @jarenjs/website

The jarenjs website — **the site is one JSON app document** running on [`@jarenjs/app`](../app) and [`@jarenjs/view`](../view). No React, no framework: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, navigation is plain hash links feeding one subscription, and the play validator's generated form renders through the standard forms stylesheet. The site is its own best demo: everything it claims about the suite, it does with the suite — its own data plane included, since every read of site-owned data resolves through a compiled `$contract` document on [`@jarenjs/contract`](../contract)'s local binding — the same document the build's generators validate their output against, whose revision the docs page prints, and whose `describe()` and OpenAPI/TypeScript projections it renders live.

```bash
npm run dev                  # in this package
npm run site:data            # regenerate public/site/packages.json + public/build.json
npm run benchmark:generate   # refresh public/benchmarks/*.json from the benchmark workspace
npm run deploy               # benchmark:generate + build + gh-pages publish
```

## What it does

- **Play (`#/play`).** The suite's single-engine explorer, hosted from [`@jarenjs/play`](../../components/play): fifteen live engines — JSON Schema (with a two-way generated form and localized errors), JSONPath, JSON Pointer (absolute + relative), JSON Patch (apply / merge / diff), JSON Query, JSLT, JTLT, XQuery, Markdown, MDX, Mermaid, JOSL, CSV, Charts and Contract (a `$contract` document compiled to `describe()`, OpenAPI 3.1, TypeScript and an in-process echo dispatch) — each a pure descriptor + curated examples, run live as a saveable/shareable session, deep-linkable per engine (`#/play?engine=…`) or per example (`?example=…`), calm by default with an opt-in "Explain" drill-down. The site owns **no bespoke engine UI**; it injects the visual renderers, the validator and the operator packs through the package's seams (`src/boundaries/play.js`).
- **The Studio (`#/project`).** The [`@jarenjs/studio`](../../components/studio) project IDE: a `jaren-project` — a small tree of typed files (app / jslt / query / schema / state / data / contract, and the validate-only fsm / dag / model), each validated against its OWN grammar (a `contract` file through `compileContract`, its `describe()` + OpenAPI projections rendered live on the stage) — with a file rail, a pen bar of seed templates, a drag splitter and a live stage. A user- or AI-authored `@jarenjs/app` document is the project's `app` file — state + JSLT view + actions as one JSON value — hosted as an isolated nested app next to the site's own: the jaren-app meta-schema gates every boot, the nested app gets **no effects and no subs**, a structural edit reboots while a state-only edit hot-updates (scroll and inputs survive), and iteration is RFC 6902 patch-based (`jaren_studio_write` / `jaren_studio_patch` / `jaren_studio_read` / `jaren_get_templates` in the assistant toolbox). Three boot-tested seed apps (form + validation, charts dashboard, routed mini-site) ship as one-app project templates beside the multi-file seeds; the app document downloads as JSON. The honest "one prompt → website". The retired `#/studio` URL redirects here.
- **The experiment IDE.** The project surface saves named projects (`localStorage` behind the injected `storage` env); play sessions save through their own store. Legacy experiments still load — a saved studio document opens as a single-app project, and a retired-`#/playground` engine experiment translates into the equivalent play session. The store is plain JSON — exportable, syncable later.
- **Benchmarks, all twenty-one suites.** Overview, the searchable per-test JSON Schema table with a ratio-distribution bar chart, the full JSONPath compliance/profile tables, the JSON Query and JSLT scenario matrices with the actual program sources unfoldable per engine, plus Contracts, Contract dispatch, JSON Pointer, JSON Patch, JOSL/TOML, Formats, CSV, Markdown, Mermaid, View, Charts, Geo, Flow, DB, ORM, Live and Long horizon (what the agent's history compaction keeps and what it destroys, as a model-free ceiling and a live model's score). Data comes from `benchmark/website-data.js` writing into `public/benchmarks/`; ratio > 1 always means "Jaren is N× faster".
- **Docs & Examples.** Thirty-four documentation sections, and neither the list nor most of the content is written here: the site's own sections are a content document (`src/content/docs.js`, kind-nodes — an LLM constrained to the schemas could write these pages), and a package's section is markdown its own workspace commits as `site.md`, collected at build into `public/site/content.json` and rendered through the one shared `@jarenjs/md` component. The curated example library lives in `@jarenjs/play` (the rail on `#/play`). The README rail beside them is **derived, not written**: `scripts/generate-site-data.js` reads the root manifest's `workspaces` and each workspace's own `package.json` into `public/site/packages.json` on every build, and the page renders one button per published workspace from it — so a new package appears here in the commit that adds it, and a test at the repository root fails if it does not.
- **The assistant (the ✦ button).** A bring-your-own-key chat on [`@jarenjs/ai`](../ai) that drives the site through the same schema-guarded tools, with a **ledger** behind it (`src/lib/ledgerStore.js` — one localStorage slot as the package's four-method storage adapter). An objective set in the panel is composed into the prompt of every turn together with the progress recorded against it, and it is read back from the store on the next visit, so a reloaded page continues instead of starting over. Compaction archives every dropped round into an addressed slot before it writes the synopsis, the panel says how many are recallable, and "Remember this session" runs a gated RFC 6902 refinement — the patch engine injected from `@jarenjs/json`, every memory carrying its evidence or being refused.
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
| Generic UI | `src/views/ui.js` | one rule per node kind (`article`/`callout`/`card`/`cards`/`chart`/`code`/`details`/`error`/`more`/`p`/`row`/`search`/`table`) renders every data-driven section |
| Reactivity | `src/app/createSiteApp.js` | one subscriber on the transition **changed-path feed** re-runs the play engine and the Project IDE — debounced, driven by data |
| Generated site data | `scripts/generate-site-data.js`, `scripts/generate-build-info.js` | the package census and the build provenance, written into `public/` at build time and fetched by the `fetch-site` effect; both derive their timestamp from the HEAD commit, so a rebuild of one revision is byte-identical |
| The site's data plane | `src/contracts/site.contract.json`, `src/boundaries/site.js` | every read of site-owned data — the census, the build provenance, the benchmark meta and suites, the repository documents the dialog renders — resolves through one compiled `$contract` on [`@jarenjs/contract`](../contract)'s local binding with output validation on, so an artifact that drifts from the shape the page declares for it settles as a typed refusal instead of a wrong render |
| The same grammar at build time | `scripts/lib/site-contract.js` | the generators compile that same document and prove each payload against the output schema of the operation the site reads it through, before the file is written: a shape the browser would refuse never reaches disk, and the run aborts naming the `JC` code, the contract member and every failing path |
| The document's identity | `src/contracts/site.contract.revision` | one line, `<revision> <class>` — the SHA-256 over the public projection's canonical bytes, and how the change that produced it compares to the one before it. The website suite recomputes both and refuses a document edited without them, so moving the shape of the site's own data plane is a decision, not a diff nobody saw |
| Styling | `src/styles.css` | hand-rolled CSS, light + dark |

Tests live in `test/website/` at the repository root (`npm run test:website`) and drive the complete site headless — routing, the play surface, the IDE round-trip, WebMCP tool execution, benchmark search against the real generated data, SSR — on the same DOM stub the view package uses.

Production build: `npm run build` (Vite, no plugins), two chunks. `jaren-*.js` is exactly the twelve packages `vite.config.js` names — core, json, validate, formats, refs, forms, locales, view, app, md, mermaid, calc — and NOT "the whole suite": the seven the site also depends on (ai, charts, contract, flow, josl, play, studio) are unlisted, so they land in `index-*.js` beside the site's own source. The sqlite worker is a lazy chunk of its own and is in neither. Measure, never estimate:

```bash
npm run build
gzip -c dist/assets/index-*.js  | wc -c   # 222,027 — the site + its unchunked packages
gzip -c dist/assets/jaren-*.js  | wc -c   # 204,351 — the twelve chunked packages
gzip -c dist/assets/index-*.css | wc -c   #  12,239
```

Those three figures are the output of those three lines on the commit that last touched this file; a change to the bundle re-runs them rather than adjusting them.

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
[ROADMAP.md](../../docs/ROADMAP.md); [APP-FORMAT](../app/docs/APP-FORMAT.md) §8.7
states the contracts it will have to prove.
