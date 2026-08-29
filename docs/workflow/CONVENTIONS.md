# Workflow conventions — the rules, once

The rules that bind every session that changes this repository: an executor
running a work order, a [`CAMPAIGN.md`](CAMPAIGN.md) author, a
[`REFACTOR.md`](REFACTOR.md) or [`QUIRKS.md`](QUIRKS.md) pass, and the operator
running [`PUBLISHING.md`](PUBLISHING.md). The playbooks in this folder point
here instead of restating; [`BOOTSTRAP.md`](BOOTSTRAP.md) is the operational
summary a fresh session is handed. When a playbook and this file disagree,
this file wins and the playbook is repaired.

## 1. Repo model (the invariants every change preserves)

- Monorepo, npm workspaces (`packages/*`, `components/*`, `benchmark`). Node ≥ 24
  (`.nvmrc` is the line every gate runs on), ESM everywhere (`"type": "module"`).
  No build step for source — each package's `main` points at `./src/index.js`;
  `.d.ts` are emitted on `prepack`.
- **Dependency arrow (one way, no cycles):** `@jarenjs/core` (zero-dep base) →
  `@jarenjs/view` → `@jarenjs/app` → `components/*` → `website`. Sibling packages
  (`json`, `validate`, `formats`, `refs`, `emit`, `forms`, `locales`, `flow`,
  `linq`, `db`, `josl`, `ai`) sit on `core` and each other only in the direction
  `docs/ARCHITECTURE.md`'s graph draws; cooperation across layers is by an
  injected hook, an extension keyword, or a generated document — never a
  reverse import.
- **Two-layer components:** a component's engine (`components/<x>/src/*`) imports
  only `@jarenjs/core` + `@jarenjs/view`; its component layer (`src/component/*`)
  may add `@jarenjs/app`/`@jarenjs/forms`.
- **House rules:** zero runtime dependencies in `packages/*` and `components/*`
  except `@jarenjs/*`; two-stage compilers (validate/compile once, run closures);
  **no `eval`/`new Function`** (CSP-safe); char-code recursive-descent parsers over
  `@jarenjs/core/scan`; `//@ts-check` and JSDoc on every export; match the
  surrounding style; tests are plain `node:test` + `node:assert` under repo-root
  `test/`, mirroring package names.
- **Where shared code lands:** a pure, dependency-free helper → `@jarenjs/core`
  (the fitting subpackage); vnode/SVG/URL work → `@jarenjs/view/helpers`;
  app-level orchestration shared by two consumers → `@jarenjs/app`. Exactly one
  implementation of a thing exists; the second consumer is the moment it moves.

## 2. The gates

Every pass, order or release ends green from the repo root, by **exit code**,
never by eyeballing output. **`npm run site:gate` is the full gate**: one command
(`scripts/site-gate.js`) that runs all eight stages and aborts on the first
failure, so nobody has to assemble them from memory. The runner is shaped by
what the stages cost: the five independent read-only stages run
**concurrently** (wall clock: the slowest, not the sum), then the site is
built **exactly once**, then the two stages that read the build run against
it. Output is buffered per stage and printed whole, so a record still quotes
every stage's counts.

Concurrent first phase:

1. `npm run lint` — zero errors **and** zero warnings, fixed at the source (no new
   disables without a justified false positive);
2. `npm test` — all packages, with no expected-value/fixture edits unless the work
   deliberately changed behavior and says so;
3. `npm run benchmark:coverage` — every dead-code finding resolved (removed,
   covered, or a justified, ideally excluded, keep);
4. `npm run docs:check` — every derived span in every committed document still
   agrees with its source: measured figures with the committed measurements, the
   `@jarenjs/linq` binder's combined tables with the pen documents beside it
   (`npm run docs:derive` rewrites them; §4.6);
5. `npm run test:documents` — every ```` ```mermaid ```` fence in the committed
   Markdown parses through `@jarenjs/mermaid` and every ```` ```json ```` fence
   parses as JSON (JSON-shaped *notation* is fenced ```` ```jsonc ```` and is not
   parsed). The diagrams the site embeds in JavaScript content are gated from the
   other side by `test/website/documents.test.js`;

then, in order:

6. `npm run website:build` — the one build this gate performs;
7. `npm run test:design` — the `docs/DESIGN.md` §1 banned hues, over the site's
   source **and** its built `dist/`;
8. the Playwright matrix over that same build (`npm run test:browser:prebuilt`;
   the standalone `npm run test:browser` still builds first, for use outside
   the gate).

**Browser scope.** The full three-engine matrix is required when the change
touches the website workspace or anything it imports (`packages/view`,
`packages/app`, `packages/forms`, `components/*`, `packages/website` itself,
or a package the site's pages consume), and for every phase-close and
close-out order. A change that cannot affect the site may land on
`npm run site:gate -- --browser=smoke` (chromium only) — CI's browser job
runs the full matrix on every push either way, so the backstop holds.
`--browser=skip` is for inner loops only and is never the gate a change
lands on. Every other argument is forwarded to Playwright verbatim
(`-- --workers=1` on a loaded host). A host that cannot launch every
engine directly sets `SITE_GATE_BROWSER_SHELL` to the complete command
that runs the matrix (e.g. a container exec of `npx playwright test -c
packages/website/playwright.config.js`); the gate builds the site on the
host first and, in full mode, runs that command verbatim.

Running a subset is a speed convenience for a small change in flight, never the
basis a change lands on. **Seven gates sit outside `site:gate`**, because they
answer a packaging or a declaration question rather than a behavior one. Four
belong to any change that touches exports or types — `npm run test:types`,
`npm run test:packed`, `npm run test:tree-shaking` and `npm run test:deps` — and
three answer questions about the checkout itself, which a release asks and a
working change rarely does: `npm run test:lock`, `npm run test:native` and
`npm run test:source`. `release:check` runs `site:gate`'s stages plus all seven,
so the release path cannot skip what the working path runs; a work order that
moves an export names the first four in its own acceptance list.

`git push` runs the four seconds-fast ones through lefthook (lint, test,
`docs:check`, `test:documents`); the minutes-long stages stay out of the hook so a
push stays cheap enough that nobody is tempted to skip it.

A work order or playbook may name further gates; it may not drop these.
**Records are numbers, not adjectives** — test counts, lint result, audit
summary, and any benchmark figure the acceptance names, pasted; "all green"
without counts is not a record.

## 3. Artifacts and where they live

- The work-order workflow has three artifacts. The **router** — one per
  campaign: charter, measured baseline, fixed D-number decisions, the order
  table, the status ledger — is specified section by section in
  [`CAMPAIGN.md`](CAMPAIGN.md) §"The router". The **work order** — one per step,
  self-contained, ending in an acceptance checklist that IS the definition of
  done — and the **session record** — one per executed order, written after the
  work is green (summary, files, decisions & divergences with the drop list,
  gate output as numbers, open issues, and a *Handoff* section for whatever a
  next session must know) — each have a template in
  [`templates/`](templates/), the shape followed by a real filled-in one.
- **Naming.** Campaign files are working scratch: router `TODO_<PROGRAM>.md`,
  orders `TODO_<PROGRAM>_NN.md`, records `TODO_<PROGRAM>_NN_RECORD.md`. Every one
  matches the `TODO*.md` ignore rule, so the tree stays clean and nothing can be
  swept into a release. Never write a record under any other name, and never
  create a `PROGRESS*.md`.
- **Scratch is scratch.** `TODO*.md`, `PROGRESS*.md` and `NEXT_SESSION.md` will
  not exist in a fresh clone and are not recoverable once deleted. Before
  clearing a campaign, move any unexecuted intent into `docs/ROADMAP.md`.

## 4. Documentation & reference rules

1. **Never reference a gitignored file from committed code, comments,
   documentation or a commit message.** Naming the *convention* (as this file
   does) is fine; naming a specific `TODO_17` is the rot the rule prevents. When
   intent must survive, open the file (or recover it from git history), extract
   the real design decision, and restate it where it belongs — with no pointer.
   **Never flatten a named unit of work into a hollow word**: a "`TODO_17` msgid",
   a "design decision D8" each name something specific; replace the reference
   with the meaning, not with "task".
2. **The source code is the source of truth.** When code and prose disagree, the
   code wins and the prose is repaired; never invent behavior to satisfy a stale
   doc. If the code itself looks wrong, surface it (record, summary, ROADMAP) —
   do not paper over it in prose.
3. **Comments state intent and constraints, not history.** No "moved from X", no
   "added in order 04", no "as of <planning doc>". Record the *why* of a
   non-obvious choice; drop the when/where-it-came-from.
4. **Docs move with the code.** A relocated or renamed symbol is updated in every
   place that documents it — the package's `README.md`/`ARCHITECTURE.md`/`docs/*`
   and the repo-wide `docs/` (`ARCHITECTURE.md`, `ROADMAP.md`, `DESIGN.md`,
   `HOWTO.md`, `CONSUMING.md`). The only committed Markdown outside `docs/` and
   the workspaces is the root `README.md`.
5. **`docs/ROADMAP.md` lists open work only.** Shipped capability is documented
   in the package docs and the entry is closed or narrowed to the genuinely open
   decision — never deleted to make a section look finished, never kept out of
   caution.
6. **Published figures are derived, never hand-written.** Numbers and tables in
   committed Markdown sit between `<!--fact:key-->` … `<!--/fact-->` markers and
   are written by `npm run docs:derive` from their source — a committed
   measurement, or another committed document; `npm run docs:check` fails on
   drift. A pass that re-measures refreshes them, it does not retype them. **One
   namespace, one runner** (`scripts/lib/derive.js`), several registries: pairing
   and the orphan report are per-namespace, so a second spelling of the same idea
   is a second blind spot.
7. **Report the loss.** A measurement that comes out worse than a rival's is
   published beside the wins.
8. **A fenced block claims what it is.** ```` ```json ```` is a value a reader can
   copy and `JSON.parse`; JSON-shaped *notation* — metavariables (`expr`, `v`),
   alternation (`"asc" | "desc"`), an elided tail, comments — is ```` ```jsonc ````.
   ```` ```mermaid ```` is a diagram `@jarenjs/mermaid` can parse. `npm run
   test:documents` enforces both over every committed Markdown document outside
   `test/**` (where a fixture's job is sometimes to be malformed).

## 5. Decisions and authority

- **D-numbers are immutable.** A router decision is settled for the program's
  lifetime. An executor who believes one is wrong records the conflict in the
  session record; only the operator amends the router.
- **Work lands on `main`, uncommitted, for review.** No session commits, tags,
  pushes, branches or deploys on its own initiative — even when everything is
  green. The close-out protocol below runs only on the operator's explicit ask.
- **Preflight is a clean tree.** Every pass and every order starts from `git
  status --porcelain` printing nothing (gitignored scratch does not count), so
  the work is one reviewable diff against a known commit. If the tree is dirty,
  say what is dirty and ask for a commit or stash — do not start.

## 6. Close-out & commit protocol (do NOT deviate)

Only when explicitly asked to commit, in this order, aborting at the first
failure. Every step but the *decision* to release is one command with an exit
code — a step that exists only as prose is a step that gets skipped:

1. **Prove it green:** `npm run site:gate` (§2), plus `npm run test:packed` and
   `npm run test:tree-shaking` if exports moved.

   **The one expected red, and only for a close-out that re-measured.** A tracked
   `packages/website/public/benchmarks/*.json` that is new or regenerated is an
   *unreviewed* measurement until a commit carries it, and the repo says so in
   three places at once: `test/scripts/release-tooling.test.js` fails
   (`checkBenchmarkDrift()` is not clean), `npm run benchmark:coverage` then exits
   non-zero downstream of that single failing test — with zero dead-code findings
   of its own — and `website:deploy` would refuse for the same reason. So this run
   has **exactly one** failing assertion and it is that one; everything else must
   be green, a second failure stops the close-out, and the gate is re-run at
   step 4 where it can pass.
2. **Bump the version:** `npm run release:bump` — `patch` by default,
   `npm run release:bump -- minor` for a phase-opening campaign order or a new
   capability line. It refuses under an npm that is not the `packageManager` pin
   (a lockfile written by another npm is one the pinned npm then rejects, in CI
   rather than here), bumps every manifest and internal range, syncs the
   lockfile, runs `npm run test:lock` and rebuilds.
3. **Commit**, as the repo user, with a **single short one-line message**
   describing the change (`Deduplicated shared helpers into core and view`). ONE
   line: no body, no `Co-authored-by`, no "Generated with", no AI attribution, no
   person's name, no version. `git add -A` stages the work; confirm gitignored
   scratch is excluded and never force-add it.
4. **Re-run `npm run site:gate` when step 1 had its expected red.** It must now be
   green with nothing expected to fail — the measurement is committed, so the
   interlock is satisfied and every stage answers for the tree that is about to be
   published. This is the run the release lands on. A close-out that did not
   re-measure had that run at step 1 and skips this one.
5. **Deploy the website — when this close-out deploys.** A close-out deploys
   when the work is visible on the published site (site content, published
   figures, a registered benchmark suite) and always at a phase close and at
   a campaign close-out; a close-out whose changes are invisible on the site
   skips this step, and the next deploying close-out publishes cumulatively —
   the live `build.json` trailing HEAD between deploys is the accepted cost,
   and the drift gates below still guard every deploy that does happen.
   When deploying: `npm run website:deploy` must finish `Published`. It
   **refuses before building** when the tracked
   `packages/website/public/benchmarks/*.json` differ from HEAD, because a deploy
   publishes figures derived from them and those must be the ones a commit
   carries; the refusal names the two commands that resolve it. Reaching that
   refusal here means a measurement was regenerated *after* step 3 — commit it or
   `git checkout --` it, and deploy again. Re-measuring as part of publishing is a
   separate, named act: `npm run deploy:remeasure` from `packages/website` is the
   only script on the deploy path that regenerates timings, and because it is the
   one path that leaves regenerated figures in the tree it is finished by a commit
   carrying them, not by the publish. The live publish then verifies **itself** —
   `postdeploy` polls the published `build.json` until its commit and version
   match this checkout, and exits non-zero if they never do. The branch push is
   not the publish.
6. **Tag before pushing:** `git tag v<new-version>`. The version lives only in the
   tag.
7. **Push with tags:** `git push && git push --tags`.

The order of 2–5 is load-bearing, and **the commit precedes the deploy**. A deploy
publishes figures derived from the tracked measurements, so those must already be
the ones a commit carries — the drift guard enforces exactly that and its own
refusal names the resolution ("the re-measure was deliberate — commit it, then
deploy"). Deploying first would make a re-measuring close-out unable to publish at
all, and it would leave the published `build.json` naming the revision *before* the
one that produced the deployed bytes. Committing first costs nothing and makes
`build.json` name the commit that built it, which is what `postdeploy` then
verifies against this checkout. The bump still lands in the working tree before the
commit, so the deployed site and the commit carry one version between them.

## 7. Running a program

1. Author the router and its work orders ([`CAMPAIGN.md`](CAMPAIGN.md) is the
   authoring playbook; [`templates/`](templates/) has the order and record
   shapes); settle the D-numbers there, once.
2. Per work order: a fresh session holding [`BOOTSTRAP.md`](BOOTSTRAP.md), the
   router and that order. It executes, proves the gates, writes the session
   record under its `TODO_` name — its Handoff section carrying whatever must
   cross to the next session — and updates the router's status ledger.
3. The operator reviews on `main` and runs §6 when satisfied.

Each template in [`templates/`](templates/) carries a real work order executed
by a fresh session against this repository, and the record it produced.
