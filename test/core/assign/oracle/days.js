//@ts-check
/**
 * @file The independent day oracle: the reference day rules' semantics
 * written a second time over raw problem JSON and the raw transition
 * table (`transitions.json`'s `zones`, passed in), by offset arithmetic
 * alone. It imports nothing: no engine module, no calendar, no reference
 * rule, no provider; a test holds that to the source text.
 *
 * A civil day D of a zone starts at the earliest instant at which the
 * wall clock (the instant plus the offset in force) crosses up to D's
 * midnight, and ends where D + 1 starts; an assignment's piece of D is
 * its task's interval inside that span. A resource with an assigned task
 * that has no zone has no days: each day rule reports one unknown
 * `no-zone` per such task, and none of its days is judged.
 *
 * - day-cap (hard): a day's summed pieces past dayCap; magnitude the excess.
 * - day-min (hard): a day's summed pieces short of minDay; magnitude the shortfall.
 * - consecutive-days (soft, weight 2): a day whose run of consecutive
 *   worked dates in its zone, ending at it, is longer than maxRun; magnitude 1.
 * - daily-rest (service): the longest stretch of the day's span free of
 *   the resource's pieces, short of minRest; magnitude the shortfall.
 */

const MINUTE = 60000;
const DAY = 86400000;
const HALF_HOUR = 30 * MINUTE;
export const LEVEL = /** @type {Record<string, 'hard' | 'service' | 'soft'>} */ ({
  'day-cap': 'hard', 'day-min': 'hard', 'consecutive-days': 'soft', 'daily-rest': 'service',
});
const WEIGHT = /** @type {Record<string, bigint>} */ ({ 'consecutive-days': 2n });
const RULES = Object.keys(LEVEL);

/**
 * @param {any} zones - transitions.json's `zones`
 * @param {any} problem - raw problem JSON
 * @param {{ task: string, slot: string, resource: string }[]} assignments
 */
export function oracleDays(zones, problem, assignments) {
  const { dayCap, minDay, maxRun, minRest } = problem.attributes;
  /** @type {Map<string, { initial: number, rows: { at: number, before: number, after: number }[] }>} */
  const parsed = new Map();
  const tableOf = (/** @type {string} */ zone) => {
    let table = parsed.get(zone);
    if (table === undefined) {
      table = { initial: zones[zone].initialOffset, rows: zones[zone].transitions.map((/** @type {any} */ row) => ({ at: Date.parse(row.at), before: row.before, after: row.after })) };
      parsed.set(zone, table);
    }
    return table;
  };
  const offsetAt = (/** @type {string} */ zone, /** @type {number} */ x) => {
    const table = tableOf(zone);
    let offset = table.initial;
    for (const row of table.rows) if (row.at <= x) offset = row.after;
    return offset;
  };
  const local = (/** @type {string} */ zone, /** @type {number} */ x) => x + offsetAt(zone, x) * MINUTE;
  /** @type {Map<string, number>} */
  const starts = new Map();
  const startOf = (/** @type {string} */ zone, /** @type {number} */ d) => {
    const key = `${zone}|${d}`;
    const known = starts.get(key);
    if (known !== undefined) return known;
    const table = tableOf(zone);
    const midnight = d * DAY;
    const offsets = new Set([table.initial, ...table.rows.flatMap((row) => [row.before, row.after])]);
    const found = [];
    for (const offset of offsets) {
      const x = midnight - offset * MINUTE;
      if (offsetAt(zone, x) === offset && local(zone, x - 1) < midnight) found.push(x);
    }
    for (const { at } of table.rows)
      if (local(zone, at - 1) < midnight && local(zone, at) >= midnight) found.push(at);
    const start = Math.min(...found);
    starts.set(key, start);
    return start;
  };
  const dateOf = (/** @type {number} */ d) => new Date(d * DAY).toISOString().slice(0, 10);
  const taskOf = (/** @type {string} */ id) => problem.tasks.find((/** @type {any} */ task) => task.id === id);
  const ids = (/** @type {string[]} */ list) => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  /** @type {string[]} */
  const matches = [];
  /** @type {string[]} */
  const unknowns = [];
  const totals = { hard: 0n, service: 0n, soft: 0n };
  const match = (/** @type {string} */ rule, /** @type {number} */ magnitude, /** @type {string} */ resource, /** @type {string[]} */ tasks, /** @type {string} */ zone, /** @type {string} */ date) => {
    matches.push(`${rule}|${magnitude}|${resource}|${ids(tasks)}|${zone}|${date}`);
    totals[LEVEL[rule]] -= BigInt(magnitude) * (WEIGHT[rule] ?? 1n);
  };

  for (const resource of problem.resources) {
    const mine = assignments.filter((assignment) => assignment.resource === resource.id);
    const zoneless = mine.filter((assignment) => taskOf(assignment.task).zone === undefined).map((assignment) => assignment.task);
    if (zoneless.length > 0) {
      for (const rule of RULES) for (const task of new Set(zoneless)) unknowns.push(`${rule}|no-zone|null|${resource.id}|${task}|${resource.id}//`);
      continue;
    }
    /** @type {Map<string, { zone: string, d: number, pieces: { start: number, end: number, task: string }[] }>} */
    const days = new Map();
    for (const assignment of mine) {
      const task = taskOf(assignment.task);
      const { start, end } = task.interval;
      for (let d = Math.floor(local(task.zone, start) / DAY) - 1; d <= Math.floor(local(task.zone, end) / DAY) + 1; d++) {
        const from = Math.max(start, startOf(task.zone, d));
        const to = Math.min(end, startOf(task.zone, d + 1));
        if (to <= from) continue;
        const key = `${task.zone}|${d}`;
        if (!days.has(key)) days.set(key, { zone: task.zone, d, pieces: [] });
        days.get(key)?.pieces.push({ start: from, end: to, task: task.id });
      }
    }
    for (const { zone, d, pieces } of days.values()) {
      const date = dateOf(d);
      const tasks = pieces.map((piece) => piece.task);
      const total = pieces.reduce((sum, piece) => sum + piece.end - piece.start, 0);
      if (total > dayCap) match('day-cap', total - dayCap, resource.id, tasks, zone, date);
      if (total < minDay) match('day-min', minDay - total, resource.id, tasks, zone, date);
      let run = 1;
      while (days.has(`${zone}|${d - run}`)) run++;
      if (run > maxRun) match('consecutive-days', 1, resource.id, [], zone, date);
      // the longest free stretch of the day, half hour by half hour: every
      // piece edge and every day edge of these zones and instances is on one
      const dayStart = startOf(zone, d);
      const dayEnd = startOf(zone, d + 1);
      if ((dayEnd - dayStart) % HALF_HOUR !== 0) throw new Error(`${zone} ${date} is not whole half hours`);
      let longest = 0;
      let free = 0;
      for (let at = dayStart; at < dayEnd; at += HALF_HOUR) {
        free = pieces.some((piece) => piece.start <= at && at < piece.end) ? 0 : free + HALF_HOUR;
        longest = Math.max(longest, free);
      }
      if (longest < minRest) match('daily-rest', minRest - longest, resource.id, [], zone, date);
    }
  }

  const hardUnknown = unknowns.some((line) => LEVEL[line.split('|')[0]] === 'hard');
  return {
    score: { hard: totals.hard.toString(), service: totals.service.toString(), soft: totals.soft.toString() },
    verdict: totals.hard < 0n ? 'infeasible-by-validation' : hardUnknown ? 'unknown' : 'feasible',
    matches: matches.sort(),
    unknowns: unknowns.sort(),
  };
}

/** @param {number} seed */
function lcg(seed) {
  let state = seed >>> 0;
  return (/** @type {number} */ n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

const ZONES = ['Europe/Amsterdam', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC'];

/**
 * A tiny day-scoped instance near one change of the clock: 2 or 3
 * resources and 3 or 4 one-slot tasks starting within 30 hours before to
 * 20 hours after `anchor`, 1 to 14 hours long on the half hour, mostly in
 * the changing zone `home`, sometimes another, sometimes none. The rest minimum is 11
 * hours or 26 (longer than any day, so every worked day reports its span).
 * @param {number} seed @param {number} anchor - epoch ms @param {string} home
 */
export function dayInstance(seed, anchor, home) {
  const next = lcg(seed * 7919 + 17);
  const resources = Array.from({ length: 2 + next(2) }, (_, i) => ({ id: `r${i}`, revision: 1 }));
  const tasks = Array.from({ length: 3 + next(2) }, (_, i) => {
    const start = anchor + (next(101) - 60) * HALF_HOUR;
    const roll = next(10);
    const zone = roll === 0 ? undefined : roll === 1 ? ZONES[next(ZONES.length)] : home;
    return { id: `t${i}`, revision: 1, interval: { start, end: start + (2 + next(27)) * HALF_HOUR }, demands: [{ slot: 's', count: 1 }], ...(zone === undefined ? {} : { zone }) };
  });
  return { revision: seed, resources, tasks, attributes: { dayCap: 8 * 3600000, minDay: 3 * 3600000, maxRun: 1, minRest: (next(2) === 0 ? 11 : 26) * 3600000 } };
}
