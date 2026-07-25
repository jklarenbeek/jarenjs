# <PROGRAM NAME> — program router

<One paragraph: what this program builds and why, in terms a fresh
session can act on. Name the packages touched and the end state.>

## Fixed decisions (do not reopen)

- **D1 — <name>.** <The decision, one sentence of rationale, and what
  an executor must therefore never do.>
- **D2 — …**

<D-numbers are immutable for the life of the program. An executor who
believes one is wrong records the conflict in the session record; only
the operator may amend the router.>

## Work orders, in execution order

| WO | Title | Depends on | Status |
| --- | --- | --- | --- |
| A | <title> | — | open |
| B | <title> | A | open |

<Each work order is a separate file next to this router, named
`WO-<letter>-<slug>.md`, self-contained per the WORK-ORDER template.
Update Status (open → done <date>) as records land; the router is the
single place execution order and progress live.>

## Definition of done (program-wide)

Every work order ends green from the repo root: `npm run lint` 0/0,
`npm test` all packages, `npm run website:build`, and
`npm run benchmark:coverage` with zero unresolved findings — plus
whatever its own acceptance checklist adds.
