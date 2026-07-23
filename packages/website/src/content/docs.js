//@ts-check
/**
 * The documentation — a content document. Each section's `blocks` are
 * kind-tagged render nodes (lib/nodes.js vocabulary) rendered by the
 * generic 'ui' rules; editing the docs means editing JSON, and an LLM
 * constrained to the vnode/kind schemas could write these pages.
 */

const p = (text) => ({ kind: 'p', text });
const code = (text, title) => ({ kind: 'code', title: title ?? null, badge: null, text });
const note = (title, text) => ({ kind: 'callout', title, text, href: null, link: null });

export const DOCS_SECTIONS = [
  {
    id: 'installation', title: 'Installation',
    blocks: [
      p('Every package is published on npm under the @jarenjs scope, zero-dependency and ESM. Install what you need — the validator pulls in nothing you do not ask for.'),
      code('npm install @jarenjs/validate\nnpm install @jarenjs/formats   # format keyword validators\nnpm install @jarenjs/json      # pointer, path, patch, query, JSLT\nnpm install @jarenjs/forms     # schema-driven forms\nnpm install @jarenjs/view @jarenjs/app  # UIs as JSON documents'),
      p('Node 22 or newer; browsers via any bundler. No eval, no new Function: everything is CSP-safe by construction.'),
    ],
  },
  {
    id: 'quick-start', title: 'Quick start',
    blocks: [
      p('Compile a schema once, validate as often as you like. Compilation does all the deciding; validation runs a specialized closure.'),
      code("import { JarenValidator } from '@jarenjs/validate';\n\nconst jaren = new JarenValidator();\nconst validate = jaren.compile({\n  type: 'object',\n  properties: {\n    name: { type: 'string' },\n    age: { type: 'integer', minimum: 0 },\n  },\n  required: ['name'],\n});\n\nvalidate({ name: 'John', age: 30 });  // true\nvalidate({ age: -5 });                // false"),
    ],
  },
  {
    id: 'validation-options', title: 'Validation options',
    blocks: [
      p('The validator constructor takes the operational switches: collectErrors gathers every failure instead of stopping at the first; skipErrors: false makes the compiled function return { valid, errors }; formatAssertion controls whether the format keyword asserts or only annotates.'),
      code("const jaren = new JarenValidator({\n  skipErrors: false,\n  collectErrors: true,\n  formatAssertion: true,\n});\nconst validate = jaren.compile(schema);\nconst { valid, errors } = validate(data);"),
    ],
  },
  {
    id: 'error-handling', title: 'Errors & i18n',
    blocks: [
      p('Every error is structured: instancePath, keyword, a stable msgid and raw params — human text renders at report time through a message catalog, so switching language never re-validates.'),
      code("import { compileMessageCatalog, localizeErrors } from '@jarenjs/validate';\nimport { nl } from '@jarenjs/locales';\n\nconst catalog = compileMessageCatalog(nl);\nlocalizeErrors(result.errors, catalog);  // the same errors, Dutch text"),
      note('Schema-authored messages', 'The errorMessage keyword and its $msgid form keep even schema-authored texts translatable — see ERROR-MESSAGES.md in the validate package.'),
    ],
  },
  {
    id: 'refs', title: 'External schemas & $ref',
    blocks: [
      p('Register schemas by $id and reference them; bundled meta-schemas (@jarenjs/refs) make draft detection and $vocabulary work offline. Dynamic references and per-document draft handling are spec-compliant.'),
      code("jaren.addSchema({ $id: 'https://example.com/address.json', type: 'object', properties: { city: { type: 'string' } } });\nconst validate = jaren.compile({\n  type: 'object',\n  properties: { address: { $ref: 'https://example.com/address.json' } },\n});"),
    ],
  },
  {
    id: 'query-keyword', title: 'The $query keyword',
    blocks: [
      p('Cross-field assertions — sums, date ordering, quantification — inside the schema itself: the $query extension keyword embeds a Jaren JSON Query as an assertion over the whole instance. This is the class of constraint JSON Schema is notoriously bad at.'),
      code('{ "type": "object",\n  "properties": {\n    "lines": { "type": "array", "items": { "type": "number" } },\n    "total": { "type": "number" }\n  },\n  "$query": { "$eq": ["$.total", { "$sum": "$.lines[*]" }] } }'),
    ],
  },
  {
    id: 'draft-support', title: 'Draft support',
    blocks: [
      p('draft-06, draft-07, 2019-09 and 2020-12 are fully supported — including annotation-driven unevaluatedProperties/unevaluatedItems, $dynamicRef/$dynamicAnchor and $vocabulary processing. The official test suite passes 100% for every benchmarked draft, optional format suites included.'),
      { kind: 'table', title: 'Official suite results', note: 'passed / failed / errors — see the Benchmarks page for the live numbers', head: ['Draft', 'Jaren', 'Ajv'], rows: [
        { kind: 'row', strong: true, cells: ['draft-07', '308 / 0 / 0', '294 / 13 / 1'] },
        { kind: 'row', strong: true, cells: ['2019-09', '425 / 0 / 0', '406 / 15 / 4'] },
        { kind: 'row', strong: true, cells: ['2020-12', '433 / 0 / 0', '390 / 33 / 10'] },
      ] },
    ],
  },
  {
    id: 'json-pointer', title: 'JSON Pointer',
    blocks: [
      p('RFC 6901 as compiled, zero-allocation getters — plus relative JSON Pointers, the $data hot path. A miss returns the JSONPOINTER_NOTHING sentinel, never a throw.'),
      code("import { compileJSONPointer } from '@jarenjs/json/pointer';\nconst get = compileJSONPointer('/limits/min');\nget({ limits: { min: 2 } });  // 2"),
    ],
  },
  {
    id: 'json-patch', title: 'JSON Patch & Merge Patch',
    blocks: [
      p('RFC 6902 and RFC 7396 as copy-on-write appliers: the input is never mutated, untouched subtrees are shared by reference, application is atomic, and the changes option turns the engine into a change feed of written paths.'),
      code("import { compileJSONPatch } from '@jarenjs/json/patch';\nconst apply = compileJSONPatch([\n  { op: 'replace', path: '/user/name', value: 'Bob' },\n], { changes: true });\nconst { doc, changes } = apply(document);\n// changes: ['/user/name']"),
    ],
  },
  {
    id: 'json-write', title: 'Write operations',
    blocks: [
      p('Compiled setters, inserters and removers for both pointer and JSONPath targets: a singular pointer writes one location; a JSONPath target writes every match. All copy-on-write with the same sharing guarantees as patch.'),
      code("import { compileJSONPathSetter } from '@jarenjs/json/write';\nconst discount = compileJSONPathSetter('$.store.book[?@.price > 20].price');\nconst next = discount(doc, (old) => old * 0.9);"),
    ],
  },
  {
    id: 'jsonpath', title: 'JSONPath',
    blocks: [
      p('The complete RFC 9535 grammar as a compiler — all 703 tests of the official compliance suite pass, normalized paths included. Compiled queries expose .nodes(data) returning { path, value } pairs.'),
      code("import { compileJSONPath } from '@jarenjs/json';\nconst query = compileJSONPath('$.store.book[?@.price < 10].title');\nquery.nodes(data);  // [{ path: \"$['store']['book'][0]['title']\", value: '...' }]"),
    ],
  },
  {
    id: 'json-query', title: 'Jaren JSON Query',
    blocks: [
      p('XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, a 58-operator library — as JSON documents with JSONPath leaves. The grammar is published as JSON Schema, so a constrained decoder cannot emit an invalid query.'),
      code('{ "$for": { "b": "$.store.book[*]" },\n  "$where": { "$lt": ["$b.price", 10] },\n  "$orderby": ["$b.price"],\n  "$return": { "title": "$b.title", "price": "$b.price" } }'),
      note('Schema operators', 'With the compileTypeTest hook from @jarenjs/validate/query, queries can type-check their own data: $valid, $assert and $as take JSON Schema literals.'),
    ],
  },
  {
    id: 'jslt', title: 'JSLT stylesheets',
    blocks: [
      p("XSLT's apply-templates idea, JSON-native: template rules match by location (JSONPath) and shape (JSON Schema) and produce output with query documents. Unchanged input flows to output by reference — the identity transform returns the input in nanoseconds, whatever the document size."),
      code('[ { "match": "$..price", "body": { "$mul": ["$", 1.21] } } ]'),
      p('Dispositions (share / fresh / error), modes, priorities and the $apply operator are specified in JSLT-FORMAT.md; this site\'s entire UI is one JSLT stylesheet producing vnodes.'),
    ],
  },
  {
    id: 'xquery', title: 'The XQuery front-end',
    blocks: [
      p('parseXQuery reads an XQuery 3.1 text subset and emits a query document — the bridge that runs the W3C QT3 suite (31,821 cases) against the JSON engine with zero unattributed failures.'),
      code("import { parseXQuery } from '@jarenjs/json/xquery';\nconst doc = parseXQuery('for $b in $doc?store?book?* where $b?price < 10 return $b?title');"),
    ],
  },
  {
    id: 'formats', title: 'Format validators',
    blocks: [
      p('All standard string formats plus many extras (iban, isbn10, mac, color…), numeric formats (int8…uint64, float16…float64) and the JSON addressing formats — one canonical name → predicate registry shared by the validator and forms, so the two can never drift.'),
      code("import { stringFormats, numberFormats, dateTimeFormats } from '@jarenjs/formats';\njaren.addFormats(stringFormats).addFormats(numberFormats).addFormats(dateTimeFormats);"),
    ],
  },
  {
    id: 'forms', title: 'Forms',
    blocks: [
      p('JSON Schema to a framework-agnostic field tree, validated in three layers on one stack: per-field on every keystroke, cross-field x-form rules (visibility, enablement, computed values, assertions — written as query documents), and the authoritative compiled schema on submit.'),
      code("import { buildFormModel, compileFormRules, buildFormViewModel } from '@jarenjs/forms';\nconst model = buildFormModel(schema);\nconst rules = compileFormRules(model);\nconst tree = buildFormViewModel(model, data, { rules, validateFields: true });"),
      note('This site eats it', "The playground's Generated Form tab renders exactly this view model through the standard forms stylesheet of @jarenjs/app — no hand-written form code anywhere."),
    ],
  },
  {
    id: 'view-app', title: 'View & App',
    blocks: [
      p('User interfaces as JSON: @jarenjs/view defines the vnode format (a keyed DOM patcher and an SSR string renderer consume it), and @jarenjs/app runs the loop — state, JSLT view, query-document actions, JSON Patch transitions, effects and subscriptions at named JS boundaries.'),
      code('{ "state": { "count": 0 },\n  "view": [ { "match": "$", "body":\n    ["main", {},\n      ["h1", {}, "Count: ", "$.count"],\n      ["button", { "on": { "click": "inc" } }, "+"]] } ],\n  "actions": { "inc": { "patch": [\n    { "op": "replace", "path": "/count", "value": { "$add": ["$.count", 1] } } ] } } }'),
      p('The page you are reading is such a document. VIEW-FORMAT.md and APP-FORMAT.md are the contracts.'),
    ],
  },
  {
    id: 'markdown', title: 'Markdown',
    blocks: [
      p('The inverse of JTLT: @jarenjs/md parses Markdown (CommonMark core + GFM tables, strikethrough and task lists + YAML/JSON/TOML frontmatter) into a plain JSON AST the whole suite consumes — JSLT transforms it, queries address it, toMarkdown prints canonical round-trip text, and the view patcher renders it with content-hash keys and structural sharing.'),
      code("import { parseMarkdown, toMarkdown } from '@jarenjs/md';\nconst doc = parseMarkdown('# Hi *there*');\ndoc.ast[0].type;          // 'heading'\ntoMarkdown(doc);          // '# Hi *there*\\n' — a fixed point"),
      p('Part two is the visual component (@jarenjs/md/component): a memoized view() projection for app viewModels, md-load / md-parse entries for the effect registry, a hydrate pass for plugins like mermaid, and the styles/md.css stylesheet. The playground Markdown tab on this site is that component, live.'),
      code("import { createMdComponent } from '@jarenjs/md/component';\nconst md = createMdComponent();\ncreateApp(appDoc, {\n  effects: { ...md.effects },\n  viewModel: (state) => ({ ...state, article: md.view(state.source) }),\n});"),
      p('Measured like every other engine: the Markdown benchmark scores @jarenjs/md against marked, markdown-it and micromark over the official CommonMark spec examples (npm run benchmark:markdown), and the results are on the Benchmarks page.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'The Markdown tab in the playground parses as you type — the preview, AST, canonical print and frontmatter all come from one compiled document. The Benchmarks page has its scorecard and timings against the mainstream parsers.',
        href: '#/playground?engine=markdown',
        link: 'Open the playground',
      },
    ],
  },
  {
    id: 'mermaid', title: 'Mermaid',
    blocks: [
      p('A native, headless Mermaid clone: @jarenjs/mermaid parses diagrams-as-code (flowchart and sequence fully; class, ER, state, gantt and pie too) into a geometry-free JSON AST, then lays it out and renders pure-vnode SVG through @jarenjs/view — no innerHTML, no browser. render() is synchronous, complete and error-safe, memoized by content hash.'),
      code("import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';\nconst doc = parseMermaid('flowchart TD\\n  A --> B');\ntoMermaid(doc);           // canonical text — a round-trip fixed point\nrenderMermaid('flowchart TD\\n  A --> B'); // an ['svg', …] vnode"),
      p('Because the AST is geometry-free it is a reusable semantic model: a stateDiagram-v2 projects via a JSLT stylesheet into an @jarenjs/app workflow / FSM (events become actions), and toMermaid turns a workflow back into editable diagram text. Rendering is one consumer of the model, not the only one.'),
      p('The Markdown engine embeds it: a ```mermaid fence renders to inline SVG through the native plugin — SSR-safe, no injected instance. This site dogfoods it; the package READMEs render their own Mermaid diagrams live in the docs dialog. Pie rendering delegates to @jarenjs/charts — same SVG, one pie engine for the whole suite.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'The Mermaid tab in the playground parses as you type — the rendered SVG, the geometry-free AST, the canonical toMermaid round-trip and (for state diagrams) the derived workflow JSON all come from one compiled document. The Benchmarks page has its coverage scorecard and parse-speed numbers.',
        href: '#/playground?engine=mermaid',
        link: 'Open the playground',
      },
    ],
  },
  {
    id: 'core', title: 'Core utilities',
    blocks: [
      p('Everything underneath, usable standalone: type guards, grapheme-aware Unicode strings, a large text-validation toolbox (emails, hostnames, IRIs, punycode, I-Regexp), RFC 3339 date-time parsing, fixed-width numeric ranges, a char-code scanner toolkit and asm.js-style int32/float64 math.'),
    ],
  },
  {
    id: 'calculator', title: 'Calculator',
    blocks: [
      p('A multi-mode calculator (standard/scientific/programmer/financial/converter) as an @jarenjs/app document, with x·y and x·y·z plots rendered as pure-vnode SVG. Its numeric kernel lives in @jarenjs/core: math (transcendentals, BigInt word math, root finders, a mat4/projection 3D kernel, number formatting), finance (TVM, NPV/IRR, amortization, bonds, indicators) and convert (fixed-factor units + the pure convertCurrency rate-table primitive). The expression engine is a two-stage compiler with a round-trip printer.'),
      code("import { evaluate, parseExpression, toExpression, plot2d, toSvgString } from '@jarenjs/calc';\nevaluate('sin(pi/2) + 2^10').value;          // 1025\ntoExpression(parseExpression('a-(b-c)'));    // 'a - (b - c)'\ntoSvgString(plot2d('sin(x)', { domain: [-6.28, 6.28] }));"),
      p('The converter’s currency dimension is the maturity example: live crypto+fiat rates flow through an @jarenjs/app effect and a when-gated poll (CoinGecko/Binance), while the pure conversion stays in @jarenjs/core/convert. A static fallback keeps it working offline.'),
    ],
  },
  {
    id: 'josl', title: 'JOSL & JSONX',
    blocks: [
      p("A strict TOML 1.0 superset with JavaScript's obvious values first-class — null, bigint, regexp, all four datetime flavours — plus a streamable [[]] root array. The parser passes the complete official toml-test suite in strict TOML mode, consumes chunk streams that may split any token, and reports document-order events with pointer-able paths."),
      code('# JOSL: TOML plus the obvious\nid = 123n\npattern = /^ok$/i\nmissing = null\n\n[[records]]\nname = "streaming"'),
      p('JSONX — the same extensions over JSON — streams too: createJsonxStreamReader is an incremental reader whose chunks may split any token (escapes mid-\\uXXXX, numbers, tru + e), with a strict-JSON mode that makes it a streaming JSON.parse. Both readers emit one unified pair event with absolute paths, so a consumer never branches on syntax.'),
      code("import { createJsonxStreamReader } from '@jarenjs/josl/jsonx-stream';\nconst reader = createJsonxStreamReader({ mode: 'json',\n  onEvent: (e) => e.type === 'pair' && console.log(e.path, e.value) });\nreader.feed('{\"run\": [{\"ops\": 61');   // any split point works\nreader.feed('200}]}');\nreader.end();                          // { run: [{ ops: 61200 }] }"),
    ],
  },
  {
    id: 'charts', title: 'Charts',
    blocks: [
      p('Headless charts: @jarenjs/charts compiles a definition document plus its data into a geometry-free AST (fractions, angles, unit coordinates — no pixels) and renders pure-vnode SVG through @jarenjs/view. Five types — pie, bar, line, scatter, candlestick — themed by host-linked tokens; the Benchmarks page charts and the mermaid pie are this engine.'),
      code("import { compileChart } from '@jarenjs/charts';\nconst compiled = compileChart({ type: 'pie', title: 'Pets',\n  slices: [{ label: 'Dogs', value: 40 }, { label: 'Cats', value: 25 }] });\ncompiled.ast;           // geometry-free JSON\ncompiled.toSvgString(); // standalone SVG"),
      p('The stream adapter turns the josl readers’ unified events into live chart data: records assemble as their fields arrive (path mode for one big document in chunks, document mode for many small messages), with ring-buffer eviction and identity-keyed memo re-renders. The playground replay demo and the Binance live feed are both this one code path.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'The Charts tab in the playground compiles definitions in JSON, JSONX or JOSL — flip stream to replay to watch a chart build chunk by chunk through the incremental reader, or go live on real Binance market data (opt-in).',
        href: '#/playground?engine=charts',
        link: 'Open the playground',
      },
    ],
  },
  {
    id: 'assistant', title: 'AI assistant',
    blocks: [
      p('@jarenjs/ai is browser-side AI that makes sense: one OpenAI-compatible chat client for OpenRouter, Ollama or LM Studio, bring-your-own-key, no server and no proxy. The playground assistant (the ✦ button, bottom-right) runs on it — describe what you want and it drives the playground for you.'),
      p('Tools are the point. Each playground engine is a tool declared with a JSON Schema, and Jaren validates the model’s own tool calls before they run — the suite guarding its own tools. A bounded agent loop keeps even small local models on the rails: malformed arguments and failing tools come back as readable results the model can correct, never crashes.'),
      code("import { createChatClient, createToolbox, createAgent } from '@jarenjs/ai';\n\nconst client = createChatClient({ provider: 'ollama', model: 'qwen3:4b' });\nconst toolbox = createToolbox();\ntoolbox.add({\n  name: 'lookup', description: 'Look up one record.',\n  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },\n  execute: ({ id }) => records.get(id) ?? { error: `no '${id}'` },\n});\nconst agent = createAgent({ client, toolbox, maxToolRounds: 5 });\nconst { message } = await agent.send(history, { onDelta: (t) => ui.stream(t) });"),
      p('The same tools publish over WebMCP (navigator.modelContext) with one call, so a browser-hosted agent drives the identical schema-guarded surface. The key stays in your browser, stored locally and sent only to the provider you choose.'),
      {
        kind: 'callout',
        title: 'Try it',
        text: 'Open the assistant (bottom-right), add your provider, model and — for OpenRouter — an API key in settings, then ask it to validate a schema or run any engine. Local runtimes need CORS enabled for this origin (Ollama: OLLAMA_ORIGINS; LM Studio: the server CORS toggle).',
        href: '#/playground',
        link: 'Open the playground',
      },
    ],
  },
  {
    id: 'further-reading', title: 'Further reading',
    blocks: [
      p('The language contracts live with their packages: QUERY-FORMAT.md, JSLT-FORMAT.md, XQUERY-FRONTEND.md, VIEW-FORMAT.md, APP-FORMAT.md, ERROR-MESSAGES.md and the JOSL FORMAT.md. The repository README maps the whole suite; benchmark/README.md documents how every number on this site is measured.'),
      note('The code is the reference', 'Every public function carries JSDoc. When in doubt, open the source — the packages are written to be read.'),
    ],
  },
];
