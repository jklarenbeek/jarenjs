# The Jaren app pen (normative)

Version 0.1. The key words MUST, MUST NOT, SHOULD and MAY are to be
interpreted as described in RFC 2119. The rules every pen keeps, the
shared refusal table and the index of the other pens are the binder,
[LINQ-FORMAT.md](LINQ-FORMAT.md).

## 1. What it writes

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
`options.validateState` (§6), which is a `createApp` option.

An action is ONE query document over APP-FORMAT §3.1's three names —
`$` the whole state, `$event` the serializable event slice, `$payload`
the dispatch payload — so everything inside it is captured in one pass:
`transition()`, `effect()` and the patch helpers assemble plain objects
and leave the spelling to the capture already running. That is what
makes the format's own guarantee expressible — the increment in a patch
and the one in an effect's props are the SAME expression, because both
evaluate against the pre-transition state — and it is why an effect's
props are a VALUE here where the flow pen's are a callback
([FLOW-PEN.md](FLOW-PEN.md)): there, each guard is its own document;
here, the action is.

The initial state is DERIVED from the state builder's `default()`s
unless `initial` names one. A member contributes its `default` (or its
`const`); an object recurses; an object resolves when it is required or
when at least one of its own members did, so an optional block of
defaults appears and an optional empty one does not; and a REQUIRED
member that resolves to nothing is `JL0102` naming its pointer —
because a state whose required member is absent fails its own
`validateState` on the boot transaction, which is a fatal `JA0007` and
a bad way to learn about a missing default.

The pen imports nothing of `@jarenjs/app`, `@jarenjs/view` or
`@jarenjs/json`: the loop's compiler stays the only judge of what an app
means (a tree-shaking probe holds it).

## 2. The mapping table

| Method | Emits | Type reading | Status |
|---|---|---|---|
| `defineApp({ state, initial?, schema?, view, actions?, subs? })` | `{ document: { $app: '0.1', state?, view, actions?, subs? }, stateSchema }` — only the members the author declared | `AppResult<State, Actions>`; `StateOf<>` and `ActionsOf<>` read it | native; a member the pen does not know, a missing `view`, a `schema` beside a builder state `JL0101`; an underivable initial state, or a view binding an undeclared action, `JL0102` |
| `state` | the initial value, from the builder's `default()`s; the builder itself is `stateSchema` | `Infer<B>` | native |
| `view` | the JSLT stylesheet verbatim — the pen's `stylesheet([rule(…)])` envelope ([JSLT-PEN.md](JSLT-PEN.md)) or §2's bare rule array | `unknown`: a view is a document the grammar judges | native |
| `action(fn, { payload?, event? })` | one action document, captured over `$`, `$event`, `$payload` | `ActionDeclaration<Payload>`; `payload`/`event` are TYPES — the format carries no schema for either | native; a non-builder `payload` `JL0101`; an excluded `event` field `JL0102`; a name §3.1 does not bind `JL0104` |
| `transition({ state?, patch?, effects? })` | the transition object of §3.2, in the order the runtime applies it | `Transition` | native; another member `JL0101` |
| `effect(run, with?)` | `{ run, with? }` (§5.1); `with` is a value in the ACTION's scope | `EffectDeclaration<Run>` — `Run` is a literal | native; an empty `run` `JL0101` |
| `add/replace/remove/move/copy/test(path, …)` | one RFC 6902 operation, `op, from?, path, value?` | `PatchOp` | native; a path the pen cannot lower `JL0102` |
| `append(path, value)` | `{ op: 'add', path: '<path>/-', value }` — the array APPEND | `PatchOp` | native |
| a path lambda `(st, x) => …` | the JSON Pointer the state shape describes (`st.todos` → `/todos`, `st.todos.at(2).done` → `/todos/2/done`) | `PatchPath<State, Payload>` — annotate to type it | native |
| a path lambda with a COMPUTED index | the pointer as a string EXPRESSION, `{ "$concat": ["/todos/", <index>, "/done"] }` — §3.2's "op members like `value` and `path` are themselves query expressions" | the same | native; anything that is not a chain of member reads and subscripts `JL0102` |
| `bind(name, { payload?, event?, preventDefault?, stopPropagation? })` | §4's object binding, in the format's member order | `Binding<Names>` — annotate the call (`bind<Action>('todo/add')`) and an undeclared name stops compiling | native; a field §3.1 excludes `JL0102` |
| `sub(run, { with?, when?, withQuery?, key?, for? })` | one §5.3 entry, in the format's member order | `SubDeclaration<Run>` | native; a callback under `with` `JL0101`; a combination §5.3 calls `JA0008` `JL0102`; `$item` outside a `for` `JL0104` |

**The one pointer this pen computes.** Every other path is written as
pointer TEXT at build time. A non-literal index cannot be — so
`st.todos.at(x.payload.i).done` emits
`{ "$concat": ["/todos/", "$payload.i", "/done"] }`, adjacent literal
segments merged into one operand. (`$string-join` joins a SEQUENCE
with a separator and casts an array constructor's array to a string —
`JQ2001`; `$concat` is the operator that concatenates operands, and it
is what a pointer needs.)

**The `$event` allow-list.** A binding may request any field name: the
built-in allow-list of §3.1, or a host extractor's own, since an
extractor registered under a name WINS over the built-in list and the
pen cannot see the host's registry. What the pen refuses is the set
§3.1 excludes by construction — `target`, `currentTarget`,
`relatedTarget`, `srcElement`, `view`, `files`, `dataTransfer`,
`touches`, `targetTouches`, `changedTouches`, `path`, `composedPath`,
`clipboardData`, `submitter` — because `$event` MUST survive
`JSON.stringify`, the same invariant as state. The message names §5.4's
own worked example: register an extractor under a name of its own
(`fileTokens`) and request that.

**The undeclared action.** §4 leaves an unknown action name to run time
(`JA2001` per dispatch, the user's click silently dropped);
`defineApp()` sees the whole document at once and refuses it. It reads
both of §4's binding forms — a string under an `on` map, and an
`action` member anywhere, which is where a widget's `emit` will find one
— and skips a value starting with `$`, which is a query expression
naming the action at render time and which no pen can resolve.

What the pen does **not** judge, by design, is the loop's: an
unregistered effect or subscription name (`JA2006`, `JA2008`), a
`when`/action document's own operators (`JA2002`), a patch that fails to
apply (`JA2004`), the state invariant (`JA2005`) and everything else
§10 lists. The pen EMITS those documents and `createApp` refuses them; a
test builds each through the pen and asserts the loop's code.

## 3. Worked examples

Every `js` fence exports exactly one document, and the `json` fence that
follows is what the pen emits — executed by
`test/linq/pen-docs.test.js`. APP-FORMAT §2's document and the
`contract/catalog.load/start` action CONTRACT-FORMAT §11.1 generates are
rebuilt the same way and held BYTE-equal to those docs' own fences by
`test/linq/app-pen.test.js`.

A todo list: a state whose defaults are the initial value, a view whose
bindings carry render-time payloads, a controlled input reading
`$event.value`, and an append that is `add` at the array's `-`
position:

```js
import { action, append, bind, defineApp, replace, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const todo = defineApp({
  state: s.object({
    todos: s.array(s.object({ text: s.string(), done: s.boolean().default(false) })).default([]),
    draft: s.string().default(''),
  }),
  view: [rule('$', (v) => ['main', {},
    ['input', { value: v.draft, on: { input: bind('todo/draft') } }],
    ['button', { on: { click: bind('todo/add', { payload: { text: v.draft } }) } }, 'add'],
  ])],
  actions: {
    'todo/draft': action((st, x) => transition({
      patch: [replace((c) => c.draft, x.event.value)],
    }), { event: ['value'] }),
    'todo/add': action((st, x) => transition({
      patch: [
        append((c) => c.todos, { text: x.payload.text, done: false }),
        replace((c) => c.draft, ''),
      ],
    }), { payload: s.object({ text: s.string() }) }),
  },
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "todos": [], "draft": "" },
  "view": [
    { "match": "$", "body": ["main", {},
      ["input", { "value": "$.draft", "on": { "input": { "action": "todo/draft" } } }],
      ["button", { "on": { "click": { "action": "todo/add", "with": { "text": "$.draft" } } } }, "add"]] }
  ],
  "actions": {
    "todo/draft": { "patch": [{ "op": "replace", "path": "/draft", "value": "$event.value" }] },
    "todo/add": { "patch": [
      { "op": "add", "path": "/todos/-", "value": { "text": "$payload.text", "done": false } },
      { "op": "replace", "path": "/draft", "value": "" }] }
  }
}
```

`append` is `add` at `/todos/-`, and the distinction is RFC 6902's:
`add((st) => st.todos, item)` sets `/todos` TO the item and drops the
list, because a pointer that names a member replaces that member.

A computed pointer, an effect and a dynamic subscription. Note that the
same subscript lowers two ways in one line — as pointer TEXT under
`path`, because a patch path is a pointer, and as the engine's `$get`
under `value`, because a value is an expression:

```js
import { action, effect, defineApp, replace, sub, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';

export const board = defineApp({
  state: s.object({
    rows: s.array(s.object({ open: s.boolean() })).default([]),
    live: s.boolean().default(false),
  }),
  view: [rule('$', (v) => ['ul', {}, v.rows.all().open])],
  actions: {
    'row/toggle': action((st, x) => transition({
      patch: [replace((c, y) => c.rows.at(y.payload.i).open, st.rows.at(x.payload.i).open.not())],
      effects: [effect('persist', { at: x.payload.i })],
    })),
  },
  subs: [sub('feed', {
    when: (st) => st.live,
    withQuery: (st) => ({ rows: st.rows.all().count() }),
  })],
}).document;
```
```json
{
  "$app": "0.1",
  "state": { "rows": [], "live": false },
  "view": [{ "match": "$", "body": ["ul", {}, "$.rows[*].open"] }],
  "actions": {
    "row/toggle": {
      "patch": [{ "op": "replace",
                  "path": { "$concat": ["/rows/", "$payload.i", "/open"] },
                  "value": { "$not": { "$get": [{ "$get": ["$.rows", "$payload.i"] }, "open"] } } }],
      "effects": [{ "run": "persist", "with": { "at": "$payload.i" } }]
    }
  },
  "subs": [{ "run": "feed", "when": "$.live",
             "withQuery": { "rows": { "$count": "$.rows[*]" } } }]
}
```

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

The message names the fix, and `docPath` is the JSON pointer of the node
being assembled where the refusal has one.

## 5. The types

```ts
import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { action, bind, defineApp, transition } from '@jarenjs/linq/app';
import type { ActionScope, ActionsOf, StateOf } from '@jarenjs/linq/app';
import type { Expr } from '@jarenjs/linq';

type State = StateOf<typeof todo>;        // { todos: { text: string; done: boolean }[]; draft: string }
type Action = ActionsOf<typeof todo>;     // 'todo/draft' | 'todo/add'

const { document, stateSchema } = todo;
createApp(document, { node, validateState: new JarenValidator().compile(stateSchema) });

bind<Action>('todo/add');                 // fine
bind<Action>('nope');                     // does not compile — and JL0102 at defineApp()
```

The honest limits, both of them TypeScript's own (a function's type
arguments are all-or-none, and a sibling member's inferred type cannot
contextually type a callback beside it):

- an action's state is typed by ANNOTATION — `action((s: Expr<State>, x)
  => …)`, and a patch path the same — because `action()` is evaluated
  before `defineApp()` sees the `state` builder. What `defineApp({ state
  })` types is the DOCUMENT (`StateOf<>`), which is what a host reading
  `app.getState()` needs. `x.payload` needs no annotation:
  `action(fn, { payload })` declares it on the same call, and
  `{ event: [...] as const }` adds the requested members to `x.event`
  beside §3.1's default slice.
- `bind()`'s action name is checked by annotating the call —
  `bind<Action>('todo/add')`, with `Action` declared or read back
  through `ActionsOf<>`. `defineApp()` checks the other direction at run
  time over the whole view, which is the half a type cannot reach: by
  then a view is a compiled stylesheet.

A view body's value is the honest top until it is annotated
(`rule('$', (v: Expr<State>) => …)`), exactly as the JSLT pen's body is.

## 6. What it cannot spell

Every construct the app pen refuses as unspellable is `JL0102`. §2's
Status column names the ones that belong to a method of this pen, each
beside the spelling that works; the binder's shared table
([LINQ-FORMAT.md](LINQ-FORMAT.md) §1.3) carries the condition in full.

## 7. Cost

`@jarenjs/linq/app` builds to **46,706 bytes** as a minified,
tree-shaken ESM bundle — the figure `scripts/check-tree-shaking.js`
measures and `npm run test:tree-shaking` reports, published rounded
beside the other nine subpath prices in
[docs/CONSUMING.md](../../../docs/CONSUMING.md). It carries the schema pen and the JSLT pen (state, and views), and no chain module, no `@jarenjs/app` or `@jarenjs/view` byte and no other pen.
