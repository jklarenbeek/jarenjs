//@ts-check
/**
 * The home page content the SITE owns — a content document, not markup.
 * The `home` view mode renders these nodes with JSLT rules; editing copy
 * means editing JSON.
 *
 * No engine card is here: every one of them is written by the workspace
 * that publishes the engine and collected by the build, so the grid a
 * reader sees is the packages' own words. What stays is what describes
 * the SITE — the hero, and the three blocks about what this page is.
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
  ai: {
    title: 'Built for the LLM era',
    lead: 'Tool definitions are JSON Schema. Structured output is JSON Schema. Jaren is the infrastructure on the receiving end:',
    points: [
      'Validate generations locally and strictly — sub-microsecond per document once compiled',
      'Closed vocabularies published as JSON Schema: use a constrained decoder, then validate locally against the canonical grammar and compile before execution',
      'Machine-repairable failures: stable codes plus a docPath pointer into the offending document',
    ],
  },
  studio: {
    title: 'The Studio: documents that run',
    lead: 'A second, self-authored app document hosted next to the site\'s own: you author a complete Jaren application as one JSON value, the jaren-app meta-schema gates every boot structurally, and the real app runtime runs it live. Jaren validates the document’s shape (a structural gate, not a sanitizer: an app document names host actions and effects, so this is for self-authored apps, not untrusted input). No eval, no server, no scaffolding.',
  },
  meta: {
    title: 'This site is the demo',
    lead: 'You are looking at an application whose state, view and actions are one JSON document: the view is a JSLT stylesheet producing vnodes, actions are query documents producing JSON Patches, and Play’s generated form is rendered by the standard forms stylesheet. No framework, no eval — the suite, all the way down.',
  },
};
