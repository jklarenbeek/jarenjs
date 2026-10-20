//@ts-check
/**
 * The Bench Arena: the engine contenders (each a real call into a Jaren
 * engine) and the runner that times them under the clock it is given;
 * the tool-call budget model — its reliability curve and its seeded race
 * of budget tiers; and the game itself — the engine race moved by
 * measured samples to its podium, the tool race played back to the
 * budget a person applies, the reflex race played whole through
 * `play()`, the drawing in every stage theme, the HUD, the save and the
 * tools a language model reads it through.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';
import { CONTENDERS, SLICE_OPS_MAX, createBenchRunner } from '../../packages/website/src/os/games/arena/bench.js';
import {
  TIERS, PROFILES, MAX_TRIES, isProfile, profileOf, tierOf, successChance, callSucceeds, chunkOf, raceToolBudgets, laneProgress,
} from '../../packages/website/src/os/games/arena/budget.js';
import { arena, measuring, KINDS, COURSE_MS, DEFAULT_CHARS, ROUNDS, STARS_AT } from '../../packages/website/src/os/games/arena/index.js';
import {
  X0, X1, LANE_W, PODIUM, MEDALS, SIGN, laneZ, runnerAt, poseOf, signFace, countdownText, drawTrack, TRACK_CAMERA, START_SHOT, PODIUM_SHOT,
} from '../../packages/website/src/os/games/arena/track.js';
import { play, idle, TICK_MS, IDLE_INPUT } from '../../packages/website/src/os/games/game.js';
import { viewOf } from '../../packages/website/src/os/stage/camera.js';
import { STAGE_THEMES } from '../../packages/website/src/os/stage/scene.js';
import { POSES, skeleton } from '../../packages/website/src/os/stage/figures.js';
import { createLighting } from '../../packages/website/src/os/engine/light.js';
import { PALETTE } from '../../packages/website/src/os/app/state.js';

/** @typedef {import('../../packages/website/src/os/games/game.js').GameEvent} GameEvent */

/** Ticks the countdown takes: three beats and the gun, with room to spare. */
const TO_RACING = Math.ceil(2400 / TICK_MS) + 3;

/** @param {GameEvent[]} events */
const sfx = (events) => events.filter((e) => e.kind === 'sfx').map((e) => /** @type {any} */ (e).name);
/** @param {GameEvent[]} events */
const bursts = (events) => events.filter((e) => e.kind === 'fx').map((e) => /** @type {any} */ (e).fx);
/** @param {GameEvent[]} events @param {string} kind */
const only = (events, kind) => events.filter((e) => e.kind === kind).map((e) => /** @type {any} */ (e));

/** One slice of measurements: lane by lane, `ms` spent at `paces[lane]` times its par. @param {number[]} paces @param {number} ms */
const slice = (paces, ms) => CONTENDERS.map((c, lane) => ({ lane, ops: (c.par * paces[lane] * ms) / 1000, ms }));

/** A tick at a given time, nothing held. @param {any} state @param {number} time @param {any} [extra] */
const tick = (state, time, extra = {}) => arena.step(state, { ...IDLE_INPUT, held: { ...IDLE_INPUT.held }, pressed: [], ...extra, time }, TICK_MS);

/** The draw context the arcade hands a game. @param {keyof typeof STAGE_THEMES} theme @param {any} [extra] */
const ctxOf = (theme, extra = {}) => ({
  view: viewOf(arena.camera, 960, 640), time: 2600, theme: STAGE_THEMES[theme],
  light: createLighting({ hour: theme === 'light' ? 10 : 23 }), bodies: {}, reduce: false, palette: PALETTE, px: 1, ...extra,
});

/**
 * The hue of a colour in degrees, or null for one too grey to have one.
 * @param {string} hex
 */
function hueOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 0.08) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Every colour a display list paints. @param {any[]} items */
const coloursOf = (items) => items.flatMap((i) => [i.fill, i.stroke]).filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));

/** Ticks in a script (actions take none). @param {any[]} script */
const ticksIn = (script) => script.filter((e) => !('act' in e)).length;

/**
 * Extend a reflex script with idle ticks until, replayed from the start,
 * the sign is up: the state says when the seeded wait ends.
 * @param {any} start @param {any[]} script
 */
function untilSign(start, script) {
  const { state } = play(arena, start, script);
  const due = Math.ceil((state.reflex.at + state.reflex.waitMs) / TICK_MS) - ticksIn(script);
  let next = [...script, ...idle(due)];
  while (play(arena, start, next).state.reflex.stage !== 'sign') next = [...next, ...idle(1)];
  return next;
}

/**
 * The whole reflex race as one script: Start, the countdown, then for
 * every reaction (in ticks) the sign and a press that many ticks after it.
 * @param {any} start @param {number[]} reactions
 * @param {{ early?: boolean, miss?: boolean }} [extra] - press once too early; let one sign go by
 */
function reflexScript(start, reactions, extra = {}) {
  /** @type {any[]} */
  let script = [{ act: { type: 'start' } }, ...idle(TO_RACING)];
  if (extra.early) script.push({ pressed: ['act'] });
  if (extra.miss) script = [...untilSign(start, script), ...idle(Math.ceil(2500 / TICK_MS) + 1)];
  for (const k of reactions) {
    script = untilSign(start, script);
    script.push(...idle(k - 1), { pressed: ['act'] }, ...idle(Math.ceil(900 / TICK_MS) + 1));
  }
  return script;
}

describe('the engine contenders', () => {
  it('each races a real workload of the OS on its Jaren engine', async () => {
    assert.deepEqual(CONTENDERS.map((c) => c.id), ['turmite', 'merit', 'scene', 'proposal', 'amend', 'tally']);
    assert.deepEqual(CONTENDERS.map((c) => c.kind), ['jaren-fsm', 'jaren-dag', 'jslt', 'contract', 'json-patch', 'json-query']);
    for (const c of CONTENDERS) assert.ok(c.par > 0 && c.label.length > 0);
    const [turmite, merit, scene, proposal, amend, tally] = CONTENDERS.map((c) => c.setup());

    // the default program steps the folded tape, a new world per step
    const first = /** @type {any} */ (turmite());
    const second = /** @type {any} */ (turmite());
    assert.equal(second.tick, first.tick + 1);
    assert.equal(first.heads.length, 4);
    assert.notEqual(second.tape, first.tape, 'every step answers a new world');

    // the merit graph compiles, and the compiled graph runs the council's arithmetic
    const dag = /** @type {any} */ (merit());
    assert.deepEqual(dag.nodes, ['verdict', 'mutual', 'gains', 'merits', 'out']);
    const run = await dag.run({
      status: 'enacted', merits: { painter: 1, dancer: 1 }, proposer: 'painter', proposal: 'p1',
      ballots: [{ voter: 'dancer', proposal: 'p1', vote: 0.5 }], delta: { balance: 0.01, symmetry: 0, structure: -0.01, motion: 0, harmony: 0.003 },
    });
    assert.ok(Math.abs(run.merits.painter - 1.01728) < 1e-9 && Math.abs(run.merits.dancer - 1.072) < 1e-9);

    // the scene stylesheet over a fresh OS: the floor, the four dancers, the two seats
    const sc = /** @type {any} */ (scene());
    assert.equal(sc.width, 20);
    assert.deepEqual(sc.heads.map((/** @type {any} */ h) => h.id), ['painter', 'dancer', 'critic', 'architect']);
    assert.deepEqual(sc.seats.map((/** @type {any} */ h) => h.id), ['oracle', 'human']);

    // a rule change, a fold of the floor and a tempo change, each valid by the contract
    const verdicts = [proposal(), proposal(), proposal(), proposal()];
    assert.deepEqual(verdicts.map((v) => /** @type {any} */ (v).valid), [true, true, true, true]);

    // the amendment turns dance-reading-amber left; the program it patched is untouched
    const patched = /** @type {any} */ (amend());
    assert.equal(patched.transitions[2].effects[1].with, 'L');
    assert.notEqual(patched, amend(), 'a patch answers a fresh document');

    // the tally weighs every ballot by its voter's merit and names the winner
    const tallied = /** @type {any} */ (tally());
    assert.equal(tallied.scores.length, 5);
    assert.equal(tallied.winner.proposal.id, 'dancer-1');
    assert.ok(Math.abs(tallied.winner.score - 1.62) < 1e-9);
  });
});

describe('the bench runner', () => {
  it('shares a slice equally and round-robin, timing each lane by the clock it is given', () => {
    let clock = 0;
    const costs = [0.125, 0.25, 0.5];
    const contenders = costs.map((ms, i) => ({ id: `c${i}`, label: `C${i}`, kind: 'fake', par: 1, setup: () => () => { clock += ms; return i; } }));
    const runner = createBenchRunner({ now: () => clock, contenders });
    assert.equal(runner.lanes, 3);
    assert.deepEqual(runner.slice(3), [{ lane: 0, ops: 8, ms: 1 }, { lane: 1, ops: 4, ms: 1 }, { lane: 2, ops: 2, ms: 1 }]);
    assert.deepEqual(runner.slice(3).map((s) => s.lane), [1, 2, 0], 'the next slice starts one lane on');
    assert.deepEqual(runner.slice(3).map((s) => s.lane), [2, 0, 1]);
    assert.deepEqual(runner.slice(3).map((s) => s.lane), [0, 1, 2]);
    const before = clock;
    // a share too small for one operation still runs it once
    assert.deepEqual(runner.slice(0), [{ lane: 1, ops: 1, ms: 0.25 }, { lane: 2, ops: 1, ms: 0.5 }, { lane: 0, ops: 1, ms: 0.125 }]);
    assert.equal(clock - before, 0.875);
  });

  it('never hangs on a stopped clock, and races nothing without contenders', () => {
    const frozen = createBenchRunner({ now: () => 0, contenders: [{ id: 'f', label: 'F', kind: 'fake', par: 1, setup: () => () => 0 }] });
    assert.deepEqual(frozen.slice(5), [{ lane: 0, ops: SLICE_OPS_MAX, ms: 0 }]);
    const empty = createBenchRunner({ now: () => 0, contenders: [] });
    assert.equal(empty.lanes, 0);
    assert.deepEqual(empty.slice(5), []);
  });

  it('races the six real contenders by default', () => {
    const runner = createBenchRunner({ now: () => performance.now() });
    const samples = runner.slice(6);
    assert.deepEqual(samples.map((s) => s.lane), [0, 1, 2, 3, 4, 5]);
    for (const s of samples) assert.ok(s.ops >= 1 && s.ms >= 0);
  });
});

describe('the arena’s work between frames', () => {
  it('measures the engines only while their race runs, with one runner made on first need', () => {
    let clock = 0;
    const work = /** @type {NonNullable<typeof arena.work>} */ (arena.work)({ now: () => (clock += 0.5) });
    const idleState = arena.create({ seed: 1, save: null, players: [] });
    assert.equal(work.frame(idleState, 6), null, 'nothing to measure before the gun');
    const racing = play(arena, idleState, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    assert.ok(measuring(racing));
    const first = work.frame(racing, 6);
    assert.equal(first?.type, 'measured');
    assert.equal(/** @type {any} */ (first).samples.length, CONTENDERS.length, 'every lane runs in each slice');
    const out = arena.act(racing, /** @type {any} */ (first));
    assert.ok(out.state.lanes.some((/** @type {any} */ l) => l.ms > 0), 'the samples move the race');
  });
});

describe('the engine race', () => {
  it('runs on measured samples: lead changes, crossings in measured order, a podium and personal bests', () => {
    let s = arena.create({ seed: 1, save: null, players: [] });
    assert.equal(s.kind, 'engines');
    assert.equal(measuring(s), false);
    assert.equal(arena.act(s, { type: 'measured', samples: slice([1, 1, 1, 1, 1, 1], 10) }).state, s, 'nothing is measured before the gun');
    assert.equal(arena.over(s), null);

    const started = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING)]);
    s = started.state;
    assert.deepEqual(sfx(started.events), ['whoosh', 'click', 'click', 'click', 'start']);
    assert.deepEqual(only(started.events, 'shot').map((e) => e.shot), [START_SHOT, TRACK_CAMERA]);
    assert.deepEqual(bursts(started.events), ['radiance']);
    assert.equal(s.phase, 'racing');
    assert.ok(measuring(s));
    assert.equal(arena.act(s, { type: 'start' }).state, s, 'a race under way does not start again');
    assert.equal(arena.hud(s).prompt, 'They\'re off!');
    assert.equal(arena.hud(s).meter, undefined, 'nothing measured yet, no speed to show');

    // Turmite leads off the line; the progress is its ops over its par's course
    let out = arena.act(s, { type: 'measured', samples: slice([2, 1, 1, 1, 1, 1], 40) });
    assert.equal(out.state.leader, 0);
    assert.equal(out.state.lanes[0].progress, (2 * 40) / COURSE_MS);
    assert.deepEqual(sfx(out.events), []);
    assert.deepEqual(arena.hud(out.state).meter, { label: 'Turmite · 520k ops/s', value: 0.2 });
    assert.equal(arena.hud(out.state).prompt, 'Turmite leads.');
    // the Scene JSLT overtakes: a whoosh
    out = arena.act(out.state, { type: 'measured', samples: slice([1, 1, 4, 1, 1, 1], 40) });
    assert.equal(out.state.leader, 2);
    assert.deepEqual(sfx(out.events), ['whoosh']);
    // a clock that starts again carries the quiet spell after a whoosh with it
    const restarted = tick(out.state, out.state.now - 500).state;
    assert.equal(restarted.leadAt, out.state.leadAt - 500);
    // and is overtaken at once: the lead changes hands, quietly this soon
    out = arena.act(out.state, { type: 'measured', samples: slice([5, 1, 1, 1, 1, 1], 40) });
    assert.equal(out.state.leader, 0);
    assert.deepEqual(sfx(out.events), []);
    // samples a runner never sent change nothing
    const junk = arena.act(out.state, { type: 'measured', samples: [{ lane: 9, ops: 5, ms: 1 }, { lane: 1.5, ops: 1, ms: 1 }, { lane: 1, ops: NaN, ms: 1 }, null] });
    assert.deepEqual(junk.state.lanes, out.state.lanes);
    assert.equal(arena.act(out.state, { type: 'measured', samples: 'lots' }).state, out.state);

    // three lanes cross in one slice: placed by when each reached its line
    out = arena.act(out.state, { type: 'measured', samples: slice([1, 1, 1.6, 1, 10, 1], 100) });
    s = out.state;
    assert.deepEqual(s.places, [4, 0, 2]);
    assert.equal(s.phase, 'finished');
    assert.equal(measuring(s), false);
    assert.deepEqual(sfx(out.events), ['levelup', 'coin', 'coin', 'chime']);
    assert.deepEqual(bursts(out.events), ['confetti', 'radiance', 'sparks', 'sparks', 'stars']);
    assert.deepEqual(only(out.events, 'shot').map((e) => e.shot), [PODIUM_SHOT]);
    assert.deepEqual(only(out.events, 'fx')[0].at, [X1, 0.6, laneZ(4, 6)], 'the confetti falls on the winner\'s lane');
    const summary = 'Amendment won at 5.09× par (3.46M ops/s), Turmite second, Scene JSLT third.';
    assert.deepEqual(only(out.events, 'say'), [{ kind: 'say', who: 'Arena', text: summary }]);
    // three stars: the race, a personal best, a winner above its par
    assert.deepEqual(arena.over(s), { stars: 3, score: 3461818, summary });
    assert.equal(arena.act(s, { type: 'measured', samples: slice([1, 1, 1, 1, 1, 1], 10) }).state, s, 'the race is decided');

    const hud = arena.hud(s);
    assert.equal(hud.prompt, summary);
    assert.equal(hud.toast, '6 new personal bests');
    assert.deepEqual(hud.buttons, [], 'the arcade\'s own card plays again');
    assert.deepEqual(hud.meter, { label: 'Amendment · 3.46M ops/s', value: 1 });
    assert.deepEqual(hud.players?.map((p) => p.active), [false, false, false, false, true, false]);
    assert.equal(hud.players?.[0].score, '496k ops/s');
    const saved = arena.save(s);
    assert.equal(saved.best, 3);
    assert.equal(saved.engines.amend, 3461818);
    assert.deepEqual(Object.keys(saved.engines), CONTENDERS.map((c) => c.id));

    // a slow rematch from the save beats no best and no par: one star, no toast
    let slow = play(arena, arena.create({ seed: 2, save: saved, players: [] }), [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    for (let k = 0; k < 5 && slow.phase === 'racing'; k++) slow = arena.act(slow, { type: 'measured', samples: slice([0.5, 0.45, 0.4, 0.35, 0.3, 0.25], 200) }).state;
    assert.deepEqual(slow.places, [0, 1, 2]);
    assert.equal(arena.over(slow)?.stars, 1);
    assert.equal(slow.toast, null);
    assert.equal(arena.save(slow).best, 3, 'the card keeps the most stars');

    // one lane without a best: one new personal best, named
    const fresh = arena.create({ seed: 3, save: { engines: { turmite: 1e9, merit: 1e9, scene: 1e9, proposal: 1e9, amend: 1e9 } }, players: [] });
    let lone = play(arena, fresh, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    for (let k = 0; k < 5 && lone.phase === 'racing'; k++) lone = arena.act(lone, { type: 'measured', samples: slice([0.5, 0.45, 0.4, 0.35, 0.3, 0.25], 200) }).state;
    assert.equal(lone.toast.text, 'New personal best: Tally');
    assert.equal(arena.over(lone)?.stars, 2);
  });

  it('starts on Act, and after a finish waits a moment before Act starts the next', () => {
    let s = arena.create({ seed: 4, save: null, players: [] });
    const go = play(arena, s, [{ pressed: ['act'] }, ...idle(2)]);
    assert.equal(go.state.phase, 'countdown');
    assert.equal(go.state.count, 0, 'the first beat sounds on the first tick of the countdown');
    s = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    s = arena.act(s, { type: 'measured', samples: slice([2, 1.5, 1.2, 0.5, 0.5, 0.5], 400) }).state;
    assert.equal(s.phase, 'finished');
    assert.equal(play(arena, s, [{ pressed: ['act'] }]).state.phase, 'finished', 'a press right after the finish is not a restart');
    // a slow engine reads in plain ops a second
    const crawling = arena.act(play(arena, arena.create({ seed: 4, save: null, players: [] }), [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state,
      { type: 'measured', samples: slice([1, 0.05, 1, 1, 1, 1], 40) }).state;
    assert.equal(arena.hud(crawling).players?.[1].score, '350 ops/s');
    assert.equal(play(arena, s, [...idle(Math.ceil(1200 / TICK_MS) + 1), { pressed: ['act'] }]).state.phase, 'countdown');
    const again = arena.act(s, { type: 'again' });
    assert.equal(again.state.phase, 'countdown');
    assert.deepEqual(sfx(again.events), ['whoosh']);
    assert.equal(again.state.places.length, 0, 'a fresh field');
    assert.equal(arena.act(again.state, { type: 'again' }).state, again.state, 'only a decided race goes again');
  });
});

describe('the tool-call budget model', () => {
  it('falls monotonically with length and gives even odds at each profile\'s c50', () => {
    for (const p of Object.values(PROFILES)) {
      assert.equal(successChance(p.id, p.c50), 0.5);
      assert.equal(successChance(p.id, 0), 1);
      let last = 1;
      for (let chars = 50; chars <= 100000; chars *= 1.5) {
        const chance = successChance(p.id, chars);
        assert.ok(chance < last && chance > 0, `${p.id} at ${chars}`);
        last = chance;
      }
      assert.equal(callSucceeds(p.id, p.c50, 0.4999), true);
      assert.equal(callSucceeds(p.id, p.c50, 0.5), false);
    }
    assert.ok(successChance('moe-3b-active', 6000) < 0.01 && successChance('frontier', 6000) > 0.99);
    assert.equal(profileOf(PROFILES.frontier), PROFILES.frontier);
    assert.throws(() => profileOf('toString'), /unknown model profile/);
    assert.equal(isProfile('dense-27b'), true);
    assert.equal(isProfile('toString'), false);
    assert.equal(tierOf('small')?.chars, 600);
    assert.equal(tierOf('huge'), undefined);
    assert.deepEqual(TIERS.map((t) => chunkOf(t, 6000)), [300, 600, 2400, 6000, 6000]);
  });

  it('races every tier deterministically from the seed, with common luck for tiers that cut alike', () => {
    const a = raceToolBudgets('moe-3b-active', 6000, 7);
    assert.deepEqual(raceToolBudgets('moe-3b-active', 6000, 7), a);
    assert.notDeepEqual(raceToolBudgets('moe-3b-active', 6000, 8), a);
    assert.deepEqual(a.lanes.map((l) => l.tier), TIERS.map((t) => t.id));
    // large and unlimited both send 6000 characters at once: the same calls, the same luck
    assert.deepEqual(a.lanes[3].calls, a.lanes[4].calls);
    for (const lane of a.lanes) {
      const failing = lane.calls.slice(-MAX_TRIES);
      if (!lane.finished) assert.ok(failing.length === MAX_TRIES && failing.every((c) => !c.ok), `${lane.tier} gave up after ${MAX_TRIES} tries`);
      assert.equal(lane.ms, lane.calls.reduce((t, c) => t + c.ms, 0));
    }
  });

  it('recommends a small budget for a 3B-active mixture of experts at 6000 characters: its calls fray past ~700 characters, so the 2400-character and one-call lanes resend until they give up', () => {
    for (let seed = 1; seed <= 30; seed++) {
      assert.ok(['tiny', 'small'].includes(raceToolBudgets('moe-3b-active', 6000, seed).recommended), `seed ${seed}`);
    }
    const race = raceToolBudgets('moe-3b-active', 6000, 7);
    assert.equal(race.recommended, 'small');
    assert.deepEqual(race.ranking, ['small', 'tiny', 'medium', 'large', 'unlimited']);
    assert.deepEqual(race.lanes.map((l) => [l.tier, l.calls.length, l.failures, l.finished, l.ms]), [
      ['tiny', 22, 2, true, 35200],
      ['small', 14, 4, true, 35000],
      ['medium', 9, 8, false, 71100],
      ['large', 8, 8, false, 149600],
      ['unlimited', 8, 8, false, 149600],
    ]);
    assert.equal(race.endMs, 35200, 'decided when the last of the two finishers is home');
  });

  it('recommends a big budget for a frontier model: one 6000-character call nearly always comes back whole, and every split pays another round trip', () => {
    for (let seed = 1; seed <= 30; seed++) {
      assert.ok(['large', 'unlimited'].includes(raceToolBudgets('frontier', 6000, seed).recommended), `seed ${seed}`);
    }
    const race = raceToolBudgets('frontier', 6000, 7);
    // large and unlimited tie in one call each; the smaller budget ranks first
    assert.deepEqual(race.ranking, ['large', 'unlimited', 'medium', 'small', 'tiny']);
    assert.deepEqual(race.lanes.map((l) => l.ms), [54000, 39000, 28500, 25500, 25500]);
    assert.equal(race.endMs, 28500, 'decided when the third is home');
  });

  it('ranks by how far they got when no budget delivers, and carries a runner forward until its call fails', () => {
    const stone = { id: 'stone', label: 'Stone', c50: 1, k: 3, baseMs: 100, charMs: 1 };
    const race = raceToolBudgets(stone, 1000, 3);
    assert.equal(race.lanes.every((l) => !l.finished && l.delivered === 0), true);
    assert.equal(race.recommended, 'tiny', 'every lane got nowhere: tier order decides');
    assert.equal(race.endMs, Math.max(...race.lanes.map((l) => l.ms)));
    // even odds at 300 characters: here the 300-character lane meets eight failures in a row
    const coin = raceToolBudgets({ id: 'coin', label: 'Coin', c50: 300, k: 3, baseMs: 100, charMs: 1 }, 600, 529);
    assert.deepEqual(coin.lanes.map((l) => l.finished), [false, true, true, true, true]);
    assert.deepEqual(coin.ranking, ['small', 'medium', 'large', 'unlimited', 'tiny'], 'a lane that gave up ranks behind every lane that delivered');

    const tiny = raceToolBudgets('moe-3b-active', 6000, 7).lanes[0];
    assert.equal(laneProgress(tiny, 6000, 0), 0);
    assert.equal(laneProgress(tiny, 6000, 800), (300 * 0.92 * 0.5) / 6000, 'half through the first call');
    assert.equal(laneProgress(tiny, 6000, 1600), 0.05, 'the first chunk delivered');
    const failed = tiny.calls[2];
    assert.equal(failed.ok, false);
    assert.ok(laneProgress(tiny, 6000, failed.at + failed.ms / 2) > laneProgress(tiny, 6000, failed.at + failed.ms), 'a failed call drops its runner back');
    assert.equal(laneProgress(tiny, 6000, 1e9), 1);
  });
});

describe('the tool-call race', () => {
  it('plays the seeded race back to a podium, the best budget and the setting a person applies', () => {
    let s = arena.create({ seed: 7, save: null, players: [], options: { kind: 'tools' } });
    assert.equal(s.lanes.length, TIERS.length);
    let hud = arena.hud(s);
    assert.equal(hud.title, 'Tool-call Race');
    assert.equal(hud.subtitle, 'MoE 3B active · a 6k character document');
    assert.equal(hud.prompt, 'Deliver 6k characters of JSON through MoE 3B active tool calls: which budget gets there first?');
    assert.deepEqual(hud.grid?.columns, ['Success', 'Calls', 'Time']);
    assert.deepEqual(hud.grid?.rows.map((r) => [r.label, ...r.cells.map((c) => c.text)]), [
      ['tiny 300', '93%', '20', '—'], ['small 600', '61%', '10', '—'], ['medium 2.4k', '2%', '3', '—'],
      ['large 12k', '0%', '1', '—'], ['unlimited', '0%', '1', '—'],
    ]);
    assert.equal(hud.grid?.rows[0].cells[0].swatch, s.lanes[0].color);
    assert.equal(hud.players?.[0].score, '93% a call');
    assert.deepEqual(hud.buttons?.map((b) => b.label), ['Start', 'Engine Race', 'Reflex Race', '✓ MoE 3B active', 'Dense 27B', 'Frontier', '1.5k chars', '✓ 6k chars', '24k chars']);
    const forecast = arena.act(s, { type: 'cell', id: 'small-calls' });
    assert.equal(forecast.state.toast.text, 'small 600: 10 calls of up to 600 characters, each coming back whole 61% of the time.');
    assert.deepEqual(sfx(forecast.events), ['click']);
    assert.equal(arena.act(s, { type: 'cell', id: 'nothing' }).state, s);
    const early = arena.act(s, { type: 'apply' });
    assert.equal(early.state.toast.text, 'Race the tool calls for MoE 3B active first.');
    assert.deepEqual(only(early.events, 'setting'), []);

    // mid-race: the table fills in as calls come back
    const mid = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING + 150)]);
    const race = mid.state.tools.race;
    assert.deepEqual(race, raceToolBudgets('moe-3b-active', DEFAULT_CHARS, race.seed), 'the game races the model, from a seed it drew');
    assert.equal(mid.state.phase, 'racing');
    hud = arena.hud(mid.state);
    assert.match(String(hud.prompt), /^\d+ s simulated\. Big calls stumble; small calls pay the round trip\.$/);
    assert.match(hud.meter?.label ?? '', / · \d+ s simulated$/);
    assert.match(hud.players?.[0].score ?? '', /^\d+ calls$/);
    assert.equal(hud.grid?.rows[0].cells[2].text, '…');
    assert.deepEqual(hud.buttons, []);
    assert.ok(arena.act(mid.state, { type: 'cell', id: 'tiny-success' }).state.toast.text.startsWith('tiny 300: '));
    const kicks = only(mid.events, 'kick');
    assert.ok(kicks.length > 0 && kicks.every((k) => /^lane-[0-4]$/.test(k.body) && k.impulse[0] === -4), 'a failed call trips its runner');
    assert.equal(sfx(mid.events).filter((n) => n === 'wrong').length, kicks.length);

    // the rest of the race, played on (the clock starts again: the rules carry on)
    const done = play(arena, mid.state, idle(800));
    s = done.state;
    assert.equal(s.phase, 'finished');
    assert.equal(race.recommended, 'tiny');
    assert.deepEqual(s.places, [0, 1], 'two budgets delivered: tiny, then small');
    assert.deepEqual(s.lanes.map((/** @type {any} */ l) => l.out), [false, false, true, true, true], 'the three that would only give up fall');
    const summary = 'Best budget for MoE 3B active: tiny. 6k characters in 20 calls, 32.0 s simulated.';
    // three stars: a decided race, a winner that never resent, a budget that beat one big call
    assert.deepEqual(arena.over(s), { stars: 3, score: 188, summary });
    assert.deepEqual(only(done.events, 'say').map((e) => e.text), [summary]);
    assert.ok(sfx(done.events).includes('levelup') && sfx(done.events).includes('coin'));
    hud = arena.hud(s);
    assert.equal(hud.prompt, 'Best budget for MoE 3B active: tiny');
    assert.deepEqual(hud.buttons, [{ id: 'apply', label: 'Apply tiny', primary: true }]);
    assert.deepEqual(hud.grid?.rows.map((r) => r.cells.map((c) => c.text)), [
      ['100%', '20', '32.0 s'], ['71%', '14', '35.0 s'], ['0%', '8', 'gave up'], ['0%', '8', 'gave up'], ['0%', '8', 'gave up'],
    ]);
    assert.deepEqual(hud.grid?.rows.map((r) => r.cells[0].active), [true, false, false, false, false]);
    assert.deepEqual(hud.players?.map((p) => p.score), ['32.0 s', '35.0 s', 'gave up', 'gave up', 'gave up']);
    assert.deepEqual(hud.meter, { label: 'tiny 300 · 32.0 s', value: 1 }, 'the winner\'s own time');
    assert.equal(arena.act(s, { type: 'cell', id: 'large-time' }).state.toast.text, 'large 12k: 8 calls sent, 0 came back whole.');

    // Apply proposes the measured budget as the OS setting
    const applied = arena.act(s, { type: 'apply' });
    assert.deepEqual(applied.events[0], { kind: 'setting', key: 'ai.toolBudget', value: 'tiny' });
    assert.deepEqual(sfx(applied.events), ['coin']);
    assert.deepEqual(arena.hud(applied.state).buttons, [{ id: 'apply', label: 'Applied: tiny', primary: true }]);
    const saved = arena.save(applied.state);
    assert.deepEqual(saved.budgets, { 'moe-3b-active': 'tiny' });
    assert.deepEqual(saved.tools, { 'moe-3b-active': { tiny: 188, small: 171 } });
    assert.deepEqual(saved.pick, { kind: 'tools', profile: 'moe-3b-active', chars: 6000 });
  });

  it('gives a frontier model no star for splitting: one call carries the document as fast as any split', () => {
    const start = arena.create({ seed: 7, save: null, players: [], options: { kind: 'tools', profile: 'frontier' } });
    const done = play(arena, start, [{ act: { type: 'start' } }, ...idle(TO_RACING + 800)]).state;
    const race = done.tools.race;
    assert.equal(race.recommended, 'large');
    assert.deepEqual(done.places, [3, 4, 2], 'large and unlimited home together, then medium');
    assert.equal(arena.over(done)?.stars, 2, 'the race and a clean winner; one big call was just as fast');
    assert.equal(done.lanes[0].out, false, 'tiny would still deliver, only later');
    assert.ok(done.lanes[0].progress > 0 && done.lanes[0].progress < 1, 'it stands where its delivered chunks put it');
    assert.equal(arena.hud(done).prompt, 'Best budget for Frontier: large');
  });

  it('trips the lane that gives up mid-race, and follows the profile and the workload', () => {
    let s = arena.create({ seed: 9, save: null, players: [], options: { kind: 'tools' } });
    const frontier = arena.act(s, { type: 'profile:frontier' });
    assert.equal(frontier.state.profile, 'frontier');
    assert.deepEqual(sfx(frontier.events), ['click']);
    assert.equal(arena.act(frontier.state, { type: 'profile', id: 'frontier' }).state, frontier.state, 'already chosen');
    assert.equal(arena.act(s, { type: 'profile', id: 'oracle' }).state, s);
    assert.equal(arena.act(s, { type: 'workload', chars: 5 }).state.chars, 100, 'a document is at least 100 characters');
    assert.equal(arena.act(s, { type: 'workload:1500' }).state.chars, 1500);
    assert.equal(arena.act(s, { type: 'workload', chars: 'lots' }).state, s);
    assert.equal(arena.act(s, { type: 'workload', chars: 6000 }).state, s, 'already that size');
    s = arena.act(s, { type: 'workload', chars: 24000 }).state;
    // a profile change mid-race goes back to the start line
    const racing = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING + 10)]).state;
    const changed = arena.act(racing, { type: 'profile', id: 'dense-27b' }).state;
    assert.equal(changed.phase, 'ready');
    assert.equal(changed.tools, null);

    // 24000 characters through MoE: the 2400-character lane gives up while tiny is still running
    const out = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING + 800)]);
    assert.equal(out.state.phase, 'finished');
    const quit = only(out.events, 'kick').filter((k) => k.impulse[0] === -8);
    assert.deepEqual(quit.map((k) => k.body), ['lane-2'], 'medium gives up mid-race and tumbles');
    assert.ok(bursts(out.events).includes('dust'));
    assert.equal(out.state.lanes[2].out, true);
    assert.equal(arena.save(out.state).budgets['moe-3b-active'], out.state.tools.race.recommended);
  });
});

describe('the reflex race', () => {
  const player = [{ id: 'p1', name: 'Player 1', color: '#f97316' }];

  it('plays five rounds through play(): an early press refused gently, a missed sign offered again, the median graded', () => {
    const start = arena.create({ seed: 11, save: null, players: player, options: { kind: 'reflex' } });
    assert.equal(start.lanes[0].label, 'Player 1');
    assert.equal(start.lanes[0].color, '#f97316');
    const { state, events } = play(arena, start, reflexScript(start, [18, 16, 20, 15, 17], { early: true, miss: true }));
    assert.equal(state.phase, 'finished');
    assert.deepEqual(state.reflex.times, [300, 267, 333, 250, 283]);
    assert.equal(state.reflex.early, 1);
    assert.equal(state.reflex.missed, 1);
    const summary = 'Median 283 ms, best 250 ms over 5 rounds, 1 early.';
    // two stars: under 450 and under 350, not under 280
    assert.deepEqual(arena.over(state), { stars: 2, score: 353, summary });
    assert.deepEqual(STARS_AT.filter((limit) => 283 < limit), [450, 350]);
    // the early press: a gentle buzz and a stumble, never a lost round
    assert.deepEqual(only(events, 'kick')[0], { kind: 'kick', body: 'lane-0', impulse: [-2.5, 2] });
    const names = sfx(events);
    assert.equal(names.filter((n) => n === 'pop').length, ROUNDS + 1, 'six signs: five answered, one missed');
    assert.equal(names.filter((n) => n === 'whoosh').length, 2, 'Start, and the sign that went by');
    assert.deepEqual(names.filter((n) => n === 'coin' || n === 'right'), ['coin', 'coin', 'coin', 'coin', 'coin']);
    assert.ok(names.includes('levelup') && names.includes('chime'));
    assert.deepEqual(only(events, 'say').map((e) => e.text), [summary]);
    assert.equal(state.toast.text, 'New personal best 250 ms and median 283 ms');
    const saved = arena.save(state);
    assert.deepEqual(saved.reflex, { best: 250, median: 283 });
    assert.equal(saved.best, 2);
    assert.equal(arena.hud(state).prompt, summary);
    assert.deepEqual(arena.hud(state).meter, { label: 'median 283 ms', value: 1 });
    assert.equal(arena.hud(state).players?.[0].score, '283 ms');

    // a slower run against those bests: no star, no toast, the bests kept
    const again = arena.create({ seed: 12, save: saved, players: player, options: { kind: 'reflex' } });
    const slow = play(arena, again, reflexScript(again, [30, 30, 31, 30, 30])).state;
    assert.deepEqual(arena.over(slow), { stars: 0, score: 200, summary: 'Median 500 ms, best 500 ms over 5 rounds.' });
    assert.equal(slow.toast, null);
    assert.deepEqual(arena.save(slow).reflex, { best: 250, median: 283 });
  });

  it('shows each stage on the sign and in the HUD', () => {
    const start = arena.create({ seed: 5, save: null, players: player, options: { kind: 'reflex' } });
    const light = STAGE_THEMES.light;
    assert.equal(signFace(start, light).text, 'ready');
    let hud = arena.hud(start);
    assert.equal(hud.title, 'Reflex Race');
    assert.equal(hud.subtitle, '5 rounds · the reflex the veto relies on');
    assert.equal(hud.prompt, 'Press Start. When the sign pops up, press Act or tap, as fast as you can.');
    assert.equal(hud.players?.[0].score, '0/5');
    assert.equal(hud.grid, undefined);

    /** @type {any[]} */
    const script = [{ act: { type: 'start' } }, ...idle(TO_RACING)];
    const waiting = play(arena, start, script).state;
    assert.equal(waiting.reflex.stage, 'wait');
    assert.equal(signFace(waiting, light).text, 'wait…');
    assert.equal(arena.hud(waiting).prompt, 'Wait for it…');
    assert.deepEqual(arena.hud(waiting).meter, { label: 'reaction', value: 0 });
    const signed = untilSign(start, script);
    const up = play(arena, start, signed);
    assert.equal(signFace(up.state, light).text, 'GO!');
    assert.equal(arena.hud(up.state).prompt, 'NOW!');
    assert.ok(bursts(up.events).includes('radiance'));
    // a tap is a press too
    const tapped = play(arena, start, [...signed, ...idle(23), { tap: { x: 0, z: 0 } }]).state;
    assert.equal(tapped.reflex.last, 400);
    assert.deepEqual(signFace(tapped, light), { text: '400 ms', color: '#0ea5e9' });
    assert.equal(arena.hud(tapped).prompt, '400 ms');
    assert.deepEqual(arena.hud(tapped).meter, { label: '400 ms', value: 0.2 });
    assert.equal(arena.hud(tapped).players?.[0].score, '1/5');
    const quick = play(arena, start, [...signed, ...idle(14), { pressed: ['act'] }]).state;
    assert.deepEqual(signFace(quick, light), { text: '250 ms', color: '#16a34a' });
    // the result shows for a moment, then the next wait begins
    assert.equal(play(arena, start, [...signed, ...idle(14), { pressed: ['act'] }, ...idle(60)]).state.reflex.stage, 'wait');
    const finished = play(arena, start, reflexScript(start, [18, 18, 18, 18, 18])).state;
    assert.deepEqual(signFace(finished, light), { text: '300 ms', color: '#16a34a' });
  });

  it('keeps its waits and reactions whole when the clock starts again', () => {
    const start = arena.create({ seed: 5, save: null, players: player, options: { kind: 'reflex' } });
    const waiting = play(arena, start, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    const at = waiting.reflex.at;
    const later = tick(waiting, waiting.now - 1000).state;
    assert.equal(later.reflex.at, at - 1000);
    assert.equal(later.phaseAt, waiting.phaseAt - 1000);
    assert.equal(later.now - later.reflex.at, waiting.now - waiting.reflex.at);
    // a clock that is no number reads as zero, a tick of no length as none
    const blank = arena.step(waiting, { ...IDLE_INPUT, time: NaN }, NaN).state;
    assert.equal(blank.now, 0);
    assert.equal(blank.reflex.at, at - waiting.now);
  });
});

describe('drawing the arena', () => {
  it('lays lit lanes, a chequered finish and runners that ask for ragdolls, in every theme and never in pink or purple', () => {
    let racing = play(arena, arena.create({ seed: 1, save: null, players: [] }), [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    racing = arena.act(racing, { type: 'measured', samples: slice([1, 0.5, 2, 0.5, 0.5, 0.5], 40) }).state;
    racing = play(arena, racing, idle(10)).state;
    for (const theme of /** @type {const} */ (['light', 'dark', 'neon'])) {
      const drawn = arena.draw(racing, ctxOf(theme));
      assert.ok(drawn.items.length > 200, theme);
      assert.deepEqual(drawn.figures?.map((f) => f.id), ['lane-0', 'lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5']);
      for (const f of drawn.figures ?? []) assert.deepEqual(Object.keys(f.pose).sort(), ['aL', 'aR', 'head', 'lL', 'lR', 'lean']);
      const texts = drawn.items.filter((i) => i.t === 'text').map((i) => /** @type {any} */ (i).text);
      assert.deepEqual(texts.filter((t) => CONTENDERS.some((c) => c.label === t)).sort(), CONTENDERS.map((c) => c.label).sort());
      for (const colour of coloursOf(drawn.items)) {
        const hue = hueOf(colour);
        assert.ok(hue === null || hue < 260 || hue > 345, `${theme} paints ${colour}`);
      }
    }
    // the leader radiates: more strokes than the same frame with nobody in front
    const lines = (/** @type {any} */ s) => arena.draw(s, ctxOf('light')).items.filter((i) => i.t === 'line').length;
    assert.ok(lines(racing) > lines({ ...racing, leader: null }));
    // a simulated body is drawn instead of the pose; reduced motion stills everything
    const bodied = arena.draw(racing, ctxOf('light', { bodies: { 'lane-0': skeleton(POSES.tumble) } }));
    assert.notDeepEqual(bodied.items, arena.draw(racing, ctxOf('light')).items);
    const still = ctxOf('dark', { reduce: true, light: null, time: 999 });
    assert.deepEqual(arena.draw(racing, still), arena.draw(racing, { ...still, time: 5 }));
  });

  it('counts down over the start, then stands the podium with medals', () => {
    const start = arena.create({ seed: 1, save: null, players: [] });
    assert.deepEqual(runnerAt(start, 0), [X0, 0.06, laneZ(0, 6)], 'every runner starts on the line');
    const texts = (/** @type {any} */ s) => arena.draw(s, ctxOf('light')).items.filter((i) => i.t === 'text').map((i) => /** @type {any} */ (i).text);
    const counting = play(arena, start, [{ act: { type: 'start' } }, ...idle(2)]).state;
    assert.equal(countdownText(counting), '3');
    assert.ok(texts(counting).includes('3'));
    const two = play(arena, start, [{ act: { type: 'start' } }, ...idle(Math.ceil(1600 / TICK_MS) + 2)]).state;
    assert.equal(countdownText(two), '1');
    const gone = play(arena, start, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    assert.equal(countdownText(gone), 'GO!');
    assert.ok(texts(gone).includes('GO!'));
    assert.equal(countdownText(play(arena, gone, idle(60)).state), null);
    assert.equal(countdownText(start), null);

    const done = arena.act(gone, { type: 'measured', samples: slice([3, 2, 1, 0.5, 0.5, 0.5], 400) }).state;
    assert.deepEqual(done.places, [0, 1, 2]);
    assert.deepEqual(runnerAt(done, 0), [PODIUM[0].x, PODIUM[0].h, PODIUM[0].z]);
    assert.deepEqual(runnerAt(done, 2), [PODIUM[2].x, PODIUM[2].h, PODIUM[2].z]);
    assert.equal(runnerAt(done, 3)[2], laneZ(3, 6), 'the rest stay in their lanes');
    for (const theme of /** @type {const} */ (['light', 'neon'])) {
      const drawn = arena.draw(done, ctxOf(theme));
      // a medal is the one outlined disc in a medal's colour (a figure's head has no stroke)
      const medals = drawn.items.filter((i) => i.t === 'disc' && i.stroke !== null && MEDALS.includes(/** @type {any} */ (i).fill));
      assert.deepEqual(medals.map((m) => /** @type {any} */ (m).fill).sort(), [...MEDALS].sort(), theme);
      assert.ok(drawn.items.some((i) => i.t === 'text' && /** @type {any} */ (i).text === '1'));
    }
  });

  it('poses each runner for its moment', () => {
    const lanes = [0, 1, 2, 3, 4].map((i) => ({ shown: 0.3, place: /** @type {number | null} */ (null), out: false, i }));
    const at = (/** @type {string} */ phase, /** @type {any} */ lane) => poseOf({ phase, lanes: [lane] }, 0, 1000);
    assert.deepEqual(Object.keys(at('ready', lanes[0])).sort(), Object.keys(POSES.dance).sort());
    assert.equal(at('countdown', lanes[0]), POSES.stamp);
    assert.notEqual(at('racing', lanes[0]), POSES.jubilant);
    assert.equal(at('racing', { ...lanes[0], place: 2 }), POSES.jubilant);
    assert.notEqual(at('finished', { ...lanes[0], place: 1 }), POSES.lift, 'the winner dances between jubilant and lift');
    assert.equal(at('finished', { ...lanes[0], place: 2 }), POSES.lift);
    assert.equal(at('finished', { ...lanes[0], place: 3 }), POSES.hold);
    assert.equal(at('finished', { ...lanes[0], place: 4 }), POSES.bow);
    assert.equal(at('racing', { ...lanes[0], out: true }), POSES.tumble);
  });

  it('fades the runners whose budget gave up', () => {
    const decided = play(arena, arena.create({ seed: 7, save: null, players: [], options: { kind: 'tools' } }), [{ act: { type: 'start' } }, ...idle(TO_RACING + 800)]).state;
    const drawn = arena.draw(decided, ctxOf('dark'));
    assert.ok(drawn.items.some((i) => i.a === 0.7), 'the three that gave up are drawn faded');
    assert.deepEqual(drawn.figures?.map((f) => f.pose), [0, 1, 2, 3, 4].map((i) => poseOf(decided, i, 2600)));
    assert.equal(poseOf(decided, 2, 0), POSES.tumble);
  });

  it('raises the reflex sign beside a lone lane and ends without a podium', () => {
    const start = arena.create({ seed: 5, save: null, players: [], options: { kind: 'reflex' } });
    const up = play(arena, start, untilSign(start, [{ act: { type: 'start' } }, ...idle(TO_RACING)])).state;
    const go = arena.draw(up, ctxOf('light')).items.filter((i) => i.t === 'text');
    const sizeOf = (/** @type {string} */ text) => /** @type {any} */ (go.find((i) => /** @type {any} */ (i).text === text))?.size ?? 0;
    assert.ok(sizeOf('GO!') > sizeOf('You'), 'GO! stands big over the sign');
    assert.equal(start.lanes[0].label, 'You', 'no player named: the human runs as you');
    const ready = arena.draw(start, ctxOf('light'));
    assert.deepEqual(ready.figures?.map((f) => f.id), ['lane-0']);
    assert.ok(ready.items.some((i) => i.t === 'text' && /** @type {any} */ (i).text === 'ready'));
    const finished = play(arena, start, reflexScript(start, [18, 18, 18, 18, 18])).state;
    assert.equal(finished.lanes[0].place, 1);
    const [x, y, z] = runnerAt(finished, 0);
    assert.ok(x > X1 - 0.05 && y === 0.06 && z === 0, 'across the line, not on a podium');
    assert.ok(finished.reflex.lift > 1, 'the sign stands up to show the median');
    const drawn = arena.draw(finished, ctxOf('dark'));
    assert.ok(drawn.items.some((i) => i.t === 'text' && /** @type {any} */ (i).text === '300 ms'));
    assert.equal(drawn.items.filter((i) => i.t === 'disc' && i.stroke !== null && MEDALS.includes(/** @type {any} */ (i).fill)).length, 0);
    assert.equal(SIGN.z1 < -LANE_W / 2, true, 'the sign stands clear of the lane');
    assert.equal(drawTrack, arena.draw);
  });
});

describe('the arena as a game module', () => {
  it('is the arcade\'s single-player arena, its races, and moves that change nothing when they make no sense', () => {
    assert.equal(arena.id, 'arena');
    assert.equal(arena.track, 'arena');
    assert.equal(arena.duel, false);
    assert.equal(arena.camera, TRACK_CAMERA);
    assert.deepEqual(KINDS, ['engines', 'tools', 'reflex']);
    assert.deepEqual(arena.tools?.map((t) => t.name), ['arena_results', 'arena_budget']);

    const s = arena.create({ seed: 1, save: null, players: [] });
    assert.equal(arena.create({ seed: /** @type {any} */ ('lucky'), save: null, players: [] }).seed, 0);
    const hud = arena.hud(s);
    assert.equal(hud.title, 'Engine Race');
    assert.equal(hud.subtitle, 'Six Jaren engines, measured live on this device');
    assert.equal(hud.prompt, 'Press Start. Each lane runs its real workload in turn, and its finish line sits at its par.');
    assert.deepEqual(hud.buttons, [{ id: 'start', label: 'Start', primary: true }, { id: 'race:tools', label: 'Tool-call Race' }, { id: 'race:reflex', label: 'Reflex Race' }]);
    assert.deepEqual(hud.players?.map((p) => p.score), ['—', '—', '—', '—', '—', '—']);
    assert.equal(hud.meter, undefined);
    assert.equal(hud.toast, null);
    assert.ok(String(hud.help).includes('par'));
    assert.equal(arena.hud(play(arena, s, [{ act: { type: 'start' } }, ...idle(1)]).state).prompt, 'On your marks…');

    for (const action of [{ type: 'dance' }, { type: 'toString' }, { type: '' }, { type: 'race', kind: 'engines' }, { type: 'race', kind: 'chess' },
      { type: 'again' }, { type: 'cell', id: 'tiny-calls' }]) {
      const out = arena.act(s, action);
      assert.equal(out.state, s, JSON.stringify(action));
      assert.deepEqual(out.events, []);
    }
    assert.equal(arena.act(s, /** @type {any} */ (null)).state, s);
    const tools = arena.act(s, { type: 'race:tools' });
    assert.equal(tools.state.kind, 'tools');
    assert.deepEqual(sfx(tools.events), ['open']);
    assert.deepEqual(only(tools.events, 'shot').map((e) => e.shot), [TRACK_CAMERA]);
    const reflex = arena.act(tools.state, { type: 'race', kind: 'reflex' });
    assert.equal(reflex.state.lanes.length, 1);
    // a profile picked during the engine race waits for the tool race
    const picked = arena.act(s, { type: 'profile', id: 'dense-27b' }).state;
    assert.equal(picked.profile, 'dense-27b');
    assert.equal(picked.lanes.length, CONTENDERS.length);
    // switching races mid-race goes back to a start line
    const running = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING)]).state;
    assert.equal(arena.act(running, { type: 'race:reflex' }).state.phase, 'ready');
  });

  it('keeps the bests, the budgets and the race to come back to across a save, and trusts nothing broken in one', () => {
    let s = arena.create({ seed: 7, save: null, players: [], options: { kind: 'tools' } });
    s = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING + 800)]).state;
    const saved = arena.save(s);
    assert.equal(saved.v, 1);
    const back = arena.create({ seed: 8, save: saved, players: [], options: { lang: 'en' } });
    assert.deepEqual(back.best, s.best);
    assert.equal(back.kind, 'tools', 'the arcade plays again where the last run was');
    assert.equal(back.phase, 'ready');
    assert.deepEqual(arena.save(back), saved);
    assert.equal(arena.create({ seed: 8, save: saved, players: [], options: { kind: 'reflex' } }).kind, 'reflex', 'an asked-for race wins');
    assert.equal(arena.hud(back).prompt, 'Deliver 6k characters of JSON through MoE 3B active tool calls: which budget gets there first? Last best: tiny.');
    assert.deepEqual(arena.hud(back).buttons?.slice(0, 2), [{ id: 'start', label: 'Start', primary: true }, { id: 'apply', label: 'Apply tiny', primary: false }]);

    const broken = arena.create({
      seed: 1, players: [], save: {
        best: 7, engines: { turmite: -1, merit: 'fast', scene: 50 }, tools: { 'moe-3b-active': { tiny: 10, huge: 5 }, nope: { tiny: 3 } },
        budgets: { 'moe-3b-active': 'giant', frontier: 'large' }, reflex: { best: 0, median: 300 }, pick: { kind: 'chess', profile: 'toString', chars: 'many' },
      },
    });
    assert.deepEqual(broken.best, {
      stars: null, engines: { scene: 50 }, tools: { 'moe-3b-active': { tiny: 10 } }, budgets: { frontier: 'large' }, reflex: { best: null, median: 300 },
    });
    assert.deepEqual([broken.kind, broken.profile, broken.chars], ['engines', 'moe-3b-active', DEFAULT_CHARS]);
    assert.deepEqual(arena.create({ seed: 1, save: 'nonsense', players: [] }).best.engines, {});
  });

  it('answers a language model: the last race and the bests, and the budget for a profile', () => {
    const validator = new JarenValidator();
    const [results, budget] = /** @type {import('../../packages/website/src/os/games/game.js').GameTool[]} */ (arena.tools);
    const checkResults = validator.compile(results.inputSchema);
    const checkBudget = validator.compile(budget.inputSchema);
    assert.equal(checkResults({}), true);
    assert.equal(checkBudget({ profile: 'frontier', chars: 2400 }), true);
    assert.notEqual(checkBudget({ profile: 'gpt' }), true);
    assert.notEqual(checkBudget({}), true);

    let s = arena.create({ seed: 7, save: null, players: [], options: { kind: 'tools' } });
    const fresh = results.run(s, {});
    assert.equal(fresh.state, s);
    assert.deepEqual(fresh.result, { race: 'tools', phase: 'ready', last: null, bests: s.best });
    const forecast = budget.run(s, { profile: 'moe-3b-active' }).result;
    assert.deepEqual(forecast.setting, { key: 'ai.toolBudget', value: forecast.tier });
    assert.equal(forecast.tier, raceToolBudgets('moe-3b-active', DEFAULT_CHARS, s.seed).recommended);
    assert.equal(forecast.source, 'forecast');
    assert.equal(forecast.advice, `Send at most ${tierOf(forecast.tier)?.chars} characters of JSON per tool call.`);

    s = play(arena, s, [{ act: { type: 'start' } }, ...idle(TO_RACING + 800)]).state;
    const measured = budget.run(s, { profile: 'moe-3b-active' });
    assert.equal(measured.state, s);
    assert.deepEqual(measured.result, {
      profile: 'moe-3b-active', tier: 'tiny', chars: 300, source: 'race', setting: { key: 'ai.toolBudget', value: 'tiny' },
      advice: 'Send at most 300 characters of JSON per tool call.',
    });
    // asked about another size, the model forecasts it, even with a race kept
    const sized = budget.run(s, { profile: 'frontier', chars: 1500 }).result;
    assert.equal(sized.tier, 'medium', 'one 1500-character call: medium already carries it whole');
    assert.equal(sized.source, 'forecast');
    const whole = budget.run(s, { profile: 'frontier', chars: 100000 }).result;
    assert.equal(whole.tier, raceToolBudgets('frontier', 100000, s.seed).recommended);
    assert.deepEqual([whole.tier, whole.chars, whole.advice], ['unlimited', null, 'Send the whole document in one call.']);
    assert.equal(budget.run(s, { profile: 'frontier', chars: 100 }).result.tier, 'tiny', 'a note fits any budget: the smallest ranks first');
    assert.deepEqual(budget.run(s, { profile: 'gpt' }).result, { error: 'unknown-profile', profiles: Object.keys(PROFILES) });
    const read = results.run(s, {}).result;
    assert.equal(read.last.recommended, 'tiny');
    assert.equal(read.phase, 'finished');
    assert.deepEqual(read.bests.budgets, { 'moe-3b-active': 'tiny' });
  });
});
