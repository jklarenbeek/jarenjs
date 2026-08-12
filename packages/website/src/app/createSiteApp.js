//@ts-check
/**
 * Assemble and start the site: one app document (state + stylesheet +
 * actions + subs) through `createApp`, with the environment injected so
 * tests run the whole site headless against stubs.
 *
 * Reactivity is one subscriber on the transition changed-path feed (the
 * patch engine's `changes` option surfaced by @jarenjs/app):
 *  - a `/play/*` engine input changed → re-run the play engine (debounced);
 *  - `/project/files*` or `/project/active` changed → re-commit the
 *    Project IDE (debounced);
 *  - `/route` changed → seed the arriving surface once, redirect the
 *    retired URLs, and apply an inbound share token.
 */

import { createApp, formEventFields, createDocStore, encodeShare, decodeShare } from '@jarenjs/app';
import { createLedger } from '@jarenjs/ai';

import { ACTIONS, SUBS } from './actions.js';
import { createSlotLedgerStorage } from '../lib/ledgerStore.js';
import { createInitialState } from './state.js';
import { viewModel } from './viewmodel.js';
import { STYLESHEET } from '../views/index.js';
import { binanceToggle, binancePageSync } from '../boundaries/binance.js';
import {
  createSiteToolbox, createAssistantEffects, registerSiteWebMcp, isConfigured,
} from '../boundaries/assistant.js';
import { STUDIO_WIDGETS as DOCUMENT_WIDGETS } from '../boundaries/studio.js';
import {
  createProjectStageWidget, createProjectSplitterWidget, commitProject, runProjectFile,
  projectSnapshot, projectAppFile,
} from '../boundaries/project.js';
import {
  runPlay, loadExample, loadDataset, sessionOf, sessionToLoaded, blankSession,
  legacyExperimentToSession, createPlaySplitterWidget, deepLinkExample,
  sessionDocument, sessionFromDocument, sessionFilename,
} from '../boundaries/play.js';
import {
  projectTemplate, fileSkeleton, singleAppProject, sharedProject,
} from '../content/projectTemplates.js';
import { createFlowRuntime } from '../boundaries/flowstudio.js';
import { createGameRuntime } from '../boundaries/game.js';
import { createDataRuntime } from '../boundaries/data.js';
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
 * @property {(filename: string, text: string) => boolean | void} [download]
 *   Save a text file on the user's machine (a Blob + anchor click in
 *   the browser); omit for no-download hosts. Return true on success.
 * @property {(accept?: string) => Promise<{ name: string, text: string } | null>}
 *   [openFile] - `download`'s twin: open a file picker and resolve what
 *   was chosen, or null if nothing was. Omit for hosts that cannot read
 *   a local file; the surface then says so rather than failing silently.
 * @property {any} [modelContext] - A WebMCP `navigator.modelContext`
 *   implementation; when present, the site registers its tools on it.
 * @property {typeof fetch} [aiFetch] - fetch for the AI assistant's
 *   provider calls (default global fetch); injectable for tests.
 * @property {{ read: () => any, write: (data: any) => void }} [aiStorage]
 *   Persistence for the assistant settings (localStorage in the browser).
 * @property {{ read: () => any, write: (data: any) => void }} [aiChat]
 *   Persistence for the assistant transcript, so a reload resumes the
 *   conversation (localStorage in the browser).
 * @property {{ read: () => any, write: (data: any) => void }} [aiLedger]
 *   Persistence for the assistant's LEDGER — the objective, its
 *   progress, what it has learned, and the rounds compaction archived.
 *   Omit it and the ledger runs in memory for the session, which is the
 *   degrade `@jarenjs/ai` is built for; supply it and a goal survives a
 *   reload.
 * @property {number} [debounceMs] - Boundary-run debounce (default 250;
 *   0 = synchronous, for tests).
 * @property {(error: Error) => void} [onError]
 */

/** Share tokens beyond this length get an honest refusal, not a
 * silently mangled URL (project documents can be long). */
const SHARE_TOKEN_LIMIT = 8000;

/** Play-slice paths that are IDE chrome, not engine inputs: a change to any
 * of them must NOT re-run the engine (the run's own output, the active tab,
 * the depth toggle + its pick, the session name/list, the share status, the
 * editor|result split ratio). */
const PLAY_CHROME_PATHS = new Set([
  '/play/result', '/play/panel', '/play/deep', '/play/deepPick', '/play/mobilePane',
  '/play/name', '/play/savedName', '/play/names', '/play/shared', '/play/ratio',
]);

/** @param {SiteEnv} env */
export function createSiteApp(env) {
  const report = env.onError
    ?? (typeof reportError === 'function' ? reportError : () => {});
  const storage = env.storage ?? { read: () => null, write: () => {} };
  // the saved-experiment store (localStorage in the browser): a keyed CRUD
  // over the injected storage, shared with the Project IDE and play surfaces
  const docStore = createDocStore({ storage });
  // the Play IDE's own saved-session store: the same primitive,
  // a separate collection key, so play sessions and legacy experiments
  // never collide
  const playStore = createDocStore({ storage, key: 'play' });

  /** effect-handler dedupe: each benchmark file is fetched once */
  const requested = new Set();
  /** @type {any} */
  let app = null;
  // the data studio's owner-worker runtime (its boot sub lives in the
  // boundary, which is coverage-excluded as browser-only)
  const dataRuntime = createDataRuntime({});

  // the @jarenjs/calc live-rates layer: the impure half (fetch); the pure
  // conversion stays in @jarenjs/core/convert. The static fallback keeps
  // the converter working offline and in tests (no network).
  const rates = createRatesLayer({
    provider: 'coingecko',
    refreshMs: 60000,
    fetch: env.ratesFetch,
  });

  const ideNames = () => docStore.names();

  // the AI assistant toolbox: the play engines as schema-guarded
  // @jarenjs/ai tools, shared by the chat panel and the WebMCP bridge.
  // `getApp` is lazy because the app is created further down.
  const toolbox = createSiteToolbox({
    getApp: () => app,
    navigate: env.navigate,
    share: env.share,
    docStore,
    playStore,
  });
  const aiStorage = env.aiStorage ?? { read: () => null, write: () => {} };
  const aiChat = env.aiChat ?? { read: () => null, write: () => {} };
  // the assistant's durable state: one @jarenjs/ai ledger over the site's
  // own JSON-slot idiom, or in memory when the host offers no slot. The
  // agent reads its objective from here every turn and compaction
  // archives every dropped round into it, so this one object is what
  // makes a session survive a closed tab.
  const aiLedger = createLedger(env.aiLedger === undefined
    ? {}
    : { storage: createSlotLedgerStorage(env.aiLedger) });

  // the Flow studio's runtime: nested-machine host widget + effects
  // (template loading, fail-closed text parsing, dag runs with abort)
  const flowRuntime = createFlowRuntime({ schedule: env.schedule });

  const effects = {
    ...flowRuntime.effects,
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
    // an in-page link inside a rendered document; a headless host has
    // nothing to scroll and omits the capability
    'scroll-to-anchor': (props) => env.scrollToAnchor?.(String(props.id ?? '')),
    'binance-toggle': (props, dispatch) =>
      binanceToggle((action, payload) => dispatch(action, payload)),
    // the IDE store (the Project IDE's Save/Load/Share bar). Two legacy
    // kinds may still be in a user's storage: an engine experiment from the
    // retired playground translates into a play session, and a Studio
    // document (`engine: 'studio'`) opens as a single-app project — loading
    // translates on the way, so nothing saved rots.
    'ide-save': (props, dispatch) => {
      const state = app.getState();
      const name = state.ide.name.trim();
      if (name === '') return;
      docStore.save(name, { engine: 'project', inputs: { project: projectSnapshot(state.project) }, savedAt: new Date().toISOString() });
      dispatch('ide/names', ideNames());
    },
    'ide-load': (props, dispatch) => {
      const experiment = docStore.load(props.name);
      if (experiment === undefined) return;
      if (experiment.engine === 'project' || experiment.engine === 'studio') {
        const project = experiment.engine === 'project'
          ? sharedProject({ e: 'project', i: experiment.inputs })
          : singleAppProject(experiment.inputs.doc, props.name);
        if (project === null) return;
        // open + commit BEFORE navigating: the route arrival then finds the
        // loaded project already committed instead of racing a stale commit
        // of the previous one
        dispatch('project/open', project);
        dispatch('project/committed', commitProject(project));
        env.navigate?.('#/project');
        return;
      }
      // a legacy playground experiment → the equivalent play session
      const session = legacyExperimentToSession(experiment.engine, experiment.inputs);
      if (session === null) return;
      env.navigate?.('#/play');
      dispatch('play/loaded-session', { ...session, name: '' });
    },
    'ide-delete': (props, dispatch) => {
      docStore.remove(props.name);
      dispatch('ide/names', ideNames());
    },
    'ide-share': (props, dispatch) => {
      const state = app.getState();
      const token = encodeShare({ e: 'project', i: { project: projectSnapshot(state.project) } });
      // hash-length honesty: a long project makes a token browsers and
      // chat clients mangle — say so instead of truncating
      if (token.length > SHARE_TOKEN_LIMIT) {
        dispatch('ide/shared',
          `too large for a share link (${token.length} > ${SHARE_TOKEN_LIMIT} chars) — use Download instead`);
        return;
      }
      const url = env.share?.(`#/project?s=${token}`);
      dispatch('ide/shared', url === undefined ? 'link ready' : 'link copied');
    },
    // the app-document download: the project's designated app file, under
    // the name Studio downloads always carried
    'project-download': (props, dispatch) => {
      const file = projectAppFile(app.getState().project);
      if (file === null) return;
      let doc;
      try { doc = JSON.parse(file.text); }
      catch { return; } // an unparseable app file has nothing to download
      const saved = env.download?.('jaren-studio-app.json', JSON.stringify(doc, null, 2));
      dispatch('ide/shared', saved === true ? 'document downloaded' : 'download unavailable here');
    },

    // the Project IDE: the editor commits the ACTIVE file's text (rewriting
    // it by name — an array index a patch path cannot compute); explicit
    // Run force-restarts the app stage; a template card opens a project.
    'project-edit': (props, dispatch) => {
      const p = app.getState().project;
      const files = p.files.map((f) => (f.name === p.active ? { ...f, text: props.text } : f));
      dispatch('project/files-set', { files });
    },
    'project-run': (props, dispatch) => {
      const state = app.getState().project;
      const active = state.files.find((f) => f.name === state.active);
      // a transform / schema file re-runs; an app file force-restarts
      if (active !== undefined && (active.kind === 'query' || active.kind === 'jslt' || active.kind === 'schema')) {
        dispatch('project/result', { name: state.active, result: runProjectFile(state, state.active) });
        return;
      }
      const commit = commitProject(state);
      const mount = commit.mount === null ? null : { ...commit.mount, revision: commit.mount.revision + 1 };
      dispatch('project/committed', { mount, revision: mount === null ? commit.revision : mount.revision });
    },
    'project-template': (props, dispatch) => {
      const template = projectTemplate(props.id);
      if (template === undefined) return;
      dispatch('project/open', template);
      // commit NOW, computed from the template itself: the debounced edit
      // loop alone leaves a race where an edit inside the debounce window
      // supersedes the opening commit — the "last good frame" then never
      // existed and an invalid edit blanks the stage
      dispatch('project/committed', commitProject(template));
    },
    // file management (the files array is an array — index-by-name lives in
    // JS here, then a patch action lands the result)
    'project-add': (props, dispatch) => {
      const text = fileSkeleton(props.kind);
      if (text === null) return;
      const p = app.getState().project;
      let n = 1;
      let name = `${props.kind}-${n}.${props.kind}`;
      while (p.files.some((f) => f.name === name)) { n += 1; name = `${props.kind}-${n}.${props.kind}`; }
      dispatch('project/added', { files: [...p.files, { name, kind: props.kind, text }], active: name });
    },
    'project-delete': (props, dispatch) => {
      const p = app.getState().project;
      if (p.files.length <= 1) return; // never delete the last file
      const files = p.files.filter((f) => f.name !== props.name);
      if (files.length === p.files.length) return; // no such file
      const active = p.active === props.name ? files[0].name : p.active;
      dispatch('project/structural', { files, active });
    },
    'project-rename': (props, dispatch) => {
      const p = app.getState().project;
      const next = String(props.name ?? '').trim();
      if (next === '' || next === p.active || p.files.some((f) => f.name === next)) return;
      const files = p.files.map((f) => (f.name === p.active ? { ...f, name: next } : f));
      dispatch('project/structural', { files, active: next });
    },
    // the Play playground: picking an example loads its source + first
    // dataset; the dataset switcher swaps the data pane against the SAME
    // source (both land as a patch, then the run loop below re-runs).
    'play-load': (props, dispatch) => {
      const loaded = loadExample(props.id);
      if (loaded !== null) dispatch('play/loaded', loaded);
    },
    'play-dataset': (props, dispatch) => {
      const data = loadDataset(app.getState().play.exampleId, props.index);
      if (data !== null) dispatch('play/dataset-set', { index: props.index, data });
    },
    // the Play IDE: a play session is a saveable document, kept in
    // the play doc-store and shareable as a `#/play?s=` link
    'play-new': (props, dispatch) => {
      dispatch('play/loaded-session', { ...blankSession(app.getState().play.engine), name: '' });
    },
    // Save overwrites the record this session is BOUND to; Save As (and a
    // session that has never been saved) writes the title as a new record.
    // Either way the session then binds to what it just wrote, so the next
    // Save overwrites that — the ordinary editor contract.
    'play-save': (props, dispatch) => {
      const slice = app.getState().play;
      const title = (slice.name ?? '').trim();
      const target = props?.as === true ? title : (slice.savedName ?? title);
      if (target === '') return; // nothing to save under (the header nudges)
      playStore.save(target, { ...sessionOf(slice), savedAt: new Date().toISOString() });
      dispatch('play/saved', { name: target, names: playStore.names() });
    },
    // a session leaves as a file, and comes back as one. Download names
    // the file after the session title; Import accepts the envelope it
    // writes AND a bare session, and reports an unreadable file instead
    // of silently replacing what the user was working on.
    'play-download': (props, dispatch) => {
      const slice = app.getState().play;
      const saved = env.download?.(sessionFilename(slice),
        JSON.stringify(sessionDocument(slice), null, 2));
      dispatch('play/shared', saved === true ? 'session downloaded' : 'download unavailable here');
    },
    'play-import': (props, dispatch) => {
      if (env.openFile === undefined) {
        dispatch('play/shared', 'opening a file is unavailable here');
        return;
      }
      Promise.resolve(env.openFile()).then((file) => {
        if (file === null || file === undefined) return; // the picker was dismissed
        const doc = sessionFromDocument(file.text);
        if (doc === null) {
          dispatch('play/shared', `${file.name ?? 'that file'} is not a play session`);
          return;
        }
        dispatch('play/loaded-session', { ...doc.session, name: doc.name });
        dispatch('play/shared', `imported ${file.name ?? 'a session'}`);
      }).catch(() => dispatch('play/shared', 'that file could not be read'));
    },
    'play-open': (props, dispatch) => {
      const session = playStore.load(props.name);
      if (session === undefined) return;
      dispatch('play/loaded-session',
        { ...sessionToLoaded(session), name: props.name, savedName: props.name });
    },
    'play-delete': (props, dispatch) => {
      playStore.remove(props.name);
      // the record this session was bound to is gone: unbind, so the next
      // Save creates rather than silently resurrecting a deleted name
      if (app.getState().play.savedName === props.name) {
        dispatch('play/saved', { name: null, names: playStore.names() });
      }
      else dispatch('play/names', playStore.names());
    },
    // toggle the validate data pane between JSON and the generated form;
    // entering form mode seeds the structured buffer from the current text
    'play-data-view': (props, dispatch) => {
      const view = props.view === 'form' ? 'form' : 'json';
      let value = app.getState().play.dataValue;
      if (view === 'form') {
        const text = app.getState().play.data?.data ?? '';
        try { value = JSON.parse(text.trim() === '' ? 'null' : text); }
        catch { value = null; } // an unparseable text opens an empty form
      }
      dispatch('play/data-view-set', { view, value });
    },
    'play-share': (props, dispatch) => {
      const token = encodeShare(sessionOf(app.getState().play));
      if (token.length > SHARE_TOKEN_LIMIT) {
        // refuse the link, but never leave the session with no way out —
        // Download writes the same session as a file Import can read back
        dispatch('play/shared',
          `too large for a share link (${token.length} > ${SHARE_TOKEN_LIMIT} chars) — use Download instead`);
        return;
      }
      const url = env.share?.(`#/play?s=${token}`);
      dispatch('play/shared', url === undefined ? 'link ready' : 'link copied');
    },
    // a README link to a published page routes in-app after the dialog
    // closes (the action's patch already closed it)
    'readme-goto': (props) => {
      env.navigate?.(props.hash);
    },
    // the README dialog's navigation trail: reset on open, push on an
    // in-document link, and back/forward replay entries. The stack
    // arithmetic lives here because a truncate-and-push is JS, not a
    // patch; the state only ever changes through 'readme/history'.
    'readme-hist': (props, dispatch) => {
      const readme = app.getState().readme;
      if (props.kind === 'reset') {
        dispatch('readme/history', { stack: [{ title: props.title, url: props.url }], at: 0 });
      }
      else if (props.kind === 'push') {
        // navigating from mid-trail drops the forward entries, exactly
        // like a browser history
        const stack = readme.stack.slice(0, readme.at + 1);
        stack.push({ title: props.title, url: props.url });
        dispatch('readme/history', { stack, at: stack.length - 1 });
      }
      else {
        const at = props.kind === 'back' ? readme.at - 1 : readme.at + 1;
        if (at < 0 || at >= readme.stack.length) return;
        const entry = readme.stack[at];
        dispatch('readme/history', { stack: readme.stack, at });
        dispatch('readme/show', { title: entry.title, url: entry.url });
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
    createAssistantEffects({
      toolbox, getApp: () => app, aiFetch: env.aiFetch, aiStorage, aiChat, ledger: aiLedger,
    }),
    // the adventure game's resolver + dynamic-tier effects; it reuses the
    // assistant's shared BYOK key (state.ai.settings) and fetch
    createGameRuntime({ getApp: () => app, aiFetch: env.aiFetch, isConfigured, download: env.download, saveSlot: env.gameSave }).effects,
    // the data studio's owner-worker transport + effects
    dataRuntime.effects);

  app = createApp({
    $app: '0.1',
    state: createInitialState(env.initialTheme ?? 'light', ideNames(), aiStorage.read(), aiChat.read(), playStore.names()),
    view: STYLESHEET,
    actions: ACTIONS,
    subs: [...SUBS, rates.subEntry],
  }, {
    node: env.node,
    document: env.document,
    schedule: env.schedule,
    // the standard form controls that carry JSON text (typed selects,
    // the structured-value editor) decode it here
    eventFields: { ...formEventFields() },
    viewModel,
    // per committed frame: keep the active tab/section of the mobile
    // scroll strips in view (a no-op capability on headless hosts)
    afterRender: () => env.revealActiveTab?.(),
    onError: report,
    effects,
    widgets: {
      // chart / mermaid / markdown / form — usable from any site-level view
      // (the adventure game embeds chart + mermaid in its own page)
      ...DOCUMENT_WIDGETS,
      'flow-doc': flowRuntime.widget,
      // the Project IDE's live stage: boots the active app file, then
      // reboots (revision change) or hot-updates (app.setState) per commit
      'studio-stage': createProjectStageWidget({ schedule: env.schedule }),
      // the drag splitter: drives --js-ratio live, commits on pointer-up
      'studio-splitter': createProjectSplitterWidget(),
      // the Play IDE's editor|result splitter (same widget, --jplay-ratio)
      'play-splitter': createPlaySplitterWidget(),
    },
    subs: {
      hash: (props, dispatch) => env.listenHash?.((route) => dispatch('route/set', route)),
      // the data studio's boot: fires once when #/data first appears
      'data-owner': dataRuntime.ownerSub,
      ...rates.subs,
    },
  });

  wireBoundaries(app, env.debounceMs ?? 250, env.navigate);
  registerSiteWebMcp(toolbox, { modelContext: env.modelContext, onError: report });
  return app;
}

/**
 * The reactive boundary runs, driven by the changed-path feed.
 * @param {any} app
 * @param {number} debounceMs
 * @param {((hash: string) => void)} [navigate] - set the location hash (for
 *   the retired-page redirect: #/examples → #/play)
 */
function wireBoundaries(app, debounceMs, navigate) {
  // the Project IDE's commit: validate + assemble the active app file and
  // fold in the last-good stage mount (an invalid edit keeps the previous)
  const runProjectCommit = () => {
    const state = app.getState();
    if (state.project === undefined) return;
    app.dispatch('project/committed', commitProject(state.project));
  };
  // run the active transform file (jslt/query) live, like the playground —
  // paired with the project's data file, registered operators included
  const runProjectActive = () => {
    const state = app.getState();
    if (state.project === undefined) return;
    const active = state.project.active;
    const file = state.project.files.find((f) => f.name === active);
    if (file !== undefined && (file.kind === 'query' || file.kind === 'jslt' || file.kind === 'schema')) {
      app.dispatch('project/result', { name: active, result: runProjectFile(state.project, active) });
    }
  };
  // the Play playground's live run: the active engine over the current
  // source + data (registered operators threaded in the boundary). Never
  // throws — a bad edit lands as an error result, not a crash.
  const runPlayLive = () => {
    const state = app.getState();
    if (state.play === undefined) return;
    app.dispatch('play/result', runPlay(state.play));
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
    if (changes === null) return;
    let routed = false;
    let project = false;
    let play = false;
    let playFormEdit = false; // a /play/dataValue* edit (from the generated form)
    let playToggle = false;   // the /play/dataView toggle (json ↔ form)
    for (const path of changes) {
      if (path === '/project/files' || path.startsWith('/project/files/') || path === '/project/active') {
        project = true;
      }
      // any Play ENGINE input (source / data / example / dataset / config)
      // re-runs; the run's own output and the pure IDE chrome (the active
      // tab, the session name/list, the share status, the split ratio) must
      // NOT, or it loops / re-runs on every keystroke and drag
      else if (path.startsWith('/play/')) {
        // the generated form writes into /play/dataValue*; that mirrors back
        // to the data TEXT (below), which is what actually re-validates — so
        // a form edit must not itself re-run
        if (path === '/play/dataView') playToggle = true;
        else if (path === '/play/dataValue' || path.startsWith('/play/dataValue/')) playFormEdit = true;
        else if (!PLAY_CHROME_PATHS.has(path)) play = true;
      }
      else if (path === '/route') {
        routed = true;
      }
    }
    if (project) debounced('project', () => { runProjectCommit(); runProjectActive(); });
    if (play) debounced('play', runPlayLive);
    // a generated-form edit (not the toggle, which sets the buffer from the
    // text) serializes the structured buffer back into the data-pane text —
    // that `/play/data/data` change then re-validates through the normal run
    if (playFormEdit && !playToggle) {
      const value = app.getState().play.dataValue;
      app.dispatch('play/data-mirror', value === null ? '' : JSON.stringify(value, null, 2));
    }
    if (routed) onRouteArrival();
  });

  /** Everything that must happen because the route just became what it is. */
  function onRouteArrival() {
    const s = app.getState();
    // the retired #/examples, #/scratch and #/playground URLs redirect
    // to #/play (an old playground share token translates on the way);
    // the retired #/studio redirects to the Project IDE, its share
    // token riding along (the token itself opens on #/project)
    if (s.route.page === 'examples' || s.route.page === 'scratch') { navigate?.('#/play'); return; }
    if (s.route.page === 'playground') { navigate?.(playgroundRedirect(s.route.params)); return; }
    if (s.route.page === 'studio') { navigate?.(studioRedirect(s.route.params)); return; }
    // arriving at the Project IDE: boot the stage once, run the active
    // transform if that is what is showing
    if (s.route.page === 'project') {
      if (s.project.mount === null) runProjectCommit();
      runProjectActive();
    }
    // arriving at Play: honour a deep link first, then run whatever is
    // loaded once, so the stage is never empty (later edits re-run
    // through the feed above)
    if (s.route.page === 'play') {
      applyPlayDeepLink(s);
      if (app.getState().play.result === null) runPlayLive();
    }
    binancePageSync(s.route.page === 'charts');
    applyShareToken(s);
  }

  /** The retired #/playground URL → #/play. A legacy share token
   * (`{ e, i }`) translates into a play session token and an `engine`
   * param rides across unchanged, so old links restore what they always
   * restored — just on #/play. */
  function playgroundRedirect(params) {
    const token = params.s;
    if (token !== undefined) {
      const snapshot = decodeShare(token);
      if (snapshot !== null && typeof snapshot.e === 'string' && snapshot.i !== undefined) {
        const session = legacyExperimentToSession(snapshot.e, snapshot.i);
        if (session !== null) return `#/play?s=${encodeShare(session)}`;
      }
    }
    return params.engine === undefined
      ? '#/play' : `#/play?engine=${encodeURIComponent(params.engine)}`;
  }

  /** The retired #/studio URL → #/project, the share token riding along
   * (applyShareToken opens a studio-document token as a one-app project). */
  function studioRedirect(params) {
    return params.s === undefined ? '#/project' : `#/project?s=${params.s}`;
  }

  /** Inbound deep links on #/play: `?engine=<id>` opens that engine's first
   * example, `?example=<id>` an exact one. A `?s=` session token outranks
   * both — it carries edited panes, which a library example does not — and
   * an id the library does not hold leaves the seeded session alone rather
   * than blanking the page. Applied once per distinct link. */
  let appliedDeepLink = null;
  function applyPlayDeepLink(state) {
    const { page, params } = state.route;
    if (page !== 'play' || params.s !== undefined) return;
    if (params.engine === undefined && params.example === undefined) return;
    const key = `${params.engine ?? ''}|${params.example ?? ''}`;
    if (key === appliedDeepLink) return;
    appliedDeepLink = key;
    const id = deepLinkExample(params);
    if (id === null) return;
    const loaded = loadExample(id);
    if (loaded !== null) app.dispatch('play/loaded', loaded);
  }

  /** Inbound share links: `?s=<token>` loads the shared snapshot once. */
  let appliedToken = null;
  function applyShareToken(state) {
    const token = state.route.params.s;
    const page = state.route.page;
    if ((page !== 'project' && page !== 'play') || token === undefined
      || token === appliedToken) {
      return;
    }
    appliedToken = token;
    const snapshot = decodeShare(token);
    if (snapshot === null) return;
    if (page === 'play') {
      // a play SESSION token ({ engine, source, data, config, exampleId });
      // a foreign shape is coerced to safe defaults, never a crash
      if (typeof snapshot.engine !== 'string') return;
      app.dispatch('play/loaded-session', { ...sessionToLoaded(snapshot), name: '' });
      return;
    }
    // a project token — or a legacy studio-document token, which opens as
    // a single-app project. Every file still validates on its own boundary
    // when it lands, so a broken share reports in the error strip instead
    // of booting; a foreign shape is ignored, never a crash. Commit in the
    // same breath (see project-template) so the opening frame is the
    // committed last-good one.
    const project = sharedProject(snapshot);
    if (project !== null) {
      app.dispatch('project/open', project);
      app.dispatch('project/committed', commitProject(project));
    }
  }

  // The hash subscription delivers the FIRST route while the app is being
  // created — before this module's subscriber attaches — so a direct entry
  // (a retired URL to redirect, a project or play page to boot, a share
  // link or a deep link in the URL) would otherwise be seen by nobody.
  // Running the same arrival path once here is what makes an entry URL and
  // an in-page navigation behave identically; every step it takes is
  // guarded or idempotent.
  onRouteArrival();
}
