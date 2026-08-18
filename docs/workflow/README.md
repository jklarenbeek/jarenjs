# The workflow — how this repository is changed and shipped

Everything in this folder is **process**: what a session or a person does to
change Jaren, prove it, and release it. Product documentation — how to *use*
Jaren — lives one level up in `docs/` (`HOWTO.md`, `CONSUMING.md`,
`ARCHITECTURE.md`, `ROADMAP.md`, `DESIGN.md`, `SECURITY.md`,
`MIGRATING-FROM-ZOD.md`).

Read in this order:

| File | Role |
|---|---|
| [`CONVENTIONS.md`](CONVENTIONS.md) | **The rules, once** — repo model, gates, artifact naming, documentation rules, decisions & authority, the close-out & commit protocol. Every other file here points at it. |
| [`BOOTSTRAP.md`](BOOTSTRAP.md) | The prompt a fresh session is handed to execute one work order from the router, the order and the repo alone. |
| [`CAMPAIGN.md`](CAMPAIGN.md) | **Build** — authoring a multi-order campaign: measure first, settle decisions once in a router, write self-contained orders. |
| [`REFACTOR.md`](REFACTOR.md) | **Tidy** — the idempotent codebase-health pass: find duplicates, collapse each into its logical parent, repair drifted docs; moves and never changes behavior. |
| [`QUIRKS.md`](QUIRKS.md) | **Hunt** — the evidence-first audit for what is wrong but not loud; the one pass allowed to change behavior, because every fix ships with its reproduction as a test. |
| [`PUBLISHING.md`](PUBLISHING.md) | **Ship** — npm authentication, synchronized versioning, the compatibility policy, release checks, provenance. |
| [`templates/`](templates/) | The work-order and session-record shapes — each file is the template followed by a real one, executed by a fresh session against this repository. The router's shape is specified in `CAMPAIGN.md` §"The router". |

Campaign files are gitignored scratch — `TODO_<PROGRAM>.md` (router),
`TODO_<PROGRAM>_NN.md` (orders), `TODO_<PROGRAM>_NN_RECORD.md` (records) —
`CONVENTIONS.md` §3.
