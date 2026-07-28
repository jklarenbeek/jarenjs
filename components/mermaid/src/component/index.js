//@ts-check
/**
 * @file The Mermaid VISUAL COMPONENT — part two of the package.
 *
 * Everything below this line is presentation glue; the engine
 * (`@jarenjs/mermaid`) neither knows nor needs any of it. Mirrors
 * `@jarenjs/md`'s `createMdComponent` field-for-field:
 *
 *  - `createMermaidComponent()` — a memoized `view()` projection for
 *    `@jarenjs/app` viewModels (reference-stable, so an unchanged source
 *    patches in O(1) — the O(change) contract), `effects` entries for
 *    the app effect registry (`mermaid-render`, `mermaid-load`), and a
 *    `hydrate()` pass kept for API symmetry (a no-op in v1: the render is
 *    already complete);
 *  - `styles/mermaid.css` — the component stylesheet.
 *
 * The boundary is one-way: the component imports the engine, never the
 * reverse.
 */

import { createProjectionMemo } from '@jarenjs/view/helpers';
import { compileMermaid, diagramToVnode } from '../index.js';

/**
 * @typedef {object} MermaidComponentOptions
 * @property {any} [theme] theme name or override object
 * @property {number} [memoLimit] LRU size for the source-string memo (default 32)
 * @property {string | URL} [base] base URL for `mermaid-load`
 * @property {typeof globalThis.fetch} [fetch] fetch implementation for `mermaid-load`
 * @property {(err: any) => void} [onHydrateError]
 */
/**
 * @typedef {object} MermaidComponent
 * @property {(source: string) => any} compile memoized compile
 * @property {(sourceOrDoc: any) => any} view memoized vnode projection
 * @property {Record<string, (props: any, dispatch: any) => any>} effects
 * @property {(container: any) => void} hydrate no-op in v1
 */

/**
 * Create the Mermaid component.
 *
 * @example
 * const mermaid = createMermaidComponent();
 * createApp(appDoc, {
 *   effects: { ...mermaid.effects },
 *   viewModel: (state) => ({ ...state, diagram: mermaid.view(state.source) }),
 * });
 *
 * @param {MermaidComponentOptions} [options]
 * @returns {MermaidComponent}
 */
export function createMermaidComponent(options = {}) {
  const compileOptions = { theme: options.theme };

  const { compile, view } = createProjectionMemo({
    memoLimit: options.memoLimit ?? 32,
    compile: (source) => compileMermaid(source, compileOptions),
    toVnode: (compiled) => compiled.toVnode(),
    docToVnode: (doc) => diagramToVnode(doc, compileOptions),
  });

  return {
    compile,

    view,

    effects: {
      /**
       * Render an in-state source to an SVG vnode and dispatch it:
       * `{ run: 'mermaid-render', with: { source, done } }`.
       */
      'mermaid-render': (props, dispatch) => {
        dispatch(props.done, compile(String(props.source ?? '')).toVnode());
      },

      /**
       * Fetch a `.mmd`/`.mermaid` URL and dispatch the DiagramDocument:
       * `{ run: 'mermaid-load', with: { url, done, error? } }`.
       */
      'mermaid-load': (props, dispatch) => {
        const f = options.fetch ?? globalThis.fetch;
        const url = options.base ? new URL(String(props.url), options.base).href : String(props.url);
        return f(url).then(
          (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            return res.text();
          },
        ).then(
          (text) => dispatch(props.done, compile(text).doc),
          (err) => {
            if (props.error !== undefined) {
              dispatch(props.error, { url, message: String(err?.message ?? err) });
            }
            else {
              throw err;
            }
          },
        );
      },
    },

    // Render is complete; hydrate is reserved for optional
    // client-only enhancements (pan/zoom) that are out of scope for v1.
    hydrate() {
      /* no-op */
    },
  };
}
