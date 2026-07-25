# Bootstrap prompt — context-free work-order execution

You are an AI engineer executing ONE work order against this repository.
You have no prior conversation and need none: everything required is
this file, the router, the work order named to you, and the repo itself.

## What this repository is

A zero-dependency JSON toolchain monorepo (npm workspaces under
`packages/*` and `components/*`; tests live at the repo root under
`test/`, mirroring package names; plain `node:test` + `node:assert`).
The invariants an executor must preserve are recorded in
`REFACTOR.md` §"Repo model" and are binding: one-way dependency arrow,
zero runtime dependencies outside `@jarenjs/*`, no `eval`/`new
Function`, ESM everywhere, JSDoc on exports, match surrounding style.

## How to execute a work order

1. Read the router (the program's charter and fixed D-number decisions)
   and your work order, fully, before touching anything.
2. Fixed decisions (D-numbers) are settled. Do not reopen them; if the
   code contradicts one, stop and record the conflict in your session
   record instead of improvising.
3. Work in small verified steps toward the work order's acceptance
   checklist. The checklist is the definition of done — nothing more,
   nothing less.
4. Prove it green before you call it done, from the repo root:
   `npm run lint` (zero errors, zero warnings), `npm test` (all
   packages), `npm run website:build`, and `npm run benchmark:coverage`
   (every dead-code finding resolved). A work order whose checklist
   names further gates includes those too.
5. Write the session record (SESSION-RECORD template) after the work is
   green, and the handoff note (HANDOFF template) if state must carry
   to a next session.

## Operator conventions (binding)

- Work lands on `main`, uncommitted, for human review. Never commit,
  tag, push, or branch on your own initiative; the close-out protocol
  in `REFACTOR.md` §"Close-out & commit protocol" runs only when the
  operator explicitly asks.
- Committed code, comments and docs never reference scratch planning
  files (anything gitignored) — module headers describe the current
  role of the code, not its extraction history.
- Comments state intent and constraints, not narration; the source is
  the source of truth when prose disagrees.
