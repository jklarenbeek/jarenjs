//@ts-check
/**
 * The home page content — a content document, not markup. The `home`
 * view mode renders these nodes with JSLT rules; editing copy means
 * editing JSON.
 */

export const HOME_CONTENT = {
  hero: {
    title: 'JSON all the way down',
    lead: 'Jaren is a high-performance JSON toolchain: a conformance-scored JSON Schema validating compiler surrounded by compiled engines for JSON Pointer, JSONPath, an XQuery-semantics JSON query language, JSLT stylesheets, JTLT text templates (Markdown, XML, SQL DDL), schema-driven forms, a Markdown engine and a headless Mermaid diagram engine. Zero dependencies, eval-free, CSP-safe.',
    install: 'npm install @jarenjs/validate',
    // the first bullet is the conformance claim: the home derivation
    // replaces it with the run's measured score once meta.json lands,
    // and this figure-free wording is what a reader gets until then
    points: [
      'The official JSON-Schema-Test-Suite scored on every benchmarked draft — passes and failures alike',
      'Measured against Ajv test by test, with every ratio published in the direction it fell',
      'Every grammar published as JSON Schema for LLM constrained decoding',
    ],
  },
  engines: [
    { key: 'validate', title: 'JSON Schema', blurb: 'Compiles schemas to specialized closures: annotation-driven unevaluated* with statically-elided checks, dynamic refs, $data, the $query cross-field keyword and structured, localizable errors.', perf: 'scored on the official suite per draft; the Ajv ratio is measured, not claimed' },
    { key: 'path', title: 'JSONPath', blurb: 'The complete RFC 9535 grammar as a compiler — every case of the official compliance corpus scored, normalized paths included.', perf: 'scored on the whole official compliance corpus' },
    { key: 'pointer', title: 'JSON Pointer', blurb: 'RFC 6901 with zero-allocation compiled getters, plus relative pointers — the $data hot path.', perf: 'compiled getters, far ahead of the npm package' },
    { key: 'patch', title: 'JSON Patch', blurb: 'RFC 6902 and RFC 7396 as copy-on-write appliers: atomic, structure-sharing, and a change feed of written paths.', perf: 'measured against clone-and-interpret' },
    { key: 'query', title: 'JSON Query', blurb: 'XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, folds and windows — as JSON documents with JSONPath leaves. Uncorrelated equijoins are planned as hash joins, and only where the rewrite is provably invisible.', perf: 'measured against fontoxpath and JSONata' },
    { key: 'jslt', title: 'JSLT', blurb: 'The stylesheet layer: JSONPath matches position, JSON Schema matches shape, query documents produce output. Identity transforms return the input reference. Operator packs register more — createJsltRegistry().use(mathPack)… adds $npv, $mean, $sqrt to JSLT, query and linq, and over @jarenjs/db the scalar subset pushes to SQLite as UDFs.', perf: 'proof-of-no-change without rebuilding the document; host operator packs are opt-in' },
    { key: 'jtlt', title: 'JTLT', blurb: 'The text sibling of JSLT: template rules render JSON as Markdown, XML or source code — schema-matched rules turn one table document into SQLite or PostgreSQL DDL, and the xml method escapes interpolated data while literal markup passes raw.', perf: 'a front-end, not a second engine: compiles to JSLT' },
    { key: 'forms', title: 'Forms', blurb: 'JSON Schema to a framework-agnostic field tree with three validation layers on one stack — per keystroke, cross-field, and authoritative on submit.', perf: 'this site renders forms with it' },
    { key: 'josl', title: 'JOSL', blurb: 'A strict TOML 1.0 superset with JavaScript-obvious values and streaming document-order events. The only engine in our benchmark passing the full toml-test suite — and the same reader family streams JSONX, strict JSON and CSV. Opt into detach and a record is handed over and forgotten, so a document larger than memory reads in a flat 0.1 MB.', perf: 'scored on the whole toml-test corpus' },
    { key: 'csv', title: 'CSV', blurb: 'RFC 4180 strict by default, and self-healing on demand: an unclosed quote, a stray quote inside a value or a ragged row is read the way that loses the least — and every fix is reported with a code, a line and a column, where other parsers heal silently or reject the file. Wholesale and chunk-streaming share one grammar path.', perf: 'reports what it repaired, instead of guessing quietly' },
    { key: 'charts', title: 'Charts', blurb: 'Headless SVG charts from JSON/JSONX/JOSL definitions: geometry-free ASTs, thirteen chart types from pie to GeoJSON maps, schema-validated, and a stream adapter that builds charts live from the incremental readers — replay a document chunk by chunk, or go live on real market data.', perf: 'incremental ticks that stay flat as the series grows' },
    { key: 'markdown', title: 'Markdown', blurb: 'The inverse of JTLT: CommonMark + GFM + frontmatter parsed into a JSON AST — transformed by JSLT, rendered by @jarenjs/view with content-hash keys and structural sharing. Ships an app-ready visual component.', perf: 'measured against marked, markdown-it and micromark; constant-time re-render' },
    { key: 'mermaid', title: 'Mermaid', blurb: 'A native, headless Mermaid clone: diagrams-as-code parsed to a geometry-free JSON AST and rendered as pure-vnode SVG through @jarenjs/view — SSR-able with no browser, structurally shared, bidirectional (parseMermaid ⇄ toMermaid).', perf: 'headless SVG, constant-time re-render' },
    { key: 'calc', title: 'Calculator', blurb: 'A multi-mode calculator (standard / scientific / programmer / financial / converter) as an @jarenjs/app document: a two-stage expression compiler (parseExpression ⇄ toExpression), x·y/x·y·z plots as pure-vnode SVG, and a pure numeric kernel pushed down into @jarenjs/core (math/finance/convert).', perf: 'apps as JSON, eval-free, SSR-able' },
    { key: 'view', title: 'View', blurb: 'UIs as JSON: the tagged-array vnode format, a keyed DOM patcher that skips unchanged subtrees in O(1), an SSR serializer and a registered-widget escape hatch for irreducibly imperative islands. The grammar ships as JSON Schema, so a constrained decoder cannot emit a structurally invalid interface — and an opt-in safe-render profile sanitizes an untrusted one. Running a view as data costs engine time against a hand-written build, and the benchmark publishes that price beside the win.', perf: 'hand-written vnodes outbuild the mainstream frameworks; the stylesheet pays for views-as-data — both published' },
    { key: 'app', title: 'App', blurb: 'Whole applications as one JSON document: state, a JSLT stylesheet for the view, query documents for actions, JSON Patch transitions and subscriptions with an EBV liveness query. Everything compiles once at createApp; the running loop only calls specialized closures.', perf: 'this site and the Studio are both app documents' },
    { key: 'contract', title: 'Contract', blurb: 'One document declares your JSON-in/JSON-out operations — kind, policy, HTTP binding — and compiles once into validators, transport normalizers and a static-beats-variable path matcher. The same contract serves over HTTP, in-process through the local binding, and across a MessagePort or a worker, binds into an @jarenjs/app document as generated task slots, and projects to OpenAPI 3.1, TypeScript, Markdown and AI tool definitions from the one source.', perf: 'measured against a hand-composed router doing the same work — the dispatch loss published beside the wins' },
    { key: 'flow', title: 'Flow', blurb: 'Executable workflows as JSON: jaren-fsm state machines compiled to a pure step function, and jaren-dag dataflow over the suite’s own engines. Guards are query documents, effects come back as data, and @jarenjs/mermaid projects a diagram both ways — the Flow studio edits, runs and animates them live.', perf: 'a machine survives a JSON round trip with its guards; XState’s functions do not' },
    { key: 'linq', title: 'LINQ', blurb: 'C#-familiar fluent chains whose output is a plain query document: a recording proxy captures the callback, the emitter folds stages into one FLWOR document, and the same chain runs in memory, over streams (one bounded mapAsync boundary), or pushed to SQL through the provider seam.', perf: 'one operator set, byte-identical documents through the sync and async drivers' },
    { key: 'db', title: 'Data', blurb: 'Documents AND entities in SQLite behind driver and dialect seams: a pushdown planner that renders guarded parameter-bound SQL, one-statement graph loads, a copy-on-write unit of work with optimistic concurrency, generated entity types, and a jaren-db CLI whose migrations rebuild tables the documented twelve-step way.', perf: 'the two-level graph load runs in ONE statement; statement counts published beside every timing' },
    { key: 'ai', title: 'AI', blurb: 'Browser-side AI with bring-your-own-key: one OpenAI-compatible client (OpenRouter / Ollama / LM Studio), an incremental SSE decoder, retry with Retry-After, structured output with local-validation repair, token-budget compaction, a bounded agent loop and WebMCP registration.', perf: 'tool calls validated by Jaren before they run' },
  ],
  ai: {
    title: 'Built for the LLM era',
    lead: 'Tool definitions are JSON Schema. Structured output is JSON Schema. Jaren is the infrastructure on the receiving end:',
    points: [
      'Validate generations locally and strictly — sub-microsecond per document once compiled',
      'Closed vocabularies published as JSON Schema: a constrained decoder cannot emit a structurally invalid query, stylesheet — or, on this site, UI (a safe-render profile handles the untrusted case)',
      'Machine-repairable failures: stable codes plus a docPath pointer into the offending document',
    ],
  },
  studio: {
    title: 'The Studio: one prompt → website',
    lead: 'A second, self-authored app document hosted next to the site\'s own: you — or the AI assistant — author a complete Jaren application as one JSON value, the jaren-app meta-schema gates every boot structurally, and the real app runtime runs it live. The AI writes JSON; Jaren validates its shape (a structural gate, not a sanitizer: an app document names host actions and effects, so this is for self-authored apps, not untrusted input). No eval, no server, no scaffolding.',
  },
  meta: {
    title: 'This site is the demo',
    lead: 'You are looking at an application whose state, view and actions are one JSON document: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, and Play’s generated form is rendered by the standard forms stylesheet. No framework, no eval — the suite, all the way down.',
  },
};
