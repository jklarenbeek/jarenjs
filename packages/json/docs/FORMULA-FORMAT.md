# Saved formulas and reviewed plans

`@jarenjs/json/formula` compiles versioned JSON profiles through the existing JSON
Query engine. `@jarenjs/linq/formula` authors the same immutable document.

```js
import { defineFormula } from '@jarenjs/linq/formula';
import { compileFormula } from '@jarenjs/json/formula';
const profile = defineFormula('amount', { $mul: ['$.price', '$.quantity'] });
const formula = compileFormula(profile);
formula.evaluate({ price: 2.5, quantity: 4 }); // {kind:'value', value:10}
```

## Profile and capabilities

A profile requires `$formula: "1"`, nonempty `id` and `revision` strings, and
`expression`, an existing JSON Query document. Identity and revision strings have
a maximum length of 256 characters. Optional members are `bindings`, `helpers`,
`inputSchema`, `resultSchema`, and `resultMode` (`value`, the default, or `outcome`).
Bindings are immutable JSON. `context` and `computed` are reserved external names.

Schema references are `{id, version}` and resolve through
`options.schemas[id] = {version, schema}`. Supply `compileTypeTest` from
`@jarenjs/validate/query` (or a structural equivalent); the JSON package never
imports the validator. Missing/mismatched references and invalid schemas fail at
compile time. Input predicates run before evaluation; result predicates validate
the value of value/explanation outcomes. Empty and non-value outcomes have no
result value to validate.

Helper references are `{name, version}` and resolve through
`options.helpers[name] = {version, run, trust:'pure', cost}`. Positive finite cost
is a host declaration, not measured enforcement. Versioned helpers must remain
pure and stable for the lifetime of a compiled formula. `createFormulaCompiler`
retains a bounded compilation cache (default 128 profiles): its collision-free
key includes the complete profile, helper function identity/version/cost, schema
contents, type-test function identity and limits. Recompile after replacing a
capability; a new compiler never shares another host's cache. `clear()` releases
entries and `size()` reports retained profiles.

`evaluate(row, context?, computed?)` snapshots and freezes JSON inputs without
freezing caller objects. Clock values, locale, rates and unit tables belong in
bindings/context or explicitly registered pure helpers. No implicit clock, locale,
network or database access is supplied. Formula errors carry `formulaId`, `code`
and an RFC 6901 `docPath`; wrapped Query errors retain their code and point below
`/expression`. Codes are allocated in the [Query registry](QUERY-FORMAT.md#10-errors).

## Values, outcomes and arithmetic

JSON Query semantics apply unchanged: missing paths yield an empty sequence;
explicit null is a value. Numeric operators do not convert strings to numbers.
Native floating-point overflow/non-finite values and non-JSON host results are
refused at the formula boundary. Rounding is explicit through existing Query/core
operations or a declared helper. There is no implicit currency rounding or
formatting; formatted text is an ordinary string. JavaScript Number precision and
Query rounding rules remain visible; the API does not claim decimal arithmetic.

The default result mode produces `{kind:'value', value}`. Empty sequence produces
`{kind:'empty', values:[]}`, distinct from a value containing an empty array.
Explicit `outcome` mode accepts only these exact shapes:

- `{kind:'value', value}`
- `{kind:'skip'}`
- `{kind:'explanation', text}` or `{kind:'explanation', text, value}`
- `{kind:'error', message}`

Outcome tags and JSON value types survive a JSON round trip. Signed zero follows
JavaScript Number arithmetic in memory; JSON/JCS text writes it as zero. Live
compilation/evaluation caches distinguish signed zero. Persist an explicit sign
field when an application needs to preserve that distinction. A skip cannot carry a value. Ordinary
object results are never interpreted as outcome instructions in `value` mode.

## Batches and isolation

`compileFormulaBatch(targets, options)` from `@jarenjs/json/formula/batch` compiles
`{id, enabled?, formula}` targets once. Disabled targets neither compile nor run.
Compile/runtime failure of one target does not stop independent cells. Each row
has a stable string/finite-number `id` (or the configured `key`); string IDs and
target IDs are bounded at 256 characters. Duplicate row/target identities refuse.

`batch.evaluate(rows, {context, revision, key})` returns `results`, exact `counts`,
`errors` and `omittedErrors`. Each result is `{id, outcomes}`. Error cells contain
`{kind:'error', code, diagnostic}`; diagnostic is an index into `errors` or null
when the diagnostic credit is exhausted. Counts distinguish rows, cells,
evaluations, cache hits, values, empty sequences, skips, explanations, errors and
disabled cells. Diagnostic text/path are bounded by `maxMessageChars` (default
256); `maxErrors` defaults to 100. `maxRows` defaults to 10000, `maxCells` to
100000, and `memoSize` to 10000. Exceeding an admission limit refuses the batch,
never silently reports a truncated result as complete.

`$computed.targetName` schedules named dependencies; missing targets and cycles
refuse deterministically. A dependency with no value blocks only its dependents.
Normalized Query paths supply conservative source-field dependencies. Whole-root
or nonsingular paths invalidate on any row edit. Named top-level dependencies
invalidate only when those values change; a declared input schema conservatively
tracks the whole row because it may constrain other fields. JSON validity is
checked even on memo hits. Context and explicit input revision
also join the memo key. Disabling/replacing profiles or capabilities requires a
new compiled batch. `clear()` releases memoized cells.

Default Query limits are 10000 expression steps, 64 levels of expression nesting,
10000 output items and 10000 phrase items. Their scope is exactly the
[Query limit contract](QUERY-FORMAT.md): intermediate work and arbitrary pure host
functions can exceed these costs. Batch row/cell credits bound scheduling and
retention, not arbitrary input/result byte sizes.

`createFormulaResource` from `@jarenjs/app/formula` owns injected terminating
workers. Supply `workerFactory`, `timeoutMs` (default 1000) and `maxInFlight`
(default 2). Each worker implements `request(message)` and `terminate()`.
Termination must actually stop the isolate and settle the request. Requests carry
`{version:1, generation, revision, payload}`; replies echo the identity and carry
`result`. The resource terminates and drains after every request, on cancellation,
on deadline and on disposal; late generations cannot publish. It offers no
same-thread timeout guarantee. `stats()` reports admitted pending work;
`dispose()` stops admission and returns a shared drain promise.

## Explicit migration

`migrateFormulas` and `rollbackFormula` live at
`@jarenjs/json/formula/migrate`. Source records require `id`, `label`, `enabled`,
`storageVersion` and `body`. The entire original is retained, including exact line
endings and extra application metadata. No source body is evaluated.

The measured conversion subset is deliberately narrow: `return null;` and
`return row.name * row.name;`, with ASCII identifier variations and whitespace that preserves JavaScript return
semantics. A line break immediately after `return` is refused because JavaScript
automatic semicolon insertion would change its meaning. Numeric
conversions emit required-number input schemas so JavaScript coercion is never
silently adopted. Outputs retain Number arithmetic, including its rounding
limitations; overflow refuses. A native target is `{formula, schemas}`.

Every other source receives a specific review reason: statements, optional
chaining, Intl formatting, application helpers, throw statements, result-policy
objects or unsupported syntax. Disabled sources are preserved without parsing.
The frozen synthetic corpus retains the original application-owned static oracle;
Jaren neither supplies a trusted JavaScript runner nor describes one as a sandbox.

Migration returns `{records, changes, changed}`. Repeating input reports zero
changes; missing sources in a later input do not delete records. A changed source
creates a conflict carrying both the original and current source. Native edits
are preserved. SHA-256 identities track source and native content.
`resolveFormulaMigration(record, native, review, options)` requires a reviewer,
reason, matching `sourceHash` and `expectedNativeHash`; it compiles the rewrite
and retains native history. Repeating an identical resolution is a no-op.
Rollback is a compare-and-restore proposal: changed source/native data refuses;
restoring twice has zero changes. The host applies returned records through its
own persistence command. Real saved corpora and operator review remain pending;
unresolved records prevent retirement of a trusted compatibility runner.

## Reviewed plans

`compileRulePlan` from `@jarenjs/json/rules` takes
`{$rules:'1', id, revision, targets}` and an explicit `writableFields` allowlist.
Targets add a JSON Pointer `field` to batch declarations. Optional `groupKey`
is application policy: first row per returned JSON group key is evaluated and
remaining duplicates are counted. Group/sibling/provenance data is explicit
`context`; the engine performs no hidden source reads.

`preview({rows, datasetRevision, context})` returns a deeply frozen plan with
SHA-256 `id`, rule ID/revision/document hash, dataset revision, enabled target IDs,
changes, counts and bounded diagnostics. Every change identifies entity/field,
target IDs, before presence/value, proposed value and any explanation. Equal
proposals deduplicate; differing proposals for the same entity/field conflict,
including when one proposal is a no-op. Conflicting locations are omitted from
selectable changes. Counts retain no-ops, conflicts, deduplication and cell errors.
Warm/cold caches produce the same plan identity.

`selectRuleChanges(plan, selection, currentPlan)` verifies both content hashes,
requires the same current plan identity and resolves unique stable change IDs.
**Call it inside an authoritative validated command transaction**, after checking
current authorization and reading saved rule/current rows. The current plan must
be recomputed there from authoritative data and policy. Revalidate resulting rows
before any effects, then use the existing durable receipt repository for replay.
A hash is content identity, never authorization or a signature. The helper alone
performs no writes and supplies no transaction.

The website's reviewed-rule example uses installed exports, a saved rule and local
SQLite, the reusable editor, and the existing virtual collection. Its application
command rechecks authority inside the receipt transaction, compares current rule
and dataset identities, validates all resulting rows before writes, and increments
row revisions only once. Draft preview does not save a rule; changing saved policy
requires a separate application command. Selection persists across review pages
and unmounted inventory rows; stale values never authorize writes.

## Measured qualification

The original fixture freeze and budgets are unchanged. Measurements include
compilation/snapshot overhead beside the retained static arithmetic loop; slower
native execution is reported. Evaluation pages are bounded and real worker
termination is automated on Node. Installed Node/Bun checks exercise source
migration, both frozen workloads and durable review replay. Real downstream data,
manual accessibility, physical devices and arbitrary host helpers remain separate
qualification; their absence is not a pass.

<!--fact:formula.measurements-->

Measured on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Static arithmetic ms | Native formula ms | Added cost ratio | Errors | Page rows | Heap / RSS MiB |
|---|---:|---:|---:|---:|---:|---:|---|
| catalog | 10000 | 0.75 | 224.64 | 297.63x | 0 | 256 | 31.20 / 110.09 |
| archive-stock | 75000 | 2.29 | 1641.62 | 715.60x | 0 | 256 | 103.36 / 239.91 |

Sources: 8 preserved, 2 converted, 5 require review, 1 disabled. Original byte changes: 0; repeat migration changes: 0. Preview writes: 0; replay writes/revisions: 0/0.

Synthetic public APIs only. Static arithmetic is faster; native costs include compilation, immutable snapshots, bounded outcomes and dependency memoization. Real saved-corpus, manual and physical-device acceptance remains pending.

<!--/fact-->
