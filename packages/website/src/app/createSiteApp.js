//@ts-check
/**
 * Assemble and start the site: one app document (state + stylesheet +
 * actions + subs) through `createApp`, with the environment injected so
 * tests run the whole site headless against stubs.
 *
 * Reactivity is one subscriber on the transition changed-path feed (the
 * patch engine's `changes` option surfaced by @jarenjs/app):
 *  - `/pg/schemaText` or `/pg/data/*` changed → revalidate the schema
 *    playground (debounced);
 *  - `/eng/<engine>/*` changed → re-run that engine's boundary
 *    (debounced);
 *  - `/route` changed → run the routed engine once if it has no result.
 */

import { createApp } from '@jarenjs/app';

import { ACTIONS, SUBS } from './actions.js';
import { createInitialState } from './state.js';
import { viewModel } from './viewmodel.js';
import { STYLESHEET } from '../views/index.js';
import { runValidation } from '../boundaries/validator.js';
import { runEngine, ENGINE_DEFS } from '../boundaries/engines.js';
import { registerWebMcpTools } from '../boundaries/webmcp.js';
import { encodeShare, decodeShare } from '../lib/share.js';

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
 * @property {(hash: string) => void} [navigate] - Set the location hash.
 * @property {(hash: string) => string | undefined} [share] - Build the
 *   absolute URL for a hash and put it on the clipboard; returns the URL.
 * @property {{ read: () => any, write: (data: any) => void }} [storage]
 *   The experiment store (localStorage in the browser).
 * @property {any} [modelContext] - A WebMCP `navigator.modelContext`
 *   implementation; when present, the site registers its tools on it.
 * @property {number} [debounceMs] - Boundary-run debounce (default 250;
 *   0 = synchronous, for tests).
 * @property {(error: Error) => void} [onError]
 */

/** @param {SiteEnv} env */
export function createSiteApp(env) {
  const report = env.onError
    ?? (typeof reportError === 'function' ? reportError : () => {});
  const storage = env.storage ?? { read: () => null, write: () => {} };
  const store = storage.read() ?? { experiments: {} };
  if (store.experiments === undefined) store.experiments = {};

  /** effect-handler dedupe: each benchmark file is fetched once */
  const requested = new Set();
  /** @type {any} */
  let app = null;

  const ideNames = () => Object.keys(store.experiments).sort();

  const effects = {
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
    'ide-save': (props, dispatch) => {
      const state = app.getState();
      const name = state.ide.name.trim();
      if (name === '') return;
      const engine = state.route.page === 'playground'
        ? (state.route.params.engine ?? 'validate')
        : 'validate';
      const inputs = engine === 'validate'
        ? { schemaText: state.pg.schemaText, data: state.pg.data }
        : state.eng[engine];
      store.experiments[name] = { engine, inputs, savedAt: new Date().toISOString() };
      storage.write(store);
      dispatch('ide/names', ideNames());
    },
    'ide-load': (props, dispatch) => {
      const experiment = store.experiments[props.name];
      if (experiment === undefined) return;
      env.navigate?.(`#/playground?engine=${experiment.engine}`);
      if (experiment.engine === 'validate') {
        dispatch('pg/example', {
          schemaText: experiment.inputs.schemaText,
          data: experiment.inputs.data,
        });
      }
      else {
        dispatch('eng/load', { engine: experiment.engine, inputs: experiment.inputs });
      }
    },
    'ide-delete': (props, dispatch) => {
      delete store.experiments[props.name];
      storage.write(store);
      dispatch('ide/names', ideNames());
    },
    'ide-share': (props, dispatch) => {
      const state = app.getState();
      const engine = state.route.page === 'playground'
        ? (state.route.params.engine ?? 'validate')
        : 'validate';
      const inputs = engine === 'validate'
        ? { schemaText: state.pg.schemaText, data: state.pg.data }
        : state.eng[engine];
      const token = encodeShare({ e: engine, i: inputs });
      const url = env.share?.(`#/playground?engine=${engine}&s=${token}`);
      dispatch('ide/shared', url === undefined ? 'link ready' : 'link copied');
    },
    'open-example': (props, dispatch) => {
      if (props.validate === true) {
        env.navigate?.('#/playground?engine=validate');
        dispatch('pg/example', { schemaText: props.schemaText, data: props.data });
      }
      else {
        env.navigate?.(`#/playground?engine=${props.engine}`);
        dispatch('eng/load', { engine: props.engine, inputs: props.inputs });
      }
    },
  };

  app = createApp({
    $app: '0.1',
    state: createInitialState(env.initialTheme ?? 'light', ideNames()),
    view: STYLESHEET,
    actions: ACTIONS,
    subs: SUBS,
  }, {
    node: env.node,
    document: env.document,
    schedule: env.schedule,
    viewModel,
    onError: report,
    effects,
    subs: {
      hash: (props, dispatch) => env.listenHash?.((route) => dispatch('route/set', route)),
    },
  });

  wireBoundaries(app, env.debounceMs ?? 250);
  registerWebMcpTools(app, {
    modelContext: env.modelContext,
    navigate: env.navigate,
    store,
    onError: report,
  });
  return app;
}

/**
 * The reactive boundary runs, driven by the changed-path feed.
 * @param {any} app
 * @param {number} debounceMs
 */
function wireBoundaries(app, debounceMs) {
  const runValidate = () => {
    const state = app.getState();
    app.dispatch('pg/result', runValidation(state.pg.schemaText, state.pg.data));
  };
  const runEng = (engine) => {
    const state = app.getState();
    if (state.eng[engine] === undefined) return;
    app.dispatch('eng/result', { engine, result: runEngine(engine, state.eng[engine]) });
  };
  /** @type {Map<string, any>} */
  const timers = new Map();
  const debounced = (key, run) => {
    if (debounceMs === 0) {
      run();
      return;
    }
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(run, debounceMs));
  };

  app.subscribe((state, changes) => {
    if (changes === null) {
      debounced('validate', runValidate);
      return;
    }
    /** @type {Set<string>} */
    const engines = new Set();
    let validate = false;
    let routed = false;
    for (const path of changes) {
      if (path === '/pg/schemaText' || path === '/pg/data' || path.startsWith('/pg/data/')) {
        validate = true;
      }
      else if (path.startsWith('/eng/')) {
        engines.add(path.split('/')[2]);
      }
      else if (path === '/route') {
        routed = true;
      }
    }
    if (validate) debounced('validate', runValidate);
    for (const engine of engines) debounced(`eng:${engine}`, () => runEng(engine));
    if (routed) {
      const s = app.getState();
      const engine = s.route.params.engine;
      if (s.route.page === 'playground' && engine !== undefined
        && ENGINE_DEFS[engine] !== undefined && s.engResults[engine] === undefined) {
        runEng(engine);
      }
      applyShareToken(s);
    }
  });

  /** Inbound share links: `?s=<token>` loads the shared snapshot once. */
  let appliedToken = null;
  function applyShareToken(state) {
    const token = state.route.params.s;
    if (state.route.page !== 'playground' || token === undefined || token === appliedToken)
      return;
    appliedToken = token;
    const snapshot = decodeShare(token);
    if (snapshot === null || typeof snapshot.e !== 'string' || snapshot.i === undefined)
      return;
    if (snapshot.e === 'validate') {
      app.dispatch('pg/example', { schemaText: snapshot.i.schemaText, data: snapshot.i.data });
    }
    else if (ENGINE_DEFS[snapshot.e] !== undefined) {
      app.dispatch('eng/load', { engine: snapshot.e, inputs: snapshot.i });
    }
  }

  runValidate(); // the initial document validates immediately
  applyShareToken(app.getState()); // a share link may be the entry URL
}
