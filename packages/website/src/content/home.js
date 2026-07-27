//@ts-check
/**
 * The home page content — a content document, not markup. The `home`
 * view mode renders these nodes with JSLT rules; editing copy means
 * editing JSON.
 */

export const HOME_CONTENT = {
  hero: {
    title: 'JSON all the way down',
    lead: 'Jaren is a high-performance JSON toolchain: a fully conformant JSON Schema validating compiler surrounded by compiled engines for JSON Pointer, JSONPath, an XQuery-semantics JSON query language, JSLT stylesheets, JTLT text templates (Markdown, XML, SQL DDL), schema-driven forms, a Markdown engine and a headless Mermaid diagram engine. Zero dependencies, eval-free, CSP-safe.',
    install: 'npm install @jarenjs/validate',
    points: [
      '100% of the official JSON-Schema-Test-Suite, all benchmarked drafts',
      'Faster than Ajv on roughly 4 of 5 individual tests per draft, ≈2× faster on the suite totals',
      'Every grammar published as JSON Schema for LLM constrained decoding',
    ],
  },
  engines: [
    { key: 'validate', title: 'JSON Schema', blurb: 'Compiles schemas to specialized closures: annotation-driven unevaluated* with statically-elided checks, dynamic refs, $data, the $query cross-field keyword and structured, localizable errors.', perf: '0 failures on every draft, ≈2× Ajv where both pass' },
    { key: 'path', title: 'JSONPath', blurb: 'The complete RFC 9535 grammar as a compiler — all 703 compliance tests pass, normalized paths included.', perf: 'all 703 RFC 9535 compliance tests pass' },
    { key: 'pointer', title: 'JSON Pointer', blurb: 'RFC 6901 with zero-allocation compiled getters, plus relative pointers — the $data hot path.', perf: 'compiled getters, far ahead of the npm package' },
    { key: 'patch', title: 'JSON Patch', blurb: 'RFC 6902 and RFC 7396 as copy-on-write appliers: atomic, structure-sharing, and a change feed of written paths.', perf: '5–170× vs clone-and-interpret' },
    { key: 'query', title: 'Jaren JSON Query', blurb: 'XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers, folds and windows — as JSON documents with JSONPath leaves. Uncorrelated equijoins are planned as hash joins, and only where the rewrite is provably invisible.', perf: '17–259× vs fontoxpath, 7–53× vs JSONata' },
    { key: 'jslt', title: 'JSLT', blurb: 'The stylesheet layer: JSONPath matches position, JSON Schema matches shape, query documents produce output. Identity transforms return the input reference.', perf: 'proof-of-no-change in 24–81 ns' },
    { key: 'jtlt', title: 'JTLT', blurb: 'The text sibling of JSLT: template rules render JSON as Markdown, XML or source code — schema-matched rules turn one table document into SQLite or PostgreSQL DDL, and the xml method escapes interpolated data while literal markup passes raw.', perf: 'a front-end, not a second engine: compiles to JSLT' },
    { key: 'forms', title: 'Forms', blurb: 'JSON Schema to a framework-agnostic field tree with three validation layers on one stack — per keystroke, cross-field, and authoritative on submit.', perf: 'this site renders forms with it' },
    { key: 'josl', title: 'JOSL', blurb: 'A strict TOML 1.0 superset with JavaScript-obvious values and streaming document-order events. The only engine in our benchmark passing the full toml-test suite — and the same reader family streams JSONX, strict JSON and CSV. Opt into detach and a record is handed over and forgotten, so a document larger than memory reads in a flat 0.1 MB.', perf: '694/694 toml-test 1.0.0' },
    { key: 'csv', title: 'CSV', blurb: 'RFC 4180 strict by default, and self-healing on demand: an unclosed quote, a stray quote inside a value or a ragged row is read the way that loses the least — and every fix is reported with a code, a line and a column, where other parsers heal silently or reject the file. Wholesale and chunk-streaming share one grammar path.', perf: 'reports what it repaired, instead of guessing quietly' },
    { key: 'charts', title: 'Charts', blurb: 'Headless SVG charts from JSON/JSONX/JOSL definitions: geometry-free ASTs, thirteen chart types from pie to GeoJSON maps, schema-validated, and a stream adapter that builds charts live from the incremental readers — replay a document chunk by chunk, or go live on real market data.', perf: 'incremental ticks that stay flat as the series grows' },
    { key: 'markdown', title: 'Markdown', blurb: 'The inverse of JTLT: CommonMark + GFM + frontmatter parsed into a JSON AST — transformed by JSLT, rendered by @jarenjs/view with content-hash keys and structural sharing. Ships an app-ready visual component.', perf: 'within 1.1–1.5× of marked, O(1) re-render' },
    { key: 'mermaid', title: 'Mermaid', blurb: 'A native, headless Mermaid clone: diagrams-as-code parsed to a geometry-free JSON AST and rendered as pure-vnode SVG through @jarenjs/view — SSR-able with no browser, structurally shared, bidirectional (parseMermaid ⇄ toMermaid).', perf: 'headless SVG, O(1) re-render' },
    { key: 'calc', title: 'Calculator', blurb: 'A multi-mode calculator (standard / scientific / programmer / financial / converter) as an @jarenjs/app document: a two-stage expression compiler (parseExpression ⇄ toExpression), x·y/x·y·z plots as pure-vnode SVG, and a pure numeric kernel pushed down into @jarenjs/core (math/finance/convert).', perf: 'apps as JSON, eval-free, SSR-able' },
    { key: 'view', title: 'View', blurb: 'UIs as JSON: the tagged-array vnode format, a keyed DOM patcher that skips unchanged subtrees in O(1), an SSR serializer and a registered-widget escape hatch for irreducibly imperative islands. The grammar ships as JSON Schema, so a constrained decoder cannot emit an invalid interface.', perf: 'O(1) re-render of unchanged trees — and slower than preact at building them' },
    { key: 'app', title: 'App', blurb: 'Whole applications as one JSON document: state, a JSLT stylesheet for the view, query documents for actions, JSON Patch transitions and subscriptions with an EBV liveness query. Everything compiles once at createApp; the running loop only calls specialized closures.', perf: 'this site and the Studio are both app documents' },
    { key: 'ai', title: 'AI', blurb: 'Browser-side AI with bring-your-own-key: one OpenAI-compatible client (OpenRouter / Ollama / LM Studio), an incremental SSE decoder, retry with Retry-After, structured output with local-validation repair, token-budget compaction, a bounded agent loop and WebMCP registration.', perf: 'tool calls validated by Jaren before they run' },
  ],
  ai: {
    title: 'Built for the LLM era',
    lead: 'Tool definitions are JSON Schema. Structured output is JSON Schema. Jaren is the infrastructure on the receiving end:',
    points: [
      'Validate generations locally and strictly — sub-microsecond per document once compiled',
      'Closed vocabularies published as JSON Schema: a constrained decoder cannot emit an invalid query, stylesheet — or, on this site, an invalid UI',
      'Machine-repairable failures: stable codes plus a docPath pointer into the offending document',
    ],
  },
  studio: {
    title: 'The Studio: one prompt → website',
    lead: 'A second, untrusted app document hosted next to the site\'s own: you — or the AI assistant — author a complete Jaren application as one JSON value, the jaren-app meta-schema gates every boot, and the real app runtime runs it live. The AI writes JSON; Jaren validates it. No eval, no server, no scaffolding.',
  },
  meta: {
    title: 'This site is the demo',
    lead: 'You are looking at an application whose state, view and actions are one JSON document: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, and the playground form is rendered by the standard forms stylesheet. No framework, no eval — the suite, all the way down.',
  },
};
