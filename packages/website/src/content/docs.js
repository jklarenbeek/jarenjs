//@ts-check
/**
 * The documentation — a content document. Each section's `blocks` are
 * kind-tagged render nodes (lib/nodes.js vocabulary) rendered by the
 * generic 'ui' rules; editing the docs means editing JSON, and an LLM
 * constrained to the vnode/kind schemas could write these pages.
 */

import { p, code, callout } from '../lib/nodes.js';

export const DOCS_SECTIONS = [
  {
    id: 'installation', title: 'Installation',
    blocks: [
      p('Every package is published on npm under the @jarenjs scope, zero-dependency and ESM. Install what you need — the validator pulls in nothing you do not ask for.'),
      code(null, 'npm install @jarenjs/validate\nnpm install @jarenjs/formats   # format keyword validators\nnpm install @jarenjs/json      # pointer, path, patch, query, JSLT\nnpm install @jarenjs/forms     # schema-driven forms\nnpm install @jarenjs/view @jarenjs/app  # UIs as JSON documents'),
      p('Node 24 or newer (the engines field every package publishes); browsers via any bundler. No eval, no new Function: everything is CSP-safe by construction.'),
    ],
  },
  {
    id: 'quick-start', title: 'Quick start',
    blocks: [
      p('Compile a schema once, validate as often as you like. Compilation does all the deciding; validation runs a specialized closure.'),
      code(null, "import { JarenValidator } from '@jarenjs/validate';\n\nconst jaren = new JarenValidator();\nconst validate = jaren.compile({\n  type: 'object',\n  properties: {\n    name: { type: 'string' },\n    age: { type: 'integer', minimum: 0 },\n  },\n  required: ['name'],\n});\n\nvalidate({ name: 'John', age: 30 });  // true\nvalidate({ age: -5 });                // false"),
    ],
  },
  {
    id: 'validation-options', title: 'Validation options',
    blocks: [
      p('The validator constructor takes the operational switches: collectErrors gathers every failure instead of stopping at the first; skipErrors: false makes the compiled function return { valid, errors }; formatAssertion controls whether the format keyword asserts or only annotates.'),
      code(null, "const jaren = new JarenValidator({\n  skipErrors: false,\n  collectErrors: true,\n  formatAssertion: true,\n});\nconst validate = jaren.compile(schema);\nconst { valid, errors } = validate(data);"),
    ],
  },
  {
    id: 'error-handling', title: 'Errors & i18n',
    blocks: [
      p('Every error is structured: instancePath, keyword, a stable msgid and raw params — human text renders at report time through a message catalog, so switching language never re-validates. @jarenjs/locales ships packs for Dutch, French, Spanish, Portuguese, German, Japanese, Korean, Traditional Chinese (Taiwan), Russian, Turkish and Arabic; the locale switcher on Play’s result card runs exactly this mechanism.'),
      code(null, "import { compileMessageCatalog, localizeErrors } from '@jarenjs/validate';\nimport { fr } from '@jarenjs/locales';  // nl, fr, es, pt, de, ja, ko, zhTW, ru, tr, ar\n\nconst catalog = compileMessageCatalog(fr);\nlocalizeErrors(result.errors, catalog);  // the same errors, French text"),
      callout('Schema-authored messages', 'The errorMessage keyword and its $msgid form keep even schema-authored texts translatable — see ERROR-MESSAGES.md in the validate package.'),
    ],
  },
  {
    id: 'refs', title: 'External schemas & $ref',
    blocks: [
      p('Register schemas by $id and reference them; bundled meta-schemas (@jarenjs/refs) make draft detection and $vocabulary work offline. Dynamic references and per-document draft handling are spec-compliant.'),
      code(null, "jaren.addSchema({ $id: 'https://example.com/address.json', type: 'object', properties: { city: { type: 'string' } } });\nconst validate = jaren.compile({\n  type: 'object',\n  properties: { address: { $ref: 'https://example.com/address.json' } },\n});"),
    ],
  },
  {
    id: 'query-keyword', title: 'The $query keyword',
    blocks: [
      p('Cross-field assertions — sums, date ordering, quantification — inside the schema itself: the $query extension keyword embeds a Jaren JSON Query as an assertion over the whole instance. This is the class of constraint JSON Schema is notoriously bad at.'),
      code(null, '{ "type": "object",\n  "properties": {\n    "lines": { "type": "array", "items": { "type": "number" } },\n    "total": { "type": "number" }\n  },\n  "$query": { "$eq": ["$.total", { "$sum": "$.lines[*]" }] } }'),
    ],
  },
  {
    id: 'draft-support', title: 'Draft support',
    blocks: [
      p('draft-06, draft-07, 2019-09 and 2020-12 are supported — including annotation-driven unevaluatedProperties/unevaluatedItems, $dynamicRef/$dynamicAnchor and $vocabulary processing. The official test suite is scored on every benchmarked draft, optional format suites included, and each engine is counted over the tests it could run — so a case the rival cannot compile still counts here.'),
      // the scorecard is the generated run, not a transcription of it:
      // the derivation boundary fills this block from the same suite
      // file the Benchmarks page reads
      { kind: 'measured', suite: 'validate' },
    ],
  },
  {
    id: 'json-pointer', title: 'JSON Pointer',
    blocks: [
      p('RFC 6901 as compiled, zero-allocation getters — plus relative JSON Pointers, the $data hot path. A miss returns the JSONPOINTER_NOTHING sentinel, never a throw.'),
      code(null, "import { compileJSONPointer } from '@jarenjs/json/pointer';\nconst get = compileJSONPointer('/limits/min');\nget({ limits: { min: 2 } });  // 2"),
    ],
  },
  {
    id: 'json-patch', title: 'JSON Patch & Merge Patch',
    blocks: [
      p('RFC 6902 and RFC 7396 as copy-on-write appliers: the input is never mutated, untouched subtrees are shared by reference, application is atomic, and the changes option turns the engine into a change feed of written paths.'),
      code(null, "import { compileJSONPatch } from '@jarenjs/json/patch';\nconst apply = compileJSONPatch([\n  { op: 'replace', path: '/user/name', value: 'Bob' },\n], { changes: true });\nconst { doc, changes } = apply(document);\n// changes: ['/user/name']"),
    ],
  },
  {
    id: 'json-write', title: 'Write operations',
    blocks: [
      p('Compiled setters, inserters and removers for both pointer and JSONPath targets: a singular pointer writes one location; a JSONPath target writes every match. All copy-on-write with the same sharing guarantees as patch.'),
      code(null, "import { compileJSONPathSetter } from '@jarenjs/json/write';\nconst discount = compileJSONPathSetter('$.store.book[?@.price > 20].price');\nconst next = discount(doc, (old) => old * 0.9);"),
    ],
  },
  {
    id: 'jsonpath', title: 'JSONPath',
    blocks: [
      p('The complete RFC 9535 grammar as a compiler — all 703 tests of the official compliance suite pass, normalized paths included. Compiled queries expose .nodes(data) returning { path, value } pairs.'),
      code(null, "import { compileJSONPath } from '@jarenjs/json';\nconst query = compileJSONPath('$.store.book[?@.price < 10].title');\nquery.nodes(data);  // [{ path: \"$['store']['book'][0]['title']\", value: '...' }]"),
    ],
  },
  {
    id: 'json-query', title: 'JSON Query',
    blocks: [
      p('XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, a 93-operator library extensible with host operator packs (see JSLT stylesheets, below) — as JSON documents with JSONPath leaves. The grammar is published as JSON Schema, so a constrained decoder cannot emit an invalid query.'),
      code(null, '{ "$for": { "b": "$.store.book[*]" },\n  "$where": { "$lt": ["$b.price", 10] },\n  "$orderby": ["$b.price"],\n  "$return": { "title": "$b.title", "price": "$b.price" } }'),
      p('A $fold clause turns the same phrase into a reduction: the accumulator is a binding, not a lambda, so the language gets folds, running totals and runtime pointer walks without the JSON encoding ever needing to spell a function value. Extended $for bindings cover the rest of XQuery iteration — $allowing-empty for outer joins, and tumbling or sliding windows for moving aggregates.'),
      code(null, '{ "$fold": { "total": 0 },\n  "$for": { "b": "$.store.book[*]" },\n  "$where": { "$lt": ["$b.price", 10] },\n  "$return": { "$add": ["$total", "$b.price"] } }'),
      callout('Schema operators', 'With the compileTypeTest hook from @jarenjs/validate/query, queries can type-check their own data: $valid, $assert and $as take JSON Schema literals.'),
      callout('Uncorrelated equijoins are hash joins', 'The planner recognizes a $where equality whose probe side does not depend on the outer binding and answers it from a hash table — O(n+m) instead of O(n·m). It declines whenever the rewrite would be observable (a $as or $let in the phrase, a correlated source, an equality that is not the first $and conjunct), so the optimization can never change an answer.'),
    ],
  },
  {
    id: 'jslt', title: 'JSLT stylesheets',
    blocks: [
      p("XSLT's apply-templates idea, JSON-native: template rules match by location (JSONPath) and shape (JSON Schema) and produce output with query documents. Unchanged input flows to output by reference — the identity transform returns the input in nanoseconds, whatever the document size."),
      code(null, '[ { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]'),
      p('Dispositions (share / fresh / error), modes, priorities and the $apply operator are specified in JSLT-FORMAT.md; this site\'s entire UI is one JSLT stylesheet producing vnodes.'),
      p('The operator vocabulary is EXTENSIBLE without changing the format. createJsltRegistry() from @jarenjs/json/jslt composes packs of pure @jarenjs/core functions into a compiler — math ($sqrt, $pow, $hypot, the trig family), finance ($npv, $irr, $sma, $fv, $pv, $pmt) and statistics ($mean, $median, $stddev, $percentile) — so a stylesheet or a bare query can COMPUTE with them. An aggregator folds a JSONPath-selected sequence before its pure call, the way $sum does.'),
      code(null, "import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';\nconst jslt = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);\nconst t = jslt.compile([{ match: '$', body: {\n  npv:  { $npv:  ['$.rate', '$.cashflows[*]'] },\n  mean: { $mean: '$.people[?(@.class == \"upper\")].probability' },\n} }]);"),
      callout('Host opt-in, and where they run', 'A document compiled WITHOUT a registry still rejects these operators (JQ0002) — they never change the published closed vocabulary. The same registry compiles JSLT stylesheets, bare query documents and @jarenjs/linq chains; against a @jarenjs/db store they run in the query residual, and the pushable-scalar (math) subset is pushed into SQLite as deterministic UDFs where the driver allows. Play mounts the packs, so the "Registered …" examples run. See JSLT-FORMAT §13 and MODEL-FORMAT §8.1–8.2.'),
    ],
  },
  {
    id: 'xquery', title: 'The XQuery front-end',
    blocks: [
      p('parseXQuery reads an XQuery 3.1 text subset and emits a query document — the bridge that runs the W3C QT3 suite (31,821 cases) against the JSON engine with zero unattributed failures.'),
      code(null, "import { parseXQuery } from '@jarenjs/json/xquery';\nconst doc = parseXQuery('for $b in $doc?store?book?* where $b?price < 10 return $b?title');"),
    ],
  },
  {
    id: 'formats', title: 'Format validators',
    blocks: [
      p('All standard string formats plus many extras (iban, isbn10, mac, color…), numeric formats (int8…uint64, float16…float64), the JSON addressing formats and the geospatial formats (geohash, wkt, and geojson — which applies to objects and enforces the ring closure a schema alone cannot) — one canonical name → predicate registry shared by the validator and forms, so the two can never drift.'),
      code(null, "import { stringFormats, numberFormats, dateTimeFormats, geoFormats } from '@jarenjs/formats';\njaren.addFormats(stringFormats).addFormats(numberFormats).addFormats(dateTimeFormats).addFormats(geoFormats);"),
    ],
  },
  {
    id: 'emit', title: 'Schemas as TypeScript',
    blocks: [
      p('The gap a schema-first codebase has where a Zod codebase has z.infer. The observation is small: a JSON Schema is JSON, TypeScript is text, and JTLT is JSON-to-text — so generating a declaration file is a stylesheet, not a new engine. Point jaren-emit at a directory of schemas and get .d.ts files with doc comments, unions, tuples, index signatures and recursive references; --check fails CI when a schema moved and the types did not.'),
      code(null, 'npx jaren-emit --schema ./schemas --out ./src/types'),
      code(null, "import { emitTypeScript } from '@jarenjs/emit';\nemitTypeScript(schema, { name: 'User' });\n// export interface User { id: string; role?: \"admin\" | \"user\"; [key: string]: unknown; }\n// the index signature IS the schema: close it with additionalProperties: false and it goes"),
      callout('The cyclic verification', 'What makes generated types trustworthy is that Jaren owns both sides. The same schema becomes a TYPE and a VALIDATOR, and the two must correspond over a corpus of instances: every schema-valid instance must type-check (so the type is never narrower than the schema), every structurally invalid one must not (never wider), and the cases TypeScript genuinely cannot express — minLength, pattern, format — are asserted as widened AND written into the generated file as a comment. Widening silently is the most common way a generated type misleads its reader. A standalone schema-to-TypeScript tool has no validator to disagree with; the suite here is itself checked by breaking the generator on purpose and confirming it fails.'),
      p('Normalization makes a contract\'s input and output shapes differ — a defaulted member is optional for the caller and present afterwards, a coerced one arrives as a transport string. Pass the same normalize options to the generator and it names both sides: Config is what you have after normalizing, ConfigInput is what a caller may hand in. That pair is exactly what a typed contract boundary wants, and a twin appears only where the type actually differs, so one defaulted field does not double every declaration. The switch resolution is imported from the normalizer rather than reimplemented, because a variant that disagrees with it is worse than no variant.'),
      p('Two stages, because a schema graph is not shaped like a declaration file: an analysis pass flattens refs, cycles, composition and anonymous subschemas into a published type model, and a JTLT stylesheet per target renders it. Markdown reference docs ship as a second target — as unlike TypeScript as a target gets, and it needed no change to the model, which is the evidence the split earned its keep.'),
    ],
  },
  {
    id: 'forms', title: 'Forms',
    blocks: [
      p('JSON Schema to a framework-agnostic field tree, validated in three layers on one stack: per-field on every keystroke, cross-field x-form rules (visibility, enablement, computed values, assertions — written as query documents), and the authoritative compiled schema on submit.'),
      code(null, "import { buildFormModel, compileFormRules, buildFormViewModel } from '@jarenjs/forms';\nconst model = buildFormModel(schema);\nconst rules = compileFormRules(model);\nconst tree = buildFormViewModel(model, data, { rules, validateFields: true });"),
      callout('This site eats it', "Play’s JSON Schema engine can swap its data pane for a generated form: that form is exactly this view model, rendered through the standard forms stylesheet of @jarenjs/app — no hand-written form code anywhere."),
    ],
  },
  {
    id: 'view-app', title: 'View & App',
    blocks: [
      p('User interfaces as JSON: @jarenjs/view defines the vnode format (a keyed DOM patcher and an SSR string renderer consume it), and @jarenjs/app runs the loop — state, JSLT view, query-document actions, JSON Patch transitions, effects and subscriptions at named JS boundaries.'),
      code(null, '{ "state": { "count": 0 },\n  "view": [ { "match": "$", "body":\n    ["main", {},\n      ["h1", {}, "Count: ", "$.count"],\n      ["button", { "on": { "click": "inc" } }, "+"]] } ],\n  "actions": { "inc": { "patch": [\n    { "op": "replace", "path": "/count", "value": { "$add": ["$.count", 1] } } ] } } }'),
      p('The page you are reading is such a document. VIEW-FORMAT.md and APP-FORMAT.md are the contracts.'),
    ],
  },
  {
    id: 'markdown', title: 'Markdown',
    blocks: [
      p('The inverse of JTLT: @jarenjs/md parses Markdown (CommonMark core + GFM tables, strikethrough, task lists, footnotes and autolink literals + YAML/JSON/TOML frontmatter) into a plain JSON AST the whole suite consumes — JSLT transforms it, queries address it, toMarkdown prints canonical round-trip text, and the view patcher renders it with content-hash keys and structural sharing.'),
      code(null, "import { parseMarkdown, toMarkdown } from '@jarenjs/md';\nconst doc = parseMarkdown('# Hi *there*');\ndoc.ast[0].type;          // 'heading'\ntoMarkdown(doc);          // '# Hi *there*\\n' — a fixed point"),
      p('Part two is the visual component (@jarenjs/md/component): a memoized view() projection for app viewModels, md-load / md-parse entries for the effect registry, a hydrate pass for plugins like mermaid, and the styles/md.css stylesheet. Play’s Markdown engine on this site is that component, live.'),
      code(null, "import { createMdComponent } from '@jarenjs/md/component';\nconst md = createMdComponent();\ncreateApp(appDoc, {\n  effects: { ...md.effects },\n  viewModel: (state) => ({ ...state, article: md.view(state.source) }),\n});"),
      p('Two emitters, one AST, and neither built on the other: toHtml writes bytes, mdToVnode builds a patchable tree. A vnode has no slot for unescaped author markup, which is what makes it safe for Markdown you did not write; a string does, which is why the raw-HTML corner of CommonMark is reachable through toHtml and only there. Escaping is the default in both; html: \'raw\' is per-call and trusted-input-only.'),
      code(null, "import { toHtml, mdToVnode } from '@jarenjs/md';\ntoHtml(doc);                       // '<h1>Hi <em>there</em></h1>' — escaped by default\ntoHtml(doc, { html: 'raw' });      // trusted input only\nmdToVnode(doc, { keyed: false });  // SSR: skip the content-hash keys"),
      p('Directives carry a value a machine derives and a human reads. The carrier is an HTML comment, which every markdown renderer drops — so the baked text between the markers is what GitHub, an editor preview and npm show, with no runtime. bake() writes the fresh value back into the source, splicing only the spans between markers, so a re-derivation is a reviewable diff instead of a number that quietly stopped being true. Every measured figure in this repository’s own documents works that way.'),
      p('Measured like every other engine, on two corpora: the Markdown benchmark scores @jarenjs/md against marked, markdown-it and micromark over the official CommonMark spec examples, and over the GFM specification’s five extension sections with every engine’s extensions on (npm run benchmark:markdown). Both jaren rows are published — the string emitter and the vnode emitter — because the difference between them is the safety boundary, not a rounding error. The results are on the Benchmarks page.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Play’s Markdown engine parses as you type — the preview, AST, canonical print and frontmatter all come from one compiled document. The Benchmarks page has its scorecard and timings against the mainstream parsers.',
        href: '#/play?engine=markdown',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'mermaid', title: 'Mermaid',
    blocks: [
      p('A native, headless Mermaid clone: @jarenjs/mermaid parses diagrams-as-code (flowchart and sequence fully; class, ER, state, gantt and pie too) into a geometry-free JSON AST, then lays it out and renders pure-vnode SVG through @jarenjs/view — no innerHTML, no browser. render() is synchronous, complete and error-safe, memoized by content hash.'),
      code(null, "import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';\nconst doc = parseMermaid('flowchart TD\\n  A --> B');\ntoMermaid(doc);           // canonical text — a round-trip fixed point\nrenderMermaid('flowchart TD\\n  A --> B'); // an ['svg', …] vnode"),
      p('Because the AST is geometry-free it is a reusable semantic model: a stateDiagram-v2 projects via a JSLT stylesheet into an executable @jarenjs/flow machine (jaren-fsm) and a flowchart into a jaren-dag dataflow — both run, both project back to editable diagram text through toMermaid. Rendering is one consumer of the model, not the only one; see the Flow section.'),
      p('The Markdown engine embeds it: a ```mermaid fence renders to inline SVG through the native plugin — SSR-safe, no injected instance. This site dogfoods it; the package READMEs render their own Mermaid diagrams live in the docs dialog. Pie rendering delegates to @jarenjs/charts — same SVG, one pie engine for the whole suite.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Play’s Mermaid engine parses as you type — the rendered SVG, the geometry-free AST and the canonical toMermaid round-trip all come from one compiled document. The Benchmarks page has its coverage scorecard and parse-speed numbers.',
        href: '#/play?engine=mermaid',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'core', title: 'Core utilities',
    blocks: [
      p('Everything underneath, usable standalone: type guards, grapheme-aware Unicode strings, a large text-validation toolbox (emails, hostnames, IRIs, punycode, I-Regexp), RFC 3339 date-time parsing, fixed-width numeric ranges, a char-code scanner toolkit and asm.js-style int32/float64 math.'),
      p('Two kernels are worth naming separately because the whole suite reaches for them. @jarenjs/core/dates is calendar arithmetic on RFC 3339 strings and epoch milliseconds — there is deliberately no date type, because a wrapper class would stop a value being patchable, schema-checkable and pointer-addressable — with LDML formatting, a locale-free civil-date core, and clamping month math that makes add and diff inverses.'),
      code(null, "import { addToParts, formatRFC3339Parts, compileDateFormat } from '@jarenjs/core/dates';\nimport { haversineDistance, geohashEncode, pointInPolygon } from '@jarenjs/core/geo';\n\nhaversineDistance(4.9041, 52.3676, 2.3522, 48.8566);  // 429861.98 m\ngeohashEncode(4.9041, 52.3676, 6);                    // 'u173zt'"),
      p('@jarenjs/core/geo is the spatial kernel, and its representation is GeoJSON itself (RFC 7946) rather than a geometry class — positions are [lon, lat] arrays, a Polygon’s coordinates IS an array of rings. It carries Shewchuk adaptive-precision orientation predicates (an exact sign, which is what containment and winding actually rest on), great-circle distance and area on the sphere, ring closure and winding, geohash, a Hilbert-packed static R-tree behind the query engine’s spatial joins, and — for drawing only — Web Mercator with Douglas-Peucker simplification. Never measure on a projected coordinate: area and distance stay on the sphere, and the projection exists so a map chart can be drawn.'),
    ],
  },
  {
    id: 'calculator', title: 'Calculator',
    blocks: [
      p('A multi-mode calculator (standard/scientific/programmer/financial/converter) as an @jarenjs/app document, with x·y and x·y·z plots rendered as pure-vnode SVG. Its numeric kernel lives in @jarenjs/core: math (transcendentals, BigInt word math, root finders, a mat4/projection 3D kernel, number formatting), finance (TVM, NPV/IRR, amortization, bonds, indicators) and convert (fixed-factor units + the pure convertCurrency rate-table primitive). The expression engine is a two-stage compiler with a round-trip printer.'),
      code(null, "import { evaluate, parseExpression, toExpression, plot2d, toSvgString } from '@jarenjs/calc';\nevaluate('sin(pi/2) + 2^10').value;          // 1025\ntoExpression(parseExpression('a-(b-c)'));    // 'a - (b - c)'\ntoSvgString(plot2d('sin(x)', { domain: [-6.28, 6.28] }));"),
      p('The converter’s currency dimension is the maturity example: live crypto+fiat rates flow through an @jarenjs/app effect and a when-gated poll (CoinGecko/Binance), while the pure conversion stays in @jarenjs/core/convert. A static fallback keeps it working offline.'),
    ],
  },
  {
    id: 'josl', title: 'JOSL & JSONX',
    blocks: [
      p("A strict TOML 1.0 superset with JavaScript's obvious values first-class — null, bigint, regexp, all four datetime flavours — plus a streamable [[]] root array. The parser passes the complete official toml-test suite in strict TOML mode, consumes chunk streams that may split any token, and reports document-order events with pointer-able paths."),
      code(null, '# JOSL: TOML plus the obvious\nid = 123n\npattern = /^ok$/i\nmissing = null\n\n[[records]]\nname = "streaming"'),
      p('JSONX — the same extensions over JSON — streams too: createJsonxStreamReader is an incremental reader whose chunks may split any token (escapes mid-\\uXXXX, numbers, tru + e), with a strict-JSON mode that makes it a streaming JSON.parse. Both readers emit one unified pair event with absolute paths, so a consumer never branches on syntax.'),
      code(null, "import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';\nconst reader = createJsonxStreamReader({ mode: 'json',\n  onEvent: (e) => e.type === 'pair' && console.log(e.path, e.value) });\nreader.feed('{\"run\": [{\"ops\": 61');   // any split point works\nreader.feed('200}]}');\nreader.end();                          // { run: [{ ops: 61200 }] }"),
      p('Feeding a document in chunks bounds the parse, not the result — the reader still ends up holding everything it has read, which is the wrong answer for a continent-sized FeatureCollection or a million-line log. detach names a path pattern whose values are never linked into the tree: the completion event still carries the whole record, so the consumer sees every one of them, but letting go of the event lets go of the record. root() comes back holding the document’s frame however many records went past.'),
      code(null, "const reader = createJsonxStreamReader({\n  mode: 'json',\n  detach: ['features', '*'],        // '*' matches any one segment\n  onEvent: (e) => {\n    if (e.type === 'object-end' && e.path.length === 2)\n      consume(e.value);             // a whole GeoJSON Feature\n  },\n});\nfor await (const chunk of fileChunks) reader.feed(chunk);\nreader.end();  // { type: 'FeatureCollection', features: [] }"),
      p('Measured on a synthetic OpenStreetMap-shaped extract of 20 000 features (node --expose-gc benchmark/jsonx-stream.js): the default read peaks at 185.4 MB of live heap and ends holding all 20 000, while the detached read stays under 0.1 MB and holds none — and that figure does not move at 80 000 features, because the peak is the 64 kB feed buffer plus one feature at a time, not the document.'),
    ],
  },
  {
    id: 'csv', title: 'CSV',
    blocks: [
      p('The same machine shape as JOSL, applied to the format the world exports by accident. One grammar path serves both directions — parseCsv walks the source once, and the chunk reader runs a side-effect-free cutter first because a chunk can stop mid-field — so a document read in pieces and the same document read whole produce identical rows.'),
      code(null, "import { parseCsv, parseCsvDocument } from '@jarenjs/josl/csv';\nimport { iterateCsvStream } from '@jarenjs/josl/csv-stream';\n\nparseCsv('a,b\\n1,2');                     // [['a','b'], ['1','2']]\nparseCsv('a,b\\n1,2', { headers: true });  // [{ a: '1', b: '2' }]\n\n// rows as they complete, never holding the table\nfor await (const row of iterateCsvStream(response.body, { headers: true }))\n  await save(row);"),
      p('Reading is strict by default: anything RFC 4180 forbids throws a CsvSyntaxError with a stable CSV1xxx code, a line and a column. repair: true reads the same damage the way that loses the least and logs it under the SAME code, so moving between the modes never means re-learning the diagnosis.'),
      code(null, "const doc = parseCsvDocument('a,b\\n\"he said \"hi\" ok\",2\\n', {\n  repair: true, headers: true,\n});\ndoc.rows;    // [{ a: 'he said \"hi\" ok', b: '2' }]\ndoc.repairs; // [{ code: 'CSV1003', line: 2, column: 10, message: … }, …]"),
      p('Two of those codes describe the same byte read two ways, and the reader decides by looking for another quote before the next delimiter: \'"he said "hi" ok"\' keeps its text, while \'"abc"junk,d\' keeps its column count — a lost field boundary corrupts every value after it, where a mangled cell corrupts one. A record shorter than its header leaves the missing columns absent rather than empty, because undefined says the record did not carry the column while an empty string would claim it carried nothing.'),
      p('delimiter: \'auto\' sniffs the dialect by scoring each candidate on how consistently it divides records, and calls a header row only when the first record looks unlike the rest — a table that is text all the way down gives no evidence, and inventing a header there would silently eat a data row. typed: true uses the package value model rather than JSON\'s: an integer past 2^53 becomes a bigint instead of rounding, ISO dates become the same LocalDate/LocalDateTime a JOSL document yields, and 007 stays a string.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Play’s CSV engine opens on a deliberately broken document: flip mode from strict to repair to watch it parse anyway and list every fix with its code, line and column.',
        href: '#/play?engine=csv',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'charts', title: 'Charts',
    blocks: [
      p('Headless charts: @jarenjs/charts compiles a definition document plus its data into a geometry-free AST (fractions, angles, unit coordinates — no pixels) and renders pure-vnode SVG through @jarenjs/view. Thirteen types — pie (and donut), bar, line, scatter, candlestick, radar, gauge, boxplot, heatmap, treemap, streamgraph, sankey, map (GeoJSON in Web Mercator, shaded by a feature property) — themed by host-linked tokens; the Benchmarks page charts and the mermaid pie are this engine.'),
      code(null, "import { compileChart } from '@jarenjs/charts';\nconst compiled = compileChart({ type: 'pie', title: 'Pets',\n  slices: [{ label: 'Dogs', value: 40 }, { label: 'Cats', value: 25 }] });\ncompiled.ast;           // geometry-free JSON\ncompiled.toSvgString(); // standalone SVG"),
      p('The stream adapter turns the josl readers’ unified events into live chart data: records assemble as their fields arrive (path mode for one big document in chunks, document mode for many small messages), with ring-buffer eviction and identity-keyed memo re-renders. The Charts page’s live Binance feed is this code path.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Play’s Charts engine compiles definitions in JSON, JSONX or JOSL and renders pure-vnode SVG. The streaming half — a chart building chunk by chunk, and the live Binance feed — is the Charts page.',
        href: '#/play?engine=charts',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'assistant', title: 'AI assistant',
    blocks: [
      p('@jarenjs/ai is browser-side AI that makes sense: one OpenAI-compatible chat client for OpenRouter, Ollama or LM Studio, bring-your-own-key, no server and no proxy. The site assistant (the ✦ button, bottom-right) runs on it — describe what you want and it drives the site for you.'),
      p('Tools are the point. Each Play engine is a tool declared with a JSON Schema, and Jaren validates the model’s own tool calls before they run — the suite guarding its own tools. A bounded agent loop keeps even small local models on the rails: malformed arguments and failing tools come back as readable results the model can correct, never crashes.'),
      code(null, "import { createChatClient, createToolbox, createAgent } from '@jarenjs/ai';\n\nconst client = createChatClient({ provider: 'ollama', model: 'qwen3:4b' });\nconst toolbox = createToolbox();\ntoolbox.add({\n  name: 'lookup', description: 'Look up one record.',\n  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },\n  execute: ({ id }) => records.get(id) ?? { error: `no '${id}'` },\n});\nconst agent = createAgent({ client, toolbox, maxToolRounds: 5 });\nconst { message } = await agent.send(history, { onDelta: (t) => ui.stream(t) });"),
      p('The same tools publish over WebMCP (navigator.modelContext) with one call, so a browser-hosted agent drives the identical schema-guarded surface. The assistant knows the site’s own example library, can save what you build together as named experiments, and keeps the conversation across reloads. Everything — the key and the transcript — stays in your browser, stored locally and sent only to the provider you choose.'),
      p('A long session used to lose what it found. A history budget keeps the conversation inside a small local context window, and the middle of it is replaced by a summary — which remembered that a tool was called and lost what it returned. The ledger fixes the destruction, not the summarising: every round that leaves the request is first archived to an addressed slot, the summary carries the address, and a recall tool fetches the whole round back. The panel says how many rounds are archived, because a compacted session should look recoverable rather than silently lossy.'),
      p('Set an objective in the panel and it outlives the tab: it is stored, composed into the prompt of every turn together with the progress recorded against it, and read back from storage on the next visit — so a reloaded page continues instead of starting over. “Remember this session” asks the model what it learned, as an RFC 6902 patch over its own memories, and every stage of the gate runs before anything lands: the patch schema, the suite’s own patch engine applied to a copy, then the ledger’s schemas. A memory without evidence is refused, and the assistant’s base instructions are not a patch target at all.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Open the assistant (bottom-right), add your provider, model and — for OpenRouter — an API key in settings, then ask it to validate a schema or run any engine. Local runtimes need CORS enabled for this origin (Ollama: OLLAMA_ORIGINS; LM Studio: the server CORS toggle).',
        href: '#/play',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'studio', title: 'The Studio',
    blocks: [
      p('The Studio (#/project) hosts a user- or AI-authored @jarenjs/app document — initial state, a JSLT view stylesheet and named actions as one JSON value — as a live application next to the site’s own. The document is one `app` file inside a multi-file project IDE, beside the query, JSLT, schema and data files it can sit with. This is the honest version of “one prompt → website” for this suite: the site does not scaffold a foreign repo, it lets the model author the suite’s own app format, gated by the suite’s own meta-schema, rendered by the suite’s own view engine. The AI writes JSON; Jaren validates it; the app runtime runs it. No eval, no server, CSP-safe.'),
      p('Why this shape works: an app document IS a website — the jarenjs site itself is one — so the generative tier needs no new runtime, only a safe host for a second, untrusted document. The threat model is the meta-schema: jaren-app.schema.json (composing the published query and JSLT grammars) is compiled by @jarenjs/validate and gates every boot. The nested app is granted no effects and no subs, so a document is inert JSON — the worst a hostile or hallucinated document can do is fail validation or render junk inside its error-contained mount. Boot is atomic: a document that fails mid-boot leaves no half-mounted DOM.'),
      p('Iteration is patch-based, not resend-based: a weak local model cannot re-emit a 200-line document per turn, but it can emit an RFC 6902 patch — and the suite’s own patch engine applies it, with the patched result re-validated before it swaps in (an invalid result is rejected atomically; the current document stays live). Dogfooding is the feature: the assistant’s studio tools — jaren_studio_write, jaren_studio_patch, jaren_studio_read and jaren_get_templates for the app document, plus jaren_project_files, jaren_project_write and jaren_project_run for the project as a file tree — are the same schema-guarded toolbox as everything else. The project tools matter for honesty as much as capability: an assistant that could only read the app document would answer questions about “my project” from one file and confidently miss the rest.'),
      code('A complete studio document', '{ "$app": "0.1",\n  "state": { "count": 0 },\n  "view": { "$jslt": "0.1", "rules": [\n    { "match": "$", "body": ["main", {},\n      ["h2", {}, "Count: ", "$.count"],\n      ["button", { "on": { "click": "inc" } }, "+"]] }\n  ] },\n  "actions": {\n    "inc": { "patch": [{ "op": "replace", "path": "/count",\n                         "value": { "$add": ["$.count", 1] } }] }\n  } }'),
      p('Documents may name four render capabilities as widgets — form ({ schema, data }: the standard forms stylesheet with live JSON Schema errors), chart ({ config }: an @jarenjs/charts definition), markdown and mermaid ({ source }) — each a pure props-to-vnode projection through the shipped compilers. Keep what you build: studio documents save into the experiment store, share as links (with an honest size limit), and download as JSON. Granting effects or subs to studio documents is a deliberate non-goal for now — that is a later order with its own threat model.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Load a seed template — a validated form, a charts dashboard, a routed mini-site — and edit the JSON, or ask the assistant to build on one via template + patch.',
        href: '#/project',
        link: 'Open the Studio',
      },
    ],
  },
  {
    id: 'flow', title: 'Flow — executable workflows',
    blocks: [
      p('@jarenjs/flow makes the suite’s machines executable, in two document formats. A jaren-fsm is a finite state machine as one JSON value — declared states, an initial state and a document-ordered transition table whose guards are Jaren JSON Query documents — compiled once into a pure step function; a jaren-dag is an acyclic dataflow whose nodes are the suite’s own engines (a query filters, a JSLT stylesheet projects, a registered task awaits) wired by edges that carry data. Both are schema-published for constrained decoding, both compile fail-closed with coded, docPath-carrying errors, and neither uses eval.'),
      p('Effects are data, not callbacks: a fired transition returns resolved { run, with } descriptors — the host’s registry runs them — so the whole machine stays a serializable value. That is the wedge, and the Benchmarks page measures it against XState v5: a jaren-fsm document survives a JSON round trip with its guards intact and still fires them, where XState’s guards are functions JSON drops and the restored machine throws. Published beside that win are the honest losses — a compiled machine holds more memory than an XState actor, and a dag run costs several times a hand-written pipeline: the measured price of dataflow as one serializable, constrained-decodable value.'),
      code('A machine and a dataflow, both as JSON', '// jaren-fsm: a guard is a query document, effects come back as data\n{ "$fsm": "0.1", "initial": "idle",\n  "states": ["idle", { "id": "done", "final": true }],\n  "transitions": [\n    { "from": "idle", "event": "ok", "guard": "$.payload.fresh", "to": "done" }] }\n\n// jaren-dag: the suite’s engines, wired\n{ "$dag": "0.1",\n  "nodes": { "rows": { "kind": "input" },\n    "adults": { "kind": "query",\n      "query": { "$for": { "r": "$[*]" }, "$where": { "$ge": ["$r.age", 18] }, "$return": "$r" } },\n    "out": { "kind": "output" } },\n  "edges": [{ "from": "rows", "to": "adults" }, { "from": "adults", "to": "out" }] }'),
      p('One document, three views that cannot disagree: @jarenjs/mermaid projects a stateDiagram to a jaren-fsm and a flowchart to a jaren-dag (and back) as plain JSLT stylesheets, a machine hosts inside an @jarenjs/app through generated standard action documents, and a dag hosts as one app effect. The Flow studio puts all three on one page — click the diagram, edit a generated inspector, or edit the mermaid text; every gesture is an RFC 6902 patch against the same document, which then runs live as a nested app or an aborting dag.'),
      p('The studio ships classic FSM examples as seeds, including three ported from iMatix’s Libero code generator (imatix-legacy.github.io/libero) — the Coke machine, the telephone dialogue and the lrcalc arithmetic-expression evaluator. Libero described logic as state / event / action / next-state tables and generated code from them; a jaren-fsm IS that table, as one runnable JSON value: load the Coke machine, watch it as a state graph, and click Ok · Clink · Coke to drive it — the current state glows and the transition just taken flows — with every Libero action landing in the run log. The expression evaluator is the same idea doing real work: a shunting-yard parser whose events are token types.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Open the Flow studio: start from the review-machine or enrich-dataflow seed, edit it three ways, then run it live and watch the diagram highlight the current state or the nodes settle.',
        href: '#/flow',
        link: 'Open Flow',
      },
    ],
  },
  {
    id: 'linq', title: 'LINQ — chains to query documents',
    blocks: [
      p('A C#-familiar chain whose product is a plain JSON query document. Capture is a recording proxy (never source-text inspection), execution is deferred, and the emitted document runs in memory, over async streams, or against any provider exposing execute(document, options) — @jarenjs/db implements that contract with no import edge in either direction.'),
      code(null, "import { from } from '@jarenjs/linq';\n\nconst adults = from(users)\n  .where((u) => u.age.gt(21))\n  .orderBy((u) => u.name)\n  .select((u) => ({ id: u.id, name: u.name }));\n\nadults.toArray();    // deferred until a terminal\nadults.toDocument(); // { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, … }"),
      p('The async surface runs the SAME operator set over cursors: streamable stages go per item, barrier operators buffer and run through the one engine, and mapAsync is the single bounded-concurrency boundary (concurrency is required; the modes are parallel / concat / switch / exhaust). Async answers equal sync answers by construction — the same chain emits a byte-identical document through both drivers.'),
    ],
  },
  {
    id: 'db', title: 'Data — documents in SQLite',
    blocks: [
      p('A model document declares collections (a JSON Schema, a key declaration, indexes over singular JSONPaths); openStore applies the physical mapping through a dialect and gives transactional, schema-validated reads and writes on Node, Bun, or an injected wasm build. Queries push down to guarded, parameter-bound SQL where equivalence is proven — a 418-run differential oracle keeps the pushed path and the engine agreeing — and explain() always names the SQL, the indexes and the residual reasons.'),
      p('A store can also open with an operator registry — openStore(model, { operators: createJsltRegistry().use(mathPack)… }) — and registered operators ($npv, $mean, $sqrt) then work in query and entity documents. They run correctly in the query residual, explain() names them, and the pushable-scalar (math) subset is pushed into SQLite as deterministic UDFs where the driver supports them (node yes; bun has no UDF API and stays the residual, reported by capabilities.pushableOperators). The Data studio mounts them — run { "$sqrt": "$it.points" } in a where and watch explain() show the jaren_p_ UDF.'),
      code(null, "import { openStore } from '@jarenjs/db';\nimport { nodeDriver } from '@jarenjs/db/node';\n\nconst store = await openStore(model, { driver: nodeDriver(), path: 'app.db' });\nconst users = store.collection('users');\nawait users.insert({ id: 'u1', email: 'ada@example.test', age: 36 });\nconst plan = await users.explain({\n  $for: { it: '$[*]' }, $where: { $ge: ['$it.age', 21] }, $return: '$it',\n});\n// plan.sql, plan.indexes, plan.residual, plan.scanNarrative"),
      p('Phase B makes it an ORM: entities declare keys, typed columns, relations and an optimistic-concurrency token with the x-entity vocabulary INSIDE their JSON Schema; a graph loads with its children in exactly ONE statement (asserted by a counting driver, not promised); the unit of work diffs frozen snapshots into minimal parameterised writes inside one transaction; and jaren-db plans, checks and applies migrations from the command line, with drift detection for CI.'),
      code(null, "const store = await openStore(entityModel, { driver: nodeDriver(), path: 'app.db' });\nconst users = store.entity('User');\n\n// one statement, two levels, filters INSIDE the subquery\nconst graph = await users.load({\n  where: { $gt: ['$it.age', 21] },\n  include: { posts: { orderBy: { $key: '$it.stars', $dir: 'desc' }, take: 3,\n    include: { comments: true } } },\n});\n\n// the unit of work: frozen reads, replacement writes, one transaction\nconst ada = await users.get('u1');\nusers.put({ ...ada, age: 37 });\nconst report = await store.saveChanges();\n// report.statements, report.fallbacks, report.concurrency"),
      p('Generated types close the loop: entityEmitModel renders the same model document into entity interfaces, input variants and an EntityMetaMap; typedStore<EntityMetaMap>(store) then types every read, checks every write, and widens load results by their include specification — u.age.gt(21) compiles, u.age.gt("x") does not, and an omitted include means the member is not there.'),
      p('Migrations are documents too: planModelMigration diffs two models into rendered DDL, data steps and the twelve-step table rebuild (foreign_key_check inside the transaction); the whole chain replays on a shadow database first; a checksummed history refuses edited or reordered migrations; and after every relational migration the schema must EQUAL what a fresh build of the target model produces.'),
      callout('SQLite only, said plainly', 'The dialect seam is real and tested against a double, but SQLite (3.45+) is the one shipped backend. There is no statement timeout on these drivers — the capability slot is honestly false — and the safe profile composes what CAN be bounded: engine limits, a mandatory row bound that refuses rather than truncates, allow-lists, and per-collection mandatory predicates no document shape can shed. The live in-browser store is phase C; the examples here are Node examples, and the ORM benchmark page publishes the Prisma/Drizzle/Kysely numbers with every loss and its reason.'),
    ],
  },
  {
    id: 'contract', title: 'Contract — operations over any wire',
    blocks: [
      p('The layer between two Jaren ends. A $contract document — the sibling of $model, $fsm and jaren-app — declares the operations they may exchange: JSON in, JSON out, each with a kind (read, command or subscribe), one input schema, an output schema, declared errors, a behavior policy and a REST-faithful HTTP binding. compileContract compiles it once into per-operation validators, transport normalizers (path and query strings decoded through the input schema itself) and a path matcher whose static segments beat variables regardless of registration order. A bad document is refused at compile with a stable JC code and the JSON Pointer of the member at fault — never at request time.'),
      code('The document', '{ "$contract": "0.1", "id": "shop",\n  "operations": {\n    "catalog.load": {\n      "kind": "read",\n      "input":  { "type": "object", "properties": { "since": { "type": "string", "format": "date-time" } } },\n      "output": { "type": "array", "items": { "$ref": "#/$defs/Product" } },\n      "http":   { "method": "GET", "path": "/api/catalog" }\n    }\n  },\n  "$defs": { "Product": { "type": "object", "required": ["id", "name"],\n             "properties": { "id": { "type": "integer" }, "name": { "type": "string" } } } } }'),
      p('Serving it is one call per binding: serveHttp turns the compiled contract plus a handler table into a total dispatch pipeline — plain request in, plain response out, every hostile input settled into a coded response — with fetch (Request→Response) and node adapters, body limits, prototype-safe parameter assembly, idempotency through a ledger interface, and the response validated against the output schema before it leaves. The same handler table serves in-process (local) and over MessagePort, Worker or BroadcastChannel (port, with collision-free client-scoped request ids — this site’s own cross-tab data studio runs on it). A subscribe operation streams a @jarenjs/db live() subscription — a snapshot, then { patch, seq } emissions — as Server-Sent Events over http and push frames over port, resumable by seq.'),
      code('Serve, call, bind', "import { compileContract } from '@jarenjs/contract';\nimport { serveHttp } from '@jarenjs/contract/http';\nimport { toNodeHandler } from '@jarenjs/contract/node';\nimport { openHttpClient } from '@jarenjs/contract/client';\nimport { contractAppBinding, createContractEffect } from '@jarenjs/contract/app';\n\nconst contract = compileContract(doc);\nhttp.createServer(toNodeHandler(serveHttp(contract, handlers))).listen(8080);\n\nconst client = openHttpClient(contract, { baseUrl: 'http://localhost:8080' });\nawait client.invoke('catalog.load', { since: '2026-01-01T00:00:00Z' });\n// { ok: true, value: [...], meta: { op, attempt, trace, revision, etag, notModified } }\n\n// or drive it from an app document: generated task slots + ONE effect\nconst { slice, actions, schema } = contractAppBinding(contract);"),
      p('The client resolves a JSON outcome for everything a server or a network can do — a declared failure, a transport error, a peer that violated the contract, a local cancellation — and never rejects for any of them. Three identities stay apart by construction: the attempt id is the caller’s, the trace id is the server’s, and the idempotency key is generated client-side and travels only as its header. The app binding turns each operation into a generated task slot with start/done/reset actions and one registered effect — no route strings, no hand-written wrappers, and no import between the packages: the documents cross as JSON.'),
      { kind: 'table', title: 'What each binding carries', note: 'from the frozen capabilities table each binding publishes — a binding that cannot carry a feature says so, never degrades silently', head: ['capability', 'http', 'local', 'port'], rows: [
        { kind: 'row', cells: ['status codes', 'yes', 'no (status: null)', 'no (status: null)'] },
        { kind: 'row', cells: ['headers / etag', 'yes', 'no', 'no'] },
        { kind: 'row', cells: ['idempotency', 'with a ledger', 'no — stated', 'no — stated'] },
        { kind: 'row', cells: ['stream (subscribe)', 'SSE, resumable', 'no', 'push frames'] },
      ] },
      p('Everything a consumer wants beside the runtime is a projection of the same compiled document: a browser-safe public subset (itself a valid $contract), OpenAPI 3.1 (validated against the official meta-schema), TypeScript declarations with a typed operation map, Markdown reference docs and AI tool definitions — with a jaren-contract CLI whose --check fails CI the moment an artifact drifts. The contract knows its own identity: revision() is the SHA-256 of the canonical public projection, served at /.well-known/jaren-contract, and diffContracts classifies what changed between two versions as breaking, additive, neutral or honestly unknown, by a published rule table.'),
      p('What it is not, said plainly: not a server framework (bring your own http server or any framework via the adapters), no authentication or authorization, no transport encryption, no replay protection beyond idempotency keys, and bytes are not JSON — a non-JSON media operation is routed and matched but its body crosses opaque. The measured cost per request is published beside Fastify’s on the Benchmarks page, losses included.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Play’s Contract engine compiles a $contract document as you type — describe(), the OpenAPI 3.1 projection, the TypeScript declarations and an in-process dispatch against echo handlers, one tab each. The Benchmarks page has the match and dispatch numbers beside find-my-way, hono and Fastify.',
        href: '#/play?engine=contract',
        link: 'Open Play',
      },
    ],
  },
  {
    id: 'further-reading', title: 'Further reading',
    blocks: [
      p('The language contracts live with their packages: QUERY-FORMAT.md, JSLT-FORMAT.md, XQUERY-FRONTEND.md, VIEW-FORMAT.md, APP-FORMAT.md, FLOW-FORMAT.md, ERROR-MESSAGES.md and the JOSL FORMAT.md. The repository README maps the whole suite; benchmark/README.md documents how every number on this site is measured.'),
      callout('The code is the reference', 'Every public function carries JSDoc. When in doubt, open the source — the packages are written to be read.'),
    ],
  },
];
