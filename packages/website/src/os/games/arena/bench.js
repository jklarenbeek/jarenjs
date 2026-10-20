//@ts-check
/**
 * The engines the Arena races, measured live: the impure half of the
 * engine race. Each contender is one real workload of this OS on a real
 * Jaren engine — the turmite stepping its default program, the council's
 * merit graph compiled, the scene stylesheet run over the OS state, a
 * proposal validated against the OS contract, an amendment patched into
 * the program, the council's tally query — and the runner times them.
 *
 * Measuring reads a clock, so it lives here and nowhere else: the runner
 * takes the clock it is given (`performance.now` in the browser, a fake
 * one in a test) and answers plain numbers, which the pure game takes
 * through `act({ type: 'measured', samples })`. A slice shares its budget
 * equally and round-robin — the lane that starts first moves each slice,
 * so a garbage collection or a cold start never lands on the same lane
 * twice — and each lane runs its operation in a tight loop for its share.
 *
 * The merit graph is raced as `compileDag`, the part of a graph a frame
 * can time: its run resolves the nodes over the microtask queue, after
 * any synchronous slice has returned, so the operation answers the
 * compiled graph and leaves running it to whoever holds it.
 */

import { compileDag } from '@jarenjs/flow';
import { compileContract } from '@jarenjs/contract';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { compileJsonQuery } from '@jarenjs/json/query';
import contractDoc from '../../documents/os.contract.json' with { type: 'json' };
import meritDoc from '../../documents/merit.dag.json' with { type: 'json' };
import sceneDoc from '../../documents/scene.jslt.json' with { type: 'json' };
import workflowDoc from '../../documents/council.workflow.json' with { type: 'json' };
import { initialState } from '../../app/state.js';
import { compileMachine, stepWorld } from '../../kernel/machine.js';
import { DEFAULT_RULES, rulesToFsm, rulePointer, programStates } from '../../kernel/program.js';

/**
 * @typedef {() => unknown} Op - one unit of work; its answer is the engine's own
 * @typedef {{ id: string, label: string, kind: string, par: number, setup: () => Op }} Contender
 *   - `par`: operations a second the reference machine reaches in this runner (Node 24, warm,
 *     sharing the slice with the other lanes) — where the lane's finish line is drawn
 * @typedef {{ lane: number, ops: number, ms: number }} Sample
 */

/** At most this many operations per lane per slice: a clock that stops
 * must not hang the frame. */
export const SLICE_OPS_MAX = 1 << 18;

/** The OS state every workload starts from: the default program on a blank floor. */
const freshOs = () => initialState({ edition: 'arena', title: 'Bench Arena' });

/** The council's five voting seats. */
const SEATS = Object.freeze(['painter', 'dancer', 'critic', 'architect', 'oracle']);

/** Proposals the contract judges, one per kind of change. */
const PROPOSALS = Object.freeze([
  { by: 'oracle', title: 'When dance reads amber, turn left', why: 'Longer lines on the floor.',
    change: { kind: 'rule', state: 'dance', symbol: 2, member: 'turn', value: 'L' } },
  { by: 'architect', change: { kind: 'tape', op: 'mirror' } },
  { by: 'dancer', why: 'Faster feet.', change: { kind: 'tempo', tempo: 16 } },
]);

/**
 * What the tally query reads at the end of a session: five proposals,
 * every seat's ballot on each, the merits that weigh them.
 */
function sessionTally() {
  const proposals = SEATS.map((by, i) => ({ id: `${by}-1`, by, title: `Proposal ${i + 1}`, why: '', change: { kind: 'tempo', tempo: 10 + i } }));
  const ballots = proposals.flatMap((p, i) => SEATS.map((voter, j) => ({ voter, proposal: p.id, vote: (((i * 7 + j * 3) % 11) - 5) / 5 })));
  return {
    session: { session: 1, merits: Object.fromEntries(SEATS.map((s, i) => [s, 1 + i / 10])) },
    proposals,
    ballots: { ballots, outcomes: {} },
  };
}

/**
 * The contenders, in lane order.
 * @type {readonly Contender[]}
 */
export const CONTENDERS = Object.freeze([
  {
    id: 'turmite', label: 'Turmite', kind: 'jaren-fsm', par: 260000,
    setup() {
      const os = freshOs();
      const machine = compileMachine(os.program.machine);
      let world = os.world;
      return () => (world = stepWorld(machine, world, 1).world);
    },
  },
  {
    id: 'merit', label: 'Merit DAG', kind: 'jaren-dag', par: 7000,
    setup: () => () => compileDag(meritDoc),
  },
  {
    id: 'scene', label: 'Scene JSLT', kind: 'jslt', par: 115000,
    setup() {
      const transform = compileJsltStylesheet(sceneDoc);
      const os = freshOs();
      return () => transform(os);
    },
  },
  {
    id: 'proposal', label: 'Proposal', kind: 'contract', par: 200000,
    setup() {
      const contract = compileContract(contractDoc, { validator: new JarenValidator({ collectErrors: true }) });
      const validate = /** @type {{ validate: (value: unknown) => unknown }} */ (contract.operations['council.propose'].input).validate;
      let next = 0;
      return () => validate(PROPOSALS[next++ % PROPOSALS.length]);
    },
  },
  {
    id: 'amend', label: 'Amendment', kind: 'json-patch', par: 680000,
    setup() {
      const machine = rulesToFsm(DEFAULT_RULES);
      const patch = [{ op: 'replace', path: rulePointer(programStates(machine), 'dance', 2, 'turn'), value: 'L' }];
      return () => applyJSONPatch(machine, /** @type {any} */ (patch));
    },
  },
  {
    id: 'tally', label: 'Tally', kind: 'json-query', par: 36000,
    setup() {
      const tally = compileJsonQuery(workflowDoc.states.convene.work.dag.nodes.tally.query);
      const input = sessionTally();
      return () => tally(input);
    },
  },
]);

/**
 * A runner over contenders and a clock. Every contender is set up once,
 * here; `slice` then only measures.
 * @param {{ now: () => number, contenders?: readonly Contender[] }} options
 */
export function createBenchRunner({ now, contenders = CONTENDERS }) {
  const ops = contenders.map((c) => c.setup());
  let turn = 0;
  return {
    /** How many lanes race. */
    lanes: ops.length,
    /**
     * Spend about `budgetMs` across the lanes: each runs its operation
     * for an equal share, at least once, starting from the next lane in turn.
     * @param {number} budgetMs @returns {Sample[]} in the order the lanes ran
     */
    slice(budgetMs) {
      const n = ops.length;
      const share = Math.max(0, budgetMs) / Math.max(1, n);
      /** @type {Sample[]} */
      const samples = [];
      for (let k = 0; k < n; k++) {
        const lane = (turn + k) % n;
        const op = ops[lane];
        const start = now();
        let count = 0;
        let spent = 0;
        do {
          op();
          count += 1;
          spent = now() - start;
        } while (spent < share && count < SLICE_OPS_MAX);
        samples.push({ lane, ops: count, ms: spent });
      }
      turn = n === 0 ? 0 : (turn + 1) % n;
      return samples;
    },
  };
}
