//@ts-check
/**
 * What a game is to the Radiant arcade: a module of PURE functions over
 * a plain JSON state. `create` deals the opening position, `step`
 * advances it by one fixed tick under the controls held and pressed,
 * `act` answers a discrete move (a HUD button, a tool call from a
 * language model), `draw` paints it into the stage's display list, `hud`
 * says what the chrome shows, `over` says whether it is finished and how
 * well it went. Every sound, burst, camera move, ragdoll knock and line
 * of dialogue a game wants is an EVENT it returns, never a call it makes
 * — the arcade performs them — so a game runs the same in a test, a
 * worker or the frame you are watching, and replays exactly from a seed.
 */

/**
 * @typedef {import('../stage/camera.js').Camera} Camera
 * @typedef {import('../stage/camera.js').View} View
 * @typedef {import('../stage/scene.js').Item} Item
 * @typedef {import('../stage/figures.js').Pose} Pose
 * @typedef {import('../stage/figures.js').Skeleton} Skeleton
 * @typedef {import('../engine/light.js').Lighting} Lighting
 * @typedef {import('../engine/render.js').Theme} Theme
 * @typedef {import('../engine/fx.js').FxKind} FxKind
 * @typedef {[number, number, number]} V3
 *
 * @typedef {{ id: string, name: string, color: string }} Player - a person at the keyboard (hot-seat)
 * @typedef {{ held: { up: boolean, down: boolean, left: boolean, right: boolean },
 *   pressed: string[], tap: { x: number, z: number } | null, time: number }} GameInput
 *   - `pressed`: the actions pressed since the last tick ('act', 'hint', …); `tap`: the floor point under a tap
 * @typedef {{ kind: 'sfx', name: string, pitch?: number }
 *   | { kind: 'fx', fx: FxKind, at: V3, colors?: string[], count?: number, power?: number }
 *   | { kind: 'shake', amp: number, ms?: number }
 *   | { kind: 'flash', color: string }
 *   | { kind: 'shot', shot: string | Camera, ms?: number }
 *   | { kind: 'follow', target: V3 | null, lag?: number }
 *   | { kind: 'kick', body: string, impulse: [number, number] }
 *   | { kind: 'say', who: string, text: string }
 *   | { kind: 'rate', skill: string, correct: boolean, difficulty: number, hinted?: boolean }
 *   | { kind: 'xp', amount: number, reason: string }
 *   | { kind: 'setting', key: string, value: any }} GameEvent
 *   - `say` is dialogue the HUD shows and the Mail app keeps; `rate` feeds the player's skill ladder
 *     (a `hinted` success counts for less); a tool call's `rate` and `xp` are dropped — a model's moves
 *     never rate the person;
 *     `setting` proposes an OS setting (the Arena's measured tool budget) the person applies with one press
 * @typedef {{ view: View, time: number, theme: Theme, light: Lighting | null, bodies: Record<string, Skeleton>,
 *   reduce: boolean, palette: readonly string[], px: number }} DrawContext
 *   - `bodies`: ragdoll-simulated skeletons of the figures the last draw named (absent under reduced motion)
 * @typedef {{ id: string, pose: Pose, head?: 'round' | 'tv' }} FigureRequest
 * @typedef {{ items: Item[], figures?: FigureRequest[], picks?: Array<{ id: string, x: number, y: number, r: number }> }} Drawn
 * @typedef {{ title: string, subtitle?: string, prompt?: string, score?: string, level?: string,
 *   buttons?: Array<{ id: string, label: string, primary?: boolean }>,
 *   players?: Array<{ name: string, score: string, active: boolean, color: string }>,
 *   meter?: { label: string, value: number }, toast?: string | null, help?: string,
 *   grid?: { columns: string[], rows: Array<{ label: string, cells: Array<{ id: string, text: string, active?: boolean, swatch?: string }> }> } }} Hud
 *   - `grid`: a table the chrome draws under the prompt (a rule table, a scoreboard); a cell press acts `{ type: 'cell', id }`
 * @typedef {{ stars: number, score: number, summary: string }} Outcome
 * @typedef {{ name: string, description: string, inputSchema: any,
 *   run: (state: any, input: any) => { state: any, result: any, events?: GameEvent[] } }} GameTool
 *   - a move a language model (WebMCP, the Tangle seat) may make; `run` is pure like the rest
 * @typedef {{ frame: (state: any, budgetMs: number) => ({ type: string, [k: string]: any } | null), dispose?: () => void }} GameWork
 *   - the one impure part a game may have: work the arcade runs between frames on a small budget
 *     (the Arena's live measurements), answering an action the arcade then acts like any other
 *
 * @typedef {{
 *   id: string, title: string, blurb: string, track: string, camera: Camera,
 *   create: (init: { seed: number, save: any, players: Player[], options?: any }) => any,
 *   step: (state: any, input: GameInput, dtMs: number) => { state: any, events: GameEvent[] },
 *   act: (state: any, action: { type: string, [k: string]: any }) => { state: any, events: GameEvent[] },
 *   draw: (state: any, ctx: DrawContext) => Drawn,
 *   hud: (state: any) => Hud,
 *   over: (state: any) => Outcome | null,
 *   save: (state: any) => any,
 *   tools?: GameTool[],
 *   duel?: boolean,
 *   work?: (env: { now: () => number }) => GameWork,
 * }} GameModule
 *   - `duel`: two people can play it at one keyboard; `work`: made once per arcade widget, on first need
 */

/** The fixed tick every game's `step` is written for, ms. */
export const TICK_MS = 1000 / 60;

/** No controls held or pressed: the input of a tick nobody touched. */
export const IDLE_INPUT = Object.freeze(/** @type {GameInput} */ ({
  held: Object.freeze({ up: false, down: false, left: false, right: false }),
  pressed: Object.freeze([]),
  tap: null,
  time: 0,
}));

/**
 * Drive a game headlessly: a script of inputs and actions, one per tick,
 * collecting every event — how the tests (and the Arena) play a game.
 * The clock starts at `from` and the answer says where it stopped, so a
 * second script continues the first instead of rewinding it.
 * @param {GameModule} game
 * @param {any} state
 * @param {Array<Partial<GameInput> | { act: { type: string, [k: string]: any } }>} script
 * @param {{ from?: number }} [options]
 * @returns {{ state: any, events: GameEvent[], time: number }}
 */
export function play(game, state, script, options = {}) {
  /** @type {GameEvent[]} */
  const events = [];
  let s = state;
  let time = options.from ?? 0;
  for (const entry of script) {
    if ('act' in entry && entry.act) {
      const out = game.act(s, entry.act);
      s = out.state;
      events.push(...out.events);
      continue;
    }
    time += TICK_MS;
    const input = /** @type {Partial<GameInput>} */ (entry);
    const out = game.step(s, {
      held: { ...IDLE_INPUT.held, ...input.held },
      pressed: input.pressed ?? [],
      tap: input.tap ?? null,
      time,
    }, TICK_MS);
    s = out.state;
    events.push(...out.events);
  }
  return { state: s, events, time };
}

/**
 * Ticks with no input, `n` of them — waiting inside a script.
 * @param {number} n @returns {Array<Partial<GameInput>>}
 */
export function idle(n) {
  return Array.from({ length: Math.max(0, n) }, () => ({}));
}
