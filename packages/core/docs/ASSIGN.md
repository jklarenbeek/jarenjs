# `@jarenjs/core/assign` — the assignment engine

`@jarenjs/core/assign` holds the mechanism of assignment problems (staff rosters, delivery slots, room bookings) but not their vocabulary. It provides:

- an assignment problem as plain, revisioned JSON with a schema twin;
- a rule contract through which the host supplies every constraint;
- exact, explained scoring.

It knows nothing about rest periods, skills, opening hours or fairness. Those are rules the host writes against the contract, and **the engine ships none**.

> Every score is the exact sum of explained rule matches. Every result says how complete it is and what produced it. The engine never decides what a rule means.

```js
import {
  admitProblem, registerRules, scoreAssignment, compareScores, explain,
  ASSIGN_LIMITS, ASSIGN_CODES, AssignError,
} from '@jarenjs/core/assign';
```

Pure JSON goes in and out. The engine reads no clock, no locale and no storage, and no zone but the ones a task names, through the provider the host injects (§7). Scoring the same inputs gives the same bytes in every host time zone, for every key order of the inputs, and for every order of their resources, tasks, demands and assignments. Fact rows and arrays inside `attributes` are host data and keep the host's order.

A rule over one resource on one civil day of a zone (`resource-day`) gets its days through the separate subpath `@jarenjs/core/assign/days` and a zone provider the host injects (§7). Not here: incremental re-scoring of one edit, and search. Scoring answers how good a given assignment list is; it does not look for a better one.

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

Two problems that differ only in key order, or in the order of their resources, tasks, demands and assignments, admit to the same bytes. Admitting the answer again answers it unchanged. Every refusal is an `AssignError` with its own code (§8) and the JSON Pointer at fault as `docPath`.

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

An unknown is `{ reason, fact?, subjects? }`. An answer of any other form is refused by name (`JN0017`), and so is a promise. What a rule throws is refused as `JN0016`, with the throw as `cause`.

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

It has no score, no matches and no unknowns: a partial total is never answered. A rule that catches the stop and returns normally is still stopped.

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

## 8. Codes

Every refusal is an `AssignError`, a coded error whose `docPath` is a JSON Pointer:

- into the argument (`/tasks/2/demands/0/count`, `/rules/1/level`, `/options/limits/maxWork`);
- or, for a rule's answer, into that answer under the rule and unit (`/rules/no-overlap/resources/ari/matches/0/magnitude`; a global rule's is `/rules/<id>/global`).

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
