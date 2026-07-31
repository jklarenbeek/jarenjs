# @jarenjs/flow

Executable workflow documents. This package defines the **jaren-fsm
format** — a finite state machine as one JSON value: declared states, an
initial state, and a document-ordered transition table whose guards and
effect props are [Jaren JSON Query](../json/docs/QUERY-FORMAT.md)
documents — and compiles it, once, into a **pure step function**.

It is the executable half of a round trip the suite already ships: a
`stateDiagram-v2` parsed by [`@jarenjs/mermaid`](../../components/mermaid)
projects (via a JSLT stylesheet) into exactly this shape, and this
engine runs it. The format is a strict superset of that projection
contract — every projected document compiles unchanged.

The grammar is published as JSON Schema in
[`schemas/jaren-fsm.schema.json`](schemas/jaren-fsm.schema.json) (with a
mechanically derived draft-07 twin for providers pinned to older
drafts) — hand it to a constrained decoder and a language model cannot
emit a machine with an unknown member or a malformed guard. The
normative contract is [docs/FLOW-FORMAT.md](docs/FLOW-FORMAT.md). Zero
dependencies outside the suite; no `eval`, CSP-safe; the only runtime
import is `@jarenjs/json`.

## The format in one glance

```json
{
  "$fsm": "0.1",
  "initial": "idle",
  "states": [
    "idle",
    { "id": "loading", "entry": [{ "run": "fetch", "with": { "url": "$.context.url" } }] },
    { "id": "done", "final": true }
  ],
  "transitions": [
    { "from": "idle", "event": "start", "to": "loading" },
    { "from": "loading", "event": "ok", "guard": "$.payload.fresh", "to": "done" },
    { "from": "loading", "event": "fail", "to": "idle" }
  ]
}
```

Guards are asserted by effective boolean value against one scope —
`{ state, event, payload, context }` — and **effects are data**: a fired
transition returns resolved `{ run, with? }` descriptors (exit →
transition → entry); the engine never executes them. Which registry runs
them is the host's business, the same boundary discipline as
`@jarenjs/app` effects.

## Usage

```javascript
import { compileFsm, createFsmSession } from '@jarenjs/flow';

const fsm = compileFsm(doc);        // throws FlowCompileError (JF0xxx) on a bad document
fsm.initial;                        // 'idle'
fsm.states;                         // ['idle', 'loading', 'done'] (frozen)
fsm.events('loading');              // ['ok', 'fail'] (frozen)

// The pure core: state in, result out. Nothing is held, nothing runs.
const r = fsm.step('loading', 'ok', { payload: { fresh: true }, context: { url: '/api' } });
r; // { changed: true, state: 'done', effects: [], final: true, errors: [] }

// The thin mutable convenience over it:
const s = createFsmSession(fsm);    // starts at doc initial
s.can('start');                     // true — a dry run (step is pure, so can() IS step())
s.send('start');                    // advances; returns the same result shape
s.state;                            // 'loading'
s.done;                             // final-state flag
```

`step` is **total over machine input**: an event no transition answers
is ignored (`changed: false`, no effects) — the conventional FSM
reading. Only caller mistakes throw: an undeclared state id or a
non-string event (`FlowRuntimeError`, JF2001/JF2002).

## Fail closed, report precisely

A guard that throws at evaluation reads **false**; an effect whose
`with` throws is **omitted**. Neither aborts the step — each appends a
plain-data record `{ code, docPath, message }` to the result's `errors`
array, where `docPath` is a JSON Pointer to exactly the query that
failed (`/transitions/2/guard`). That is the suite's standard
machine-repairable error shape: a host surfaces the records through its
own error channel, and a repair loop knows precisely what to fix.

Compile-time failures throw `FlowCompileError` with the same `code` +
`docPath` discipline (JF0001–JF0009, table in
[FLOW-FORMAT.md §5](docs/FLOW-FORMAT.md)); a guard that cannot compile
is a compile error, never a runtime surprise.

## One scope, one honest quirk

`$.state`, `$.event`, `$.payload`, `$.context` — control state lives in
the machine, data state lives in the host, passed per call. A guard
written as a plain string that does not start with `$` is a *literal*
(query semantics), and a non-empty literal is EBV-**true**: a display
guard carried over from a diagram label (`count > 3`) is vacuously true
by design, because a picture's annotation must not change execution.
Real conditions are `$`-paths (`"$.payload.fresh"`) or operator
documents (`{ "$gt": ["$.context.count", 3] }`).

## Development

Unit tests live in `test/flow/` at the repository root
(`npm run test:flow`). See the repository [README](../../README.md) for
the full suite documentation.
