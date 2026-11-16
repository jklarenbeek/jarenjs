//@ts-check
/**
 * @file Problems and readings the local-search tests share, written over
 * raw JSON and sharing no code with the engine: a staff roster repaired
 * after one person's availability is withdrawn, locks drawn from a seed,
 * the churn of a list against a baseline, and the local objective.
 */

import { availabilityRequired } from './rules/reference.js';
import { ROSTER_RULES, rosterFixture, greedyByLeastTime } from './solve-fixtures.js';

/** @typedef {{ task: string, slot: string, resource: string, lock?: 'hard' | 'soft' }} Item */

/** The roster's rules and the availability rule, which reads the `availability` table. */
export const REPAIR_RULES = Object.freeze([...ROSTER_RULES, availabilityRequired]);

/** @param {string} a @param {string} b */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A published staff roster and the same roster after `absent` became
 * unavailable for the whole fortnight: the problem holds the published
 * list as its own assignments and as its baseline, and a busy row now
 * covers every one of the absent person's shifts, so `availability-required`
 * reports a hard match for each.
 * @param {number} seed @param {string} absent @param {number} [staff] @param {number} [shifts]
 * @returns {{ problem: any, published: Item[] }}
 */
export function rosterRepair(seed, absent, staff = 9, shifts = 28) {
  const roster = rosterFixture(seed, staff, shifts);
  const rows = roster.resources.map((/** @type {any} */ r) => ({ resource: r.id, start: 0, end: 1e12, state: 'available' }));
  roster.facts = { availability: { revision: 1, rows } };
  const published = greedyByLeastTime(roster);
  const problem = structuredClone(roster);
  problem.revision = `${roster.revision}-repair`;
  problem.assignments = structuredClone(published);
  problem.baseline = { revision: `published-${seed}`, assignments: structuredClone(published) };
  problem.facts.availability = { revision: 2, rows: [...rows, { resource: absent, start: 0, end: 1e12, state: 'busy' }] };
  return { problem, published };
}

/**
 * Give each assignment a lock drawn from a seed: about a third hard, a
 * third soft and a third none.
 * @param {Item[]} list @param {number} seed
 * @returns {Item[]}
 */
export function withLocks(list, seed) {
  let state = (seed * 2246822519) >>> 0;
  return list.map((item) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const pick = state % 3;
    const { task, slot, resource } = item;
    return pick === 0 ? { task, slot, resource } : { task, slot, resource, lock: pick === 1 ? 'hard' : 'soft' };
  });
}

/** @param {{ task: string, slot: string, resource: string }} item */
export const keyOf = (item) => JSON.stringify([item.task, item.slot, item.resource]);

/**
 * The churn of a list against a baseline, counted directly: per slot,
 * the baseline's resources the list lacks and the ones it holds that the
 * baseline did not, paired in code-unit order of the resource ids.
 * @param {Item[]} baseline @param {readonly Item[]} list
 */
export function rawChurn(baseline, list) {
  /** @type {Map<string, { task: string, slot: string, before: string[], after: string[] }>} */
  const slots = new Map();
  for (const [side, items] of /** @type {const} */ ([['before', baseline], ['after', list]]))
    for (const item of items) {
      const key = JSON.stringify([item.task, item.slot]);
      if (!slots.has(key)) slots.set(key, { task: item.task, slot: item.slot, before: [], after: [] });
      /** @type {any} */ (slots.get(key))[side].push(item.resource);
    }
  const added = [];
  const removed = [];
  const moved = [];
  /** @type {Record<string, number>} */
  const resources = Object.create(null);
  /** @type {Record<string, number>} */
  const tasks = Object.create(null);
  let total = 0;
  for (const { task, slot, before, after } of [...slots.values()].sort((a, b) => byCode(a.task, b.task) || byCode(a.slot, b.slot))) {
    const gone = before.filter((r) => !after.includes(r)).sort(byCode);
    const come = after.filter((r) => !before.includes(r)).sort(byCode);
    const n = Math.max(gone.length, come.length);
    total += n;
    if (n > 0) tasks[task] = (tasks[task] ?? 0) + n;
    for (const r of [...gone, ...come]) resources[r] = (resources[r] ?? 0) + 1;
    for (let i = 0; i < n; i++) {
      if (i < gone.length && i < come.length) moved.push({ from: gone[i], slot, task, to: come[i] });
      else if (i < gone.length) removed.push({ resource: gone[i], slot, task });
      else added.push({ resource: come[i], slot, task });
    }
  }
  const sorted = (/** @type {Record<string, number>} */ map, /** @type {string} */ name) => Object.keys(map).sort(byCode).map((id) => ({ count: map[id], [name]: id }));
  return { added, byResource: sorted(resources, 'resource'), byTask: sorted(tasks, 'task'), moved, removed, total };
}

const CLASS = /** @type {Record<string, number>} */ ({ feasible: 3, unknown: 2, 'infeasible-by-validation': 1 });

/**
 * The local objective over two scorings and their churn totals (null
 * without a baseline), read directly: class (an incomplete scoring
 * lowest), hard, service, churn (fewer first), soft.
 * @param {any} a @param {number | null} churnA @param {any} b @param {number | null} churnB
 * @returns {number} 1 when a is better, -1 when worse, 0 when equal on these keys
 */
export function rawObjective(a, churnA, b, churnB) {
  const cls = (/** @type {any} */ r) => (r.complete ? CLASS[r.verdict] : 0);
  if (cls(a) !== cls(b)) return cls(a) > cls(b) ? 1 : -1;
  if (!a.complete) return 0;
  /** @param {string} level */
  const cmp = (level) => {
    const x = BigInt(a.score[level]);
    const y = BigInt(b.score[level]);
    return x === y ? 0 : x > y ? 1 : -1;
  };
  const head = cmp('hard') || cmp('service');
  if (head !== 0) return head;
  if (churnA !== null && churnB !== null && churnA !== churnB) return churnA < churnB ? 1 : -1;
  return cmp('soft');
}
