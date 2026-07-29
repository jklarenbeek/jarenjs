//#region @jarenjs/emit
// Build-time artifacts from JSON documents.
//
// A JSON Schema is JSON, TypeScript is text, and JTLT is JSON-to-text — so
// generating a declaration file is a stylesheet, not a new engine. That is the
// whole idea of this package, and the reason it is `emit` rather than `infer`:
// swapping the stylesheet swaps the target language, and nothing else moves.
//
// Two stages, because a schema graph is not shaped like a declaration file:
//
//   schema ──▶ compileEmitModel ──▶ TYPE MODEL ──▶ stylesheet ──▶ artifact
//
// The type model is a published format, not a private intermediate: the
// bundled emitters have no privileged access to it, so a third-party emitter
// is exactly as capable as the ones shipped here.

export { compileEmitModel, EMIT_MODEL_VERSION } from './model.js';
export { emitTypeScript, renderTypeScript, TYPESCRIPT_STYLESHEET } from './typescript.js';
export { emitMarkdown, renderMarkdown, MARKDOWN_STYLESHEET } from './markdown.js';

//#endregion
