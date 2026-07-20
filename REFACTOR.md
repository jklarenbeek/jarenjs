# REFACTOR.md — periodic codebase-health pass

A **reusable, idempotent** refactor playbook. Run it every so often to keep the monorepo DRY
and correctly layered: find redundant/duplicated code, collapse each duplicate into the single
most logical parent package, and repair any documentation that has drifted from the code. A run
that finds nothing worth changing is a **valid, successful run** — report "no redundancy found"
and stop.

This file is committed and self-contained: it does **not** depend on any other planning
document. (In particular it never relies on `TODO*.md`/`PROGRESS*.md`, which are gitignored —
see the Documentation & reference rules below.)

## How to run

- **Whole repo (default):** sweep `packages/*` and `components/*` for redundancy and relocate
  each duplicate into its logical parent.
- **Scoped:** if you were handed a package reference (e.g. "run REFACTOR for `@jarenjs/mermaid`"),
  restrict the sweep to that package's helpers plus everywhere that would share them — but still
  land shared code in the correct parent (`core`/`view`/`app`), not in the scoped package.

Definition of done for a run: `npm run lint` clean, `npm test` green across ALL packages (with
**no existing-fixture edits** — see below), `npm run website:build` succeeds, the dead-code
audit (`npm run benchmark:coverage`) has every finding resolved, and every documentation/
reference rule below holds.

## Repo model (the invariants a refactor must preserve)

- Monorepo, npm workspaces (`packages/*`, `components/*`, `benchmark`). Node ≥ 22, ESM
  everywhere (`"type": "module"`). No build step for source — each package's `main` points at
  `./src/index.js`; `.d.ts` are emitted on `prepack`.
- **Dependency arrow (one way, no cycles):**
  `@jarenjs/core` (zero-dep base) → `@jarenjs/view` → `@jarenjs/app` → `components/*` → `website`.
  Sibling packages (`json`, `validate`, `formats`, `refs`, `forms`, `locales`) sit on `core`.
- **Two-layer components:** a component's engine (`components/<x>/src/*`) imports only
  `@jarenjs/core` + `@jarenjs/view`; its component layer (`src/component/*`) may add
  `@jarenjs/app`/`@jarenjs/forms`. The arrow is one-way.
- **House rules:** zero runtime dependencies in `packages/*` and `components/*` (except
  `@jarenjs/*`); two-stage compilers, **no `eval`/`new Function`** (CSP-safe); char-code
  recursive-descent parsers; JSDoc on exports; match surrounding code style; tests are plain
  `node:test` + `node:assert` under repo-root `test/`, mirroring package names.

## The goal

The suite grows by copy-and-adapt, so the same small function or vnode builder gets
re-implemented (sometimes byte-for-byte, sometimes lightly renamed) in several packages.
Consolidate:

1. **Pure, dependency-free functions** (string/number/hash/geometry/color helpers with no view
   or DOM knowledge) → **`@jarenjs/core`** (the fitting subpackage: `core` root, `core/string`,
   `core/number`, `core/math`, `core/color`, `core/scan`, …).
2. **vnode/SVG/view helpers** (functions that build `@jarenjs/view` vnodes via `h()`, sanitize
   URLs, or resolve theme tokens) → **`@jarenjs/view/helpers`**.
3. **App-level orchestration helpers** shared by more than one `@jarenjs/app` consumer →
   **`@jarenjs/app`**.

Every relocation is **behavior-preserving**: emitted SVG strings, vnode shapes, hash values,
golden-geometry fixtures and round-trip fixed points stay byte-identical. Dedup, don't redesign.

## Identify by SHAPE, not by name

Two functions are "the same" when their **behavior** is the same, even if their names, parameter
names, or defaults differ. Do not rely on grep-by-name alone.

- Compare the **signature shape** (arity, argument roles) and the **transformation**,
  normalizing away identifier names.
- Two functions that differ only by a hard-coded constant, class string, prefix or theme token
  are the **same function missing a parameter** — unify them by **generalizing the signature**
  (add the parameter; callers pass their specific value).
- When a symbol lands in a parent package, give it the **most general, accurate name** for its
  new home. If that means renaming, **rename it and update every dependent** — code, tests,
  JSDoc and prose — leaving no dangling reference.

## Non-negotiables (correctness)

- **Preserve the dependency arrow and the purity boundary.** `@jarenjs/core` stays pure and
  zero-runtime-dependency (no view, no DOM, no I/O). `@jarenjs/view/helpers` may use `view`'s own
  `h`/serializer but nothing above it. **No circular dependencies** — verify.
- **No behavior change.** The existing golden / round-trip / render / SSR suites are the oracle;
  they must stay green with **no edits to their expected values or fixtures**. Updating a test's
  *import path* because a symbol moved is allowed; changing an asserted value is not — if a
  fixture must change, the move was not behavior-preserving, so stop and reconsider. Where a
  duplicate had subtly divergent behavior, keep **both** reachable via a parameter rather than
  silently picking one.
- **One home per concept.** After a move, exactly one implementation exists; every former copy
  is deleted and re-imported. Do not leave a leaf-package re-export shim unless a *published
  public* export name would otherwise break — prefer the clean rename (these are pre-1.0
  workspace packages linked by `file:`, so internal renames are free).
- **Update export maps + barrels.** New subpaths go in the owning package's `package.json`
  `exports` (mirroring how `@jarenjs/core` maps `./math`/`./math/*`); barrels re-export moved
  symbols; `files`/`sideEffects` stay correct; `npm run test:tree-shaking` still passes.
- **Work in small, verifiable batches** (one concept at a time), running `npm test` between
  batches so a regression is attributable. Keep diffs limited to relocations + import rewiring;
  do not reformat or restyle untouched code.

## Documentation & reference rules (new — apply on every run)

These keep the committed tree honest, and they are part of the refactor's job:

1. **Never reference a gitignored file from committed code, comments, or documentation.** Files
   matched by `.gitignore` — notably `TODO*.md` and `PROGRESS*.md` (planning/scratch docs) —
   will not exist in a fresh clone, so any reference to them rots. On each run, scan for such
   references (e.g. `TODO_17`, `PROGRESS_19`, "see TODO", "as of TODO_18") and repair them:
   - If the referenced file still exists, **open it, extract the real intent**, and rewrite the
     comment/doc to state that intent directly (the design decision, the constraint, the reason)
     — with no pointer to the file.
   - If the referenced file is gone, recover the intent from git history and the surrounding
     code, then rewrite to state it directly.
   - **Never** flatten a meaningful named unit of work into a hollow word. A "`TODO_17` msgid",
     a "design decision D8", a "work item / phase / chapter" each name something specific;
     replace the *reference* with the *meaning*, not with a generic term like "task" that
     carries none of it.
2. **The source code is the source of truth.** When code and a comment/doc disagree, or when you
   are unsure while writing or repairing documentation, the **code wins**: correct the doc to
   match what the code actually does. Never invent behavior to satisfy a stale doc. (If the code
   itself looks wrong, surface it in your summary — do not paper over it in prose.)
3. **Comments state intent and constraints, not history.** A comment exists for the next reader
   of the code, not to narrate how the code got here. While refactoring, strip migration
   narration ("moved from X", "previously threw", "as of <planning doc>") and keep only what a
   reader needs to understand or safely change the code. Record the *why* of a non-obvious
   choice; drop the *when/where-it-came-from*.
4. **Keep documentation in sync with the move.** When a symbol is relocated or renamed, update
   every place that documents it — package `README.md`, `ARCHITECTURE.md`, `docs/*`, `ROADMAP.md`
   — to its new name and home.

## Dead-code audit (run every pass)

Run `npm run benchmark:coverage` (the `--dead-code` mode of `benchmark/coverage.js`). It executes
the **whole** test suite under coverage with `--all` — so a module no test imports still surfaces
at 0% — and lists two kinds of stale/dead-code candidate:

- **FULLY DEAD FILES** — no test executes any function in the file.
- **DEAD FUNCTIONS** — individual functions with zero hits inside otherwise-used files.

It exits non-zero when findings exist, so it can gate a health check. **For each finding, decide
and act — never leave it unresolved:**

- **Remove it** if it is genuinely unreachable or obsolete (and remove anything that existed only
  to support it). A relocation often *creates* dead code — the old copy, or a branch that no
  longer runs — so re-run the audit after the dedup and clean up.
- **Add a focused test** that exercises it if it is a real, intended path (public API surface, an
  error branch, a rarely-hit option). Untested-but-intended is a coverage gap, not dead code —
  close it.
- **Keep it only with a recorded justification** when it is a genuinely untestable entry point —
  e.g. the browser bootstrap `packages/website/src/main.js`, which no headless test loads.
  Prefer *excluding* such true entry points from the audit (tighten the `--exclude` globs in
  `benchmark/coverage.js`) over silently tolerating a standing finding.

Removing dead code must itself be behavior-preserving for everything still live (the suite stays
green). Run the audit on a **green** suite — findings from a red suite are unreliable (untested
paths may simply not have run).

## Method (per candidate)

1. **Locate** all shape-siblings (grep by constant/regex/structure, then read and compare bodies).
2. **Choose the parent** by the purity/arrow rules and the most general accurate name.
3. **Generalize** the signature to cover every caller (parameterize the diverging constants).
4. **Land** it (module + barrel + export-map entry + JSDoc that states intent, not history).
5. **Rewire** every dependent to import from the parent under the new name; **delete** the copies.
6. **Prove** no behavior change: re-run that area's tests (golden/round-trip/render/SSR) — no
   expected-value/fixture edits.
7. **Sweep docs/comments** in the touched area for the reference rules above.

Then **expand**: sweep `components/*` and `packages/*` `utils.js`/`render/*`/`lib/*`/`theme.js`
for other same-shape helpers (escaping, clamping, id/slug generation, deep-equal, small
array/object utilities, vnode constructors, pointer-token encoding) and hoist each to its
logical parent.

## Acceptance checklist

- [ ] `npm run lint` clean; `npm test` green across ALL packages, with **no expected-value/fixture
      edits** (import-path updates for moved symbols are fine); `npm run website:build` succeeds;
      `npm run test:tree-shaking` passes.
- [ ] Every duplicate collapsed to ONE implementation in its logical parent (pure → `core`,
      view → `@jarenjs/view/helpers`, app → `@jarenjs/app`); each former copy deleted and
      re-imported; the most general accurate name chosen and propagated to all dependents.
- [ ] Zero-dep and the one-way dependency arrow preserved; the two-layer component rule holds;
      **no circular dependencies**; export maps/barrels/`files`/`sideEffects` updated.
- [ ] `npm run benchmark:coverage` (dead-code audit) run on a green suite; every FULLY DEAD FILE
      and DEAD FUNCTION finding resolved — removed, or covered by a new test — with any
      deliberate "keep" (a true entry point) justified and, ideally, excluded from the audit.
- [ ] No committed code/comment/doc references any gitignored file; every prior such reference
      rewritten to state its real intent (source code and, if needed, git history as the source
      of truth); no named work unit flattened into a hollow word.
- [ ] Docs (`README`/`ARCHITECTURE`/`docs/*`/`ROADMAP`) updated for every moved/renamed symbol;
      comments state intent, not migration history.
- [ ] **No `PROGRESS*.md` (or any scratch planning file) created for the run** — summarize the
      changes in the commit message / hand-off instead.

## Close-out & commit protocol (do NOT deviate)

**Default: stop for review.** When the pass is done, leave everything in the working tree on the
current branch and hand it back for review. Do **not** commit, tag, push, or create a branch on
your own initiative — even if everything is green. Do **not** create a `PROGRESS*.md`.

**Only when explicitly asked to commit**, run this in order and abort at the first failure:

1. **Prove it's green:** `npm run lint`, `npm test` (all packages), `npm run website:build`, and
   `npm run benchmark:coverage` with every dead-code finding resolved (or a justified keep).
2. **Bump the patch version by one:** `npm run version:patch`, then `npm install` to sync the
   lockfile, and re-verify the build.
3. **Deploy the website:** `npm run website:deploy` — it must finish successfully (`Published`).
4. **Only then commit**, as the repo user (**Joham**), with a **single short one-line message**
   describing the change (e.g. `Deduplicated shared helpers into core and view`):
   - The message is ONE short line. **No body, no `Co-authored-by`, no "Generated with", no
     Claude/AI attribution, and no person's name inside the message.**
   - `git add -A` stages the work; gitignored files (`TODO*.md`, `PROGRESS*.md`) MUST stay out —
     never force-add them; confirm they are excluded before committing.
5. **Tag with the version before pushing:** `git tag v<new-version>` (the version from step 2).
6. **Push with tags:** `git push && git push --tags`.

The commit message is the human one-liner; the version lives only in the **tag** (do not use any
release script that injects a `vX.Y.Z` commit message).

## Out of scope

- Behavior changes, new features, or API additions beyond what a clean relocation needs.
- "Fixing" a duplicate's semantics while moving it (unless two copies genuinely diverged and the
  correct behavior is unambiguous — then keep both reachable via a parameter and document it).
- Changing an existing helper's established (even quirky) behavior that current consumers rely
  on; introduce a correctly-named replacement instead and migrate callers deliberately.
- Publishing / version bumps / deploys, except as steps 2–3 of the commit protocol above.
- Reformatting or restyling untouched code.
