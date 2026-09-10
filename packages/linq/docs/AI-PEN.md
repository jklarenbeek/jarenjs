# The AI program pen

> `./ai` — the public action program over environment slots. **Read it when**
> you want typed fixtures or host-authored programs without a model client.

## 1. What it writes

The pen emits exactly `{ steps: [...] }`, the document consumed by the AI
program schema, compiler and runner. It imports no AI engine or environment.
`.schema` is an independent, deeply frozen JSON snapshot; `JSON.stringify()`
writes that document. Updates return a new builder.

`program(['corpus'])` declares input names for TypeScript; those names never
become extra document members or an embedded registry. The compiler checks the
real environment. Queries can be raw JSON or callbacks recorded over the input
document, using the same capture as other pens and no runtime query engine.

## 2. The mapping table

Factories return frozen public steps. The same method on a program appends that
step. Every non-answer step writes `op`, `from` and `as` before its options.

| Factory / method | Emits | Type | Status |
|---|---|---|---|
| `program(slots?)` | empty `steps` | declared input names | native |
| `chunk(from, as, options?)`, `.chunk(...)` | chunk; strategy and size | result family | native |
| `grep(from, as, options)`, `.grep(...)` | grep; pattern, flags, limit | match-list slot | native |
| `select(from, as, query)`, `.select(...)` | select; query JSON | result slot | native |
| `stat(from, as)`, `.stat(...)` | stat | result slot | native |
| `peek(from, as)`, `.peek(...)` | peek | result slot | native |
| `map(from, as, prompt)`, `.map(...)` | map; bounded instruction | result family | native |
| `reduce(from, as, query, options?)`, `.reduce(...)` | reduce; query JSON and optional `outputSchema` | result slot | native |
| `answer(from, options?)`, `.answer(...)` | answer; optional chars, no as | terminal program | native |
| `.step(step)` | appends a public step | tracks its input/result names | native |
| `from(document)` | raw program | no binding-order inference | native |
| `.schema`, `.toJSON()` | frozen public JSON | program document | native |

`chunk` options are `strategy: 'size' | 'line' | 'separator'` and `size`.
`grep` requires `pattern`, with optional `flags: 'i' | 'm' | 'im' | ''` and
`limit`. `answer` takes `chars`. The schema owns numeric and string bounds.

## 3. Worked examples

```js
import { program } from '@jarenjs/linq/ai';
export const plan = program(['corpus'])
  .chunk('corpus', 'pieces', { strategy: 'line', size: 200 })
  .map('pieces', 'found', 'Return the number in this piece as JSON')
  .reduce('found', 'count', { $count: '$[*]' })
  .answer('count', { chars: 50 });
```
```json
{"steps":[{"op":"chunk","from":"corpus","as":"pieces","strategy":"line","size":200},{"op":"map","from":"pieces","as":"found","prompt":"Return the number in this piece as JSON"},{"op":"reduce","from":"found","as":"count","query":{"$count":"$[*]"}},{"op":"answer","from":"count","chars":50}]}
```

Validate with `PROGRAM_SCHEMA` (or `programSchema({ queryRef })`), then
`compileProgram`/`programGate` with the query compiler and known environment
names. `createProgramRunner` does both shape and compile checks before execution.
The standalone compile gate checks semantics; it does not replace the shape
schema's numeric ranges, member closure or step-count cap.

## 4. Refusals

| Code | Condition |
|---|---|
| `JL0101` | invalid slot/result name shape, unknown option/operation, non-JSON input, or a malformed input-name list |
| `JL0102` | appending a step after answer |
| `JL0104` | a query callback reads an external; program queries bind only their input document |

The schema/compiler own unknown environment names, duplicate result bindings,
missing answers, limits, query validity and family/slot semantics. `from()`
preserves raw programs for those checks rather than carrying a second compiler.

## 5. The types

`ProgramBuilder<Bindings, Done>` tracks names and whether answer has closed the
program. `ProgramDocument`, `Step`, `StepDocument`, `StepOptions`, `Operation`,
`Query`, `ChunkOptions`, `GrepOptions` and `AnswerOptions` are types only.

A later step may read only a declared input or previous result. `select` and
`answer` read individual slots, not chunk/map families; `reduce` reads map
results. A result cannot be rebound, although an input slot can be shadowed as
in the compiler. Standalone step factories retain literal names and `.step()`
checks them on insertion. Raw documents claim neither binding order nor a
terminal state. No inferred data schema, budget or successful-run guarantee is
attached to a program.

## 6. What it cannot spell

This is the action document, not a prompt/client wrapper. It neither pastes
corpus contents into a private envelope nor runs model calls in query expressions.
Only the existing runner's map step calls a model. Cancellation, concurrency,
sub-call budgets, storage and result interpretation remain runner concerns.

## 7. Cost

The isolated AI program pen costs **<!--fact:bundle.ai-->15,472<!--/fact--> bytes**.
Its tree probe excludes AI, other target engines and the query chain.
