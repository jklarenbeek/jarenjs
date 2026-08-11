//@ts-check
/**
 * @file Plugin registry helpers and the reference plugins.
 *
 * A plugin is data, validated and frozen at definition time; the
 * parser and vnode emitter bake plugin arrays into dispatch tables at
 * compile time (the normative contract lives in docs/PLUGINS.md).
 */

const RE_KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * @typedef {object} MdPlugin
 * @property {string} name unique kebab-case identifier
 * @property {string[]} [fences] fenced-code claims by info-string first word
 * @property {any[]} [blocks] block rule descriptors ({ chars, start, continue, close })
 * @property {any[]} [inlines] inline rule descriptors ({ char, scan })
 * @property {string} [node] the AST type this plugin emits/renders
 * @property {(node: any, h: any, ctx: any) => any} [render] pure vnode renderer
 * @property {(node: any, ctx: any) => string} [toHtml] pure HTML-string
 *   renderer, for `toHtml`. Independent of `render`: a plugin may serve
 *   one emitter, the other, or both (docs/PLUGINS.md §5.1)
 * @property {(el: any, node: any, ctx: any) => any} [hydrate] browser-only upgrade
 */

/**
 * Validate and freeze a plugin spec (docs/PLUGINS.md §1).
 * @param {MdPlugin} spec
 * @returns {MdPlugin}
 */
export function definePlugin(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError('md plugin: spec must be an object');
  }
  if (typeof spec.name !== 'string' || !RE_KEBAB.test(spec.name)) {
    throw new TypeError(`md plugin: name must be kebab-case, got '${spec.name}'`);
  }
  if (spec.fences !== undefined) {
    if (!Array.isArray(spec.fences) || spec.fences.some((f) => typeof f !== 'string')) {
      throw new TypeError(`md plugin '${spec.name}': fences must be an array of strings`);
    }
    Object.freeze(spec.fences);
  }
  if (spec.blocks !== undefined) {
    for (const rule of spec.blocks) {
      if (typeof rule.chars !== 'string' || rule.chars.length === 0
        || typeof rule.start !== 'function' || typeof rule.continue !== 'function') {
        throw new TypeError(`md plugin '${spec.name}': block rules need chars, start and continue`);
      }
      Object.freeze(rule);
    }
    Object.freeze(spec.blocks);
  }
  if (spec.inlines !== undefined) {
    for (const rule of spec.inlines) {
      if (typeof rule.char !== 'string' || rule.char.length !== 1
        || typeof rule.scan !== 'function') {
        throw new TypeError(`md plugin '${spec.name}': inline rules need a single char and scan`);
      }
      Object.freeze(rule);
    }
    Object.freeze(spec.inlines);
  }
  if ((spec.fences !== undefined || spec.node !== undefined)
    && spec.render !== undefined && typeof spec.render !== 'function') {
    throw new TypeError(`md plugin '${spec.name}': render must be a function`);
  }
  if (spec.toHtml !== undefined && typeof spec.toHtml !== 'function') {
    throw new TypeError(`md plugin '${spec.name}': toHtml must be a function`);
  }
  return Object.freeze(spec);
}

export { highlightPlugin, tokenizeCode, GRAMMAR_NAMES } from './highlight.js';
export { mermaidPlugin } from './mermaid.js';
