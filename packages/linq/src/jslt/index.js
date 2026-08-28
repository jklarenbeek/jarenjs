//@ts-check
/**
 * @file `@jarenjs/linq/jslt` — `$jslt` 0.1 stylesheets by code. Rule
 * bodies are callbacks captured over `$` through the chain's own
 * recording proxy, with `root`/`path` and the declared parameters as
 * typed externals; `apply()` spells the apply-templates operator and
 * `op()` any registered one; `rule()` and `stylesheet()` write the
 * rule object and the envelope of JSLT-FORMAT §2. The document is the
 * deliverable: plain, deep-frozen JSON that `compileJsltStylesheet`
 * takes unchanged; nothing here imports an engine. `body()` is the one
 * body-capture entry point the migration, flow and app pens reuse.
 */

export { body, apply, op } from './body.js';
export { rule, stylesheet } from './rules.js';
