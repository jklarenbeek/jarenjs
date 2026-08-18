# CAMPAIGN.md — authoring and running a multi-order campaign

A **campaign** is how this monorepo takes on a body of work too large for one
session: a **router** that settles the decisions once, and a series of numbered,
self-contained **work orders** that a fresh session can execute from the router,
the order and the repo alone. The suite's engines, its studios, its data layer and
its playground were all built this way.

This file is the **authoring** playbook — how to decompose the work, what the
router must contain, and the rails that keep a campaign honest.
[`CONVENTIONS.md`](CONVENTIONS.md) is the companion: it holds, once, the rules
every session obeys (repo model, gates, artifact naming, documentation rules,
close-out) and binds the **executor**; the work-order and session-record shapes
referenced throughout are in [`templates/`](templates/). Read that file too;
this one does not restate it.

Authoring a campaign is itself a deliverable. A router that is vague, unmeasured,
or that leaves a fork open is not a plan — it is a promise that every executor
session will improvise differently.

## When a campaign is the right shape

| The work | The shape |
|---|---|
| One change, one session, one checklist | a single work order |
| Duplication, drift, dead code — no new capability | [`REFACTOR.md`](REFACTOR.md), which is idempotent and may find nothing |
| "Something is off and nobody knows how much" — quiet bugs, non-idempotent syncs, lying counts, false comments | [`QUIRKS.md`](QUIRKS.md), the evidence-first hunt: sweep, reproduce, fix with a test, report the drop list |
| A capability that needs several dependent steps, shared decisions, and a nameable end state | **a campaign** |
| A list of unrelated wants | [`ROADMAP.md`](../ROADMAP.md) — not a campaign |

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
- **Session record** — `TODO_<PROGRAM>_NN_RECORD.md`, written by the executor
  after the order is green ([`templates/session-record.md`](templates/session-record.md));
  its Handoff section carries what the next session must know.

`<PROGRAM>` is a short upper-case slug naming the capability, not the package
path. Numbering never renumbers: an order that turns out to be two orders becomes
`NN` plus a **new highest number**, never `NN_a`/`NN_b`.

**These files are gitignored scratch** — the naming, where session records
live, and why nothing committed may point at them are [`CONVENTIONS.md`](CONVENTIONS.md) §3
and §4. Two consequences bind every campaign: no committed file names a specific `TODO_*`
file (restate the intent where it belongs instead), and before clearing a campaign the
router's ledger is checked for unexecuted orders whose intent must first move to
[`ROADMAP.md`](../ROADMAP.md).

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

**A scoped quirk hunt is part of measuring.** Before authoring, run
[`QUIRKS.md`](QUIRKS.md) over the packages the campaign will touch — parallel readers
with the taxonomy brief, every finding reproduced by you. What it returns changes the
plan in three ways, which is why it comes before the order list and not after:

- A confirmed quirk *in the campaign's path* becomes a **Step 0** or its own early order,
  so no later order builds on it. Building a new sync on top of a link pass that
  duplicates rows on run one and crashes on run two is a campaign that fails in order 04
  for a reason authored in order 00.
- A confirmed quirk *beside* the path goes to the ROADMAP or to a reserved order — named,
  not fixed in passing, because a campaign never widens.
- The **checked-and-dropped list** goes into the router verbatim. It is the cheapest
  section a router has: it stops seven executors from each re-investigating the same
  suspicious-looking guard.

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
   starting loss cannot prove it closed it. Include the pre-campaign quirk hunt's
   three lists (confirmed-in-path, confirmed-beside-path with disposition,
   checked-and-dropped with reasons) — see Authoring rule 1.
3. **Fixed decisions (D1, D2, …).** See below.
4. **Cross-cutting contracts.** The constraints every order obeys that are not
   decisions but obligations: house rules, the dependency arrow, the gates,
   `docs/DESIGN.md` where visual work is involved, where shared code must land. A
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

Per [`templates/work-order.md`](templates/work-order.md), plus
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
  regenerated and published, drift gates extended, site surfaces updated — **and a
  scoped [`QUIRKS.md`](QUIRKS.md) hunt over what the campaign built.** New capability
  is where quirks are born (a feature that makes people bind a server to the network
  turns every "localhost-only by construction" assumption into a hole; a new importer
  is non-idempotent until proven otherwise). The close-out record carries the hunt's
  three lists next to the baseline table.

## Non-negotiables (inherited, not restated)

Every order obeys [`CONVENTIONS.md`](CONVENTIONS.md) — the repo model (§1), the gates by
exit code with numbers in the record (§2), the documentation rules (§4), the clean-tree
preflight and uncommitted-on-`main` rule (§5) — and the router says so once. Two rules are
campaign-specific enough to state here:

- **No redundancy, enforced during the campaign.** A campaign is where duplication
  is born: two orders each need an escape helper, a slug, a hash. The
  [`REFACTOR.md`](REFACTOR.md) placement rules apply *while* building, not
  afterwards — pure helpers to `@jarenjs/core`, vnode/URL work to
  `@jarenjs/view/helpers`, app orchestration to `@jarenjs/app`. Make it checkable:
  an order that could grow a duplicate carries an acceptance line asserting
  **exactly one implementation exists**, grep-proven in the record.
- **Anything an order builds that imports, syncs, migrates or reconciles passes the
  two-run check** before its record is written: the second run on identical input
  changes nothing, bumps no revision, and reports zero — asserted by a test, not by
  running it twice by hand. This is [`QUIRKS.md`](QUIRKS.md)'s most productive check
  and the one campaigns most often skip because "it worked". And the record carries
  the drop list (what was investigated and found unfounded), so the next executor
  and the close-out hunt do not repeat it.

## Documentation & reference rules

[`CONVENTIONS.md`](CONVENTIONS.md) §4, in full — with three of its rules being the ones a
campaign most often breaks: **no committed file references a campaign's scratch files** (not
code, not comments, not documentation, not a commit message — restate the intent, never
flatten it into a hollow word); **`ROADMAP.md` lists open work only** (a campaign *closes*
entries by moving shipped capability into the package docs, and narrows what stays open to
an accurate decision); and **published figures are derived, never typed** — the campaign that
re-measures refreshes them through the benchmark-figure gate, and **reports the loss** beside
the win.

## Running the campaign

1. Author the router (§"The router") and every order (`templates/work-order.md`). Settle the D-numbers
   there, once. Hand the campaign to the operator for review **before** executing.
2. Per order: a fresh session holding
   [`BOOTSTRAP.md`](BOOTSTRAP.md), the router and that order.
   It executes, proves the gates, writes the session record, updates the router's
   status ledger; the record's Handoff section carries what must cross the
   session boundary.
3. **Work lands on `main`, uncommitted, for review.** No executor commits, tags,
   pushes or branches on its own initiative. No `PROGRESS*.md` is created for a
   run — the session record and the commit message carry the summary.
4. The operator reviews and runs the close-out when satisfied.

## Close-out & commit protocol

Per order, and only when the operator explicitly asks, run [`CONVENTIONS.md`](CONVENTIONS.md)
§6 unchanged; a phase-opening order takes a minor bump instead of a patch. `git add -A`
stages the work — confirm the gitignored campaign files are excluded, never force-add them.

## Acceptance checklist — for the authoring pass

- [ ] Preflight held: clean tree, no other campaign in flight, and the baseline
      was **measured**, not copied from existing documentation — including a scoped
      quirk hunt over the packages in scope, its findings dispositioned (Step 0 /
      early order / ROADMAP / dropped-with-reason) in the router.
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
- [ ] The close-out quirk hunt ran over what the campaign built; its three lists are in
      the close-out record; every confirmed quirk in the campaign's own code is fixed
      with a regression test or named in the ROADMAP with its reason.
- [ ] No committed code, comment or document references a scratch file.

## Out of scope

- Executing orders while authoring. Authoring produces the plan; the operator
  reviews it before any code moves.
- Committing, tagging, pushing or deploying on the campaign's own initiative.
- Creating a `PROGRESS*.md`, or any scratch planning file beyond the router, the
  orders and the session records.
- Amending a D-number from inside an order.
- Widening a campaign mid-flight. New work found while executing goes to the
  ROADMAP or to a new numbered order — never into an order already under way.
