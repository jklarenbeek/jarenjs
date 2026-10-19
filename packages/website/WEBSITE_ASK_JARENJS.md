# Ask: Jaren — change requests from the websites

[Website README](README.md) · [Radiant OS design](../../docs/DESIGN.md#11-radiant-os) · Tangle requests: `docs/WEBSITE_ASK_TANGLEAI.md` in the tangleai repository

Two websites run Radiant OS on Jaren:

- the **Jaren edition**, this package's `src/os/`, which runs on this repository's
  own workspaces (HEAD);
- the **Tangle edition**, `apps/pages/src/os/` in the tangleai repository, which
  runs on the published `@jarenjs/*` **0.91.4**.

Building the studio (the crew game, the board, the mail, the library), the
arcade's three games and the language-model seat on them turned up the requests
below. Each one says what the OS does today to work around it, so that
workaround can go once the change ships. Paths are relative to this repository
unless they name the tangleai one.

**Blocking** means a website feature cannot ship without the change.
**Non-blocking** means the OS has a working workaround meanwhile. Please say
when a request should be shaped differently; the websites will adapt.

## Overview

| Id | Request | Package | Blocking | Status |
| --- | --- | --- | --- | --- |
| WJ-1 | A release carrying the worker-safe validator clock, `$round`, `$tokenize` and the audience in `describe()` | validate, json, contract | No | Requested 2026-10-19 |
| WJ-2 | Subscription and effect handlers that can read the state at their first start | app | No | Requested |
| WJ-3 | Name `$seq` when `$min` or `$max` is handed an argument list | json | No | Requested |
| WJ-4 | `$round` over a bare expression, as `$floor` and `$ceiling` take one | json | No | Requested |
| WJ-5 | Suggestions that keep an operator's meaning (`$gte` → `$ge`) | json | No | Requested |
| WJ-6 | A "has a value" test beside `$exists` | json | No | Requested |
| WJ-7 | A synchronous run for DAGs made only of query nodes | flow | No | Requested |
| WJ-8 | An operation without input that takes `{}`, or says why not | contract | No | Requested |

## WJ-1 — A release carrying four things the Tangle edition needs

**Today.** The Tangle edition consumes 0.91.4, which lacks four things HEAD has:

- **The validator's clock in a worker.** In 0.91.4 `@jarenjs/validate` stamps
  every validation error with a `performance` object of its own: `window.performance`
  in a page, `process.hrtime()` everywhere else. A module worker has neither, so
  the first invalid input a contract rejects inside a worker throws
  `ReferenceError: process is not defined` instead of answering with the error.
  HEAD stamps with `globalThis.performance.now()` (`packages/validate/src/index.js`,
  `InternalValidationError`). The Tangle edition's database worker compiles its
  store contract with that validator (`apps/pages/src/os/db-worker.ts`), so the
  store contract both editions share answers its nullable reads as a type union
  rather than a `oneOf` — a failed `oneOf` branch records an error, and that
  error is what reaches for `process`.
- **`$round`.** 0.91.4 refuses it (`JQ0002: unknown operator '$round' (no operator
  does this in jaren-query)`). The OS rounds in its view models instead of in its
  documents.
- **`$tokenize`.** 0.91.4 has no way to split a string. The crew's setup form takes
  the employers' names with commas between them, so both editions split them in
  a host effect (`src/os/app/studio-host.js`, `crew-start`) instead of in the
  `crew/start` action document.
- **The audience in `describe()`.** HEAD's `describe()` reports each operation's
  `audience` (`packages/contract/src/compile.js`, the policy's `audience`); 0.91.4's
  does not. Both editions therefore read `policy.audience` from the raw contract
  document to know which operations are the human's alone
  (`src/os/kernel/system.js`, `PUBLIC_OPERATIONS`; the same in the tangleai
  repository's `apps/pages/src/os/kernel/system.ts`).

**Why.** The veto, the review of the crew's work and the start of a project are
the human's alone. A seat that learns this from the compiled contract instead of
the raw document cannot drift from it.

**Request.** A release (0.92 or a 0.91 patch) that carries the four.

**Acceptance.** The Tangle edition moves its pin, reads the audience from
`describe()`, splits the names in the `crew/start` document again, and its
database worker answers an invalid call with `invalid-input`, which a test in the
tangleai repository proves inside a worker.

## WJ-2 — Subscription and effect handlers that can read the state at their first start

**Today.** A subscription handler is called as `handler(props, send)` and an
effect handler as `handler(props, send, { signal })` (`packages/app/src/app.js`,
`refreshSubs` and `beginAwait`). Neither receives the state. A host reaches it
through the app, but the first start of every subscription happens inside
`createApp`, before `createApp` has returned the app: `app.getState()` does not
exist yet. Radiant OS defers two subscriptions by a timer turn for that reason:

- the theme renderer (`src/os/app/createOs.js`, `theme`: "Deferred a turn: the
  first start happens while the app is still booting");
- the coach, which reads the quest and the profile (`src/os/app/studio-host.js`,
  `coach`).

**Why.** A deferral is a turn in which the page shows a stale theme and the
coach's first step is late. A host also has to know about the boot order to get
this right; the first version of the coach crashed at boot.

**Request.** A third argument to subscription handlers, `{ getState }`, and
`getState` in the effect handler's context, valid from the first call.

**Acceptance.** A subscription that reads the state in its first start works
without a timer, and a test pins that its first start sees the initial state.

## WJ-3 — Name `$seq` when `$min` or `$max` is handed an argument list

**Today.** `{ "$min": ["$.a", 3] }` fails with `JQ2001: '$min'/'$max' items must
be all numbers or all strings, got an array`. The arguments array is read as one
array-valued item. The working form, `{ "$min": { "$seq": ["$.a", 3] } }`, is
not mentioned.

**Why.** Every other operator that takes several values takes an argument list
(`$add`, `$concat`), so the list is what a writer — or a language model — tries
first, and the message points at the item's type instead of at the form.

**Request.** When `$min`/`$max` gets an array literal, say so and name the
`$seq` form; or accept the argument list as the sequence it spells.

**Acceptance.** The message for `{ "$min": [1, 2] }` names `$seq`, or the
document evaluates to `1`.

## WJ-4 — `$round` over a bare expression

**Today.** `$floor`, `$ceiling` and `$abs` take a bare expression
(`{ "$floor": 2.5 }` → `2`). `$round` takes only an array (`{ "$round": 2.5 }` →
`JQ0003: '$round' takes an array of expressions`), because it also accepts a
precision (`packages/json/src/query/operators.js`, `roundingEntry`).

**Request.** Accept a bare expression as `[expression]`.

**Acceptance.** `{ "$round": 2.5 }` evaluates to `3`.

## WJ-5 — Suggestions that keep an operator's meaning

**Today.** The unknown-operator message suggests the nearest name by spelling
(`packages/json/src/query/normalize.js`): `$gte` → "did you mean `$gt`?",
`$lte` → `$lt`, `$neq` → `$seq`. Followed, the first two silently change `≥` into
`>`, and the third is a different operator altogether.

**Why.** `$gte`, `$lte` and `$neq` are the names most query languages use, so
they are what writers and models reach for; the OS's first actions used `$gte`.

**Request.** A small alias table checked before the spelling distance:
`$gte` → `$ge`, `$lte` → `$le`, `$neq` → `$ne`.

**Acceptance.** The message for `$gte` suggests `$ge`.

## WJ-6 — A "has a value" test beside `$exists`

**Today.** `$exists` is true for a member that holds `null`
(`{ "$exists": "$.a" }` over `{ "a": null }` → `true`), which is right for JSON
but rarely what an action document means by an optional payload member. The OS
writes `{ "$not": { "$is-null": "$payload.x" } }` wherever a member may be absent
or null (`src/os/app/studio-actions.js`: `mail/send`, `board/text`,
`board/link-to`).

**Request.** A sentence in the operator reference on the difference, and an
operator for "present and not null" (for example `$present`).

**Acceptance.** The reference states the null case for `$exists`; the new
operator is false for a missing member and for `null`.

## WJ-7 — A synchronous run for DAGs made only of query nodes

**Today.** A compiled `jaren-dag` runs asynchronously: its run settles over
microtasks, whatever its nodes are. Bench Arena times each engine for a few
milliseconds of every frame, synchronously, so its merit lane can race only
`compileDag`; the run itself cannot be measured inside a frame
(`src/os/games/arena/bench.js`). The council's merit and tally DAGs are made only
of query documents, which are synchronous.

**Request.** A `runSync` (or a compile option) for a DAG whose nodes are all
synchronous engines, refusing at compile time any graph with an asynchronous
node.

**Acceptance.** The Arena races the merit DAG's compile and run together, and a
test pins that `runSync` refuses a graph with a task node.

## WJ-8 — An operation without input that takes `{}`, or says why not

**Today.** A local client refuses an empty object for an operation that declares
no input: `client.invoke('crew.read', {})` answers `JC2050: the input of
operation crew.read is invalid; nothing was sent`, with the details
`[{ path: '', keyword: 'input' }]`. `invoke('crew.read')` works. The tool
projection (`contractTools`) already accepts `{}` for such an operation, so a
host that writes `{}` out of habit, as a tool call does, is refused without
being told why. The Tangle edition's crew seat hit it (tangleai repository,
`apps/pages/src/os/kernel/crew-seat.ts`, `built`).

**Request.** Treat `{}` as no input for an operation that declares none; or keep
refusing it, with a message that says the operation takes no input.

**Acceptance.** `invoke('crew.read', {})` succeeds, or its message names the
operation as taking no input.
