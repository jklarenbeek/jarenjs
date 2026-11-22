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

- [ ] **`renderQueryMessage` has no English default for a formula id.** A formula
  diagnostic's id renders through `queryMessagesEn` only, so English needs
  `formulaMessagesEn` passed (or the diagnostic's own `message`).
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
- [ ] **JSLT compile options and transform, declared for strict consumers** —
  `compileJsltStylesheet` and `transformJson` declare their options without
  `extensions` and `functions`, though the dispatch reads both: a strict
  TypeScript consumer's `compileJsltStylesheet(sheet, registry.toOptions())`
  and `transformJson(sheet, data, {}, registry.toOptions())` fail TS2559 (no
  properties in common). `compileJsltStylesheet`'s declaration also drops
  `pathFunctions` (TS2353 on `{ pathFunctions }`; `transformJson`'s keeps it).
  The transform is declared `Function`, and so is the registry's `compile`, so
  the documented `transform.externals` and `transform.doc` are TS2339 and the
  transform fits no typed callable (TS2322). Fix in the declarations only (a
  patch): one options type naming every option the compile reads, and one
  transform type, `((data, externals?) => any) & { externals, doc }`, that
  both functions and the registry's `compile` return.

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
- [ ] **An output format that records units walks every branch in full, and
  exhausts the heap on the studio's `form` seed.** With `outputFormat` basic,
  detailed, verbose, list or hierarchical the reference answers a collecting
  walk keeps are off (the recorder hangs units under the evaluation path that
  entered them, and a kept answer gives errors only), so every `oneOf`/`anyOf`
  branch is walked again at every level: the VALID `minisite` seed takes
  90-243 MB and 0.17-0.66 s, `dashboard` 238-506 MB and 0.56-1.35 s, and
  `form`, valid or broken, runs out of a 2 GB heap, where `flagOutput` answers
  in 2-3 ms. basic, detailed and list write 108-235 KB for those valid seeds:
  their cost is the recording, and wants a kept answer that holds its unit
  subtree relative to its reference plus a projection that drops a failed
  subtree under a valid applicator before expanding it. verbose and
  hierarchical write the failed branches' units under `valid: true` by their
  own definition (65-219 MB of JSON on the valid seeds), so their size follows
  the branches. On a broken document basic writes each failing path (minisite
  one phrase down: 2,819 units, 529 distinct by location, instance and text).
  Wanted: the bounded recording for basic/detailed/list, and a decision on
  writing each distinct error once on a broken document.
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

- [ ] **Status colours as text on the page ground.** In the light theme `--ok` and
  `--warn` fall below WCAG AA (4.5:1) against `--bg`, yet both are set as text: the
  site's `.badge.ok` and the studio's warning notes (`.js-file-warn` and the
  `--warn-soft` callouts). Wanted: an audit of every place a status colour is ink,
  then darker text steps (or a `-fg` pair per status) that clear AA in both themes,
  after which those pairs join DESIGN §1's guarded pairs, which
  `test/view/tokens.test.js` checks. Changing the token values changes the site's rendering.
- [ ] **Controlled inputs under `safe: 'interactive'`.** Inputs stay
  attribute-only, so app state cannot reset a field the user edited. Wanted:
  the controlled-value path for `value`/`checked` (not `file`) under the
  interactive profile, with its serializer counterpart.
- [ ] **One id namespace per untrusted document.** `idPrefix` defaults to
  `jaren-u-` in both safe profiles; two untrusted documents on one page, or a
  host id that starts with the prefix, must be kept apart by the host passing
  its own prefix. Wanted: a check that refuses a second render with the same
  prefix into one document, or a per-render default that DOM and SSR agree on.
- [ ] **`createFormView`'s own form-chrome defaults are English.** `@jarenjs/app`
  keeps a hand copy of the add/remove/JSON-hint words because it does not depend on
  `@jarenjs/forms`, whose `formChromeLabels(catalog)` speaks every pack; a host passes
  `labels` or `labelsPath` (the website does), and a host that passes neither shows English.
Reusable host helpers now cover [bounded file tokens and route subscriptions](../packages/app/docs/APP-FORMAT.md),
the [owned native dialog](../packages/view/docs/VIEW-FORMAT.md), and
[ordinary-panel drag sources](../components/collection/docs/COLLECTION.md).
Public consumers exercise disposal, interrupted interaction and three browser
engines; the manual device and assistive-technology qualification below remains
open. [Signed Node continuations](../packages/contract/docs/CONTRACT-FORMAT.md)
bind injected host context, while [CSV formula neutralization](../packages/josl/FORMAT.md)
is an opt-in formatter policy with unchanged default bytes. SQLite
[async jobs, committed feeds and separate-file receipt replay](../packages/db/docs/HOSTS.md)
have source and isolated-package fixtures. These source capabilities do not
establish registry publication or downstream acceptance.

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

- [ ] **Canonical printing: delimiter runs neither the derivation nor the
  search reaches.** `toMarkdown` spells emphasis, strong and strikethrough
  whose canonical spelling does not read back from the delimiter rules, falls
  back to the search where that spelling does not read back, and names what
  still does not read back to `onLossy`. Some trees the reader makes are
  reached by neither and are named `'unread'` instead of reading back: literal
  `*` or `_` inside nested runs (`*\**2;_"_\*****\*_` is one), and long chains
  of nested emphasis and strong. Wanted: those spellings derived, so that
  every tree the reader makes reads back and the search can go; such content
  costs the derivation and then the search.

## @jarenjs/mermaid

- [ ] **Mermaid forms still read differently from Mermaid** — measured against
  Mermaid 11.16.1 on its own syntax-doc examples: a flowchart label holding a
  multi-line markdown string is refused as an unterminated shape; a node's
  `A@{ shape: …, label: … }` metadata is skipped rather than read into the
  node's shape and label; a class generic keeps `~T~` in the name in `class
  X~T~ {` and relation ends but not in `class X~T~` or `X : member` (Mermaid
  names all of them `X`); a lollipop's interface keeps its written name where
  Mermaid generates one; a sequence participant's `type` (boundary, database,
  …) and a message's half-arrow marks are not kept; a state transition label
  keeps a closing `;` (`A --> B : x;`, Mermaid ends the label there); `state
  X` with no `{` is read as a state (Mermaid reads none); an ER line `A o--o
  B` reads as a relationship (Mermaid: three entities) and one without `:
  label` reads (Mermaid refuses it); a flowchart link to a subgraph id prints
  a node line for the id that reads back as another tree.
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

- [ ] **The play slice's reducers are still each host's** — `@jarenjs/play/host`
  exports the slice (`PLAY_START`), its reader-language rules and the
  generated form's actions, but `play/loaded`, `play/option-set` and
  `play/loaded-session` (which write `exampleLocale` and the reader's
  language) are action documents each host writes from ARCHITECTURE's
  table. A kit builder for them would take the host's language pointer
  (the site's `/lang`) as an argument.
The engine playground behind `#/play`: pick an engine and an example, edit the
source or the data, it runs live. Membership is a rule rather than a list — an
engine belongs here iff it is a **pure function of `(source, data)`**:
stateless, no worker, no live subscription, no side channel. That is why flow
and the document store are studio file kinds instead, and why adding an engine
costs a descriptor plus examples and no UI code at all.

- [ ] **Streaming readers need a chunked source pane** — the JOSL and CSV
  stream parsers are pure, but they consume a stream rather than a string, so
  a descriptor for them first needs a source pane that means "feed this in
  chunks" — a question the `(source, data)` shape does not answer.

## @jarenjs/studio

- [ ] **The authoring gate's findings in the IDE, and one render audit.**
  `validateFile` reports `warnings` (`JS0005`) and refuses an element written
  as an object (`JS0004`), but the IDE's rail and error strip show `errors`
  only and `describe` passes no `warnings`. The website's document host keeps
  a second audit that refuses every bare object, where `validateFile` refuses
  only the element-shaped one, and the app audit renders with the built-in
  operator packs, not the host's `operators`. An object in an element's props
  position (`["ul", {"tag": "li", …}]`) is read as props and not reported.
- [ ] **Entity models and durable project stores** — collection models now
  run in private workers with explicit query routing, SQL plans, live results
  and seed files. The stage's operation contract addresses collections; an
  entity-only model needs entity/query controls. Durable stores and migration
  UI also need project identity, storage ownership and a migration policy:
  the current documented lifetime is in-memory, reset on committed model or
  seed changes. Reusing the data page's shared database would break isolation.

## @jarenjs/contract

- [ ] **The TypeScript projection's `Handlers` types a subscribe handler as its snapshot.**
  `@jarenjs/contract/project`'s `toTypeScript` writes `Handlers` as `Operations[K]['output'] | Failure`
  for every operation, so a generated table's subscribe handler is typed as the snapshot the binding
  refuses (`JC2010`); the pen's `TypedHandlerTable` answers `SubscriptionSource<output>`. Changing the
  projection changes generated text pinned byte-identically
  (`test/consumer/linq-contract-generated.ts`), a planner-like output change of its own.
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

- [ ] **A bare collection root's first item, element or existence reads every document.** Over a
  collection handle (no root of its own), `any()`, `first()`, `elementAt(n)` and
  `take(n).toArray()` push `{ $exists: '$[*]' }` and `[{ $subsequence: ['$[*]', n, k] }]`.
  The planner answers them `set`: one `SELECT` of every document, then the window or the test
  in JS. Explain reports this honestly, so the cost is unbounded but nothing is hidden. Wanted:
  the `'$[*]'` operand of a top-level `$exists` or `$subsequence` planned as the `$for` scan it
  abbreviates, as `'$[*]'` alone and `{ $count: '$[*]' }` are.
- [ ] **A backlog read from the tick backwards is not counted.** A tick whose backlog is longer than one search reads
  under the limits fires exactly what `missed` says, but counts as skipped only the occurrences of the span it read;
  `counts.uncounted` says a tick did so. Wanted: the passed occurrences counted without enumerating them.
- [ ] **The client bundle carries calendar-member plumbing without the seam.** The calendar code and the keying run
  only when a host installs `@jarenjs/db/temporals`, but the declaration's reading, its DDL and introspection terms and
  its refusals ship in every store client, about 11 KB of the client bundle that a store declaring no calendar member
  never runs. Wanted: the declaration read behind the seam too, so a store without it keeps only the refusal.
- [ ] **A CHECK the model does not declare is read back as a declaration where
  the format has one.** On PostgreSQL a CHECK of someone else's opens, still
  refuses the writes it governs (`JD2005`) and is an `unmapped-constraint`
  line of `introspect()` on a collection, an entity and a join table alike,
  where SQLite's CREATE-text comparison answers `JD0002`; but one of a shape
  the model format declares — an enum over an entity column, an interval over
  a collection — is read into `introspect()`'s derived model rather than
  reported, and `jaren-db plan --store` reaches SQLite alone. Wanted:
  `store.introspect()` naming each CHECK its own model does not declare.
- [ ] **A unique index over a document whose member holds a kind its schema
  does not list answers differently on the two engines.** The store does not
  validate a member against its declared types by default: under a unique
  `$.q` over `['number', 'string']` two documents with `q: true` (or two equal
  objects) are both stored on PostgreSQL, whose indexes key only the kinds the
  union lists, and the second is refused on SQLite, whose untyped column keys
  every kind. Wanted: a decision — key every kind on PostgreSQL (an index per
  kind beside every unique union index: a minor and an insert cost), or state
  the unvalidated-document boundary for uniqueness as for queries.
- [ ] **On PostgreSQL an index refuses a key past the B-tree's entry limit.**
  A declared index over a member is a B-tree keying the value whole, unique or
  not, so a document whose member is past PostgreSQL's B-tree entry limit (a
  long string, a large object or array) is refused `JD2005` (`class: 'error'`,
  the server's message), though it duplicates nothing, where SQLite stores it.
  An exclusion constraint over a hash index holds a value of any size exactly,
  but serves equality alone: a range, an ordering or keyset pagination over a
  unique member would read every row; and a hash index keys one column, so a
  composite one needs an immutable expression that combines its members
  (`ROW(...)` and `jsonb_build_array(...)` are refused). Wanted: a decision —
  keep the stated limit, or a design that keeps both (an exclusion constraint
  for uniqueness beside a B-tree over a bounded prefix that range and ordering
  seeks read with an exact recheck; a plan change, a minor).
- [ ] **Replication over an entity expression index.** Replication orders an
  envelope's writes by unique columns, never by an expression index's key
  ([MODEL-FORMAT §7A](../packages/db/docs/MODEL-FORMAT.md)): a value the
  host's function folds together, taken by one write before another releases
  it, refuses `JD2005` where a plain unique column applies. Wanted: the slot
  keyed by the declaration's `apply`.
- [ ] **Database invariants over a store-owned layout, beyond its scalar
  columns.** A store-owned entity takes `enforcement: "database"` rules over
  the scalar and foreign-key columns its table maps, `$exists-row` probes of
  another table among them (a rule about a related row probes it by its
  foreign-key column), installed with the table and verified at every open
  (MODEL-FORMAT §13.4). Still refused (`JD0005`): a rule that reads an epoch
  member, whose column holds milliseconds while the rule compares the member's
  text, or a member the document holds; and an `audit` or `effects`, whose
  trigger writes journal capture cannot see. Wanted: those — the epoch member
  needs the text it reads back rebuilt from milliseconds in SQL on both
  engines, the document member a JSON read inside the trigger with the
  engine's missing/null/type semantics, each with an oracle of its own.
  Introspection reports such a table's rule programs as unmapped objects, so a
  model derived from the database neither reopens nor migrates to the
  authored one: no reader turns the store's own installed program back into
  its rule (an application's hand-written SQLite triggers are read back as the
  rules they equal with the `triggers` option of `@jarenjs/db/trigger-rules`,
  MODEL-FORMAT §13.6).
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
- [ ] **Pushdown beyond the proven scalar shapes.** Group keys the schema does
  not declare as scalars alone (untyped, a union that lists an object or an
  array, reached by a negative index),
  group returns that read the grouped row binding, ordering by a floating
  sum/avg or other unproven aggregate expressions and floating numeric
  aggregates without a rounding proof still run in the engine (SQLite's sum
  compensates its rounding and PostgreSQL's numeric sum is exact, so neither
  repeats the engine's left-to-right double addition; a guard that every term
  is integral would answer exactly but send fractional data, the common case,
  through a second statement). One-root scalar
  grouping, guarded integer sums/counts, groups ordered by an integer sum/avg
  and, on SQLite, the unordered grouping of a connected join of roots now have
  native plans; over a join of roots an ordered grouping, a window over its
  groups, the nullable form of a sum and a return that reads a whole binding
  still run in the engine (tied groups would order by the first row's number,
  with a proof per ordering shape). A window over a group return that can omit
  an item needs an output-cardinality proof, and a window over groups ordered
  by an integer sum/avg needs the exactness guard read on every group, not only
  on the returned ones (`plan.windowedAccumulation`); the proven singleton
  constructors already lower. A grouping over a compound physical key whose
  order leaves two groups tied runs in the engine (`entity.groupOrder`): a
  group's first appearance is its smallest key tuple, which per-column minima
  do not give. On PostgreSQL an entity grouping lowers only over one adopted
  table with no document column; a store-owned table and any join plan the set
  residual (`bind.entityGrouping`) until the runtime guards are qualified
  there. A comparison of two paths when either is not typed as a scalar (an
  object, an array, a member with no type), an entity query's comparison of two
  paths outside one non-null number/string family, predicates whose individual
  leaves span bindings, and unlisted operators remain residual. **Semantic
  boundary:** promotions must preserve missing/null, first-occurrence order and
  engine errors under the indexed, unindexed and forced-residual oracle. A
  disconnected binding graph remains a deliberate cartesian-product refusal;
  removing that guard changes the join contract. A join equality is an edge
  only between mapped columns of one comparison family (the family the column
  stores and the engine decodes, never a union's first type) that are neither a
  boolean nor both able to read a NULL as a present `null`, so the database
  pairs the rows the engine does; an undeclared foreign key compares as the key
  it references, a nullable member whose NULL reads back as no member (every
  store-owned nullable column) still joins natively, and any other equality
  runs in the engine.
- [ ] **Projection and distinct beyond reconstructible trees.** A return
  containing an operator beyond `$default`, `$upper`, `$lower`,
  `$string-length`, `$count`, `$exists`, `$concat`, `$add`, `$sub`, `$mul` and
  `$div` (each over the members and literals
  [MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md) names; `$idiv` and
  `$mod` raise on a zero divisor, and an operator over an operator is not
  proven), a whole entity binding inside a constructor or a non-singular path
  still needs the engine. So does a navigation hop that is chained, ordered inside, correlated
  across comparison families or over a column that can hold a `null`,
  correlated by inequalities alone or by an inequality outside an existence or
  emptiness test (a count, a comparison of its member, an order key or a
  projection leaf), or read as a value without the related entity's key. A hop over a foreign key no
  property declares stays in the engine although a join reads that key
  (`entity.hopShape`). Windows over such returns are set-residual: source-row
  limits cannot stand in for projected-item limits, and the engine evaluates
  the return of every row, so a window or a count may leave a row unevaluated
  only where the evaluation cannot raise. Over an object or array constructor
  of those operators a collection's window rides in the statement (`row`) and
  a count is a `COUNT(*)`, on a collection and on an entity; an entity window
  over an operator projection (the entity planner has no row residual; a
  per-row evaluation of the constructor over the fetched window would lower
  it), a collection's window or count beside a conjunct that runs as a
  registered function, and a bare operator as the whole return (always one
  item per row, but no constructor) are still the engine's. `$distinct` still
  runs in the engine over a leaf that may hold an object or an array (an
  untyped member, a union that lists either, a path reached by a negative
  index: the database groups an object by its text, which keeps member order,
  where the engine compares members), an array constructor, an operator, the
  document, a constructor or an ordering by other paths beside a registered
  function, and, on an entity, a distinct with an ordering of its own (numbering
  the entity rows by the order terms would lower it) or over a document member,
  an epoch or a date column (`plan.distinctProjection`, `entity.distinct`).
  **Proof still needed:** preserve output cardinality, structural equality,
  ordering and errors, and never drop a member a residual predicate reads.

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
  Relation navigation across physical layouts, a PostgreSQL page's `ORDER BY`
  read in index order (it spells `NULLS FIRST`, so the rows past the row value
  are sorted: about 14 ms for the second page of 200,000 rows against 0.016 ms
  read in index order), pushdown beyond the qualified native census and
  additional PostgreSQL types remain open. A partition attached to an adopted
  partitioned table while a store is open reports a duplicate key as `JD2005`
  naming its own constraint until the next open; the catalog read cannot
  follow it without a read on the failure path, which an aborted PostgreSQL
  transaction forbids. Capture and replication of adopted physical tables —
  whose application triggers and cascades the store does not write — remain
  refused until their complete writer population has an executable oracle.
- [ ] **Broader database invariant lowering.** Rules lower to verified triggers
  on SQLite and PostgreSQL alike ([MODEL-FORMAT §13](../packages/db/docs/MODEL-FORMAT.md#13-persistence-invariants)),
  over comparisons, membership, existence probes keyed by a verified key or
  index and integer `$add`/`$sub`/`$neg` inside the safe-integer domain.
  Still outside: `$mul`, `$div`, `$idiv`, `$mod` and arithmetic over a
  `number` operand (the engine's double rounding and division are not SQL's);
  `$starts-with` (a code-point prefix spelling and an oracle of its own on each
  engine); and the stored-row walk of a migration that adds a rule (it judges
  no stored row today). Store-only rules retain their explicit writer
  qualification. SQLite's change test compares each column under its declared
  collation and stored spelling (§13.4), where PostgreSQL and the store compare
  by codec; comparing by code point would change the text of every installed
  update program, so it waits for a reviewed migration of installed programs.
- [ ] **An open's per-table catalog reads.** Opening verifies each table the
  store owns, and each table a physical entity maps, with catalog reads of its
  own — existence, columns, indexes and their columns, foreign keys, checks —
  so its statements grow with its tables, each a round trip on PostgreSQL and
  on the worker, pool and process hosts; the namespace's table list, objects
  and catalog rows, and on PostgreSQL its rule programs and rewrite rules,
  already come from one read per open. One read of the namespace for each
  per-table read would bound an open of many tables.
- [ ] **A linq transaction's records grow with the model's names.** A
  transaction client defines one getter per declared entity and collection
  name on its two records, so a transaction whose body touches one handle
  still pays for every name the model declares; a record shared per client
  until a transaction first reads a handle would make that cost constant.
- [ ] **A validated linq open takes every entity's store handle.** So that a
  schema the compiler refuses is refused at open, `open()` builds each
  entity's store-level handle (and compiles each collection schema) when it
  opens; a compile-only check of the entity write schemas would keep the
  refusal without the handles.
- [ ] **The job tables' and the change log's first-open bracket.** An open
  with `jobs: true` or `capture` creates or verifies its job tables and its
  change log under `BEGIN IMMEDIATE` on every open, so another connection's
  write waits for those statements even when every table exists, where the
  model's own tables are verified holding no write lock. Verifying them first
  under the read, and taking the bracket only to create or upgrade one, would
  leave the writer free for the whole open.
- [ ] **A migration's target validation reads the whole schema once per
  physical entity.** `validateTargetState` verifies each physical entity of the
  target model against a read of the whole database, so its catalog statements
  grow with entities × tables, as an open's did; the open's one read of the
  namespace would bound it.
- [ ] **Broader native authoring for legacy SQL.** The executable census now
  proves five adopted-column read families and three SQLite mutation families
  ([native contracts](../packages/db/docs/NATIVE-PLANS.md)). Receipt history
  retains SQL because its table has no declared primary key. The explicit SQLite surface now supports correlated/computed selections,
  cross-table insert-select and partial/expression conflicts. Entity `mutate`
  also admits adopted PostgreSQL column layouts, but the frozen census, its
  parity, no-op and rollback proofs and the benchmark are SQLite-only: the same
  three families on PostgreSQL, with PostgreSQL reference SQL, remain open, as
  do promotions into the JSON query semantic contract and store-invariant bulk
  preimages. Additional promotions need retained SQL/decoded-row parity, no-op
  and rollback proofs, and explicit work costs; fluent syntax alone is not
  evidence.
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
- [ ] **PostgreSQL entity changes beyond an unreferenced table.** A change
  the planner expresses as a rebuild (a key declaration, an `enum`, a type, a
  relation) rebuilds the table on PostgreSQL under a table lock, which holds for
  an entity no foreign key references, its own included: a referenced or
  self-referencing entity is refused at the drop (`JD0023`, naming what depends
  on it) and the link rolls back whole
  ([MIGRATION-FORMAT §10](../packages/db/docs/MIGRATION-FORMAT.md)). A rename
  of a referenced entity plans such a rebuild for every table that references
  it, so a rename alone is refused when one of those is itself referenced. Wanted:
  foreign keys re-pointed through the rebuild, or in-place `ALTER`s where
  PostgreSQL has them.
- [ ] **A rebuild that spells a number as text can end in another last digit
  on SQLite, and keeps the cast for a referenced key.** A number retyped into
  text is copied as `String()` spells it on both engines, except that on
  SQLite a number whose shortest spelling takes 16 or 17 significant digits
  can end in the neighbour of `String()`'s last digit (the text reads back as
  the same number): the copy chooses among the candidates that read back the
  one SQLite's own formatter rounds to, and that formatter rounds from an
  inexact decimal of its own. An exact choice needs the double's exact decimal
  in SQL (multi-precision per value) or a registered function, which a
  migration document cannot rely on (`bun:sqlite` registers none). A key
  another table's foreign key references, with the column that references it,
  keeps the engine's cast (`5.0` on SQLite) so the reference matches while one
  table is rebuilt and the other not yet; for the same reason a text led or
  trailed by a blank only `Number()` trims (a no-break space) is refused there
  when retyped into a number. Wanted: exact last digits on SQLite, and a
  referenced key spelled and read as `String()` and `Number()` do (the
  referencing table rebuilt ahead of the key's check, or the check taken after
  both).
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
- [ ] **A PostgreSQL statement at the term bound can still compile for
  seconds.** One statement carries at most 128 predicate terms
  ([POSTGRESQL](../packages/db/docs/POSTGRESQL.md)); a leaf is one term, an
  inequality or a negated comparison against an external operand on a document
  member counts four, and a member's membership in an external list counts
  sixteen (four in its own column, eight there under a `$not`), so the
  external chains that compiled for many seconds are the engine's. A statement
  the server's cost model sends through JIT is still compiled by LLVM, which
  no signal interrupts. A conjunction's `$ne` literals over one member are
  spelled as one negated list, whose compile does not grow with its length,
  but still count one term each; what remains is the weights of the other leaf
  kinds — an `$or` of `$and` pairs and an external `$ne` compile per leaf and
  grow with the count — and whether the regrouped chain should count one term.
- [ ] **A mandatory predicate past the term bound still reaches PostgreSQL
  whole.** A profile's mandatory predicate with more leaves than the dialect's
  term bound demotes the document, and the residual's root fetch carries the
  whole predicate (a 200-leaf statement is sent; it answers right and
  `maxRows`, `strict` and `refuseFullScan` still bound it). Its `$ne` literals
  over one member reach the server as one negated list, so a chain of them
  compiles in a time that does not grow with its length; other leaf kinds
  still compile per leaf under JIT and grow with the count — an `$or` of
  tenant/level pairs, and `$ne` against externals. A refusal (`JD0011`) was
  tried and rejected: profiles of 33 external `$ne` terms or 65 tenant/level
  pairs answered right and would stop opening. Wanted: a cheaper spelling of
  those leaves (a row-value membership for pairs, one external list for
  external `$ne`), or a weight for the fetch in the style of the
  external-operand weights.
- [ ] **On PostgreSQL a comparison of another kind of a union member seeks no
  non-unique composite or conditional index, and no non-unique index over a
  path with a guarded step.** A declared single-path index over a member of
  several scalar kinds has an index beside it per other kind (`c_by_q$text`)
  over the document read that comparison spells, and so does every unique
  index (composite, conditional or guarded, which needs them to refuse a
  duplicate of each kind), so it seeks; a non-unique composite (`['$.q',
  '$.k']`) or conditional index over such a member, and a non-unique index
  over a path whose step the dialect guards (`$.u[0]` under an open container
  with `items: { type: ['number', 'string'] }`), has none, and that comparison
  reads every row. Wanted: the same index beside those (for a guarded path,
  under each spelling of the guard the table may hold).
- [ ] **On PostgreSQL an ordering over an indexed collection member is sorted,
  never read in index order.** The statement orders `ASC NULLS FIRST` beside
  `"rid"`, which an ascending B-tree index does not provide (`Sort` over `Seq
  Scan`), so an `$orderby` sorts every matching row however few a page or a
  narrow `$where` returns. Wanted: an index whose null placement the order
  reads, or an order whose null placement the index provides.
- [ ] **On PostgreSQL a load's order and a page's continuation read a
  `numeric` key without the store's key CHECK bare.** A table an earlier
  release created holds a writer's digits until `planColumnUpgrade` adds the
  CHECK: a literal, a literal list and an external list compare with its key
  by the interval of decimals that round to the number's double, and a join, a
  hop's correlation, two references in one row and a query's ordering compare
  it as the doubles the engine holds, but a load's `orderBy` and a page's
  keyset continuation read it bare, so a post another writer re-keyed
  `5.99999999999999999999` orders apart from post 6, and the continuation
  after it (`pid > 6`) never pages post 6. At or past 2^53 the CHECK leaves a
  writer's digits their own, so a pair and an ordering compare such a key
  exactly where another writer may have spelled it otherwise. Wanted: the
  load's order term read as the double, with a unique tie-break its
  continuation carries (the row's stored digits).
- [ ] **On PostgreSQL an entity's ordering over a column that may hold NULL
  never reads an index.** A term over a reference or an indexed column is `ASC
  NULLS FIRST` (descending `DESC NULLS LAST`), the engine's empty-first
  placement, which a default B-tree does not give, so a window, a load's
  `orderBy` and a keyset page over it sort every row (a key and a column the
  catalog declares `NOT NULL` read their index). Wanted: indexes the store
  creates declared `NULLS FIRST` (a DDL change: the previous release reads
  such an index as not plain), measured; an ascending scan still reads the
  whole null group first. A non-key `number`/`integer` column orders by the
  double and needs an expression index besides.
- [ ] **On PostgreSQL a collection's external list never seeks.** A membership
  in an external list reads a text branch beside the number branch (`OR`),
  which reads the document, so the statement scans even where the number
  branch ranges over an index; a typed `number` member's external comparison
  reads `to_jsonb(column)` and scans too.
- [ ] **On PostgreSQL a join's equality over two non-key number columns no
  longer seeks.** It reads both columns as the doubles (bounded by ranges of
  each around the other), which the planner cannot estimate, so it hashes or
  merges on the doubles where it seeked the bare column's index. Wanted: an
  index the doubles' equality uses (an expression index over the double),
  measured.
- [ ] **On SQLite an empty window over an indexed `integer` member the schema
  does not bound is read twice, and a read of every row is sorted.** The order
  key reads the double (`CAST("gx_v" AS REAL)`) so two spellings of one double
  past 2^53 tie as the engine's do. A window with a limit reads the column
  bare, in index order, behind a probe in its own LIMIT (the column's MIN and
  MAX past ±(2^53 − 1) leave no row), and an empty answer is read again
  ordered by the double: a window that holds no row, and every window over
  rows that hold such an integer, costs both statements, the first a whole
  index walk where no index serves the filter. A read of every row sorts.
  Wanted: a statement that tells an empty answer from a probe that found such
  an integer (a sentinel row whose order SQLite keeps), or an index over the
  double, measured.
- [ ] **On PostgreSQL a column that reads a NULL as a present `null` is read
  in the engine.** No column whose policy is `null: 'null'` is read natively
  on PostgreSQL (`nativeQuery` is false for it), so a grouping ordered by such
  a key, and a grouped sum, mean or extreme over one, run in the engine there,
  where SQLite runs them in SQL beside a guard that raises the engine's
  `JQ2005` or `JQ2001`. Wanted: qualify such a column on PostgreSQL, with the
  same guards.
- [ ] **A native grouping in the engine's order of first appearance cannot
  know its group count.** A native `$distinct` or `$groupby` whose order does
  not name every key groups every row it reads and then sorts the groups by
  their first row: with nearly as many groups as rows it does the engine's
  work and that sort besides and is slower than the engine, more so on
  PostgreSQL, whose client also reads one row per group through the cursor,
  than on SQLite. A grouping ordered by every key needs no such sort
  (NATIVE-PLANS). Wanted: a cost signal that costs the answering path no
  second round trip — a distinct-count estimate the planner holds without a
  catalog read, or a bounded-group run-time fallback that does not run both
  plans.
- [ ] **PostgreSQL verifies a layout index condition or expression key it
  cannot read back by shape.** A layout index's condition, or the key under an
  expression term, that the PostgreSQL read-back does not read — a timestamp
  literal, a date a session under another `DateStyle` writes, a function
  outside the relational vocabulary, a quantified comparison over anything but
  a list of non-NULL literals — is not compared, so an index recreated under
  another such condition or key opens as the declared one, where SQLite
  compares the CREATE text (MODEL-FORMAT §12); `introspect()` reports such an
  index (`unmapped-index`). Wanted: read those forms into the condition form.
- [ ] **A locking probe's refusal under row-level security reads as the
  rule's.** On PostgreSQL a probe that locks the row it finds reads it
  through the table's UPDATE policy as well as its SELECT policy, so for a
  writer whose UPDATE policy is narrower a row it may read but not lock is
  missed, and the write is refused in the rule's name (`JD2096`, `jaren
  invariant:<rule>`) though the row exists (MODEL-FORMAT §13.3). Wanted:
  where a locked read finds nothing and an unlocked one finds the row, a
  distinct coded refusal that names the policy (the writer may read the row
  but not lock it) instead of the rule's message.
- [ ] **PostgreSQL migrationStatus compares only rule programs.** On
  PostgreSQL, migrationStatus(…, { model }) and plan --store's comparison read
  the rule programs of each ruled store-owned entity table as the open does
  (MIGRATION-FORMAT §12), and acceptance verifies join tables and collections
  too, but status compares no column, index, or undeclared trigger of a table,
  where SQLite compares every stored CREATE text. Wanted: status reads every
  table the model owns as the open verifies it.
- [ ] **A ruled update reads its row `FOR UPDATE`, which a probe's
  `FOR KEY SHARE` holds up.** The store's update of a row a store rule
  judges reads it `FOR UPDATE` (MODEL-FORMAT §13.3), so it waits for every
  open transaction whose probe found that row by key columns, and two
  transactions that each probe a row and then update it through a ruled
  update deadlock (one fails `JD2005`), where `FOR NO KEY UPDATE` — the lock
  the `UPDATE` itself takes when it changes no key column — would let both
  through, as PostgreSQL's foreign keys do. Wanted: that read locks
  `FOR NO KEY UPDATE` when the update assigns no key column.
- [ ] **A count or a reversal over an entity window stays the engine's under
  strict execution.** `take(n).count()`, `skip(n).count()` and
  `select(f).take(n).count()` emit `{ $count: { $subsequence: ... } }`, and
  `last()` a `$reverse` over the entity phrase; the planner leaves both to the
  engine, so strict execution refuses them (`JD0010`, 'op') while the residual
  answers.

- [ ] **A join's inner side refuses the entity handle it accepts once filtered.** `A.join(P, …)`
  is `JL0005` ("join takes another async sequence over a provider … as its inner side") while
  `A.join(P.where(…), …)` is accepted and `A.join(fromAsync(P), …)` is the native spelling; the
  handle could be read as `fromAsync(P)` ([DB-CLIENT §6](../packages/linq/docs/DB-CLIENT.md)).

## @jarenjs/josl

- [ ] **A CSV dialect with `quote: null` does not round-trip.** The writers
  read `quote: null` as the default `"` and the reader reads it as no quoting,
  so `parseCsv(stringifyCsv([['x,y']], { quote: null }), { quote: null })`
  answers `[['"x', 'y"']]`. Both meanings are documented and answer that way
  today. Wanted: one meaning of `null` on both sides, or a refusal of `null`
  on the side that cannot honour it.

## @jarenjs/locales

- [ ] **The uncataloged-text guard trusts a catalog's English.** A literal equal to an
  existing English catalog value passes `test/locales/uncataloged.test.js`; a
  rendered-surface test is the only catch for a copy typed back into a view.

## @jarenjs/core

- [ ] **String helpers that answer for a non-string.** `countCodePoints(5)` and
  `countCharCode(5, 48)` answer 0, `toCodePoints(5)` answers `[]`, and `fnv1a(5)` equals
  `fnv1a('')` (so `hashContent({})` is `hashContent('')`), each because a non-string's missing
  `length` ends the loop at once. `utf8ByteLength` now refuses such input with a named
  `TypeError`; these siblings should follow once each caller is audited as that one was.
- [ ] **One SHA-256 in the lexical db source.** `packages/db/src/search.js` hashes its canonical
  source with its own `crypto.subtle.digest` and hex loop; `sha256Hex` answers the same digest.
- [ ] **A frozen subtree inside a fresh tuple still walks.** `semanticKey` remembers the key of a
  wholly frozen root, but a key built per call over it (`[document, dialect, strict]`) is a new
  root and walks the whole document. Joining a remembered subtree's key inside a walk would make
  that case cheap too; it needs the depth bound to count the joined subtree's height, as the
  shared-subtree form does.

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
- [ ] **On PostgreSQL a claim can land inside a lease-less effect decision.**
  `reconcile(id, legId, revision, null, decision)` reads the plan's job in the
  transaction that moves the effect record's revision and refuses while it is
  leased. On SQLite that transaction keeps a claim out until it commits; on
  PostgreSQL the claim is one `UPDATE … FOR UPDATE SKIP LOCKED` outside the
  store's writer lock and the job read takes no row lock, so another store can
  claim the job between the read and the commit, and the decision lands while
  the job is leased. The moved revision refuses that claimant's next write made
  with the revision it read before (`JL2009`), so nothing is written wrongly;
  the rule that the lease holder decides while the job is leased is what
  lapses. Wanted: a row-locked job read on the transaction's `jobs` view
  (`SELECT … FOR UPDATE`, as `assertLease` takes) for the lease-less decision.

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
