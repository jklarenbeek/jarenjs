//@ts-check
/**
 * Assemble and start the site: one app document (state + stylesheet +
 * actions + subs) through `createApp`, with the environment injected
 * so tests run the whole site headless against stubs.
 *
 * The wire() subscriber is the site's one reactive derivation: it
 * watches the transition changed-path feed (the patch engine's
 * `changes` option, surfaced by @jarenjs/app) and revalidates the
 * playground document whenever the schema text or the form data
 * changed — debounced, exactly like the old React hook, but driven by
 * data instead of component lifecycles.
 */

import { createApp } from '@jarenjs/app';

import { ACTIONS, SUBS } from './actions.js';
import { createInitialState } from './state.js';
import { viewModel } from './viewmodel.js';
import { STYLESHEET } from '../views/index.js';
import { runValidation } from '../boundaries/validator.js';

/**
 * @typedef {Object} SiteEnv
 * @property {any} [node] - Mount element (omit for headless).
 * @property {any} [document] - DOM document for the renderer.
 * @property {(flush: () => void) => void} [schedule] - Render scheduler.
 * @property {string} [initialTheme] - 'light' | 'dark'.
 * @property {(name: string) => Promise<any>} fetchJson - Benchmark file loader.
 * @property {(theme: string) => void} [applyTheme]
 * @property {(cb: (route: any) => void) => (() => void) | void} [listenHash]
 *   Must call `cb` once immediately with the current route, then on
 *   every change; returns a cleanup.
 * @property {number} [debounceMs] - Revalidation debounce (default 250;
 *   0 = synchronous, for tests).
 * @property {(error: Error) => void} [onError]
 */

/** @param {SiteEnv} env */
export function createSiteApp(env) {
  const report = env.onError
    ?? (typeof reportError === 'function' ? reportError : () => {});

  /** effect-handler dedupe: each benchmark file is fetched once */
  const requested = new Set();

  const app = createApp({
    $app: '0.1',
    state: createInitialState(env.initialTheme ?? 'light'),
    view: STYLESHEET,
    actions: ACTIONS,
    subs: SUBS,
  }, {
    node: env.node,
    document: env.document,
    schedule: env.schedule,
    viewModel,
    onError: report,
    effects: {
      'fetch-bench': (props, dispatch) => {
        if (requested.has(props.name)) return;
        requested.add(props.name);
        dispatch('bench/status', { name: props.name, status: 'loading' });
        env.fetchJson(props.name)
          .then((data) => dispatch('bench/loaded', { name: props.name, data }))
          .catch(() => {
            requested.delete(props.name);
            dispatch('bench/status', { name: props.name, status: 'error' });
          });
      },
      'apply-theme': (props) => env.applyTheme?.(props.theme),
      'parse-data': (props, dispatch) => {
        try {
          dispatch('pg/data-set', JSON.parse(props.text));
        }
        catch (err) {
          dispatch('pg/data-error', /** @type {Error} */ (err).message);
        }
      },
    },
    subs: {
      hash: (props, dispatch) => env.listenHash?.((route) => dispatch('route/set', route)),
    },
  });

  wireRevalidation(app, env.debounceMs ?? 250);
  return app;
}

/**
 * Revalidate the playground when its inputs change — driven by the
 * transition changed-path feed.
 * @param {any} app
 * @param {number} debounceMs
 */
function wireRevalidation(app, debounceMs) {
  const run = () => {
    const state = app.getState();
    app.dispatch('pg/result', runValidation(state.pg.schemaText, state.pg.data));
  };
  /** @type {any} */
  let timer = null;
  app.subscribe((state, changes) => {
    const relevant = changes === null || changes.some((p) =>
      p === '/pg/schemaText' || p === '/pg/data' || p.startsWith('/pg/data/'));
    if (!relevant) return;
    if (debounceMs === 0) {
      run();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  });
  run(); // the initial document validates immediately
}
