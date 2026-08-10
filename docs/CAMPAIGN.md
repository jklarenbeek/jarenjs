# CAMPAIGN.md — authoring and running a multi-order campaign

A **campaign** is how this monorepo takes on a body of work too large for one
session: a **router** that settles the decisions once, and a series of numbered,
self-contained **work orders** that a fresh session can execute from the router,
the order and the repo alone. The suite's engines, its studios, its data layer and
its playground were all built this way.

This file is the **authoring** playbook — how to decompose the work, what the
router must contain, and the rails that keep a campaign honest.
[`workflow/CONVENTIONS.md`](workflow/CONVENTIONS.md) is the companion: it binds
the **executor**, and its four artifact templates (router, work order, session
record, handoff) are the shapes referenced throughout. Read that file too; this
one does not restate it.

Authoring a campaign is itself a deliverable. A router that is vague, unmeasured,
or that leaves a fork open is not a plan — it is a promise that every executor
session will improvise differently.

## When a campaign is the right shape

| The work | The shape |
|---|---|
| One change, one session, one checklist | a single work order |
| Duplication, drift, dead code — no new capability | [`REFACTOR.md`](REFACTOR.md), which is idempotent and may find nothing |
| A capability that needs several dependent steps, shared decisions, and a nameable end state | **a campaign** |
| A list of unrelated wants | [`ROADMAP.md`](ROADMAP.md) — not a campaign |

The test: **can you name the end state in one sentence, and does getting there
require decisions that more than one order would otherwise re-litigate?** If yes,
write a campaign. If the second half is no, write one work order.

A campaign is **not** a container for everything touching a package. Unrelated
work that happens to live in the same directory belongs in its own campaign or in
the ROADMAP.

## The artifacts and their names

- **Router** — `TODO_<PROGRAM>.md`. One per campaign. The charter, the measured
  baseline, the fixed decisions, the order table, the status ledger.
- **Orders** — `TODO_<PROGRAM>_NN.md`, numbered from `01` in execution order,
  restarting at `01` for every campaign. Each is self-contained.
- **Session record** and **handoff note** — per
  [`workflow/CONVENTIONS.md`](workflow/CONVENTIONS.md), written by the executor.

`<PROGRAM>` is a short upper-case slug naming the capability, not the package
path. Numbering never renumbers: an order that turns out to be two orders becomes
`NN` plus a **new highest number**, never `NN_a`/`NN_b`.

**These files are gitignored scratch** (`.gitignore` matches `TODO*.md` and
`PROGRESS*.md`), which has two consequences that bind every campaign:

1. They will not exist in a fresh clone. **No committed file may point at one.**
   Naming the *convention* — as this document does — is fine; naming a *specific
   file* is the rot the rule exists to prevent. When a campaign's rationale needs
   to survive, it moves into committed documentation (package `README`,
   `ARCHITECTURE`, the format spec) as a statement of intent, never as a pointer.
2. They are not recoverable once deleted. Before clearing a campaign, check the
   router's status ledger for unexecuted orders and make sure their intent lives
   in [`ROADMAP.md`](ROADMAP.md) first.

`workflow/` uses `WO-<letter>-<slug>.md` for the same role. Both namings are
correct: `workflow/` is the **published, context-free harness**, so its examples
must be committed files; the in-repo campaigns are working scratch and use the
`TODO_` names. One workflow, two namings, chosen by whether the artifact ships.

## Preflight — abort unless all three hold

1. **The working tree is clean** — `git status --porcelain` prints nothing. A
   campaign that begins on top of unrelated in-flight work cannot be reviewed as a
   sequence of clean diffs. If the tree is dirty, say so and ask the operator to
   commit or stash first. (Gitignored scratch does not count — the command already
   ignores it.)
2. **No other campaign is in flight**, or the interaction is stated in the router.
   Two campaigns editing the same package produce merge pain and unattributable
   regressions.
3. **You have measured** — see the next section. Authoring from a document alone
   is the single most common way a campaign starts wrong.

## Authoring rule 1 — measure before you write a word of plan

**The ROADMAP, the READMEs and the last campaign's records are claims, not
evidence.** They were true when written. Re-derive every number and every
diagnosis the campaign will act on, from the code and from a run, *before*
deciding what the orders are.

This is not ceremony. In the markdown campaign the two open ROADMAP entries were
both wrong in ways that would have misdirected the entire program:

- The performance entry named three functions to optimize. A CPU profile showed
  all three sat inside a phase worth **a quarter** of the end-to-end cost, while
  an unnamed function in the *next* phase accounted for roughly a third of it on
  its own. Following the entry would have moved single-digit percentages.
- A quoted figure ("~0.32 ms") disagreed with the committed measurement (0.49 ms)
  for the same thing.

A campaign authored from those sentences would have shipped real work against the
wrong target. **Measure first, and put the measurement in the router.**

How to do it well:

- **Classify by cause, not by count.** "84 failures" is not actionable; "34 in
  this spec section, 13 in that one, 8 sharing a single root cause" is. A census
  bucketed by cause is what lets orders be scoped so they do not overlap.
- **Verify the classification you inherit.** In the same campaign, roughly eight
  failures the ROADMAP filed as one kind of problem turned out to belong to
  another order entirely — visible only by reading the actual expected-vs-actual
  output, not the summary.
- **Prefer a profile to an intuition**, and say which you have. An assumption
  recorded as an assumption is useful; an assumption recorded as a fact poisons
  every order downstream.
- **Record the recipe, not just the result**, so a later session can re-run it.
  Inline the recipe in the router; do not leave the campaign depending on a
  scratch script.

The result goes in the router under a heading that says **measured on `<date>`
with `<runtime>` — do not re-derive**, so seven orders do not each spend a session
rediscovering it. Earlier campaigns used the same device with a "verified
`<date>`, do not re-derive" section establishing that the mechanism a campaign
intended to package **already existed in the engine** — which is what let that
campaign be three small orders instead of a rewrite.

## Authoring rule 2 — settle the forks with the operator, not in the orders

Where two readings of the goal produce **materially different campaigns**, stop
and ask the operator before authoring. Ask concretely: name the fork, give the
options, state which you recommend and why, and show what each costs.

The markdown campaign had three such forks — whether an architectural limit
should be accepted or dissolved, whether to widen scope past the tracked items,
and how to treat overlapping uncommitted work. Each answer changed the order list.
Asked up front they took one exchange; discovered mid-campaign they would have
invalidated finished orders.

Every answer becomes a **D-number** in the router. That is the point of asking.

## The router — required sections, in this order

1. **Title and charter.** One paragraph a fresh session can act on: what this
   campaign builds, which packages it touches, and the end state. Include a
   **north-star statement** — one sentence, set off as a block quote, that an
   executor can hold the whole campaign against. Vague charters produce vague
   orders.
2. **The measured baseline.** Dated, with the runtime, marked *do not re-derive*.
   Tables, not adjectives. Include the numbers the campaign will be judged on —
   **especially the ones that currently look bad.** A campaign that hides its
   starting loss cannot prove it closed it.
3. **Fixed decisions (D1, D2, …).** See below.
4. **Cross-cutting contracts.** The constraints every order obeys that are not
   decisions but obligations: house rules, the dependency arrow, the gates,
   `DESIGN.md` where visual work is involved, where shared code must land. A
   campaign with a recurring theme gives it its own named section and says which
   orders it binds — one past campaign carried a binding mobile contract in the
   router, so a single fix hardened every surface that reused the primitive.
5. **Preflight**, if this campaign needs something done before order 01 (landing
   overlapping work, a submodule, a decision from the operator).
6. **The order table** — number, file, one-line scope, size estimate (S/M/L), and
   whether it deploys.
7. **Sequencing** — the dependencies in prose, with the *reason* for each. "02
   before 03 because 02 settles what the scorecard measures" is a reason; "02
   before 03" is not.
8. **Definition of done (program-wide)** — what must be true when the last order
   lands, beyond each order's own checklist. This is where the campaign commits to
   closing ROADMAP entries, publishing measurements, and documenting capability.
9. **The status ledger** — a checklist, one line per order, updated as records
   land: `- [x] TODO_<PROGRAM>_01 — <title> (SHIPPED v0.x.y)`. The router is the
   single place progress lives.

## D-numbers — what qualifies

A D-number is a decision that **more than one order would otherwise re-open**. It
is immutable for the life of the campaign. An executor who believes one is wrong
records the conflict in the session record; **only the operator amends the
router.**

Qualifies:

- A boundary — what the campaign will never do, and why.
- A default, especially a surprising one, **with its reason attached**. A default
  whose rationale is not written down gets "fixed" by a later reader.
- A home — which package owns a shared concept, so two orders do not each grow
  their own copy.
- A trust or safety rule that several orders could erode independently.
- A reporting rule — how the campaign's numbers get published, so a late order
  cannot quietly drop an unflattering one.

Does not qualify: an implementation detail inside one order (that belongs in its
Design section), a preference with no cross-order effect, or a restatement of an
existing house rule (cross-reference it instead).

Write each as **`D<n> — <short name>.`** then the decision, the rationale in a
sentence, and what an executor must therefore never do. The last clause is what
makes it enforceable.

## The order file — required sections

Per [`workflow/WORK-ORDER.template.md`](workflow/WORK-ORDER.template.md), plus
two campaign-specific obligations:

- **A router pointer and the binding D-numbers**, first line. Then **"Read
  first:"** — the specific files, with the functions and line references that
  matter, whose conventions the new code must match. A fresh session cannot infer
  this, and an order that omits it produces code that does not look like the repo.
- **Goal** — the observable end state, not the activity.
- **Design** — the intended shape: module boundaries, data shapes, error surfaces,
  edge rules, and **the reasoning behind any non-obvious choice**. Decisions made
  here are made; an executor extends them, it does not re-litigate them. Where an
  order carries a diagnosis (a bug's root cause, a group of failures sharing one
  fix), put it here in full — with the concrete input and the expected-vs-actual
  output. An order that says "fix the emphasis rules" costs a session of
  rediscovery; one that shows the failing case and names the spec clause does not.
- **Files** — what changes, with one clause each.
- **Steps** — ordered, each small enough to test, with `npm test` between batches
  so a regression is attributable.
- **Acceptance checklist** — behavioral assertions, each independently checkable,
  with exact names, outputs and error codes. **This IS the definition of done.**
  It always ends with the full gate and the session record.

**"Step 0 — re-measure" is mandatory when an earlier order moves this order's
target.** State it as the first step, with the reason. In the markdown campaign
the conformance order opens by re-running the census, because the order before it
converts a chunk of the failures — working from the router's pre-campaign table
would have sent it chasing already-fixed bugs.

## Sizing and sequencing

- **3–9 orders** is the observed range. Fewer means it was probably one order;
  more means the campaign is really two, or the orders are too small to justify a
  session each.
- **Sequence by dependency first, then by risk.** The order that *settles a
  measurement target* or *establishes a shared home* goes early, so later orders
  are not measured against a moving baseline. The order that touches **committed
  documents** or public surfaces goes late, when the thing being documented has
  stopped changing.
- **Deliver something visible early.** The smallest order with a user-facing
  effect is a good `01`: it proves the campaign's plumbing and gives the operator
  something to review.
- **Long campaigns take phases.** Group orders into phases with a **close-out
  order at each boundary** that proves the phase whole — docs, benchmarks, gates
  — rather than trailing loose ends into the next phase. Convention: a **patch**
  bump per order, a **minor** bump opening a phase.
- **A reserved order is allowed** — numbered, written, and explicitly marked not
  scheduled — when a campaign wants to prove its model generalizes without
  committing to build it now.
- **An order's open tail becomes a new numbered order**, never a silent extension
  of the finished one and never a reopened D-number.
- **Every campaign ends with a close-out order**: ROADMAP entries retired or
  narrowed, capability documented where a stranger would look, measurements
  regenerated and published, drift gates extended, site surfaces updated.

## Non-negotiables (inherited, not restated)

Every order obeys, and the router says so once:

- **The repo model and house rules** — [`REFACTOR.md`](REFACTOR.md) §"Repo model"
  is normative: the one-way dependency arrow, the two-layer component rule, zero
  runtime dependencies outside `@jarenjs/*`, no `eval`/`new Function`, two-stage
  compilers, JSDoc on exports, tests as plain `node:test`/`node:assert` under
  `test/`.
- **The gates.** Every order ends green from the repo root: `npm run lint` at zero
  errors **and** zero warnings, `npm test` across all packages,
  `npm run website:build`, and `npm run benchmark:coverage` with every dead-code
  finding resolved. Orders touching packaging add `npm run test:tree-shaking`;
  orders touching visual code add the `DESIGN.md` sweep including the banned-hue
  grep over `src` **and** `dist`.
- **No redundancy, enforced during the campaign.** A campaign is where duplication
  is born: two orders each need an escape helper, a slug, a hash. The
  [`REFACTOR.md`](REFACTOR.md) rules apply *while* building, not afterwards — pure
  helpers to `@jarenjs/core`, vnode/URL work to `@jarenjs/view/helpers`, app
  orchestration to `@jarenjs/app`. Make it checkable: an order that could grow a
  duplicate carries an acceptance line asserting **exactly one implementation
  exists**, grep-proven in the record.
- **Records are numbers, not adjectives.** "All green" without counts is not a
  record.

## Documentation & reference rules

1. **No committed file references a campaign's scratch files.** Not code, not
   comments, not documentation, not a commit message. When intent must survive,
   restate it where it belongs and drop the pointer — never flatten a named unit
   of work into a hollow word.
2. **The source is the source of truth.** When prose and code disagree the code
   wins and the prose is repaired. If the code itself looks wrong, surface it in
   the session record rather than papering over it.
3. **Comments state intent and constraints, not history.** No "added in order 04",
   no migration narration.
4. **ROADMAP.md lists open work only.** A campaign *closes* entries by moving
   shipped capability into the package docs. Do not delete an item to make a
   section look finished, and do not keep a closed one out of caution — if
   something remains genuinely open, leave a **narrow, accurate** entry naming the
   decision and its reason.
5. **Published figures are derived, never hand-written.** Numbers quoted in
   committed markdown come from the committed measurements through the
   benchmark-figure gate (`npm run docs:benchmarks`, `npm run docs:check`). A
   campaign that re-measures refreshes them; it does not retype them.
6. **Report the loss.** If a campaign's own measurement comes out worse than a
   rival's, it is published beside the wins. A campaign may not quietly omit the
   number it set out to improve.

## Running the campaign

1. Author the router and every order from the templates. Settle the D-numbers
   there, once. Hand the campaign to the operator for review **before** executing.
2. Per order: a fresh session holding
   [`workflow/BOOTSTRAP.md`](workflow/BOOTSTRAP.md), the router and that order.
   It executes, proves the gates, writes the session record, updates the router's
   status ledger, and writes a handoff note when state must cross the session
   boundary.
3. **Work lands on `main`, uncommitted, for review.** No executor commits, tags,
   pushes or branches on its own initiative. No `PROGRESS*.md` is created for a
   run — the session record and the commit message carry the summary.
4. The operator reviews and runs the close-out when satisfied.

## Close-out & commit protocol

Per order, and only when the operator explicitly asks, run
[`REFACTOR.md`](REFACTOR.md) §"Close-out & commit protocol" unchanged: prove the
gates green, bump the patch version (`npm run version:patch` + `npm install`),
deploy the website, then commit as the repo user with a **single short one-line
message** — no body, no attribution, no person's name, no version in the message —
tag `v<new-version>`, and push with tags. The version lives only in the tag. A
phase-opening order takes a minor bump instead of a patch.

`git add -A` stages the work; confirm the gitignored campaign files are excluded
before committing, and never force-add them.

## Acceptance checklist — for the authoring pass

- [ ] Preflight held: clean tree, no other campaign in flight, and the baseline
      was **measured**, not copied from existing documentation.
- [ ] Every fork that would change the order list was put to the operator and
      answered; each answer is a D-number.
- [ ] The router has all nine required sections, and the baseline is dated, names
      its runtime, and is marked *do not re-derive*.
- [ ] The charter's end state is one sentence, and every order visibly serves it.
- [ ] Every order is **self-contained**: a fresh session with the bootstrap, the
      router, that order and the repo could execute it — no conversation context,
      no reference to another order's internals, no pointer to a scratch file.
- [ ] Every order names its "Read first" files, carries its diagnosis in full, and
      ends in a checklist of independently checkable assertions plus the gate.
- [ ] Orders whose target an earlier order moves open with **Step 0 — re-measure**.
- [ ] Dependencies are stated **with reasons**; document-touching orders are late.
- [ ] The campaign closes every ROADMAP entry it claims to, and the close-out
      order says how.
- [ ] No committed file references the campaign's scratch files.

## Acceptance checklist — for the finished campaign

- [ ] Every order's status is recorded in the ledger with its shipped version.
- [ ] The end state named in the charter is true, and demonstrably so — the
      close-out record puts the router's baseline table beside the final numbers.
- [ ] The ROADMAP section the campaign targeted is closed, or narrowed to
      accurately-stated open decisions.
- [ ] Capability is documented where a stranger would look: package `README`,
      `ARCHITECTURE`, and the format spec for anything normative.
- [ ] Measurements regenerated and re-derived into the prose; the gate passes.
- [ ] Drift gates extended to cover what this campaign made worth gating — a gate
      that would have caught the drift the campaign found is worth more than a
      paragraph promising not to drift again.
- [ ] No committed code, comment or document references a scratch file.

## Out of scope

- Executing orders while authoring. Authoring produces the plan; the operator
  reviews it before any code moves.
- Committing, tagging, pushing or deploying on the campaign's own initiative.
- Creating a `PROGRESS*.md`, or any scratch planning file beyond the router, the
  orders, the session records and the handoff notes.
- Amending a D-number from inside an order.
- Widening a campaign mid-flight. New work found while executing goes to the
  ROADMAP or to a new numbered order — never into an order already under way.
