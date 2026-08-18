# Workflow conventions

The rules that make the work-order workflow reproducible. They bind
every executor session; BOOTSTRAP.md is their operational summary.

## The four artifacts

- **Router** (`ROUTER.template.md`) — one per program: charter, fixed
  D-number decisions, the ordered work-order table with status. The
  single source of execution order and progress.
- **Work order** (`WORK-ORDER.template.md`) — one per step,
  self-contained: a fresh session with no conversation context executes
  it from the bootstrap prompt, the router, the work order and the repo
  alone. Ends in an acceptance checklist, which IS the definition of
  done.
- **Session record** (`SESSION-RECORD.template.md`) — one per executed
  work order, written after the work is green: Summary / Files /
  Decisions & divergences / Test & benchmark output / Open issues.
- **Handoff note** (`HANDOFF.template.md`) — carries state between
  sessions when open follow-ups, deferred items or cross-package
  contracts must survive the context boundary.

## Binding rules

1. **D-numbers are immutable.** A router decision is settled for the
   program's lifetime. An executor who believes one is wrong records
   the conflict in the session record; only the operator amends the
   router.
2. **Work lands on `main`, uncommitted, for review.** No executor
   commits, tags, pushes or branches on its own initiative. The commit
   and release path is `docs/REFACTOR.md` §"Close-out & commit protocol",
   run only on the operator's explicit ask.
3. **Every work order ends green** before its record is written:
   `npm run lint` at zero errors and zero warnings, `npm test` across
   all packages, `npm run website:build`, and
   `npm run benchmark:coverage` with every dead-code finding resolved.
4. **Committed artifacts never reference scratch.** Code, comments,
   docs and these workflow files never point at gitignored planning
   files; module headers describe the current role of the code, not
   how it came to be. (`docs/REFACTOR.md` §"Documentation & reference
   rules" is the long form.)
5. **The source is the source of truth.** When prose and code
   disagree, the code wins and the prose is repaired — never the
   reverse.
6. **Records are numbers, not adjectives.** Session records paste test
   counts and gate results; "all green" without counts is not a
   record. A record also names what was investigated and dropped
   (one line each: what, why not), so the next session and the
   close-out quirk hunt (`docs/QUIRKS.md`) do not repeat it.

## Running a program

1. Author the router and its work orders from the templates; settle
   the D-numbers there, once.
2. Per work order: start a fresh session with BOOTSTRAP.md, the
   router, and the work-order file. The session executes, proves the
   gates, writes the session record, updates the router's status row,
   and (when needed) the handoff note.
3. The operator reviews on `main` and runs the close-out protocol when
   satisfied.

A worked example lives in `examples/`: a real work order executed by a
fresh session against this repository, with the session record it
produced.
