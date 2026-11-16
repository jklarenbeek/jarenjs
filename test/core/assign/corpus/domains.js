//@ts-check
/**
 * @file The quality corpus: seeded synthetic assignment problems in
 * neutral domains, written as raw JSON by a generator of its own (a
 * 32-bit LCG) and sharing no code with the engine. Each domain makes one
 * kind of constraint bite, and every instance names the rule set it is
 * scored with:
 *
 * - `overlaps`: tasks crowded into the same hours (no-overlap);
 * - `availability`: busy rows and availability that does not cover every
 *   task, so some assignments are undecided (availability-required);
 * - `attributes`: slots requiring skills few resources have (attribute-match);
 * - `gaps`: a long minimum gap between a resource's tasks (min-gap-between);
 * - `rolling`: a 24-hour window opening at each task's start, capped
 *   (the corpus rule rolling-cap), beside the fixed window cap;
 * - `days`: one task a day across a change of the clock, scored by the
 *   four day rules (consecutive days, daily rest, day caps);
 * - `coverage`: more demand than the resources can fill (coverage-min);
 * - `fairness`: many short, separate tasks, so the spread of load decides (spread-fairness);
 * - `locks`: a published list with hard and soft locks, some of them now
 *   on a busy resource;
 * - `repair`: a published list after one resource was withdrawn.
 *
 * Sizes are `{ resources, tasks }`; a `maxSpace` makes the generator
 * redraw until the oracle can enumerate every list of the problem.
 */

import { spaceOf } from '../oracle/instances.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SKILLS = ['a', 'b', 'c'];

/** The reference-rule domains, in corpus order. */
export const REFERENCE_DOMAINS = Object.freeze(['overlaps', 'availability', 'attributes', 'gaps', 'rolling', 'coverage', 'fairness', 'locks', 'repair']);

/** Every domain, in corpus order. */
export const DOMAINS = Object.freeze([...REFERENCE_DOMAINS.slice(0, 5), 'days', ...REFERENCE_DOMAINS.slice(5)]);

/**
 * Two changes of the clock in a zone the day oracle's table covers: a
 * spring-forward and a fall-back, as epoch ms of the change.
 */
export const CLOCK_CHANGES = Object.freeze([
  Object.freeze({ zone: 'Europe/Amsterdam', at: Date.UTC(2026, 2, 29, 1), local: Date.UTC(2026, 2, 29) - HOUR }),
  Object.freeze({ zone: 'Europe/Amsterdam', at: Date.UTC(2026, 9, 25, 1), local: Date.UTC(2026, 9, 25) - 2 * HOUR }),
]);

/** @param {number} seed */
function lcg(seed) {
  let state = seed >>> 0;
  return (/** @type {number} */ n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/**
 * The rule set an instance of a domain is scored with.
 * @param {string} domain
 * @returns {'reference' | 'rolling' | 'days'}
 */
export function kindOf(domain) {
  return domain === 'rolling' ? 'rolling' : domain === 'days' ? 'days' : 'reference';
}

/** Each reference domain's knobs (percentages and hours). */
const KNOBS = /** @type {Record<string, any>} */ ({
  overlaps: { spread: 3, minLen: 3, lenRange: 5, count2P: 40, minGap: 0, cap: 1e12 },
  availability: { busyP: 60, gapP: 35, count2P: 30, minGap: 0, cap: 1e12 },
  attributes: { skillP: 40, requireP: 45, count2P: 30, minGap: 0, cap: 1e12 },
  gaps: { minGap: 11 * HOUR, cap: 1e12, count2P: 20 },
  rolling: { rolling: { span: DAY, cap: 9 * HOUR }, cap: 30 * HOUR, minGap: 0, count2P: 20 },
  coverage: { count2P: 70, count3P: 40, minP: 50, minGap: 0, cap: 1e12 },
  fairness: { minLen: 1, lenRange: 2, perDay: 6, prefP: 15, minGap: 0, cap: 1e12 },
  locks: { busyP: 0, count2P: 30, minGap: 4 * HOUR, cap: 1e12, published: 'locks' },
  repair: { count2P: 30, minGap: 4 * HOUR, cap: 1e12, published: 'repair' },
});

/**
 * One reference-domain instance.
 * @param {string} domain @param {number} seed @param {{ resources: number, tasks: number }} size
 * @returns {any}
 */
function referenceInstance(domain, seed, size) {
  const k = KNOBS[domain];
  const next = lcg(seed * 2654435761 + domain.length * 97);
  const pct = (/** @type {number | undefined} */ p) => next(100) < (p ?? 0);
  const days = Math.max(1, Math.ceil(size.tasks / (k.perDay ?? 3)));
  const horizon = days * DAY;
  const resources = [];
  for (let i = 0; i < size.resources; i++) {
    const skills = SKILLS.filter(() => pct(k.skillP ?? 100));
    resources.push({ id: `r${i}`, revision: 1 + next(3), attributes: { skills } });
  }
  const tasks = [];
  for (let i = 0; i < size.tasks; i++) {
    const day = next(days);
    const hour = k.spread === undefined ? 6 + next(13) : 8 + next(k.spread);
    const start = day * DAY + hour * HOUR + next(2) * HOUR / 2;
    const end = start + ((k.minLen ?? 2) + next(k.lenRange ?? 7)) * HOUR;
    const demands = [];
    const slots = pct(25) ? 2 : 1;
    for (let s = 0; s < slots; s++) {
      const count = 1 + (pct(k.count2P) ? 1 : 0) + (pct(k.count3P) ? 1 : 0);
      const requires = SKILLS.filter(() => pct(k.requireP));
      const attributes = /** @type {Record<string, unknown>} */ ({ requires });
      if (pct(k.minP)) attributes.min = next(count + 1);
      demands.push({ slot: s === 0 ? 'lead' : 'crew', count, attributes });
    }
    tasks.push({ id: `t${i}`, revision: 1, interval: { start, end }, demands });
  }
  const availability = [];
  for (const resource of resources) {
    const covered = pct(k.gapP) ? Math.floor(horizon / 2) : horizon;
    availability.push({ resource: resource.id, start: 0, end: covered, state: 'available' });
    if (pct(k.busyP)) {
      const start = next(days * 24) * HOUR;
      availability.push({ resource: resource.id, start, end: start + (2 + next(6)) * HOUR, state: 'busy' });
    }
  }
  const preferences = [];
  for (const resource of resources)
    for (const task of tasks)
      if (pct(k.prefP ?? 5)) preferences.push({ resource: resource.id, task: task.id, penalty: 1 + next(5) });
  const attributes = /** @type {Record<string, unknown>} */ ({ minGap: k.minGap, cap: k.cap, window: { start: 0, end: horizon } });
  if (k.rolling !== undefined) attributes.rolling = k.rolling;
  const problem = /** @type {any} */ ({
    revision: `${domain}-${seed}`, resources, tasks,
    facts: { availability: { revision: `a${seed}`, rows: availability }, preferences: { revision: 1, rows: preferences } },
    attributes,
  });
  if (k.published !== undefined) publish(problem, next, k.published);
  return problem;
}

/**
 * A published list, greedy over raw JSON (each slot in id order, the
 * first resources with the skills and no overlap), made the problem's own
 * list and its baseline. `locks` then locks each assignment hard, soft or
 * not at all and makes some locked resources busy at their task; `repair`
 * withdraws the resource holding the most assignments for the whole horizon.
 * @param {any} problem @param {(n: number) => number} next @param {'locks' | 'repair'} how
 */
function publish(problem, next, how) {
  /** @type {Map<string, { start: number, end: number }[]>} */
  const busy = new Map(problem.resources.map((/** @type {any} */ r) => [r.id, []]));
  const list = [];
  for (const task of problem.tasks)
    for (const demand of task.demands) {
      let room = demand.count;
      for (const resource of problem.resources) {
        if (room === 0) break;
        const mine = /** @type {{ start: number, end: number }[]} */ (busy.get(resource.id));
        const skilled = (demand.attributes?.requires ?? []).every((/** @type {string} */ s) => resource.attributes.skills.includes(s));
        if (!skilled || mine.some((iv) => Math.min(iv.end, task.interval.end) > Math.max(iv.start, task.interval.start))) continue;
        mine.push(task.interval);
        list.push({ task: task.id, slot: demand.slot, resource: resource.id });
        room--;
      }
    }
  problem.baseline = { revision: `b-${problem.revision}`, assignments: list.map((item) => ({ ...item })) };
  const rows = problem.facts.availability.rows;
  if (how === 'locks') {
    problem.assignments = list.map((item) => {
      const roll = next(3);
      return roll === 0 ? { ...item, lock: 'hard' } : roll === 1 ? { ...item, lock: 'soft' } : { ...item };
    });
    for (const item of problem.assignments)
      if (item.lock !== undefined && next(4) === 0) {
        const { interval } = problem.tasks.find((/** @type {any} */ t) => t.id === item.task);
        rows.push({ resource: item.resource, start: interval.start, end: interval.end, state: 'busy' });
      }
  }
  else {
    problem.assignments = list.map((item) => ({ ...item }));
    const load = new Map();
    for (const item of list) load.set(item.resource, (load.get(item.resource) ?? 0) + 1);
    let absent = problem.resources[0].id;
    for (const resource of problem.resources) if ((load.get(resource.id) ?? 0) > (load.get(absent) ?? 0)) absent = resource.id;
    rows.push({ resource: absent, start: 0, end: problem.attributes.window.end, state: 'busy' });
  }
}

/**
 * One `days` instance: a task a day for `size.tasks` days around a change
 * of the clock, each in the changing zone (now and then none), one slot,
 * some running past midnight; at most 2 consecutive worked days, 8 hours
 * a day, 3 at least on a worked day, 11 hours of rest.
 * @param {number} seed @param {{ resources: number, tasks: number }} size
 * @param {{ zone: string, local: number }} change - `local` is the epoch of the change day's local midnight
 * @returns {any}
 */
function dayInstance(seed, size, change) {
  const next = lcg(seed * 40503 + 11);
  const resources = Array.from({ length: size.resources }, (_, i) => ({ id: `r${i}`, revision: 1 }));
  const first = change.local - Math.floor(size.tasks / 2) * DAY;
  const tasks = Array.from({ length: size.tasks }, (_, i) => {
    const late = next(4) === 0;
    const start = first + i * DAY + (late ? 20 : 7 + next(8)) * HOUR;
    const zone = next(12) === 0 ? undefined : change.zone;
    return { id: `t${i}`, revision: 1, interval: { start, end: start + (3 + next(7)) * HOUR }, demands: [{ slot: 's', count: 1 }], ...(zone === undefined ? {} : { zone }) };
  });
  return { revision: `days-${seed}`, resources, tasks, attributes: { dayCap: 8 * HOUR, minDay: 3 * HOUR, maxRun: 2, minRest: 11 * HOUR } };
}

/**
 * One corpus instance.
 * @param {string} domain - one of {@link DOMAINS}
 * @param {number} seed
 * @param {{ resources: number, tasks: number }} size
 * @param {{ maxSpace?: number, change?: { zone: string, local: number } }} [options]
 * @returns {any} raw problem JSON
 */
export function domainInstance(domain, seed, size, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const draw = seed + attempt * 100003;
    const problem = domain === 'days'
      ? dayInstance(draw, size, options.change ?? CLOCK_CHANGES[seed % CLOCK_CHANGES.length])
      : referenceInstance(domain, draw, size);
    problem.revision = `${domain}-${seed}`;
    if (options.maxSpace === undefined || spaceOf(problem) <= options.maxSpace) return problem;
    if (attempt === 200) throw new Error(`${domain} ${seed}: no draw within ${options.maxSpace} lists`);
  }
}
