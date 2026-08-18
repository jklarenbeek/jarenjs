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
never by eyeballing output:

- `npm run lint` — zero errors **and** zero warnings, fixed at the source (no new
  disables without a justified false positive);
- `npm test` — all packages, with no expected-value/fixture edits unless the work
  deliberately changed behavior and says so;
- `npm run website:build`;
- `npm run benchmark:coverage` — every dead-code finding resolved (removed,
  covered, or a justified, ideally excluded, keep);
- when packaging or exports change: `npm run test:packed`, `npm run
  test:tree-shaking`; when visual code changes: the `docs/DESIGN.md` conformance
  sweep including the banned-hue grep over `src` **and** `dist`; when the browser
  surface changes: `npm run test:browser`.

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
6. **Published figures are derived, never hand-written.** Numbers in committed
   Markdown come from the committed measurements through the benchmark-figure
   gate (`npm run docs:benchmarks`, `npm run docs:check`); a pass that re-measures
   refreshes them, it does not retype them.
7. **Report the loss.** A measurement that comes out worse than a rival's is
   published beside the wins.

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
failure:

1. **Prove it green** — the gates in §2, by exit code, including any the work
   named.
2. **Bump the version:** `npm run version:patch` (a phase-opening campaign order
   or a new capability line takes `version:minor`), then `npm install` under the
   pinned npm (`packageManager` in the root manifest) to sync the lockfile, then
   `npm run test:lock`, and re-verify the build.
3. **Deploy the website:** `npm run website:deploy` must finish `Published`
   (`npm run website:build` + `npx gh-pages -d packages/website/dist` when the
   tracked benchmark timings must not be regenerated on this machine); verify
   the live publish, not just the branch push.
4. **Only then commit**, as the repo user, with a **single short one-line
   message** describing the change (`Deduplicated shared helpers into core and
   view`). ONE line: no body, no `Co-authored-by`, no "Generated with", no AI
   attribution, no person's name, no version. `git add -A` stages the work;
   confirm gitignored scratch is excluded and never force-add it.
5. **Tag before pushing:** `git tag v<new-version>`. The version lives only in the
   tag.
6. **Push with tags:** `git push && git push --tags`.

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
