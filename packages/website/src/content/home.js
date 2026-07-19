//@ts-check
/**
 * The home page content — a content document, not markup. The `home`
 * view mode renders these nodes with JSLT rules; editing copy means
 * editing JSON.
 */

export const HOME_CONTENT = {
  hero: {
    title: 'JSON all the way down',
    lead: 'Jaren is a high-performance JSON toolchain: a fully conformant JSON Schema validating compiler surrounded by compiled engines for JSON Pointer, JSONPath, an XQuery-semantics JSON query language, JSLT stylesheets, schema-driven forms, a Markdown engine and a headless Mermaid diagram engine. Zero dependencies, eval-free, CSP-safe.',
    install: 'npm install @jarenjs/validate',
    points: [
      '100% of the official JSON-Schema-Test-Suite, all benchmarked drafts',
      'Faster than Ajv on the majority of individual tests per draft',
      'Every grammar published as JSON Schema for LLM constrained decoding',
    ],
  },
  engines: [
    { key: 'validate', title: 'JSON Schema', blurb: 'Compiles schemas to specialized closures: annotation-driven unevaluated*, dynamic refs, $data, the $query cross-field keyword and structured, localizable errors.', perf: '308–433 suite tests per draft, 0 failures' },
    { key: 'path', title: 'JSONPath', blurb: 'The complete RFC 9535 grammar as a compiler — all 703 compliance tests pass, normalized paths included.', perf: '18.7× faster than json-p3 on the CTS mean' },
    { key: 'pointer', title: 'JSON Pointer', blurb: 'RFC 6901 with zero-allocation compiled getters, plus relative pointers — the $data hot path.', perf: '37 ns on escaped keys vs 548 ns npm' },
    { key: 'patch', title: 'JSON Patch', blurb: 'RFC 6902 and RFC 7396 as copy-on-write appliers: atomic, structure-sharing, and a change feed of written paths.', perf: '5–170× vs clone-and-interpret' },
    { key: 'query', title: 'Jaren JSON Query', blurb: 'XQuery 3.1 semantics — FLWOR, joins, grouping, quantifiers — as JSON documents with JSONPath leaves.', perf: '14–215× vs fontoxpath, 10–63× vs JSONata' },
    { key: 'jslt', title: 'JSLT', blurb: 'The stylesheet layer: JSONPath matches position, JSON Schema matches shape, query documents produce output. Identity transforms return the input reference.', perf: 'proof-of-no-change in 24–81 ns' },
    { key: 'forms', title: 'Forms', blurb: 'JSON Schema to a framework-agnostic field tree with three validation layers on one stack — per keystroke, cross-field, and authoritative on submit.', perf: 'this site renders forms with it' },
    { key: 'josl', title: 'JOSL', blurb: 'A strict TOML 1.0 superset with JavaScript-obvious values and streaming document-order events. The only engine in our benchmark passing the full toml-test suite.', perf: '694/694 toml-test 1.0.0' },
    { key: 'markdown', title: 'Markdown', blurb: 'The inverse of JTLT: CommonMark + GFM + frontmatter parsed into a JSON AST — transformed by JSLT, rendered by @jarenjs/view with content-hash keys and structural sharing. Ships an app-ready visual component.', perf: 'within 1.1–1.5× of marked, O(1) re-render' },
    { key: 'mermaid', title: 'Mermaid', blurb: 'A native, headless Mermaid clone: diagrams-as-code parsed to a geometry-free JSON AST and rendered as pure-vnode SVG through @jarenjs/view — SSR-able with no browser, structurally shared, bidirectional (parseMermaid ⇄ toMermaid).', perf: 'headless SVG, O(1) re-render' },
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
  meta: {
    title: 'This site is the demo',
    lead: 'You are looking at an application whose state, view and actions are one JSON document: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, and the playground form is rendered by the standard forms stylesheet. No framework, no eval — the suite, all the way down.',
  },
};
