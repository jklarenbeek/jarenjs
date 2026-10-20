//@ts-check
/**
 * Radiant OS council sessions: the workflow run, the human's verdict,
 * the timer that enacts when the human stays silent, the merit document's
 * reward, and the repeal — driven over a fake clock and a fake reducer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createCouncilDriver, SESSION_EVERY, VERDICT_MS, QUEUE_MAX } from '../../packages/website/src/os/kernel/session.js';
import { LOOKAHEAD, MEMBERS } from '../../packages/website/src/os/kernel/council.js';
import { compileMachine, createWorld, stepWorld } from '../../packages/website/src/os/kernel/machine.js';
import { DEFAULT_RULES, rulesToFsm, fsmToRules } from '../../packages/website/src/os/kernel/program.js';
import { initialState, WORLD_SIZE } from '../../packages/website/src/os/app/state.js';

/**
 * A host over a plain state value: the few council actions the driver
 * dispatches, reduced the way the app reduces them, and a clock and
 * timers the test turns by hand.
 * @param {{ ticks?: number, world?: any, oracle?: any, validateProposal?: any }} [options]
 */
function councilHost(options = {}) {
  let state = initialState({ edition: 'test', title: 'Radiant OS' });
  const world = options.world ?? stepWorld(compileMachine(state.program.machine), state.world, options.ticks ?? 300).world;
  state = { ...state, world };
  /** @type {Array<[string, any]>} */
  const log = [];
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let now = 0;
  let nextTimer = 1;
  const council = (/** @type {any} */ patch) => { state = { ...state, council: { ...state.council, ...patch } }; };
  const host = {
    getState: () => state,
    dispatch: (/** @type {string} */ action, /** @type {any} */ payload) => {
      log.push([action, payload]);
      if (action === 'council/phase') council(payload);
      else if (action === 'council/queue') council({ queue: payload });
      else if (action === 'council/enacted') {
        state = { ...state, program: payload.program, world: payload.world };
        council({ log: [payload.amendment, ...state.council.log] });
      }
      else if (action === 'council/vetoed') council({ log: [payload.amendment, ...state.council.log] });
      else if (action === 'council/merits') council({ merits: payload.merits });
      else if (action === 'council/repealed') state = { ...state, program: payload.program };
    },
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { timers.set(nextTimer, { fn, at: now + ms }); return nextTimer++; },
    clearTimer: (/** @type {number} */ id) => { timers.delete(id); },
    now: () => now,
    yieldEvery: () => Promise.resolve(),
    oracle: options.oracle,
    validateProposal: options.validateProposal,
  };
  const driver = createCouncilDriver(host);
  return {
    driver, log, timers,
    get state() { return state; },
    set state(next) { state = next; },
    /** @param {number} ms */
    advance(ms) { now += ms; },
    /** The actions dispatched so far, by name. @param {string} action */
    sent: (action) => log.filter(([a]) => a === action).map(([, p]) => p),
    /** Fire every timer that is due, and let the run it resumes settle. */
    async fire() {
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      for (let i = 0; i < 100 && driver.open; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** Convene sessions on successive floors until one's winner passes the test. */
async function sessionWhere(/** @type {(winner: any) => boolean} */ test) {
  for (let ticks = 300; ticks < 900; ticks += 37) {
    const h = councilHost({ ticks });
    await h.driver.convene();
    if (h.driver.open && test(h.state.council.winner)) return h;
  }
  throw new Error('no session found with such a winner');
}

describe('a council session', () => {
  it('runs the workflow to a verdict that waits for the human', async () => {
    const h = councilHost();
    assert.equal(h.driver.open, false);
    assert.equal(h.driver.awaiting, null);
    assert.equal(h.driver.documents.workflow.revision, 'radiant-council/1');
    assert.ok(h.driver.documents.merit.nodes.merits);

    const result = await h.driver.convene();
    assert.deepEqual(result, { session: 1, phase: 'veto' });
    assert.equal(h.sent('council/phase')[0].phase, 'convening');
    assert.deepEqual(h.sent('council/queue'), [[]], 'the queue is handed to the session and emptied');
    const phase = h.sent('council/phase').at(-1);
    assert.equal(phase.phase, 'veto');
    assert.equal(phase.deadline, VERDICT_MS);
    assert.equal(phase.window, VERDICT_MS);
    assert.ok(phase.proposals.length >= 2, 'several seats proposed');
    assert.equal(phase.scores.length, phase.proposals.length);
    assert.ok(phase.winner.score > 0);
    assert.equal(phase.winner.score, Math.max(...phase.scores.map((/** @type {any} */ s) => s.score)), 'the best tally wins');
    assert.ok(phase.proposals.every((/** @type {any} */ p) => MEMBERS.some((m) => m.id === p.by)));
    assert.equal(h.driver.open, true);
    assert.equal(h.driver.awaiting, phase.winner.id);
    assert.equal(h.timers.size, 1, 'one timer stands in for the workflow clock');
    assert.equal([...h.timers.values()][0].at, VERDICT_MS);
    assert.equal(await h.driver.convene(), null, 'one session at a time');
    h.driver.dispose();
    assert.equal(h.driver.open, false);
    assert.equal(h.timers.size, 0);
  });

  it('records a veto and makes the proposer and its backers pay', async () => {
    const h = councilHost();
    await h.driver.convene();
    const winner = h.state.council.winner;
    assert.equal(await h.driver.verdict('veto', 'someone-else'), false, 'only the awaiting proposal can be judged');
    assert.equal(await h.driver.verdict('veto', winner.id), true);
    const [{ amendment }] = h.sent('council/vetoed');
    assert.equal(amendment.status, 'vetoed');
    assert.equal(amendment.proposal, winner.id);
    assert.equal(amendment.id, `a1-${winner.by}`);
    assert.deepEqual(amendment.change, winner.change);
    const [merits] = h.sent('council/merits');
    assert.equal(merits.amendment, amendment.id);
    assert.ok(merits.reward < 0, 'a vetoed proposer loses merit');
    assert.ok(merits.merits[winner.by] < 1);
    assert.equal(merits.merits.human, 1, 'the human casts no vote and pays nothing');
    for (const value of Object.values(merits.merits)) assert.ok(value >= 0.2 && value <= 5);
    assert.equal(h.state.council.phase, 'idle');
    assert.equal(h.state.council.next, h.state.world.tick + SESSION_EVERY);
    assert.equal(h.driver.open, false);
    assert.equal(h.timers.size, 0);
    assert.equal(await h.driver.verdict('approve', winner.id), false, 'a closed session takes no verdict');
  });

  it('enacts on approval and rewards the enactment when its future arrives', async () => {
    const h = councilHost();
    const before = h.state;
    await h.driver.convene();
    const winner = h.state.council.winner;
    assert.equal(await h.driver.verdict('approve', winner.id), true);
    const [enacted] = h.sent('council/enacted');
    assert.equal(enacted.amendment.status, 'enacted');
    assert.equal(enacted.amendment.reward, null);
    assert.equal(enacted.amendment.previousTempo, before.program.tempo);
    assert.equal(enacted.amendment.tick, before.world.tick);
    if (winner.change.kind === 'rule') {
      assert.equal(enacted.amendment.inverse.length, 1);
      assert.notDeepEqual(fsmToRules(enacted.program.machine), fsmToRules(before.program.machine));
    }
    assert.deepEqual(h.sent('council/merits'), [], 'an enactment is judged later, not at once');

    const due = before.world.tick + LOOKAHEAD;
    const early = stepWorld(compileMachine(h.state.program.machine), h.state.world, LOOKAHEAD - 1).world;
    await h.driver.onTick(early, h.state.world.tape);
    assert.deepEqual(h.sent('council/merits'), []);
    const later = stepWorld(compileMachine(h.state.program.machine), h.state.world, LOOKAHEAD).world;
    assert.equal(later.tick, due);
    await h.driver.onTick(later, early.tape);
    const [merits] = h.sent('council/merits');
    assert.equal(merits.amendment, enacted.amendment.id);
    assert.equal(typeof merits.reward, 'number');
    await h.driver.onTick(later, early.tape);
    assert.equal(h.sent('council/merits').length, 1, 'each enactment is judged once');
  });

  it('enacts when the human stays silent past the window', async () => {
    const h = councilHost();
    await h.driver.convene();
    const winner = h.state.council.winner;
    h.advance(VERDICT_MS - 1);
    await h.fire();
    assert.equal(h.driver.open, true, 'the window is still open');
    h.advance(1);
    await h.fire();
    assert.equal(h.driver.open, false);
    const [enacted] = h.sent('council/enacted');
    assert.equal(enacted.amendment.proposal, winner.id);
    assert.equal(h.state.council.phase, 'idle');
  });

  it('refuses to enact a rule the program no longer has', async () => {
    const h = await sessionWhere((winner) => winner.change.kind === 'rule');
    const renamed = rulesToFsm({ a: DEFAULT_RULES.dance, b: DEFAULT_RULES.leap });
    h.state = { ...h.state, program: { ...h.state.program, machine: renamed } };
    await h.driver.verdict('approve', h.state.council.winner.id);
    const [refused] = h.sent('council/refused');
    assert.equal(refused.session, 1);
    assert.match(refused.reason, /a state the program no longer has/);
    assert.deepEqual(h.sent('council/enacted'), []);
    assert.equal(h.state.council.phase, 'idle');
  });

  it('rests when nothing anyone can think of helps', async () => {
    const still = createWorld({ width: WORLD_SIZE, height: WORLD_SIZE, heads: [], initial: 'dance' });
    const h = councilHost({ world: still });
    assert.deepEqual(await h.driver.convene(), { session: 1, phase: 'idle' });
    assert.deepEqual(h.sent('council/rested'), [{ session: 1 }]);
    assert.equal(h.state.council.phase, 'idle');
    assert.equal(h.state.council.winner, null);
    assert.equal(h.timers.size, 0);
  });

  it('hears the oracle through its seam and admits only valid proposals', async () => {
    /** @type {any[]} */
    const asked = [];
    const oracleProposal = { id: 'oracle-fold', by: 'oracle', title: 'Fold it', why: 'a test', change: { kind: 'tape', op: 'mirror' } };
    const h = councilHost({
      oracle: async (/** @type {any} */ context, /** @type {AbortSignal} */ signal) => { asked.push({ context, signal }); return oracleProposal; },
      validateProposal: (/** @type {any} */ p) => p.id !== 'bad',
    });
    h.state = { ...h.state, council: { ...h.state.council,
      chat: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, by: 'human', text: `hello ${i}` })),
      queue: [
        { id: 'human-q1', by: 'human', title: 'Wash', why: '', change: { kind: 'tape', op: 'clear' } },
        { id: 'bad', by: 'human', title: 'Bad', why: '', change: { kind: 'tape', op: 'clear' } },
      ] } };
    await h.driver.convene();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].context.chat.length, 6, 'the oracle hears the latest few lines');
    assert.ok(asked[0].signal instanceof AbortSignal);
    assert.equal(typeof asked[0].context.seed, 'number');
    assert.ok(asked[0].context.program.machine.transitions);
    const ids = h.sent('council/phase').map((p) => p.proposals.map((/** @type {any} */ x) => x.id)).find((x) => x.length > 0) ?? [];
    assert.ok(ids.includes('oracle-fold'));
    assert.ok(ids.includes('human-q1'));
    assert.ok(!ids.includes('bad'));
    h.driver.dispose();

    // a model's rule that names a state the program lacks would break
    // every simulation of the session; the seam drops it instead
    const confused = councilHost({ oracle: async () => ({ ...oracleProposal, id: 'oracle-lost',
      change: { kind: 'rule', state: 'dance', symbol: 1, member: 'next', value: 'sleep' } }) });
    assert.deepEqual(await confused.driver.convene(), { session: 1, phase: 'veto' });
    assert.ok(!confused.state.council.proposals.some((/** @type {any} */ p) => p.id === 'oracle-lost'));
    confused.driver.dispose();

    const quiet = councilHost({ oracle: async () => { throw new Error('offline'); } });
    await quiet.driver.convene();
    const quietIds = quiet.sent('council/phase').at(-1).proposals.map((/** @type {any} */ x) => x.by);
    assert.ok(!quietIds.includes('oracle'), 'a failing oracle simply has nothing to say');
    quiet.driver.dispose();
  });

  it('convenes on schedule, and reports a session that could not meet', async () => {
    const h = councilHost();
    await h.driver.onTick({ ...h.state.world, tick: SESSION_EVERY - 1 }, undefined);
    assert.equal(h.driver.open, false, 'not before its time');
    h.state = { ...h.state, machine: { ...h.state.machine, running: false } };
    await h.driver.onTick({ ...h.state.world, tick: SESSION_EVERY }, undefined);
    assert.equal(h.driver.open, false, 'not while the machine is paused');
    h.state = { ...h.state, machine: { ...h.state.machine, running: true } };
    await h.driver.onTick({ ...h.state.world, tick: SESSION_EVERY }, undefined);
    assert.equal(h.driver.open, true);
    h.driver.dispose();

    const broken = councilHost({ oracle: () => { throw new Error('the oracle fell over'); } });
    await assert.rejects(broken.driver.convene(), /oracle fell over/);
    assert.equal(broken.driver.open, false);
    assert.equal(broken.state.council.phase, 'idle');
    assert.equal(broken.state.council.next, broken.state.world.tick + SESSION_EVERY);
    broken.state = { ...broken.state, council: { ...broken.state.council, next: 0 } };
    await broken.driver.onTick(broken.state.world, undefined);
    const [notice] = broken.sent('os/notice');
    assert.equal(notice.tone, 'warn');
    assert.match(notice.text, /could not meet: .*the oracle fell over/);
  });

  it('repeals enacted rule and tempo amendments by their recorded inverse', () => {
    const h = councilHost();
    const original = h.state.program.machine.transitions[8].effects[0].with;
    const changed = { ...h.state.program, tempo: 20,
      machine: { ...h.state.program.machine, transitions: h.state.program.machine.transitions.map((/** @type {any} */ t, /** @type {number} */ i) => (i === 8
        ? { ...t, effects: [{ run: 'write', with: 4 }, t.effects[1]] } : t)) } };
    const rule = { id: 'a1-painter', status: 'enacted', change: { kind: 'rule', state: 'leap', symbol: 2, member: 'write', value: 4 },
      inverse: [{ op: 'replace', path: '/transitions/8/effects/0/with', value: original }] };
    const tempo = { id: 'a2-dancer', status: 'enacted', change: { kind: 'tempo', tempo: 20 }, inverse: [], previousTempo: 12 };
    const tape = { id: 'a3-architect', status: 'enacted', change: { kind: 'tape', op: 'mirror' }, inverse: [] };
    const vetoed = { id: 'a4-critic', status: 'vetoed', change: { kind: 'tempo', tempo: 3 }, inverse: [] };
    const broken = { id: 'a5-oracle', status: 'enacted', change: rule.change, inverse: [{ op: 'replace', path: '/transitions/99/to', value: 'dance' }] };
    h.state = { ...h.state, program: changed, council: { ...h.state.council, log: [rule, tempo, tape, vetoed, broken] } };

    assert.equal(h.driver.repeal('nope'), 'not-found');
    assert.equal(h.driver.repeal('a3-architect'), 'not-repealable', 'a tape change has nothing to undo');
    assert.equal(h.driver.repeal('a4-critic'), 'not-repealable', 'a vetoed proposal never happened');
    assert.equal(h.driver.repeal('a5-oracle'), 'not-repealable', 'an inverse the program cannot take is refused');
    assert.deepEqual(h.sent('council/repealed'), []);
    assert.equal(h.driver.repeal('a1-painter'), 'repealed');
    assert.equal(h.state.program.machine.transitions[8].effects[0].with, original);
    assert.equal(h.driver.repeal('a2-dancer'), 'repealed');
    assert.equal(h.state.program.tempo, 12);
    assert.deepEqual(h.sent('council/repealed').map((p) => p.amendment), ['a1-painter', 'a2-dancer']);
  });

  it('forecasts a change for the Machine app', () => {
    const h = councilHost();
    const forecast = h.driver.forecast({ kind: 'tape', op: 'mirror' });
    assert.equal(forecast.title, 'Fold the floor in half');
    assert.ok(forecast.after.symmetry > forecast.before.symmetry);
    for (const value of [...Object.values(forecast.before), ...Object.values(forecast.after)]) {
      assert.equal(Math.round(value * 10000) / 10000, value, 'rounded for the screen');
    }
    assert.equal(QUEUE_MAX, 6);
  });
});
