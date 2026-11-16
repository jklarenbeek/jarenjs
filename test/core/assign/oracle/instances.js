//@ts-check
/**
 * @file Tiny instances and their exhaustive enumeration, for the oracle.
 * A seeded generator of its own (a 32-bit LCG; no engine or core module)
 * writes problems of at most 4 resources and 5 tasks, each with one or
 * two slots, sized so every assignment list can be enumerated, and
 * `enumerate` yields every such list: the problem's own assignments
 * and, per slot, every subset of the resources not already in it no
 * larger than the room left.
 */

/** @param {number} seed */
function lcg(seed) {
  let state = seed >>> 0;
  return (/** @type {number} */ n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/** @param {number} n @param {number} k @returns {number} */
function choose(n, k) {
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return out;
}

/**
 * The resources already in one slot: the problem's own assignments,
 * which every list of the problem keeps.
 * @param {any} problem @param {string} task @param {string} slot
 * @returns {string[]}
 */
function heldIn(problem, task, slot) {
  return (problem.assignments ?? []).filter((/** @type {any} */ a) => a.task === task && a.slot === slot).map((/** @type {any} */ a) => a.resource);
}

/**
 * The number of assignment lists of a problem: per slot, the sets of
 * the resources not already in it no larger than the room it has left.
 * @param {any} problem
 * @returns {number}
 */
export function spaceOf(problem) {
  let space = 1;
  for (const task of problem.tasks)
    for (const demand of task.demands) {
      const held = heldIn(problem, task.id, demand.slot);
      const free = problem.resources.length - held.length;
      let ways = 0;
      for (let k = 0; k <= Math.min(demand.count - held.length, free); k++) ways += choose(free, k);
      space *= ways;
    }
  return space;
}

const SKILLS = ['a', 'b', 'c'];

/**
 * One tiny instance from a seed: ids that sort in code-unit order unlike
 * their numbers (`r10` before `r9`), skills, availability and
 * preferences tables (each sometimes absent, so a rule is unknown), and
 * the window, cap and minimum gap in its attributes.
 * @param {number} seed
 * @returns {any}
 */
export function tinyInstance(seed) {
  const next = lcg(seed);
  for (;;) {
    const resources = [];
    const resourceCount = next(5) === 0 ? 1 : 2 + next(3);
    for (let i = 0; i < resourceCount; i++) {
      const skills = SKILLS.filter(() => next(2) === 1);
      resources.push({ id: `r${[9, 10, 2, 1][i]}`, revision: 1 + next(3), attributes: { skills } });
    }
    const tasks = [];
    const taskCount = 1 + next(5);
    for (let i = 0; i < taskCount; i++) {
      const start = next(40) * 5;
      const end = start + 5 + next(8) * 5;
      const demands = [];
      const slots = 1 + next(2);
      for (let s = 0; s < slots; s++) {
        const count = 1 + next(2);
        const requires = SKILLS.filter(() => next(3) === 0);
        const attributes = /** @type {Record<string, unknown>} */ ({ requires });
        if (next(3) === 0) attributes.min = next(count + 1);
        demands.push({ slot: s === 0 ? 'lead' : 'crew', count, attributes });
      }
      tasks.push({ id: `t${i}`, revision: 1, interval: { start, end }, demands });
    }
    /** @type {Record<string, unknown>} */
    const facts = {};
    if (next(4) !== 0) {
      const rows = [];
      for (const resource of resources) {
        if (next(4) === 0) continue;
        rows.push({ resource: resource.id, start: next(10) * 5, end: 150 + next(20) * 5, state: 'available' });
        if (next(2) === 0) {
          const start = next(40) * 5;
          rows.push({ resource: resource.id, start, end: start + 5 + next(4) * 5, state: 'busy' });
        }
      }
      facts.availability = { revision: `a${seed}`, rows };
    }
    if (next(3) !== 0) {
      const rows = [];
      for (const resource of resources)
        for (const task of tasks)
          if (next(4) === 0) rows.push({ resource: resource.id, task: task.id, penalty: 1 + next(5) });
      facts.preferences = { revision: 7, rows };
    }
    const problem = {
      revision: `p${seed}`, resources, tasks, facts,
      attributes: { minGap: 5 + next(4) * 5, cap: 10 + next(8) * 10, window: { start: next(10) * 10, end: 100 + next(10) * 10 } },
    };
    if (spaceOf(problem) <= 4000) return problem;
  }
}

/**
 * Every assignment list of a problem: the problem's own assignments
 * and, per slot, every subset of the resources not already in it of at
 * most the room it has left.
 * @param {any} problem
 * @returns {Generator<{ task: string, slot: string, resource: string }[]>}
 */
export function* enumerate(problem) {
  const slots = [];
  for (const task of problem.tasks)
    for (const demand of task.demands) {
      const held = heldIn(problem, task.id, demand.slot);
      const free = problem.resources.map((/** @type {any} */ resource) => resource.id).filter((/** @type {string} */ id) => !held.includes(id));
      /** @type {string[][]} */
      const subsets = [];
      for (let mask = 0; mask < (1 << free.length); mask++) {
        const subset = free.filter((/** @type {string} */ _, /** @type {number} */ i) => (mask & (1 << i)) !== 0);
        if (subset.length <= demand.count - held.length) subsets.push(subset);
      }
      slots.push({ task: task.id, slot: demand.slot, subsets });
    }
  const fixed = (problem.assignments ?? []).map((/** @type {any} */ a) => ({ task: a.task, slot: a.slot, resource: a.resource }));
  /** @param {number} at @param {{ task: string, slot: string, resource: string }[]} chosen @returns {Generator<any>} */
  function* walk(at, chosen) {
    if (at === slots.length) {
      yield [...fixed, ...chosen];
      return;
    }
    for (const subset of slots[at].subsets) {
      for (const resource of subset) chosen.push({ task: slots[at].task, slot: slots[at].slot, resource });
      yield* walk(at + 1, chosen);
      chosen.length -= subset.length;
    }
  }
  yield* walk(0, []);
}
