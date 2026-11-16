//@ts-check
/**
 * @file Seeded edit streams for the evaluator tests: generated problems,
 * random edits, the edit semantics written a second time over plain
 * arrays, and the equality check that names the rules whose answers
 * differ. Nothing here imports the evaluator; full scoring is the oracle.
 */

import { registerRules, scoreAssignment } from '@jarenjs/core/assign';

const HOUR = 3600000;

/**
 * A seeded generator of whole numbers below `n`, from the high bits of a
 * 32-bit LCG (its low bits repeat with a short period).
 * @param {number} seed @returns {(n: number) => number}
 */
export function lcg(seed) {
  let state = seed >>> 0;
  return (n) => Math.floor((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296 * n);
}

/**
 * A staff-roster problem for a stream: `resources` people, `tasks` tasks
 * of two slots (lead 1, crew 2) over a few days, skills, availability and
 * preferences, and a starting list. With `zones`, each task has one of
 * them, except about one in six with none and, with `stray`, one task
 * in a zone the provider does not know.
 * @param {number} seed
 * @param {{ resources: number, tasks: number, start?: number, days?: number, zones?: string[], stray?: string }} size
 * @returns {{ problem: any, assignments: { task: string, slot: string, resource: string }[] }}
 */
export function streamInstance(seed, { resources, tasks, start = Date.UTC(2026, 9, 21), days = 6, zones, stray }) {
  const next = lcg(seed * 2654435761);
  const people = Array.from({ length: resources }, (_, r) => ({
    id: `p${r}`, revision: 1, attributes: { skills: next(3) === 0 ? ['till'] : ['till', 'first-aid'] },
  }));
  const list = Array.from({ length: tasks }, (_, t) => {
    const from = start + next(days * 48) * HOUR / 2;
    /** @type {Record<string, unknown>} */
    const task = {
      id: `t${t}`, revision: 1, interval: { start: from, end: from + (1 + next(20)) * HOUR / 2 },
      demands: [{ slot: 'lead', count: 1, attributes: { requires: ['first-aid'] } }, { slot: 'crew', count: 2, attributes: { min: 1 } }],
    };
    if (zones !== undefined) {
      if (stray !== undefined && t === tasks - 1) task.zone = stray;
      else if (next(6) !== 0) task.zone = zones[next(zones.length)];
    }
    return task;
  });
  const availability = [];
  const preferences = [];
  for (const person of people) {
    availability.push({ resource: person.id, start, end: start + days * 24 * HOUR, state: 'available' });
    if (next(3) === 0) {
      const from = start + next(days * 24) * HOUR;
      availability.push({ resource: person.id, start: from, end: from + 2 * HOUR, state: 'busy' });
    }
    for (let k = 0; k < 2; k++) preferences.push({ resource: person.id, task: `t${next(tasks)}`, penalty: 1 + next(4) });
  }
  const assignments = [];
  for (let t = 0; t < tasks; t++) {
    if (stray !== undefined && t === tasks - 1) continue;
    if (next(4) !== 0) assignments.push({ task: `t${t}`, slot: 'lead', resource: `p${next(resources)}` });
    const crew = next(resources);
    if (next(3) !== 0) assignments.push({ task: `t${t}`, slot: 'crew', resource: `p${crew}` });
  }
  return {
    problem: {
      revision: `stream-${seed}`, resources: people, tasks: list,
      facts: { availability: { revision: 1, rows: availability }, preferences: { revision: 1, rows: preferences } },
      attributes: {
        minGap: 2 * HOUR, cap: 6 * HOUR, window: { start, end: start + 24 * HOUR },
        dayCap: 7 * HOUR, minDay: 2 * HOUR, maxRun: 2, minRest: 14 * HOUR,
      },
    },
    assignments,
  };
}

/** @typedef {{ task: string, slot: string, resource: string, lock?: string }} Plain */

/**
 * A random edit of the list: mostly one the list can take, sometimes one
 * it cannot (a full slot, an id the problem does not hold, an assignment
 * the list does not hold).
 * @param {(n: number) => number} next @param {any} problem @param {readonly Plain[]} list
 * @returns {any}
 */
export function randomEdit(next, problem, list) {
  const resources = problem.resources.length;
  const tasks = problem.tasks.length;
  const person = () => (next(40) === 0 ? 'nobody' : `p${next(resources)}`);
  const pick = () => {
    if (list.length === 0 || next(30) === 0) return { task: `t${next(tasks)}`, slot: 'crew', resource: `p${next(resources)}` };
    const { task, slot, resource } = list[next(list.length)];
    return { task, slot, resource };
  };
  const roll = next(10);
  if (roll < 3 || list.length === 0) {
    const edit = { op: 'assign', task: `t${next(tasks)}`, slot: next(2) === 0 ? 'lead' : 'crew', resource: person() };
    return next(8) === 0 ? { ...edit, lock: next(2) === 0 ? 'hard' : 'soft' } : edit;
  }
  if (roll < 5) return { op: 'unassign', ...pick() };
  if (roll < 8) {
    const { task, slot, resource } = pick();
    return { op: 'move', task, slot, from: resource, to: person() };
  }
  return { op: 'swap', a: pick(), b: pick() };
}

/**
 * An edit made on a plain list, as the evaluator documents it, or the
 * code it is refused with.
 * @param {any} problem @param {readonly Plain[]} list @param {any} edit
 * @returns {{ list: Plain[] } | { code: string }}
 */
export function plainApply(problem, list, edit) {
  const task = (/** @type {string} */ id) => problem.tasks.find((/** @type {any} */ t) => t.id === id);
  const known = (/** @type {any} */ x, /** @type {string} */ member) =>
    task(x.task) !== undefined && task(x.task).demands.some((/** @type {any} */ d) => d.slot === x.slot)
    && problem.resources.some((/** @type {any} */ r) => r.id === x[member]);
  const find = (/** @type {any} */ x, /** @type {string} */ member = 'resource') =>
    list.findIndex((a) => a.task === x.task && a.slot === x.slot && a.resource === x[member]);
  const out = list.map((a) => ({ ...a }));
  const clash = () => {
    const seen = new Set();
    const filled = new Map();
    for (const a of out) {
      const key = `${a.task}\n${a.slot}`;
      if (seen.has(`${key}\n${a.resource}`)) return true;
      seen.add(`${key}\n${a.resource}`);
      filled.set(key, (filled.get(key) ?? 0) + 1);
      if (filled.get(key) > task(a.task).demands.find((/** @type {any} */ d) => d.slot === a.slot).count) return true;
    }
    return false;
  };
  if (edit.op === 'assign') {
    if (!known(edit, 'resource')) return { code: 'JN0007' };
    out.push(edit.lock === undefined ? { task: edit.task, slot: edit.slot, resource: edit.resource } : { task: edit.task, slot: edit.slot, resource: edit.resource, lock: edit.lock });
  }
  else if (edit.op === 'unassign') {
    if (!known(edit, 'resource')) return { code: 'JN0007' };
    const at = find(edit);
    if (at < 0) return { code: 'JN0023' };
    out.splice(at, 1);
  }
  else if (edit.op === 'move') {
    if (!known(edit, 'from') || !known(edit, 'to')) return { code: 'JN0007' };
    const at = find(edit, 'from');
    if (at < 0) return { code: 'JN0023' };
    out[at].resource = edit.to;
  }
  else {
    if (!known(edit.a, 'resource') || !known(edit.b, 'resource')) return { code: 'JN0007' };
    const a = find(edit.a);
    const b = find(edit.b);
    if (a < 0 || b < 0) return { code: 'JN0023' };
    const ra = out[a].resource;
    out[a].resource = out[b].resource;
    out[b].resource = ra;
  }
  return clash() ? { code: 'JN0008' } : { list: out };
}

/**
 * What a call answers, as comparable text: the result's JSON, or the
 * refusal's code and docPath.
 * @param {() => unknown} call
 * @returns {string}
 */
export function outcome(call) {
  try {
    return JSON.stringify(call());
  }
  catch (error) {
    const e = /** @type {any} */ (error);
    if (typeof e?.code !== 'string') throw error;
    return JSON.stringify({ refused: e.code, docPath: e.docPath ?? null });
  }
}

/**
 * The rule ids whose matches or unknowns differ between two outcomes,
 * plus `score`, `counts`, `verdict` or `provenance` when those do: what
 * an equality failure names.
 * @param {string} actual @param {string} expected
 * @returns {string[]}
 */
export function differing(actual, expected) {
  const a = JSON.parse(actual);
  const b = JSON.parse(expected);
  if (a.refused !== undefined || b.refused !== undefined) return ['refusal'];
  const out = [];
  for (const key of ['complete', 'verdict', 'score', 'counts', 'provenance', 'stoppedAt'])
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
  const rules = new Set([...(a.matches ?? []), ...(a.unknowns ?? []), ...(b.matches ?? []), ...(b.unknowns ?? [])].map((x) => x.rule));
  for (const rule of [...rules].sort()) {
    const of = (/** @type {any} */ r) => JSON.stringify([(r.matches ?? []).filter((/** @type {any} */ x) => x.rule === rule), (r.unknowns ?? []).filter((/** @type {any} */ x) => x.rule === rule)]);
    if (of(a) !== of(b)) out.push(rule);
  }
  return out;
}

/**
 * Run a seeded stream: after every edit, `apply`'s answer and a preview
 * of another edit must be the bytes a fresh full scoring answers, or the
 * same refusal; a refused edit and every preview leave the evaluator's
 * result and list as they were. Answers what the stream visited, or the
 * first difference (`failure`, naming the rules).
 * `onState` is told each list about to be scored, for a rule that reads
 * host state the view cannot see; `onApplied` each list an edit made.
 * Given the `rules` and `make(ruleSet)` that builds the evaluator, a
 * failure also names its `culprits`: the rules without which the same
 * stream is exact up to the failing edit.
 * A stream can be run in parts: pass the `next` generator a part
 * answered back, with the `list` it ended on.
 * @param {{ evaluator: any, problem: any, ruleSet: any, list: Plain[], options?: any, edits: number, seed: number,
 *   next?: (n: number) => number,
 *   onState?: (list: Plain[]) => void, onApplied?: (list: Plain[], result: any) => void,
 *   rules?: readonly any[], make?: (ruleSet: any) => any }} run
 * @returns {{ failure: any, seen: any, list: Plain[], next: (n: number) => number }}
 */
export function runStream(run) {
  const out = streamOnce(run);
  if (out.failure === null || run.rules === undefined || run.make === undefined) return out;
  const { rules, make } = run;
  out.failure.culprits = rules.filter((rule) => {
    const fewer = registerRules(rules.filter((other) => other !== rule));
    const again = streamOnce({ ...run, next: undefined, ruleSet: fewer, evaluator: make(fewer), edits: out.failure.at + 1 });
    return again.failure === null;
  }).map((rule) => rule.id);
  return out;
}

/**
 * One stream, as {@link runStream} describes it.
 * @param {Parameters<typeof runStream>[0]} run
 * @returns {{ failure: any, seen: any, list: Plain[], next: (n: number) => number }}
 */
function streamOnce({ evaluator, problem, ruleSet, list, options, edits, seed, next = lcg(seed), onState = () => {}, onApplied = () => {} }) {
  const seen = { applied: 0, refused: /** @type {Record<string, number>} */ ({}), previews: 0, incomplete: 0, complete: 0, unitsMoved: 0 };
  let current = list;
  const full = (/** @type {Plain[]} */ l) => outcome(() => scoreAssignment(problem, ruleSet, l, options));
  let units = evaluator.result.counts.units;
  for (let i = 0; i < edits; i++) {
    const edit = randomEdit(next, problem, current);
    const planned = plainApply(problem, current, edit);
    const result = evaluator.result;
    const held = evaluator.assignments;
    onState('code' in planned ? current : planned.list);
    const expected = 'code' in planned ? JSON.stringify({ refused: planned.code }) : full(planned.list);
    const actual = outcome(() => evaluator.apply(edit));
    const same = 'code' in planned ? JSON.parse(actual).refused === planned.code : actual === expected;
    if (!same) return { failure: { at: i, edit, differing: differing(actual, expected) }, seen, list: current, next };
    if ('code' in planned || JSON.parse(expected).refused !== undefined) {
      const code = 'code' in planned ? planned.code : JSON.parse(expected).refused;
      seen.refused[code] = (seen.refused[code] ?? 0) + 1;
      if (evaluator.result !== result || evaluator.assignments !== held) return { failure: { at: i, edit, differing: ['state after a refusal'] }, seen, list: current, next };
    }
    else {
      current = planned.list;
      seen.applied++;
      const answer = evaluator.result;
      if (answer.complete) {
        seen.complete++;
        if (answer.counts.units !== units) seen.unitsMoved++;
        units = answer.counts.units;
      }
      else seen.incomplete++;
      onApplied(current, answer);
    }
    // a preview of another edit, compared, and the state untouched
    const other = randomEdit(next, problem, current);
    const preview = plainApply(problem, current, other);
    const before = { result: evaluator.result, held: evaluator.assignments, text: JSON.stringify(evaluator.result) };
    onState('code' in preview ? current : preview.list);
    const previewed = outcome(() => evaluator.whatIf(other));
    const wanted = 'code' in preview ? JSON.stringify({ refused: preview.code }) : full(preview.list);
    const matches = 'code' in preview ? JSON.parse(previewed).refused === preview.code : previewed === wanted;
    if (!matches) return { failure: { at: i, preview: other, differing: differing(previewed, wanted) }, seen, list: current, next };
    if (evaluator.result !== before.result || evaluator.assignments !== before.held || JSON.stringify(evaluator.result) !== before.text)
      return { failure: { at: i, preview: other, differing: ['state after a preview'] }, seen, list: current, next };
    onState(current);
    seen.previews++;
  }
  return { failure: null, seen, list: current, next };
}
