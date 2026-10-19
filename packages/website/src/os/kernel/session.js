//@ts-check
/**
 * The council's host: it runs `council.workflow.json` — one session per
 * run — and `merit.dag.json`, and is the only code that turns their
 * results into app state.
 *
 * A session, end to end:
 *
 *   1. `convene` starts a workflow run over a snapshot of the program,
 *      the world, the merits and the queued proposals. The workflow's
 *      first work state is a DAG: every seat proposes (`propose`), every
 *      member judges every proposal by simulation (`deliberate`), and a
 *      query node tallies the ballots by merit.
 *   2. With a winner, the run WAITS in the `verdict` state: a durable
 *      wait whose only ways out are the human's `veto`, the human's
 *      `approve`, or its timer. The workflow keeps no clock of its own,
 *      so this host arms one at the snapshot's earliest deadline and
 *      resumes the run when it fires — the same call a veto makes, with
 *      an event instead of a time.
 *   3. `enact` applies the winner to the program as it stands NOW (the
 *      machine kept dancing while the human decided); `veto` records the
 *      refusal; `rest` records a session with nothing worth doing.
 *   4. A while later the enactment is judged against the future it
 *      replaced: the counterfactual world is simulated at enactment, the
 *      real one is measured when the machine gets there, and the merit
 *      DAG rewards the difference. A veto is judged at once.
 *
 * The workflow decides control, the DAG decides merit, the contract
 * decides who may say what; this file decides nothing, it carries.
 */

import { compileWorkflow, compileDag } from '@jarenjs/flow';
import { mulberry32 } from '@jarenjs/core/random';
import workflowDoc from '../documents/council.workflow.json' with { type: 'json' };
import meritDoc from '../documents/merit.dag.json' with { type: 'json' };
import { MEMBERS, LOOKAHEAD, propose, deliberate, applyChange, simulate, describeChange, fitsProgram } from './council.js';
import { compileMachine, stepWorld } from './machine.js';
import { measure, roundMeasure } from './metrics.js';
import { applyJSONPatch } from '@jarenjs/json/patch';

/** Ticks between the end of one session and the next, when nobody convenes one. */
export const SESSION_EVERY = 360;
/** How long the human has to decide, ms. The workflow document's `after`
 * is the authority; this mirrors it for the countdown on screen. */
export const VERDICT_MS = workflowDoc.states.verdict.after.ms;
/** At most this many proposals wait in the queue between sessions. */
export const QUEUE_MAX = 6;

/** Three decimals: what the documents compute exactly, the host publishes
 * rounded — the documents keep to operators every Jaren release has. */
const round3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;

/**
 * @typedef {import('./council.js').Proposal} Proposal
 * @typedef {import('./council.js').Change} Change
 * @typedef {import('./machine.js').World} World
 * @typedef {{ getState: () => any, dispatch: (action: string, payload?: any) => void,
 *   oracle?: (context: any, signal: AbortSignal) => Promise<Proposal | null>,
 *   validateProposal?: (proposal: Proposal) => boolean,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void,
 *   now?: () => number, yieldEvery?: () => Promise<void> }} DriverHost
 */

/**
 * Create the council driver.
 * @param {DriverHost} host
 */
export function createCouncilDriver(host) {
  const setTimer = host.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = host.clearTimer ?? ((id) => clearTimeout(id));
  const clock = host.now ?? (() => Date.now());
  const pause = host.yieldEvery ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));

  /** @type {{ runId: string, input: any, snapshot: any, started: number, timer: any, winner: any } | null} */
  let open = null;
  /** Enactments waiting to be judged: the counterfactual's measure and the tick it is due. */
  /** @type {Array<{ amendment: any, due: number, baseline: any, ballots: any[] }>} */
  const pending = [];
  let busy = false;

  const workflow = compileWorkflow(workflowDoc, {
    tasks: {
      propose: { version: '1', run: async ({ input }, signal) => gather(input, signal) },
      deliberate: { version: '1', run: async ({ input }) => deliberate(input.proposals, input.session.program, input.session.world) },
      enact: { version: '1', run: async ({ input }) => enact(input) },
      veto: { version: '1', run: async ({ input }) => refuse(input) },
      rest: { version: '1', run: async ({ input }) => ({ session: input.session, verdict: 'rest' }) },
    },
  });
  const merit = compileDag(meritDoc);

  /**
   * Every seat's proposal for this session. Members propose in turn,
   * yielding between them so a session never holds a frame for longer
   * than one member's thinking; the oracle answers through its own seam;
   * queued proposals (the human's, an agent's) join last.
   * @param {any} input @param {AbortSignal} signal
   */
  async function gather(input, signal) {
    /** @type {Proposal[]} */
    const out = [];
    for (const member of MEMBERS) {
      if (member.taste === null || member.id === 'oracle') continue;
      await pause();
      const p = propose(member, input.program, input.world, input.seed);
      if (p) out.push(p);
    }
    const oracle = MEMBERS.find((m) => m.id === 'oracle');
    if (oracle) {
      await pause();
      const p = host.oracle
        ? await host.oracle({ program: input.program, world: input.world, chat: input.chat ?? [], seed: input.seed }, signal)
          .catch(() => null)
        : propose(oracle, input.program, input.world, input.seed);
      if (p && valid(p, input.program)) out.push(p);
    }
    for (const queued of input.queue ?? []) if (valid(queued, input.program)) out.push(queued);
    return out;
  }

  /** A proposal from outside the council's own members: well-formed, and
   * naming only states the program has (the queue may predate a program
   * put back from the gallery).
   * @param {Proposal} p @param {{ machine: any }} program */
  function valid(p, program) {
    return (host.validateProposal ? host.validateProposal(p) : true) && fitsProgram(p.change, program.machine);
  }

  /**
   * Apply the winner to the program and world as they stand now.
   * @param {any} data - the tally, carried through `decide` and `verdict`
   */
  function enact(data) {
    const state = host.getState();
    const proposal = data.winner.proposal;
    const program = { machine: state.program.machine, tempo: state.program.tempo };
    if (!fitsProgram(proposal.change, program.machine)) {
      // the program moved under the proposal (an artwork put back from
      // the gallery) and a state the rule names no longer exists
      host.dispatch('council/refused', { session: data.session, reason: 'it names a state the program no longer has' });
      return { session: data.session, verdict: 'refused' };
    }
    const applied = applyChange(program, state.world, proposal.change);
    const amendment = {
      id: `a${data.session}-${proposal.by}`,
      proposal: proposal.id,
      session: data.session,
      by: proposal.by,
      title: proposal.title,
      status: 'enacted',
      change: proposal.change,
      score: round3(data.winner.score),
      reward: null,
      inverse: applied.inverse,
      previousTempo: state.program.tempo,
      tick: state.world.tick,
    };
    // the future this amendment replaces, simulated now while it still can be
    const baseline = stepWorld(compileMachine(state.program.machine), state.world, LOOKAHEAD).world;
    pending.push({
      amendment,
      due: state.world.tick + LOOKAHEAD,
      baseline: measure(baseline, state.world.tape),
      ballots: data.ballots,
    });
    host.dispatch('council/enacted', {
      program: { ...state.program, machine: applied.program.machine, tempo: applied.program.tempo },
      world: applied.world,
      amendment,
    });
    return { session: data.session, verdict: 'enacted', amendment: amendment.id };
  }

  /** The human said no: record it, and let the merit document weigh it now.
   * @param {any} data */
  async function refuse(data) {
    const proposal = data.winner.proposal;
    const amendment = {
      id: `a${data.session}-${proposal.by}`, proposal: proposal.id, session: data.session, by: proposal.by,
      title: proposal.title, status: 'vetoed', change: proposal.change, score: round3(data.winner.score), reward: null,
      inverse: [], previousTempo: null, tick: host.getState().world.tick,
    };
    host.dispatch('council/vetoed', { amendment });
    await reward(amendment, data.ballots, { balance: 0, symmetry: 0, structure: 0, motion: 0, harmony: 0 }, 'vetoed');
    return { session: data.session, verdict: 'vetoed', amendment: amendment.id };
  }

  /**
   * Run the merit document over one verdict and publish the new merits.
   * @param {any} amendment @param {any[]} ballots @param {Record<string, number>} delta @param {'enacted' | 'vetoed'} status
   */
  async function reward(amendment, ballots, delta, status) {
    const merits = host.getState().council.merits;
    const result = await merit.run({
      status, merits, proposer: amendment.by, proposal: amendment.proposal, ballots: ballots ?? [], delta,
    });
    host.dispatch('council/merits', {
      merits: Object.fromEntries(Object.entries(result.merits).map(([id, merit]) => [id, round3(/** @type {number} */ (merit))])),
      amendment: amendment.id,
      reward: round3(result.gains[amendment.by] ?? 0),
    });
    return result;
  }

  /**
   * Publish a settled or waiting run.
   * @param {any} result
   */
  function settle(result) {
    if (!open) return;
    if (result.status === 'waiting') {
      const data = result.snapshot.context.data;
      const timer = result.snapshot.control.timers?.[0];
      const deadline = open.started + (timer?.at ?? VERDICT_MS);
      open.snapshot = result.snapshot;
      open.winner = data.winner;
      clearTimer(open.timer);
      open.timer = setTimer(() => { void resume(null); }, Math.max(0, deadline - clock()));
      host.dispatch('council/phase', {
        phase: 'veto', session: data.session, proposals: data.proposals,
        scores: data.scores.map((/** @type {{ id: string, score: number }} */ s) => ({ id: s.id, score: round3(s.score) })),
        winner: { ...data.winner.proposal, score: round3(data.winner.score) }, deadline, window: VERDICT_MS,
      });
      return;
    }
    clearTimer(open.timer);
    const session = open.input.session;
    open = null;
    if (result.result?.verdict === 'rest') host.dispatch('council/rested', { session });
    host.dispatch('council/phase', {
      phase: 'idle', session, proposals: [], scores: [], winner: null, deadline: null, window: VERDICT_MS,
      next: host.getState().world.tick + SESSION_EVERY,
    });
  }

  /**
   * Resume the waiting run: with the human's event, or (null) because
   * the timer fired.
   * @param {'veto' | 'approve' | null} event
   */
  async function resume(event) {
    if (!open || !open.snapshot || busy) return null;
    busy = true;
    try {
      const elapsed = clock() - open.started;
      const result = await workflow.run(open.input, {
        runId: open.runId,
        snapshot: open.snapshot,
        now: Math.max(open.snapshot.control.time ?? 0, elapsed),
        ...(event ? { event: { type: event } } : {}),
      });
      settle(result);
      return result;
    }
    finally {
      busy = false;
    }
  }

  return {
    /** The workflow and merit documents this driver runs (for the Source app). */
    documents: { workflow: workflowDoc, merit: meritDoc },

    /** Whether a session is open. */
    get open() { return open !== null; },

    /** The proposal awaiting the human's verdict, if any. */
    get awaiting() { return open?.winner?.proposal?.id ?? null; },

    /**
     * Convene a session now.
     * @returns {Promise<{ session: number, phase: string } | null>} null when one is already open
     */
    async convene() {
      if (open || busy) return null;
      const state = host.getState();
      const session = (state.council.session ?? 0) + 1;
      busy = true;
      try {
        open = {
          runId: `session-${session}`,
          input: {
            session,
            seed: (Math.floor(mulberry32(session * 7919)() * 2 ** 31) ^ state.world.tick) >>> 0,
            merits: state.council.merits,
            program: { machine: state.program.machine, tempo: state.program.tempo },
            world: state.world,
            queue: state.council.queue ?? [],
            chat: (state.council.chat ?? []).slice(0, 6),
          },
          snapshot: null, started: clock(), timer: null, winner: null,
        };
        host.dispatch('council/phase', {
          phase: 'convening', session, proposals: [], scores: [], winner: null, deadline: null, window: VERDICT_MS,
        });
        host.dispatch('council/queue', []);
        const result = await workflow.run(open.input, { runId: open.runId, now: 0 });
        busy = false;
        settle(result);
        return { session, phase: result.status === 'waiting' ? 'veto' : 'idle' };
      }
      catch (error) {
        busy = false;
        const failed = open?.input.session ?? session;
        if (open) clearTimer(open.timer);
        open = null;
        host.dispatch('council/phase', {
          phase: 'idle', session: failed, proposals: [], scores: [], winner: null, deadline: null, window: VERDICT_MS,
          next: host.getState().world.tick + SESSION_EVERY,
        });
        throw error;
      }
      finally {
        busy = false;
      }
    },

    /**
     * The human's verdict on the awaiting proposal.
     * @param {'veto' | 'approve'} event @param {string} proposal
     * @returns {Promise<boolean>} false when that proposal is not awaiting
     */
    async verdict(event, proposal) {
      if (!open?.snapshot || open.winner?.proposal?.id !== proposal) return false;
      await resume(event);
      return true;
    },

    /**
     * Called by the tape unit after every advance: convenes on schedule
     * and judges the enactments whose future has arrived.
     * @param {World} world
     * @param {readonly number[] | undefined} past - the tape the dancer's liveliness is judged against
     */
    async onTick(world, past) {
      while (pending.length > 0 && pending[0].due <= world.tick) {
        const judged = /** @type {any} */ (pending.shift());
        const actual = measure(world, past);
        /** @type {Record<string, number>} */
        const delta = {};
        for (const key of Object.keys(actual)) delta[key] = actual[/** @type {'harmony'} */ (key)] - judged.baseline[key];
        await reward(judged.amendment, judged.ballots, roundMeasure(delta), 'enacted');
      }
      const state = host.getState();
      if (!open && !busy && state.machine.running && world.tick >= (state.council.next ?? SESSION_EVERY)) {
        await this.convene().catch((error) => host.dispatch('os/notice', { tone: 'warn', text: `The council could not meet: ${error?.message ?? error}` }));
      }
    },

    /**
     * Undo an enacted rule or tempo amendment: apply its recorded inverse.
     * @param {string} id
     * @returns {'repealed' | 'not-found' | 'not-repealable'}
     */
    repeal(id) {
      const state = host.getState();
      const amendment = (state.council.log ?? []).find((/** @type {any} */ a) => a.id === id);
      if (!amendment) return 'not-found';
      if (amendment.status !== 'enacted') return 'not-repealable';
      const program = state.program;
      let next = program;
      if (amendment.change.kind === 'rule') {
        try {
          next = { ...program, machine: applyJSONPatch(program.machine, amendment.inverse) };
        }
        catch {
          return 'not-repealable';
        }
      }
      else if (amendment.change.kind === 'tempo') {
        next = { ...program, tempo: amendment.previousTempo ?? program.tempo };
      }
      else {
        return 'not-repealable';
      }
      host.dispatch('council/repealed', { program: next, amendment: id });
      return 'repealed';
    },

    /** Forecast what a change would do, for the Machine app's preview.
     * @param {Change} change */
    forecast(change) {
      const state = host.getState();
      const outcome = simulate({ machine: state.program.machine, tempo: state.program.tempo }, state.world, change);
      return { title: describeChange(change), before: roundMeasure(outcome.before), after: roundMeasure(outcome.after) };
    },

    /** Stop every timer (the OS is shutting down). */
    dispose() {
      if (open) clearTimer(open.timer);
      open = null;
      pending.length = 0;
    },
  };
}
