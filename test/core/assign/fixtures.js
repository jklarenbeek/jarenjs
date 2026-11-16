//@ts-check
/** @file A small neutral problem (staff rosters) the assign tests share. */

/** @returns {any} a fresh raw problem */
export function rosterProblem() {
  return {
    revision: 'week-12',
    attributes: { minGap: 60, cap: 480, window: { start: 0, end: 1440 } },
    resources: [
      { id: 'nina', revision: 3, attributes: { skills: ['till', 'first-aid'] } },
      { id: 'ari', revision: 1, attributes: { skills: ['till'] } },
      { id: 'sam', revision: 2 },
    ],
    tasks: [
      { id: 'mon-early', revision: 1, interval: { start: 0, end: 480 }, demands: [{ slot: 'lead', count: 1, attributes: { requires: ['first-aid'] } }, { slot: 'crew', count: 2 }] },
      { id: 'mon-late', revision: 1, interval: { start: 450, end: 900 }, demands: [{ slot: 'crew', count: 1 }] },
    ],
    facts: {
      availability: { revision: 'av-1', rows: [
        { resource: 'nina', start: 0, end: 1440, state: 'available' },
        { resource: 'ari', start: 0, end: 1440, state: 'available' },
        { resource: 'sam', start: 400, end: 500, state: 'busy' },
      ] },
      preferences: { revision: 2, rows: [{ resource: 'ari', task: 'mon-late', penalty: 4 }] },
    },
    assignments: [{ task: 'mon-early', slot: 'lead', resource: 'nina', lock: 'hard' }],
    baseline: { revision: 'b-1', assignments: [{ task: 'mon-early', slot: 'lead', resource: 'nina' }] },
  };
}

/** The arrays whose order is the engine's to fix, not host data. */
const STRUCTURAL = new Set(['resources', 'tasks', 'demands', 'assignments', 'rows']);

/**
 * A deep copy whose object keys, and whose resource, task, demand,
 * assignment and fact-row arrays, come in a seeded shuffled order.
 * Arrays inside attributes are host data and keep their order; so do
 * fact rows when `keepRows` is set.
 * @param {any} value @param {number} seed @param {boolean} [keepRows]
 * @returns {any}
 */
export function shuffled(value, seed, keepRows = false) {
  let state = seed >>> 0;
  const next = (/** @type {number} */ n) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state % n;
  };
  /** @param {any[]} list */
  const mix = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = next(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  /** @param {any} node @param {string} key @returns {any} */
  const walk = (node, key) => {
    if (Array.isArray(node)) return (STRUCTURAL.has(key) && !(keepRows && key === 'rows') ? mix(node) : node).map((item) => walk(item, ''));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const member of mix(Object.keys(node)))
      Object.defineProperty(out, member, { value: walk(node[member], member), enumerable: true, writable: true, configurable: true });
    return out;
  };
  return walk(value, '');
}

/**
 * A generated staff-roster problem of `tasks` tasks over `resources`
 * resources, every slot filled round-robin, with availability and
 * preference tables: the shape the cost test and measurements score.
 * @param {number} tasks @param {number} resources
 * @returns {{ problem: any, assignments: { task: string, slot: string, resource: string }[] }}
 */
export function largeProblem(tasks, resources) {
  let state = 12345;
  const next = (/** @type {number} */ n) => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n;
  const people = [];
  for (let r = 0; r < resources; r++) people.push({ id: `p${r}`, revision: 1, attributes: { skills: next(3) === 0 ? ['till'] : ['till', 'first-aid'] } });
  const list = [];
  const assignments = [];
  // Task t sits in block floor(t / resources) of six hours, so every
  // resource's timeline is as dense at any size.
  const block = 6 * 3600000;
  const span = Math.ceil(tasks / resources) * block;
  for (let t = 0; t < tasks; t++) {
    const start = Math.floor(t / resources) * block + next(120) * 60000;
    const demands = [{ slot: 'lead', count: 1, attributes: { requires: ['first-aid'] } }, { slot: 'crew', count: 2 }];
    list.push({ id: `t${t}`, revision: 1, interval: { start, end: start + (30 + next(240)) * 60000 }, demands });
    assignments.push({ task: `t${t}`, slot: 'lead', resource: `p${t % resources}` });
    assignments.push({ task: `t${t}`, slot: 'crew', resource: `p${(t + 1) % resources}` });
    if (next(2) === 0) assignments.push({ task: `t${t}`, slot: 'crew', resource: `p${(t + 2) % resources}` });
  }
  const availability = [];
  const preferences = [];
  for (const person of people) {
    availability.push({ resource: person.id, start: 0, end: span + block, state: 'available' });
    if (next(4) === 0) {
      const start = next(span / 60000) * 60000;
      availability.push({ resource: person.id, start, end: start + 3600000, state: 'busy' });
    }
    for (let k = 0; k < 3; k++) preferences.push({ resource: person.id, task: `t${next(tasks)}`, penalty: 1 + next(4) });
  }
  return {
    problem: {
      revision: `large-${tasks}`, resources: people, tasks: list,
      facts: { availability: { revision: 1, rows: availability }, preferences: { revision: 1, rows: preferences } },
      attributes: { minGap: 8 * 3600000, cap: 40 * 3600000, window: { start: 0, end: 4 * 3600000 } },
    },
    assignments,
  };
}
