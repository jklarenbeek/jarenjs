# @jarenjs/website

The jarenjs website — **the site is one JSON app document** running on [`@jarenjs/app`](../app) and [`@jarenjs/view`](../view). No React, no framework: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, navigation is plain hash links feeding one subscription, and the play validator's generated form renders through the standard forms stylesheet. The site is its own best demo: everything it claims about the suite, it does with the suite — its own data plane included, since every read of site-owned data resolves through a compiled `$contract` document on [`@jarenjs/contract`](../contract)'s local binding — the same document the build's generators validate their output against, whose revision the docs page prints, and whose `describe()` and OpenAPI/TypeScript projections it renders live.

```bash
npm run dev                  # in this package
npm run site:data            # regenerate public/site/packages.json + public/build.json
npm run benchmark:generate   # refresh public/benchmarks/*.json from the benchmark workspace
npm run deploy               # guard + build + gh-pages publish + verify the live site
npm run deploy:remeasure     # the same, RE-MEASURING first — the deliberate path
```

Publishing is guarded at both ends. `predeploy` refuses to build while the tracked
`public/benchmarks/*.json` differ from HEAD: a deploy publishes figures derived from
those files, so they must be the ones a commit carries — the refusal names the two
commands that resolve it. That is why `deploy` no longer re-measures implicitly;
re-measuring as part of publishing is `deploy:remeasure`, opt-in by name, and it is the
only script on the deploy path that runs the benchmarks. `postdeploy` then polls the
published `build.json` until its commit and version match this checkout, retrying while
Pages propagates and failing if they never do — because `gh-pages` reporting success
means the *branch* was pushed, which is not the same as the site being live.

## What it does

- **Play (`#/play`).** The suite's single-engine explorer, hosted from [`@jarenjs/play`](../../components/play): fifteen live engines — JSON Schema (with a two-way generated form and localized errors), JSONPath, JSON Pointer (absolute + relative), JSON Patch (apply / merge / diff), JSON Query, JSLT, JTLT, XQuery, Markdown, MDX, Mermaid, JOSL, CSV, Charts and Contract (a `$contract` document compiled to `describe()`, OpenAPI 3.1, TypeScript and an in-process echo dispatch) — each a pure descriptor + curated examples, run live as a saveable/shareable session, deep-linkable per engine (`#/play?engine=…`) or per example (`?example=…`), calm by default with an opt-in "Explain" drill-down. The site owns **no bespoke engine UI**; it injects the visual renderers, the validator and the operator packs through the package's seams (`src/boundaries/play.js`).
- **The Studio (`#/project`).** The [`@jarenjs/studio`](../../components/studio) project IDE: a `jaren-project` — a small tree of typed files (app / jslt / query / schema / state / data / contract, and the validate-only fsm / dag / model), each validated against its OWN grammar (a `contract` file through `compileContract`, its `describe()` + OpenAPI projections rendered live on the stage) — with a file rail, a pen bar of seed templates, a drag splitter and a live stage. A user- or AI-authored `@jarenjs/app` document is the project's `app` file — state + JSLT view + actions as one JSON value — hosted as an isolated nested app next to the site's own: the jaren-app meta-schema gates every boot, the nested app gets **no effects and no subs**, a structural edit reboots while a state-only edit hot-updates (scroll and inputs survive), and iteration is RFC 6902 patch-based (`jaren_studio_write` / `jaren_studio_patch` / `jaren_studio_read` / `jaren_get_templates` in the assistant toolbox). Three boot-tested seed apps (form + validation, charts dashboard, routed mini-site) ship as one-app project templates beside the multi-file seeds; Download preserves the complete project as JSON; App JSON exports the designated app separately. Autorun can be disabled, nested-app errors appear on the stage, and all three layouts can be resized. The honest "one prompt → website". The retired `#/studio` URL redirects here.
- **The experiment IDE.** The project surface saves named projects (`localStorage` behind the injected `storage` env); play sessions save through their own store. Legacy experiments still load — a saved studio document opens as a single-app project, and a retired-`#/playground` engine experiment translates into the equivalent play session. The store is plain JSON — exportable, syncable later.
- **Benchmarks, all twenty-five suites.** Overview, the searchable per-test JSON Schema table with a ratio-distribution bar chart, the full JSONPath compliance/profile tables, the JSON Query and JSLT scenario matrices with the actual program sources unfoldable per engine, plus Contracts, Contract dispatch, JSON Pointer, JSON Patch, JOSL/TOML, Formats, CSV, Markdown, Mermaid, View, Charts, Geo, Flow, DB, ORM, Live, Long horizon (what the agent's history compaction keeps and what it destroys, as a model-free ceiling and a live model's score), Retrieval (whether the ledger's recall puts the right memory in the prompt — recall@k and MRR per policy over a synthetic corpus, against an oracle ceiling) Vector (k-nearest over a stored vector column every physical way it runs, against sqlite-vec, with what the column costs to write and the brute-force ceiling as numbers) and Series (one range, one bucketing, one rolling window and one as-of read answered by plain references, by a generic query document and by stock SQLite over a declared epoch column — the temporal ground, published before a kernel exists so a later fast path arrives with a number to beat). Data comes from `benchmark/website-data.js` writing into `public/benchmarks/`; ratio > 1 always means "Jaren is N× faster".
- **Docs & Examples.** <!--fact:site.documentation-->28 documentation sections<!--/fact-->, and neither the list nor almost any of the content is written here: four sections only the site can answer are a content document (`src/content/docs.js`, kind-nodes — an LLM constrained to the schemas could write those pages), and every other section is markdown the package's own workspace commits as `site.md`, collected at build into `public/site/content.json` and rendered through the one shared `@jarenjs/md` component. The engine grid on the home page is collected the same way: each card is written by the workspace that publishes the engine, so an engine reaches the site in its own package's commit — and because that page shows no documentation body, it reads `public/site/cards.json`, the same entries with the markdown left out, which is an order of magnitude fewer bytes. The curated example library lives in `@jarenjs/play` (the rail on `#/play`). The README rail beside them is **derived, not written**: `scripts/generate-site-data.js` reads the root manifest's `workspaces` and each workspace's own `package.json` into `public/site/packages.json` on every build, and the page renders one button per published workspace from it — so a new package appears here in the commit that adds it, and a test at the repository root fails if it does not.
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
| The site's data plane | `src/contracts/site.contract.json`, `src/boundaries/site.js` | every read of site-owned data — the census, the workspaces' own content and its cards-only projection, the build provenance, the benchmark meta and each suite, the repository documents the dialog renders — resolves through one compiled `$contract` on [`@jarenjs/contract`](../contract)'s local binding with output validation on, so an artifact that drifts from the shape the page declares for it settles as a typed refusal instead of a wrong render. Each of the twenty-three benchmark suites has its OWN shape in that document and `bench.suite` answers exactly one of them: closed at the root and over every record the page iterates, open where the page stops reading. Those shapes cost **3,760 bytes gzipped** of the main bundle (measured: build with and without them), and they stay there deliberately — the client is opened at boot and the footer reads the build provenance on every page, so the document cannot be code-split behind `#/benchmarks`, and splitting it in two to merge later would make `revision()` depend on when it is asked, which is the one thing the pin exists to prevent |
| The same grammar at build time | `scripts/lib/site-contract.js` | the generators compile that same document and prove each payload against the output schema of the operation the site reads it through, before the file is written: a shape the browser would refuse never reaches disk, and the run aborts naming the `JC` code, the contract member and every failing path |
| The document's identity | `src/contracts/site.contract.revision` | one line, `<revision> <class>` — the SHA-256 over the public projection's canonical bytes, and how the change that produced it compares to the one before it. The website suite recomputes both and refuses a document edited without them, so moving the shape of the site's own data plane is a decision, not a diff nobody saw |
| Package-owned content | `scripts/generate-site-data.js`, `public/site/content.json`, `public/site/cards.json` | the engine cards and documentation sections are not authored here: each workspace commits a `site.md` — frontmatter against `schemas/site-document.schema.json`, body parsed by [`@jarenjs/md`](../../components/md) — which the build collects in census order. A workspace with no document degrades to a manifest-derived card, so a half-migrated repository renders honestly, and a new package reaches the site in its own commit with zero edits here. The cards artifact is a PROJECTION of the collected content, never a second collection of it |
| Repository document navigation | `src/boundaries/markdown.js`, `src/app/createSiteApp.js` | relative Markdown links stay in the README dialog; cross-document fragments travel in its back/forward history, fetch the document without the fragment, and scroll to the decoded heading after rendering |
| One renderer, three provenances | `src/boundaries/markdown.js` | one `@jarenjs/md` component renders repo READMEs, the packages' own site documents and assistant/user text, and each call names which it is: heading ids are minted bare for the repository's own documents and `user-content-` prefixed for everything else, because ids are this page's namespace |
| Motion | `src/styles.css` (the tokenized layer), `src/lib/motion.js` | three families — a page entrance on route swap, cards rising in on first view, measured headlines counting up — every one behind `prefers-reduced-motion: no-preference`, where `reduce` means instant final states rather than slower motion. The browser half installs from `afterRender` through a host capability and is the only thing on the site that knows an `IntersectionObserver` exists, so the headless render never sees an intermediate value |
| Styling | `src/styles.css` | hand-rolled CSS, light + dark |

Tests live in `test/website/` at the repository root (`npm run test:website`) and drive the complete site headless — routing, the play surface, the IDE round-trip, WebMCP tool execution, benchmark search against the real generated data, SSR — on the same DOM stub the view package uses.

## Every fact is derived, gated, or pinned

Nothing on this site is a number somebody typed. A figure is one of three things,
and there is no fourth:

- **derived at runtime** from the generated JSON — every benchmark headline, the
  compliance scorecards, the suite counts, the contract's live operation table and
  its 64-hex revision;
- **generated at build** — the package census from the root manifest's `workspaces`
  and each workspace's own `package.json`, the build provenance from the HEAD
  commit, the collected site documents;
- **hand-written and pinned by a test that fails on drift**, where deriving it would
  cost bundle for no reader benefit — the binding capability table, the render-node
  kinds, the suite and section counts, the Node floor, the bundle figures above.
  `test/website/claims.test.js` holds each against the thing it describes: edit a
  documented cell without editing the code behind it and it fails; add a capability
  without documenting it and it fails too.

Authored prose carries voice, never numbers — the site-document grammar refuses a
digit in a card's `perf` line outright — and a claim that can be neither derived nor
pinned is removed rather than left standing. Published losses stay published beside
the wins: the contract benchmark's honest 2.4–7.5× band against a harness-free rival,
the JSONPath README figure that fell from 23.1× to 8.8× under one derivation, and each engine's
conformance score includes the tests its competitor could not compile.

Production build: `npm run build` (Vite, no plugins), with two main chunks. `jaren-*.js` is exactly the twelve packages `vite.config.js` names — core, json, validate, formats, refs, forms, locales, view, app, md, mermaid, calc — and NOT "the whole suite": the seven the site also depends on (ai, charts, contract, flow, josl, play, studio) are unlisted, so they land in `index-*.js` beside the site's own source. The sqlite worker is a lazy chunk of its own and is in neither. Measure, never estimate:

```bash
npm run build
gzip -c dist/assets/index-*.js  | wc -c   # the site + its unchunked packages
gzip -c dist/assets/jaren-*.js  | wc -c   # the twelve chunked packages
gzip -c dist/assets/index-*.css | wc -c
```

These commands measure the current build; release records carry their output rather than preserving stale sizes here.

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
mobile layout, and the motion contract — every test also asserting **zero
page errors** under real engine scheduling. The `browser` CI job runs all
three engines on every push.

`e2e/project-kinds.spec.js` covers the embedded Flow editor, fragment state
hot-updates, private model workers, query plans and live commits.
`e2e/project-offline.spec.js` downloads and unzips the actual export, serves
it locally with external requests blocked, and runs both an app and SQLite.
`e2e/view-runtime.spec.js` tests safe DOM/SSR reflection, composition and caret
settlement, multiple selects, adopted fragment roots and SVG namespaces.
Composition events are automated; native OS IME and actual screen-reader
audits remain open.

The **Offline ZIP** runtime is generated by `site:data` during dev/build from
the installed dependencies. It bundles its JavaScript, CSS, fonts and SQLite
worker/WASM under `public/studio-offline`, with a manifest and version record.
No CDN is required by the runner. Authored external URLs remain external, and
only source files and explicit seeds are exported, not live rows or settings.

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

`e2e/motion.spec.js` pins the other thing only a real engine can answer:
that the site moves, and that it stops when the reader asks. Under an
emulated `no-preference` a card below the fold waits at its pre-view state
and reaches its final transform when scrolled to, a measured headline
counts up and lands on exactly the string the renderer published, and
neither a scroll that flies past a card nor a disclosure that opens can
leave content unpainted; under an emulated `reduce` every surface carries
its final state on first paint, with `animation-name: none` and nothing
counting. The vocabulary those tests assert is written down once in
[DESIGN.md](../../docs/DESIGN.md) §6.

This suite covers the **lifecycle** half of the app/view real-browser
matrix, plus the `prefers-reduced-motion` half of the accessibility one.
What is still uncovered is assistive technology itself — dialog focus
traps and focus restoration under an actual screen reader, and AT
semantics — tracked in [ROADMAP.md](../../docs/ROADMAP.md);
[APP-FORMAT](../app/docs/APP-FORMAT.md) §8.7 states the contracts it will
have to prove.

The data studio selects isolated SharedArrayBuffer OPFS, SAH-pool OPFS, atomic
IndexedDB snapshots or visibly non-durable memory through runtime write/reopen
probes. IndexedDB writes await durable acknowledgement and explicitly disable live
maintenance. The isolated Playwright preview sets COOP/COEP on a second server;
production headers remain host-controlled. See the [database host matrix](../db/docs/HOSTS.md)
for evidence, failure behavior and measurement recipes.

Only the owning tab can recreate or migrate the studio's store. Client tabs
attach to its active model; reopening announces that model and renews each tab's
live subscription. Store and host failures retain their message and stringify
numeric error codes. Web Locks identify an owner even while its worker is busy;
without them, a held OPFS access handle triggers a longer discovery retry and a
specific refusal if no owner answers, instead of selecting private memory.


## Assistant ledger persistence

The assistant's JSON ledger slot uses Web Locks when available. It reloads inside
the shared lock and retains that lock through localStorage's task publication
boundary, including Firefox. Chromium and Firefox tabs preserve independent minted ids
and progress; WebKit elects one writer, as described below. Hosts without locks report single-writer mode in the assistant.
Quota, denied locks and corrupt slot contents surface as persistence failures;
a failed atomic write never overwrites the last durable ledger.

The ledger supports host-set archive/goal limits through `createLedger` and reports
every eviction with durable tombstones. The assistant shows retention decisions,
and conversation clear removes archived rounds, indexes and tombstones together.
The active goal and learned memories survive conversation clear. Bounds are opt-in;
the site's default configuration does not assume a universal browser quota.


WebKit host limit: the measured localStorage process caches can remain stale after
an exclusive Web Lock and task boundary. The adapter therefore elects one owner
with a lifetime Web Lock on WebKit, refuses other tabs before reading or writing,
and permits takeover after the owner closes. `storage.status()` reports
`single-writer`; its atomic mutation capability still protects accepted batches.
Chromium and Firefox use serialized concurrent writers. Hosts can explicitly
request owner election with `singleWriter: true`; overriding it requires a storage
slot whose cross-writer coherence the host has established. Browser-engine detection
is a conservative host policy, not a Web Locks guarantee. `storage.close()` releases
ownership deliberately. No fixed delay is treated as a cure for WebKit coherence.
