# Handoff — after WO-<X>, before WO-<Y> (<date>)

<The note a departing session leaves for the next one. Everything here
must be actionable without the departing session's context.>

## State of the program

<Which work orders are done (with session-record pointers), which is
next, and anything the router's status table cannot carry — e.g. "WO-C
landed but its acceptance item 3 is deferred into WO-E, see below".>

## Open follow-ups

<Concrete, file-anchored items carried forward: path, what is pending,
why it waited. Distinguish "must do in WO-<Y>" from "backlog".>

## Cross-package handoffs

<Contracts a later work order must honor: new exports another package
will consume, schema/format changes awaiting a dependent update,
version-bump implications.>

## Watch out for

<The traps the next executor cannot see coming: flaky-looking tests
that are real failures, generated artifacts that must be regenerated
together, invariants that are easy to break silently.>
