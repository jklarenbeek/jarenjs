# `@jarenjs/core/assign` — the assignment engine

`@jarenjs/core/assign` holds the mechanism of assignment problems (staff rosters, delivery slots, room bookings) but not their vocabulary. It provides:

- an assignment problem as plain, revisioned JSON with a schema twin;
- a rule contract through which the host supplies every constraint;
- exact, explained scoring;
- an evaluator that, after an edit or for a hypothetical one, re-evaluates only what the edit touches and answers the bytes full scoring answers;
- `solve`, which proposes assignments for a problem's open places or repairs its list against a baseline, re-validates the proposal, and says how much its status proves.

It knows nothing about rest periods, skills, opening hours or fairness. Those are rules the host writes against the contract, and **the engine ships none**: every rule in this document, and every rule its measurements (§11) are scored with, is an example written for it, not an export. What a rule means, its level and its weight are the host's decisions, and so is every policy value it reads.

> Every score is the exact sum of explained rule matches. Every result says how complete it is and what produced it. The engine never decides what a rule means.

```js
import {
  admitProblem, registerRules, scoreAssignment, compareScores, explain, createEvaluator, solve,
  ASSIGN_LIMITS, SOLVE_LIMITS, ASSIGN_CODES, AssignError,
} from '@jarenjs/core/assign';
```

Pure JSON goes in and out. The engine reads no clock, no locale and no storage, and no zone but the ones a task names, through the provider the host injects (§7). Scoring the same inputs gives the same bytes in every host time zone, for every key order of the inputs, and for every order of their resources, tasks, demands and assignments. Fact rows and arrays inside `attributes` are host data and keep the host's order.

A rule over one resource on one civil day of a zone (`resource-day`) gets its days through the separate subpath `@jarenjs/core/assign/days` and a zone provider the host injects (§7). An edit or a hypothetical one is answered by an evaluator (§8). Scoring answers how good a given assignment list is; `solve` looks for a better one (§9).

## 1. The problem

A problem has these members:

- `revision`, plus `resources` and `tasks` (both required);
- optionally `facts`, `assignments`, a `baseline` and the host's own `attributes`.

Every object carries a `revision`: the problem, each resource, each task, each fact table and the baseline. A revision is a non-empty string or a whole number from 0.

| Member | Form | Notes |
|---|---|---|
| `resources[]` | `{ id, revision, attributes? }` | whoever or whatever fills a slot |
| `tasks[]` | `{ id, revision, interval: { start, end }, demands: [{ slot, count, attributes? }], attributes?, zone? }` | the interval is half-open `[start, end)` in safe integers (epoch milliseconds by convention), start before end; `count` resources may fill a slot; `zone` (a non-empty zone name) is read only by `resource-day` rules (§7) |
| `facts` | `{ <name>: { revision, rows: [...] } }` | named host tables (availability spans, bookings, preferences); only rules read them |
| `assignments[]` | `{ task, slot, resource, lock?: 'hard' \| 'soft' }` | the stored assignment; locks are kept as data and scoring does not read them |
| `baseline` | `{ revision, assignments: [...] }` | a snapshot to compare against |

`attributes` (on the problem, a resource, a task or a demand) and fact rows are host data: any JSON. The engine copies them, keeps their array order, and never reads them. Rules read them.

`admitProblem(problem)` checks a problem against `@jarenjs/core/schemas/assign/problem.schema.json` (`$id` `https://jarenjs.dev/schemas/jaren-core/assign/problem/0.1`). It also makes the checks a schema cannot state:

- ids are unique;
- every reference resolves;
- no `(task, slot, resource)` repeats, and no slot is filled past its count;
- every start is before its end;
- host data is JSON no deeper than 64 levels.

It answers the problem as frozen canonical JSON:

- resources and tasks sorted by id;
- demands sorted by slot;
- assignments sorted by task, slot and resource;
- every object's keys written in code-unit order (JavaScript still lists integer-like keys such as `9` and `10` first, in numeric order);
- `facts` and `assignments` default to empty.

Two problems that differ only in key order, or in the order of their resources, tasks, demands and assignments, admit to the same bytes. Admitting the answer again answers it unchanged. Every refusal is an `AssignError` with its own code (§9) and the JSON Pointer at fault as `docPath`.

Ids sort by UTF-16 code unit: `r10` before `r9`, `B` before `b`, and an astral character before `U+FFFF`. They never sort by number, locale or insertion order. An id is data: `__proto__` and `constructor` are ordinary ids.

```js
import { admitProblem } from '@jarenjs/core/assign';

const HOUR = 3600000;
export const admitted = admitProblem({
  revision: 'week-12',
  resources: [
    { id: 'nina', revision: 3, attributes: { skills: ['first-aid'] } },
    { id: 'ari', revision: 1 },
  ],
  tasks: [
    { id: 'mon-late', revision: 1, interval: { start: 7.5 * HOUR, end: 15 * HOUR }, demands: [{ slot: 'crew', count: 1 }] },
    { id: 'mon-early', revision: 1, interval: { start: 0, end: 8 * HOUR },
      demands: [{ slot: 'lead', count: 1, attributes: { requires: ['first-aid'] } }, { slot: 'crew', count: 2 }] },
  ],
  assignments: [{ task: 'mon-early', slot: 'lead', resource: 'nina', lock: 'hard' }],
});
```

```json
{
  "assignments": [
    {
      "lock": "hard",
      "resource": "nina",
      "slot": "lead",
      "task": "mon-early"
    }
  ],
  "facts": {},
  "resources": [
    {
      "id": "ari",
      "revision": 1
    },
    {
      "attributes": {
        "skills": [
          "first-aid"
        ]
      },
      "id": "nina",
      "revision": 3
    }
  ],
  "revision": "week-12",
  "tasks": [
    {
      "demands": [
        {
          "count": 2,
          "slot": "crew"
        },
        {
          "attributes": {
            "requires": [
              "first-aid"
            ]
          },
          "count": 1,
          "slot": "lead"
        }
      ],
      "id": "mon-early",
      "interval": {
        "end": 28800000,
        "start": 0
      },
      "revision": 1
    },
    {
      "demands": [
        {
          "count": 1,
          "slot": "crew"
        }
      ],
      "id": "mon-late",
      "interval": {
        "end": 54000000,
        "start": 27000000
      },
      "revision": 1
    }
  ]
}
```

## 2. Rules

A rule is a plain object with one pure, synchronous function:

| Member | Form | Default |
|---|---|---|
| `id` | non-empty string, unique in the set | — |
| `version` | non-empty string or whole number from 0 | — |
| `level` | `'hard'`, `'service'` or `'soft'` | — |
| `scope` | `'resource'` (once per resource), `'resource-day'` (once per resource and civil day, §7), `'task'` (once per task) or `'global'` (once) | — |
| `evaluate(view, unit)` | answers `{ matches?, unknowns? }` | — |
| `weight` | whole number from 1: a match scores minus magnitude times weight | `1` |
| `measure` | the unit a magnitude counts in, such as `ms` or `count` | `'count'` |
| `reads` | `{ facts?: [names] }`: the fact tables the rule reads | `{ facts: [] }` |

`registerRules(rules)` checks every declaration and answers a frozen rule set `{ hash, rules }`, sorted by id. The hash is a fingerprint of the declarations (id, version, level, scope, weight, measure, reads), so the same rules in any order agree. It does not cover the functions: a rule whose behaviour changes must change its `version`. The set's identity is its rule list, which every result carries: the hash is a short fingerprint, not a digest that can never collide.

`unit` is `{ scope, id }`: the resource's or task's id, or `null` for a global rule. A `resource-day` unit also has `zone` and `date` (§7). `view` is frozen and answers only frozen data:

| Call | Answers |
|---|---|
| `resources()`, `tasks()` | every resource or task, by id |
| `resource(id)`, `task(id)`, `demand(task, slot)` | one record, or `undefined` |
| `assignments()` | every scored assignment, by task, slot and resource |
| `assignmentsOf(resource)` | one resource's assignments in task time order (start, end, task id, slot) |
| `assignmentsFor(task)` | one task's assignments, by slot and resource |
| `tasksOverlapping(start, end)` | the tasks overlapping `[start, end)`, in time order |
| `fact(name)`, `factRows(name, member, value)` | a declared fact table, or its rows whose `member` is `value` (indexed on first use, in the table's order) |
| `stored()`, `baseline()`, `attributes()` | the problem's own assignments with their locks, its baseline (or null), its attributes (or null) |

A rule that reads a fact it does not declare is refused (`JN0018`). A declared fact missing from the problem means the rule is **not evaluated**. It reports one unknown, `reason: 'missing-fact'`, naming the rule and the fact. A rule that cannot see what it needs is never read as satisfied.

A match is `{ magnitude, messageId, subjects?, intervals?, params? }`:

- `magnitude` is a whole number from 1, a safe integer or a bigint, in the rule's measure;
- `messageId` and `params` (JSON) are for the host to localize: the engine writes no prose;
- `subjects` is `{ resources?, tasks? }`, ids the problem holds;
- `intervals` are `{ start, end }` like a task's.

An unknown is `{ reason, fact?, subjects? }`. It says the rule could not decide whether more matches exist, and it never takes back a match the rule reported beside it: so a hard match beside a hard unknown is still `infeasible-by-validation` (§3), and a search reads an unknown as something that can only lower a score (§9). An answer of any other form is refused by name (`JN0017`), and so is a promise. What a rule throws is refused as `JN0016`, with the throw as `cause`.

## 3. Scoring

`scoreAssignment(problem, ruleSet, assignments, { limits })` scores one assignment list, checked as the problem's assignments are. It runs every rule over every unit of its scope: rules in id order, units in id order. Each unit's matches and unknowns are put in a canonical order, so the order a rule emits them in does not show.

A complete result is:

```text
{ complete: true, verdict, score: { hard, service, soft, encoding }, matches, unknowns, counts, provenance }
```

- **The score** is lexicographic: hard, then service, then soft. 0 is best, and every match lowers its level by `magnitude × weight`.
- **The matches** carry the rule, version, level, measure, unit, magnitude and score. Re-summed per level, they equal the score exactly; the engine checks this before it answers.
- **The verdict:**
  - `infeasible-by-validation` when any hard match exists: a validated violation, not a search proof;
  - else `unknown` when a hard rule reported an unknown or could not run;
  - else `feasible`.

  Service and soft unknowns are reported and do not block.
- **`counts`** are `{ rules, units, matches, unknowns, work }`.
- **`provenance`** binds what produced the result:
  - the problem's revision;
  - each fact table's revision;
  - the baseline's revision;
  - the rule set's hash, and every rule's id and version;
  - a fingerprint of the scored assignments;
  - `algorithm: 'full'`.

```js
import { registerRules, scoreAssignment } from '@jarenjs/core/assign';

const HOUR = 3600000;
const problem = {
  revision: 'week-12',
  resources: [{ id: 'nina', revision: 3 }, { id: 'ari', revision: 1 }],
  tasks: [
    { id: 'mon-early', revision: 1, interval: { start: 0, end: 8 * HOUR }, demands: [{ slot: 'crew', count: 2 }] },
    { id: 'mon-late', revision: 1, interval: { start: 7.5 * HOUR, end: 15 * HOUR }, demands: [{ slot: 'crew', count: 1 }] },
  ],
};

// Two host rules. The engine ships none: these are the host's policy.
const noOverlap = {
  id: 'no-overlap', version: 1, level: 'hard', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const mine = view.assignmentsOf(unit.id); // in task time order
    const matches = [];
    for (let i = 0; i + 1 < mine.length; i++) {
      const a = view.task(mine[i].task).interval;
      const b = view.task(mine[i + 1].task).interval;
      if (b.start < a.end)
        matches.push({ magnitude: Math.min(a.end, b.end) - b.start, messageId: 'overlap',
          subjects: { resources: [unit.id], tasks: [mine[i].task, mine[i + 1].task] } });
    }
    return { matches };
  },
};
const coverage = {
  id: 'coverage', version: 1, level: 'service', scope: 'task', weight: 10,
  evaluate(view, unit) {
    const task = view.task(unit.id);
    const filled = view.assignmentsFor(unit.id).length;
    const wanted = task.demands.reduce((sum, demand) => sum + demand.count, 0);
    return { matches: filled < wanted
      ? [{ magnitude: wanted - filled, messageId: 'open-slots', params: { open: wanted - filled }, subjects: { tasks: [unit.id] } }]
      : [] };
  },
};

const rules = registerRules([noOverlap, coverage]);
const result = scoreAssignment(problem, rules, [
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-late', slot: 'crew', resource: 'ari' },
]);
export const report = {
  complete: result.complete,
  verdict: result.verdict,
  score: result.score,
  matches: result.matches.map((m) => `${m.rule} ${m.subjects.resources.concat(m.subjects.tasks).join(',')}: ${m.magnitude} ${m.measure} -> ${m.score}`),
};
```

```json
{
  "complete": true,
  "verdict": "infeasible-by-validation",
  "score": {
    "encoding": {
      "hard": "number",
      "service": "number",
      "soft": "number"
    },
    "hard": -1800000,
    "service": -10,
    "soft": 0
  },
  "matches": [
    "coverage mon-early: 1 count -> -10",
    "no-overlap ari,mon-early,mon-late: 1800000 ms -> -1800000"
  ]
}
```

```js
import { registerRules, scoreAssignment } from '@jarenjs/core/assign';

const problem = {
  revision: 1,
  resources: [{ id: 'room-a', revision: 1 }],
  tasks: [{ id: 'review', revision: 1, interval: { start: 0, end: 3600000 }, demands: [{ slot: 'room', count: 1 }] }],
};
const free = {
  id: 'room-free', version: 1, level: 'hard', scope: 'resource', reads: { facts: ['bookings'] },
  evaluate(view, unit) {
    const booked = view.factRows('bookings', 'room', unit.id);
    const matches = [];
    for (const assignment of view.assignmentsOf(unit.id)) {
      const { start, end } = view.task(assignment.task).interval;
      if (booked.some((row) => row.start < end && row.end > start))
        matches.push({ magnitude: 1, messageId: 'booked', subjects: { resources: [unit.id], tasks: [assignment.task] } });
    }
    return { matches };
  },
};

const result = scoreAssignment(problem, registerRules([free]), [{ task: 'review', slot: 'room', resource: 'room-a' }]);
export const missing = { verdict: result.verdict, hard: result.score.hard, unknowns: result.unknowns };
```

```json
{
  "verdict": "unknown",
  "hard": 0,
  "unknowns": [
    {
      "fact": "bookings",
      "level": "hard",
      "reason": "missing-fact",
      "rule": "room-free",
      "subjects": {
        "resources": [],
        "tasks": []
      },
      "unit": null,
      "version": 1
    }
  ]
}
```

## 4. Exact arithmetic

Scores are integers in the rules' declared measures, summed exactly as bigints. A level whose final sum is past `Number.MAX_SAFE_INTEGER` in size is answered as an exact decimal string, and the score's `encoding` says so for that level. A match whose magnitude or score is past it is decimal in both, with `encoding: 'decimal'`. Below it, plain numbers are used.

The encoding is decided from the final sum alone, never from a running total, so it does not depend on evaluation order. Nothing is ever rounded.

`compareScores(a, b)` compares exactly, decimal levels included. It answers `1` when `a` is better, `-1` when `b` is, and `0` when they are equal, so `scores.sort(compareScores)` puts the worst first.

```js
import { registerRules, scoreAssignment } from '@jarenjs/core/assign';

const problem = {
  revision: 1,
  resources: [{ id: 'van-1', revision: 1 }],
  tasks: [{ id: 'drop-17', revision: 1, interval: { start: 0, end: 900000 }, demands: [{ slot: 'van', count: 1 }] }],
};
// A soft cost of 2^52 per unit: three units are past Number.MAX_SAFE_INTEGER.
const costly = {
  id: 'fuel', version: 1, level: 'soft', scope: 'global', weight: 2 ** 52,
  evaluate: () => ({ matches: [{ magnitude: 3, messageId: 'fuel' }] }),
};
const result = scoreAssignment(problem, registerRules([costly]), []);
export const exact = { score: result.score, match: [result.matches[0].encoding, result.matches[0].magnitude, result.matches[0].score] };
```

```json
{
  "score": {
    "encoding": {
      "hard": "number",
      "service": "number",
      "soft": "decimal"
    },
    "hard": 0,
    "service": 0,
    "soft": "-13510798882111488"
  },
  "match": [
    "decimal",
    "3",
    "-13510798882111488"
  ]
}
```

## 5. Limits and incomplete results

`ASSIGN_LIMITS` is `{ maxUnits: 1000000, maxMatches: 1000000, maxWork: 100000000 }`, and `options.limits` overrides any of them with a whole number from 0. They count:

- `maxUnits`: rule evaluations;
- `maxMatches`: matches collected;
- `maxWork`: one per view call, plus every row a view answers, every match and every unknown. It is a deterministic count, never a clock.

Past a limit the result is typed incomplete:

```text
{ complete: false, verdict: 'unknown', stoppedAt: { limit, rule, unit }, counts, provenance }
```

It has no score, no matches and no unknowns: a partial total is never answered. A rule that catches the stop and returns normally is still stopped. `unit` is the unit being evaluated, or `null` when the `missing-fact` unknowns of a rule that never ran (§2) were the work that passed `maxWork`.

This is the one shape of a bounded answer across `@jarenjs/core`: every bounded answer of `@jarenjs/core/calendar` (a recurrence or series expansion, an availability evaluation and each of its layers, a slot search, a compiled zone) also carries `complete` and, when it is false, `stoppedAt: { limit }` (an evaluation's adds the `layer` that stopped), beside its older `status` and `limit` ([CALENDAR.md](CALENDAR.md)).

## 6. Explanations

`explain(result, { group })` groups a complete result's matches and unknowns for a report. Each group carries the exact score of its matches. Groups are sorted by key, and within a group entries keep the result's order.

- `group: 'rule'` (the default) or `'level'`: each entry falls in one group, so the groups sum to the total.
- `group: 'resource'` or `'task'`: an entry falls in every group its subjects name, so groups can overlap. An entry naming none is `ungrouped`.

An incomplete result has no total to explain (`JN0020`).

```js
import { registerRules, scoreAssignment, explain, compareScores } from '@jarenjs/core/assign';

const problem = {
  revision: 1,
  resources: [{ id: 'nina', revision: 1 }, { id: 'ari', revision: 1 }],
  tasks: ['t1', 't2', 't3'].map((id, i) => ({ id, revision: 1, interval: { start: i * 10, end: i * 10 + 10 }, demands: [{ slot: 'crew', count: 1 }] })),
};
const load = {
  id: 'max-two', version: 1, level: 'soft', scope: 'resource',
  evaluate: (view, unit) => {
    const count = view.assignmentsOf(unit.id).length;
    return { matches: count > 2 ? [{ magnitude: count - 2, messageId: 'over-two', subjects: { resources: [unit.id] } }] : [] };
  },
};
const rules = registerRules([load]);
const all = problem.tasks.map((task) => ({ task: task.id, slot: 'crew', resource: 'nina' }));
const spread = [{ ...all[0], resource: 'ari' }, all[1], all[2]];

const stopped = scoreAssignment(problem, rules, all, { limits: { maxUnits: 1 } });
const scored = scoreAssignment(problem, rules, all);
export const outcome = {
  stopped: { complete: stopped.complete, verdict: stopped.verdict, stoppedAt: stopped.stoppedAt, hasScore: 'score' in stopped },
  byResource: explain(scored, { group: 'resource' }).groups.map((group) => [group.key, group.score.soft]),
  spreadIsBetter: compareScores(scoreAssignment(problem, rules, spread).score, scored.score),
};
```

```json
{
  "stopped": {
    "complete": false,
    "verdict": "unknown",
    "stoppedAt": {
      "limit": "maxUnits",
      "rule": "max-two",
      "unit": {
        "id": "nina",
        "scope": "resource"
      }
    },
    "hasScore": false
  },
  "byResource": [
    [
      "nina",
      -1
    ]
  ],
  "spreadIsBetter": 1
}
```

## 7. Civil days

A rule of scope `resource-day` judges one resource on one civil day: consecutive days, a total per day, the rest a day leaves. Its unit is `{ scope: 'resource-day', id, zone, date }`, and the engine evaluates it once per resource and civil day of a zone that resource works in: by resource id, then zone, then date.

A day is a civil day of the task's own `zone` (an optional task member), cut by `@jarenjs/core/calendar`'s `splitByCivilDay`. A day across a change of the clock is 23 or 25 hours long (23.5 or 24.5 across a half-hour change), and a skipped day has no instant, so it has no piece. A shift that ends exactly at local midnight has no piece of the next day. The same date in two zones is two days, never merged.

The zone data is the host's. Pass `civilDays({ zoneProvider, policy })`, from its own subpath, as `options.days`:

```js
import { civilDays } from '@jarenjs/core/assign/days';
```

- `zoneProvider` has `candidates` and `toParts`, as `@jarenjs/locales/intl-zones`'s `createIntlZoneProvider` answers, or a fixed table of your own.
- `policy` matters only where a change carries the clock back across midnight, so a day starts twice: `rfc5545` takes the earlier start, `later` the later, and `reject` refuses the scoring (`JN0022`).
- The provider's identity (`{ name, revision }`, else `unrecorded`) and the policy are the result's `provenance.days`. Day-scoped answers are the same bytes on every host for one provider identity and policy. With the host's own `Intl` data they can differ where that data differs.
- The base `@jarenjs/core/assign` carries no calendar code. A scoring without a day rule never asks the seam, and `provenance.days` is there only when `days` was given.

The view answers a day rule two more calls. Only a `resource-day` rule may make them (`JN0021`):

| Call | Answers |
|---|---|
| `daysOf(resource)` | the resource's days, by zone and then date |
| `day(resource, zone, date)` | one day, or `null` when the resource works no part of it |

A day is `{ date, end, pieces, start, zone }`. `start` and `end` are the day's whole span, the next day's first instant being its end. `pieces` are `{ end, slot, start, task }`, the part of each assignment's task inside the day, in time order.

**A task without a zone is unknown, never guessed.** The engine supplies no zone, UTC included. A resource with an assigned task that has no zone has days nobody can tell:

- none of its days is evaluated;
- each day rule reports one unknown `reason: 'no-zone'` per such task, at the unit `{ scope: 'resource-day', id, zone: null, date: null }`;
- a rule that reads that resource's days from another unit makes that unit `no-zone` too, whatever it answers.

A floor rule (at least so many hours a day) judged on the zoned tasks alone would report a violation that may not exist, so a hard day rule's `no-zone` makes the verdict `unknown`.

```js
import { registerRules, scoreAssignment } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const HOUR = 3_600_000;
const days = civilDays({ zoneProvider: createIntlZoneProvider({ revision: '2026a' }), policy: 'rfc5545' });

const rules = registerRules([{
  id: 'eight-hours-a-day', version: 1, level: 'hard', scope: 'resource-day', measure: 'ms',
  evaluate(view, unit) {
    const day = view.day(unit.id, unit.zone, unit.date);
    let worked = 0;
    for (const piece of day.pieces) worked += piece.end - piece.start;
    if (worked <= 8 * HOUR) return {};
    return { matches: [{
      magnitude: worked - 8 * HOUR, messageId: 'over-eight-hours',
      subjects: { resources: [unit.id] }, params: { dayHours: (day.end - day.start) / HOUR },
    }] };
  },
}]);

const shift = (id, start, end, zone) => ({
  id, revision: 1, interval: { start: Date.parse(start), end: Date.parse(end) },
  demands: [{ slot: 'crew', count: 1 }], ...(zone ? { zone } : {}),
});
const problem = {
  revision: 1,
  resources: [{ id: 'ari', revision: 1 }, { id: 'nina', revision: 1 }],
  tasks: [
    // 22:00 to 08:00 in Amsterdam, across the night the clocks go back
    shift('night', '2026-10-24T20:00:00Z', '2026-10-25T07:00:00Z', 'Europe/Amsterdam'),
    // no zone: nobody can tell which day it is on
    shift('remote', '2026-10-25T08:00:00Z', '2026-10-25T18:00:00Z'),
  ],
};

const result = scoreAssignment(problem, rules, [
  { task: 'night', slot: 'crew', resource: 'ari' },
  { task: 'remote', slot: 'crew', resource: 'nina' },
], { days });

export const answer = {
  verdict: result.verdict,
  matches: result.matches.map(({ unit, magnitude, params }) => ({ unit, hours: magnitude / HOUR, params })),
  unknowns: result.unknowns.map(({ reason, subjects, unit }) => ({ reason, subjects, unit })),
  days: result.provenance.days,
};
```

```json
{
  "verdict": "infeasible-by-validation",
  "matches": [
    {
      "unit": {
        "date": "2026-10-25",
        "id": "ari",
        "scope": "resource-day",
        "zone": "Europe/Amsterdam"
      },
      "hours": 1,
      "params": {
        "dayHours": 25
      }
    }
  ],
  "unknowns": [
    {
      "reason": "no-zone",
      "subjects": {
        "resources": [
          "nina"
        ],
        "tasks": [
          "remote"
        ]
      },
      "unit": {
        "date": null,
        "id": "nina",
        "scope": "resource-day",
        "zone": null
      }
    }
  ],
  "days": {
    "policy": "rfc5545",
    "provider": {
      "name": "intl",
      "revision": "2026a"
    }
  }
}
```

The day table counts toward `maxWork`: one for each task split, each piece and each day span. Each day read is charged like any view call, and day units count toward `maxUnits`. A task that cannot be split is refused (`JN0022`, with the calendar's refusal as `cause`): a zone the provider does not know, a provider that fails, or a task spanning more than 36600 civil days. Its `docPath` is `/tasks/<i>/zone`, where `i` is the task's place in the admitted problem (tasks sorted by id).

## 8. Incremental and what-if evaluation

`createEvaluator(problem, ruleSet, assignments, { limits?, days? })` scores once and keeps every rule's answer for every unit. It takes the arguments and options `scoreAssignment` takes, and refuses what it refuses.

- `apply(edit)` makes the edit and answers the new result.
- `whatIf(edit)` answers the result the edit would have, and changes nothing.
- `result` is the current answer, and `assignments` the current list, admitted.
- `counts` says what the evaluator did, and `close()` drops what it keeps. After `close()`, every edit is refused, while `result` and `assignments` still answer.

Each answer is the bytes `scoreAssignment` answers for the same problem, rule set, assignments and options. That covers the score, the matches and unknowns in their order, `counts`, `provenance` and the refusals. `provenance.algorithm` stays `'full'`: it names what the answer is, and the evaluator's own `counts` say how it was reached.

```js
import { createEvaluator, registerRules, scoreAssignment } from '@jarenjs/core/assign';

const problem = {
  revision: 'week-12',
  resources: [{ id: 'ari', revision: 1 }, { id: 'nina', revision: 1 }, { id: 'sam', revision: 1 }],
  tasks: [
    { id: 'mon-early', revision: 1, interval: { start: 0, end: 480 }, demands: [{ slot: 'crew', count: 1 }] },
    { id: 'mon-late', revision: 1, interval: { start: 450, end: 900 }, demands: [{ slot: 'crew', count: 1 }] },
  ],
};
// one resource's overlapping tasks: it reads only its own row
const noOverlap = {
  id: 'no-overlap', version: 1, level: 'hard', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const intervals = view.assignmentsOf(unit.id).map((a) => view.task(a.task).interval);
    const matches = [];
    for (let i = 1; i < intervals.length; i++) {
      const overlap = intervals[i - 1].end - intervals[i].start;
      if (overlap > 0) matches.push({ magnitude: overlap, messageId: 'overlap', subjects: { resources: [unit.id] } });
    }
    return { matches };
  },
};
const rules = registerRules([noOverlap]);
const evaluator = createEvaluator(problem, rules, [
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-late', slot: 'crew', resource: 'ari' },
]);
const move = { op: 'move', task: 'mon-late', slot: 'crew', from: 'ari', to: 'nina' };
const preview = evaluator.whatIf(move);
const kept = evaluator.result.score.hard;
const applied = evaluator.apply(move);
const full = scoreAssignment(problem, rules, evaluator.assignments);

export const edits = {
  before: kept,
  preview: preview.score.hard,
  applied: applied.score.hard,
  sameBytes: JSON.stringify(applied) === JSON.stringify(full),
  counts: evaluator.counts,
};
```

```json
{
  "before": -30,
  "preview": 0,
  "applied": 0,
  "sameBytes": true,
  "counts": {
    "edits": 1,
    "previews": 1,
    "evaluated": 7,
    "reused": 2,
    "fullFallbacks": 0,
    "fullScorings": 1
  }
}
```

### Edits

| Edit | What it does |
|---|---|
| `{ op: 'assign', task, slot, resource, lock? }` | adds an assignment |
| `{ op: 'unassign', task, slot, resource }` | removes one |
| `{ op: 'move', task, slot, from, to }` | hands one assignment, its lock with it, to another resource |
| `{ op: 'swap', a, b }` | exchanges the resources of two assignments, each `{ task, slot, resource }`; each keeps its lock |
| `{ op: 'revise', problem?, ruleSet?, days?, assignments? }` | replaces any of the four, and every rule is evaluated again |

An edit the list cannot take is refused and changes nothing:

- `JN0023`: an edit out of form, or one naming an assignment the list does not hold;
- `JN0002` or `JN0007`: an id;
- `JN0008`: an assignment held twice, or a slot past its count.

Every id is checked before the list is. An edit that changes nothing, such as a move to the resource that holds the assignment, answers the current result.

### What an edit evaluates again

A unit's *row* is one of two things:

- for a `task` unit, its task's assignments;
- for a `resource` or `resource-day` unit, its resource's assignments and that resource's days.

An edit evaluates again the units of the rows it touches, and every `global` rule. Every other answer is kept. Nothing else a view answers changes for the evaluator's life: resources, tasks, demands, facts, stored assignments and the baseline. Fact indexes and civil-day splits are kept too, and are counted in `work` as a scoring counts them.

The scope is the declaration, and the view checks it. Suppose one of a rule's units reads assignments outside its row: another task's, another resource's or its days, or `assignments()`. From then on, that rule is evaluated over every unit of its scope on every edit, and `counts.fullFallbacks` counts each such answer, so the answers stay exact. A rule must be pure. The evaluator cannot see host state that a rule reads past the view, through a closure.

### When it scores in full

`counts.fullScorings` counts the answers for which every rule was evaluated over every unit:

- the first answer;
- each `revise` naming an object other than the one held. This goes by identity, not revision: a rule set's hash covers its declarations, not its `evaluate`, and a host may reuse a revision;
- each answer past a limit, which is full scoring's incomplete result and never a partial total;
- each answer while a rule throws or answers out of contract, or while the seam refuses a task. That answer is full scoring's own answer or refusal. A refused `apply` changes nothing.

| Count | Counts |
|---|---|
| `edits`, `previews` | the answers of `apply` and of `whatIf` |
| `evaluated` | rule evaluations over one unit |
| `reused` | unit answers kept from an earlier answer |
| `fullFallbacks` | answers in which a rule was evaluated over every unit because it read outside its row |
| `fullScorings` | answers in which every rule was evaluated over every unit |

## 9. Search

`solve(problem, ruleSet, { strategy, seed?, budgets?, rank?, signal?, limits?, days? })` proposes assignments for a problem's open places, or repairs its list (`local`). It scores with the rules the host gave it, through an evaluator (§8), and re-validates what it proposes with a fresh full scoring.

**The space.** An open place is room left in a demand slot past the assignments the problem already holds. For `exhaustive`, `construct` and `auto`, those assignments stay as they are: these strategies fill, and only `local` repairs (below). A *candidate* is the problem's assignments plus, for each slot, a set of resources not already in it no larger than its room. A place may stay open, because the model never requires a slot to be filled: a rule that wants it filled says so. The model has no eligibility either. Every resource is a candidate for every place, and the rules judge it.

The answer is frozen JSON:

```text
{ status, best, added, removed?, score, churn?, bound?, cancelled?, counts, provenance }
```

- `best` is the whole proposed list (sorted as scoring sorts it), `added` the assignments it holds that the problem's list does not, and, for `local` and `auto`, `removed` the problem's assignments it no longer holds. The host applies `best`.
- `score` is `scoreAssignment(problem, ruleSet, best, { limits, days })`, made again after the search. The search's own scoring of `best` must be the same bytes; when it is not, a rule read state past its view, and the solve is refused (`JN0026`).
- `bound`, when present, is a score no candidate of the space can beat.
- `churn`, for `local` and `auto` on a problem with a `baseline`, is how `best` differs from the baseline (below). Without a baseline it is absent, not zero. It is never part of `score`.
- `counts` is `{ nodes, moves, ranked, undecided, space }`, defined under the strategies below; `local` and `auto` add `restarts` and `editWork`. `construct`, `local` and `auto` add `fullFallbacks`, the evaluator's count (§8): one for each rule that read outside its row, in each edit or preview the search asked for, so a host sees why its moves cost full re-evaluations. A search whose rules keep to their rows counts `0`.
- `provenance` is the scoring provenance of the problem as given (§3), which carries the baseline's revision, with the strategy that ran as `algorithm`, and `budgets`, `limits`, `rank` (whether a hook ordered the candidates) and `seed` (null for none). For `local` and `auto` it also names the `strategy` asked for, and `budgets` holds all four budgets.

A proposal never commits itself. Nothing is written, and the host rechecks revisions and authority before it applies `best`.

```js
import { registerRules, solve } from '@jarenjs/core/assign';

const problem = {
  revision: 'week-12',
  resources: [{ id: 'ari', revision: 1 }, { id: 'nina', revision: 1 }, { id: 'sam', revision: 1 }],
  tasks: [
    { id: 'mon-early', revision: 1, interval: { start: 0, end: 480 }, demands: [{ slot: 'crew', count: 2 }] },
    { id: 'mon-late', revision: 1, interval: { start: 450, end: 900 }, demands: [{ slot: 'crew', count: 1 }] },
  ],
  // kept by every candidate: exhaustive and construct fill, they do not repair
  assignments: [{ task: 'mon-early', slot: 'crew', resource: 'nina' }],
};
// one resource's overlapping tasks
const noOverlap = {
  id: 'no-overlap', version: 1, level: 'hard', scope: 'resource', measure: 'ms',
  evaluate(view, unit) {
    const intervals = view.assignmentsOf(unit.id).map((a) => view.task(a.task).interval);
    const matches = [];
    for (let i = 1; i < intervals.length; i++) {
      const overlap = intervals[i - 1].end - intervals[i].start;
      if (overlap > 0) matches.push({ magnitude: overlap, messageId: 'overlap', subjects: { resources: [unit.id] } });
    }
    return { matches };
  },
};
// each place a task leaves open: the model allows it, this rule does not like it
const covered = {
  id: 'covered', version: 1, level: 'service', scope: 'task',
  evaluate(view, unit) {
    const want = view.task(unit.id).demands.reduce((sum, demand) => sum + demand.count, 0);
    const open = want - view.assignmentsFor(unit.id).length;
    return open > 0 ? { matches: [{ magnitude: open, messageId: 'open', subjects: { tasks: [unit.id] } }] } : {};
  },
};
const rules = registerRules([noOverlap, covered]);
const proved = solve(problem, rules, { strategy: 'exhaustive' });
const built = solve(problem, rules, { strategy: 'construct', budgets: { maxMoves: 4 } });
const places = (list) => list.map((a) => `${a.task} ${a.resource}`);

export const proposals = {
  exhaustive: { status: proved.status, added: places(proved.added), service: proved.score.score.service, bound: proved.bound.service, counts: proved.counts },
  construct: { status: built.status, added: places(built.added), service: built.score.score.service, counts: built.counts },
};
```

```json
{
  "exhaustive": {
    "status": "optimal",
    "added": [
      "mon-early ari",
      "mon-late sam"
    ],
    "service": 0,
    "bound": 0,
    "counts": {
      "nodes": 12,
      "moves": 21,
      "ranked": 0,
      "undecided": 0,
      "space": 12
    }
  },
  "construct": {
    "status": "limit",
    "added": [
      "mon-early ari"
    ],
    "service": -1,
    "counts": {
      "nodes": 2,
      "moves": 4,
      "ranked": 0,
      "undecided": 0,
      "space": null,
      "fullFallbacks": 0
    }
  }
}
```

The budget of 4 moves stops `construct` while it previews the second place, so it answers `limit` with the one place it filled.

### Status

| Status | When |
|---|---|
| `optimal` | `exhaustive` scored every candidate, and the best feasible one is no worse than any candidate could be, whatever its unknowns would decide |
| `infeasible` | `exhaustive` scored every candidate, and every one has a hard match |
| `feasible` | the best candidate is fully validated feasible (verdict `feasible`), and nothing more is proved |
| `limit` | a budget ran out, or the signal aborted (`cancelled: true`); `best` is the best candidate held, and there is no bound |
| `unknown` | no candidate is validated feasible and nothing is proved: a hard rule could not decide, a scoring stopped at a limit, or (for `construct`, `local` and `auto`'s heuristic path) the proposal has a hard match |

`optimal` and `infeasible` come only from a complete `exhaustive` search, so `local` and `auto`'s `construct` path answer `feasible` (a validated feasible proposal at a local optimum, or after the restarts asked for) or `unknown`. A cancelled or budget-exhausted search is `limit`, never `infeasible`, even when the problem has no feasible list.

**How the proof reads unknowns.** An unknown only hides matches: a rule that could decide might lower a score, never raise it. So a candidate scores at best what its scoring answers, and at worst that score with every level from the first level an unknown is reported at unbounded below. `optimal` needs the best feasible candidate's worst score to be no less than every other candidate's best score, apart from candidates with a hard match. A candidate of verdict `unknown` that could beat it, or a scoring that stopped at a limit, blocks the proof. The answer is then `feasible` if a validated feasible candidate exists, else `unknown`, and `counts.undecided` says how many candidates were undecided. The bound is the best score any candidate answered, given only when every scoring was complete.

### `exhaustive`

`exhaustive` visits every candidate once, each reached by one evaluator edit from its parent, so each is scored with the evaluator's exact answer. The order is fixed: slots in task and slot order, each slot's resources in id order, and a set before the sets that extend it. The best candidate is the first of:

1. the best class: verdict `feasible`, then `unknown`, then `infeasible-by-validation` (an incomplete scoring is never best);
2. then the best score;
3. then the best worst score;
4. then the first one visited.

It takes no `seed` and no `rank`, and refuses both (`JN0015`).

It runs only within `SOLVE_LIMITS.maxSpace` candidates. Past that it is refused before anything is scored (`JN0024`), and it is never switched to another strategy. It prunes nothing. Rules are host code, so no bound on what a rule answers holds for every rule. `counts.space` is the size of the space, `nodes` the candidates scored (the problem as given is the first), and `moves` the evaluator edits.

### `construct`

`construct` makes one greedy pass over the open places: tasks in id order, each task's slots in slot order, a slot's room one place at a time. Each place is decided once. The choices are leaving it open and each resource not yet in its slot, each previewed with `whatIf`. A resource is admissible only if its scoring is complete, its verdict class is no worse than leaving the place open, and it adds no hard match. The choice is the admissible candidate with:

1. the lowest `rank` (every rank is 0 without a hook);
2. then the best class;
3. then the best score.

Leaving the place open wins a tie. A tie between resources goes to the first in id order, or, with a `seed` (a whole number from 0 to 4294967295), to a draw of `mulberry32(seed)` among them. A place left open ends its slot's filling.

`construct` answers `feasible` or `unknown` from the re-validated score, never `optimal` or `infeasible`. `counts.nodes` counts places decided, `moves` the previews and edits, `ranked` the hook's answers, and `undecided` the previews of verdict `unknown` or past a limit. `space` is null.

**The rank hook.** `rank(candidate, state)` orders the admissible candidates; a lower integer goes first. It answers a safe integer or a bigint, and anything else, or a throw, is refused (`JN0025`, the throw as `cause`). `candidate` is `{ task, slot, resource, result }`, with `resource: null` for leaving the place open and `result` the scoring the choice would have. `state` is `{ problem, assignments, added }`: the admitted problem, the current list, and what this pass added, in the order it added it. Both are frozen. A rank orders candidates and never waives a hard rule. A greedy that depends on its own path, such as "least time already assigned in this pass first", is a rank over `state.added` in the problem's integer units.

### `local` and repair

`local` starts from the problem's own list and improves it one edit at a time. The edits are those of the evaluator (§8): assign a resource to a slot with room, unassign, move to another resource, and swap the resources of two assignments. Each is previewed with `whatIf`, and one is applied only when it is strictly better under the objective below. When no single edit is better, the list is a local optimum.

**Positions.** The search visits *positions*: each assignment it may change, and each slot with room. Positions named by the most severe match or unknown come first: hard, then service, then soft, then the rest. A match names an assignment when it names its resource (or no resource) and its task (or no task). Within a rank, assignments come before open slots, in task, slot and resource order. At each position, every edit it offers is previewed. The best is applied if it is strictly better than the current list. A tie between the best edits goes to the first in order, or, with a `seed`, to a draw of `mulberry32(seed)` among them. A sweep over every position that applies nothing ends the descent.

**Restarts.** With a `seed` and `budgets.maxRestarts`, the search restores the best list it has held, makes 3 seeded edits, and descends again, `maxRestarts` times. Each restart and each of its edits is counted. The answer is always the best list the search held. A stop by a budget or the signal does not change it.

**The objective** is lexicographic:

1. the class: verdict `feasible`, then `unknown`, then `infeasible-by-validation` (an incomplete scoring is never better);
2. the hard level, then the service level;
3. with a baseline, the churn total, fewer changes first;
4. the soft level;
5. then the worst score, as for the other strategies.

So a repair first meets the hard rules and the service levels, then changes as little as it can, then improves what is left. `score` stays exactly `scoreAssignment` of `best`: churn is its own member and is never added to a level. A host that wants churn scored writes a rule that reads `baseline()`.

**Locks.** Locks are read from the problem's own list:

- a `hard`-locked assignment is never unassigned, moved or swapped, and `best` holds it as it is;
- a `soft`-locked assignment may change only when its change counts as churn: when the problem has a baseline that holds it;
- without a baseline, or when the baseline does not hold it, a `soft` lock is held like a `hard` one;
- an assignment with no lock may change freely.

**A proposal's locks are exactly the held ones.** An assignment in `best` carries a lock only when the problem's own list holds that same assignment (task, slot, resource) with that lock. So a soft-locked assignment that moves arrives at its new resource with no lock, and if the search makes the original assignment again, it gets its lock back. The evaluator's own `move` and `swap` keep the lock (§8), so `local` makes such a change as unassigns and then assigns instead. Such an edit is made whole or not at all: each evaluator edit counts as a move, and a budget that cannot cover all of them stops the search before it.

**Churn** compares assignments by task, slot and resource; a lock is not churn. Within one slot, the baseline's resources the list no longer holds and the resources it holds that the baseline did not are paired in id order. Each pair is one `moved` assignment `{ task, slot, from, to }`, and what is left over is `removed` or `added`. `total` counts each change once. `byResource` counts the changes each resource is in, so a move counts for both of its resources; `byTask` counts each task's changes. Ids with no change are not listed, and every list is sorted by id. Churn is counted against the baseline, not against the list the search started from.

```js
import { registerRules, solve } from '@jarenjs/core/assign';

const published = [
  { task: 'mon-early', slot: 'crew', resource: 'ari' },
  { task: 'mon-early', slot: 'crew', resource: 'nina', lock: 'hard' },
  { task: 'mon-late', slot: 'crew', resource: 'ari', lock: 'soft' },
];
const problem = {
  revision: 'week-12-r2',
  resources: [{ id: 'ari', revision: 1 }, { id: 'nina', revision: 1 }, { id: 'sam', revision: 1 }],
  tasks: [
    { id: 'mon-early', revision: 1, interval: { start: 0, end: 480 }, demands: [{ slot: 'crew', count: 2 }] },
    { id: 'mon-late', revision: 1, interval: { start: 480, end: 900 }, demands: [{ slot: 'crew', count: 1 }] },
  ],
  // ari is away all Monday now
  facts: { away: { revision: 2, rows: [{ resource: 'ari' }] } },
  assignments: published,
  baseline: { revision: 'week-12', assignments: published },
};
// an assignment of someone away
const notAway = {
  id: 'not-away', version: 1, level: 'hard', scope: 'resource', reads: { facts: ['away'] },
  evaluate(view, unit) {
    if (view.factRows('away', 'resource', unit.id).length === 0) return {};
    return { matches: view.assignmentsOf(unit.id).map((a) => ({ magnitude: 1, messageId: 'away', subjects: { resources: [unit.id], tasks: [a.task] } })) };
  },
};
// each place a task leaves open
const covered = {
  id: 'covered', version: 1, level: 'service', scope: 'task',
  evaluate(view, unit) {
    const want = view.task(unit.id).demands.reduce((sum, demand) => sum + demand.count, 0);
    const open = want - view.assignmentsFor(unit.id).length;
    return open > 0 ? { matches: [{ magnitude: open, messageId: 'open', subjects: { tasks: [unit.id] } }] } : {};
  },
};
const rules = registerRules([notAway, covered]);
const repaired = solve(problem, rules, { strategy: 'local' });

export const repair = {
  status: repaired.status,
  best: repaired.best.map((a) => `${a.task} ${a.resource}${a.lock ? ` (${a.lock})` : ''}`),
  score: { hard: repaired.score.score.hard, service: repaired.score.score.service },
  churn: { total: repaired.churn.total, moved: repaired.churn.moved, byResource: repaired.churn.byResource },
  baseline: repaired.provenance.baseline,
};
```

```json
{
  "status": "feasible",
  "best": [
    "mon-early nina (hard)",
    "mon-early sam",
    "mon-late nina"
  ],
  "score": {
    "hard": 0,
    "service": 0
  },
  "churn": {
    "total": 2,
    "moved": [
      {
        "from": "ari",
        "slot": "crew",
        "task": "mon-early",
        "to": "sam"
      },
      {
        "from": "ari",
        "slot": "crew",
        "task": "mon-late",
        "to": "nina"
      }
    ],
    "byResource": [
      {
        "count": 2,
        "resource": "ari"
      },
      {
        "count": 1,
        "resource": "nina"
      },
      {
        "count": 1,
        "resource": "sam"
      }
    ]
  },
  "baseline": "week-12"
}
```

Ari's two assignments now carry a hard match. Moving each costs one change, and leaving a place open would cost the service level. The soft lock on Monday's late shift was in the baseline, so it could move: the churn lists it, and Nina's new assignment carries no lock, because the problem never locked it. Nina's hard lock stayed. A tie between Nina and Sam for the late shift went to the first id.

### `auto`

`auto` runs `exhaustive` when its space is within `SOLVE_LIMITS.maxSpace`, and otherwise `construct` and then `local` over the same space: the problem's own list is kept, and `local` changes only what `construct` added. So both paths answer one question, and `auto` within the limit answers exactly what `exhaustive` answers. Both paths use the order of the other strategies, without churn. A repair is asked for with `local`.

`provenance.algorithm` names what ran: `exhaustive`, `construct+local`, or `construct` when a budget or the signal stopped `construct`. `provenance.strategy` is `auto`. It never falls back silently: `exhaustive` past its limit is still refused (`JN0024`), and `auto` says which path it took. The limit is not settable per call, so the same problem always takes the same path.

`seed` and `rank` go to `construct`, and `seed` to `local`. When `exhaustive` runs, they are unused, and the provenance says so: `algorithm` is `exhaustive`.

### Budgets and the signal

`budgets` is `{ maxNodes?, maxMoves?, maxRestarts?, maxEditWork? }`, each a whole number from 1. They count work and never time it, so the same budget stops at the same place on every host. The search stops before a node or a move the budget does not cover.

- `maxNodes` counts the candidates `exhaustive` scores, the places `construct` decides and the positions `local` tries.
- `maxMoves` counts the evaluator answers each asks for: a preview, an edit, or the restore of the best list before a restart.
- `maxRestarts` (`local` and `auto` only, and only with a `seed`) is the number of restarts after the first descent. Making all of them is the search asked for, not a stop: the answer is then `feasible` or `unknown`, not `limit`.
- `maxEditWork` (`local` and `auto` only) counts the evaluator's rule evaluations over one unit (`counts.evaluated` of §8), the first full scoring included, and is checked before each move. `counts.editWork` reports it.

`exhaustive` and `construct` refuse the last two (`JN0015`).

`signal` is an `AbortSignal`, read before each node and each move. A solve is synchronous, so it sees an abort raised before the call, or by host code it calls (a rule or the rank hook). Either way the answer is `limit` with `cancelled: true`.

A solve longer than a process should hold runs in slices: each a `local` solve with a `maxMoves` budget from the list the last one answered, saved between them, so an abort, a deploy or a crash costs at most one slice. [JOBS-FORMAT §12](../../db/docs/JOBS-FORMAT.md#12-long-computations) runs it as a durable job of `@jarenjs/db`, resumed from the saved list and answering the bytes an uninterrupted run does.

`SOLVE_LIMITS` is `{ maxSpace: 100000 }`.

## 10. Codes

Every refusal is an `AssignError`, a coded error whose `docPath` is a JSON Pointer:

- into the argument (`/tasks/2/demands/0/count`, `/rules/1/level`, `/options/limits/maxWork`);
- or, for a rule's answer, into that answer under the rule and unit (`/rules/no-overlap/resources/ari/matches/0/magnitude`; a global rule's is `/rules/<id>/global`).

An input with more than one fault is refused at the first one met, in the input's own order of members and items, so two orders of a faulty input can be refused at two different paths. An answer is the same bytes for every order; a refusal names one fault, not every fault.

| Code | Meaning |
|---|---|
| `JN0001` | the problem or one of its members is not of the form the schema takes: a wrong type, a missing member or one it does not define |
| `JN0002` | an id or a fact name is not a non-empty string |
| `JN0003` | an id is given twice where it must be unique: two resources, two tasks, two slots of one task or two rules |
| `JN0004` | a revision or a rule version is not a non-empty string or a whole number from 0 |
| `JN0005` | an interval is not a pair of safe integers with start before end |
| `JN0006` | a demand count is not a whole number from 1 |
| `JN0007` | an assignment, a baseline entry or a match names a task, slot or resource the problem does not hold |
| `JN0008` | an assignment repeats a task, slot and resource, or fills a slot past its count |
| `JN0009` | a value inside attributes, facts or params is not JSON: a non-finite number, undefined, a function, a symbol, a cycle or deeper than 64 levels |
| `JN0010` | a rule is not of the contract's form: a missing member, one it does not define, a wrong type, or an evaluate that is not a function |
| `JN0011` | a rule's level is not hard, service or soft |
| `JN0012` | a rule's scope is not resource, resource-day, task or global |
| `JN0013` | a rule's weight is not a whole number from 1 |
| `JN0014` | a rule set was not built by registerRules |
| `JN0015` | an option is not of the form this call takes: an unknown option, a limit that is not a whole number from 0, or an unknown group |
| `JN0016` | a rule's evaluate threw; what it threw is the cause |
| `JN0017` | a rule's evaluate answered something other than the contract's matches and unknowns: a promise, a wrong member, or a magnitude that is not a whole number from 1 |
| `JN0018` | a rule read a fact it does not declare in reads.facts |
| `JN0019` | a score is not of the form scoreAssignment answers |
| `JN0020` | a result is incomplete or not one scoreAssignment answers, so it has no total to explain |
| `JN0021` | civil days were asked for without the seam that answers them: a resource-day rule scored without options.days from civilDays, a days value civilDays did not build, or a day read by a rule whose scope is not resource-day |
| `JN0022` | a task's interval could not be split into civil days in its zone: the provider does not know the zone, failed, a day starts twice under the reject policy, or the task spans more than 36600 civil days; the calendar's refusal is the cause |
| `JN0023` | an edit is not one an evaluator takes: an unknown op or member, an unassign, move or swap naming an assignment the list does not hold, a revise naming nothing to change, or any edit to a closed evaluator |
| `JN0024` | an exhaustive solve was asked for a space holding more candidates than SOLVE_LIMITS.maxSpace; it is refused before anything is scored, never answered by another strategy |
| `JN0025` | a rank hook threw or answered other than a safe integer or a bigint; what it threw is the cause |
| `JN0026` | a fresh scoring of a solve's best list differs from the search's scoring of it: a rule read state past its view, so the search's answers cannot be trusted |

## 11. Measurements

There is no JavaScript library that takes a host's rules as plugins and scores and searches under them, so these figures have no rival. The one comparison is the evaluator against the engine's own full scoring of the same state. Every row is published, including the ones that lose. `node benchmark/assign.js` measures them into `benchmark/assign-result.json`.

**The quality corpus** (`test/core/assign/corpus/`, synthetic and seeded, with its provenance) holds the 30 tiny instances and ten domains (overlaps, availability spans, skills, gaps, a rolling window, consecutive days across a change of the clock, coverage, fairness, locks, and repair from a baseline), each at a size the oracle can enumerate and at a medium size. Every instance is solved by every strategy that applies to it. An independent validator then checks each answer: it reads raw JSON, imports no engine module, and scores the proposal again by brute force, checking the locks, `added`, `removed` and `churn` against raw differences and the status against what the answer can claim.

<!--fact:assign.corpus-->

80 instances, 7 calls each where they apply: 544 answers, **544 of 544** agreed with by the independent validator (optimal 58, feasible 311, limit 76, unknown 79, infeasible 20). On the 64 instances the oracle enumerates within `SOLVE_LIMITS`, `exhaustive` answered the proof's status, best score and bound 64 times of 64. The heuristics reached a proven optimum (counted where the proof is `optimal`, `local` only where the problem holds no assignment of its own, `limit` answers left out): construct 29 of 29; construct seed 7 28 of 29; local 29 of 29; local seed 7, 2 restarts 29 of 29; auto 29 of 29; local, 3 moves 2 of 2.

<!--/fact-->

**Classes.** A row is one instance class, solved by one strategy. Each class runs in three processes of its own, and the engine must answer the same status, score, churn and counts in every round of every process. The domain classes are the corpus generators at a larger size, scored by the domain's rule set (the reference rules; with `rolling-cap` for `rolling`; the four day rules for `days`). The oracle also validates their answers. The last three classes are the losses measured when local search and greedy construction were built:

- a roster repaired after one person was withdrawn;
- a dense start that is infeasible almost everywhere, repaired under a move budget: the swap neighbourhood costs about one preview per free assignment per position;
- greedy construction over 200 people and 2,000 tasks under a move budget, which answers `limit`.

Only the engine's fresh scoring re-validates those three. "Retained heap" is the live set the answer holds after forced collections, measured in a process that times nothing. It is not the search's peak.

<!--fact:assign.measurements-->

Measured on v24.22.1, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics (load average 1.05 before, 2.15 after). Method: each class in 3 processes of its own; a class timed in several rounds makes an untimed first call first, and a class timed in one round (the roster repair, the dense start and the large fill) is one cold call per process; never a forced collection in a timed process; the retained heap measured after two forced collections in a further process that times nothing; ns per operation. Rival: none: no JavaScript library takes host rules as plugins and scores and searches under them; the one comparison is incremental evaluation against the engine's own full rescoring.

| Class | Strategy | Resources × tasks | Status | Score (hard / service / soft) | Bound | Churn | Nodes / moves | Restarts / rule evaluations | Median ms (process 1 / 2 / 3) | Spread | Retained heap KiB | Validated by |
|---|---|---|---|---|---|---:|---|---|---|---:|---:|---|
| overlaps | `construct` | 10 × 40 (64 places) | feasible | 0 / -2 / -1 | — | — | 64 / 684 | — | 41.9 / 43.3 / 43.1 | 1.03 | 629 | oracle |
| overlaps | `local` | 10 × 40 (64 places) | feasible | 0 / -2 / -1 | — | — | 174 / 7,049 | 0 / 92,004 | 547 / 513 / 514 | 1.07 | 768 | oracle |
| overlaps | `auto` | 10 × 40 (64 places) | feasible | 0 / -2 / -1 | — | — | 128 / 4,387 | 0 / 55,858 | 314 / 312 / 305 | 1.03 | 792 | oracle |
| availability | `construct` | 10 × 40 (61 places) | feasible | 0 / 0 / -2 | — | — | 61 / 660 | — | 40.0 / 50.7 / 38.8 | 1.30 | 658 | oracle |
| availability | `local` | 10 × 40 (61 places) | feasible | 0 / 0 / -2 | — | — | 172 / 7,351 | 0 / 96,360 | 504 / 510 / 507 | 1.01 | 956 | oracle |
| availability | `auto` | 10 × 40 (61 places) | feasible | 0 / 0 / -2 | — | — | 122 / 4,346 | 0 / 55,530 | 304 / 302 / 321 | 1.06 | 799 | oracle |
| attributes | `construct` | 10 × 40 (68 places) | feasible | 0 / -8 / -18 | — | — | 66 / 706 | — | 43.2 / 44.8 / 45.9 | 1.06 | 598 | oracle |
| attributes | `local` | 10 × 40 (68 places) | feasible | 0 / -8 / -17 | — | — | 186 / 7,130 | 0 / 92,432 | 557 / 551 / 613 | 1.11 | 793 | oracle |
| attributes | `auto` | 10 × 40 (68 places) | feasible | 0 / -8 / -17 | — | — | 198 / 7,624 | 0 / 99,020 | 605 / 599 / 589 | 1.03 | 813 | oracle |
| gaps | `construct` | 10 × 40 (62 places) | feasible | 0 / -4 / -3 | — | — | 61 / 659 | — | 44.3 / 59.2 / 39.3 | 1.51 | 735 | oracle |
| gaps | `local` | 10 × 40 (62 places) | feasible | 0 / -3 / -3 | — | — | 176 / 7,270 | 0 / 94,940 | 512 / 527 / 529 | 1.03 | 801 | oracle |
| gaps | `auto` | 10 × 40 (62 places) | feasible | 0 / -4 / -3 | — | — | 122 / 4,073 | 0 / 51,594 | 303 / 293 / 293 | 1.03 | 806 | oracle |
| rolling | `construct` | 10 × 40 (64 places) | feasible | 0 / 0 / -54000015 | — | — | 64 / 690 | — | 47.0 / 48.6 / 45.8 | 1.06 | 615 | oracle |
| rolling | `local` | 10 × 40 (64 places) | feasible | 0 / 0 / -46800013 | — | — | 178 / 7,752 | 0 / 116,424 | 816 / 902 / 835 | 1.11 | 803 | oracle |
| rolling | `auto` | 10 × 40 (64 places) | feasible | 0 / 0 / -46800015 | — | — | 190 / 8,473 | 0 / 127,690 | 901 / 903 / 923 | 1.02 | 809 | oracle |
| days | `construct` | 6 × 21 (21 places) | feasible | 0 / 0 / 0 | — | — | 21 / 126 | — | 5.61 / 5.63 / 5.44 | 1.03 | 489 | oracle |
| days | `local` | 6 × 21 (21 places) | feasible | 0 / 0 / 0 | — | — | 21 / 126 | 0 / 504 | 5.71 / 6.22 / 5.85 | 1.09 | 531 | oracle |
| days | `auto` | 6 × 21 (21 places) | feasible | 0 / 0 / 0 | — | — | 42 / 252 | 0 / 1,008 | 8.41 / 8.41 / 9.18 | 1.09 | 632 | oracle |
| coverage | `construct` | 10 × 40 (108 places) | feasible | 0 / -2 / -8 | — | — | 98 / 1,003 | — | 63.7 / 64.2 / 59.1 | 1.09 | 588 | oracle |
| coverage | `local` | 10 × 40 (108 places) | feasible | 0 / -3 / -4 | — | — | 332 / 13,309 | 0 / 173,486 | 1006 / 1022 / 992 | 1.03 | 778 | oracle |
| coverage | `auto` | 10 × 40 (108 places) | feasible | 0 / -2 / -2 | — | — | 293 / 11,547 | 0 / 150,036 | 891 / 931 / 848 | 1.10 | 790 | oracle |
| fairness | `construct` | 10 × 40 (46 places) | feasible | 0 / 0 / -1 | — | — | 46 / 506 | — | 31.6 / 28.9 / 30.7 | 1.09 | 563 | oracle |
| fairness | `local` | 10 × 40 (46 places) | feasible | 0 / 0 / -1 | — | — | 92 / 2,868 | 0 / 36,110 | 183 / 188 / 186 | 1.02 | 737 | oracle |
| fairness | `auto` | 10 × 40 (46 places) | feasible | 0 / 0 / -1 | — | — | 92 / 2,868 | 0 / 36,110 | 223 / 183 / 184 | 1.22 | 751 | oracle |
| locks | `construct` | 10 × 40 (63 places, 63 held) | unknown | -10 / -338400000 / -67 | — | — | 0 / 0 | — | 2.64 / 2.63 / 2.63 | 1.00 | 323 | oracle |
| locks | `local` | 10 × 40 (63 places, 63 held) | unknown | -2 / -79200000 / -43 | — | 19 | 90 / 12,267 | 0 / 107,220 | 944 / 891 / 893 | 1.06 | 884 | oracle |
| locks | `auto` | 10 × 40 (63 places, 63 held) | infeasible | -10 / -338400000 / -67 | -10 / -338400000 / -67 | 0 | 1 / 0 | 0 / 122 | 2.71 / 2.99 / 2.75 | 1.10 | 153 | oracle |
| repair | `construct` | 10 × 40 (61 places, 58 held) | unknown | -14 / -28800003 / -31 | — | — | 2 / 20 | — | 4.59 / 5.17 / 4.77 | 1.13 | 448 | oracle |
| repair | `local` | 10 × 40 (61 places, 58 held) | feasible | 0 / -4 / -18 | — | 15 | 120 / 5,768 | 0 / 77,844 | 503 / 524 / 485 | 1.08 | 810 | oracle |
| repair | `auto` | 10 × 40 (61 places, 58 held) | infeasible | -14 / -28800003 / -31 | -14 / -28800003 / -31 | 0 | 616 / 1,229 | 0 / 9,954 | 81.8 / 81.3 / 81.6 | 1.01 | 602 | oracle |
| tiny | `exhaustive` | 30 instances | per instance | — | — | — | — | — | 1128 / 1117 / 1139 | 1.02 | 863 | oracle |
| limit | `exhaustive` | 9 × 5 (5 places) | optimal | 0 / 0 / -1 | 0 / 0 / -1 | — | 100,000 / 199,997 | — | 5591 / 5593 / 5719 | 1.02 | 623 | oracle |
| roster repair | `local` (maxMoves 20,000) | 50 × 500 (1,500 places, 336 held) | limit | 0 / -1170 / -9 | — | 6 | 361 / 20,000 | 0 / 131,868 | 3138 / 3029 / 3051 | 1.04 | 1034 | engine |
| dense start | `local` (maxMoves 20,000) | 50 × 500 (1,500 places, 1,250 held) | limit | -5224620278 / -18035040255 / -53 | — | 25 | 16 / 20,000 | 0 / 279,488 | 16943 / 17038 / 17171 | 1.01 | 1755 | engine |
| large fill | `construct` (maxMoves 20,000) | 200 × 2,000 (6,000 places) | limit | 0 / -5901 / -1 | — | — | 100 / 20,000 | — | 5990 / 6147 / 5900 | 1.04 | 1790 | engine |

`fullFallbacks` is the evaluator's count; `solve` does not report it, so it is per edit only:

| Mode | Assignments | Units | Full scoring ms (1 / 2 / 3) | `apply` ms (1 / 2 / 3) | `whatIf` ms (1 / 2 / 3) | Full ÷ `apply` | `fullFallbacks` | Evaluator live MiB |
|---|---:|---:|---|---|---|---|---:|---:|
| base: the eight reference rules (two global) | 5,000 | 4,802 | 62.7 / 64.6 / 61.8 | 3.07 / 2.98 / 3.22 | 3.05 / 3.00 / 3.19 | 20.4× / 21.7× / 19.2× | 0 of 1200 | 6.12 |
| local: the six reference rules that read only their own row | 5,000 | 4,800 | 62.0 / 62.4 / 62.6 | 2.61 / 2.57 / 2.58 | 2.60 / 2.54 / 2.58 | 23.7× / 24.2× / 24.3× | 0 of 1200 | 6.09 |
| days: the four day rules over tasks in two zones | 2,811 | 7,500 | 66.7 / 66.3 / 66.1 | 1.74 / 1.69 / 1.73 | 1.72 / 1.70 / 1.73 | 38.4× / 39.3× / 38.2× | 0 of 1200 | 6.14 |
| wide: the eight reference rules and one that reads the next resource's row | 5,000 | 5,002 | 70.8 / 73.9 / 73.4 | 11.5 / 11.7 / 11.5 | 11.5 / 11.7 / 11.4 | 6.2× / 6.3× / 6.4× | 1196 of 1200 | 6.35 |

<!--/fact-->
