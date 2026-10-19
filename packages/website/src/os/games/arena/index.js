//@ts-check
/**
 * The Bench Arena: benchmarking as a race. Every benchmark is run on a
 * track — each lane a contender, a cut-out runner whose place on its
 * lane is its measured progress — and the first across the line wins,
 * the podium follows, and the results are kept as personal bests.
 *
 * Three races:
 *
 *   - **Engines.** Six real workloads of this OS on their Jaren engines,
 *     measured live (`bench.js`). The game's `work` runs the runner's
 *     `slice` every frame while `measuring(state)` holds and the arcade
 *     acts the samples it answers (`{ type: 'measured', samples }`); a lane's finish line is
 *     its par, so on the reference machine the race is a photo finish
 *     and on this one it shows which engine runs furthest above par.
 *   - **Tool calls.** The race that tunes the OS's tool-call budget for a
 *     language model (`budget.js`): one lane per budget tier delivers
 *     the same JSON document through simulated calls that fail more the
 *     longer they are. The race is computed whole from the seed when it
 *     starts and played back; the winner is the budget to use, and
 *     `apply` proposes it as the `ai.toolBudget` setting.
 *   - **Reflex.** The human's own benchmark: a sign pops up after a
 *     seeded wait, Act (or a tap) as fast as possible, five rounds, the
 *     median graded — the reflex the council's veto relies on.
 *
 * Pure like every game: the state is plain JSON (the random stream is
 * one 32-bit number in it), time arrives in `input.time`, and every
 * sound, burst, camera move and ragdoll knock is an event. HUD buttons
 * name the action they act; `race:tools` acts `{ type: 'race', kind: 'tools' }`.
 */

import { mulberry32 } from '@jarenjs/core/random';
import { spring } from '../../engine/fx.js';
import { CONTENDERS, createBenchRunner } from './bench.js';
import { TIERS, PROFILES, isProfile, tierOf, chunkOf, successChance, raceToolBudgets, laneProgress } from './budget.js';
import { drawTrack, runnerAt, laneZ, X0, X1, PODIUM, MEDALS, SIGN, TRACK_CAMERA, START_SHOT, PODIUM_SHOT } from './track.js';

/**
 * @typedef {import('../game.js').GameModule} GameModule
 * @typedef {import('../game.js').GameEvent} GameEvent
 * @typedef {import('../game.js').GameInput} GameInput
 * @typedef {import('../game.js').GameTool} GameTool
 * @typedef {import('../game.js').Hud} Hud
 * @typedef {import('../game.js').Outcome} Outcome
 * @typedef {'engines' | 'tools' | 'reflex'} RaceKind
 * @typedef {{ stars: number | null, engines: Record<string, number>, tools: Record<string, Record<string, number>>,
 *   budgets: Record<string, string>, reflex: { best: number | null, median: number | null } }} Bests
 *   - stars: the most any race earned; engines: ops a second per contender; tools: characters a
 *     simulated second per profile and tier; budgets: the last recommended tier per profile
 */

/** The races, in menu order. */
export const KINDS = /** @type {readonly RaceKind[]} */ (Object.freeze(['engines', 'tools', 'reflex']));

/** What the HUD calls each race. */
const TITLES = Object.freeze({ engines: 'Engine Race', tools: 'Tool-call Race', reflex: 'Reflex Race' });

const HELP = Object.freeze({
  engines: 'Six real workloads of this OS race on their Jaren engines, measured live: the turmite stepping its program, '
    + 'the merit graph compiled, the scene stylesheet, a proposal checked against the contract, an amendment patched in, '
    + 'the council tally queried. Every lane gets the same share of each frame, and its finish line is its par, the speed '
    + 'a reference machine reaches, so the winner is the engine running furthest above par on this device.',
  tools: 'A language model hands the OS big JSON documents through tool calls, and small models fumble long arguments, '
    + 'so the OS cuts them into chunks: the tool-call budget. Each lane delivers the same document at one budget. Big '
    + 'calls fail and are sent again; small calls pay the round trip every time. The first lane home is the budget to '
    + 'use, and Apply sets it.',
  reflex: 'Wait for the sign, then press Act (Space or Enter) or tap, as fast as you can. Five rounds; pressing early '
    + 'only restarts the wait. A star for a median under 450, 350 and 280 ms: the reflex the veto relies on.',
});

/** Runner colours, lane by lane: the OS's five brights and a lime. The human runs in orange. */
const RUNNERS = Object.freeze(['#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4', '#84cc16']);
const HUMAN = '#f97316';

/** CPU time a lane needs at its par to finish, ms: the length of the engine track. */
export const COURSE_MS = 400;
/** One beat of the countdown, ms. */
const BEAT_MS = 800;
/** How long the tool race's winner takes to cross on screen, and the longest a whole race may take, ms. */
const TOOL_RACE_MS = 7000;
const TOOL_RACE_MAX_MS = 12000;
/** The document the tool race delivers unless told otherwise: an app document. */
export const DEFAULT_CHARS = 6000;
const WORKLOADS = Object.freeze([1500, 6000, 24000]);
const CHARS_MIN = 100;
const CHARS_MAX = 100000;
/** The reflex race: rounds, the seeded wait before the sign, how long the sign waits for a press. */
export const ROUNDS = 5;
const WAIT_MIN = 1200;
const WAIT_MAX = 3400;
const SIGN_MS = 2500;
const RESULT_MS = 900;
/** A star for a median reaction under each of these, ms. */
export const STARS_AT = Object.freeze([450, 350, 280]);
const TOAST_MS = 2600;
/** The lead may change hands audibly at most this often, ms. */
const LEAD_MS = 1200;
/** How fast a runner closes on its progress, ms (exponential). */
const EASE_MS = 140;
/** After a finish, Act starts the next race only once this has passed, ms. */
const HOLD_MS = 1200;

/** The increment of mulberry32's state: its whole stream is one 32-bit number. */
const GOLDEN = 0x6d2b79f5;

/**
 * The next draw of the state's random stream, advancing it: the same
 * numbers `mulberry32(seed)` would answer in turn, kept as JSON.
 * @param {any} s @returns {number} in [0, 1)
 */
function draw(s) {
  const value = mulberry32(s.rng)();
  s.rng = (s.rng + GOLDEN) >>> 0;
  return value;
}

/** Three significant digits: steady enough that the HUD only changes when the number does. @param {number} x */
const sig3 = (x) => Number(x.toPrecision(3));
/** @param {number} n */
const fmtRate = (n) => (n >= 1e6 ? `${sig3(n / 1e6)}M ops/s` : n >= 1e3 ? `${sig3(n / 1e3)}k ops/s` : `${Math.round(n)} ops/s`);
/** @param {number} ms */
const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** @param {number} chars */
const fmtChars = (chars) => (chars >= 1000 ? `${Number((chars / 1000).toFixed(1))}k` : String(chars));
/** @param {number} x */
const pct = (x) => `${Math.round(x * 100)}%`;
/** @param {number} n */
const clampChars = (n) => Math.max(CHARS_MIN, Math.min(CHARS_MAX, Math.round(n)));
/** @param {unknown} v @returns {v is number} */
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** @param {import('./budget.js').Tier} tier */
const tierLabel = (tier) => (tier.chars === null ? 'unlimited' : `${tier.id} ${fmtChars(tier.chars)}`);
/** A lane's measured speed, ops a second. @param {any} lane */
const rateOf = (lane) => (lane.ms > 0 ? (lane.ops / lane.ms) * 1000 : 0);
/** Ops lane `i` must run to finish. @param {number} i */
const courseOf = (i) => (CONTENDERS[i].par * COURSE_MS) / 1000;

/**
 * Personal bests out of a save, keeping only what this Arena knows: a
 * save from an older or a broken build loses nothing that still fits.
 * @param {any} save @returns {Bests}
 */
function readBests(save) {
  /** @type {Bests} */
  const best = { stars: null, engines: {}, tools: {}, budgets: {}, reflex: { best: null, median: null } };
  const src = save && typeof save === 'object' ? save : {};
  if (Number.isInteger(src.best) && src.best >= 0 && src.best <= STARS_AT.length) best.stars = src.best;
  for (const c of CONTENDERS) if (positive(src.engines?.[c.id])) best.engines[c.id] = src.engines[c.id];
  for (const id of Object.keys(PROFILES)) {
    for (const tier of TIERS) {
      const v = src.tools?.[id]?.[tier.id];
      if (positive(v)) (best.tools[id] ??= {})[tier.id] = v;
    }
    if (tierOf(src.budgets?.[id])) best.budgets[id] = src.budgets[id];
  }
  if (positive(src.reflex?.best)) best.reflex.best = src.reflex.best;
  if (positive(src.reflex?.median)) best.reflex.median = src.reflex.median;
  return best;
}

/**
 * A lane at the start line.
 * @param {string} id @param {string} label @param {string} color
 */
const laneOf = (id, label, color) => ({ id, label, color, progress: 0, shown: 0, ops: 0, ms: 0, place: /** @type {number | null} */ (null), out: false });

/** The lanes of the race the state is set to. @param {any} s */
function lanesFor(s) {
  if (s.kind === 'engines') return CONTENDERS.map((c, i) => laneOf(c.id, c.label, RUNNERS[i % RUNNERS.length]));
  if (s.kind === 'tools') return TIERS.map((tier, i) => laneOf(tier.id, tierLabel(tier), RUNNERS[i]));
  return [laneOf('you', s.player.name, s.player.color)];
}

/** Back to the start line of the race the state is set to. @param {any} s */
function reset(s) {
  s.phase = 'ready';
  s.phaseAt = null;
  s.count = -1;
  s.leader = null;
  s.leadAt = null;
  s.places = [];
  s.tools = null;
  s.reflex = null;
  s.lanes = lanesFor(s);
}

/** Show a message for a moment. @param {any} s @param {string} text */
function toast(s, text) {
  s.toast = { text, left: TOAST_MS };
}

/**
 * The opening position.
 * @param {{ seed: number, save: any, players: import('../game.js').Player[], options?: any }} init
 */
function create(init) {
  const seed = (Number(init.seed) || 0) >>> 0;
  const player = init.players?.[0];
  // the race asked for, else the one played last, else the engines
  const pick = { ...init.save?.pick, ...init.options };
  const s = {
    v: 1,
    seed,
    rng: seed,
    kind: KINDS.includes(pick.kind) ? pick.kind : 'engines',
    profile: isProfile(pick.profile) ? pick.profile : 'moe-3b-active',
    chars: Number.isFinite(pick.chars) ? clampChars(pick.chars) : DEFAULT_CHARS,
    phase: 'ready',
    now: 0,
    phaseAt: null,
    count: -1,
    lanes: [],
    leader: null,
    leadAt: null,
    places: [],
    tools: null,
    reflex: null,
    player: { name: player?.name ?? 'You', color: player?.color ?? HUMAN },
    toast: null,
    applied: null,
    last: null,
    best: readBests(init.save),
  };
  reset(s);
  return s;
}

/**
 * On your marks: a fresh field and the countdown. The tool race is run
 * whole here, from the next seed of the stream, and played back after GO.
 * @param {any} s @param {GameEvent[]} events @returns {false | void}
 */
function begin(s, events) {
  if (s.phase === 'countdown' || s.phase === 'racing') return false;
  reset(s);
  s.phase = 'countdown';
  if (s.kind === 'tools') {
    const race = raceToolBudgets(s.profile, s.chars, Math.floor(draw(s) * 2 ** 32));
    const first = /** @type {import('./budget.js').Lane} */ (race.lanes.find((l) => l.tier === race.ranking[0]));
    const winnerMs = first.finished ? first.ms : race.endMs;
    s.tools = { race, t: 0, rate: Math.max(winnerMs / TOOL_RACE_MS, race.endMs / TOOL_RACE_MAX_MS) };
  }
  events.push({ kind: 'sfx', name: 'whoosh' }, { kind: 'shot', shot: START_SHOT, ms: 900 });
}

/** Three, two, one: a click a beat, then GO. @param {any} s @param {GameEvent[]} events */
function countdown(s, events) {
  const beat = Math.min(3, Math.floor((s.now - s.phaseAt) / BEAT_MS));
  while (s.count < beat) {
    s.count += 1;
    if (s.count < 3) events.push({ kind: 'sfx', name: 'click', pitch: 1 + s.count * 0.15 });
    else go(s, events);
  }
}

/** The gun. @param {any} s @param {GameEvent[]} events */
function go(s, events) {
  s.phase = 'racing';
  s.phaseAt = s.now;
  if (s.kind === 'reflex') {
    s.reflex = { stage: 'wait', at: s.now, waitMs: 0, times: [], early: 0, missed: 0, last: null, lift: 0.35, vel: 0 };
    wait(s);
  }
  events.push({ kind: 'sfx', name: 'start' }, { kind: 'fx', fx: 'radiance', at: [X0, 1, 0], power: 1.6 },
    { kind: 'shake', amp: 2, ms: 220 }, { kind: 'shot', shot: TRACK_CAMERA, ms: 800 });
}

/**
 * A runner crosses the line: a place, and the noise a place deserves.
 * @param {any} s @param {number} i @param {GameEvent[]} events
 */
function cross(s, i, events) {
  const lane = s.lanes[i];
  lane.place = s.places.length + 1;
  lane.progress = 1;
  s.places.push(i);
  const z = laneZ(i, s.lanes.length);
  if (lane.place === 1) {
    events.push({ kind: 'sfx', name: 'levelup' }, { kind: 'fx', fx: 'confetti', at: [X1, 0.6, z], colors: [lane.color, MEDALS[0], '#06b6d4'] },
      { kind: 'fx', fx: 'radiance', at: [X1, 1.2, z] }, { kind: 'shake', amp: 4, ms: 300 });
  }
  else {
    events.push({ kind: 'sfx', name: 'coin', pitch: lane.place === 2 ? 0.9 : 0.8 }, { kind: 'fx', fx: 'sparks', at: [X1, 0.6, z], colors: [lane.color] });
  }
}

/**
 * Who leads, and a whoosh when the lead changes hands for real (not the
 * jostle off the line, not more often than `LEAD_MS`).
 * @param {any} s @param {GameEvent[]} events
 */
function lead(s, events) {
  let best = 0;
  s.lanes.forEach((/** @type {any} */ lane, /** @type {number} */ i) => { if (lane.progress > s.lanes[best].progress) best = i; });
  if (best === s.leader) return;
  if (s.leader !== null && s.lanes[best].progress >= 0.1 && (s.leadAt === null || s.now - s.leadAt >= LEAD_MS)) {
    events.push({ kind: 'sfx', name: 'whoosh', pitch: 1.2 });
    s.leadAt = s.now;
  }
  s.leader = best;
}

/**
 * The race is decided: the podium stands, the bests are kept, the
 * camera goes to the medals and the Mail app keeps the result.
 * @param {any} s @param {GameEvent[]} events @param {any} last
 * @param {[number, number, number]} at - where the stars burst
 * @param {any} shot
 */
function finish(s, events, last, at, shot) {
  s.phase = 'finished';
  s.phaseAt = s.now;
  s.last = last;
  s.best.stars = Math.max(s.best.stars ?? 0, last.stars);
  events.push({ kind: 'fx', fx: 'stars', at, count: 14 }, { kind: 'sfx', name: 'chime' }, { kind: 'shot', shot, ms: 1100 },
    { kind: 'say', who: 'Arena', text: last.summary });
}

/**
 * Samples from the runner: each lane's operations and the time they took.
 * @param {any} s @param {any} samples @param {GameEvent[]} events @returns {false | void}
 */
function measured(s, samples, events) {
  if (s.kind !== 'engines' || s.phase !== 'racing' || !Array.isArray(samples)) return false;
  /** @type {Array<{ lane: number, at: number }>} */
  const crossings = [];
  for (const sample of samples) {
    const lane = Number.isInteger(sample?.lane) ? s.lanes[sample.lane] : undefined;
    if (!lane || lane.place !== null || !(sample.ops >= 0) || !(sample.ms >= 0)) continue;
    const course = courseOf(sample.lane);
    const before = lane.ops;
    lane.ops += sample.ops;
    lane.ms += sample.ms;
    lane.progress = Math.min(1, lane.ops / course);
    // when, in the lane's own measured time, it reached the line
    if (lane.ops >= course) crossings.push({ lane: sample.lane, at: lane.ms - sample.ms + sample.ms * ((course - before) / sample.ops) });
  }
  crossings.sort((a, b) => a.at - b.at);
  for (const c of crossings) cross(s, c.lane, events);
  lead(s, events);
  if (s.places.length >= Math.min(PODIUM.length, s.lanes.length)) finishEngines(s, events);
}

/** @param {any} s @param {GameEvent[]} events */
function finishEngines(s, events) {
  /** @type {string[]} */
  const fresh = [];
  s.lanes.forEach((/** @type {any} */ lane) => {
    const rate = rateOf(lane);
    if (rate > (s.best.engines[lane.id] ?? 0)) {
      s.best.engines[lane.id] = Math.round(rate);
      fresh.push(lane.label);
    }
  });
  const podium = s.places.slice(0, PODIUM.length).map((/** @type {number} */ i) => ({ id: s.lanes[i].id, label: s.lanes[i].label, value: fmtRate(rateOf(s.lanes[i])) }));
  const paces = s.places.slice(0, PODIUM.length).map((/** @type {number} */ i) => rateOf(s.lanes[i]) / CONTENDERS[i].par);
  const winner = s.lanes[s.places[0]];
  const summary = `${winner.label} won at ${paces[0].toFixed(2)}× par (${podium[0].value}), ${podium[1].label} second, ${podium[2].label} third.`;
  if (fresh.length > 0) toast(s, fresh.length === 1 ? `New personal best: ${fresh[0]}` : `${fresh.length} new personal bests`);
  // a star for the race, one for a personal best on any lane, one for a winner at or above its par
  const stars = 1 + (fresh.length > 0 ? 1 : 0) + (paces[0] >= 1 ? 1 : 0);
  finish(s, events, { kind: 'engines', podium, summary, stars, score: Math.round(rateOf(winner)) },
    [PODIUM[0].x, 3.4, PODIUM[0].z], PODIUM_SHOT);
}

/**
 * Play the tool race forward: stumbles where calls fail, a tumble where
 * a lane gives up, places as lanes deliver, the podium when it is decided.
 * @param {any} s @param {number} dt @param {GameEvent[]} events
 */
function playTools(s, dt, events) {
  const play = s.tools;
  const from = play.t;
  const to = Math.min(play.race.endMs, from + dt * play.rate);
  play.t = to;
  play.race.lanes.forEach((/** @type {import('./budget.js').Lane} */ lane, /** @type {number} */ i) => {
    const runner = s.lanes[i];
    runner.progress = laneProgress(lane, play.race.chars, to);
    lane.calls.forEach((call, k) => {
      const end = call.at + call.ms;
      if (call.ok || end <= from || end > to) return;
      if (!lane.finished && k === lane.calls.length - 1) {
        runner.out = true;
        events.push({ kind: 'kick', body: `lane-${i}`, impulse: [-8, 7] }, { kind: 'sfx', name: 'wrong', pitch: 0.7 }, { kind: 'fx', fx: 'dust', at: runnerAt(s, i) });
      }
      else {
        events.push({ kind: 'kick', body: `lane-${i}`, impulse: [-4, 3] }, { kind: 'sfx', name: 'wrong' });
      }
    });
  });
  for (const tier of play.race.ranking) {
    const i = TIERS.findIndex((t) => t.id === tier);
    const lane = play.race.lanes[i];
    if (lane.finished && s.lanes[i].place === null && lane.ms <= to) cross(s, i, events);
  }
  lead(s, events);
  if (to >= play.race.endMs) finishTools(s, events);
}

/** @param {any} s @param {GameEvent[]} events */
function finishTools(s, events) {
  const race = s.tools.race;
  const profile = PROFILES[race.profile];
  const tier = race.recommended;
  // a lane caught mid-call when the podium is decided stands where its
  // delivered chunks put it, and one that would only give up falls
  race.lanes.forEach((/** @type {import('./budget.js').Lane} */ sim, /** @type {number} */ i) => {
    const lane = s.lanes[i];
    if (lane.place !== null) return;
    lane.progress = callsBack(sim, s.tools.t).reduce((done, c) => done + (c.ok ? c.size : 0), 0) / race.chars;
    if (!sim.finished) lane.out = true;
  });
  s.best.budgets[race.profile] = tier;
  const bests = (s.best.tools[race.profile] ??= {});
  for (const lane of race.lanes) {
    const rate = Math.round(race.chars / (lane.ms / 1000));
    if (lane.finished && rate > (bests[lane.tier] ?? 0)) bests[lane.tier] = rate;
  }
  const win = race.lanes.find((/** @type {any} */ l) => l.tier === tier);
  const podium = s.places.slice(0, PODIUM.length).map((/** @type {number} */ i) => ({ id: s.lanes[i].id, label: s.lanes[i].label, value: fmtSeconds(race.lanes[i].ms) }));
  const summary = win.finished
    ? `Best budget for ${profile.label}: ${tier}. ${fmtChars(race.chars)} characters in ${win.calls.length} calls, ${fmtSeconds(win.ms)} simulated.`
    : `Best budget for ${profile.label}: ${tier}. No budget delivered all ${fmtChars(race.chars)} characters; ${tier} got furthest.`;
  // a star for the race, one for a winner that never had to resend, one for
  // a budget that beat sending the whole document in one call
  const whole = race.lanes[race.lanes.length - 1];
  const beat = win.finished && (!whole.finished || win.ms < whole.ms);
  const stars = 1 + (win.finished && win.failures === 0 ? 1 : 0) + (beat ? 1 : 0);
  finish(s, events, {
    kind: 'tools', profile: race.profile, chars: race.chars, recommended: tier, podium, summary, stars,
    score: win.finished ? Math.round(race.chars / (win.ms / 1000)) : 0,
  }, [PODIUM[0].x, 3.4, PODIUM[0].z], PODIUM_SHOT);
}

/** A new seeded wait before the next sign. @param {any} s */
function wait(s) {
  const r = s.reflex;
  r.stage = 'wait';
  r.at = s.now;
  r.waitMs = Math.round(WAIT_MIN + draw(s) * (WAIT_MAX - WAIT_MIN));
}

/** The top of the reflex sign, where its bursts go. */
const SIGN_TOP = /** @type {[number, number, number]} */ ([(SIGN.x0 + SIGN.x1) / 2, 2.8, (SIGN.z0 + SIGN.z1) / 2]);

/**
 * One tick of the reflex race.
 * @param {any} s @param {GameInput} input @param {GameEvent[]} events
 */
function playReflex(s, input, events) {
  const r = s.reflex;
  const press = input.pressed.includes('act') || Boolean(input.tap);
  if (r.stage === 'wait') {
    if (press) {
      r.early += 1;
      wait(s);
      toast(s, 'Too early! Wait for the sign.');
      events.push({ kind: 'sfx', name: 'wrong', pitch: 1.3 }, { kind: 'kick', body: 'lane-0', impulse: [-2.5, 2] });
    }
    else if (s.now - r.at >= r.waitMs) {
      r.stage = 'sign';
      r.at = s.now;
      events.push({ kind: 'sfx', name: 'pop' }, { kind: 'fx', fx: 'radiance', at: SIGN_TOP, power: 1.4 });
    }
  }
  else if (r.stage === 'sign') {
    if (press) {
      const ms = Math.round(s.now - r.at);
      r.times.push(ms);
      r.last = ms;
      r.stage = 'result';
      r.at = s.now;
      s.lanes[0].progress = r.times.length / ROUNDS;
      events.push({ kind: 'sfx', name: ms < STARS_AT[1] ? 'coin' : 'right' }, { kind: 'fx', fx: 'stars', at: SIGN_TOP, count: 6 },
        { kind: 'kick', body: 'lane-0', impulse: [1.5, 5] });
      if (r.times.length >= ROUNDS) finishReflex(s, events);
    }
    else if (s.now - r.at >= SIGN_MS) {
      r.missed += 1;
      wait(s);
      toast(s, 'Missed that one. Here comes another.');
      events.push({ kind: 'sfx', name: 'whoosh' });
    }
  }
  else if (s.now - r.at >= RESULT_MS) {
    wait(s);
  }
}

/** @param {any} s @param {GameEvent[]} events */
function finishReflex(s, events) {
  const r = s.reflex;
  const sorted = [...r.times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const best = sorted[0];
  /** @type {string[]} */
  const fresh = [];
  if (s.best.reflex.best === null || best < s.best.reflex.best) {
    s.best.reflex.best = best;
    fresh.push(`best ${best} ms`);
  }
  if (s.best.reflex.median === null || median < s.best.reflex.median) {
    s.best.reflex.median = median;
    fresh.push(`median ${median} ms`);
  }
  if (fresh.length > 0) toast(s, `New personal ${fresh.join(' and ')}`);
  const lane = s.lanes[0];
  lane.place = 1;
  s.places = [0];
  events.push({ kind: 'sfx', name: 'levelup' }, { kind: 'fx', fx: 'confetti', at: [X1, 0.6, 0], colors: [lane.color, MEDALS[0], '#2563eb'] },
    { kind: 'fx', fx: 'radiance', at: [X1, 1.2, 0] });
  const summary = `Median ${median} ms, best ${best} ms over ${ROUNDS} rounds${r.early > 0 ? `, ${r.early} early` : ''}.`;
  finish(s, events, {
    kind: 'reflex', median, best, early: r.early, podium: [{ id: lane.id, label: lane.label, value: `${median} ms` }], summary,
    stars: STARS_AT.filter((limit) => median < limit).length, score: Math.round(100000 / Math.max(1, median)),
  }, SIGN_TOP, TRACK_CAMERA);
}

/**
 * Animation that follows the rules: runners close on their progress, the
 * reflex sign springs to its height.
 * @param {any} s @param {number} dt
 */
function settle(s, dt) {
  const k = 1 - Math.exp(-dt / EASE_MS);
  for (const lane of s.lanes) lane.shown += (lane.progress - lane.shown) * k;
  const r = s.reflex;
  if (r) {
    const target = r.stage === 'sign' ? 2.6 : r.stage === 'result' || s.phase === 'finished' ? 1.6 : 0.35;
    [r.lift, r.vel] = spring(r.lift, r.vel, target, 300, 14, Math.min(0.05, dt / 1000));
  }
}

/**
 * A clock that started again (a host that resets its time, a test that
 * plays in pieces): every moment the rules measure from moves with it,
 * so no wait, countdown or reaction loses or gains time.
 * @param {any} s @param {number} delta
 */
function rebase(s, delta) {
  if (s.phaseAt !== null) s.phaseAt += delta;
  if (s.leadAt !== null) s.leadAt += delta;
  if (s.reflex) s.reflex.at += delta;
}

/**
 * One fixed tick.
 * @param {any} state @param {GameInput} input @param {number} dtMs
 * @returns {{ state: any, events: GameEvent[] }}
 */
function step(state, input, dtMs) {
  const s = structuredClone(state);
  /** @type {GameEvent[]} */
  const events = [];
  const dt = Math.max(0, Math.min(100, Number(dtMs) || 0));
  const now = Number(input.time) || 0;
  if (now < s.now) rebase(s, now - s.now);
  s.now = now;
  s.phaseAt ??= now;
  if (s.toast) {
    s.toast.left -= dt;
    if (s.toast.left <= 0) s.toast = null;
  }
  const pressed = input.pressed.includes('act');
  if (s.phase === 'ready' && pressed) begin(s, events);
  else if (s.phase === 'finished' && pressed && s.now - s.phaseAt >= HOLD_MS) begin(s, events);
  else if (s.phase === 'countdown') countdown(s, events);
  else if (s.phase === 'racing' && s.kind === 'tools') playTools(s, dt, events);
  else if (s.phase === 'racing' && s.kind === 'reflex') playReflex(s, input, events);
  settle(s, dt);
  return { state: s, events };
}

/**
 * The tool budget proposed as the OS setting: the last race's for the
 * profile chosen, kept across sessions.
 * @param {any} s @param {GameEvent[]} events
 */
function apply(s, events) {
  const tier = s.best.budgets[s.profile];
  if (!tier) {
    toast(s, `Race the tool calls for ${PROFILES[s.profile].label} first.`);
    events.push({ kind: 'sfx', name: 'pop' });
    return;
  }
  s.applied = { profile: s.profile, tier };
  events.push({ kind: 'setting', key: 'ai.toolBudget', value: tier }, { kind: 'sfx', name: 'coin' },
    { kind: 'fx', fx: 'sparks', at: [PODIUM[0].x, 2.4, PODIUM[0].z], colors: [MEDALS[0], '#16a34a'] });
}

/**
 * A press on the tool table: that budget's run, told in a sentence.
 * @param {any} s @param {string} id - a cell id, `<tier>-<column>` @param {GameEvent[]} events
 * @returns {false | void}
 */
function cell(s, id, events) {
  const i = TIERS.findIndex((t) => id.startsWith(`${t.id}-`));
  if (s.kind !== 'tools' || i < 0) return false;
  const tier = TIERS[i];
  const chunk = chunkOf(tier, s.chars);
  if (!s.tools) {
    toast(s, `${tierLabel(tier)}: ${Math.ceil(s.chars / chunk)} calls of up to ${chunk} characters, `
      + `each coming back whole ${pct(successChance(s.profile, chunk))} of the time.`);
  }
  else {
    const sim = s.tools.race.lanes[i];
    const back = callsBack(sim, s.phase === 'finished' ? Infinity : s.tools.t);
    toast(s, `${tierLabel(tier)}: ${back.length} calls sent, ${back.filter((c) => c.ok).length} came back whole.`);
  }
  events.push({ kind: 'sfx', name: 'click' });
}

/**
 * What an action asks for: `{ type: 'race', kind }`, or the HUD button
 * spelling `{ type: 'race:tools' }` that carries its one argument in its id.
 * @param {any} action @returns {{ type: string, arg: any }}
 */
function parseAction(action) {
  const raw = String(action?.type ?? '');
  const colon = raw.indexOf(':');
  if (colon < 0) return { type: raw, arg: action?.kind ?? action?.id ?? action?.chars };
  return { type: raw.slice(0, colon), arg: raw.slice(colon + 1) };
}

/** @type {Record<string, (s: any, arg: any, events: GameEvent[], action: any) => false | void>} */
const ACTS = {
  race(s, kind, events) {
    if (!KINDS.includes(kind) || (kind === s.kind && s.phase === 'ready')) return false;
    s.kind = kind;
    reset(s);
    events.push({ kind: 'sfx', name: 'open' }, { kind: 'shot', shot: TRACK_CAMERA, ms: 700 });
  },
  profile(s, id, events) {
    if (!isProfile(id) || id === s.profile) return false;
    s.profile = id;
    if (s.kind === 'tools') reset(s);
    events.push({ kind: 'sfx', name: 'click' });
  },
  workload(s, chars, events) {
    const n = Number(chars);
    if (!Number.isFinite(n) || clampChars(n) === s.chars) return false;
    s.chars = clampChars(n);
    if (s.kind === 'tools') reset(s);
    events.push({ kind: 'sfx', name: 'click' });
  },
  cell: (s, id, events) => cell(s, String(id), events),
  start: (s, _arg, events) => begin(s, events),
  again: (s, _arg, events) => (s.phase === 'finished' ? begin(s, events) : false),
  measured: (s, _arg, events, action) => measured(s, action.samples, events),
  apply: (s, _arg, events) => apply(s, events),
};

/**
 * A discrete move: a HUD button, a host's measurement, a tool call.
 * @param {any} state @param {{ type: string, [k: string]: any }} action
 * @returns {{ state: any, events: GameEvent[] }}
 */
function act(state, action) {
  const { type, arg } = parseAction(action);
  if (!Object.hasOwn(ACTS, type)) return { state, events: [] };
  const s = structuredClone(state);
  /** @type {GameEvent[]} */
  const events = [];
  if (ACTS[type](s, arg, events, action) === false) return { state, events: [] };
  return { state: s, events };
}

/**
 * True while the engine race wants measurements: the host then calls the
 * runner's `slice` each frame and acts what it answers.
 * @param {any} state
 */
export const measuring = (state) => state.kind === 'engines' && state.phase === 'racing';

/** The calls of a tool lane that have come back by simulated time `t`.
 * @param {import('./budget.js').Lane} lane @param {number} t */
const callsBack = (lane, t) => lane.calls.filter((c) => c.at + c.ms <= t);

/** @param {any} s @param {number} i */
function scoreOf(s, i) {
  const lane = s.lanes[i];
  if (s.kind === 'engines') return lane.ms > 0 ? fmtRate(rateOf(lane)) : '—';
  if (s.kind === 'tools') {
    if (!s.tools) return `${pct(successChance(s.profile, chunkOf(TIERS[i], s.chars)))} a call`;
    // once the race is decided, every lane's whole simulated run
    const t = s.phase === 'finished' ? Infinity : s.tools.t;
    const sim = s.tools.race.lanes[i];
    if (sim.finished && sim.ms <= t) return fmtSeconds(sim.ms);
    if (lane.out || s.phase === 'finished') return 'gave up';
    return `${callsBack(sim, t).length} calls`;
  }
  if (s.phase === 'finished') return `${s.last.median} ms`;
  return `${s.reflex?.times.length ?? 0}/${ROUNDS}`;
}

/** @param {any} s */
function promptOf(s) {
  if (s.phase === 'countdown') return 'On your marks…';
  if (s.phase === 'finished') return s.kind === 'tools' ? `Best budget for ${PROFILES[s.last.profile].label}: ${s.last.recommended}` : s.last.summary;
  if (s.phase === 'ready') {
    if (s.kind === 'engines') return 'Press Start. Each lane runs its real workload in turn, and its finish line sits at its par.';
    if (s.kind === 'reflex') return 'Press Start. When the sign pops up, press Act or tap, as fast as you can.';
    const kept = s.best.budgets[s.profile];
    return `Deliver ${fmtChars(s.chars)} characters of JSON through ${PROFILES[s.profile].label} tool calls: which budget gets there first?`
      + (kept ? ` Last best: ${kept}.` : '');
  }
  if (s.kind === 'reflex') return s.reflex.stage === 'sign' ? 'NOW!' : s.reflex.stage === 'result' ? `${s.reflex.last} ms` : 'Wait for it…';
  if (s.kind === 'tools') return `${Math.floor(s.tools.t / 1000)} s simulated. Big calls stumble; small calls pay the round trip.`;
  return s.leader === null ? 'They\'re off!' : `${s.lanes[s.leader].label} leads.`;
}

/** @param {any} s */
function buttonsOf(s) {
  if (s.phase === 'countdown' || s.phase === 'racing') return [];
  /** @type {Array<{ id: string, label: string, primary?: boolean }>} */
  const buttons = [];
  const kept = s.best.budgets[s.profile];
  if (s.kind === 'tools' && kept) {
    const done = s.applied?.profile === s.profile && s.applied.tier === kept;
    buttons.push({ id: 'apply', label: done ? `Applied: ${kept}` : `Apply ${kept}`, primary: s.phase === 'finished' });
  }
  // a decided race is the arcade's to replay (its result card plays again,
  // from the save), so only a race not yet run offers the choices
  if (s.phase === 'finished') return buttons;
  buttons.unshift({ id: 'start', label: 'Start', primary: true });
  for (const kind of KINDS) if (kind !== s.kind) buttons.push({ id: `race:${kind}`, label: TITLES[kind] });
  if (s.kind === 'tools') {
    for (const id of Object.keys(PROFILES)) buttons.push({ id: `profile:${id}`, label: `${id === s.profile ? '✓ ' : ''}${PROFILES[id].label}` });
    for (const chars of WORKLOADS) buttons.push({ id: `workload:${chars}`, label: `${chars === s.chars ? '✓ ' : ''}${fmtChars(chars)} chars` });
  }
  return buttons;
}

/** @param {any} s @returns {{ label: string, value: number } | null} */
function meterOf(s) {
  if (s.phase === 'ready' || s.phase === 'countdown') return null;
  if (s.kind === 'reflex') {
    const label = s.phase === 'finished' ? `median ${s.last.median} ms` : s.reflex.last === null ? 'reaction' : `${s.reflex.last} ms`;
    return { label, value: s.lanes[0].progress };
  }
  const i = s.phase === 'finished' ? s.places[0] : s.leader;
  // off the line, before anything is measured, there is no speed to show
  if (i === undefined || i === null) return null;
  const lane = s.lanes[i];
  const value = Math.round(lane.progress * 100) / 100;
  if (s.kind === 'engines') return { label: `${lane.label} · ${fmtRate(rateOf(lane))}`, value };
  // the race clock while the leader runs, its own time once it is home
  const home = lane.place !== null ? fmtSeconds(s.tools.race.lanes[i].ms) : `${Math.floor(s.tools.t / 1000)} s simulated`;
  return { label: `${lane.label} · ${home}`, value };
}

/** The tool race as a table: budget × success × calls × time. @param {any} s */
function gridOf(s) {
  const play = s.tools;
  return {
    columns: ['Success', 'Calls', 'Time'],
    rows: TIERS.map((tier, i) => {
      const lane = s.lanes[i];
      /** @type {string[]} */
      let texts;
      let active = false;
      if (!play) {
        const chunk = chunkOf(tier, s.chars);
        texts = [pct(successChance(s.profile, chunk)), String(Math.ceil(s.chars / chunk)), '—'];
      }
      else {
        // live while racing; once decided, every lane's whole simulated run
        const t = s.phase === 'finished' ? Infinity : play.t;
        const sim = play.race.lanes[i];
        const back = callsBack(sim, t);
        const ok = back.filter((c) => c.ok).length;
        const time = sim.finished && sim.ms <= t ? fmtSeconds(sim.ms) : lane.out || s.phase === 'finished' ? 'gave up' : '…';
        texts = [back.length > 0 ? pct(ok / back.length) : '—', String(back.length), time];
        active = s.phase === 'finished' ? s.last.recommended === tier.id : s.leader === i;
      }
      return {
        label: tierLabel(tier),
        cells: texts.map((text, k) => ({ id: `${tier.id}-${['success', 'calls', 'time'][k]}`, text, active, ...(k === 0 ? { swatch: lane.color } : {}) })),
      };
    }),
  };
}

/**
 * What the chrome shows.
 * @param {any} s @returns {Hud}
 */
function hud(s) {
  const leading = s.phase === 'finished' ? s.places[0] : s.leader;
  /** @type {Hud} */
  const out = {
    title: TITLES[/** @type {RaceKind} */ (s.kind)],
    subtitle: s.kind === 'engines' ? 'Six Jaren engines, measured live on this device'
      : s.kind === 'tools' ? `${PROFILES[s.profile].label} · a ${fmtChars(s.chars)} character document`
        : `${ROUNDS} rounds · the reflex the veto relies on`,
    prompt: promptOf(s),
    buttons: buttonsOf(s),
    players: s.lanes.map((/** @type {any} */ lane, /** @type {number} */ i) => ({ name: lane.label, score: scoreOf(s, i), active: i === leading, color: lane.color })),
    toast: s.toast?.text ?? null,
    help: HELP[/** @type {RaceKind} */ (s.kind)],
  };
  const meter = meterOf(s);
  if (meter) out.meter = meter;
  if (s.kind === 'tools') out.grid = gridOf(s);
  return out;
}

/**
 * The outcome once a race is decided.
 * @param {any} s @returns {Outcome | null}
 */
function over(s) {
  if (s.phase !== 'finished' || !s.last) return null;
  return { stars: s.last.stars, score: s.last.score, summary: s.last.summary };
}

/**
 * What outlives the run: the most stars (the arcade's game card shows
 * them), the personal bests, the recommended budgets, and the race to
 * come back to when the arcade plays again.
 * @param {any} s
 */
function save(s) {
  const { stars, ...bests } = structuredClone(s.best);
  return { v: 1, best: stars, ...bests, pick: { kind: s.kind, profile: s.profile, chars: s.chars } };
}

/**
 * The recommended budget for a profile: the last race's when there was
 * one (and no other size was asked about), otherwise the model's forecast.
 * @param {any} state @param {any} input
 */
function budgetAnswer(state, input) {
  const profile = input?.profile;
  if (!isProfile(profile)) return { error: 'unknown-profile', profiles: Object.keys(PROFILES) };
  const sized = Number.isFinite(input.chars);
  const kept = sized ? undefined : state.best.budgets[profile];
  const tier = kept ?? raceToolBudgets(profile, sized ? clampChars(input.chars) : DEFAULT_CHARS, state.seed).recommended;
  const chars = /** @type {import('./budget.js').Tier} */ (tierOf(tier)).chars;
  return {
    profile, tier, chars, source: kept ? 'race' : 'forecast',
    setting: { key: 'ai.toolBudget', value: tier },
    advice: chars === null ? 'Send the whole document in one call.' : `Send at most ${chars} characters of JSON per tool call.`,
  };
}

/** The moves a language model may make in the Arena: both read. @type {GameTool[]} */
const TOOLS = [
  {
    name: 'arena_results',
    description: 'Read the Bench Arena: the race on the track and its phase, the last finished race (its kind, podium and '
      + 'summary) and the personal bests kept on this device: engine speeds in ops a second, tool-call delivery rates per '
      + 'model profile and budget, the recommended tool budget per profile, and reflex times in ms.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: (state) => ({ state, result: { race: state.kind, phase: state.phase, last: state.last, bests: structuredClone(state.best) } }),
  },
  {
    name: 'arena_budget',
    description: 'The tool-call budget for a language-model profile: how many characters of JSON one tool call should carry. '
      + 'Quote it to ask for smaller chunks. Measured by the last tool-call race for that profile when there was one, '
      + 'otherwise forecast by the Arena\'s reliability model for a document of `chars` characters.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['profile'],
      properties: {
        profile: { enum: Object.keys(PROFILES) },
        chars: { type: 'integer', minimum: CHARS_MIN, maximum: CHARS_MAX, description: 'The document size to forecast for.' },
      },
    },
    run: (state, input) => ({ state, result: budgetAnswer(state, input) }),
  },
];

/**
 * The Bench Arena game module: one player, so no duel.
 * @type {GameModule}
 */
export const arena = Object.freeze({
  id: 'arena',
  title: 'Bench Arena',
  blurb: 'Benchmarks as a race: Jaren engines measured live, tool-call budgets for language models, and your own reflex.',
  track: 'arena',
  duel: false,
  camera: TRACK_CAMERA,
  create,
  step,
  act,
  draw: drawTrack,
  hud,
  over,
  save,
  tools: TOOLS,
  // the engine race's measurements: the runner compiles its contenders on the first race
  work: ({ now }) => {
    /** @type {ReturnType<typeof createBenchRunner> | null} */
    let runner = null;
    return {
      frame(state, budgetMs) {
        if (!measuring(state)) return null;
        runner ??= createBenchRunner({ now });
        return { type: 'measured', samples: runner.slice(budgetMs) };
      },
    };
  },
});
