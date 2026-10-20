//@ts-check
/**
 * Assemble a running Radiant OS: the app document (state, the view
 * stylesheet, the action documents, the subscriptions), the boundaries
 * it names, the council driver, and the system call table that binds
 * them — and nothing that needs a browser. The bootstrap (`main.js`)
 * hands in what only a browser has (a node to render into, a database
 * worker's port, a way to apply a stylesheet or save a file); a test
 * hands in nothing, and gets the same OS, headless.
 */

import { createApp } from '@jarenjs/app';
import { compileMachine, stepWorld } from '../kernel/machine.js';
import { measure, roundMeasure } from '../kernel/metrics.js';
import { LOOKAHEAD } from '../kernel/council.js';
import { createCouncilDriver } from '../kernel/session.js';
import { createSystem, isProposal } from '../kernel/system.js';
import { renderArt } from '../kernel/exports.js';
import { stageWidget } from '../stage/widget.js';
import { sculptureWidget } from '../stage/sculpture.js';
import { initialState, restoreState, sessionSlice } from './state.js';
import { ACTIONS } from './actions.js';
import { STUDIO_ACTIONS } from './studio-actions.js';
import { createStudioHost } from './studio-host.js';
import { VIEW } from './view.js';
import { viewModel } from './viewmodel.js';

/** How often the running session is saved, ms. */
export const AUTOSAVE_MS = 20000;
/** How many harmony samples the sparkline keeps, one per this many ticks. */
const TRAIL = { keep: 48, every: 12 };

/** What a refused contract call means, in words a person can act on. */
const FAILURE_TEXT = /** @type {Record<string, string>} */ ({
  'not-awaiting': 'Nothing is awaiting your verdict any more.',
  'in-session': 'The council is already in session.',
  'queue-full': 'The council’s table is full; wait for the next session.',
  'unknown-state': 'That rule names a state the program does not have.',
  'not-found': 'There is nothing by that name.',
  unreadable: 'That artwork was kept in a form this OS cannot run, so it stays in the gallery.',
  'not-repealable': 'That amendment cannot be undone: only enacted rule and tempo changes can.',
  storage: 'The OS database is not available right now.',
});

/** @param {any} outcome */
export function describeFailure(outcome) {
  const code = outcome?.error?.code;
  if (code && FAILURE_TEXT[code]) return FAILURE_TEXT[code];
  if (code === 'JC2050') return `The OS refused the request: ${(outcome.error.details ?? []).map((/** @type {any} */ d) => `${d.path || '/'} (${d.keyword})`).join(', ') || 'invalid input'}.`;
  return outcome?.error?.message ?? 'The request failed.';
}

/**
 * @typedef {{ setInterval: (fn: () => void, ms: number) => any, clearInterval: (id: any) => void,
 *   setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void }} Timers
 * @typedef {{
 *   node?: Element, document?: Document,
 *   edition: string, title: string, about?: any,
 *   theme?: 'light' | 'dark' | 'neon', reduce?: boolean, app?: string,
 *   store?: { invoke: (op: string, input?: any) => Promise<any> } | null,
 *   saved?: any,
 *   oracle?: (context: any, signal: AbortSignal) => Promise<any>,
 *   applyTheme?: (css: string) => void,
 *   download?: (file: { name: string, mime: string, text: string }) => void,
 *   savePrefs?: (prefs: { theme: string, reduce: boolean }) => void,
 *   keys?: { addEventListener: Function, removeEventListener: Function } | null,
 *   timers?: Timers, now?: () => number,
 *   schedule?: (flush: () => void) => void,
 *   onError?: (error: any) => void,
 *   games?: Record<string, import('../games/game.js').GameModule>,
 *   audio?: ReturnType<typeof import('../engine/audio.js').createAudio> | null,
 *   speech?: import('./studio-host.js').Speech | null,
 *   loadLibrary?: (() => Promise<any>) | null,
 *   askDocs?: ((question: string, hits: any[]) => Promise<{ text: string, citations: any[] }>) | null,
 *   crewTurn?: ((project: any) => Promise<void>) | null,
 *   onBudget?: (tier: string) => void,
 * }} OsOptions
 */

/**
 * Create the OS.
 * @param {OsOptions} options
 */
export function createOs(options) {
  const timers = options.timers ?? globalThis;
  const now = options.now ?? (() => Date.now());
  const report = options.onError ?? ((/** @type {any} */ error) => { throw error; });

  /** @type {any} */
  let app = null;
  const getState = () => app.getState();
  const dispatch = (/** @type {string} */ action, /** @type {any} */ payload = null) => app.dispatch(action, payload);

  const council = createCouncilDriver({
    getState,
    dispatch,
    oracle: options.oracle,
    validateProposal: isProposal,
    setTimer: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimer: (id) => timers.clearTimeout(id),
    now,
  });
  // the studio is bound to the contract the system serves, and the system
  // to the studio's library and arcade: each reaches the other late
  /** @type {any} */
  let system = null;
  const studio = createStudioHost({
    getState,
    dispatch,
    timers,
    now,
    council,
    invoke: (op, input) => system.client.invoke(op, input),
    games: options.games ?? {},
    audio: options.audio ?? null,
    speech: options.speech ?? null,
    loadLibrary: options.loadLibrary ?? null,
    askDocs: options.askDocs ?? null,
    crewTurn: options.crewTurn ?? null,
    ...(options.onBudget ? { onBudget: options.onBudget } : {}),
    report,
  });
  system = createSystem({
    edition: options.edition,
    title: options.title,
    getState,
    dispatch,
    council,
    store: options.store ?? null,
    now,
    ...studio.system,
  });

  // what the tape unit remembers between ticks: the tapes the dancer's
  // liveliness is judged against, and the harmony sparkline
  /** @type {Array<{ tick: number, tape: number[] }>} */
  let history = [];
  /** @type {number[]} */
  let trail = [];
  let sampled = -Infinity;

  const effects = {
    /** Step the world the action handed over and send the new one back.
     * @param {{ machine: any, world: any, steps: number }} props @param {(a: string, p?: any) => void} send */
    cpu(props, send) {
      let result;
      try {
        result = stepWorld(compileMachine(props.machine), props.world, Math.max(1, Math.min(64, Math.floor(Number(props.steps) || 1))));
      }
      catch (error) {
        send('machine/stopped', String(/** @type {any} */ (error)?.message ?? error));
        return;
      }
      const world = result.world;
      if (history.length > 0 && history[history.length - 1].tick > world.tick) { history = []; trail = []; sampled = -Infinity; }
      if (history.length === 0 || world.tick - history[history.length - 1].tick >= TRAIL.every) history.push({ tick: world.tick, tape: world.tape });
      while (history.length > 1 && history[1].tick <= world.tick - LOOKAHEAD) history.shift();
      const past = history[0].tick < world.tick ? history[0].tape : undefined;
      const measured = roundMeasure(measure(world, past));
      if (world.tick - sampled >= TRAIL.every) {
        trail = [...trail.slice(-(TRAIL.keep - 1)), measured.harmony];
        sampled = world.tick;
      }
      send('machine/advanced', { world, measure: measured, trail, fired: result.fired });
      council.onTick(world, past).catch(report);
    },
    /** @param {{ op: string, input: any }} props @param {(a: string, p?: any) => void} send */
    invoke(props, send) {
      return system.client.invoke(props.op, props.input).then((/** @type {any} */ outcome) => {
        if (!outcome.ok) send('os/notice', { tone: 'warn', text: describeFailure(outcome) });
        return outcome;
      });
    },
    /** Call the contract; send the value (with the input it answers) to
     * `then`, the refusal in words to `catch`.
     * @param {{ op: string, input?: any, then: string, catch: string }} props @param {(a: string, p?: any) => void} send */
    async call(props, send) {
      const outcome = await system.client.invoke(props.op, props.input);
      if (outcome.ok) send(props.then, { value: outcome.value, input: props.input ?? null });
      else send(props.catch, { message: describeFailure(outcome) });
    },
    /** @param {any} change @param {(a: string, p?: any) => void} send */
    forecast(change, send) {
      send('machine/forecasted', council.forecast(change));
    },
    /** @param {any} amendment */
    record(amendment) {
      options.store?.invoke('amendment.put', { amendment }).catch(() => {});
    },
    /** @param {{ theme: string, reduce: boolean }} prefs */
    prefs(prefs) {
      options.savePrefs?.(prefs);
    },
    /** @param {{ name: string, mime: string, text: string }} file */
    download(file) {
      options.download?.(file);
    },
    /** @param {{ action: string, payload?: any }} props @param {(a: string, p?: any) => void} send */
    redispatch(props, send) {
      send(props.action, props.payload ?? null);
    },
    ...studio.effects,
  };

  const subs = {
    /** @param {{ tempo: number }} props @param {(a: string) => void} send */
    ticker(props, send) {
      const id = timers.setInterval(() => send('machine/tick'), Math.max(30, Math.round(1000 / Math.max(1, props.tempo))));
      return () => timers.clearInterval(id);
    },
    /** @param {unknown} _props @param {(a: string, p?: any) => void} send */
    clock(_props, send) {
      send('os/clock', now());
      const id = timers.setInterval(() => send('os/clock', now()), 500);
      return () => timers.clearInterval(id);
    },
    /** The human's keys: V vetoes, A lets it pass, Space runs or pauses the machine, Esc or P pauses everything.
     * @param {unknown} _props @param {(a: string) => void} send */
    keys(_props, send) {
      const target = options.keys;
      if (!target) return undefined;
      const onKey = (/** @type {KeyboardEvent} */ e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = /** @type {any} */ (e.target)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || /** @type {any} */ (e.target)?.isContentEditable) return;
        const key = e.key.toLowerCase();
        // Esc and P pause anywhere, M mutes anywhere; while a game is in front its keys are the game's
        if (key === 'escape' || key === 'p') { e.preventDefault(); send('os/pause'); return; }
        if (key === 'm') { send('settings/mute'); return; }
        if (getState().arcade.game !== null) return;
        if (key === 'v') send('council/veto');
        else if (key === 'a') send('council/approve');
        else if (key === ' ' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); send('machine/toggle'); }
      };
      target.addEventListener('keydown', onKey);
      return () => target.removeEventListener('keydown', onKey);
    },
    /** Save the running session every so often. */
    autosave() {
      if (!options.store) return undefined;
      const save = () => { options.store?.invoke('session.put', { state: sessionSlice(getState()) }).catch(() => {}); };
      const id = timers.setInterval(save, AUTOSAVE_MS);
      return () => { timers.clearInterval(id); save(); };
    },
    ...studio.subs,
    /** Re-render the theme the chrome wears when the leader or the light
     * changes. Deferred a turn: the first start happens while the app is
     * still booting, before its state can be read. */
    theme() {
      if (!options.applyTheme) return undefined;
      const id = timers.setTimeout(() => {
        renderArt(getState()).then((art) => options.applyTheme?.(art.css), report);
      }, 0);
      return () => timers.clearTimeout(id);
    },
  };

  const fresh = initialState({ edition: options.edition, title: options.title, theme: options.theme, reduce: options.reduce, app: options.app });
  const state = restoreState(fresh, options.saved);
  state.os.about = options.about ?? { lead: '', sections: [], links: [] };
  state.os.now = null;
  // the arcade's shelf: what the games say about themselves
  state.arcade.shelf = Object.values(options.games ?? {}).map((g) => ({ id: g.id, title: g.title, blurb: g.blurb, duel: /** @type {any} */ (g).duel === true }));

  const doc = {
    $app: '0.1',
    state,
    view: VIEW,
    actions: {
      ...ACTIONS,
      ...STUDIO_ACTIONS,
      'os/clock': { patch: [{ op: 'replace', path: '/os/now', value: '$payload' }] },
    },
    subs: [
      { run: 'ticker', when: '$.machine.running', withQuery: { tempo: '$.program.tempo' } },
      { run: 'clock', when: { $eq: ['$.council.phase', 'veto'] } },
      { run: 'keys' },
      { run: 'autosave' },
      { run: 'theme', withQuery: { leader: '$.council.leader', theme: '$.os.theme' } },
      ...studio.entries,
    ],
  };

  app = createApp(doc, {
    ...(options.node ? { node: options.node } : {}),
    ...(options.document ? { document: options.document } : {}),
    effects,
    subs,
    widgets: { stage: stageWidget, sculpture: sculptureWidget, ...studio.widgets },
    viewModel,
    onError: report,
    ...(options.schedule ? { schedule: options.schedule } : {}),
  });
  // the saved sound mix, before the first note
  studio.effects.mix();

  return {
    app,
    system,
    council,
    studio,
    /** Stop the OS: timers, the council, the app. */
    destroy() {
      council.dispose();
      app.destroy();
    },
  };
}
