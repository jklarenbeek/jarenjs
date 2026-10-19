//@ts-check
/**
 * The arcade: the host every game runs in. A game (`game.js`) is pure;
 * the arcade is everything around it — the fixed-step loop, the keys and
 * taps (a tap is a ray from the camera through the pixel onto the
 * floor), the camera director, the effects, the ragdolls that keep the
 * figures lively, the lighting rig, the sound, and the two-way line to
 * the OS: the HUD and every line of dialogue go out as app actions; the
 * phase (title, playing, paused, over), a new run and the HUD's button
 * presses come back in as widget props.
 *
 * The arcade also answers for the game to a language model: `read` and
 * `tool` reach the live game's tools (`GameTool`), validated against
 * their own schemas, so a model can coach a player — or program a dancer
 * a rule at a time — through the OS contract's `arcade.*` operations.
 */

import { JarenValidator } from '@jarenjs/validate';
import { createSurface } from '../stage/surface.js';
import { viewOf } from '../stage/camera.js';
import { STAGE_THEMES } from '../stage/scene.js';
import { toSvg } from '../stage/paint.js';
import { createDirector } from '../engine/director.js';
import { createFx, emit as burst, stepFx, fxGroups, overlayItems, flash } from '../engine/fx.js';
import { createRagdoll, stepRagdoll, kickRagdoll, ragdollSkeleton } from '../engine/ragdoll.js';
import { createLighting } from '../engine/light.js';
import { createLoop, createInput } from '../engine/loop.js';
import { screenRay } from '../engine/collide.js';
import { flatten } from '../engine/render.js';
import { TICK_MS } from './game.js';
import { PALETTE } from '../app/state.js';

/**
 * @typedef {import('./game.js').GameModule} GameModule
 * @typedef {import('./game.js').GameEvent} GameEvent
 * @typedef {{ game: string, phase: string, seed: number, save: any, players: number, act: { seq: number, action: any },
 *   theme: string, reduce: boolean, ragdoll: boolean, light: { hour: number, bands: number, shadows: boolean }, lang: string, label?: string }} ArcadeProps
 */

/** How long a game's own work may take of a frame, ms. */
export const WORK_MS = 6;

/** The players a hot-seat game gets: one or two, in the employers' colours. */
const PLAYERS = [{ id: 'p1', name: 'Player 1', color: '#f97316' }, { id: 'p2', name: 'Player 2', color: '#2563eb' }];

/** @param {string} theme */
const themeOf = (theme) => /** @type {any} */ (STAGE_THEMES)[theme] ?? STAGE_THEMES.light;

/**
 * A fresh game state for the props' run, on the wall clock's date (a
 * game may let a skill rust over days away).
 * @param {GameModule} game @param {ArcadeProps} props @param {number} now
 */
function startState(game, props, now) {
  return game.create({ seed: props.seed, save: props.save ?? null, players: PLAYERS.slice(0, props.players === 2 ? 2 : 1), options: { lang: props.lang, now } });
}

/**
 * Build the arcade over a shelf of games.
 * @param {{ games: Record<string, GameModule>, audio?: { sfx: (name: string, o?: any) => any } | null, now?: () => number }} options
 */
export function createArcade(options) {
  const now = options.now ?? (() => Date.now());
  const validator = new JarenValidator({ collectErrors: true });
  /** @type {Map<string, any>} */
  const checks = new Map();
  /** The game being played: the arcade keeps one, however many widgets come and go. */
  const session = { id: /** @type {string | null} */ (null), state: /** @type {any} */ (null), phase: 'title', handle: /** @type {any} */ (null) };

  /** @param {string} id */
  const gameOf = (id) => options.games[id] ?? null;

  /** A move's answer: the new state, its events, what the chrome shows. @param {any} handle @param {{ state: any, events: GameEvent[] }} out */
  function apply(handle, out) {
    session.state = out.state;
    perform(handle, out.events);
    report(handle);
  }

  /** The game's work between frames, made on first need and kept for this widget's game.
   * @param {any} handle @param {GameModule} game */
  function workOf(handle, game) {
    if (!game.work) return null;
    if (handle.work?.game !== game.id) {
      handle.work?.it.dispose?.();
      handle.work = { game: game.id, it: game.work({ now: () => handle.surface.now() }) };
    }
    return handle.work.it;
  }

  /**
   * Perform a game's events: sound, effects, camera, ragdolls, and what
   * the OS should hear about.
   * @param {any} handle @param {GameEvent[]} events
   */
  function perform(handle, events) {
    for (const e of events) {
      switch (e.kind) {
        case 'sfx': options.audio?.sfx(e.name, { pitch: e.pitch ?? 1 }); break;
        case 'fx': if (handle && !handle.props.reduce) burst(handle.fx, e.fx, e.at, { colors: e.colors, count: e.count, power: e.power }); break;
        case 'shake': if (handle && !handle.props.reduce) handle.director.shake(Math.min(0.06, e.amp * 0.004), e.ms ?? 320); break;
        case 'flash': if (handle && !handle.props.reduce) flash(handle.fx, e.color); break;
        case 'shot': handle?.director.move(e.shot, { ms: e.ms ?? 900 }); break;
        case 'follow':
          if (handle) {
            handle.follow = e.target;
            handle.director.follow(e.target ? () => handle.follow : null, { lag: e.lag ?? 0.06 });
          }
          break;
        case 'kick': {
          const rag = handle?.bodies.get(e.body);
          if (rag) kickRagdoll(rag, e.impulse);
          break;
        }
        default:
          handle?.emit({ action: 'arcade/event', with: e });
      }
    }
  }

  /** Report the HUD when it changed, and the outcome once. @param {any} handle */
  function report(handle) {
    const game = gameOf(handle.props.game);
    if (!game) return;
    const hud = game.hud(session.state);
    const text = JSON.stringify(hud);
    if (text !== handle.hudText) {
      handle.hudText = text;
      handle.emit({ action: 'arcade/hud', with: hud });
    }
    const outcome = game.over(session.state);
    if (outcome && !handle.over) {
      handle.over = true;
      handle.emit({ action: 'arcade/save', with: { game: handle.props.game, save: game.save(session.state) } });
      handle.emit({ action: 'arcade/over', with: outcome });
    }
  }

  /** One rule step of the game under the controls. @param {any} handle @param {number} dt */
  function update(handle, dt) {
    const game = gameOf(handle.props.game);
    if (!game || handle.props.phase !== 'playing') return;
    const held = handle.input?.held ?? new Set();
    const out = game.step(session.state, {
      held: { up: held.has('up'), down: held.has('down'), left: held.has('left'), right: held.has('right') },
      pressed: handle.pressed.splice(0),
      tap: handle.tap,
      time: (handle.time += dt),
    }, dt);
    handle.tap = null;
    session.state = out.state;
    perform(handle, out.events);
    for (const [id, rag] of handle.bodies) {
      const want = handle.figures.get(id);
      if (want) stepRagdoll(rag, want.pose, dt / 1000);
    }
    stepFx(handle.fx, dt / 1000);
    report(handle);
  }

  /** Draw the current frame — after the game's own work, if it has any. @param {any} handle @param {number} now */
  function render(handle, now) {
    const game = gameOf(handle.props.game);
    if (!game) return;
    if (handle.props.phase === 'playing' && game.work) {
      const action = workOf(handle, game)?.frame(session.state, WORK_MS);
      if (action) apply(handle, game.act(session.state, action));
    }
    const frameMs = handle.lastFrame < 0 ? TICK_MS : Math.min(100, now - handle.lastFrame);
    handle.lastFrame = now;
    const camera = handle.director.step(handle.props.phase === 'title' ? frameMs * 0.5 : frameMs);
    const surface = handle.surface;
    const view = viewOf(camera, surface.width, surface.height);
    handle.view = view;
    const theme = themeOf(handle.props.theme);
    /** @type {Record<string, any>} */
    const bodies = {};
    if (!handle.props.reduce && handle.props.ragdoll) for (const [id, rag] of handle.bodies) bodies[id] = ragdollSkeleton(rag);
    const drawn = game.draw(session.state, {
      view, time: handle.time, theme, light: handle.light, bodies, reduce: handle.props.reduce, palette: PALETTE,
      px: Math.max(0.6, Math.min(surface.width, surface.height) / 720),
    });
    // ragdolls follow the figures the game named this frame
    handle.figures = new Map((drawn.figures ?? []).map((f) => [f.id, f]));
    for (const f of drawn.figures ?? []) if (!handle.bodies.has(f.id)) handle.bodies.set(f.id, createRagdoll(f.pose, { head: f.head ?? 'round' }));
    for (const id of [...handle.bodies.keys()]) if (!handle.figures.has(id)) handle.bodies.delete(id);
    handle.picks = drawn.picks ?? [];
    const items = [...drawn.items, ...flatten(fxGroups(handle.fx, view, theme)), ...overlayItems(handle.fx, surface.width, surface.height)];
    surface.paint(items, theme.paper, handle.props.label ?? game.title);
  }

  /** Start a run: a fresh state, the camera on the opening shot. @param {any} handle */
  function begin(handle) {
    const game = gameOf(handle.props.game);
    if (!game) return;
    session.id = handle.props.game;
    session.state = startState(game, handle.props, now());
    // a key or tap from the last run's result card is not this run's first move
    handle.pressed.length = 0;
    handle.tap = null;
    handle.time = 0;
    handle.over = false;
    handle.hudText = '';
    handle.director.cut(game.camera);
    handle.bodies.clear();
    report(handle);
  }

  /** Follow the props' phase: the loop runs only while playing; the title orbits. @param {any} handle */
  function phase(handle) {
    session.phase = handle.props.phase;
    if (handle.props.phase === 'playing') handle.loop.resume();
    else handle.loop.pause();
    handle.director.orbit(handle.props.phase === 'title' && !handle.props.reduce ? 0.12 : 0);
  }

  const widget = {
    /**
     * @param {HTMLElement} host @param {ArcadeProps} props
     * @param {(binding: any, event?: any) => void} emit @param {{ document?: Document }} [context]
     */
    mount(host, props, emit, context) {
      const surface = createSurface(host, context?.document ?? host.ownerDocument);
      const game = gameOf(props.game);
      /** @type {any} */
      const handle = {
        host, props, emit, surface,
        director: createDirector(game?.camera, { limits: false }),
        fx: createFx(props.seed),
        light: createLighting(props.light),
        bodies: new Map(), figures: new Map(), picks: [],
        pressed: [], tap: null, time: 0, lastFrame: -1, view: null, follow: null, hudText: '', over: false,
      };
      handle.loop = createLoop({
        update: (dt) => update(handle, dt),
        render: (_alpha, now) => render(handle, now),
        frame: (cb) => (typeof surface.win.requestAnimationFrame === 'function' ? surface.win.requestAnimationFrame(cb) : null),
        cancel: (id) => surface.win.cancelAnimationFrame?.(id),
      });
      handle.input = createInput(surface.win.addEventListener ? surface.win : null, (action) => {
        // the OS owns pause and mute; everything else is the game's
        if (action !== 'pause' && action !== 'mute') handle.pressed.push(action);
      });
      const tap = (/** @type {any} */ e) => {
        if (handle.props.phase !== 'playing' || !handle.view) return;
        const r = host.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        const ray = screenRay(handle.view, e.clientX - r.left, e.clientY - r.top);
        if (!ray || ray.direction[1] >= -1e-6) return;
        const t = -ray.origin[1] / ray.direction[1];
        handle.tap = { x: ray.origin[0] + ray.direction[0] * t, z: ray.origin[2] + ray.direction[2] * t };
      };
      host.addEventListener('pointerdown', tap);
      handle.off = () => host.removeEventListener('pointerdown', tap);
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', props.label ?? game?.title ?? 'Arcade');
      session.handle = handle;
      if (session.id !== props.game || session.state === null) begin(handle);
      else report(handle);
      handle.loop.start();
      phase(handle);
      render(handle, surface.now());
      return handle;
    },
    /** @param {any} handle @param {ArcadeProps} props @param {ArcadeProps} prev */
    update(handle, props, prev) {
      handle.props = props;
      if (props.light !== prev.light) handle.light = createLighting(props.light);
      if (props.game !== prev.game || props.seed !== prev.seed) begin(handle);
      if (props.act.seq !== prev.act.seq && props.act.action) {
        const game = gameOf(props.game);
        if (game) apply(handle, game.act(session.state, props.act.action));
      }
      if (props.phase !== prev.phase) phase(handle);
      if (props.label !== prev.label) handle.host.setAttribute('aria-label', props.label ?? 'Arcade');
      render(handle, handle.surface.now());
    },
    /** @param {any} handle */
    unmount(handle) {
      handle.work?.it.dispose?.();
      handle.loop.stop();
      handle.input.dispose();
      handle.off();
      handle.surface.destroy();
      if (session.handle === handle) session.handle = null;
    },
    /** A still of the opening position: the server render, the reduced-motion frame. @param {ArcadeProps} props */
    ssr(props) {
      const game = gameOf(props.game);
      if (!game) return ['div', { class: 'os-arcade-empty' }, 'No game'];
      const state = startState(game, props, now());
      const theme = themeOf(props.theme);
      const view = viewOf(game.camera, 960, 600);
      const drawn = game.draw(state, { view, time: 0, theme, light: createLighting(props.light), bodies: {}, reduce: true, palette: PALETTE, px: 1 });
      return toSvg(drawn.items, { width: 960, height: 600, background: theme.paper, title: props.label ?? game.title });
    },
  };

  return {
    widget,
    /** The live game, as `arcade.read` answers it. */
    read() {
      const game = session.id ? gameOf(session.id) : null;
      if (!game || session.state === null) return { game: null, phase: 'title', hud: null, tools: [] };
      return {
        game: game.id,
        phase: session.phase,
        hud: game.hud(session.state),
        tools: (game.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      };
    },
    /**
     * Make one of the live game's moves.
     * @param {string} name @param {any} input
     * @returns {{ ok: true, result: any } | { ok: false, error: 'no-game' | 'not-found' | 'invalid', details?: any }}
     */
    tool(name, input) {
      const game = session.id ? gameOf(session.id) : null;
      if (!game || session.state === null) return { ok: false, error: 'no-game' };
      const tool = (game.tools ?? []).find((t) => t.name === name);
      if (!tool) return { ok: false, error: 'not-found' };
      let check = checks.get(`${game.id}/${name}`);
      if (!check) {
        check = validator.compile(tool.inputSchema);
        checks.set(`${game.id}/${name}`, check);
      }
      const verdict = check(input);
      if (verdict !== true && verdict?.valid !== true) return { ok: false, error: 'invalid', details: verdict?.errors ?? null };
      const out = tool.run(session.state, input);
      session.state = out.state;
      // a model's move is shown and heard, but never rates or rewards the person at the keyboard
      if (out.events) perform(session.handle, out.events.filter((e) => e.kind !== 'rate' && e.kind !== 'xp'));
      if (session.handle) report(session.handle);
      return { ok: true, result: out.result };
    },
  };
}
