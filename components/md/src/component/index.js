//@ts-check
/**
 * @file The Markdown VISUAL COMPONENT — part two of the package.
 *
 * Everything below this line is presentation glue; the engine
 * (`@jarenjs/md`) neither knows nor needs any of it. The component
 * layer packages the engine for hosts that render:
 *
 *  - `createMdComponent()` — a batteries-included bundle: a memoized
 *    `view()` projection for `@jarenjs/app` viewModels (reference-
 *    stable, so unchanged sources patch in O(1)), `effects` entries
 *    for the app effect registry (`md-load`, `md-parse`), and a
 *    `hydrate()` pass for app-managed DOM;
 *  - `styles/md.css` — the component's stylesheet (`.md` content
 *    rhythm, `tok-*` token colors, mermaid placeholder), light/dark.
 *
 * The boundary is deliberate: the engine stays a headless data
 * toolchain (text ↔ AST ↔ vnode values), the component owns defaults,
 * memoization policy, CSS and app-registry shapes. See
 * ARCHITECTURE.md §"Engine and component".
 */

import { createProjectionMemo } from '@jarenjs/view/helpers';
import { buildPluginTables } from '../parser.js';
import { compileMarkdown } from '../compiler.js';
import { loadMarkdown } from '../loader.js';
import { walkAst } from '../ast.js';
import { hashContent } from '../utils.js';
import { highlightPlugin } from '../plugins/highlight.js';

/**
 * @typedef {import('../ast.js').MdDocument} MdDocument
 * @typedef {import('../compiler.js').CompiledMd} CompiledMd
 * @typedef {import('../compiler.js').MdCompileOptions} MdCompileOptions
 */
/**
 * @typedef {MdCompileOptions & {
 *   base?: string | URL,
 *   fetch?: typeof globalThis.fetch,
 *   cache?: any,
 *   memoLimit?: number,
 *   onHydrateError?: (err: any) => void,
 * }} MdComponentOptions
 */
/**
 * The component bundle.
 * @typedef {object} MdComponent
 * @property {any[]} plugins the compiled-in plugin set
 * @property {(sourceOrDoc: any) => any} view memoized vnode projection
 * @property {(source: string) => CompiledMd} compile memoized compile
 * @property {Record<string, (props: any, dispatch: any) => any>} effects
 *   `md-load` and `md-parse` for `createApp({ effects })`
 * @property {(container: any) => void} hydrate run plugin hydrate hooks
 *   over already-mounted DOM (no-op without hydratable plugins)
 */

/**
 * Create the Markdown component: one object that plugs the engine
 * into an `@jarenjs/app` document (or any view-owning host).
 *
 * @example
 * const md = createMdComponent();
 * createApp(appDoc, {
 *   effects: { ...md.effects },
 *   viewModel: (state) => ({ ...state, article: md.view(state.articleSource) }),
 * });
 * // an action loads a document:
 * //   { "effects": [{ "run": "md-load", "with": { "url": "$.url", "done": "article/loaded" } }] }
 *
 * @param {MdComponentOptions} [options]
 * @returns {MdComponent}
 */
export function createMdComponent(options = {}) {
  const plugins = options.plugins ?? DEFAULT_PLUGINS;
  const compileOptions = { ...options, plugins };
  const memoLimit = options.memoLimit ?? 32;
  const tables = buildPluginTables(plugins);

  /** Content-hash → AST node, for hydratable plugin nodes. */
  /** @type {Map<string, any>} */
  const hydratable = new Map();
  /** @type {WeakMap<any, string>} */
  const hydrated = new WeakMap();
  const onHydrateError = options.onHydrateError
    // eslint-disable-next-line no-console -- the documented default sink
    ?? ((err) => console.error('md hydrate:', err));

  /**
   * Remember hydratable nodes of a document by content hash.
   * @param {MdDocument | any} doc
   */
  const indexHydratable = (doc) => {
    if (tables.hydrates.size === 0) return;
    walkAst(doc.ast ?? doc, (node) => {
      if (tables.hydrates.has(node.type) && typeof node.value === 'string') {
        hydratable.set(hashContent(node.value), node);
      }
    });
  };

  const { compile, view } = createProjectionMemo({
    memoLimit,
    compile: (source) => {
      const compiled = compileMarkdown(source, compileOptions);
      indexHydratable(compiled.doc);
      return compiled;
    },
    toVnode: (compiled) => compiled.toVnode(),
    docToVnode: (doc) => {
      const vnode = compileMarkdown(doc, compileOptions).toVnode();
      indexHydratable(doc);
      return vnode;
    },
  });

  /** @type {MdComponent} */
  const component = {
    plugins,

    compile,

    view,

    effects: {
      /**
       * Load a URL and dispatch the plain MdDocument:
       * `{ run: 'md-load', with: { url, done, error? } }`.
       */
      'md-load': (props, dispatch) =>
        loadMarkdown(props.url, {
          ...compileOptions,
          base: options.base,
          fetch: options.fetch,
          cache: options.cache,
        }).then(
          (compiled) => {
            indexHydratable(compiled.doc);
            dispatch(props.done, compiled.doc);
          },
          (err) => {
            if (props.error !== undefined) {
              dispatch(props.error, { url: String(props.url), message: String(err?.message ?? err) });
            }
            else {
              throw err;
            }
          },
        ),

      /**
       * Parse a source string and dispatch the plain MdDocument:
       * `{ run: 'md-parse', with: { source, done } }`.
       */
      'md-parse': (props, dispatch) => {
        dispatch(props.done, compile(String(props.source ?? '')).doc);
      },
    },

    hydrate(container) {
      if (tables.hydrates.size === 0) return;
      const marked = container.querySelectorAll('[data-md-hydrate]');
      for (const el of marked) {
        const name = el.getAttribute('data-md-hydrate');
        const hash = el.getAttribute('data-md-hash') ?? '';
        if (hydrated.get(el) === hash) continue;
        const node = hydratable.get(hash);
        if (node === undefined) continue;
        const plugin = tables.hydrates.get(node.type);
        if (plugin === undefined || plugin.name !== name) continue;
        hydrated.set(el, hash);
        try {
          const result = plugin.hydrate(el, node, { options, hash: hashContent });
          if (result !== undefined && result !== null && typeof result.catch === 'function') {
            result.catch(onHydrateError);
          }
        }
        catch (err) {
          onHydrateError(err);
        }
      }
    },
  };
  return component;
}

/**
 * The component's default plugin set: syntax highlighting on. A single
 * shared array so `buildPluginTables` (and every memo hanging off it)
 * compiles exactly once per process.
 */
export const DEFAULT_PLUGINS = [highlightPlugin()];
