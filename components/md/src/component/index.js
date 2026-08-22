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

import { createBoundedCache } from '@jarenjs/core/cache';
import { createProjectionMemo } from '@jarenjs/view/helpers';
import { buildPluginTables } from '../parser.js';
import { compileMarkdown } from '../compiler.js';
import { mdToVnode } from '../to-vnode.js';
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
 *   policyLimit?: number,
 *   onHydrateError?: (err: any) => void,
 * }} MdComponentOptions
 */
/**
 * The rendering policy a single `view()` call may name, for a host that
 * renders documents of different PROVENANCE through one component. Only
 * the options that shape the emitted vnode belong here — the parse is
 * provenance-independent, and `plugins`/`sanitizeUrl` are the
 * construction-time decisions a per-call override would quietly undo.
 *
 * The live case is heading ids: repo-authored Markdown is trusted with
 * the ids it mints, and text from anywhere else must not mint bare ids
 * into a page that owns ids of its own — so it renders with a
 * `slugPrefix`. Footnote ids already default to `user-content-`
 * (MD-FORMAT §4.6) and are unaffected.
 *
 * @typedef {object} MdRenderPolicy
 * @property {boolean} [headingIds] mint an `id` on every heading
 * @property {string} [slugPrefix] prepended to every emitted heading id
 *   and to the anchor href beside it (`''` opts out)
 * @property {boolean} [headingAnchors] emit the copy-a-link anchor
 * @property {string} [footnotesLabel] the footnote section's heading
 * @property {'skip'|'text'} [html] what to do with raw HTML
 * @property {boolean} [keyed] emit patcher keys on block children
 */
/**
 * The component bundle.
 * @typedef {object} MdComponent
 * @property {any[]} plugins the compiled-in plugin set
 * @property {(sourceOrDoc: any, policy?: MdRenderPolicy) => any} view
 *   memoized vnode projection, per source AND policy
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

  const { compile, view: viewDefault } = createProjectionMemo({
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

  // One projection memo per named policy, on top of the one compile
  // memo above: parsing is provenance-independent, so a second policy
  // costs a second vnode and nothing else. Bounded because a caller
  // that mints a policy per call would otherwise retain every variant
  // it ever rendered; a host names two or three provenances, not
  // hundreds.
  /** @type {import('@jarenjs/core/cache').BoundedCache<string, any>} */
  const variants = createBoundedCache(options.policyLimit ?? 8);

  /**
   * The projection memo for one policy. Reference stability is the whole
   * contract, so the vnode is cached against the compiled document the
   * shared memo already returns — `mdToVnode` is called once per
   * (document, policy), never once per render.
   * @param {MdRenderPolicy} policy
   */
  const buildVariant = (policy) => {
    const renderOptions = {
      plugins: compileOptions.plugins,
      html: compileOptions.html,
      sanitizeUrl: compileOptions.sanitizeUrl,
      headingIds: compileOptions.headingIds,
      slugPrefix: compileOptions.slugPrefix,
      headingAnchors: compileOptions.headingAnchors,
      footnotesLabel: compileOptions.footnotesLabel,
      keyed: compileOptions.keyed,
      ...policy,
    };
    /** @type {WeakMap<any, any>} compiled document → its vnode */
    const vnodes = new WeakMap();
    const project = (/** @type {any} */ compiled) => {
      let vnode = vnodes.get(compiled);
      if (vnode === undefined) {
        vnode = mdToVnode(compiled, renderOptions);
        vnodes.set(compiled, vnode);
      }
      return vnode;
    };
    return createProjectionMemo({
      memoLimit,
      compile,
      toVnode: project,
      docToVnode: (doc) => {
        indexHydratable(doc);
        return project(compileMarkdown(doc, compileOptions));
      },
    });
  };

  /** @type {MdComponent['view']} */
  const view = (sourceOrDoc, policy) => {
    if (policy === undefined || policy === null) return viewDefault(sourceOrDoc);
    const key = policyKey(policy);
    if (key === '') return viewDefault(sourceOrDoc);
    return variants.getOrCreate(key, () => buildVariant(policy)).view(sourceOrDoc);
  };

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
 * The option names a per-call {@link MdRenderPolicy} may carry. Anything
 * else is refused rather than ignored: a policy naming `plugins` would
 * silently render under the construction-time set, which is exactly the
 * kind of quiet disagreement the per-call policy exists to end.
 */
const POLICY_OPTIONS = new Set([
  'headingIds', 'slugPrefix', 'headingAnchors', 'footnotesLabel', 'html', 'keyed',
]);

/**
 * A policy's cache key: its members in name order, so two spellings of
 * the same policy share one memo. An empty key means the policy named
 * nothing and the construction-time defaults answer it.
 * @param {MdRenderPolicy} policy
 * @returns {string}
 * @throws {TypeError} when the policy names an option it may not set.
 */
function policyKey(policy) {
  let key = '';
  for (const name of Object.keys(policy).sort()) {
    if (!POLICY_OPTIONS.has(name)) {
      throw new TypeError(`md view policy: '${name}' is not a rendering option `
        + `(${[...POLICY_OPTIONS].join(', ')})`);
    }
    const value = /** @type {any} */ (policy)[name];
    if (value === undefined) continue;
    key += `${name}=${JSON.stringify(value)};`;
  }
  return key;
}

/**
 * The component's default plugin set: syntax highlighting on. A single
 * shared array so `buildPluginTables` (and every memo hanging off it)
 * compiles exactly once per process.
 */
export const DEFAULT_PLUGINS = [highlightPlugin()];
