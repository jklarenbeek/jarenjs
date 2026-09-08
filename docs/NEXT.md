# NEXT — the SUITE campaign, starting point

The monorepo restructure, as the operator settled it. A router and its work
orders are authored from this file by the process in
[workflow/CAMPAIGN.md](workflow/CAMPAIGN.md): §1–§3 are the charter and the
decisions the router carries verbatim, §4–§5 the structural census and the
seams it may copy under its *do not re-derive* heading, §6–§7 the order list
and its sequencing, §8 the forks the router closes with the operator before an
order is written, §9–§10 the definition of done and the boundaries.

This file is retired by the close-out order. What is durable about the shape
moves into [workflow/CONVENTIONS.md](workflow/CONVENTIONS.md) §1,
[ARCHITECTURE.md](ARCHITECTURE.md) and [CONSUMING.md](CONSUMING.md); this
file is then deleted, not kept as history.

## 1. Charter

Cut the suite along the seams the code already has, and put every program in
one place. The three JSON languages become three names. The validator becomes
the whole validation story under one name. The two programs — the GitHub Pages
site and the `jaren` command — live under `apps/`. The flow studio becomes a
visual component beside the others. No compatibility layer remembers the old
names.

> **North star:** a stranger reads the tree and knows what every name is,
> installs one name and gets nothing they did not ask for, and runs one command
> for everything the suite does from a shell.

End state, in one sentence: `apps/` holds `cli` and `pages`, `packages/` holds
the libraries with `json`, `query` and `jslt` as three packages and `validate`
carrying `./formats` and `./refs`, `components/` holds the seven visual
components including `flowstudio`, and every list, path and dependency range in
the repository is derived from the workspace manifests rather than typed.

## 2. The end state

```text
jarenjs/
  apps/
    cli/            @jarenjs/cli      public    bin: jaren
    pages/          @jarenjs/pages    private   the GitHub Pages site
  packages/
    core/  json/  query/  jslt/  validate/  locales/  emit/  forms/
    view/  app/  flow/  contract/  db/  linq/  josl/  ai/
  components/
    md/  mermaid/  charts/  calc/  play/  studio/  flowstudio/
  benchmark/  test/  docs/  scripts/
```

| Today | After | What changes |
|---|---|---|
| `packages/website`, `@jarenjs/website` (private) | `apps/pages`, `@jarenjs/pages` (private) | moved and renamed; still built by vite and published by gh-pages under `/jarenjs/`; `test/website` becomes `test/pages` |
| `jaren-emit`, `jaren-db`, `jaren-contract` — a `bin` and a `cli.js` inside emit, db and contract | `apps/cli`, `@jarenjs/cli` (public), one bin `jaren` | `jaren emit`, `jaren db …`, `jaren contract …` plus the engine commands of §8; the three libraries lose their `bin` and `cli.js` |
| `@jarenjs/json` — addressing, query, xquery, jslt, jtlt in one package | `@jarenjs/json` (addressing), `@jarenjs/query` with `./xquery` and `./engine`, `@jarenjs/jslt` with `./jtlt` | three packages; `test/json` splits the same way |
| `@jarenjs/validate`, `@jarenjs/formats`, `@jarenjs/refs` | `@jarenjs/validate` with `./formats`, `./refs`, `./refs/draft-06`, `./refs/draft-07`, `./refs/draft-2019-09`, `./refs/draft-2020-12` | one package; the root entry imports neither subpath; `test/formats` and `test/refs` move under `test/validate` |
| the site's `#/flow` page — its boundary, view, seed templates, actions and styles | `components/flowstudio` (name: fork F1) | the site becomes one host of the component |
| `components/*` | unchanged | stays the home of visual components |
| every other package | unchanged name and folder | imports rewritten to the new names |

Workspaces after: 24 public (16 packages, 7 components, the CLI) and 2 private
(pages, benchmark). Today: 22 public and 2 private.

## 3. Settled decisions (the router's D-numbers)

Settled by the operator. The router carries them verbatim under these numbers;
an executor who disagrees records the conflict in the session record and does
not act on it.

**D1 — `apps/` holds programs.** A workspace with an entry point a person runs
— a site, a command — lives under `apps/`; `packages/` and `components/` hold
libraries. Publish status is a manifest fact, not a folder fact: `pages` is
private, `cli` is public. Never put a library under `apps/`, and never put a
`bin` under `packages/` or `components/`.

**D2 — `pages` is the static GitHub Pages site, and only that.** The rename
says what the workspace is deployed as. A server-backed site is a future
sibling under `apps/`; nothing in this campaign prepares for it beyond the
rename. Never add a server, a backend, an API route or a second deploy target
in this campaign.

**D3 — `components/` stays and holds visual components only.** A component is
a document format with its headless engine and its renderable layer under
`src/component`, carrying a format document, a stylesheet and a `site.md`.
Never fold a component into `packages/`, and never put a non-visual library
under `components/`.

**D4 — the flow studio becomes a component.** Everything `#/flow` is today —
the projection chain from document to mermaid text to decorated vnode, the
text round-trip loss reasons, the forms-generated inspector, the run runtime
(the nested app and the dag runner), the seed templates, the `flow/*` actions
and the `.flow-*` styles — ships from `components/flowstudio`, and the site
hosts it the way it hosts `@jarenjs/play` and `@jarenjs/studio`. Never leave a
second copy of any of it in the site.

**D5 — `@jarenjs/validate` is the whole validation story.** formats and refs
become its `./formats` and `./refs` subpaths and cease to exist as packages.
The root entry, `./query` and `./normalize` import neither subpath; formats are
registered by the caller exactly as `addFormats` and `ValidatorOptions` take
them today. A bundle of `JarenValidator` alone carries no formats module and no
meta-schema, and the tree-shaking gate proves it on every run. Never register a
format or a meta-schema by default, and never import `./formats` or `./refs`
from any other subpath of the package.

**D6 — `jaren` is the suite's one command.** `@jarenjs/cli` owns argv, files,
stdio, the TTY and exit codes, and nothing else: every command is a door over a
published subpath, and the exit convention every command shares is the one the
three commands already agree on — 0 what you asked for holds, 1 it does not, 2
you asked for the wrong thing. The three existing commands move in with their
subcommands, flags, outputs and exit codes; the document loader that only they
use moves in with them (fork F3). Never put engine logic in the CLI, never keep
a `bin` in a library, and never add a Node-only module to a library that only
the CLI needs — a library's `./node` subpath exists when tests, benchmarks or
consumers use it, as `@jarenjs/db/node` is.

**D7 — no compatibility layer.** No barrel, shim, alias bin, re-export or
deprecation window for a name this campaign moves; the old name stops existing
in the same order that creates the new one. The published packages are at
0.56.0 with no known consumer, so the first release after close-out is a minor
under the PUBLISHING policy and nothing more. Never add a compatibility
re-export "for one release".

**D8 — the language split.** `@jarenjs/json` keeps basic, canonical, pointer,
path, patch and write, and promotes `./segments` and `./errors` as documented
subpaths. `@jarenjs/query` takes the query engine, the XQuery text front-end as
`./xquery`, the query schemas, and exposes `./engine` — compile, normalize,
runtime, errors and the nodes-mode segment runner — as the one subpath a
dependant may consume engine internals through. `@jarenjs/jslt` takes JSLT,
JTLT as `./jtlt`, the option-variants cache and the JSLT schemas, and depends
on json and query. The GeoJSON schema artifacts stay in json so `@jarenjs/ai`
gains no edge. Never import a query internal from anywhere but `./engine`, and
never grow a fourth language package: xquery and jtlt are front-ends and ride
along.

**D9 — core and ai stay whole.** The heaviest consumer of core's domain
subpaths is the query operator table itself, so splitting core would give
`@jarenjs/query` six dependencies for isolation that subpath exports and
`sideEffects: false` already give a bundler. ai's layers are visible enough as
folders. Never split either in this campaign.

**D10 — workspace edges are names, never paths.** `file:` links leave the
pages manifest; a private workspace ranges its `@jarenjs/*` dependencies as
`*`, a public one as the shared version. Never write a path into a dependency
range.

**D11 — every list of workspaces is derived from the root `workspaces` field.**
The version script, `clean`, the pack check, `publish`, the site census, the
coverage includes and the lint overrides read the manifests; the existing drift
test then proves the derivation instead of policing a copy. Never add a second
hand-maintained list of workspaces or paths.

**D12 — relocation is not redesign.** The orders that move files rewire
imports and paths and nothing else: asserted values, fixtures, error codes,
messages and emitted bytes stay identical, and the only permitted edit to a
test is an import path or a spawned path (the REFACTOR non-negotiables). New
capability — the CLI's engine commands, the component's host contract — lives
only in the orders that say so. Never change behavior in a move order.

## 4. Census — structural, 2026-09-08, tree 33d13030, Node 24.20.0

Counts from the tree, not from a run: every `@jarenjs/*` specifier in
`packages`, `components`, `test`, `benchmark`, `scripts` and `src`, with the
submodules, `dist` and `node_modules` excluded. The router copies these under
its *do not re-derive* heading. The scoped quirk hunt over the packages in
scope is **not done**; it is the router author's first act.

**What the language split moves** (lines of `packages/json/src`):

| Slice | Lines | Goes to |
|---|---|---|
| basic, canonical, pointer, path, patch, write, cow, segments, errors, node | 5,484 | json (node: the CLI, fork F3) |
| query | 6,767 | query |
| xquery | 1,666 | query `./xquery` |
| jslt | 1,838 | jslt |
| jtlt | 627 | jslt `./jtlt` |

**Import traffic the split rewrites** (specifiers, whole repository):

| Specifier | Count |
|---|---|
| `@jarenjs/json/query` | 88 |
| `@jarenjs/json/jslt` | 48 |
| `@jarenjs/json/jtlt` | 14 |
| `@jarenjs/json/xquery` | 5 |
| `@jarenjs/json` root, of which files pulling query symbols | 32, of which 8 |
| `@jarenjs/json/node` | 4 (two CLIs, two tests) |
| `@jarenjs/formats` | 46 |
| `@jarenjs/refs` | 10 |

**Where the site's position is written down:**

| Literal | Files |
|---|---|
| `packages/website` | root manifest, eslint config, gitignore, 8 scripts, 2 benchmark files, 34 test files, 7 docs, the root README |
| `components/` | 4 scripts, 2 benchmark files, 17 test files, 7 docs |
| relative imports into `packages/website/src` | 77, from `test/website`, `test/app` and `test/docs` |
| `file:` dependency links in the site manifest | 20 |

**The flow studio, in the site today:** 948 lines across its boundary, its view
and its seed templates; 35 `flow/*` actions in the site's action table; 27
`.flow-*` style rules in the site stylesheet; a `flow-mint` effect, the
`flow-doc` widget and the runtime's effects wired in the site's app factory; one
headless test file and one three-engine e2e spec.

**The CLI capability, scattered today:**

| Piece | Where | Size |
|---|---|---|
| `jaren-emit` (typescript and markdown targets, `--check`) | `packages/emit/src/cli.js` | 208 lines |
| `jaren-db` (plan, snapshot, status, apply, check, shape, documents; interactive confirm) | `packages/db/src/cli.js` | 551 lines |
| `jaren-contract` (describe, public, openapi, types, docs, diff; `--check`, `--fail-on`) | `packages/contract/src/cli.js` | 269 lines |
| the document loader (a `.json` file or a pure module evaluated twice) | `@jarenjs/json/node` | used by the db and contract commands only |
| the JSON and JSONL document readers and the atomic writer | `@jarenjs/db/node` | stays: tests and benchmarks use it |
| three argv parsers, three `fail`/`misuse` pairs, three usage texts | the three files above | one of each after |

**Leftovers the campaign removes:** the root bundle entry `src/index.js` with
`esbuild.config.js` and `build:jaren`; nine `@jarenjs/*` dependencies on the
root manifest; a `turbo` devDependency with no configuration; the five
hand-maintained workspace lists (`clean`, `pack:check`, `publish`, the version
script's manifest list, the lint `no-console` file list).

**Published state:** npm carries the suite at 0.56.0; the tree is at 0.65.1.

## 5. The seams the orders build on (verified in the code)

- **json internals.** `segments.js` is shared by pointer, path, patch and
  write, by three query modules and by the JSLT dispatcher; `cow.js` is
  addressing-only; `errors.js` is the base of every language's errors;
  `option-variants.js` is used by jslt and jtlt only. JSLT imports five query
  internals directly (compile, normalize, runtime, errors, the package index)
  and JTLT imports the normalizer. Order 03's `./engine` subpath is exactly that
  set; nothing else blocks the split.
- **validate and formats never import each other.** validate imports core, json
  and its own `./query`; formats imports core and the json root (the `json-path`
  format runs the real JSONPath parser); refs imports core only. The merge adds
  no edge and creates no cycle.
- **The three commands need no new export.** Every symbol they use is already
  public: `@jarenjs/emit`; `@jarenjs/db` and `@jarenjs/db/node` (which
  re-exports the document files); `@jarenjs/contract`, `./diff` and
  `./project`, the last loaded lazily for `types` and `docs` so a command that
  never projects never loads emit.
- **The site's component convention.** A published component exports a
  `createXComponent(options)` factory handing the host its JSLT `rules`, `mode`,
  `modes`, `viewModel` and engine surface; the site wires the reducer actions
  and mounts the widget through one shared `mount`/`update`/`unmount` lifecycle
  (`boundaries/host-widget.js`, written because the flow studio was the third
  caller). The site's pane switcher, editor textarea and error line are
  mirrored, not imported, by published components, so each stands alone.
- **The gates already hold the shape.** All 22 public packages declare
  `sideEffects: false`; the tree-shaking gate already proves three separations
  (a pointer bundle carries no query module, the contract root carries no emit,
  the default calendar carries no `Intl` provider); the workspace drift gate
  pins the README table, the PUBLISHING list, the ARCHITECTURE table and the
  CONSUMING partition to the public manifests; the version-script drift gate
  pins its hand list to the manifests; the site census reads the root
  `workspaces` field in order and skips private ones.

## 6. Orders

| # | Scope | Size | Deploys |
|---|---|---|---|
| 01 | Root and pages: move the site to `apps/pages`, rename the site scripts and `test/website`, move the site-only scripts with it (fork F4), replace `file:` links, derive every workspace list, delete the root leftovers, sweep the path literals | L | no |
| 02 | CLI scaffold: `apps/cli` with one bin, one parser, one loader and the three commands moved verbatim; `@jarenjs/json/node` moves in (fork F3); the libraries lose `bin` and `cli.js`; the subprocess tests move to `test/cli` | M | no |
| 03 | `@jarenjs/query`: promote `./segments` and `./errors` on json, add `./engine`, move query and xquery with their schemas, docs, tests and benchmarks, rewrite imports | L | no |
| 04 | `@jarenjs/jslt`: move jslt, jtlt, the option-variants cache and the JSLT schemas with their docs, tests and benchmarks, rewrite imports; the json root exports addressing only | M | no |
| 05 | validate absorbs formats and refs: subpaths, the root-bundle probe in the tree-shaking gate, consumers rewritten, linq's optional peers reduced, docs folded | M | no |
| 06 | CLI engine commands (fork F2): validate, query, jslt, jtlt, xquery, path, pointer, patch, josl, csv, md, mermaid; an in-process `run(argv, io)` behind the bin; the CLI's `site.md` | L | no |
| 07 | `components/flowstudio`: engine, component, stylesheet, format document, `site.md`; the site rewired to host it; its actions, effects, widget and styles leave the site; the headless test splits, the e2e spec stays with the site | L | yes |
| 08 | Close-out: docs sweep, gates extended, measurements re-derived, ROADMAP narrowed, the scoped quirk hunt over what was built, this file retired | M | yes |

Phases: A is 01–02 (relocation), B is 03–05 (boundaries), C is 06–07
(capability), D is 08. Every order is a breaking change for a consumer, so the
version policy applies unchanged: a minor bump opens each phase, a patch per
order. Publishing to npm is the operator's act after 08 and is not an order.

Three orders carry new capability and each opens with a Step 0 that
re-measures the surface it touches, because the order before it moved that
surface: 06 re-derives the subpath names it imports, 07 the site's action table
and stylesheet, 08 every figure it publishes.

## 7. Sequencing

- **01 first.** Every later order adds or moves a workspace. With the lists
  derived and the site at its final path, each later order edits the root
  manifest once (the `workspaces` field) and sweeps paths once, against final
  paths.
- **02 before 03.** The subprocess tests pin the three commands' behavior before
  the packages beneath them move, and the loader leaves json before json is
  cut.
- **03 before 04.** JSLT consumes the query engine through the `./engine`
  subpath 03 creates and documents.
- **04 before 05.** 04's import sweep touches validate's consumers (emit, forms,
  contract, linq); the merge lands on a settled graph.
- **05 before 06 and 07.** `jaren validate` targets `./formats` and `./refs`,
  and the component imports jslt and `validate/formats`; both import final
  names once. 07 is also the order that changes the site most, so it runs on a
  site nothing else is moving.
- **08 last.** Documents are written when what they document has stopped
  moving; the quirk hunt runs over the finished capability.

## 8. Forks the router closes with the operator first

Each fork changes an order's design; none changes the order list. The
recommendation is stated so the exchange is one answer.

- **F1 — the component's name.** `@jarenjs/flowstudio` under
  `components/flowstudio` (recommended: it is what the site already calls it,
  and it sits beside `studio`), or another name. `@jarenjs/flow` is taken by the
  engine.
- **F2 — the CLI command set of order 06.** The full table below (recommended:
  the command exists to make every engine reachable from a shell), or the three
  moved commands plus validate, query and jslt only.
- **F3 — the document loader's home.** Move `@jarenjs/json/node` into the CLI
  (recommended: json becomes free of `node:` imports and the loader has no other
  consumer), or keep it published for consumers scripting their own tools.
- **F4 — the site-only scripts.** Move generate-site-data, generate-build-info,
  check-sw-cache, check-site-design, check-benchmark-drift, verify-live-site
  and the site-contract helper under `apps/pages/scripts` (recommended: they
  build or check one workspace), or leave them in `scripts/` with rewritten
  paths.
- **F5 — the flow studio and the studio.** Build the component standalone now
  (recommended), with its run pane written to work under the studio's
  isolation boundary — widgets and `compileTypeTest`, no effects and no
  subscriptions — so the open ROADMAP entry "the flow editor is not in the
  studio" narrows to hosting this component per kind; or fold the editor into
  `@jarenjs/studio` directly and skip the component. The second reading makes
  07 a studio order and leaves the site's `#/flow` as it is.

The engine commands of order 06, for F2:

| `jaren` command | Door | Reads and writes |
|---|---|---|
| `emit`, `db …`, `contract …` | `@jarenjs/emit`; `@jarenjs/db`, `@jarenjs/db/node`; `@jarenjs/contract`, `./diff`, `./project` | as today, byte for byte |
| `validate` | `@jarenjs/validate`, with `./formats`, `./refs` and a `@jarenjs/locales` pack on request | a schema and a document, file or stdin; errors as JSON, localized on request |
| `query` | `@jarenjs/query`, schema literals through `@jarenjs/validate/query`, operator packs on request | a query document, a document, externals |
| `jslt`, `jtlt` | `@jarenjs/jslt`, `./jtlt` | a stylesheet and a document; jtlt writes text |
| `xquery` | `@jarenjs/query/xquery` | an expression and a document; `--to-query` prints the compiled query document |
| `path`, `pointer`, `patch` | `@jarenjs/json` | a selector or pointer and a document; patch applies, diffs and merges |
| `josl`, `csv` | `@jarenjs/josl`, `./csv` | josl, toml, jsonx and json in either direction; csv strict or repair, typed, dialect sniffed |
| `md`, `mermaid` | `@jarenjs/md`, `@jarenjs/mermaid`, `@jarenjs/view` for the string renderer | text in; AST, HTML or SVG, or canonical text out |

Every command reads `-` as stdin, prints usage on `--help`, and shares the
`--out` and `--check` drift idiom the emit and contract commands already have.
The CLI depends on core, json, query, jslt, validate, locales, emit, contract,
db, josl, md, mermaid and view; it does not depend on ai, app, forms, play or
studio.

## 9. Definition of done (program-wide)

- The tree of §2 exists, every workspace resolves by name, and `npm run
  release:check` is green on Linux and Windows.
- No `bin` outside `apps/cli`; no `node:` import in `@jarenjs/json` (given F3);
  no `packages/website` or `file:` literal anywhere; no hand-maintained
  workspace list.
- `@jarenjs/json` exports addressing only; `@jarenjs/validate` exports the
  validator, `./query`, `./normalize`, `./formats` and `./refs`; the old package
  names and subpaths resolve nowhere.
- Gates extended, each proven by a failing case first: the tree-shaking gate
  carries a `JarenValidator` root probe (no formats module, no meta-schema) and
  a query-package probe replacing the pointer bundle's `/query/` check; the
  workspace drift gate additionally asserts that every `packages/`,
  `components/` or `apps/` path a committed document names exists on disk; the
  packed-consumer gate runs `jaren --help` from the installed tarball; the
  dead-code audit instruments `apps/*/src`; the documented-count gate knows the
  seventh component.
- Documents say the new shape and only the new shape: CONVENTIONS §1 (the repo
  model, the dependency arrow, and the two-layer sentence repaired to what play,
  studio and flowstudio actually do), §2 and §6; ARCHITECTURE's layout graph and
  table; the README table; the PUBLISHING list; CONSUMING's package selection
  and vendoring recipe; HOWTO's installation and lightweight sections; DESIGN,
  SECURITY and REFACTOR paths. Every public README, the three new packages
  included, carries its derived export inventory, and every public workspace
  commits a `site.md`.
- Measurements re-derived, not retyped: the per-subpath bundle prices in
  CONSUMING for the new names, and HOWTO's hand-typed bundle-size table either
  derived through the figure gate or removed.
- ROADMAP narrowed: the studio entry on the flow editor states the hosting of
  the component per kind; nothing the campaign shipped remains listed as open.
- The close-out record puts the census of §4 beside the final counts, and this
  file is deleted.

## 10. Out of scope

- Splitting `@jarenjs/core` or `@jarenjs/ai` (D9).
- A server, a backend or a second deploy target for the site (D2).
- Turning the `#/data` studio, the assistant or the game into components.
- Free-form geometry or persisted layout in the flow editor; composing a
  machine and a dataflow into one document.
- Any behavior change in an engine, a format or a validator, and any change to
  a published document format.
- Publishing to npm; the operator publishes after the close-out.
