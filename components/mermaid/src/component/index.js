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
 *    `hydrate()` kept for API symmetry (a no-op: the render is already
 *    complete; pan, zoom and touch are the opt-in
 *    `mermaidPlugin({ interactive: true })` hydrate, node and edge tooltips the opt-in
 *    `mermaidPlugin({ tooltips: true })` one);
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
 * @property {boolean} [htmlLabels] draw flowchart and state labels as HTML in `foreignObject` unless
 *   a diagram's config turns them off; a diagram's own `htmlLabels` cannot turn them on
 * @property {boolean} [safe] keep every label SVG text whatever `htmlLabels` says, for output a host
 *   renders through the `@jarenjs/view` safe policy (which drops `foreignObject`)
 * @property {{ pie?: import('../render/index.js').DiagramRenderer }} [renderers] renderers for the
 *   types this engine does not draw itself — a pie, from `@jarenjs/charts/transforms/mermaid-adapter`
 * @property {import('@jarenjs/core/dates').DateNames} [dateNames] the locale-name record a Gantt's
 *   `dateFormat`/`axisFormat` needs for a month or weekday token (`compileDateLocale(pack).names`)
 * @property {(text: string) => any} [parseFrontmatter] the front-matter parser, in place of the
 *   built-in YAML subset
 * @property {number} [memoLimit] LRU size for the source-string memo (default 32)
 * @property {string | URL} [base] base URL for `mermaid-load`
 * @property {typeof globalThis.fetch} [fetch] fetch implementation for `mermaid-load`
 */
/**
 * @typedef {object} MermaidComponent
 * @property {(source: string) => any} compile memoized compile
 * @property {(sourceOrDoc: any) => any} view memoized vnode projection
 * @property {Record<string, (props: any, dispatch: any) => any>} effects
 * @property {(container: any) => void} hydrate no-op
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
  const compileOptions = { theme: options.theme, renderers: options.renderers,
    dateNames: options.dateNames, parseFrontmatter: options.parseFrontmatter,
    htmlLabels: options.htmlLabels, safe: options.safe };

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

    // The render is complete, so there is nothing to attach; the
    // client-only enhancement (pan/zoom) is `mermaidPlugin`'s hydrate.
    hydrate() {
      /* no-op */
    },
  };
}
