# REFACTOR.md — periodic codebase-health pass

A **reusable, idempotent** refactor playbook. Run it every so often to keep the monorepo DRY
and correctly layered: find redundant/duplicated code, collapse each duplicate into the single
most logical parent package, and repair any documentation that has drifted from the code. A run
that finds nothing worth changing is a **valid, successful run** — report "no redundancy found"
and stop.

This file is committed and self-contained: it depends on no planning document. The rules it
shares with every other pass — the repo model, the gates, the documentation rules, the clean-tree
preflight and the close-out protocol — live once in [`CONVENTIONS.md`](CONVENTIONS.md) and are
not restated here; this file is what is specific to a refactor.

It has two siblings. [`QUIRKS.md`](QUIRKS.md) is the **quirk hunt**: the evidence-first audit
that finds and fixes what is wrong-but-quiet (broken idempotence, lying counts, divergent twins,
false comments) — the one pass that *is* allowed to change behavior, because every fix comes with
its reproduction as a test. [`CAMPAIGN.md`](CAMPAIGN.md) is for building capability. The
division of labour is deliberate: a REFACTOR pass **moves and never changes**; when it trips
over a bug it surfaces it (see "Quirk sweep" below) and either hands it to a QUIRKS pass or, when
the operator asked for both, fixes it under the QUIRKS rules in the same working tree — never
silently, never without a test.

## Preflight — a clean working tree (CONVENTIONS §5)

`git status --porcelain` must print nothing before you read a line of code; otherwise abort,
say what is dirty, and ask for a commit or stash. A refactor is a "close-in" pass: starting from
a clean commit makes the whole pass one diff against the previous commit — trivial to review,
trivial to revert, impossible to tangle with in-flight work.

## How to run

- **Whole repo (default):** sweep `packages/*` and `components/*` for redundancy and relocate
  each duplicate into its logical parent.
- **Scoped:** if you were handed a package reference (e.g. "run REFACTOR for `@jarenjs/mermaid`"),
  restrict the sweep to that package's helpers plus everywhere that would share them — but still
  land shared code in the correct parent (`core`/`view`/`app`), not in the scoped package.

Definition of done for a run: the gates of [`CONVENTIONS.md`](CONVENTIONS.md) §2 green —
with the refactor's own sharpening that `npm test` passes with **no existing-fixture edits**
(import-path updates for moved symbols are fine) — the design-conformance rules
(**`docs/DESIGN.md`**, below) hold, the documentation & reference rules (CONVENTIONS §4) hold
for every moved symbol, and the **quirk sweep** (below) has been run with its findings surfaced
in the summary.

## Repo model

The invariants a refactor must preserve are [`CONVENTIONS.md`](CONVENTIONS.md) §1: the one-way
dependency arrow, the two-layer component rule, zero runtime dependencies outside `@jarenjs/*`,
no `eval`/`new Function`, two-stage compilers, JSDoc on exports, plain `node:test` under `test/`
— and, the one a refactor lives by, **where shared code lands** (pure → `core`, vnode/URL →
`view/helpers`, app orchestration → `app`).

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

## Documentation & reference sweep (run every pass)

The rules are [`CONVENTIONS.md`](CONVENTIONS.md) §4; a refactor is the pass that *enforces* them
across the tree, so on each run: scan committed code, comments and docs for references to
gitignored files (`TODO_17`, `PROGRESS_19`, "see TODO", "as of TODO_18") and repair each by
restating the real intent — from the file if it still exists, from git history if not — never by
flattening a named unit of work into a hollow word; strip migration narration from comments;
and update every document that names a moved or renamed symbol (the package's
`README`/`ARCHITECTURE`/`docs/*` and the repo-wide `docs/`).

## Design conformance — DESIGN.md is binding (run every pass)

**`docs/DESIGN.md` is the committed visual design system and branding contract** for
`packages/website` and the visual components (`components/calc`, `components/md`,
`components/mermaid`). It is not advisory: any code the refactor touches in those areas must
hold its invariants, and every pass sweeps for drift:

1. **Touched visual code follows the system.** Colors come from the token vocabulary (no raw
   hex that duplicates a token's meaning), spacing snaps to the `--space-*` scale, radii use
   the two radius tokens, `.page` never regains the `padding` shorthand, host stylesheet
   overrides use the doubled selector, and SVG components theme through the two-layer /
   host-linked `createTheme` architecture — all as specified in `DESIGN.md`.
2. **Sweep for branding drift.** Run the banned-hue grep from `DESIGN.md` §10 over the
   source tree and the built `dist/` — the brand is blue; **no pink, no purple, anywhere**
   (UI chrome, syntax palettes, diagram themes, chart palettes). Zero hits required.
3. **Code and DESIGN.md must not diverge.** When they disagree, decide which one is right:
   repair the code toward the document, unless the code embodies a deliberate, newer design
   decision — then update `DESIGN.md` in the same pass and say so in the summary. Never
   leave the two in conflict, and never weaken a constraint silently.
4. When a refactor moves or renames a token, theme symbol, or palette, `DESIGN.md` is
   updated with it like every other document (CONVENTIONS §4 rule 4).

## Lint sweep (run every pass)

Linting is part of the refactor's job, not just a gate at the end:

- Run `npm run lint` over packages, components and tests; the pass is done only at
  **zero errors and zero warnings**.
- **Fix findings at the source.** Do not silence with `eslint-disable`, rule downgrades, or
  config exclusions. An inline disable is acceptable only for a genuine false positive,
  scoped to a single line, with a short justification comment.
- Some rules only offer *suggestions*, not autofixes (e.g. `no-useless-escape` in ESLint
  v9), so `--fix` will not clear them — resolve those by hand.
- The lint **infrastructure** is in scope: a broken glob, a missing ignore, or a gate that
  silently lints nothing is itself a finding — repair it so the gate genuinely covers the
  tree.

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

## Quirk sweep (run every pass; surface, do not silently fix)

A refactor reads more code closely than any other activity in the repo, so it is the pass most
likely to notice a **quirk** — a defect that does not fail a gate: a helper whose two copies
diverge in behavior (not just in name), a comment asserting an invariant a sibling module
breaks, an importer or sync that is not idempotent, a count that reports columns as rows, a
flag that is parsed and never read, a status mapping that answers 404 as 400. The full taxonomy
and the verification discipline live in [`QUIRKS.md`](QUIRKS.md); this section says what a
REFACTOR pass does with them.

- **Look for them on purpose while you dedupe.** Comparing two shape-siblings is exactly when a
  behavioral divergence shows: two "same" helpers that differ by an off-by-one, a `??` on a
  `NOT NULL DEFAULT ''` column, an escape function that misses one character. Note it the
  moment you see it, with `file:line` and the concrete input → wrong output.
- **A REFACTOR pass does not change behavior, so it does not fix them in-line.** Two divergent
  copies stay reachable via a parameter (see "Non-negotiables"), and the divergence is reported
  as a finding: *"copy A and copy B differ on input X; A returns …, B returns …; unified under
  parameter `p`, callers keep their old value; one of them is probably wrong."* Deciding which
  is a QUIRKS decision, made with a reproduction and a test — not a side effect of a move.
- **When the operator asked for a REFACTOR and a QUIRKS pass together**, fix confirmed quirks
  under the QUIRKS rules (reproduce first, smallest fix, regression test with exact values,
  prose repaired), but keep them **out of the relocation diff's story**: list them separately in
  the summary as *behavior changes*, each with its test, so the reviewer can tell a move from a
  fix. Never let "moved X to core" hide "and changed what X returns for empty input".
- **Doc drift found on the way is not a quirk, it is this pass's job** — repair it under the
  documentation & reference sweep above.
- **Report the sweep even when it found nothing.** "Quirk sweep: no behavioral divergences
  among the N shape-siblings compared" is a result; silence is not.

## Method (per candidate)

1. **Locate** all shape-siblings (grep by constant/regex/structure, then read and compare bodies —
   and note any behavioral divergence between them for the quirk sweep).
2. **Choose the parent** by the purity/arrow rules and the most general accurate name.
3. **Generalize** the signature to cover every caller (parameterize the diverging constants).
4. **Land** it (module + barrel + export-map entry + JSDoc that states intent, not history).
5. **Rewire** every dependent to import from the parent under the new name; **delete** the copies.
6. **Prove** no behavior change: re-run that area's tests (golden/round-trip/render/SSR) — no
   expected-value/fixture edits.
7. **Sweep docs/comments** in the touched area per the documentation & reference sweep above.

Then **expand**: sweep `components/*` and `packages/*` `utils.js`/`render/*`/`lib/*`/`theme.js`
for other same-shape helpers (escaping, clamping, id/slug generation, deep-equal, small
array/object utilities, vnode constructors, pointer-token encoding) and hoist each to its
logical parent.

## Acceptance checklist

- [ ] Started from a **clean working tree** (`git status --porcelain` empty), so the whole
      refactor is a single reviewable diff against the previous commit.
- [ ] `npm run lint` clean at **zero errors and zero warnings**, with findings fixed at the
      source (no new disables/downgrades without a justified false positive); `npm test` green
      across ALL packages, with **no expected-value/fixture edits** (import-path updates for
      moved symbols are fine); `npm run website:build` succeeds; `npm run test:tree-shaking`
      passes.
- [ ] **`DESIGN.md` conformance holds**: touched visual code uses the token vocabulary, spacing
      scale and theming architecture; the banned-hue sweep (no pink/purple) over source and
      built `dist/` returns zero hits; code and `DESIGN.md` end the pass in agreement (the
      document updated in-pass if a deliberate design decision superseded it).
- [ ] Every duplicate collapsed to ONE implementation in its logical parent (pure → `core`,
      view → `@jarenjs/view/helpers`, app → `@jarenjs/app`); each former copy deleted and
      re-imported; the most general accurate name chosen and propagated to all dependents.
- [ ] Zero-dep and the one-way dependency arrow preserved; the two-layer component rule holds;
      **no circular dependencies**; export maps/barrels/`files`/`sideEffects` updated.
- [ ] `npm run benchmark:coverage` (dead-code audit) run on a green suite; every FULLY DEAD FILE
      and DEAD FUNCTION finding resolved — removed, or covered by a new test — with any
      deliberate "keep" (a true entry point) justified and, ideally, excluded from the audit.
- [ ] No committed code/comment/doc references any gitignored file (CONVENTIONS §4); every
      prior such reference rewritten to state its real intent; no named work unit flattened into
      a hollow word.
- [ ] Docs (`README`/`ARCHITECTURE`/`docs/*`/`ROADMAP`) updated for every moved/renamed symbol;
      comments state intent, not migration history.
- [ ] **Quirk sweep reported**: every behavioral divergence noticed between shape-siblings is
      listed with `file:line` and input → output (kept reachable via a parameter, not silently
      resolved); any quirk *fixed* because the operator asked for it is listed separately as a
      behavior change with its regression test.
- [ ] **No `PROGRESS*.md` (or any scratch planning file) created for the run** — summarize the
      changes in the commit message / hand-off instead.

## Close-out & commit protocol

**Default: stop for review** — leave everything in the working tree on the current branch and
hand it back; do not commit, tag, push, branch or deploy on your own initiative, even when green,
and do not create a `PROGRESS*.md`. Only when explicitly asked to commit, run
[`CONVENTIONS.md`](CONVENTIONS.md) §6 unchanged (gates → patch bump → deploy → single one-line
commit → tag → push with tags). A refactor's one-liner names the consolidation
(`Deduplicated shared helpers into core and view`).

## Out of scope

- Behavior changes, new features, or API additions beyond what a clean relocation needs. Bugs
  found on the way are surfaced (see "Quirk sweep") and fixed only under [`QUIRKS.md`](QUIRKS.md)
  rules — reproduced, tested, reported separately — never as an unmarked part of a move.
- "Fixing" a duplicate's semantics while moving it (unless two copies genuinely diverged and the
  correct behavior is unambiguous — then keep both reachable via a parameter and document it).
- Changing an existing helper's established (even quirky) behavior that current consumers rely
  on; introduce a correctly-named replacement instead and migrate callers deliberately.
- Publishing / version bumps / deploys, except inside the close-out protocol (CONVENTIONS §6).
- Reformatting or restyling untouched code.
