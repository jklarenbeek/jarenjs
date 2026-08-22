# QUIRKS.md — the quirk hunt

A **reusable, evidence-first audit pass** for the whole monorepo or one package: find the
things that are *wrong but not loud* — bugs nobody has filed, imports and syncs that are not
idempotent, counts that lie, comments that promise an invariant another module breaks, flags
that are parsed and never read, error paths that hide the real status — verify each one by
making it happen, fix what is confirmed, pin the fix with a test, and repair the prose the fix
made stale. A run that confirms nothing is a **valid, successful run**; the report then lists
what was checked and dropped, which is worth as much as a fix.

The pass exists because the other two playbooks deliberately look away from this. A
[`REFACTOR.md`](REFACTOR.md) pass is *behavior-preserving by contract* — it moves duplicates and
must not change what the code does, so a bug it trips over can only be surfaced, not fixed. A
[`CAMPAIGN.md`](CAMPAIGN.md) builds a capability and is forbidden from widening mid-flight. The
quirks fall between them and rot. This document is the ritual for going and getting them.

This file is committed and self-contained; it never relies on `TODO*.md`/`PROGRESS*.md`. The
rules it shares with the other passes — repo model, gates, documentation rules, the clean-tree
preflight, the close-out protocol — live once in [`CONVENTIONS.md`](CONVENTIONS.md).

## What a quirk is

A quirk is a defect you can **reproduce** and that a careful reader would call wrong, but that
does not currently fail a gate. The taxonomy below is the checklist a sweep works from; every
class carries the reason it matters, because a scanner told "find bugs" finds style.

| Class | What to look for | Why it matters |
|---|---|---|
| **Silent data loss / wrong write** | an insert that collides with a constraint and rolls back a whole batch; a "refresh" that resurrects a record the user retired; a lookup keyed too broadly (no environment / no scope) so one record collects another's links | the operator sees a success message and the data is wrong |
| **Broken idempotence** | re-running an import/sync/migration changes rows it should not touch, bumps revisions or `updated_at` on identical values, or reports N "changes" that were none | every re-run invalidates optimistic clients and destroys the signal in the report |
| **Counts and messages that lie** | columns counted as rows; an env-wide total in a per-env report; "0 updated" on a typo'd argument instead of an error; success logged after garbage output | the number is what the operator decides on |
| **Divergent twins** | the same helper written N times with N−1 different mappings (six error mappers, three status tables); two clients where one honours an env var the other's comment says "can never" apply | inconsistency is a bug that has not chosen its victim yet |
| **Dead or half-wired switches** | a flag parsed and never read; a documented option the code ignores; a boolean flag that swallows the next positional; a `--max abc` that means "unlimited" | the user believes they controlled something |
| **State that survives when it should not** | a mount-once default recomputed from stale props; a "dirty" flag that can never clear; a test result masked by an older result | the UI lies about what will happen on the next click |
| **Wrong status / wrong surface** | 404s answered as 400; a server fault answered as a client error with an absolute path in the body; a request from the wrong place accepted because "it binds to localhost" — until it does not | clients branch on status; operators branch on messages |
| **Comments and docs that assert falsehoods** | "nothing passes this flag yet" (three callers do); "run `node ./src/x.js`" (moved two directories ago); a route list missing whole surfaces; a duplicated bullet with two different meanings | the next reader trusts them and builds on sand |
| **Unit and format mismatches** | cents where every other path writes euros; a CSV parsed with the wrong delimiter so the header becomes one column and every filter matches nothing; `Number(x.replace(',', '.'))` on `1.250,00` | 100× and NaN are the two most expensive quiet failures |
| **Schema/migration hazards** | a marker `INSERT` that is not an upsert; a unique index created unconditionally on data that may already violate it; a `NOT NULL` that the CLI path fills with `0` | first start on a second machine, concurrent start, or a legacy database — the cases nobody runs locally |

Not a quirk: a naming preference, a formatting nit, "could be prettier", a missing feature. Those
go to review comments or the ROADMAP. A quirk has a concrete input and a wrong output.

## Preflight — a clean working tree (CONVENTIONS §5), then a baseline

`git status --porcelain` must print nothing; otherwise abort, say what is dirty, and ask for a
commit or stash. A quirk hunt produces many small, unrelated fixes; it must be one reviewable
diff against a known commit, or nobody can tell a fix from in-flight work.

Then run the gates once and record the baseline: `npm run site:gate` (CONVENTIONS §2 — the
counts that matter are `npm test`'s and the dead-code audit's). Findings from a red suite are
unreliable, and the closing report puts the final counts next to these.

## The ritual, in order

### 1. Fix what you were told first

If the operator named a quirk ("the import reports thousands of changes every run"), fix that
one **before** the sweep, with a test, and confirm the fix the way the operator would notice it
(run the command twice; the second run must say `0`). It is the calibration point: it tells you
what the operator considers wrong, and it is the promise you actually made.

### 2. Sweep in parallel, by area, with an adversarial mandate

Split the tree into 3–5 areas that a single reader can hold — in this monorepo typically the
engine packages (`packages/core`, `packages/json`, `packages/validate`, `packages/formats`,
`packages/refs`), the runtime packages (`packages/view`, `packages/app`, `packages/forms`,
`packages/locales`), the data pair and the model layer (`packages/linq`, `packages/db`,
`packages/ai`, `packages/josl`, `packages/flow`), the components (`components/*`), and the
harness (`benchmark/`, `scripts/`, `test/` infrastructure, `docs/`). Give each area to a
separate reader — a subagent, a colleague, or yourself in a separate session — with the **same
brief**:

- The taxonomy above, verbatim, and the instruction *do not report style nits*.
- Read the code, not the docs about the code. Cross-check the docs against the code and report
  drift as findings (routes documented but missing, options honoured but undocumented, module
  headers describing history).
- For every finding: `file:line`, what happens, why it is wrong as **concrete input → wrong
  output**, confidence (`high`/`medium`/`low`), and the minimal fix.
- **Verify before reporting.** Run the parser on the actual fixture; compile the three-line
  schema and validate the instance; render the vnode to a string; call the sync twice on a
  fresh store. A finding you could not substantiate is not a finding — drop it or mark it `low`
  with the reason.
- Rank: the 5–15 most important, real quirks. A list of forty unranked observations is noise.

Parallel readers with the same brief find different things because they read from different
ends; that is the point. Do not run the same sweep yourself while they run — you are the
verifier, not a fourth scanner.

### 3. Verify every claim yourself before you touch code

The reader's reproduction is a claim; yours is evidence. For each finding, reproduce it in the
smallest possible arena — a pure call, a compiled schema against one instance, an SSR render
compared to its expected string, the parser on a three-line fixture, a fresh in-memory store
run through the operation twice — and decide:

- **Confirmed** → it goes on the fix list with its reproduction, which becomes the regression
  test.
- **Confirmed but out of scope** (a design decision, a feature gap, a behavior consumers rely
  on) → it goes on the *not changed* list **with the reason**, or to the ROADMAP.
- **Not reproducible** → it goes on the *checked and dropped* list. Say why: the guard the reader
  missed, the test that already pins the behavior, the comment that turned out to be right.

Confidence labels are for triage, not for skipping verification: a `high` you did not reproduce
is still a rumor.

### 4. Fix in batches, by layer, gates between

Fix bottom-up — the pure/engine layer first, then the runtime, then components and site — so a
higher layer's failing test after a batch is attributable to that batch and not to something
under it. Between batches: `npm test`. After every batch that touched a package's public
surface: `npm run lint`.

Rules for the fix itself:

- **Every confirmed quirk gets a test that would have caught it** — a `node:test` case under
  `test/` mirroring the package name, asserting the corrected behavior with exact values. A
  test that merely exercises the line is not a regression test.
- **Fix at the source, once.** Divergent twins are collapsed into one helper (in the parent the
  dependency arrow allows — pure to `@jarenjs/core`, view to `@jarenjs/view/helpers`, app to
  `@jarenjs/app`) and every copy deleted; that part of the fix follows [`REFACTOR.md`](REFACTOR.md)
  §"Method". Do not fix the same twin in five places.
- **Idempotence fixes compare before they write.** "Skip when the stored value equals the
  incoming value" is the whole fix; do not add a flag to hide the count.
- **Counts report what the reader assumes.** If a stat is per row, count rows; if it is per
  field, name it `*FieldsChanged`. Rename rather than reinterpret.
- **A comment that lied is rewritten to what the code does now**, or, if the code was wrong,
  the code is fixed and the comment kept. Never leave both.
- **Do not widen.** A quirk fix is the smallest change that makes the reproduction pass and
  nothing else. A tempting redesign discovered on the way is a ROADMAP entry, not a batch.
- **Preserve documented behavior consumers rely on** even when it is odd. If a public helper's
  quirk is load-bearing, the fix is a correctly-named replacement plus a migration note, not a
  silent change (same rule as [`REFACTOR.md`](REFACTOR.md) §"Out of scope").

### 5. Repair the drift the fixes exposed

The sweep always finds documentation that a fix makes wrong twice over. In the same pass:
module headers, `README`/`ARCHITECTURE`/`docs/*`, the CLI usage text and its file header, the
route or option lists. The [`CONVENTIONS.md`](CONVENTIONS.md) §4 documentation & reference rules
apply verbatim — no scratch-file pointers, the source is the source of truth, comments state
intent not history.

### 6. Report

The hand-off is three lists, each with numbers, and nothing else:

1. **Fixed** — grouped by layer, one line each: what was wrong, what it now does, where the
   test is. Lead with the one the operator asked for.
2. **Not changed** — confirmed but deliberately left, each with its reason (design decision,
   load-bearing behavior, feature not bug) so the next pass does not re-discover it.
3. **Checked and dropped** — reported by a reader, not reproducible, with the one-line reason.

Then the gate counts before and after (`npm test`: 268 → 285, all green; lint 0/0; coverage
findings resolved). "All green" without counts is not a report.

## Why each part is there (learned the hard way)

These are the reasons the steps are ordered as they are; they come from real passes, in this
suite and its siblings.

- **Readers find, verifiers decide.** A single reader on the whole tree returns the first ten
  things that look odd and stops. Three readers each on a third, told to rank and to verify,
  returned some forty ranked findings — and, between them, a dozen candidates they had already
  checked and dropped, which were exactly the ones a rushed pass would have "fixed" into a new
  bug (a guard existed two calls up; a test already pinned the behavior; a lock had no await
  between check and set). The drop list is not waste; it is the record that those need no
  further attention.
- **The named quirk first.** The operator's example is the only finding you know is a quirk *to
  them*. Fixing it first calibrates the rest: it showed, once, that "reports changes" meant
  "columns not rows" *and* "rewrites identical values" — two fixes, one complaint.
- **Idempotence is where the bugs hide.** Eight of one pass's confirmed findings were of the
  form "run it twice": a sync that reported every row updated forever, an import that bumped
  every revision on identical input, a link pass that created duplicates on run one and crashed
  on run two, a migration marker written with a plain `INSERT`. None failed a test, because
  tests run things once. Every importer, sync and migration in scope gets the two-run check.
- **Twins are found by shape.** Six copies of an error mapper had three different status
  mappings; a reader grepping by name saw one function. Grep by the *constant* (`409`,
  `NOT_FOUND`), by the *structure* (`try { return fn() } catch`), by the *message*.
- **Comments claim; modules verify.** "No `BASE_URL` override here so a stale `.env` can never
  redirect a client" was true of the module it sat in and false of the sibling client three
  directories away. A comment that states a codebase-wide invariant is a finding until the whole
  codebase is checked.
- **Wrong delimiter, right exit code.** A migration script parsed a semicolon file with commas:
  the header became one column, every lookup missed, three filters skipped zero rows, and it
  logged 🎉 *complete*. Success messages that do not carry the numbers they summarize are how a
  quirk survives for years.
- **A fix without a test is a comment.** The idempotence fixes above are one `if` each; the
  next refactor would remove them as redundant. The test is what makes the fix a fact.
- **The LAN moment.** A feature that makes people bind a local server to the network turned
  every "localhost-only by construction" assumption in the tree into a hole. New capability
  changes what old assumptions mean; the sweep after a capability lands is not optional.

## Scope knobs

- **Whole repo (default).** All areas, all classes.
- **Scoped** ("run QUIRKS for `@jarenjs/json`") — that package plus everything that consumes it,
  same classes; twins found across the boundary are still collapsed into the correct parent.
- **Class-scoped** ("idempotence only", "docs drift only") — allowed when the operator names it;
  say so in the report so nobody mistakes it for a full pass.
- **After a campaign** — [`CAMPAIGN.md`](CAMPAIGN.md) §"Close-out" schedules a scoped hunt over
  what the campaign built; the report goes into the close-out record.

## Definition of done

`npm run site:gate` green end to end (CONVENTIONS §2): lint at zero errors and zero warnings,
`npm test` across all packages **with the new regression tests counted in the report**, and the
dead-code audit with every finding resolved — a quirk fix that removes a dead flag often removes
a dead branch, so that stage earns its re-run more than any other here. Then: the three-list
report written; every doc the fixes touched repaired; no scratch planning file created.

## Acceptance checklist

- [ ] Started from a **clean working tree**; baseline gate counts recorded before the first
      change.
- [ ] The operator's named quirk fixed first, with a test, and demonstrated the way the operator
      would notice.
- [ ] Sweep run **by area, in parallel, with the taxonomy brief**; each finding carries
      `file:line`, input → wrong output, confidence, minimal fix.
- [ ] **Every finding reproduced by the verifier** before a line changed; the three lists exist
      (fixed / not changed with reason / checked and dropped with reason).
- [ ] Every confirmed quirk has a regression test asserting exact corrected values.
- [ ] Twins collapsed to one implementation in the correct parent; no fix applied in more than
      one place.
- [ ] Every importer/sync/migration in scope passed the two-run check (second run: zero
      changes, zero revision bumps, same counts).
- [ ] Comments and documents the fixes made stale are repaired; no scratch-file pointers
      introduced; the source is the source of truth.
- [ ] Gates green with counts in the report; dead-code audit re-run after fixes.
- [ ] Nothing widened: redesigns and feature gaps went to the ROADMAP or the *not changed* list.

## Close-out & commit protocol

**Default: stop for review** with the three-list report; leave the work uncommitted on the
current branch. Only when explicitly asked to commit, run [`CONVENTIONS.md`](CONVENTIONS.md) §6
unchanged (gates → patch bump → deploy → single one-line commit → tag → push with tags). A quirk
hunt's one-liner names the theme, not the list
(`Made imports idempotent and unified API error status mapping`).

## Out of scope

- Redesigns, new capability, API additions — ROADMAP or a campaign.
- Style, formatting, naming preferences.
- Changing load-bearing quirky behavior of a published helper without a named replacement.
- Fixing anything you could not reproduce.
- Committing, tagging, pushing or deploying on the pass's own initiative.
