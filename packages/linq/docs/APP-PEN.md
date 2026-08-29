# The Jaren app pen

> `./app` — the `jaren-app` 0.1 document `createApp` runs, and the JSON
> Schema of its state beside it. **Read it when** you are declaring a
> whole application: state, view, actions, effects

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. This document is a **guide** — read
it in order and you can write the format — whose one normative section is
[§2 The mapping table](#2-the-mapping-table); the rules every pen keeps, the shared refusal table, the
index of the other pens and every pen's mapping table collected in one
place are the normative reference,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

An app document is a whole interactive application as one JSON value —
its state, the view that renders it, the actions that change it, the
subscriptions that feed it. Written by hand it is JSON Pointers in
strings, action names in strings, and query expressions in object
literals, none of which anything checks until the app runs. This pen
makes each of them a function call over the state you declared, so a
pointer is derived from the shape, an action name a view binds is checked
against the actions map, and a patch you can spell wrong does not
compile.

```js
import { defineApp, action, transition, effect, bind, sub } from '@jarenjs/linq/app';
import { add, append, replace, remove, move, copy, test } from '@jarenjs/linq/app';
```

writes the `jaren-app` 0.1 document
([APP-FORMAT](../../app/docs/APP-FORMAT.md)) `createApp` runs — a whole
interactive application as one JSON value — and, beside it, the JSON
Schema of its state. The two are two members of ONE result,
`{ document, stateSchema }`, and are never merged: the format has no
slot for a state schema, and the hook that wants one is
`options.validateState` (APP-FORMAT §6), which is a `createApp` option.

Thirteen names, and they fall into four groups a reader can hold at
once: `defineApp()` writes the document; `action()`, `transition()`,
`effect()` write a transition; the seven patch operations write the
`patch` inside it; and `bind()` and `sub()` write the two places the
outside world reaches in — an event, and a subscription.

**The running example.** §3 is one project board, taken a feature at a
time: the tag list whose patch semantics catch everybody out first, the
estimate counter that is the smallest complete app, the card promotion
that exercises all seven patch operations, the filter box that reads the
event, the card list with an effect beside its patch, the live columns
that fan a subscription out per column, and the grid whose view binds
actions. Each fence is a whole document — that is what the gate runs —
and read in order they are the same application growing. §5 reads the
types back off it.

### 1.1 One document, one capture

An action is ONE query document over APP-FORMAT §3.1's three names —
`$` the whole state, `$event` the serializable event slice, `$payload`
the dispatch payload — so everything inside it is captured in one pass.
`transition()`, `effect()` and the patch helpers assemble plain objects
and leave the spelling to the capture already running; none of them
starts a capture of its own.

That is what makes the format's own guarantee expressible — the
increment in a patch and the one in an effect's props are the SAME
expression, because both evaluate against the pre-transition state
(§3.5 shows the two `{ "$add": ["$.pending", 1] }` nodes) — and it is
why an effect's props are a VALUE here where the flow pen's are a
callback ([FLOW-PEN.md](FLOW-PEN.md)): there, each guard is its own
document; here, the action is.

A view is not part of that capture. The `view` member is a JSLT
stylesheet ([JSLT-PEN.md](JSLT-PEN.md)), captured per rule body against
its own scope, and a `bind()` inside one is ordinary data the body
spells — which is what replaces a payload-creator function, because a
payload built at render time may embed the matched node's own members.

### 1.2 The initial state is derived

The initial state comes from the state builder's `default()`s unless
`initial` names one. A member contributes its `default` (or its
`const`); an object recurses; an object resolves when it is required or
when at least one of its own members did, so an optional block of
defaults appears and an optional empty one does not; and a REQUIRED
member that resolves to nothing is `JL0102` naming its pointer
([§4.3](#43-jl0102--the-state-the-pointer-and-the-binding)) — because a
state whose required member is absent fails its own `validateState` on
the boot transaction, which is a fatal `JA0007` and a bad way to learn
about a missing default.

The rule that follows is worth stating on its own, because it is what
the derivation MEANS: **the state a default describes is the state the
document carries.** There is no second source. If the document's initial
state is wrong, a `default()` is wrong or `initial` is wrong, and both
are visible in the source that wrote it.

### 1.3 The pen carries no engine

The pen imports nothing of `@jarenjs/app`, `@jarenjs/view`,
`@jarenjs/json` or `@jarenjs/validate`: the loop's compiler stays the
only judge of what an app means. `test/linq/app-pen.test.js` reads every
file of `packages/linq/src/app/` and asserts the import is absent, and
the tree-shaking probe (§7) measures the bundle that follows from it.

## 2. The mapping table

Every name `@jarenjs/linq/app` exports — all thirteen — and the members
each writes. The subpath exports no builder class, no constant and no
guard, so §5 documents the exported TYPES rather than a set of values a
caller meets.

Status: **native** (emits the named member), **emulated** (a composition
with identical semantics), **refused** (a coded error naming the
reason).

### 2.1 The document

The one call that assembles an application, and the two members it
answers.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineApp({ state, initial?, schema?, view, actions?, subs? })` | `{ document: { $app: '0.1', state?, view, actions?, subs? }, stateSchema }` — only the members the author declared, deep-frozen | `AppResult<State, Actions>`; `StateOf<>` and `ActionsOf<>` read it back | native; a member the pen does not know, a missing `view`, a `schema` beside a builder state `JL0101`; an underivable initial state, or a view binding an undeclared action, `JL0102` |
| `state` | the initial value, from the builder's `default()`s (§1.2); the builder itself becomes `stateSchema` | `Infer<B>` | native |
| `initial` | the initial value verbatim, in place of the derivation | `Infer<B>` | native; a non-JSON value `JL0101` |
| `schema` | nothing — it TYPES a `state` given as a plain JSON value, and becomes `stateSchema` | `Infer<B>` | native; beside a builder state, `JL0101` (a builder state IS its schema) |
| `view` | the JSLT stylesheet verbatim — the pen's `stylesheet([rule(…)])` envelope ([JSLT-PEN.md](JSLT-PEN.md)) or APP-FORMAT §2's bare rule array | `unknown`: a view is a document the grammar judges | native |
| `actions` | the `actions` map, one captured action document per name | `keyof A & string` — the literal names, which is what `bind<>()` is checked against | native; a value that is not an `action()` `JL0101` |
| `subs` | the `subs` array, one `sub()` entry per element | `readonly SubDeclaration[]` | native; a value that is not a `sub()` `JL0101` |

### 2.2 The transition

What an action returns: the patch to apply, the effects to hand the host,
and nothing else — a transition is data, so a test can read it.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `action(fn, { payload?, event? })` | one action document, captured over `$`, `$event`, `$payload` | `ActionDeclaration<Payload>`; `payload` and `event` are TYPES — the format carries no schema for either, and nothing is emitted for them | native; a non-builder `payload` `JL0101`; an excluded `event` field `JL0102`; a name §3.1 does not bind `JL0104` |
| `transition({ state?, patch?, effects? })` | the transition object of APP-FORMAT §3.2, in the order the runtime applies it | `Transition` | native; another member `JL0101` |
| `effect(run, with?)` | `{ run, with? }` (§5.1); `with` is a value in the ACTION's scope, not a callback | `EffectDeclaration<Run>` — `Run` is a literal | native; an empty `run` `JL0101` |

Returning nothing from an action is the format's own no-op, and
`transition({})` is that same empty object: it is allowed, and it is
what an action that only fires an effect on a later turn writes.

### 2.3 The seven patch operations

A `path` is a captured lambda over the state — `(st) => st.todos` is
`/todos` — so a pointer is DERIVED from the state shape and a typo is a
capture error rather than a silent `JA2004` at dispatch. A pointer
string is accepted verbatim for the locations a shape cannot spell.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `add(path, value)` | `{ op: 'add', path, value }` — **sets a member, and REPLACES an array when the path names one** | `PatchOp` | native |
| `append(path, value)` | `{ op: 'add', path: '<path>/-', value }` — RFC 6902's array APPEND, the same op at the array's `-` position | `PatchOp` | native |
| `replace(path, value)` | `{ op: 'replace', path, value }` — the op a transition writes most, and the one an array ELEMENT needs | `PatchOp` | native |
| `remove(path)` | `{ op: 'remove', path }` | `PatchOp` | native |
| `move(from, path)` | `{ op: 'move', from, path }` — both lowered as pointers | `PatchOp` | native |
| `copy(from, path)` | `{ op: 'copy', from, path }` | `PatchOp` | native |
| `test(path, value)` | `{ op: 'test', path, value }` — a failing test aborts the WHOLE transition (`JA2004`), which is the format's own way to write a precondition | `PatchOp` | native |
| a path lambda `(st, x) => …` | the JSON Pointer the state shape describes: `st.todos` → `/todos`, `st.todos.at(2).done` → `/todos/2/done`, `st.get('a/b')` → `/a~1b` (RFC 6901 escaping) | `PatchPath<State, Payload>` — annotate to type it | native |
| a path lambda with a COMPUTED index | the pointer as a string EXPRESSION, `{ "$concat": ["/todos/", <index>, "/done"] }` — APP-FORMAT §3.2's "op members like `value` and `path` are themselves query expressions" | the same | native; anything that is not a chain of member reads and subscripts `JL0102` |
| a path as a string | the pointer verbatim, `+ '/-'` under `append()` | `string` | native; a string that does not start with `/` `JL0102` |

**`add()` REPLACES an array; `append()` adds to it.** This is the pen's
single most misread pair and the distinction is RFC 6902's, not the
pen's: a pointer that NAMES a member replaces that member, so
`add((st) => st.todos, item)` sets `/todos` to the item and drops the
list. The append is `add` at the array's `-` position, `/todos/-`, and
it has its own name here because the difference costs a `validateState`
rejection at dispatch time to find out otherwise. [§3.1](#31-addpath-value-replaces-an-array-appendpath-value-adds-to-it)
shows both emitted documents side by side.

**The one pointer this pen computes.** Every other path is written as
pointer TEXT at build time. A non-literal index cannot be — so
`st.todos.at(x.payload.i).done` emits
`{ "$concat": ["/todos/", "$payload.i", "/done"] }`, adjacent literal
segments merged into one operand. (`$string-join` joins a SEQUENCE with
a separator and casts an array constructor's array to a string —
`JQ2001`; `$concat` is the operator that concatenates operands, and it
is what a pointer needs.) The `$concat` node is LIFTED as an operator
rather than written as data, because a `$`-keyed object in a captured
tree is otherwise a constructor (the `$map` escape).

### 2.4 The two doors in

The two places the outside world reaches an app: an event a view binds,
and a subscription the host runs.

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `bind(name, { payload?, event?, preventDefault?, stopPropagation? })` | APP-FORMAT §4's object binding — `{ action, with?, event?, preventDefault?, stopPropagation? }`, in the format's member order | `Binding<Names>` — annotate the call (`bind<Action>('todo/add')`) and an undeclared name stops compiling | native; an empty name, an unknown member or a non-boolean control `JL0101`; a field §3.1 excludes `JL0102` |
| `sub(run, { with?, when?, withQuery?, key?, for? })` | one APP-FORMAT §5.3 entry, in the format's member order | `SubDeclaration<Run>` | native; an empty `run`, an unknown member or a callback under `with` `JL0101`; a combination §5.3 calls `JA0008` `JL0102`; `$item` outside a `for` `JL0104` |

**`with` is data; `withQuery`, `key` and `for` are queries.** That is the
distinction the format builds its whole restart rule out of, and the pen
makes it at the door: `with` is verbatim and never evaluated, so a
static entry never restarts; a callback under it is `JL0101` before the
runtime would hand a function to a handler as props. A member that is
sometimes data and sometimes executable is how a document becomes
accidentally executable.

The three combinations §5.3 calls `JA0008` are refused here, naming the
same reason, because the pen can see all three members at once:
`with` beside `withQuery`, `with` beside `for`, and `key` without either
([§4.3](#43-jl0102--the-state-the-pointer-and-the-binding)).

### 2.5 The `$event` allow-list

A binding may request any field name: the built-in allow-list of
APP-FORMAT §3.1, or a host extractor's own, since an extractor
registered under a name WINS over the built-in list (§3.1's precedence
order) and the pen cannot see the host's registry. Requesting a name
nothing answers is `JA2009` at dispatch — the member is bound `null` and
the dispatch is NOT dropped — which is the runtime's to report.

What the pen refuses is the set §3.1 excludes BY CONSTRUCTION, fourteen
names: `target`, `currentTarget`, `relatedTarget`, `srcElement`, `view`,
`files`, `dataTransfer`, `touches`, `targetTouches`, `changedTouches`,
`path`, `composedPath`, `clipboardData`, `submitter`. The reason is one
sentence and it is the invariant, not a policy: **`$event` MUST survive
`JSON.stringify`, the same invariant as state.** A host object never
enters it. [§4.3](#43-jl0102--the-state-the-pointer-and-the-binding)
carries the message and the way through.

### 2.6 What the pen does not judge

By design, these are the loop's, and the pen emits documents that reach
them: an unregistered effect or subscription name (`JA2006`, `JA2008`),
an action or `when` document that throws while evaluating (`JA2002`), a
patch that fails to apply (`JA2004`), the state invariant (`JA2005`), a
requested event field nothing answers (`JA2009`), a dynamic
subscription query that throws (`JA2016`), a fan-out past
`maxSubInstances` (`JA2017`) and everything else APP-FORMAT §10 lists.
`test/linq/app-pen.test.js` builds an app through the pen whose only
effect name is unregistered, boots it under `createApp` and asserts the
loop reports `JA2006` — the pen's silence there is a tested property,
not an omission.

## 3. Worked examples

Every `js` fence exports exactly one document, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. APP-FORMAT §2's document and the
`contract/catalog.load/start` action CONTRACT-FORMAT §11.1 generates are
rebuilt the same way and held BYTE-equal to those docs' own fences by
`test/linq/app-pen.test.js`, which also boots every example shape under
`createApp` with a headless host and dispatches into it.

### 3.1 `add(path, value)` replaces an array; `append(path, value)` adds to it

**The board's tag list**, and the trap everyone meets first.
Two actions, one array, one document — because the only way to read the
difference is to see both pointers beside each other:

```js
import { action, add, append, defineApp, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const list = defineApp({
  state: s.object({ tags: s.array(s.string()).default([]) }),
  view: [rule('$', (v) => ['ul', {}, v.tags.all()])],
  actions: {
    // RFC 6902 'add' at a path that NAMES the array replaces the array
    'tags/set': action((st, x) => transition({ patch: [add((c) => c.tags, x.payload)] })),
    // 'add' at the array's '-' position appends one element to it
    'tags/append': action((st, x) => transition({ patch: [append((c) => c.tags, x.payload)] })),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "tags": [] },
  "view": [{ "match": "$", "body": ["ul", {}, "$.tags[*]"] }],
  "actions": {
    "tags/set": { "patch": [{ "op": "add", "path": "/tags", "value": "$payload" }] },
    "tags/append": { "patch": [{ "op": "add", "path": "/tags/-", "value": "$payload" }] }
  }
}
```

Both operations are `"op": "add"`. The only difference in the emitted
document is the last two characters of the pointer, `/-`, and that is
the whole of it:

| Dispatched with | `tags/set` leaves | `tags/append` leaves |
|---|---|---|
| `'a'` on `[]` | `"a"` — the array is GONE, replaced by a string | `["a"]` |
| `'c'` on `['a', 'b']` | `"c"` | `["a", "b", "c"]` |

`tags/set` is not a bug; it is the operation a reader wants when the
payload IS the new list (`add((c) => c.tags, x.payload)` where the
payload is an array replaces the list wholesale). It is a bug when the
payload is one element, and the state schema is what catches it — the
next state fails `validateState`, the transition is blocked, and the
loop reports `JA2005`. Reaching for `append()` is how a reader never
sees that.

`replace()` and `add()` differ once more, at an array ELEMENT:
`add((c) => c.tags.at(1), x)` INSERTS at index 1 and shifts the rest,
where `replace((c) => c.tags.at(1), x)` overwrites it. On an object
member the two are the same operation.

### 3.2 An app with state, one action and a view

**The board's estimate counter**, and the smallest app that is a whole
one. The whole shape in one document: a state whose defaults ARE the initial
value, a view that reads it and binds an action, and an action that
patches it.

```js
import { action, bind, defineApp, replace, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const counter = defineApp({
  state: s.object({ total: s.integer().default(0), step: s.integer().default(1) }),
  view: [rule('$', (v) => ['main', {},
    ['output', {}, v.total],
    ['button', { on: { click: bind('inc') } }, 'add'],
  ])],
  actions: {
    inc: action((st) => transition({ patch: [replace((c) => c.total, st.total.add(st.step))] })),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "total": 0, "step": 1 },
  "view": [
    { "match": "$", "body": ["main", {},
      ["output", {}, "$.total"],
      ["button", { "on": { "click": { "action": "inc" } } }, "add"]] }
  ],
  "actions": {
    "inc": { "patch": [{ "op": "replace", "path": "/total", "value": { "$add": ["$.total", "$.step"] } }] }
  }
}
```

Three readings in one document. `state` is `{ total: 0, step: 1 }`
because both members declare a `default()` — nothing else wrote it.
`v.total` in the view body captured as `"$.total"`, an ordinary JSLT
body over the state. And `st.total.add(st.step)` captured as
`{ "$add": ["$.total", "$.step"] }` — the action reads the whole state,
so a patch value may name any member, not just the one it writes.

`bind('inc')` emitted `{ "action": "inc" }` and nothing more:
`defineApp()` checked that name against `actions` before the document
existed ([§4.3](#43-jl0102--the-state-the-pointer-and-the-binding)).

### 3.3 A patch chain over a nested path

**Promoting a card between the board's columns.**
Every one of the seven operations, the pointer each writes, and the two
places a pointer is not plain text:

```js
import { action, copy, move, remove, replace, test, transition } from '@jarenjs/linq/app';

export const promote = action((st, x) => transition({
  patch: [
    test((c) => c.board.columns.at(0).cards.at(2).id, x.payload.id),
    copy((c) => c.board.columns.at(0).cards.at(2), (c) => c.board.columns.at(1).cards.at(0)),
    remove((c) => c.board.columns.at(0).cards.at(2)),
    move((c) => c.board.get('draft/note'), (c) => c.board.get('a~b')),
    replace((c, y) => c.board.columns.at(y.payload.to).title, 'Done'),
  ],
})).document;
```
```json
{
  "patch": [
    { "op": "test", "path": "/board/columns/0/cards/2/id", "value": "$payload.id" },
    { "op": "copy", "from": "/board/columns/0/cards/2", "path": "/board/columns/1/cards/0" },
    { "op": "remove", "path": "/board/columns/0/cards/2" },
    { "op": "move", "from": "/board/draft~1note", "path": "/board/a~0b" },
    { "op": "replace",
      "path": { "$concat": ["/board/columns/", "$payload.to", "/title"] },
      "value": "Done" }
  ]
}
```

What to read off it:

- **A literal subscript is pointer text.** `at(0)`, `at(2)` became `/0`,
  `/2` at build time; no expression survives into the document.
- **`get(name)` is how a member whose name is not an identifier is
  reached**, and RFC 6901 escaping is the pen's: `draft/note` →
  `draft~1note`, `a~b` → `a~0b`. It is also the escape for a member
  named like a chain method ([§5.3](#53-a-member-named-like-a-chain-method-captures-as-the-method)).
- **`move()` and `copy()` lower BOTH pointers.** `from` is written
  before `path`, which is RFC 6902's member order.
- **A computed subscript is the one expression a path carries**, and it
  is a `$concat` over the literal segments and the index — evaluated at
  dispatch, against the pre-transition state, like every other
  expression in the action.
- **`test()` aborts the whole transition**, not its own operation. The
  patch above is a precondition followed by four writes: if card 2 is
  not the card the payload names, nothing at all happens and the loop
  reports `JA2004`.

### 3.4 An action reading `$event`

**The board's filter box**, where the action reads the keystroke.
`$event` is the serializable slice of a DOM event: the default four
members (`type`, `value`, `checked`, `key`) plus one per field the
BINDING requested. The `action()`'s own `event` option requests nothing
at run time — it types `x.event` — so the two lists are declared in both
places when both are wanted.

```js
import { action, bind, defineApp, replace, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const search = defineApp({
  state: s.object({
    term: s.string().default(''),
    exact: s.boolean().default(false),
    lastKey: s.string().default(''),
  }),
  view: [rule('$', (v) => ['input', {
    value: v.term,
    on: {
      input: bind('term/typed', { event: ['shiftKey'] }),
      keydown: bind('term/key', { event: ['code'], preventDefault: true }),
    },
  }])],
  actions: {
    'term/typed': action((st, x) => transition({
      patch: [
        replace((c) => c.term, x.event.value),
        replace((c) => c.exact, x.event.shiftKey),
      ],
    }), { event: ['shiftKey'] }),
    'term/key': action((st, x) => transition({
      patch: [replace((c) => c.lastKey, x.event.code)],
    }), { event: ['code'] }),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "term": "", "exact": false, "lastKey": "" },
  "view": [
    { "match": "$", "body": ["input", {
      "value": "$.term",
      "on": {
        "input": { "action": "term/typed", "event": ["shiftKey"] },
        "keydown": { "action": "term/key", "event": ["code"], "preventDefault": true }
      } }] }
  ],
  "actions": {
    "term/typed": { "patch": [
      { "op": "replace", "path": "/term", "value": "$event.value" },
      { "op": "replace", "path": "/exact", "value": "$event.shiftKey" }] },
    "term/key": { "patch": [
      { "op": "replace", "path": "/lastKey", "value": "$event.code" }] }
  }
}
```

`x.event.value` is the default slice's member and needed no request;
`x.event.shiftKey` and `x.event.code` are the built-in allow-list's, and
each binding asked for the one its action reads. `preventDefault` rides
on the binding, not on the action, because it is the DISPATCH's
behaviour and the binding is where the format puts it.

What this document cannot ask for is `event.target` — see
[§2.5](#25-the-event-allow-list) and
[§4.3](#43-jl0102--the-state-the-pointer-and-the-binding).

### 3.5 An action reading `$payload`, with an effect in the same scope

**Adding a card**, where the patch and the effect read the same payload.

```js
import { action, append, defineApp, effect, replace, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

const Card = s.object({ id: s.string(), text: s.string(), done: s.boolean().default(false) });

export const cards = defineApp({
  state: s.object({ cards: s.array(Card).default([]), pending: s.integer().default(0) }),
  view: [rule('$', (v) => ['ul', {}, v.cards.all().text])],
  actions: {
    'card/add': action((st, x) => transition({
      patch: [
        append((c) => c.cards, { id: x.payload.id, text: x.payload.text, done: false }),
        replace((c) => c.pending, st.pending.add(1)),
      ],
      effects: [effect('persist', { id: x.payload.id, at: st.pending.add(1) })],
    }), { payload: s.object({ id: s.string(), text: s.string() }) }),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "cards": [], "pending": 0 },
  "view": [{ "match": "$", "body": ["ul", {}, "$.cards[*].text"] }],
  "actions": {
    "card/add": {
      "patch": [
        { "op": "add", "path": "/cards/-",
          "value": { "id": "$payload.id", "text": "$payload.text", "done": false } },
        { "op": "replace", "path": "/pending", "value": { "$add": ["$.pending", 1] } }
      ],
      "effects": [
        { "run": "persist",
          "with": { "id": "$payload.id", "at": { "$add": ["$.pending", 1] } } }
      ]
    }
  }
}
```

The two `{ "$add": ["$.pending", 1] }` nodes are the point. They are the
same expression written twice in the source and captured twice into the
document, and at dispatch they evaluate to the same number — because
both evaluate against the PRE-transition state, whatever order the
runtime applies the transition in. An effect that needs the value the
patch just wrote computes it, rather than reading it back.

`{ payload: s.object({ … }) }` emitted nothing. It types `x.payload`
(§5) and the format carries no schema for a payload, so declaring one
costs a document nothing.

### 3.6 A subscription with `for` and `$item`

**The board's live columns.** A static entry and a dynamic fan-out in one document:

```js
import { defineApp, sub } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const chat = defineApp({
  state: s.object({
    online: s.boolean().default(false),
    columns: s.array(s.object({ id: s.string(), unread: s.integer().default(0) })).default([]),
  }),
  view: [rule('$', (v) => ['ul', {}, v.columns.all().id])],
  subs: [
    // static: verbatim props, never restarts
    sub('clock', { with: { ms: 1000, tick: 'clock/tick' } }),
    // dynamic fan-out: one instance per column, keyed by the column's id
    sub('column', {
      when: (st) => st.online,
      for: (st) => st.columns.all(),
      withQuery: (st, x) => ({ id: x.item.id, since: st.columns.all().unread.sum() }),
      key: (st, x) => x.item.id,
    }),
  ],
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "online": false, "columns": [] },
  "view": [{ "match": "$", "body": ["ul", {}, "$.columns[*].id"] }],
  "subs": [
    { "run": "clock", "with": { "ms": 1000, "tick": "clock/tick" } },
    { "run": "column",
      "when": "$.online",
      "withQuery": { "id": "$item.id", "since": { "$sum": "$.columns[*].unread" } },
      "key": "$item.id",
      "for": "$.columns[*]" }
  ]
}
```

The members come out in APP-FORMAT §5.3's order — `run`, `with`, `when`,
`withQuery`, `key`, `for` — whatever order the author wrote them in.

`x.item` is bound in `withQuery` and `key`, and ONLY under a `for`: the
scope the pen captures against is exactly §5.3's closed world, so `when`
and `for` see the state alone and `$item` there is `JL0104` at build
time rather than `JA0008` at `createApp` time
([§4.4](#44-jl0104--the-closed-worlds)). `withQuery` may read both, as
`since` does: `$item.id` beside a query over the whole state.

The two entries also show the restart rule from the document's side. The
`clock` entry has `with` and no query, so it never restarts. The `column`
entry restarts one instance whenever its `key` changes, and
`stableStringify(item)` would have been the key had none been declared —
`key` is the opt-out from recomputing a deep key per transaction.

### 3.7 A view binding an action, and the refusal when it is undeclared

**The board's grid**, and what a view may bind.
APP-FORMAT §4 gives a binding two forms and the pen reads both: a string
under an `on` map, and an object carrying an `action` member ANYWHERE,
because that member is §4's vocabulary and a widget's `emit` will find
one wherever it sits.

```js
import { action, bind, defineApp, remove, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const table = defineApp({
  state: s.object({ rows: s.array(s.object({ id: s.string() })).default([]), mode: s.string().default('view') }),
  view: [rule('$', (v) => ['table', {},
    // a literal name: the pen checks it against `actions`
    ['button', { on: { click: bind('row/clear', { stopPropagation: true }) } }, 'clear'],
    // an object binding anywhere is a binding — a widget's `emit` finds it here
    ['x-grid', { rowAction: bind('row/drop', { payload: { id: v.rows.all().id } }) }],
    // a `$`-prefixed value names the action at RENDER time; no pen can resolve it
    ['button', { on: { click: v.mode } }, 'go'],
  ])],
  actions: {
    'row/clear': action(() => transition({ patch: [remove('/rows')] })),
    'row/drop': action((st, x) => transition({ patch: [remove((c, y) => c.rows.at(y.payload.id))] })),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "rows": [], "mode": "view" },
  "view": [
    { "match": "$", "body": ["table", {},
      ["button", { "on": { "click": { "action": "row/clear", "stopPropagation": true } } }, "clear"],
      ["x-grid", { "rowAction": { "action": "row/drop", "with": { "id": "$.rows[*].id" } } }],
      ["button", { "on": { "click": "$.mode" } }, "go"]] }
  ],
  "actions": {
    "row/clear": { "patch": [{ "op": "remove", "path": "/rows" }] },
    "row/drop": { "patch": [{ "op": "remove",
      "path": { "$concat": ["/rows/", "$payload.id"] } }] }
  }
}
```

Rename `row/drop` to `row/dropped` in `actions`, leave the view alone,
and the pen refuses the document before it exists — naming what IS
declared, so a typo is one glance from fixed:

```text
JL0102: the view binds the action 'row/drop', which "actions" does not
declare — the runtime drops such a dispatch and reports JA2001
(APP-FORMAT §4), so the user's click does nothing; the declared actions
are 'row/clear', 'row/dropped'   at /view
```

The third binding is why the check has a hole in it, honestly: a value
starting with `$` is a query expression naming the action at render
time, and no pen can resolve it — the state decides which action a
render-time binding dispatches. Those the pen skips, and the runtime
checks them per dispatch as it always did.

## 4. Refusals

The app pen raises these `LinqBuildError` codes and no others —
`test/linq/pen-docs.test.js` holds this list equal, in both directions,
to the codes `packages/linq/src/app/` throws. The full condition each
code states across every pen is the binder's,
[LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3.

| Code | What this pen raises it for |
|---|---|
| `JL0101` | a value this pen cannot spell, or a name → value map it cannot read |
| `JL0102` | a construct the format cannot carry |
| `JL0104` | a pen-owned keyword written through `meta()`, or an external a captured rule did not declare |

Every message below is the one the pen raised when the spelling beside
it was run, with the code prefix removed. `docPath`, where the refusal
carries one, is the JSON pointer of the node being assembled and is
appended to the message text as well (`… at /actions/a`).

### 4.1 `JL0101` — the document's own members

Raised at the door, before anything is captured.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineApp('$')` | `defineApp() takes { state, initial?, schema?, view, actions?, subs? }, got a string` | a plain object |
| `defineApp({ state: {}, nope: 1, view: [] })` | `defineApp() does not take 'nope' — it takes state, initial, schema, view, actions, subs` | one of the six |
| `defineApp({ state: {} })` | `defineApp() needs a view — a JSLT stylesheet, from stylesheet([rule(…)]) or as a bare rule array; the format requires the member and the runtime refuses an app without one (JA0002)` | `view: [rule('$', …)]` |
| `defineApp({ state: {}, view: 'x' })` | `defineApp() view is a JSLT stylesheet document or a bare rule array, got a string` | an array, or a `stylesheet()` envelope |
| `defineApp({ state: s.object({}), schema: s.object({}), view: [] })` | `defineApp() takes 'schema' beside a state given as a plain JSON value — a state given as a builder IS its schema` | drop the `schema` |
| `defineApp({ state: {}, schema: {}, view: [] })` | `defineApp() schema is a schema-pen builder, got a Object instance` | `s.object({ … })` |
| `defineApp({ …, actions: [] })` | `defineApp() actions is an object of named action() declarations, got a Array instance` | a plain object |
| `defineApp({ …, actions: { a: { patch: [] } } })` | `defineApp() action 'a' is action((s, x) => transition(…)), got a Object instance` | `action(fn)` |
| `defineApp({ …, subs: 1 })`, `subs: [{ run: 'x' }]` | `defineApp() subs is an array of sub() declarations, got 1`; `defineApp() subs[0] is sub(run, options?), got a Object instance` | `sub('x')` |
| `defineApp({ state: () => 1, view: [] })`, the same under `initial` | `defineApp() state received a function, which is not JSON — a document carries null, booleans, finite numbers (never -0), strings, arrays and plain objects, and nothing else` | a JSON value, or a builder |

### 4.2 `JL0101` — the transition, the binding and the subscription

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `action(7)` | `action() takes a callback (s, x) => transition(…), got 7` | a callback |
| `action(fn, { nope: 1 })` | `action() does not take 'nope' — it takes payload, event` | `payload`, `event` |
| `action(fn, { payload: {} })` | `action() payload is a schema-pen builder — it types the dispatch's $payload, and the app format carries no schema for it, so nothing is emitted for it; got a Object instance` | `payload: s.object({ … })` |
| `action(fn, { event: 'x' })`, `{ event: [1] }` | `action() event is an array of field names (APP-FORMAT §4), got a string`; `action() event[0] is a field name, got 1` | `event: ['shiftKey']` |
| `transition(7)`, `transition({ nope: 1 })` | `transition() takes { state?, patch?, effects? }, got 7`; `transition() does not take 'nope' — it takes state, patch, effects` | one of the three |
| `transition({ patch: 'x' })`, `{ patch: [1] }` | `transition() patch is an array of add/replace/remove/move/copy/test operations, got a string`; `transition() patch[0] is one of add/replace/remove/move/copy/test, got 1` | an array of operations |
| `transition({ effects: [{ run: 'x' }] })` | `transition() effects[0] is effect(run, with?), got a Object instance` | `effect('x')` |
| `effect('')`, `bind('')`, `sub('')` | `effect() takes the handler name as a non-empty string, got a string`; `bind() takes an action name as a non-empty string, …`; `sub() takes the handler name as a non-empty string, …` | a non-empty name |
| `bind('a', { nope: 1 })` | `bind() does not take 'nope' — it takes payload, event, preventDefault, stopPropagation` | one of the four |
| `bind('a', { preventDefault: 'yes' })` | `bind() preventDefault is a boolean — it is allowed only on the object binding form and defaults to false (APP-FORMAT §4), got a string` | `preventDefault: true` |
| `sub('a', { nope: 1 })` | `sub() does not take 'nope' — it takes with, when, withQuery, key, for (APP-FORMAT §5.3)` | one of the five |
| `sub('a', { with: (st) => st.ms })` | `sub() 'with' is VERBATIM data handed to the handler, never evaluated — for props derived from the state write 'withQuery' instead (APP-FORMAT §5.3)` | `withQuery: (st) => …` |
| `replace(7, 1)` | `a patch path is a lambda over the state — (st) => st.todos — or a JSON Pointer string, got 7` | a lambda, or a pointer |

**The `__proto__` case.** `actions` and the state's `properties` are both
name → value maps, so the binder's §1.1 rule 5 applies to them:

```js
defineApp({ state: {}, view: [], actions: { __proto__: action(fn) } })
// JL0101: defineApp() actions received a map whose prototype was
// replaced: a '__proto__:' key in an object literal sets the prototype
// instead of adding a member, so that member is not there to emit —
// spell it { ['__proto__']: … }, which is an own key   at /actions
```

The computed key IS an own property, and then `__proto__` is ORDINARY
DATA all the way through this pen — which the app pen is where the
campaign proves end to end, because it is the one pen whose document
carries a name map on both sides at once:

```js
defineApp({
  state: s.object({ ['__proto__']: s.integer().default(7), n: s.integer().default(0) }),
  view: [rule('$', () => ['p', {}, 'x'])],
  actions: { ['__proto__']: action(() => transition({})), ok: action(() => transition({})) },
}).document
// { "$app": "0.1", "state": { "__proto__": 7, "n": 0 }, "view": [ … ],
//   "actions": { "__proto__": {}, "ok": {} } }
```

An action named `__proto__` is a declared action; a state member named
`__proto__` gets its default into the initial state like any other. Both
survive because the pen writes them with `setObjectMember` — a plain
`out[name] = value` would reassign the emitted object's prototype and
drop the member. `test/linq/pen-docs.test.js` asserts the emitted
`actions` and `state` still carry `Object.prototype`, still hold
`__proto__` as an OWN member, and that `state['__proto__']` is `7`.

### 4.3 `JL0102` — the state, the pointer and the binding

Four conditions, and a reader meets three of them in their first
afternoon.

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `defineApp({ state: s.object({ id: s.string() }), view: [] })` | `the initial state cannot be derived: '/id' is required and declares no default — give the member a default(), or pass the whole initial state as defineApp()'s 'initial'` | `s.string().default('')`, or `initial: { id: '' }` |
| `replace((st) => st.todos.all().count(), 1)` | `a patch path is a JSON Pointer, and this one cannot be written as one: {"$count":"$.todos[*]"} — a path lambda reads members and subscripts off the state (st.todos.at(2).done, st.todos.at(x.payload.i)); anything else, pass the pointer as a string` | `st.todos.at(i)`, or a pointer string |
| `replace('a/b', 1)` | `a patch path given as a string is an RFC 6901 JSON Pointer — 'a/b' does not start with '/'; write a lambda over the state instead, (st) => st.todos` | `'/a/b'` |
| `bind('a', { event: ['target'] })`, `action(fn, { event: ['files'] })` | `an event binding cannot request 'target' — APP-FORMAT §3.1 excludes target, files, touch lists and every other host-object-valued field by construction, because $event MUST survive JSON.stringify, the same invariant as state. Register an extractor under a name of its own (§5.4's worked example maps event.target.files to opaque string tokens under 'fileTokens') and request that.` | register an extractor, request its name |
| a view binding an action `actions` does not declare | `the view binds the action 'nope', which "actions" does not declare — the runtime drops such a dispatch and reports JA2001 (APP-FORMAT §4), so the user's click does nothing; the declared actions are 'real'` | declare it, or fix the spelling |
| `sub('r', { with: 1, withQuery: fn })` | `sub() carries both 'with' and 'withQuery' — one entry, one props source: 'with' is verbatim data and never restarts, 'withQuery' derives the props from the state and makes the entry dynamic (APP-FORMAT §5.3, the runtime's JA0008)` | one of the two |
| `sub('r', { with: 1, for: fn })` | `sub() carries 'with' beside 'for' — a fan-out's props come from 'withQuery', or default to the item itself (APP-FORMAT §5.3, the runtime's JA0008)` | drop `with`, or drop `for` |
| `sub('r', { key: fn })` | `sub() carries 'key' without 'withQuery' or 'for' — a static subscription never restarts, so it has no restart key (APP-FORMAT §5.3, the runtime's JA0008)` | add `withQuery` or `for` |

**A patch path that is not a chain of member reads and subscripts.** No
JSON Pointer can be written for one, and the pen will not guess where an
arbitrary expression lands in the state. The line between the two is
exactly this: a chain of `.member` reads, `get(name)` reads and `at(i)`
subscripts lowers — `at()` with a COMPUTED index included, which is the
`$concat` of [§2.3](#23-the-seven-patch-operations) and works. Anything
that calls an OPERATOR does not: `all()`, `count()`, `filter()`,
arithmetic. The two spellings side by side:

```js
replace((c, y) => c.todos.at(y.payload.i).done, true)   // { "$concat": ["/todos/", "$payload.i", "/done"] }
replace((c) => c.todos.all().count(), 1)                // JL0102 — no pointer names a count
```

Where a location genuinely cannot be reached from the state shape, pass
the pointer as a string; that door is always open, and the only check on
it is that it starts with `/`.

**An `$event` field APP-FORMAT §3.1 excludes by construction.** A reader
will reach for `event.target` on their first afternoon, and the reason
they cannot have it is not a policy: **`$event` MUST survive
`JSON.stringify`.** A DOM node in the event slice would break the
invariant state itself keeps — it could not be serialized, replayed,
sent to a devtool or compared between transactions — so §3.1 excludes
`target` and thirteen siblings BY CONSTRUCTION, not by omission, and the
pen refuses the request rather than emitting a document the loop would
bind `null` for. The way through is §5.4's own worked example: a host
registers an extractor under a name of its own, which maps the host
object to a JSON value at the boundary, and the binding requests THAT
name.

```js
bind('pickFiles', { event: ['files'] })       // JL0102
bind('pickFiles', { event: ['fileTokens'] })  // fine — the host's extractor answers it
```

An extractor registered under one of the fourteen excluded names would
shadow the exclusion the format exists to state, so the pen refuses
those names whatever the registry holds; every OTHER name is allowed,
because an extractor wins over the built-in allow-list (§3.1's
precedence order) and the pen cannot see the host's registry.

**An initial state no `default()` describes.** The rule §1.2 states is
what makes this a refusal rather than a shrug: the state a default
describes IS the state the document carries, so a required member with
no default leaves the document with no value for it, and the app fails
its own `validateState` on the boot transaction — `JA0007`, fatal,
after everything acquired is rolled back. The pen sees it at build time
and names the pointer. An OPTIONAL member with no default is fine and
simply does not appear.

**A view binding an action `actions` does not declare.** APP-FORMAT §4
leaves an unknown name to run time — `JA2001` per dispatch, and the
user's click does nothing at all, silently. `defineApp()` sees the whole
document at once and refuses it, naming the declared alternatives so a
typo is one glance from fixed. [§3.7](#37-a-view-binding-an-action-and-the-refusal-when-it-is-undeclared)
shows both binding forms it reads and the one it cannot.

### 4.4 `JL0104` — the closed worlds

| The spelling that trips it | The message | The spelling that works |
|---|---|---|
| `action((st, x) => transition({ state: x.clock }))` | `an action() rule cannot bind 'clock' — its query evaluates with exactly 2 externals, 'event' and 'payload'; anything else has nothing to bind to — the whole state is the first argument; §3.1 binds $event and $payload and nothing else, and a host value reaches an action through a binding's payload or an event-field extractor` | `x.event`, `x.payload`, or the state |
| `sub('r', { withQuery: (st, x) => x.item })` | `a sub() withQuery rule cannot bind 'item' — its query evaluates with no externals at all; anything else has nothing to bind to — a subscription's withQuery is compiled closed-world against the state alone; $item exists only under a "for" declaration (APP-FORMAT §5.3)` | add `for`, or read the state |
| `sub('r', { when: (st, x) => x.item, for: fn })` | `a sub() when rule cannot bind 'item' — … — a subscription's when is compiled closed-world against the state alone; $item exists only under a "for" declaration (APP-FORMAT §5.3)` | `when` sees the state alone |

Three scopes, and the pen mirrors each exactly:

| Where | `$` | Externals |
|---|---|---|
| an action, and a patch path inside it | the whole state | `$event`, `$payload` |
| a subscription's `when` and `for` | the whole state | none |
| a subscription's `withQuery` and `key` | the whole state | `$item`, and only under a `for` |

The mirror is the point. A document the pen writes cannot be the
`JA0008` a free variable would be at `createApp` time, because the pen
raised `JL0104` at the line that wrote it — where the fix has a name and
a stack — rather than letting an unbound external reach the loop's
compiler.

Two of the three messages are the shared capture's, so they open by
counting the EXTERNALS and then name the whole vocabulary in the advice
the pen appends. "Exactly 2 externals" for an action means `$event` and
`$payload`; the state is the first argument and is never an external.

The app pen writes no keyword of its own onto a schema, so the other
half of `JL0104` — a pen-owned keyword written through `meta()` — is
reachable here only through the schema pen that types the state
([SCHEMA-PEN.md §4.4](SCHEMA-PEN.md#44-jl0104--the-keyword-and-the-external)).

## 5. The types

```ts
import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { action, append, bind, defineApp, effect, replace, sub, transition } from '@jarenjs/linq/app';
import type {
  ActionScope, ActionsOf, AppDocument, AppResult, Binding, EffectDeclaration,
  EventSlice, FanScope, PatchOp, PatchPath, StateOf, SubDeclaration, Transition,
} from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import type { Expr } from '@jarenjs/linq';
import type { Infer } from '@jarenjs/linq/schema';

const State = s.object({
  todos: s.array(s.object({ text: s.string(), done: s.boolean().default(false) })).default([]),
  draft: s.string().default(''),
});
type State = Infer<typeof State>;
type Action = 'todo/add' | 'todo/toggleAt';

const Payload = s.object({ text: s.string() });

const todo = defineApp({
  state: State,
  view: [rule('$', (v: Expr<State>) => ['main', {},
    ['button', { on: { click: bind<Action>('todo/add', { payload: { text: v.draft } }) } }, 'add'],
  ])],
  actions: {
    // the state is typed by ANNOTATION; the payload by its own declaration
    'todo/add': action((st: Expr<State>, x) => transition({
      patch: [append((c: Expr<State>) => c.todos, { text: x.payload.text, done: false })],
    }), { payload: Payload }),
    'todo/toggleAt': action((st: Expr<State>, x) => transition({
      patch: [replace((c: Expr<State>, y: ActionScope<{ i: number }>) =>
        c.todos.at(y.payload.i).done, true)],
    })),
  },
  subs: [sub('interval', { with: { ms: 1000 }, when: (st: Expr<State>) => st.todos.all().count().gt(0) })],
});

type Shape = StateOf<typeof todo>;      // the state the document describes
type Names = ActionsOf<typeof todo>;    // 'todo/add' | 'todo/toggleAt'

const { document, stateSchema } = todo;
// no narrow and no cast: the `state: <builder>` overload can never
// answer null, and AppResult carries that in its third phantom (§5.4)
createApp(document, { node, validateState: new JarenValidator().compile(stateSchema) });

bind<Names>('todo/add');                // fine
bind<Names>('nope');                    // does not compile — and JL0102 at defineApp()
```

### 5.1 The two phantoms, and what reads them

`AppDocument<State, Actions>` carries two phantoms: the state SHAPE, and
the declared action NAMES as a literal union. Both are read off the
declarations themselves — `defineApp`'s `A extends Record<string,
ActionDeclaration<any>>` is `const`, so the keys stay literal — and both
come back out:

| Type | Reads | What it is for |
|---|---|---|
| `StateOf<A>` | the state shape | what a host reading `app.getState()` needs |
| `ActionsOf<A>` | the literal action names | what a `bind<Names>()` is checked against |

`AppResult<State, Actions>` is the pair `defineApp()` answers,
`{ document, stateSchema }`. Both `StateOf<>` and `ActionsOf<>` accept
either the result or the document, so a consumer that stores only the
document loses nothing.

### 5.2 The honest limits, both of them TypeScript's own

A function's type arguments are all-or-none, and a sibling member's
inferred type cannot contextually type a callback beside it. Everything
awkward about this pen's types follows from those two:

- **An action's state is typed by ANNOTATION** — `action((s: Expr<State>,
  x) => …)`, and a patch path the same — because `action()` is evaluated
  before `defineApp()` sees the `state` builder. What `defineApp({ state
  })` types is the DOCUMENT (`StateOf<>`). `x.payload` needs NO
  annotation: `action(fn, { payload })` declares it on the same call, and
  `{ event: [...] as const }` adds the requested members to `x.event`
  beside APP-FORMAT §3.1's default slice — which is what `EventSlice<Fields>`
  spells, four known members plus one `unknown` per requested field.
- **`bind()`'s action name is checked by annotating the call** —
  `bind<Action>('todo/add')`, with `Action` declared or read back through
  `ActionsOf<>`. `defineApp()` checks the other direction at run time
  over the whole view, which is the half a type cannot reach: by then a
  view is a compiled stylesheet.
- **A view body's value is the honest top until it is annotated**
  (`rule('$', (v: Expr<State>) => …)`), exactly as the JSLT pen's body
  is ([JSLT-PEN.md §5](JSLT-PEN.md#5-the-types)).

`PatchPath<State, Payload>` is the union of the lambda and the pointer
string, and its lambda sees the same scope the action does — so a
computed index may read `$payload`, annotated the same way
(`(c: Expr<State>, y: ActionScope<P>) => …`). `FanScope<Item>` is the
one-member scope a subscription's `withQuery`/`key` gets under a `for`.

### 5.3 A member named like a chain method captures as the method

The trap a reader meets in their first hour, and it is not the pen's:
the capture proxy answers a chain METHOD before it answers a member of
the same name, so a state whose member shares a name with one of them
hands the lambda a function instead of an expression. The set is
[QUERY-PEN.md §4](QUERY-PEN.md#4-the-mapping-table)'s "expression
methods" row, and a state schema meets it more often than a reader
expects — `count`, `sum`, `min`, `max`, `avg`, `length`, `at`, `all`,
`get`, `exists`, `contains`, `replace` and `add` are all ordinary member
names and all shadowed. Names that are NOT shadowed include the sequence
terminals: `first`, `map` and `filter` are chain methods on a SEQUENCE,
and an action's state is an expression, so those read as members.

```js
const app = defineApp({
  state: s.object({ count: s.integer().default(0) }),
  view: [rule('$', (v) => ['output', {}, v.count])],
  // …
});
// JL0005: a captured expression cannot embed a function value
```

The same spelling in an action reads the same way —
`action((st) => transition({ state: st.count }))` is the same `JL0005`
— and the message names the symptom rather than the cause, because by
the time the capture sees a function it no longer knows the name that
produced it. The escape is the one `get()` exists for, and it lowers to
exactly what a member read would have:

```js
rule('$', (v) => ['output', {}, v.get('count')])   // "$['count']"
replace((c) => c.get('count'), 1)                  // { "op": "replace", "path": "/count" }
```

Naming the member something else is the other fix and usually the better
one. Nothing in the state's SCHEMA is affected — the member is a member
either way, and only the lambda that reads it has to spell it
differently.

### 5.4 The schema slot is typed by the overload that filled it

`defineApp()` answers `null` for `stateSchema` when the state is a plain
JSON value with no `schema` beside it, and a document for the two
overloads that were handed a builder. `AppResult` carries that as its
THIRD phantom rather than one union across all three, so the presence of
a schema survives into the type:

| The call | `stateSchema` |
|---|---|
| `defineApp({ state: <builder>, … })` | `JsonSchema \| boolean` |
| `defineApp({ state: <json>, schema: <builder>, … })` | `JsonSchema \| boolean` |
| `defineApp({ state: <json>, … })` | `null` |

That is what lets the one line every consumer writes compile with no
narrow and no cast — and it is exactly the line that does not compile
when the slot is one union, because `JarenValidator.compile()` takes
`boolean | JSONSchemaLike` and not `null`:

```ts
const { stateSchema } = defineApp({ state: s.object({ n: s.integer().default(0) }), view: [] });
new JarenValidator().compile(stateSchema);              // fine

const plain = defineApp({ state: { n: 1 }, view: [] });
new JarenValidator().compile(plain.stateSchema);        // does not compile: there is no schema
```

The third parameter defaults to the whole union, so `AppResult<State,
Actions>` still names any result and no consumer annotation has to spell
it. `test/consumer/linq-app.ts` pins all four lines, the negative
included.

### 5.5 What the pins hold

`test/consumer/linq-app.ts` carries this pen's compile-level half beside
the forms pen's — one file, because they are the two pens a form-shaped
application uses together. Compiled by `npm run test:types`, it holds:

- `StateOf<typeof todo>` EQUAL (not merely assignable) to `Infer<typeof
  State>`, and `ActionsOf<typeof todo>` equal to the declared name union
  — both by the strict `Equals<>` test, in both directions;
- `todo.document` assignable to `AppDocument<State, Action>`, and a
  `@ts-expect-error` on `todo.document.stateSchema`: the two are two
  members and the document is not one of them;
- a payload member the declaration does not carry, a state member the
  schema does not carry, and an `$event` field the binding did not
  request — three `@ts-expect-error`s, each the type half of a refusal
  §4 states at run time;
- `bind<Action>('nope')` and `bind<ActionsOf<typeof todo>>('nope')`,
  both `@ts-expect-error`;
- `transition({ nope: 1 })` and `sub('interval', { with: () => 1 })`,
  the two closed vocabularies;
- `PatchOp`, `EffectDeclaration<'save'>` and `SubDeclaration<'interval'>`
  as the concrete types the three helpers answer, with
  `effect('save').run` pinned to the literal `'save'`.

## 6. What it cannot spell

Every construct the app pen refuses as unspellable is `JL0102`, and §4.3
carries the four conditions with the spelling that works for each: a
patch path that is not a chain of member reads and subscripts, an
`$event` field APP-FORMAT §3.1 excludes by construction, an initial
state no `default()` describes, and a view binding an action `actions`
does not declare. Those are limits of the FORMAT reached through the
pen, and each has a way through.

One limit is the format's own and has no way through today: **an action
document cannot express AWAITING.** A transition is a pure function of
the pre-transition state to a next state plus a list of effects; an
effect runs after the transition settles and reaches back only by
dispatching another action. That is deliberate — it is what makes a
transition replayable and a document serializable — but it means a
sequence like "call this, then patch with the answer, then call that" is
written as a chain of actions and effect callbacks rather than as one
document.

The convention for it exists and is the host's, not the format's:
`createTaskEffect` and the async-task pattern of
[TASKS.md](../../app/docs/TASKS.md) give the sequence a key, a
concurrency mode and a structured failure, and APP-FORMAT §9 is the
normative half. What is open is expressing the awaiting IN the action
document, which is an entry in `docs/ROADMAP.md` under `@jarenjs/app`;
this pen writes whatever that grammar grows, because it has no opinion
of its own about it.

Two smaller things the pen deliberately does not do, so a reader does
not look for them:

- **It writes no state schema into the document.** The format has no
  slot for one, and inventing an `x-` member for it would make the pen's
  documents a dialect. `stateSchema` is answered beside the document and
  goes to `options.validateState`.
- **It judges nothing the loop must judge anyway.**
  [§2.6](#26-what-the-pen-does-not-judge) is the list, and the reason is
  the binder's rule 1: a pen refuses only what it can see, and inventing
  a check the engine does not make would be a second, weaker validator.

### 6.1 When not to reach for this pen

- **The app document is data.** One read from a file, authored in the
  studio, projected from a machine by `fsmToApp`
  ([FLOW-PEN.md](FLOW-PEN.md)), or written by a model is a value;
  `createApp` takes it directly.
- **You are writing a component, not an application.** An app document is
  one state, one view and one action map — the unit `createApp` runs. A
  reusable widget is a view function and a set of props, and it lives in
  `@jarenjs/view` where it can take children and callbacks; an app
  document has no slot for either.
- **The logic is mostly awaiting.** §6 above says it plainly: a
  transition is pure and an effect reaches back only by dispatching. An
  application whose interesting part is a sequence of awaited calls is
  mostly host code with an app document attached, and the reading order
  should follow — write the tasks, then the document that dispatches
  them.
- **The state does not fit in a document.** Every value in the state is
  JSON: no DOM nodes, no class instances, no functions, no handles. A
  canvas, a media element or a socket lives in the host and reaches the
  document only as the data it produces.
- **You would be fighting the patch.** A state shape that needs deep
  rewrites on every event is a shape that wants normalizing before it
  wants a pen. §3.1 is the first place this shows: `add` at a path that
  names an array replaces it, and a reader who wanted `append` had a
  shape question rather than a spelling one.

## 7. Cost

`@jarenjs/linq/app` builds to **<!--fact:bundle.app-->46,862<!--/fact--> bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema
pen and the JSLT pen (state, and views), and no chain module, no
`@jarenjs/app` or `@jarenjs/view` byte and no other pen.

It is the second-largest pen bundle after the client, and the two pens
it carries are most of it. The three figures the same probe measures,
side by side: `@jarenjs/linq/schema` <!--fact:bundle.schema-->32,427<!--/fact--> bytes,
`@jarenjs/linq/jslt` <!--fact:bundle.jslt-->19,124<!--/fact-->, `@jarenjs/linq/app` <!--fact:bundle.app-->46,862<!--/fact-->. The subpath sums do not add — all
three carry the capture, the expression lowering and the JSON boundary,
which each bundle counts once — so what the app pen costs a consumer who
already imports the schema pen is the difference the numbers do state:
**14,435 bytes**, the JSLT pen's non-shared half plus this pen's own
`defineApp`, action capture, seven patch operations, pointer lowering,
`bind()`, `sub()` and their refusal messages.
