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

## @jarenjs/core

- [ ] **`ringSignedArea` and `ringWinding` throw an uncoded `TypeError` on a
  missing position.** `ringSignedArea([[0,0],[4,0],null,[0,4],[0,0]])` throws
  `Cannot read properties of null (reading '0')` and
  `ringWinding([null,[4,0],[4,4],[0,0]])` throws `object null is not
  iterable`, where the ring's other exported helpers answer (`pointInRing`
  false, `sphericalRingArea` `NaN`, `isRingClosed` false); a member that is
  not a position of finite numbers (`'12'`, `[null, null]`) is read as the
  numbers arithmetic makes of it, so the sign can be wrong. Their JSDoc names
  no reading of a malformed ring. Wanted: a documented malformed answer (`NaN`
  and `0`) at no cost to a well-formed ring, as the containment helpers have
  (a patch).

- [ ] **A restore that throws `undefined` is reported as a restore that
  succeeded.** `createGuardedRefiner`'s `commit` keeps the thrown value as
  `restoreError` and tests it against `undefined`, so a `restore` hook that
  throws `undefined` after a failed commit answers `{ ok: false, stage:
  'commit', errors: [<commit failure>] }` with no `restoreError` and no
  `'restore'` failure record, the answer of a restore that worked. A snapshot,
  commit or hook that throws `undefined` is reported (as `JG2002`, message
  `'undefined'`). Wanted: the restore's throw kept apart from its absence; a
  new failure record in an answer hosts read (a patch, a wrong answer made
  right).

## @jarenjs/json — JSONPath & addressing

*The current focus.* JSON Pointer (RFC 6901), the JSONPath engine
(RFC 9535, passing the complete official compliance suite), JSON Patch
(RFC 6902) and Merge Patch (RFC 7396). See
[`packages/json/ARCHITECTURE.md`](../packages/json/ARCHITECTURE.md).
- [ ] **`canonicalizeJson` and `stableKeyString` escape uncoded on a text
  longer than the host's longest string.** `canonicalizeJson([s, s])` of
  `@jarenjs/json/canonical` and `stableKeyString([s, s])` of
  `@jarenjs/json/query`, `s` a string of 2^28 characters, throw the host's own
  `RangeError` (`Invalid string length`), where `stableStringify`,
  `semanticKey` and `contentKey` of `@jarenjs/core/object` refuse the same
  value with `JO2009` (`JsonLengthError`). The refusal belongs in each writer
  (`canonicalizeJson` as a `JsonCanonicalizeError` with that code); the host's
  refusal is told from a call stack exhausted by `isPastLongestString`, which
  is internal to `@jarenjs/core`.

## @jarenjs/json — JSLT

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

- [ ] **More `xs:*` constructors and `fn:*` mappings** — the numeric, boolean and string constructors, the derived integer
  types, `cast as` / `castable as` for those types, `fn:tokenize` with a plain-text separator, `abs`, `floor`, `ceiling`,
  `round`, `round-half-to-even`, `remove`, `insert-before` and `compare` (codepoint collation) are mapped. What remains:
  `fn:format-number`, which maps onto `$format-number` but needs the QT3 runner first (it ignores the test environments'
  decimal-format declarations and has no mapping for `FODF1310`, so the scorecard would count right answers as failures);
  the date, time and duration constructors (`xs:date`, `xs:dateTime`, `xs:time`, `xs:dayTimeDuration`, ...); and, needing an engine operator first, `fn:tokenize` with a regular-expression pattern
  or flags (an I-Regexp split; the plain-text mapping probes every position, so it is quadratic in the text length and
  bounded by the sequence guards), `substring-before`/`-after` and `translate` (nothing finds a position in a string).

## @jarenjs/validate

- [ ] **A compile refusal names an embedded resource's place two ways.** The
  walks name a place by its pointer into the document
  (`#/%24defs/n/properties/a/%24id`), while a `$query`, `$recursiveRef` or
  `$dynamicRef` refusal and a reference resolved on first use name a place
  inside an embedded resource (a subschema with its own `$id`) by that
  resource's URI (`https://x.test/n#/properties/a/%24query`), and spell
  `$defs` unencoded (`https://held.test/root.json#/$defs/a/%24ref`). One
  spelling needs the compiler to carry each object's document pointer; it
  changes `docPath` (an upgrade note).
- [ ] **A compile refusing a reference of a document registered earlier names
  no place.** `addSchema({ $id: 'https://h.test/b.json', properties: { x: {
  $ref: 'https://h.test/missing.json' } } })` then `compile({ type: 'object'
  })` is refused `JK0009` without a `docPath`: the `$ref` sites are recorded
  only by the walk of the schema being compiled. Recording them at
  registration keeps a site per held placeholder on the validator.
- [ ] **`addSchema` registers a relative `$id` under its raw text.** `new
  JarenValidator().addSchema({ $id: 'sub/t.json', type: 'string' })` then
  `compile({ properties: { a: { $ref: 'sub/t.json' } } })` is refused `JK0009`
  (`https://github.com/jklarenbeek/sub/t.json#` is not held; `t.json` alike):
  the key is the `$id` as written, not resolved against the origin a compile
  resolves the reference against. Pass the key (`addSchema(schema,
  'https://…/t.json')`) or an absolute `$id`.
- [ ] **A held dialect named with an upper-case scheme or host is read as
  draft-07.** With a dialect `https://example.com/my-dialect` that extends
  2020-12 held, `{ $schema: 'HTTPS://EXAMPLE.com/my-dialect', prefixItems: [{
  type: 'string' }] }` accepts `[1]` (the lower-case spelling refuses it): the
  held meta-schema is looked up by the `$schema` text as written, in the walk,
  in `dialectDraft`, in the `$vocabulary` lookup and in `compileAsync`. The
  names json-schema.org and the Jaren dialect publish are read in any case.
- [ ] **A draft-07 plain-name `$id` as a reference target outside the
  validator.** In a draft-07 document, `definitions: { a: { $id: '#foo', type:
  'integer' } }` and `properties: { y: { $ref: '#foo' } }`: the validator
  applies it (`{ y: 1 }` true, `{ y: '1' }` false), but `compileNormalizer`
  with `coerceTypes` leaves `'1'` as sent, `@jarenjs/emit` types `y: unknown`,
  and `deriveStrictProfile` refuses `JK0104` ("resolves to no schema"):
  `collectSameDocumentAnchors` collects `$anchor` only. Collect a
  fragment-only `$id` as a plain name where the place is read under a draft
  before 2019-09.
- [ ] **The normalizer reads a plain-anchor target under the root's draft.**
  `compileNormalizer` reads the target of a `#name` reference under the
  document's root `$schema`, where the validator reads it under the nearest
  `$schema` above its place: with an undeclared root, `$defs: { S: {}, B: {
  $schema: <2020-12>, $defs: { C: { $anchor: 'c', $ref: '#/$defs/S', type:
  'integer' } } } }` and `properties: { q: { $ref: '#c' } }`, the validator
  reads `C`'s sibling `type` (`{ q: '12' }` false, `{ q: 12 }` true), but
  `coerceTypes` leaves `'12'` as sent, so the normalized value still fails;
  `@jarenjs/emit`, which reads by place as the validator does, types the input
  `q?: S & (number | string)`. Read an anchor target by the nearest `$schema`
  above it, as a pointer target is read.
- [ ] **Strict profiles of the JTLT grammar and of two schemas for one
  member.** `deriveStrictProfile` (`@jarenjs/validate/strict-profile`) carries
  a value of any shape as JSON text, a map as `{ key, value }` entries, and an
  object beside `allOf`/`anyOf`/`oneOf` distributed into its branches; every
  suite grammar and authoring profile derives except JTLT, whose segment puts
  an untyped `allOf` of several branches beside no type (`JK0103`). Still
  refused, coded: two schemas for one member where neither is an
  `enum`/`const` nor only narrows (no conjunction in the strict subset), a map
  beside declared properties, a branch that is a `$ref` or a nested union
  beside an object type, and `if`/`then`/`else`. Profile size against provider
  caps (nesting depth, total name length) is not checked.
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
- [ ] **The normalizer reads a dialect by name only** — `compileNormalizer`,
  `deriveStrictProfile` and `@jarenjs/emit` hold no meta-schemas, so a
  `$schema` naming a custom dialect is read as draft-07 there while `compile`
  reads it through the meta-schema the validator holds: under a held dialect
  `https://example.com/my-dialect` that extends 2020-12, `{ $schema:
  'https://example.com/my-dialect', $defs: { s: { type: 'object' } }, $ref:
  '#/$defs/s', properties: { a: { default: 1 } } }` applies the `$ref`'s
  siblings when it validates, and the normalizer's `useDefaults` fills nothing
  (`{}`, not `{ a: 1 }`). Handing the standalone readers the validator's
  meta-schemas is the open work.
- [ ] **A required vocabulary the validator does not implement is processed**
  — a meta-schema whose `$vocabulary` declares an unknown vocabulary `true` is
  processed with that vocabulary's keywords read as annotations, where 2020-12
  asks a validator to refuse it. Refusing it is a stricter refusal, and must
  keep admitting the Jaren dialect's query vocabulary, which this package
  implements.
- [ ] **A dynamic reference keeps instance locations on** — once a `$data`,
  `data` or `$query` reader exists anywhere in the compilation, a `$ref` is
  resolved during the compile-time scan and only a target that reaches a
  reader keeps member and item locations on; a subtree holding a `$dynamicRef`
  or `$recursiveRef`, or a `$ref` inside a subtree with an embedded `$id`,
  still extends them even when nothing it can reach reads one. Following those
  needs every `$dynamicAnchor` the compilation can enter by that name, and the
  embedded resource's base.
- [ ] **Compiling a deeply nested schema still recurses per level.** A schema
  nested 20,000 levels deep (`properties`, `items` or `allOf` chains, under
  any `$schema`) throws `RangeError` while it compiles: two passes recurse
  once per level (`#walkKeywords`, then `createValidator` →
  `compileSchemaObject` → `buildPropertyValidators`). A fixed bound that fires
  before a small host stack also refuses schemas a default host compiles
  today, so the fix is that bound plus an option to raise it (a minor), as
  `maxReferenceDepth` is, or an iterative compile. The same per-level
  recursion remains in `compileMergePatch`/`applyMergePatch` over a
  100,000-deep patch, and in `equalsDeep` (and `uniqueItems` through
  `isUniqueDeepArray`), `deepFreeze` and `semanticKey` over a 100,000-deep
  value; `equalsJson`, `stableStringify`, `createJSONPatch` and
  `createMergePatch` walk on their own stack and refuse past 10000 levels with
  `JO2001`.
- [ ] **A `v`-mode literal `pattern` is still read as a literal.** `pattern`,
  `patternProperties` keys, the `regex` format and `@jarenjs/forms`' field
  `pattern` read a string as an ECMA-262 source in Unicode mode, so `"/a/"`
  matches only text containing `/a/`; a string that is no valid Unicode-mode
  source but compiles as a `/source/flags` literal (`"/[\\p{L}--[a-z]]/v"`)
  still falls back to that literal, because it compiled before. Closing it
  refuses such a schema when it compiles (a minor), with an upgrade sentence
  that names the `v`-mode spelling.
- [ ] **`compileAsync` still asks the loader for a URI under the default
  base.** `{ $ref: 'name.json' }` in a schema without `$id`, on a validator
  whose `traverse` names no origin, asks for
  `https://github.com/jklarenbeek/name.json`; a failed load now names the base
  and both repairs (an `$id`, or `traverse: new TraverseOptions(base)`), but
  the request itself still goes out. Refusing before the load would refuse a
  loader that serves that URI, which the README teaches and which answers
  right, so it waits on a decision to change the default (a minor with an
  upgrade sentence).
- [ ] **The output formats answer in English only.** A unit carries rendered
  text, so `localizeErrors` does not reach it and the packs' `subschema` entry
  is never read. A catalog on the output path (or units that keep `msgid` and
  `params`) is a new API (a minor).
- [ ] **A disallowed member is located two ways.** `additionalProperties:
  false` places each failure at the member (`/x`), `unevaluatedProperties:
  false` at the object (`""`, the member in the message), and
  `dependentRequired` at the present member (`/a`) in collected errors and
  `basic`, at the object in `list`. One rule changes collected `instancePath`
  (an upgrade note).

## @jarenjs/view & @jarenjs/app

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

- [ ] **Settling on awaits in flight.** `app.settled()` answers when the queue
  drains; an awaiting action's effect in flight is not queued, so a server
  render or a test that dispatches one has no handle on its continuation
  (APP-FORMAT §3.3). Open: a settled form that also waits, bounded, for the
  awaits in flight.
- [ ] **The app pen writes no awaiting action.** `@jarenjs/linq/app` builds
  query actions only; an `{ "$await": … }` action (APP-FORMAT §3.3) is written
  by hand beside the pen's document. Open: a builder capturing
  `start`/`with`/`then`/`catch` over `$result` and `$error`.
- [ ] **Segmented logical scrolling past the CSS extent ceiling.** The [reusable collection](../components/collection/docs/COLLECTION.md) and [injected provider coordinator](../packages/app/docs/COLLECTION-PROVIDER.md) cover fixed/measured axes, keyed interaction and bounded page caches up to the conservative CSS extent ceiling; a source longer than that needs segmented logical scrolling. Complete sequential database snapshots and index seeks behind the provider also need an independently qualified source contract.

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

- [ ] **Canonical printing: delimiter soups.** `toMarkdown` spells a run of
  emphasis and strong by a search a stretch at a time and, where nothing it
  finds reads back, prints the block a stretch at a time, each stretch the
  canonical spelling does not read back as spelled by a guided search (sites
  in print order, the printed prefix read back after each text node), each
  search paid in proportion to what the call prints. A stretch the guided
  search does not reach within its allowance still prints canonically and
  reads back as other nodes there, as does a node no Markdown reads back as
  (an empty emphasis or strong); `toMarkdown` does not report either. Wanted:
  a spelling derived from the delimiter algorithm instead of searched for, and
  a way to report a stretch that does not read back (a new option: a minor).

## @jarenjs/mermaid

- [ ] **Flowchart statements: two silent misreads of quotes** — the inline
  edge form reads a label holding a link operator inside its quotes as two
  edges (`A -- "a --> b" --> B` is an edge `A`→`b` labelled `"a`, and `B`
  vanishes); and a `;` after an apostrophe in an unquoted label is not a
  statement separator (`A[it's] --> B; C --> D` drops `C --> D` without a
  word), because the statement splitter takes every `'` for a quote where the
  bracket reader does not. The printer never writes either form (it prints the
  pipe form and one statement per line), so only hand-written source is
  affected. Wanted: the inline reader honours a quoted label as the pipe
  reader does, and the splitter applies the bracket reader's quote rule.
- [ ] **`htmlLabels:true` — browser check** — flowchart and state labels
  render as HTML in `foreignObject` when the host passes `htmlLabels: true` (a
  diagram's config can turn them off, never on; sized and wrapped by the
  advance table; `safe: true` keeps SVG text; MERMAID-FORMAT §3, §6–7). Not
  yet checked in a browser engine: label centering, overflow past the box, and
  color under a host-linked theme in light and dark, with pan and zoom.
- [ ] **Named entity codes in labels** — flowchart and state labels decode
  Mermaid's decimal entity codes (`#9829;`) and draw markdown strings
  (MERMAID-FORMAT §4.1), but a named code (`#quot;`, `#amp;`, `#lt;`) still
  prints as written: Mermaid's table is the browser's, the WHATWG named
  references, and the only copy in this repository is the Markdown
  component's, which no other component may import. Wanted: that table hoisted
  into `@jarenjs/core`, imported by both components, and looked up for a
  non-decimal code in the label reading — a new core export, so a minor; it
  grows the mermaid bundle by the table's size.
- [ ] **Entity codes and line breaks in the other diagram types** — sequence
  messages, notes and actors, class and ER panels and gantt rows print
  Mermaid's entity codes as written (`A->>B: I #9829; you #59; ok` draws
  `#9829;` and `#59;`, Mermaid's documented way to write `;` in a message) and
  a message's `<br/>` as text. Wanted: the flowchart label reading (decimal
  codes decoded last, `<br>` a line break) at each type's measured and drawn
  text, so a message is measured and drawn in the lines it breaks into.
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

- [ ] **Entity models and durable project stores** — collection models now
  run in private workers with explicit query routing, SQL plans, live results
  and seed files. The stage's operation contract addresses collections; an
  entity-only model needs entity/query controls. Durable stores and migration
  UI also need project identity, storage ownership and a migration policy:
  the current documented lifetime is in-memory, reset on committed model or
  seed changes. Reusing the data page's shared database would break isolation.

## @jarenjs/contract

- [ ] **`diffContracts` misreads three top-level/closed member shapes for real
  members.** (a) A closed object whose `patternProperties` admits a member's
  name classes that member's removal as breaking (R5 at the input's top level,
  R6 nested) though the change widens what is accepted
  (`{properties:{m:{type:'string'}}, patternProperties:{'^m':{}},
  additionalProperties:false}` → without `m`). (b) The input's top level has
  no applicator check: under `unevaluatedProperties: false` beside an `allOf`
  that names `m`, dropping `m` is breaking R5 at the top level and R15 one
  level down. (c) At the top level a member named only in `required` on one
  side and in `properties` on the other is never schema-compared:
  `{required:['m']}` → `{properties:{m:{type:'string'}}}` (or `m: false`) is
  additive R7 `input-member-optional` alone, though older requests carrying
  `m` may be refused.
- [ ] **`diffContracts` does not read a member schema that accepts nothing
  unless it is `false`.** `m: { not: {} }` (or any unsatisfiable schema) added
  to an open input is additive R7 per the R7 row, though every request
  carrying `m` is refused; only `false` (directly or through same-document
  `$ref`s) is read as forbidding the member.

- [ ] **`diffContracts` reports a change inside `not`, `if`, `contains`, or a
  union whose variants overlap as R15 `unknown`,** so a `--fail-on breaking`
  gate alone passes a required member dropped there. `not` is anti-monotone (a
  branch narrowed widens the node) and `contains` monotone, so either could be
  classed with its direction read through; a union mixing variants a type
  tells apart with object variants a discriminator tells apart (`anyOf: [{ k:
  'a' }, { k: 'b' }, { type: 'null' }]`, flat) is disjoint but keyed by
  neither alone; a variant whose discriminator or type set grows into
  another's would need the two compared value by value. Two `allOf` conjuncts
  respelled together, and a change at a location another conjunct or the node
  itself also constrains (it would need the two intersected; a variant added
  beside the node's own `type` among them), stay R15.

## @jarenjs/linq & @jarenjs/db — the data pair

The fluent front door and the SQLite document store shipped as a pair;
what each does is its own documentation's job
([linq](../packages/linq/README.md) ·
[db](../packages/db/README.md)). What remains open:

- [ ] **On PostgreSQL a unique index over a `jsonb` column keys a JSON
  `null`.** A member whose union lists a container first (`['object',
  'string', 'null']`), or that has no type, has a `jsonb` generated column,
  which holds a JSON `null` as a value: a unique index over it refuses a
  second document with `q: null` (`JD2005`), where SQLite, whose column holds
  it as SQL `NULL`, and a member whose column holds a scalar store both, as
  two missing members are. Wanted: one answer for two nulls on both engines (a
  column or key that reads a JSON `null` as SQL `NULL`; a table change, a
  minor).
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
- [ ] **On PostgreSQL `introspect()` reads the indexes beside a unique index
  over a container-first union back as no kind.** A member whose union lists a
  container first (`['object', 'string']`) has a `jsonb` column and, beside a
  unique index over it, an index per scalar kind (`c_by_q$text`);
  `introspect()` leaves the member untyped and reports that index
  `unmapped-index`, so the model it reads back does not reopen the table
  (`JD0002`). Wanted: read those kinds back into the member's union, as for a
  scalar-first member.
- [ ] **Expression indexes on entities.** An entity declares composite,
  unique and partial indexes over its members (MODEL-FORMAT §9.2), but an
  entry with an `expression` is refused (`JD0004`, §7A): an entity table has
  no generated column to carry the expression, and SQLite maintains an index
  over a function only on a connection that registered it, so every other
  writer of the table — the raw SQL client a database rule exists for
  included — could no longer insert or delete a row. Wanted: a carrier for
  the expression on entities as a collection has one, or an expression the
  engine evaluates on every connection, with the row-predicate module's call
  nodes (§7A), open verification, the migration planner's index diff and
  introspection.
- [ ] **Database invariants over a store-owned layout, beyond its scalar
  columns.** A store-owned entity takes `enforcement: "database"` rules over
  the scalar and foreign-key columns its table maps, installed with the table
  and verified at every open (MODEL-FORMAT §13.4). Still refused (`JD0005`): a
  rule that reads an epoch member, a member the document holds or a relation;
  an `audit` or `effects`, whose trigger writes journal capture cannot see;
  and `$exists-row`, whose probe needs the target table's key columns and
  their declared types. Wanted: those. Introspection reports such a table's
  triggers as unmapped objects, so a model derived from the database neither
  reopens nor migrates to the authored one. Every PostgreSQL open reads each
  store-owned table's triggers and rewrite rules with a query per table (about
  1.2–1.5 ms each); one read per namespace would bound it.
- [ ] **Pushdown beyond the proven scalar shapes.** Group keys the schema does
  not declare as scalars alone (untyped, a union that lists an object or an
  array, reached by a negative index),
  group returns that read the grouped row binding, ordering by a floating
  sum/avg or other unproven aggregate expressions and floating numeric
  aggregates without a rounding proof still run in the engine. One-root scalar
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
  `$string-length`, `$count` and `$exists` (each over the members
  [MODEL-FORMAT §10.6](../packages/db/docs/MODEL-FORMAT.md) names), a whole
  entity binding inside a constructor or a non-singular path still needs the
  engine. So does a navigation hop that is chained, ordered inside, correlated
  across comparison families or over a column that can hold a `null`, or read
  as a value without the related entity's key. A hop over a foreign key no
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
  over comparisons, membership, existence probes keyed by a verified unique
  index and integer `$add`/`$sub`/`$neg` inside the safe-integer domain.
  Still outside: `$mul`, `$div`, `$idiv`, `$mod` and arithmetic over a
  `number` operand (the engine's double rounding and division are not SQL's);
  `$starts-with` (a code-point prefix spelling and an oracle of its own on each
  engine); an arbitrary trigger program (a `TableTrigger` stays SQLite SQL); a
  probe of the rule's own table (PostgreSQL runs row triggers at statement end
  and SQLite per row); an aggregate over other rows; and the stored-row walk of
  a migration that adds a rule (it judges no stored row today). Store-only rules
  retain their explicit writer qualification. SQLite's change test compares
  each column under its declared collation and stored spelling (§13.4), where
  PostgreSQL and the store compare by codec; comparing by code point would
  change the text of every installed update program, so it waits for a
  reviewed migration of installed programs.
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
- [ ] **An integer past 2^53 in an `integer` column answers differently on the
  two engines.** A stored integer a JavaScript number would round is refused
  `JD2003` on both where a row is read whole and, on PostgreSQL, where a
  native statement projects the member; but one the store wrote (2**53+2,
  2**60) reads back exactly on PostgreSQL (`numeric`) and is refused on SQLite
  (`INTEGER`), whose create accepts it, and on PostgreSQL an included child
  (`load({ include })`) and change capture still read a rounding one as the
  nearest double. Wanted: one answer for an integer past ±(2^53 − 1): on
  SQLite an integer a double holds exactly read as that number (each SQLite
  driver decodes the column itself — drivers/node.js, bun.js, wasm.js and the
  worker hosts), and an included child's and the capture journal's integer
  columns refused as the row read whole is (graph.js, capture.js).
- [ ] **A join table carries no column beyond its two keys.** A many-to-many
  join table is a read-only root (`$.<JoinTable>[*]`, MODEL-FORMAT §10.7)
  whose rows are its two keys, so "which pairs were attached since Friday" has
  no column to read; such a membership is an entity with two one-to-many edges
  today. Wanted: columns declared on a `through` (an attach instant at least).
  Five decisions come first: the declaration (`through` is a table name on
  either side of the edge; an object form must be declared once or
  identically); who writes a value (`link()` carries none, and the unit of
  work, the capture journal, replication documents and live join rows carry
  only the two keys; a database default such as `'now'` is the database's
  transaction time, which a replay or a capture apply on another database does
  not reproduce); what re-linking an existing pair does (an idempotent no-op
  today: keep the first value or refresh it); how `introspectModel` tells a
  join table with a third column from an entity (it reads exactly two
  foreign-key columns as one); and the migration strategy that adds or drops a
  column on a join table (none exists).
- [ ] **A non-JSON external reached through a conditional, a computed operand
  or a nested phrase is read as `{}`.** An external the engine compares or
  equates, reached through name, index, wildcard, slice, filter and descendant
  segments, through `$let`, `$for` (its window too), quantifier, grouping and
  `$fold` variables, or handed through by `$head`, `$tail`, `$reverse`,
  `$subsequence` with literal bounds, `$get` with a literal key, `$seq` or an
  array or object constructor compared whole, that holds a `Date`, a `Map` or
  another object with no own member, or a `bigint`, is refused `JD0041`
  ([MODEL-FORMAT §10.1](../packages/db/docs/MODEL-FORMAT.md)), and so is one a
  filter compares or hands to a path function on the way. One reached through
  `$if`, `$coalesce` or `$default`, through `$subsequence` or `$get` with a
  computed bound or key, through `$entries`, a nested phrase's return or a
  path into a constructor, or through a filter that reads the input document
  (`$xs[?@.k == $[0].k]`), is still compared as `{}` and matches no row. Which
  operand those hand through depends on a row or on the collection, so a
  refusal by what the external holds would refuse calls that answer right.
  Wanted: follow them where the operand they pick is decided by the externals
  alone.
- [ ] **A handle refuses a chain over one database a second store names
  differently.** A handle takes a chain over another store's view when both
  read one database (one SQLite file by its canonical path, one shared-cache
  in-memory database the Node drivers hold, one PostgreSQL address, port,
  database and schema), but one file through two hard links (which only a
  rollback journal mode opens twice) or one server through two addresses (a
  socket and TCP, IPv4 and IPv6) give the two stores different names, so the
  chain is refused `JL0005` though it would answer right. The server's
  `system_identifier` is not a fix (a standby or a restored copy carries it);
  a file needs an identity every driver reports alike ([DB-CLIENT
  §6](../packages/linq/docs/DB-CLIENT.md)).
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
- [ ] **A store predicate's external past 2^53 compares exactly with digits
  another writer spelled, in SQLite.** A store profile predicate's external
  integer past ±(2^53 − 1) binds on SQLite as the integer its own shortest
  digits spell (2^60 as `1152921504606847000`), the digits a document the
  store wrote holds for the same number, so the predicate keeps the rows the
  engine keeps over the store's own documents, in the statement a safe integer
  binds. A document another writer stored with other digits for such a number
  (`1152921504606846976`, which the engine reads as 2^60) is compared by those
  digits and kept or dropped otherwise than the engine. A document's own such
  external still runs in the engine over the whole collection. Wanted: a
  seekable double form of the comparison (the integer interval that rounds to
  the double, bound as two integers), which would also keep a document's such
  external on its index.
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
  expression term, that the PostgreSQL read-back does not read — a date or
  uuid literal the server rewrites by its type, `TRIM` (deparsed `TRIM(BOTH
  FROM …)`), a quantified comparison other than `= ANY` and `<> ALL`, `IS
  [NOT] TRUE` — is not compared, so an index recreated under another such
  condition or key opens as the declared one, where SQLite compares the CREATE
  text (MODEL-FORMAT §12). Wanted: read those forms into the condition form.

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
  open never refused, the renewal on a 3 s wall clock with 150 ms margins);
  two worker-thread stores racing `BEGIN IMMEDIATE` on one file
  (`test/db/collection-expect.test.js`, 300 rounds under the 5 s busy timeout)
  and a second `DatabaseSync` holding a writer while a store refuses options;
  keyset pages over adopted files with a malformed-UTF-8 key
  (`test/db/physical-page.test.js`) and list membership read by a second
  connection (`test/db/list-membership.test.js`,
  `test/linq/list-membership.test.js`); the migrations (`migrate-host-step`,
  `migrate-foreign-keys` with a raw second connection writing an orphan, atomic
  runs, adopted history, and the planner goldens on LF checkouts); and every
  test and README example that removes a temp directory after `close()`
  (`EBUSY`/`EPERM` when a worker's handle outlives it).
- [ ] **Worker and pool hosts.** Waits on a Windows run of the worker and
  pool tests: `test/db/relational-store.test.js` and `quirks-relational.test.js`
  (`node-worker` and a WAL `node-pool` over a temp file: the reader-lane
  assertion and the WAL sidecars); `transaction-hold`, `transaction-retry` with
  its README runner, `connection-loss` and `quirks-transactions` (100 ms holds
  near the limit); and `pool-parallel-reads` (a held read given back on close
  within 2,500 ms). A worker `endpoint` is a URL — on Windows
  `pathToFileURL(path)`, never a `C:\` path. Compiled executables are qualified
  on Linux only.
- [ ] **Sockets.** Waits on a Windows run of the loopback tests, where
  Winsock's smaller buffers and its resets differ from Linux:
  `test/contract/node-framework.test.js` (Fastify's slow reader, whose bound
  reads `writableHighWaterMark`, and the chunked-upload 413s that rely on the
  linger keeping an RST from eating the answer); `server-surface-quirks.test.js`
  and `binding-quirks.test.js` on `127.0.0.1`; and `test/contract/cli.test.js`,
  which spawns `node` in a temp directory and removes it.
- [ ] **Processes and runtimes.** Waits on a Windows run with `bun.exe` on
  the path: the cross-process ledger test (`test/linq/db-ledger.test.js`)
  spawns `node --input-type=module -e` or `bun -e`, and
  `test/db/numeric-keys.test.js` and `migrate-foreign-keys` spawn `bun` when it
  is present.
- [ ] **Links, paths and line endings.** Waits on a Windows run of the path
  and line-ending tests: `buildImportMap` compares real paths and reports URLs
  and duplicates with `/`, and `test/emit/importmap.test.js` builds its fixture
  behind a junction (no privilege needed), a short `8.3` temp path being the
  case to watch; the task documents (`test/linq/app-tasks.test.js`,
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
