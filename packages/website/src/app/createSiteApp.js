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
import { binanceToggle, binancePageSync } from '../boundaries/binance.js';
import {
  createSiteToolbox, createAssistantEffects, registerSiteWebMcp,
} from '../boundaries/assistant.js';
import { encodeShare, decodeShare } from '../lib/share.js';
import { calcEditEffects, createRatesLayer } from '@jarenjs/calc/component';

/**
 * @typedef {Object} SiteEnv
 * @property {any} [node] - Mount element (omit for headless).
 * @property {any} [document] - DOM document for the renderer.
 * @property {(flush: () => void) => void} [schedule] - Render scheduler.
 * @property {string} [initialTheme] - 'light' | 'dark'.
 * @property {(name: string) => Promise<any>} fetchJson - Benchmark file loader.
 * @property {(url: string) => Promise<string>} [fetchText] - Raw-text
 *   loader for package READMEs (the dialog); omit for no-network hosts.
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
 * @property {typeof fetch} [aiFetch] - fetch for the AI assistant's
 *   provider calls (default global fetch); injectable for tests.
 * @property {{ read: () => any, write: (data: any) => void }} [aiStorage]
 *   Persistence for the assistant settings (localStorage in the browser).
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

  // the @jarenjs/calc live-rates layer: the impure half (fetch); the pure
  // conversion stays in @jarenjs/core/convert. The static fallback keeps
  // the converter working offline and in tests (no network).
  const rates = createRatesLayer({
    provider: 'coingecko',
    refreshMs: 60000,
    fetch: env.ratesFetch,
  });

  const ideNames = () => Object.keys(store.experiments).sort();

  // the AI assistant toolbox: the playground engines as schema-guarded
  // @jarenjs/ai tools, shared by the chat panel and the WebMCP bridge.
  // `getApp` is lazy because the app is created further down.
  const toolbox = createSiteToolbox({
    getApp: () => app,
    navigate: env.navigate,
    share: env.share,
    store,
  });
  const aiStorage = env.aiStorage ?? { read: () => null, write: () => {} };

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
    // the README dialog locks the page scroll behind it; headless
    // hosts simply omit the capability
    'lock-scroll': (props) => env.lockScroll?.(props.on === true),
    'binance-toggle': (props, dispatch) =>
      binanceToggle((action, payload) => dispatch(action, payload),
        props.target === 'page' ? 'page' : 'playground'),
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
    // fetch a package README as raw text (cached per URL); the viewModel
    // parses + renders it through the @jarenjs/md component
    'readme-load': (props, dispatch) => {
      if (env.fetchText === undefined) {
        dispatch(props.error, 'README loading is unavailable in this environment.');
        return;
      }
      const cached = readmeCache.get(props.url);
      if (cached !== undefined) {
        dispatch(props.done, cached);
        return;
      }
      env.fetchText(props.url).then(
        (text) => {
          readmeCache.set(props.url, text);
          // ignore a stale response if the dialog moved on or closed
          const readme = app.getState().readme;
          if (readme.open && readme.url === props.url) dispatch(props.done, text);
        },
        (err) => {
          const readme = app.getState().readme;
          if (readme.open && readme.url === props.url) {
            dispatch(props.error, /** @type {Error} */ (err)?.message ?? String(err));
          }
        },
      );
    },
  };

  /** README text cache, keyed by URL (a reopen is instant). */
  const readmeCache = new Map();

  // fold in the calc sub-app's effects (= evaluation, backspace), the
  // live-rates effect (plus the `when`-gated rates-poll subscription),
  // and the AI assistant's streaming-turn + settings effects.
  Object.assign(effects, calcEditEffects, rates.effects,
    createAssistantEffects({ toolbox, getApp: () => app, aiFetch: env.aiFetch, aiStorage }));

  app = createApp({
    $app: '0.1',
    state: createInitialState(env.initialTheme ?? 'light', ideNames(), aiStorage.read()),
    view: STYLESHEET,
    actions: ACTIONS,
    subs: [...SUBS, rates.subEntry],
  }, {
    node: env.node,
    document: env.document,
    schedule: env.schedule,
    viewModel,
    // per committed frame: keep the active tab/section of the mobile
    // scroll strips in view (a no-op capability on headless hosts)
    afterRender: () => env.revealActiveTab?.(),
    onError: report,
    effects,
    subs: {
      hash: (props, dispatch) => env.listenHash?.((route) => dispatch('route/set', route)),
      ...rates.subs,
    },
  });

  wireBoundaries(app, env.debounceMs ?? 250);
  registerSiteWebMcp(toolbox, { modelContext: env.modelContext, onError: report });
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
  // Engines may carry a `sync(inputs, dispatch, active)` lifecycle hook
  // (the charts replay timer): called after that engine's boundary run
  // and on every route change, with `active` false whenever the
  // playground no longer shows the engine — the hook must stop its
  // side channel then.
  const syncEng = (engine) => {
    const def = ENGINE_DEFS[engine];
    if (def === undefined || def.sync === undefined) return;
    const state = app.getState();
    const active = state.route.page === 'playground'
      && (state.route.params.engine ?? 'validate') === engine;
    def.sync(state.eng[engine] ?? {},
      (action, payload) => app.dispatch(action, payload), active);
  };
  const syncAll = () => {
    for (const engine of Object.keys(ENGINE_DEFS)) syncEng(engine);
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
    for (const engine of engines) {
      debounced(`eng:${engine}`, () => {
        runEng(engine);
        syncEng(engine);
      });
    }
    if (routed) {
      const s = app.getState();
      const engine = s.route.params.engine;
      if (s.route.page === 'playground' && engine !== undefined
        && ENGINE_DEFS[engine] !== undefined && s.engResults[engine] === undefined) {
        runEng(engine);
      }
      syncAll();
      binancePageSync(s.route.page === 'charts');
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
