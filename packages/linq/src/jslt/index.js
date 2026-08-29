//@ts-check
/**
 * @file `@jarenjs/linq/jslt` — `$jslt` 0.1 stylesheets by code. Rule
 * bodies are callbacks captured over `$` through the chain's own
 * recording proxy, with `root`/`path` and the declared parameters as
 * typed externals; `apply()` spells the apply-templates operator and
 * `op()` any registered one; `rule()` and `stylesheet()` write the
 * rule object and the envelope of JSLT-FORMAT §2. The document is the
 * deliverable: plain, deep-frozen JSON that `compileJsltStylesheet`
 * takes unchanged; nothing here imports an engine. `body()` is the
 * migration pen's body-capture entry point too (a `jslt` step's body
 * binds the same `root`/`path`); the flow and app pens capture through
 * `captureQuery` directly, because their evaluators bind nothing and a
 * body's two reserved names would be a promise neither engine keeps.
 */

export { body, apply, op } from './body.js';
export { rule, stylesheet } from './rules.js';
