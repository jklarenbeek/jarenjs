//@ts-check
/**
 * @file The projections of a compiled contract (`@jarenjs/contract/project`):
 * `publicProjection` (the browser-safe subset — itself a `$contract`
 * document, and what the revision hashes), `toOpenApi` (OpenAPI 3.1
 * through a JSLT stylesheet), `toTypeScript` and `toMarkdown` (on
 * `@jarenjs/emit`'s type model), `contractTools` (`@jarenjs/ai` tool
 * definitions, no import edge) and the same-document bundler they share.
 * This is the one subpath that imports `@jarenjs/emit`; a consumer that
 * never imports it never loads it.
 */

export { publicProjection } from '../public.js';
export { toOpenApi } from './openapi.js';
export { toTypeScript } from './typescript.js';
export { toMarkdown } from './markdown.js';
export { contractTools } from './tools.js';
export { reachableDefs, bundleSameDocument } from '../bundle.js';

/**
 * @typedef {import('../public.js').PublicProjectionOptions} PublicProjectionOptions
 * @typedef {import('./openapi.js').OpenApiOptions} OpenApiOptions
 * @typedef {import('./openapi.js').OpenApiResult} OpenApiResult
 * @typedef {import('./openapi.js').DroppedKeyword} DroppedKeyword
 * @typedef {import('./typescript.js').TypeScriptOptions} TypeScriptOptions
 * @typedef {import('./markdown.js').MarkdownOptions} MarkdownOptions
 * @typedef {import('./tools.js').ToolDefinition} ToolDefinition
 * @typedef {import('./tools.js').ContractToolsOptions} ContractToolsOptions
 */
