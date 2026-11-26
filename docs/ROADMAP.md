# 📅 Jaren Roadmap

```
My manager tried to open that door before,
but it apparently was scheduled for the next release.
```

This is the single roadmap for the whole monorepo: the remaining release
milestones and the open work per package.

**It lists only what is still open.** When an item ships, its knowledge moves
into the document a reader would actually reach for — the package `README`, its
`ARCHITECTURE.md`, the format spec under `docs/` — and the entry leaves this
file. Nothing is summarized here twice. The record of *when* something shipped
is the git history and the release tags; what a shipped thing *does* is its
documentation's job. Keeping that rule is what stops this file turning back into
a changelog nobody reads to the end of.

Each entry states a problem and the constraint that makes it hard, in one
paragraph. An entry that no longer matches the code is a bug in this file —
delete it or fix it.

## Release milestones

- **1.0 stable** — no milestone-level blockers remain; 1.0 is gated on the
  per-package items below rather than on any one feature.

## @jarenjs/json — JSONPath & addressing

*The current focus.* JSON Pointer (RFC 6901), the JSONPath engine
(RFC 9535, passing the complete official compliance suite), JSON Patch
(RFC 6902) and Merge Patch (RFC 7396). See
[`packages/json/ARCHITECTURE.md`](../packages/json/ARCHITECTURE.md).

## @jarenjs/json — JSLT

- [ ] **A bare formula reference renders its id by default.**
  `renderQueryMessageId('query/formula/detail', { formulaId, detail })` with
  no `reason` answers the id unless `formulaMessagesEn` is passed: every
  formula error and diagnostic carries its English as `params.reason`, but a
  reference a host builds itself does not, and covering it in the query
  engine's English catalog costs about 3,300 bytes in every pen that carries
  the query messages.
- [ ] **JSLT matcher: schema-aware pruning and the rest of the single walk** —
  a mode's match paths built from names, indexes and wildcards (child or
  descendant) already run as one walk of the input; three parts remain. Prune
  shape rules that can never match, from input-schema knowledge: nothing
  accepts an input schema today, so this needs a new compile option (a minor).
  Run slice and filter selectors inside the walk too (they still enumerate per
  path). Specialize location tracking by the modes a dispatch can reach: a
  mode with no path rule and no `$path` read still builds every location
  because JT2002/JT2003/JT2004 messages print it (`no rule in mode "s" matched
  $['a']`), so this first needs messages that do not depend on it, or
  locations built only on error.
- [ ] **Prepass-level pruning from the changed-path feed** — skip re-matching
  paths over unchanged regions using the transition's changed paths:
  `evaluate(data, externals)` takes no changed paths today, so this needs a
  new argument or option (a minor) and `@jarenjs/app` passing its transition's
  `changedPaths`. Reusing the previous pre-pass by input reference instead is
  not safe: under `memo: true` a stylesheet whose rules are not memo-eligible
  answers right today when the caller mutates the input in place, and
  reference reuse would answer it from stale matches. Even with the pre-pass
  pruned, a copy-on-write view loop stays O(n) per frame: its `$apply`
  dispatch and memo lookups run per item.

## @jarenjs/json — XQuery front-end & QT3

- [ ] **More `xs:*` constructors and `fn:*` mappings** — mapped: the numeric,
  boolean and string constructors, the derived integer types,
  `xs:date`/`xs:dateTime`/`xs:time` for the values whose RFC 3339 text orders
  in time (a date without a timezone; a dateTime or time in UTC without a
  fraction), `cast as`/`castable as` for all of these, `fn:format-number`,
  `fn:tokenize` (I-Regexp, flags `""`/`q`), `substring-before`/`-after`,
  `translate`, `abs` … `compare`. What remains: the duration constructors
  (`xs:duration`, `xs:dayTimeDuration`, `xs:yearMonthDuration`) and date
  arithmetic, which need an engine operator that orders and canonicalizes a
  duration (its text orders neither by length nor by equality: `P1D`/`PT12H`,
  `P1Y`/`P12M`); date and time values outside that domain (other timezones, no
  timezone on a dateTime or time, fractions of a second, a timezone on a
  date), which need a date value that compares by instant, not by text; the
  component functions (`year-from-date`, `hours-from-time`, …) onto
  `$year`/`$hours`/…; `tokenize` flags `i`, `s`, `m`, `x`, which need I-Regexp
  flags; and the `declare decimal-format` prolog.

- [ ] **A value that may be a date is refused, even where it answers.** A use
  whose operand may hold a date and a value of another type (`min(($x,
  xs:date(...)))`, a `group by` or computed `order by` key over
  `(xs:date(...), $x)`) is refused by name, and an `order by` variable whose
  key is a string in a date's shape raises `unsupported` when the query runs —
  also where the other part is empty at run time and XQuery answers. Wanted: a
  date value the engine tells apart from a string at run time, so these
  compare as XQuery compares them. Arithmetic on a date raises the engine's
  `JQ2001` without XQuery's `XPTY0004`.

## @jarenjs/validate

- [ ] **Per-call cost of annotation tracking for `unevaluated*`** — a check
  over many members or items no longer scans the evaluation log once per
  member: a long stretch is gathered in one pass, so the check grows with the
  instance (static and dynamic checks alike, `anyOf` included). What remains
  of the gap to Ajv's compile-time evaluated-set tracking is per call: while
  tracking is on, every in-place keyword records each member it evaluates and
  `anyOf` runs every branch. A compile-time evaluated set per check, with
  recording confined to the checks whose set the instance decides, answered
  identically over the whole suite in every mode, but its analysis cost more
  bundle than the validator's budget and measured no faster than the log on
  suite-size instances; a smaller encoding of it, or gating that pays for
  itself, is the open work.
- [ ] **A dynamic reference keeps instance locations on** — once a `$data`,
  `data` or `$query` reader exists anywhere in the compilation, a `$ref` is
  resolved during the compile-time scan and only a target that reaches a
  reader keeps member and item locations on; a subtree holding a `$dynamicRef`
  or `$recursiveRef`, or a `$ref` inside a subtree with an embedded `$id`,
  still extends them even when nothing it can reach reads one. Following those
  needs every `$dynamicAnchor` the compilation can enter by that name, and the
  embedded resource's base.
- [ ] **`verbose` and `hierarchical` write a definition's units under every branch
  that entered it, and exhaust the heap on the studio's `form` seed; a broken
  document's `basic` writes each failing path.** A recording walk keeps a
  reference's answer and its units for the branches that enter it again, and
  `basic`, `detailed` and `list` expand only what they write
  (packages/validate/ARCHITECTURE.md, Standard Output Formats: "A unit's
  applied units are made from the records on first read, and `basic`,
  `detailed` and `list` read only the ones their pruning keeps"). `verbose`
  and `hierarchical` write the failed branches' units under `valid: true` by
  their own definition, so their size follows the branches. On the valid
  seeds, hierarchical writes 67 MB of JSON on minisite and 224 MB on
  dashboard, verbose 219 MB and 729 MB, and on `form` both run out of a 2 GB
  heap. On a broken document `basic` writes each failing path (minisite one
  phrase down: 2,819 units, 529 distinct by location, instance and text; form
  three phrases down: 183,807 units, 123 MB, 702 distinct). Wanted: an opt-in
  that writes each distinct error once (by schema location, instance location
  and text) on the recording formats, the default staying the specification's
  shape; `collectErrors` already keeps each distinct error once.
- [ ] **A two-position tuple validates at about half of Ajv's speed.** The
  validator benchmark's 'uniqueItems=false with an array of items' rows (a
  two-position `prefixItems`/`items` tuple of `type: boolean`; `uniqueItems:
  false` compiles to nothing) take 1.5–2.0× Ajv's time and the '…and
  additionalItems=false' rows 1.3–1.7×, and two runs of the same code part by
  up to a third on them. Such a tuple is one closure tested by code with no
  call per element (`isPurePosition` in packages/validate/src/array.js). What
  is left is the call into it: every compiled validator enters its schema
  through one shared function (`validateRoot`, `createValidateFn` in
  packages/validate/src/index.js), so that call sees every schema's closure,
  and a schema compiling to nothing still reads 1.1–1.3× Ajv's time; then the
  array test (`Array.isArray`; the instance's `constructor` member is no
  longer read). Testing the two positions without the loop measured a fifth
  faster per row in one process but does not stand out of the published rows'
  spread. Wanted: such a tuple at Ajv's speed, every answer unchanged.
- [ ] **A typical object schema validates at a third to a sixth of Ajv's
  speed.** Compiled alone and called warm (best of five rounds of two million
  calls on one pinned core), `{ type: 'object', properties: { query: { type:
  'string' }, limit: { type: 'integer' }, exact: { type: 'boolean' } },
  required: ['query'], additionalProperties: false }` takes about 53 ns per
  valid call where Ajv takes 17, the same without `additionalProperties` about
  69 ns to 12 and without `required` too about 62 ns to 12. A leading `type`
  (`object`, `array`, `string`), a type-only member or item and
  `additionalProperties` no longer cost a closure of their own; what is left
  is how a closure reads a member: a declared name probed with `Object.hasOwn`
  and read by a varying key costs about 13 ns where Ajv's generated code reads
  it by a fixed name in under 2 ns, and the validator generates no code by
  design. A `required` name is one more such probe, and a name `properties`
  also declares is probed twice: the second probe matters only to an instance
  that changes while it is validated, which is read in an unspecified order
  and may answer differently in the two modes (packages/validate/README.md,
  'Values JSON cannot carry'), so it may go. `additionalProperties` lists the
  instance's keys (`Object.keys`). The validator benchmark's properties,
  required and additionalProperties rows take 1.3–1.5× Ajv's time together.
  Wanted: those costs gone, every answer unchanged, non-JSON values included,
  an instance that changes while it is validated excepted.
- [ ] **An object member holding `undefined` is present to `required` and
  passes `type`, and a bare `undefined` passes `type`.** `{ required: ['a']
  }` accepts `{ a: undefined }` and `{ dependentSchemas: { a: { required:
  ['b'] } } }` refuses it, as for a member holding any value, while `{
  type: 'boolean' }` accepts a bare `undefined` and `{ additionalProperties:
  { type: 'boolean' } }` (the same under `patternProperties` or
  `unevaluatedProperties`) accepts `{ a: undefined }`, in both modes. Ajv
  splits the other way: it reads such a member as absent under
  `properties`, `required` and `dependentSchemas` (refusing the `required`
  schema above and not applying the `dependentSchemas` one), and tests
  its value under the other three, refusing them, as it refuses the bare
  `undefined`. What makes it hard is that JSON sends nothing to compare
  with: `JSON.stringify({ a: undefined })` sends `{}` and
  `JSON.stringify(undefined)` no document at all, where an array element
  holding `undefined` is sent as `null` and so fails `type` (the array
  section of packages/validate/README.md). Wanted: held for the
  maintainer's decision; no release changes either reading until then.

## @jarenjs/view & @jarenjs/app

- [ ] **Controlled inputs under `safe: 'interactive'`.** Inputs stay
  attribute-only, so app state cannot reset a field the user edited. Wanted:
  the controlled-value path for `value`/`checked` (not `file`) under the
  interactive profile, with its serializer counterpart.
- [ ] **One id namespace per untrusted document.** `idPrefix` defaults to
  `jaren-u-` in both safe profiles; two untrusted documents on one page, or a
  host id that starts with the prefix, must be kept apart by the host passing
  its own prefix. Wanted: a check that refuses a second render with the same
  prefix into one document, or a per-render default that DOM and SSR agree on.
- [ ] **Segmented logical scrolling past the CSS extent ceiling.** The [reusable collection](../components/collection/docs/COLLECTION.md) and [injected provider coordinator](../packages/app/docs/COLLECTION-PROVIDER.md) cover fixed/measured axes, keyed interaction and bounded page caches up to the conservative CSS extent ceiling; a source longer than that needs segmented logical scrolling. Complete sequential database snapshots and index seeks behind the provider also need an independently qualified source contract.

- [ ] **Collection table semantics beyond activation and selection.** A host serving a record table still lacks per-column
  sizes (`columnSize` is one estimate; an array is refused `Invalid size`), a `columnheader` row with its own ARIA row index, one
  fill column, and a content-height mode (the widget owns a fixed-height scroller, default 440px). Waits on the owner's choice:
  grow table semantics in the collection, or keep small bounded tables as semantic `<table>`s; for height, a non-virtual mode
  bounded by `maxRows` or virtualization against the page scroller. Pointer activation and host-owned selection shipped.
- [ ] **Collection qualification on real devices, assistive technology and downstream.** Waits on a physical touch device, a screen reader and native OS input methods driving the collection, and on a downstream consumer's acceptance; the retained virtualizer oracle stays until that acceptance permits its retirement. Qualified on this host: the collection matrix in Chromium, Firefox and WebKit with synthetic input, and installed synthetic consumers, which alone do not authorize an external cutover.

- [ ] **Real-browser accessibility audit.** Waits on a screen-reader session
  (NVDA, JAWS or VoiceOver) against the built site, proving the dialog focus
  trap, focus restoration and assistive-technology semantics that APP-FORMAT
  §8.4/§8.7 state. Qualified on this host: the site's lifecycle in Chromium,
  Firefox and WebKit on every push
  ([its browser tests](../packages/website/README.md#browser-tests)), both
  emulated `prefers-reduced-motion` preferences in all three engines
  (`reduce` yields final states on first paint, DESIGN §6/§10), and the
  collection matrix's pending active descendants, keyed focus and selection,
  anchored scroll, RTL and editable controls.
- [ ] **Native IME verification.** Waits on manual sessions with native OS
  input methods (CJK IMEs among them) on real devices before full language and
  input-method fidelity is claimed; VIEW-FORMAT §8 records that limit.
  Qualified on this host: composition-aware controlled writes, caret
  preservation, multiple selects and the safe create/update/remove/reinsert
  corpus in Chromium, Firefox and WebKit, with synthetic composition events,
  Firefox's automation input sequence, and synthetic composition during
  collection scroll and focused-row removal.

## @jarenjs/md

- [ ] **Canonical printing: delimiter runs neither the derivation nor the search
  reaches.** `toMarkdown` spells emphasis, strong and strikethrough whose
  canonical spelling does not read back from the delimiter rules (each node's
  delimiter, how many of the literal `*` and `_` beside a run print bare in
  it, the characters beside a run that print as references), falls back to the
  search where that spelling does not read back, and names what still does not
  read back to `onLossy`. Some trees the reader makes are reached by neither
  and are named `'unread'` instead of reading back: literal `*` or `_` inside
  nested runs (`*_***_**__x*_____2;_*____*_` is one), where no spelling the
  derivation weighs reads back or the derivation weighs one as reading back
  that the reader reads otherwise. Wanted: those spellings derived and the
  derivation's weighing agreeing with the reader, so that every tree the
  reader makes reads back and the search can go; such content costs the
  derivation and then the search.

## @jarenjs/mermaid

- [ ] **Mermaid forms still read differently from Mermaid** — measured against
  Mermaid 11.16.1 on its own syntax-doc examples: a class lollipop's interface
  is the relation's written end (`foo --() bar` ends at `bar`), where Mermaid
  makes one interface per lollipop (`interface0`, labelled `bar`), so two
  lollipops named alike, or one named like a class, share an end (wanted: the
  relations panel marks a lollipop end, so a class of the same name is not
  taken as it; the tree keeps the written name); an `<<enumeration>>` line
  inside a class body counts as a member; a subgraph nested in another is not
  its member, and one named by a quoted markdown title keeps the backticks in
  its id; `state X` with its `{` on the next line reads a state `{`; and a few
  lines Mermaid refuses still read: a node `@{ shape: … }` Mermaid has no name
  for, a lone `"` inside an unquoted label (`A[He said "hi]`), a nested
  generic in a class name (`class List~List~int~~`) and a bare `subgraph`
  line.
- [ ] **Sequence marks read but not drawn** — a participant's `type` (boundary,
  control, entity, database, collections, queue), the half arrows (`-|\`,
  `-//`, `/|-`, …), the two-way `<<->>` and the central-connection marks
  (`A()->>()B`) are read and printed back (MERMAID-FORMAT §4.2) but drawn as a
  plain box and a plain arrow; flowchart nodes in the 36 Mermaid 11 shapes
  with no drawn equivalent (`doc`, `manual-file`, …) read as a rectangle and
  print as one.
- [ ] **`htmlLabels:true` — browser check** — flowchart and state labels
  render as HTML in `foreignObject` when the host passes `htmlLabels: true` (a
  diagram's config can turn them off, never on; sized and wrapped by the
  advance table; `safe: true` keeps SVG text; MERMAID-FORMAT §3, §6–7). Not
  yet checked in a browser engine: label centering, overflow past the box, and
  color under a host-linked theme in light and dark, with pan and zoom.
- [ ] **Full layout for the secondary types** — class and ER render as structured panels, not domain-specific layouts; mindmap/gitGraph/journey/timeline parse-accept with a placeholder. Real layouts are the next coverage push (tracked honestly in the benchmark scorecard).
- [ ] **Layout/perf workstream** — dagre-lite handles ranks and straight
  edges; orthogonal edge routing, subgraph clustering and crossing reduction
  are the next levers. Edge labels now measure themselves and step aside from
  one another, so the remaining work here is the routing itself: an edge still
  runs straight from border to border and can cross a node it has nothing to
  do with.
- [ ] **More domain projections** — the geometry-free-AST-as-model idea now ships executable arrows for flat FSMs, compound statecharts and DAGs (`stateDiagram ⇄ jaren-fsm` and `flowchart ⇄ jaren-dag`, run by `@jarenjs/flow`; MERMAID-FORMAT §5.1); the remaining follow-ups on the same idea are sequence⇄orchestration/saga and ER⇄JSON-Schema+`@jarenjs/forms`.
- [ ] **Diagram tooltips on the secondary types** — `mermaidPlugin({ tooltips:
  true })` gives every node and edge of flowchart, state, jaren-dag, sequence,
  class, ER and gantt output a tooltip, through one marker contract
  (`render/marks.js`), and a flowchart or class `click` line's tooltip text is
  modelled and shown as text. The secondary types (mindmap, gitGraph, journey,
  timeline) render a placeholder and draw nothing to point at, sequence notes
  and blocks are not targets, a class or ER relation's label is not part of
  its ends' tooltips (the relations box draws it inside one row), and a
  truncated gantt name stays truncated in its tooltip. The text is
  English-only. A class diagram's `link` and `callback` statements (which also
  carry a tooltip) are not modelled.

## @jarenjs/play

- [ ] **Streaming readers need a chunked source pane** — the JOSL and CSV
  stream parsers are pure, but they consume a stream rather than a string, so
  a descriptor for them first needs a source pane that means "feed this in
  chunks" — a question the `(source, data)` shape does not answer.

## @jarenjs/studio

- [ ] **App documents cannot use pack operators in the studio.** An `app` file's
  meta-schema composes the query and JSLT grammars of the core operators only,
  so `validateFile` refuses `{"$sqrt": 16}` in an app view with schema errors
  whether or not the host's `operators` registry mounts the math pack (only a
  function reached through `$call` passes the grammar), and the document host
  boots apps with no pack and no function at all.
- [ ] **Entity models and durable project stores** — collection models now
  run in private workers with explicit query routing, SQL plans, live results
  and seed files. The stage's operation contract addresses collections; an
  entity-only model needs entity/query controls. Durable stores and migration
  UI also need project identity, storage ownership and a migration policy:
  the current documented lifetime is in-memory, reset on committed model or
  seed changes. Reusing the data page's shared database would break isolation.

## @jarenjs/contract

- [ ] **`diffContracts` cannot tell whether some member schemas accept
  nothing.** A string-only member whose `pattern` holds no string only by
  a lookaround, a back-reference, a word boundary or a modifier group
  (`^(?=b)a`, `^a\bb`), or only under one way of counting a length
  (`^.{3}$` beside `maxLength: 2` admits `e\u0301e` counted in grapheme
  clusters, nothing counted in UTF-16 units), and a required member whose
  `propertyNames` cannot be asked at its place (a dynamic reference in the
  document, a contract another copy of the package compiled), answer R15
  when added to an open input, so a `--fail-on breaking` gate alone
  passes them; a member that accepts nothing through a shape the
  procedure does not model at all (`type: 'string', allOf: [{ pattern:
  '[]' }]`, `type: 'array', items: false, minItems: 1`) still answers
  additive R7. Deciding the first would need the pattern's language
  computed with its lookarounds and back-references, the second the
  validator's own `lengthUnit` read from the compiled contract, the
  third every conjunct and item schema read against the node's own
  keywords.
- [ ] **`diffContracts` reports an `if` changed beside a `then` and an
  `else` unlike each other, a `contains` changed under both counts, or a
  union whose change touches a variant that overlaps another as R15
  `unknown`,** so a `--fail-on breaking` gate alone passes a required
  member dropped there. A value that crosses such an `if` moves from one
  branch to the other, and a value one overlapping variant drops another
  may still accept: deciding either would need two schemas compared value
  by value; with a `minContains` above 0 beside a `maxContains`, the
  count is not monotone in what matches. An `if` that changed while its
  branch changed or appeared, one added or dropped beside a branch, an
  `if` change at a keyword its branch also bounds, a changed `contains`
  beside a tuple form or beside counts that changed, a union changed in
  two variants, two `allOf` conjuncts respelled together, and a change at
  a location another conjunct or the node itself also constrains (it
  would need the two intersected; a variant added beside the node's own
  `type` among them) stay R15 too.

## @jarenjs/linq & @jarenjs/db — the data pair

- [ ] **A backlog read from the tick backwards is not counted.** A tick whose backlog is longer than one search reads
  under the limits fires exactly what `missed` says, but counts as skipped only the occurrences of the span it read;
  `counts.uncounted` says a tick did so. Wanted: the passed occurrences counted without enumerating them.
- [ ] **The client bundle carries calendar-member plumbing without the seam.**
  The calendar kernel runs only when a host installs `@jarenjs/db/temporals`,
  and the tree-shaking gate keeps it out of the store client, but the
  declaration's reading, its DDL and introspection terms and its refusals ship
  in every store client, about 11 KB of the client bundle that a store
  declaring no calendar member never runs. Wanted: the declaration read behind
  the seam too, so a store without it keeps only the refusal.
- [ ] **A CHECK the model does not declare is read back as a declaration where
  the format has one.** On PostgreSQL a CHECK of someone else's opens, still
  refuses the writes it governs (`JD2005`) and is an `unmapped-constraint`
  line of `introspect()` on a collection, an entity and a join table alike,
  where SQLite's CREATE-text comparison answers `JD0002`; but one of a shape
  the model format declares — an enum over an entity column, an interval over
  a collection — is read into `introspect()`'s derived model rather than
  reported, and `jaren-db plan --store` reaches SQLite alone. Wanted:
  `store.introspect()` naming each CHECK its own model does not declare.
- [ ] **Read the store's own rule programs back on PostgreSQL.** On SQLite,
  introspect({ triggers: sqliteTriggers }) reads a store-owned table's
  _jaren_rule_* programs back as the rules that plan them (MODEL-FORMAT
  §13.6), all or nothing per table; on PostgreSQL they stay unmapped-object
  rows, so the derived model loses the rules it was read with. Wanted: the
  same re-planning oracle over the PL/pgSQL function bodies, which needs a
  reader of their bounded shapes (MODEL-FORMAT §13.6 states that the reader
  reads SQLite programs only).
- [ ] **A jaren-db introspect command.** The CLI reads no model back from a
  database: introspectModel(connection, options) and store.introspect(options)
  do, with the trigger reader (MIGRATION-FORMAT §11 says none ships). Wanted:
  a subcommand over introspectModel that can pass the trigger reader.
- [ ] **PostgreSQL entity grouping over a store-owned table.** One-root scalar
  grouping, guarded integer sums and counts and groups ordered by an integer
  sum lower on SQLite over every table, and on PostgreSQL over one adopted
  table with no document column; over a store-owned table, and over any join,
  PostgreSQL plans the set residual (`bind.entityGrouping`). Lifting that
  guard is not enough: over a `numeric` column another writer re-keyed, the
  statement groups `2` and `2.00000000000000000001` apart where the engine
  reads one key, and it answers a group over an integer past 2^53 that the
  engine refuses (`JD2003`). Wanted: the group key read as the double the
  engine holds and the row's integer check carried into the grouping,
  qualified under SQLite's oracle with re-keyed digits. Every other shape of
  the former umbrella (untyped or object-listing group keys, row-binding
  returns, floating sums without a rounding proof, windows over groups, a
  compound key's tie order, two-path comparisons outside one family,
  disconnected bindings) answers right in the engine and is the documented
  boundary ([MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md)), where
  `explain()` names each reason.
- [ ] **An entity operator projection has no row residual.** A return built of
  the operators [MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md)
  proves (`$upper`, `$add`, `$string-length` over required typed members) runs
  per fetched row on a collection (`row`), but on an entity every operator
  projection, and every window over one, is the set residual
  (`entity.projection`): the entity planner has no row residual. Wanted: the
  constructor evaluated per fetched row over the entity's statement, so entity
  operator projections and their windows stream as `row`. Every other shape of
  the former umbrella (a distinct over an object, an array, an operator or the
  document — structural equality, not a missing plan —, a distinct with its
  own ordering, `entity.distinct`; hops chained, ordered inside, correlated
  across families or by inequalities alone, `entity.hopShape`; operators
  outside the proven list) answers right in the engine and is the documented
  boundary (§10.6), where `explain()` names each reason.
- [ ] **SQLite row estimates.** Wait on a per-statement estimate API in
  `node:sqlite` or `bun:sqlite`; neither exposes one, so `rowEstimates` stays
  absent on SQLite, which also lacks a statement timeout (a server timeout is
  not the Store's `AbortSignal` promise). Qualified on PostgreSQL:
  `rowEstimates` from the planner's own labelled estimate
  (`explain().budget.estimatedRows`), bounded native cursors, a server timeout
  and an optional cursor cancellation hook.
- [ ] **Broader relational mapping and query qualification.** Explicit SQLite
  and PostgreSQL column layouts, codecs, read-only views and composite-key
  join-table entities are supported ([MODEL-FORMAT
  §12](../packages/db/docs/MODEL-FORMAT.md#12-existing-column-layouts)).
  Physical tables page by integer, bigint, text and uuid identities on both
  engines (a SQLite uuid by the text its table stores), an identity of NOT
  NULL terms in one direction as one row value that the key's index serves
  ([MODEL-FORMAT §10.5](../packages/db/docs/MODEL-FORMAT.md#105-pagination)).
  Relation navigation across physical layouts, a PostgreSQL page ordered by a
  column that may hold NULL read in index order (its empty-first placement is
  not the order a default index provides, so its rows are sorted — the
  entity-ordering entry over a column that may hold NULL; a key or a NOT NULL
  order column reads its index), pushdown beyond the qualified native census
  and additional PostgreSQL types remain open. A partition attached to an
  adopted partitioned table while a store is open reports a duplicate key as
  `JD2005` naming its own constraint until the next open; the catalog read
  cannot follow it without a read on the failure path, which an aborted
  PostgreSQL transaction forbids. Capture and replication of adopted physical
  tables — whose application triggers and cascades the store does not write —
  remain refused until their complete writer population has an executable
  oracle.
- [ ] **Broader database invariant lowering.** Rules lower to verified
  triggers on SQLite and PostgreSQL alike ([MODEL-FORMAT
  §13](../packages/db/docs/MODEL-FORMAT.md#13-persistence-invariants)), over
  comparisons, membership, existence probes keyed by a verified key or index
  and integer `$add`/`$sub`/`$neg` inside the safe-integer domain, and a
  migration that adds or changes a rule on a table the store owns judges the
  rows the table holds by it (`JD0023`, MIGRATION-FORMAT §9). The operators
  refused at the member (`JD0005`) are the stated boundary: `$mul`, `$div`,
  `$idiv`, `$mod` and arithmetic over a `number` operand (the engine's double
  rounding and division are not SQL's) and `$starts-with` (a code-point prefix
  spelling and an oracle of its own on each engine). A physical layout's
  programs, which the host installs (`planInvariants`) or `planProgramUpgrade`
  reinstalls, and a drifted store-owned program `repair` reinstalls, judge no
  stored row. Store-only rules retain their explicit writer qualification.
  SQLite's change test compares each column under its declared collation and
  stored spelling (§13.4), where PostgreSQL and the store compare by codec;
  comparing by code point would change the text of every installed update
  program, so it waits for a reviewed migration of installed programs.
- [ ] **A linq transaction that reads a handle builds a record of every name.** A
  transaction client builds its `entities` and `collections` records when its
  body first reads them, so a body that reads no handle costs the same at any
  model size; a body that reads one still builds that record's getter for
  every name of its kind, because a record holds the model's names as its own
  frozen members (DB-CLIENT §2.1), which stays the contract. A shared
  prototype holding the getters would make `Object.keys` of a transaction's
  record answer no names, and a Proxy cannot answer the names of a frozen
  record without holding them. Wanted: a cheaper build that keeps the names as
  own frozen members.
- [ ] **The native SQL census's mutation families on PostgreSQL.** The
  executable census proves five adopted-column read families and three SQLite
  mutation families ([native contracts](../packages/db/docs/NATIVE-PLANS.md)),
  and entity `mutate` also runs natively over adopted PostgreSQL column
  layouts, but the census's parity, no-op and rollback proofs and its
  benchmark run on SQLite only. Wanted: the three mutation families on
  PostgreSQL with PostgreSQL reference SQL, the same proofs, and the
  benchmark's PostgreSQL row. Receipt history retains SQL because its table
  has no declared primary key; promotions into the JSON query semantic
  contract and store-invariant bulk preimages wait on the same proofs.
- [ ] **Relational recovery beyond the qualified SQLite hosts.** Waits on
  outside evidence: a power-cut rig for power-loss durability; macOS and
  Windows machines for the worker-hosted Bun backup
  ([HOSTS](../packages/db/docs/HOSTS.md#existing-file-adoption-and-backup)) and
  any deployment beyond the qualified Linux executables; and an application
  owner's physical-schema and downstream cutover. Qualified on this host:
  explicit preservation plans, consistent committed-WAL backups, interrupted
  rebuild and publication recovery, and forward repair from the newest file
  under Node and Bun ([MIGRATION-FORMAT](../packages/db/docs/MIGRATION-FORMAT.md#existing-physical-files-and-forward-recovery));
  on PostgreSQL the shared receipt and preservation executor for reviewed
  native catalog targets, recorded dependencies and sequence allocation guards,
  independent-database shadow replay of exact qualified programs, and
  [separate managed-data oracles](../packages/db/docs/POSTGRESQL.md) for
  coherent dump/restore and archived-WAL recovery.
- [ ] **A PostgreSQL rebuild under a view, a self-referencing entity's retyped
  key, and a retype into text in place.** A change the planner expresses as a
  rebuild (a key declaration, a type, a relation, a calendar member) rebuilds
  the table on PostgreSQL under a table lock; for an entity another table's
  foreign key references, its own included, the step drops each such key and
  adds it again, validated, in the same transaction ([MIGRATION-FORMAT
  §10](../packages/db/docs/MIGRATION-FORMAT.md)), which holds an `ACCESS
  EXCLUSIVE` lock on the table and on each table that references it, readers
  included, from the step's second statement until the link commits. An
  application's view over the table, a foreign key from a table the model does
  not declare, or another object the server keeps on it is refused at the drop
  (`JD0023`, naming it), and a self-referencing entity whose key is retyped is
  refused at the temporary table's create (its reference to the old table
  cannot join the two types); either link rolls back whole. A referenced
  entity's `enum` change, or a retype by a cast of a column that is no key, no
  foreign key's column and read by no index, changes in place instead; a
  number or an integer retyped into text (its spelled copy is a select, which
  `ALTER COLUMN … TYPE … USING` cannot hold) rebuilds. Wanted: a
  self-referencing entity's retyped key, and an in-place retype into text.
- [ ] **A join table carries no column beyond its two keys.** A many-to-many
  join table is a read-only root (`$.<JoinTable>[*]`, MODEL-FORMAT §10.7)
  whose rows are its two keys, so "which pairs were attached since Friday" has
  no column to read; such a membership is an entity with two one-to-many edges
  today. Wanted: columns declared on a `through` (an attach instant at least).
  Five decisions come first: the declaration (`through` is a table name on
  either side of the edge, and any other value is refused `JD0005` where a
  store opens or prepares the model, which keeps an object form free; an
  object form must be declared once or identically); who writes a value
  (`link()` carries none, and the unit of work, the capture journal,
  replication documents and live join rows carry only the two keys; a database
  default such as `'now'` is the database's transaction time, which a replay
  or a capture apply on another database does not reproduce); what re-linking
  an existing pair does (an idempotent no-op today: keep the first value or
  refresh it); how `introspectModel` tells a join table with a third column
  from an entity (it reads exactly two foreign-key columns as one); and the
  migration strategy that adds or drops a column on a join table (none
  exists). A migration plan's target model, `explainMapping` and the CLI still
  read a non-string `through` as the implicit `<A>_<B>` name: the refusal
  moves there once a plan reads its from model as history.
- [ ] **A PostgreSQL statement at the term bound can still compile for seconds
  over an `$or` of pairs.** One statement carries at most 128 predicate terms
  ([POSTGRESQL](../packages/db/docs/POSTGRESQL.md)); a leaf is one term, an
  inequality or a negated comparison against an external operand on a document
  member counts four, and a member's membership in an external list counts
  sixteen (four in its own column, eight there under a `$not`), so the
  external chains that compiled for many seconds are the engine's. A
  conjunction's `$ne` over one member — literals, or externals over an
  entity's string column — is spelled as one negated list, whose compile does
  not grow with its length, and counts one term. A statement the server's cost
  model sends through JIT is still compiled by LLVM, which no signal
  interrupts, and an `$or` of `$and` pairs (an equality and a range each)
  compiles per leaf and grows with the count. Wanted: the pairs spelled as one
  table-driven membership — a row of bound values per pair, each column typed
  as the column it is compared with (a `numeric` column by the interval edges
  it binds) — weighed as one term.
- [ ] **A mandatory predicate of pairs past the term bound still reaches
  PostgreSQL whole.** A profile's mandatory predicate with more terms than the
  dialect's bound demotes the document, and the residual's root fetch carries
  the whole predicate (a 200-leaf statement is sent; it answers right and
  `maxRows`, `strict` and `refuseFullScan` still bound it). A chain of `$ne`
  over one member — literals, or externals over an entity's string column — is
  one list and one term, so it no longer demotes; an `$or` of tenant/level
  pairs still does, and compiles per leaf under JIT. A refusal (`JD0011`) was
  tried and rejected: profiles of 65 tenant/level pairs answered right and
  would stop opening. Wanted: the pairs spelled as one membership (the
  statement-bound entry's wanted spelling), or a weight for the fetch in the
  style of the external-operand weights.
- [ ] **On PostgreSQL a comparison of another kind of a union member seeks no
  non-unique composite or conditional index, and no non-unique index over a
  path with a guarded step.** A declared single-path index over a member of
  several scalar kinds has an index beside it per other kind (`c_by_q$text`),
  and so does every unique index, so it seeks; a non-unique composite
  (`['$.q', '$.k']`) or conditional index over such a member, and a non-unique
  index over a path whose step the dialect guards (`$.u[0]`), has none, and
  that comparison reads every row. The same index beside those seeks
  (measured: Seq Scan to Index Scan on all three), but it keys the member at
  its other kind, so a write the declared index stores today — a string past
  the B-tree entry limit (2,704 bytes), or another writer's number of
  thousands of digits, which the declared column holds as NULL — would be
  refused `JD2005`, and `introspect()` reads such an index back beside no
  non-unique composite, conditional or guarded index. Wanted: an index that
  keys a bounded image of the value (a hash index, or an expression over a
  digest, with the comparison spelled to read it) so no write is refused, read
  back by `introspect()`.
- [ ] **On PostgreSQL an ordering over a unique member is sorted, and a
  descending page deep into its order walks the index.** A non-unique index
  the store creates over a column a statement orders bare keys it `NULLS
  FIRST` with the row identity after it, and an index led by a number column
  that declares `doubleOrder` has one beside it over the double, so a window,
  a load's `orderBy` and a keyset page read them — an ordering with `$empty:
  'greatest'` in two ordered, limited branches under one sort of their rows —
  and an ascending page past a value seeks the index from it; a table an
  earlier release created, whose indexes the open reads as plain, is read as
  that release read it until `planColumnUpgrade` respells it. But an ordering
  over a unique member, whose index keeps its plain spelling, and over a
  number member whose index declares no `doubleOrder`, sorts as before; and a
  descending page with its empty keys last (the default) reads the index
  backward from its start, its continuation a filter, since its empty keys
  follow every value and no one bound holds of them. Wanted: an ordering over
  a unique member read in index order, and a descending page that seeks.
- [ ] **On PostgreSQL a load's scalar `after` over a `numeric` key without the
  store's key CHECK, and such a key at or past 2^53, still compare bare.** A
  table an earlier release created holds a writer's digits until
  `planColumnUpgrade` adds the CHECK: its literals, lists, joins, hops, pairs
  in one row, a query's, a load's and an include's ordering compare the key as
  the doubles the engine holds, and a page's keyset continuation carries the
  digits of a row another writer re-keyed (`"key": "5.99999999999999999999"`),
  so every row is paged once; but a load's scalar `after` (`load({ orderBy,
  take, after: 6 })`) positions no row among the keys that round to its
  number, so a walk by it can step past a row another writer re-keyed, and
  such a table's load ordered by the key is sorted, not read in the key's
  index order. At or past 2^53 the CHECK leaves a writer's digits their own,
  so a pair and an ordering compare such a key exactly where another writer
  may have spelled it otherwise. Wanted: a scalar `after` that resumes exactly
  over such a key, and the order of a key past 2^53 read as the double.
- [ ] **On PostgreSQL an external list holding both strings and numbers reads
  every document.** Each branch of a membership in an external list stands
  beside whether the list holds its kind, so a list of one kind seeks the
  member's index (numbers by the interval of decimals that round to each,
  strings by `= ANY`), and a number external compares the generated `numeric`
  column with `numeric` edges and seeks; a list holding both keeps both
  branches in an `OR`, and a branch over a kind the member has no column for
  reads the document, so it scans (measured: 20,000 documents, a two-number
  list 35.6 ms before, 1.3 ms now). Wanted: the branch of the other kind as
  its own index read (a `UNION` of the two seeks).
- [ ] **On SQLite an empty window over an indexed `integer` member the schema
  does not bound is read twice.** The order key reads the double (`CAST("gx_v"
  AS REAL)`) so two spellings of one double past 2^53 tie as the engine's do.
  A window with a limit reads the column bare, in index order, behind a probe
  in its own LIMIT, and an empty answer is read again ordered by the double:
  measured on 20,000 rows, a five-row window that holds no row costs 13.1 ms
  (the fallback alone 5.5 ms), where a window over rows costs 0.03 ms. An
  index over `CAST("gx_v" AS REAL)` loses (16.8 ms: its walk decodes every row
  to test the filter) and a read of every row is decode-bound either way
  (17-18 ms). Wanted: a statement that tells an empty answer from a probe that
  found such an integer (a sentinel row whose order SQLite keeps), so the
  empty answer costs one statement.
- [ ] **A native grouping in the engine's order of first appearance cannot
  know its group count.** A native `$distinct` or `$groupby` whose order does
  not name every key groups every row it reads and then sorts the groups by
  their first row: with nearly as many groups as rows it is slower than the
  engine — on PostgreSQL 1.5-1.8x at 16,000 one-row groups, and a grouping
  ordered by its key as much (the client reads one row per group); a larger
  driver fetch window (`windowRows` 64 -> 4096) speeds the engine's read of
  every document more than the grouping's, so it widens the gap (1.8-2.5x) —
  more than on SQLite (1.2x). Wanted: a cost signal that costs the answering
  path no second round trip — a distinct-count estimate the planner holds
  without a catalog read, or a bounded-group run-time fallback that does not
  run both plans.
- [ ] **PostgreSQL verifies a layout index condition or expression key it
  cannot read back by shape.** A layout index's condition, or the key under an
  expression term, that the PostgreSQL read-back does not read — a timestamp
  literal, a date a session under another `DateStyle` writes, a function
  outside the relational vocabulary, a quantified comparison over anything but
  a list of non-NULL literals — is not compared, so an index recreated under
  another such condition or key opens as the declared one, where SQLite
  compares the CREATE text (MODEL-FORMAT §12); `introspect()` reports such an
  index (`unmapped-index`). Wanted: read those forms into the condition form.
- [ ] **A database rule's locking probe under row-level security refuses in
  the rule's name.** On PostgreSQL a probe that locks the row it finds reads
  it through the table's UPDATE policy as well as its SELECT policy. A store
  rule whose locked probe misses a row an unlocked read finds refuses
  `JD2099`, which names the policy (MODEL-FORMAT §13.3); a database rule's
  program still refuses such a write in the rule's name (`JD2096`, `jaren
  invariant:<rule>`) though the row exists. Wanted: the program's own unlocked
  probe on that failure path and a refusal the store reports as `JD2099` — new
  text for every installed program, so a program spelling of its own and a
  reviewed upgrade link.
- [ ] **PostgreSQL migrationStatus compares only rule programs.** On
  PostgreSQL, migrationStatus(…, { model }) and plan --store's comparison read
  the rule programs of each ruled store-owned entity table as the open does
  (MIGRATION-FORMAT §12), and acceptance verifies join tables and collections
  too, but status compares no column, index, or undeclared trigger of a table,
  where SQLite compares every stored CREATE text. Wanted: status reads every
  table the model owns as the open verifies it.

## @jarenjs/locales

- [ ] **The uncataloged-text guard reads a window of tokens.** The guard refuses a
  literal equal to a catalog's English unless one of its ids sits beside it,
  but it reads a window of tokens, so a copy beside a word equal to an id's
  last segment still passes. The data studio's corpus disagreement line
  (`components/studio/src/data/runtime.js`) reads its catalog for the empty
  sequence and is English around it (`) disagreed on ` is listed `not-prose`).

## @jarenjs/core

## Lexical search (cross-package)

The [resident lexical contract](../packages/core/docs/SEARCH.md), explicit JSON/LINQ
provider boundary, source-validated db snapshots and injected worker lifecycle are
implemented. The [measurements](../benchmark/README.md#lexical-search-qualification)
qualify the retained cold ranking profile on frozen synthetic corpora.

- [ ] **Downstream relevance and migration acceptance.** Waits on an
  application's real corpus run through the declared tokenizer, ranker and host
  decoding policy, and on its owners' review of ranking, tie and resource
  differences before the retained engine leaves that consumer. Qualified on
  this host: the retained cold ranking profile on frozen synthetic corpora,
  which establishes neither production relevance nor host-wide memory limits.
- [ ] **Native full-text execution.** Qualify SQLite/PostgreSQL tokenization,
  ranking, ties and errors before promoting a dialect index. The current db
  adapter reports bounded resident residual work; PostgreSQL external-writer
  capture needs its own platform proof. Optional match positions remain open.

## Saved formulas and reviewed rules (cross-package)

Versioned native profiles, bounded per-record outcomes/dependencies, explicit
subset migration, terminating workers and reusable reviewed-rule authoring are
implemented in [FORMULA-FORMAT](../packages/json/docs/FORMULA-FORMAT.md) and
[@jarenjs/rules](../components/rules/README.md). Reviewed writes use the existing
validated command/receipt transaction with current-authority and snapshot checks.

- [ ] **Saved-source corpora resolved with their owners.** Waits on the
  application owners' saved-source corpora and their helper and result
  policies, which decide the differences a translation names. The translator
  covers a measured corpus with every remaining difference named and
  positioned; whether such a corpus needs more than the translated subset —
  regular-expression captures (`.match(…)[n]`), a first-occurrence `.replace`,
  a string-or-array `.length`/`.includes` on a field no host schema types — is
  that corpus's to show. Retain the application-selected trusted runner until
  every original is resolved.
- [ ] **Downstream adoption, physical devices and manual accessibility.**
  Waits on a downstream application adopting saved formulas and reviewed rules,
  runs on physical devices, and a manual accessibility pass. Qualified on this
  host: automated synthetic Node/Bun and browser results, which do not prove
  those outcomes.

## Provider execution and durable domain workflows (cross-package)

The suite already supplies ordered/drained `mapConcurrent`, AI clients with
bounded requests and retry policy, contract HTTP clients and host lifecycle
hooks, `createDbLedger(tx)` settlement, flow checkpoints, fenced jobs with
renewal/recovery, and the transactional `tx.jobs` outbox
([contract lifecycle](../packages/contract/docs/CONTRACT-FORMAT.md#77-the-host-lifecycle-identify-acquire-release-settle),
[jobs](../packages/db/docs/JOBS-FORMAT.md),
[flow](../packages/flow/README.md)). The remaining work extends their composition with
external provider protocols and existing durable business facts. Reuse those
owners: core for shared scheduling, contract for execution boundaries, flow for
orchestration, db/linq for persistence, app for public run observation and ai for
its provider dialects. Provider schemas, credentials, destination policy,
inventory arithmetic and immutable business history remain application-owned;
native integration means expressing and enforcing them through public Jaren
capabilities, not replacing their meanings with a generic ledger.

The bounded provider read and ingestion composition now has public owners:
[core retry and scheduling](../packages/core/docs/SCHEDULING.md),
[contract descriptors and private run authority](../packages/contract/docs/PROVIDER-FORMAT.md),
[flow ingestion](../packages/flow/docs/WORKFLOW-FORMAT.md#complete-provider-ingestion)
and [transactional staging/publication](../packages/linq/docs/DB-CLIENT.md#complete-ingestion-store).
Three recorded dialects and two installed Node/Bun consumers qualify bounded
reads, authority revalidation, lossless accepted pages, crash recovery, complete
partition publication and identical-input no-op behavior. The original reference
fixtures remain executable; these results do not retire external SDKs or qualify
production cutover. Streaming DAG input is not required by this composition.

- [ ] **Provider extensions and live adoption.** Waits on real provider
  accounts, their credentials and their hosts: provider authority, credential
  refresh and account restoration, and read-back qualified there before any
  downstream cutover. Until a protocol is qualified that way, media/binary,
  bulk-operation and upload descriptors refuse before dispatch, and an SDK
  transport must prove one request per admitted attempt and bind provider
  idempotency explicitly. External writes go through the durable receipts and
  reconciliation composition, since single-send classification cannot resolve
  an uncertain remote outcome; membership, destination and reconciliation rules,
  manual facts included, stay injected by the application.
- [ ] **Existing business-history adoption qualification.** Waits on each
  downstream application's owner: its historical outcome mapping, hash-version
  policy, retention rules and existing transaction owner, qualified before
  cutover, and on runs on other operating systems and a downstream PostgreSQL
  deployment. Qualified on this host: the
  [durable command composition](../packages/contract/docs/DURABLE.md)
  co-settling validated HTTP/local/job commands over mapped application tables,
  with permanent replay, separate leases and bounded migration/compaction, in
  the combined Linux executable and installed Node/Bun SQLite. Arbitrary
  historical schemas and destructive retention policies are not inferred or
  supported automatically.
- [ ] **Provider-specific external reconciliation acceptance.** Waits on real
  providers and an operator: key scope and retention, correlation and read-back
  guarantees, absence semantics and authoritative outcome classification
  established per provider; real disconnect, timeout and lost-settlement
  boundaries exercised; and application/operator acceptance of manual
  reconciliation and separately authorized compensation. Qualified on this
  host: the
  [fenced effect composition](../packages/flow/docs/WORKFLOW-FORMAT.md#domain-run-and-external-effect-adoption)
  recording reviewed legs, sending intent, uncertainty and explicit
  reconciliation on the job engine, with synthetic exactly-once local
  settlement, which does not establish exactly-once remote delivery.
- [ ] **Application run lifecycle adoption.** Waits on each application's
  owner: its historical status vocabulary, public-summary projection,
  upgrade/reset policy, remote cancellation boundaries and host resource
  lifecycle qualified before cutover, with downstream and manual acceptance and
  runs on other operating systems and a downstream PostgreSQL deployment.
  Qualified on this host: the
  [mapped run and observation adapters](../packages/linq/docs/DB-CLIENT.md#durable-mapped-records)
  preserving run identities, workflow/schema provenance and bounded progress
  over workflow checkpoints and job fences, in the combined Linux executable,
  with synthetic restart, takeover and observer evidence that does not
  substitute for those runs. Source provenance, review decisions and posted
  history keep their domain schemas and rules.

## Native application adoption — external qualification

These workstreams cover five mechanisms that can remain application-owned
after adopting the suite: domain SQL/private driver bridge,
MiniSearch, virtual-core, trusted local formulas, and provider adapters/domain
ledgers.

| Retained mechanism | Roadmap owner |
|---|---|
| Domain SQL and private driver bridge | [The data pair](#jarenjslinq--jarenjsdb--the-data-pair): physical mappings, invariants, shared transactions, native queries and recovery |
| MiniSearch | [Lexical search](#lexical-search-cross-package): ranking, incremental indexes and resident/database equivalence |
| virtual-core | [View and app](#jarenjsview--jarenjsapp): windowing, accessible interaction and bounded data providers |
| Trusted local formulas | [Saved formulas and reviewed rules](#saved-formulas-and-reviewed-rules-cross-package): native profiles, evaluation, migration and reviewed plans |
| Provider adapters and domain ledgers | [Provider execution and durable workflows](#provider-execution-and-durable-domain-workflows-cross-package): scheduling, protocols, authority, receipts, reconciliation and run adoption |

The [public disposition ledger](ADOPTION-EVIDENCE.md#request-disposition-ledger)
reconciles the library requests and selected older clauses against their owned
contracts and executable evidence. Library completion and synthetic portable
qualification are established within those scopes. Each external retirement
entry remains pending until its actual host and operator evidence exists.

- [ ] **External adoption acceptance.** Waits on real labelled and
  saved-source corpora, actual provider-platform guarantees, a downstream
  cutover, a manual accessibility and native OS IME pass, and runs on other
  operating systems and a downstream PostgreSQL deployment. Qualified on this
  host: the combined journeys on Node/Bun installations, the Linux standalone
  executables and automated browser composition. Keep original sources and
  retained oracles until their qualified retirement; synthetic passes never
  authorize a downstream deletion or increase a budget.
- [ ] **Safari offline page navigation.** Offline page reload is qualified
  with the site's server really gone on Chromium, Firefox and the Linux
  Playwright WebKit build, both on its own and inside the adoption journey
  (reopen, ingestion, interrupted send, reconciliation and reload, all
  offline). Playwright's WebKit offline emulation fails a request before the
  page's service worker answers it, so that build takes the real outage alone;
  the reduced case is pinned in the browser suite. Waits on an offline reload
  in a shipping Safari (macOS or iOS), which this Linux host cannot run.
- [ ] **Combined resource qualification on Windows and macOS.** The Linux Node
  and Bun source hosts publish the largest live heap after forced collections
  at the journey's phase boundaries and the host resources remaining after
  teardown in the [complete budget comparison](ADOPTION-EVIDENCE.md#complete-frozen-budget-comparison).
  Windows and macOS need the same run (`node benchmark/adoption-resources.js`)
  on a machine of that system: their allocators, file and socket handles and
  process teardown differ in ways a Linux run cannot show.
- [ ] **The SQLite owner lease on macOS.** [HOSTS.md](../packages/db/docs/HOSTS.md)
  qualifies the lease on Linux only. macOS arm64 and x64 need a run of
  `test/db/owner-lease.test.js` on each: APFS locking, process termination and
  its case-insensitive default (the path-spelling case adds the other-case path
  there), recorded with the operating system, architecture, Node and SQLite
  versions of each result. One platform does not qualify another.
- [ ] **Combined resources on the standalone executables, and the peak inside a
  call.** The live set and remaining handles are measured on the Node and Bun
  source hosts only; the relocated standalone executables
  (`scripts/check-adoption-journeys.js --native`) have neither. The published
  peak is the largest live set at phase boundaries, a lower bound: a live set
  inside one application call is not observed (the smallest heap limit the
  journey completes under would bound it from above).

## Windows qualification (cross-package)

Nothing below has run on Windows; [HOSTS.md](../packages/db/docs/HOSTS.md)
says as much of the owner lease. Hosted CI runs on Linux only, and the
[Windows workflow](workflow/WINDOWS.md) is opt-in. These behaviours depend on
Windows file locking, sockets, process termination, timers, links or line
endings in ways a Linux run cannot show, so each needs a run on a Windows
machine — the opt-in workflow or a local one — and its result recorded here.

- [ ] **Files and SQLite locking.** Waits on a Windows run of the file and
  lock tests, where Windows file locking and `TerminateProcess` differ from
  Linux: a refused `openStore` (a malformed option value) must create no file
  and hold no handle; the owner lease (`test/db/owner-lease.test.js`: a second
  process refused while the first holds it, a killed holder's lease expiring
  though its handle may outlive it, `close()` releasing at once, a read-only
  open never refused, the renewal on a 3 s wall clock with 150 ms margins, the
  same file named by another path spelling, path case included);
  two worker-thread stores racing `BEGIN IMMEDIATE` on one file
  (`test/db/collection-expect.test.js`, 300 rounds under the 5 s busy timeout)
  and a second `DatabaseSync` holding a writer while a store refuses options;
  keyset pages over adopted files with a malformed-UTF-8 key
  (`test/db/physical-page.test.js`) and list membership read by a second
  connection (`test/db/list-membership.test.js`,
  `test/linq/list-membership.test.js`); the migrations (`migrate-host-step`,
  `migrate-foreign-keys` with a raw second connection writing an orphan, atomic
  runs, adopted history, and the planner goldens on LF checkouts); the
  shared-cache store `test/db/store-source.test.js` opens under SQLite's
  `win32` VFS; and every test and README example that removes a temp directory
  after `close()` (`test/db/fixtures/shared-memory-source-bun.mjs` now leaves its
  working directory before removing it and names a failure to; it waits on the
  Windows run to confirm)
  (`EBUSY`/`EPERM` when a worker's handle outlives it).
- [ ] **Worker and pool hosts.** Waits on a Windows run of the worker and
  pool tests: `test/db/relational-store.test.js` and `quirks-relational.test.js`
  (`node-worker` and a WAL `node-pool` over a temp file: the reader-lane
  assertion and the WAL sidecars); `transaction-hold`, `transaction-retry` with
  its README runner, `connection-loss` and `quirks-transactions` (100 ms holds
  near the limit); and `pool-parallel-reads` (a held read given back on close
  within 2,500 ms). A worker `endpoint` is a URL — on Windows
  `pathToFileURL(path)`, never a `C:\` path; `test/db/worker-endpoint.test.js`
  expects a `file:` URL with a host (a UNC path there) to construct and a
  drive-less one to be refused when the driver is made, as Windows' own
  `fileURLToPath` answers. Compiled executables are qualified on Linux only.
- [ ] **Sockets.** Waits on a Windows run of the loopback tests, where
  Winsock's smaller buffers and its resets differ from Linux:
  `test/contract/node-framework.test.js` (Fastify's slow reader, whose bound
  reads `writableHighWaterMark`, and the chunked-upload 413s that rely on the
  linger keeping an RST from eating the answer); `server-surface-quirks.test.js`
  and `binding-quirks.test.js` on `127.0.0.1`; the declared-length 413 cases in
  `test/contract/adapters.test.js` (an unfinished upload closed through the linger,
  a whole one kept alive); and `test/contract/cli.test.js`,
  which spawns `node` in a temp directory and removes it.
- [ ] **Processes and runtimes.** Waits on a Windows run with `bun.exe` on
  the path: the cross-process ledger test (`test/linq/db-ledger.test.js`)
  spawns `node --input-type=module -e` or `bun -e`, and
  `test/db/numeric-keys.test.js`, `migrate-foreign-keys`, `relational-recovery`
  and `sqlite-migration-identity-recovery` spawn `bun` when it is present, and
  `backup-worker-bun` reads `Bun.isStandaloneExecutable` inside the executable
  it compiles.
- [ ] **Links, paths and line endings.** Waits on a Windows run of the path
  and line-ending tests: `buildImportMap` compares real paths and reports URLs
  and duplicates with `/`, and `test/emit/importmap.test.js` builds its fixture
  behind a junction (no privilege needed), a short `8.3` temp path being the
  case to watch; the symbolic-link cases of `test/db/backup.test.js`,
  `snapshot-database.test.js` and `store-source.test.js` skip on `EPERM` and
  run where the privilege is held; the task documents (`test/linq/app-tasks.test.js`,
  `test/app/tasks.test.js`) and the formula corpus split their text on LF,
  which `.gitattributes` keeps, and the translator counts CRLF as one line
  break.
- [ ] **PostgreSQL from Windows.** Waits on a Windows host with a reachable
  server: `test/db/postgres-sessions.test.js` and the other server tests, whose
  timing bounds (an unrelated call under 250 ms, tracked work under 500 ms)
  assume a local one; its server-less part opens two SQLite connections to one
  file and closes a store with transactions in flight.
- [ ] **Timers, focus and input.** Waits on a Windows run with real keyboard
  and IME input: `test/app/settled.test.js` and `test/view/controlled.test.js`
  schedule with `setTimeout(…, 0)` and wait on promises, and the focus
  end-to-end test uses real keyboard input, where OS-level IME and focus
  behaviour shows. The ICU cross-check of number formatting skips unless the
  runtime's ICU is the one it was measured against.
