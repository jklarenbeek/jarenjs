#!/usr/bin/env node
//@ts-check
/**
 * The assignment engine, `@jarenjs/core/assign`, measured on its own
 * terms: there is no JavaScript library that takes a host's rules as
 * plugins and scores and searches under them, so there is no rival here,
 * and the one comparison made is the engine's incremental evaluation
 * against its own full rescoring of the same state.
 *
 *   node benchmark/assign.js            # measure and write benchmark/assign-result.json
 *   node benchmark/assign.js --quick    # the corpus sizes, one run, written nowhere unless --filepath
 *   node benchmark/assign.js --output json --filepath FILE
 *
 * What it publishes, every row together and none dropped:
 * - the quality corpus (test/core/assign/corpus): how many answers the
 *   independent validator agreed with, the statuses, the proofs matched
 *   and how often each heuristic reached a proven optimum. A single
 *   disagreement exits non-zero and writes nothing;
 * - per instance class and strategy: the score per level, the status, the
 *   bound, churn, nodes, moves, restarts and rule evaluations, the live
 *   heap the answer retains (after a forced collection, in a process of
 *   its own that times nothing) and the latency median of each of three
 *   processes; `fullFallbacks` is the evaluator's count and `solve` does
 *   not report it, so it is null on those rows;
 * - per edit, the incremental evaluator against full scoring of the same
 *   state, including a rule that reads outside its row (every answer a
 *   fallback).
 *
 * Every timed class runs in a process of its own (three of them), never
 * forces a collection, makes an untimed first call when it is timed in
 * several rounds (a single-round class is one cold call per process), and must answer the same status, score, churn and
 * counts in every round of every process: the engine is deterministic,
 * and a class that is not exits non-zero before anything is written.
 * Latencies are nanoseconds per operation (one solve, one scoring, one edit).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

import { admitProblem, registerRules, scoreAssignment, createEvaluator, solve } from '@jarenjs/core/assign';
import { civilDays } from '@jarenjs/core/assign/days';
import { REFERENCE_RULES } from '../test/core/assign/rules/reference.js';
import { DAY_RULES } from '../test/core/assign/rules/days.js';
import { rollingCap } from '../test/core/assign/rules/rolling.js';
import { fixtureProvider, TRANSITIONS } from '../test/core/assign/days-provider.js';
import { largeProblem } from '../test/core/assign/fixtures.js';
import { rosterRepair, REPAIR_RULES } from '../test/core/assign/local-fixtures.js';
import { streamInstance, randomEdit, plainApply, lcg } from '../test/core/assign/stream.js';
import { tinyInstance } from '../test/core/assign/oracle/instances.js';
import { oracleOf, validateAnswer } from '../test/core/assign/oracle/validate.js';
import { DOMAINS, kindOf, domainInstance } from '../test/core/assign/corpus/domains.js';
import { corpusInstances, solveInstance, CALLS } from '../test/core/assign/corpus/run.js';

const SELF = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULT = fileURLToPath(new URL('./assign-result.json', import.meta.url));
const RUNS = 3;
const HOUR = 3600000;

/** The files the measurement reads its inputs from; the published figures are pinned to their hash. */
export const INPUTS = Object.freeze([
  'benchmark/assign.js',
  'test/core/assign/corpus/domains.js', 'test/core/assign/corpus/run.js',
  'test/core/assign/rules/reference.js', 'test/core/assign/rules/days.js', 'test/core/assign/rules/rolling.js',
  'test/core/assign/oracle/validate.js', 'test/core/assign/oracle/score.js', 'test/core/assign/oracle/days.js',
  'test/core/assign/oracle/rolling.js', 'test/core/assign/oracle/instances.js',
  'test/core/assign/fixtures.js', 'test/core/assign/local-fixtures.js', 'test/core/assign/solve-fixtures.js', 'test/core/assign/stream.js',
]);

/** @param {string[]} files @returns {string} */
export function hashOf(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(new URL(`../${file}`, import.meta.url))).update('\0');
  return hash.digest('hex');
}

const SETS = {
  reference: registerRules(REFERENCE_RULES),
  rolling: registerRules([...REFERENCE_RULES, rollingCap]),
  days: registerRules(DAY_RULES),
};
const DAYS = civilDays({ zoneProvider: fixtureProvider(), policy: 'rfc5545' });

/** @param {any} raw @returns {{ resources: number, tasks: number, places: number, assignments: number }} */
function sizeOf(raw) {
  let places = 0;
  for (const task of raw.tasks) for (const demand of task.demands) places += demand.count;
  return { resources: raw.resources.length, tasks: raw.tasks.length, places, assignments: (raw.assignments ?? []).length };
}

/** 9 people and 5 one-place shifts: 10^5 candidate lists, SOLVE_LIMITS.maxSpace exactly. */
function atTheLimit() {
  const resources = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, revision: 1, attributes: { skills: i % 3 === 0 ? ['a'] : ['a', 'b'] } }));
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, revision: 1, interval: { start: i * 3 * HOUR, end: i * 3 * HOUR + 4 * HOUR },
    demands: [{ slot: 'lead', count: 1, attributes: { requires: i % 2 === 0 ? ['b'] : [] } }] }));
  return {
    revision: 'limit', resources, tasks,
    facts: { availability: { revision: 1, rows: resources.map((r) => ({ resource: r.id, start: 0, end: 20 * HOUR, state: 'available' })) },
      preferences: { revision: 1, rows: [{ resource: 'p1', task: 't2', penalty: 2 }] } },
    attributes: { minGap: HOUR, cap: 8 * HOUR, window: { start: 0, end: 20 * HOUR } },
  };
}

/** The dense, broadly infeasible start: a round-robin list over overlapping tasks, as baseline, and p0 busy throughout. */
function denseStart(tasks, resources) {
  const { problem, assignments } = largeProblem(tasks, resources);
  problem.assignments = assignments;
  problem.baseline = { revision: 'published', assignments };
  problem.facts.availability.rows.push({ resource: 'p0', start: 0, end: 1e12, state: 'busy' });
  return problem;
}

/**
 * Every timed solve class. `validated: 'oracle'` classes are small enough
 * for the brute-force oracle to score their answer; the rest are
 * re-validated by the engine's own fresh scoring only.
 * @param {boolean} quick
 */
function classes(quick) {
  const out = [];
  for (const domain of DOMAINS) {
    const size = quick ? (domain === 'days' ? { resources: 4, tasks: 10 } : { resources: 8, tasks: 24 })
      : (domain === 'days' ? { resources: 6, tasks: 21 } : { resources: 10, tasks: 40 });
    for (const strategy of ['construct', 'local', 'auto'])
      out.push({ id: `${domain}/${strategy}`, group: 'domain', domain, kind: kindOf(domain), strategy, options: {}, rounds: 3, validated: 'oracle',
        build: () => domainInstance(domain, 1, size) });
  }
  out.push({ id: 'tiny/exhaustive', group: 'exhaustive', domain: 'tiny', kind: 'reference', strategy: 'exhaustive', options: {}, rounds: 3, validated: 'oracle',
    build: () => null, many: () => Array.from({ length: 30 }, (_, i) => tinyInstance(i + 1)) });
  out.push({ id: 'limit/exhaustive', group: 'exhaustive', domain: 'limit', kind: 'reference', strategy: 'exhaustive', options: {}, rounds: quick ? 1 : 2, validated: 'oracle',
    build: atTheLimit });
  const roster = quick ? [9, 28] : [50, 500];
  out.push({ id: 'roster-repair/local', group: 'scale', domain: 'roster repair', kind: 'repair', strategy: 'local', options: { budgets: { maxMoves: 20000 } }, rounds: 1, validated: 'engine',
    build: () => rosterRepair(1, 's3', roster[0], roster[1]).problem });
  const dense = quick ? [100, 20] : [500, 50];
  out.push({ id: 'dense-start/local', group: 'scale', domain: 'dense start', kind: 'reference', strategy: 'local', options: { budgets: { maxMoves: 20000 } }, rounds: 1, validated: 'engine',
    build: () => denseStart(dense[0], dense[1]) });
  const large = quick ? [200, 20] : [2000, 200];
  out.push({ id: 'large/construct', group: 'scale', domain: 'large fill', kind: 'reference', strategy: 'construct', options: { budgets: { maxMoves: 20000 } }, rounds: 1, validated: 'engine',
    build: () => largeProblem(large[0], large[1]).problem });
  return out;
}

/** @param {string} kind */
const ruleSetOf = (kind) => (kind === 'repair' ? registerRules(REPAIR_RULES) : SETS[/** @type {'reference'} */ (kind)]);

/** @param {any} entry @param {any} problem @param {any} ruleSet */
const solveOnce = (entry, problem, ruleSet) => solve(problem, ruleSet, { strategy: entry.strategy, ...entry.options, ...(entry.kind === 'days' ? { days: DAYS } : {}) });

/** @param {any} answer */
function signatureOf(answer) {
  const s = answer.score.complete ? answer.score.score : null;
  return JSON.stringify({ status: answer.status, score: s && { hard: String(s.hard), service: String(s.service), soft: String(s.soft) },
    verdict: answer.score.verdict, bound: answer.bound === undefined ? null : { hard: String(answer.bound.hard), service: String(answer.bound.service), soft: String(answer.bound.soft) },
    churn: answer.churn?.total ?? null, added: answer.added.length, removed: answer.removed?.length ?? null,
    counts: { nodes: answer.counts.nodes, moves: answer.counts.moves, restarts: answer.counts.restarts ?? null, editWork: answer.counts.editWork ?? null } });
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One timed class in this process: an untimed first call, then `rounds` timed ones. */
function timeClass(entry) {
  if (entry.many !== undefined) {
    const problems = entry.many().map((/** @type {any} */ raw) => admitProblem(raw));
    const ruleSet = ruleSetOf(entry.kind);
    const all = () => problems.map((/** @type {any} */ p) => solveOnce(entry, p, ruleSet));
    const signature = JSON.stringify(all().map(signatureOf));
    const rounds = [];
    for (let i = 0; i < entry.rounds; i++) {
      const start = process.hrtime.bigint();
      const answers = all();
      rounds.push(Number(process.hrtime.bigint() - start));
      if (JSON.stringify(answers.map(signatureOf)) !== signature) throw new Error(`${entry.id}: round ${i} answered differently`);
    }
    return { signature, rounds, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  }
  const problem = admitProblem(entry.build());
  const ruleSet = ruleSetOf(entry.kind);
  const signature = entry.rounds > 1 ? signatureOf(solveOnce(entry, problem, ruleSet)) : null;
  const rounds = [];
  let seen = signature;
  for (let i = 0; i < entry.rounds; i++) {
    const start = process.hrtime.bigint();
    const answer = solveOnce(entry, problem, ruleSet);
    rounds.push(Number(process.hrtime.bigint() - start));
    const now = signatureOf(answer);
    if (seen !== null && now !== seen) throw new Error(`${entry.id}: round ${i} answered differently`);
    seen = now;
  }
  return { signature: seen, rounds, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
}

/** The answer of one class, validated, and the live heap it retains, in a process that times nothing. */
function heapClass(entry) {
  const gc = /** @type {() => void} */ (globalThis.gc);
  if (entry.many !== undefined) {
    const raws = entry.many();
    const problems = raws.map((/** @type {any} */ raw) => admitProblem(raw));
    const ruleSet = ruleSetOf(entry.kind);
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    const answers = problems.map((/** @type {any} */ p) => solveOnce(entry, p, ruleSet));
    gc(); gc();
    const retainedBytes = process.memoryUsage().heapUsed - before;
    const answerOf = oracleOf('reference');
    const wrong = answers.flatMap((answer, i) => validateAnswer(raws[i], entry.strategy, answer, answerOf).map((w) => `tiny-${i + 1}: ${w}`));
    return { retainedBytes, wrong, answer: null };
  }
  const raw = entry.build();
  const problem = admitProblem(raw);
  const ruleSet = ruleSetOf(entry.kind);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const answer = solveOnce(entry, problem, ruleSet);
  gc(); gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  /** @type {string[]} */
  let wrong = [];
  if (entry.validated === 'oracle') wrong = validateAnswer(raw, entry.strategy, answer, oracleOf(entry.kind, TRANSITIONS.zones), { stoppable: entry.options.budgets !== undefined });
  const again = scoreAssignment(problem, ruleSet, answer.best, entry.kind === 'days' ? { days: DAYS } : undefined);
  if (JSON.stringify(again) !== JSON.stringify(answer.score)) wrong.push('the answer\'s score is not a fresh scoring of best');
  return { retainedBytes, wrong, answer: { size: sizeOf(raw), rules: ruleSet.rules.length, signature: signatureOf(answer), algorithm: answer.provenance.algorithm } };
}

/** Incremental modes over 200 resources and 2,000 tasks, as the evaluator's equality proofs build them. */
function incrementalModes(quick) {
  const [tasks, resources] = quick ? [200, 20] : [2000, 200];
  const paired = /** @type {any} */ ({
    id: 'paired-shifts', version: 1, level: 'soft', scope: 'resource',
    evaluate(/** @type {any} */ view, /** @type {any} */ unit) {
      const ids = view.resources().map((/** @type {any} */ r) => r.id);
      const buddy = ids[(ids.indexOf(unit.id) + 1) % ids.length];
      const theirs = new Set(view.assignmentsOf(buddy).map((/** @type {any} */ a) => a.task));
      return { matches: view.assignmentsOf(unit.id).filter((/** @type {any} */ a) => theirs.has(a.task)).map(() => ({ magnitude: 1, messageId: 'paired' })) };
    },
  });
  const local = REFERENCE_RULES.filter((rule) => rule.scope !== 'global');
  // every task in a zone, so every resource's days are judged however the edits move them
  const zoned = () => {
    const made = streamInstance(1, { resources, tasks, zones: ['Europe/Amsterdam', 'America/New_York'] });
    for (const task of made.problem.tasks) task.zone ??= 'Europe/Amsterdam';
    return made;
  };
  return [
    { mode: 'base', note: 'the eight reference rules (two global)', build: () => largeProblem(tasks, resources), rules: REFERENCE_RULES },
    { mode: 'local', note: 'the six reference rules that read only their own row', build: () => largeProblem(tasks, resources), rules: local },
    { mode: 'days', note: 'the four day rules over tasks in two zones', build: zoned, rules: DAY_RULES, days: true },
    { mode: 'wide', note: 'the eight reference rules and one that reads the next resource\'s row', build: () => largeProblem(tasks, resources), rules: [...REFERENCE_RULES, paired] },
  ];
}

/** One incremental mode in this process: full scorings, then a stream of edits applied and previewed. */
function timeIncremental(mode, quick) {
  const { problem: raw, assignments } = mode.build();
  const problem = admitProblem(raw);
  const ruleSet = registerRules(mode.rules);
  const options = mode.days ? { days: DAYS } : undefined;
  const fullRounds = [];
  for (let i = 0; i < 20; i++) {
    const start = process.hrtime.bigint();
    scoreAssignment(problem, ruleSet, assignments, options);
    if (i >= 5) fullRounds.push(Number(process.hrtime.bigint() - start));
  }
  const evaluator = createEvaluator(problem, ruleSet, assignments, options);
  const units = evaluator.result.complete ? evaluator.result.counts.units : null;
  const next = lcg(13);
  /** @type {any[]} */
  let list = assignments;
  const apply = [];
  const preview = [];
  const edits = quick ? 200 : 600;
  for (let i = 0; i < edits;) {
    const edit = randomEdit(next, raw, list);
    const planned = plainApply(raw, list, edit);
    if ('code' in planned) continue;
    let start = process.hrtime.bigint();
    evaluator.apply(edit);
    const applied = Number(process.hrtime.bigint() - start);
    list = planned.list;
    let other = randomEdit(next, raw, list);
    while ('code' in plainApply(raw, list, other)) other = randomEdit(next, raw, list);
    start = process.hrtime.bigint();
    evaluator.whatIf(other);
    const previewed = Number(process.hrtime.bigint() - start);
    if (i >= edits / 6) {
      apply.push(applied);
      preview.push(previewed);
    }
    i++;
  }
  const sameBytes = JSON.stringify(evaluator.result) === JSON.stringify(scoreAssignment(problem, ruleSet, list, options));
  return {
    assignments: assignments.length, units, rules: mode.rules.length,
    fullNs: median(fullRounds), applyNs: median(apply), whatIfNs: median(preview), timedEdits: apply.length,
    counts: { ...evaluator.counts }, sameBytes,
  };
}

/** The live heap an evaluator holds over the mode's state, in a process that times nothing. */
function heapIncremental(mode) {
  const gc = /** @type {() => void} */ (globalThis.gc);
  const { problem: raw, assignments } = mode.build();
  const problem = admitProblem(raw);
  const ruleSet = registerRules(mode.rules);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const evaluator = createEvaluator(problem, ruleSet, assignments, mode.days ? { days: DAYS } : undefined);
  gc(); gc();
  const liveBytes = process.memoryUsage().heapUsed - before;
  return { liveBytes, complete: evaluator.result.complete };
}

/** The corpus, every call, and the validator's verdict on each answer. */
function corpusSummary() {
  const instances = corpusInstances();
  let answers = 0;
  let agreed = 0;
  let proofs = 0;
  let proofsMatched = 0;
  const statuses = /** @type {Record<string, number>} */ ({});
  const reached = /** @type {Record<string, { reached: number, of: number }>} */ ({});
  const wrong = [];
  for (const instance of instances) {
    const { proof, runs, refused } = solveInstance(instance);
    for (const message of refused) wrong.push(`${instance.name}: ${message}`);
    for (const run of runs) {
      answers++;
      if (run.wrong.length === 0) agreed++;
      else wrong.push(`${instance.name} ${run.label}: ${run.wrong.join('; ')}`);
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    }
    const exhaustive = runs.find((run) => run.label === 'exhaustive');
    if (proof === null || exhaustive === undefined) continue;
    proofs++;
    if (exhaustive.status === proof.status) proofsMatched++;
    if (proof.status !== 'optimal') continue;
    const fills = (instance.problem.assignments ?? []).length === 0;
    for (const run of runs) {
      if (run.label === 'exhaustive' || (run.strategy === 'local' && !fills) || run.status === 'limit') continue;
      const at = (reached[run.label] ??= { reached: 0, of: 0 });
      at.of++;
      const s = run.answer.score.score;
      if (String(s.hard) === proof.score.hard && String(s.service) === proof.score.service && String(s.soft) === proof.score.soft) at.reached++;
    }
  }
  return { instances: instances.length, calls: CALLS.map((call) => call.label), answers, agreed, statuses, proofs, proofsMatched, optimaReached: reached, wrong };
}

/** Run this file in a child process and read the one JSON line it prints. */
function child(args, gc = false) {
  const out = spawnSync(process.execPath, [...(gc ? ['--expose-gc'] : []), '--no-warnings=ExperimentalWarning', SELF, ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, FORCE_COLOR: '0' } });
  if (out.status !== 0) throw new Error(`${args.join(' ')} exited ${out.status}: ${out.stderr.slice(-2000)}`);
  return JSON.parse(out.stdout.trim().split('\n').at(-1) ?? 'null');
}

function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const at = (/** @type {string} */ flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const role = at('--child');
  if (role !== undefined) {
    const [what, id] = role.split(':');
    let value;
    if (what === 'corpus') value = corpusSummary();
    else if (what === 'time') value = timeClass(classes(quick).find((entry) => entry.id === id));
    else if (what === 'heap') value = heapClass(classes(quick).find((entry) => entry.id === id));
    else if (what === 'edit') value = timeIncremental(incrementalModes(quick).find((m) => m.mode === id), quick);
    else if (what === 'edit-heap') value = heapIncremental(incrementalModes(quick).find((m) => m.mode === id));
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  const output = at('--output') ?? 'console';
  const filepath = at('--filepath') ?? (quick ? null : RESULT);
  const runs = quick ? 1 : RUNS;
  const flag = quick ? ['--quick'] : [];
  const host = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown',
    loadBefore: loadavg().map((x) => Math.round(x * 100) / 100), freeMemBytes: freemem(), totalMemBytes: totalmem() };

  console.error('corpus...');
  const corpus = child(['--child', 'corpus', ...flag]);
  if (corpus.agreed !== corpus.answers || corpus.proofsMatched !== corpus.proofs) {
    console.error(`the validator disagrees: ${corpus.wrong.slice(0, 5).join('\n')}`);
    process.exit(1);
  }

  const rows = [];
  for (const entry of classes(quick)) {
    console.error(`${entry.id}...`);
    const heap = child(['--child', `heap:${entry.id}`, ...flag], true);
    if (heap.wrong.length > 0) {
      console.error(`${entry.id}: ${heap.wrong.join('; ')}`);
      process.exit(1);
    }
    const timed = [];
    for (let run = 0; run < runs; run++) timed.push(child(['--child', `time:${entry.id}`, ...flag]));
    const signatures = new Set(timed.map((t) => t.signature));
    if (heap.answer !== null) signatures.add(heap.answer.signature);
    else signatures.add(timed[0].signature);
    if (signatures.size !== 1) {
      console.error(`${entry.id}: the processes answered differently`);
      process.exit(1);
    }
    const medians = timed.map((t) => median(t.rounds));
    const signature = heap.answer === null ? null : JSON.parse(heap.answer.signature);
    rows.push({
      id: entry.id, group: entry.group, domain: entry.domain, strategy: entry.strategy, options: entry.options, validated: entry.validated,
      size: heap.answer?.size ?? { instances: 30 }, rules: heap.answer?.rules ?? REFERENCE_RULES.length, algorithm: heap.answer?.algorithm ?? 'exhaustive',
      status: signature?.status ?? 'per instance', score: signature?.score ?? null, verdict: signature?.verdict ?? null, bound: signature?.bound ?? null,
      churn: signature?.churn ?? null, added: signature?.added ?? null, removed: signature?.removed ?? null,
      counts: signature?.counts ?? null, fullFallbacks: null,
      latency: { runs: timed.map((t, i) => ({ medianNs: medians[i], roundsNs: t.rounds })), medianNs: median(medians), spread: Math.max(...medians) / Math.min(...medians) },
      retainedBytes: heap.retainedBytes, maxRssBytes: timed.map((t) => t.maxRssBytes),
    });
  }

  const incremental = [];
  for (const mode of incrementalModes(quick)) {
    console.error(`edits ${mode.mode}...`);
    const heap = child(['--child', `edit-heap:${mode.mode}`, ...flag], true);
    const timed = [];
    for (let run = 0; run < runs; run++) timed.push(child(['--child', `edit:${mode.mode}`, ...flag]));
    if (timed.some((t) => !t.sameBytes)) {
      console.error(`${mode.mode}: the evaluator's last answer is not full scoring's`);
      process.exit(1);
    }
    if (new Set(timed.map((t) => JSON.stringify(t.counts))).size !== 1) {
      console.error(`${mode.mode}: the processes counted differently`);
      process.exit(1);
    }
    incremental.push({
      mode: mode.mode, note: mode.note, assignments: timed[0].assignments, units: timed[0].units, rules: timed[0].rules, timedEdits: timed[0].timedEdits,
      fullNs: timed.map((t) => t.fullNs), applyNs: timed.map((t) => t.applyNs), whatIfNs: timed.map((t) => t.whatIfNs),
      speedup: timed.map((t) => t.fullNs / t.applyNs), fullFallbacks: timed[0].counts.fullFallbacks, fullScorings: timed[0].counts.fullScorings,
      edits: timed[0].counts.edits, previews: timed[0].counts.previews, sameBytes: true, liveBytes: heap.liveBytes,
    });
  }

  const result = {
    format: 'jaren-assign-measurements/1',
    inputs: INPUTS,
    inputsHash: hashOf([...INPUTS]),
    quick,
    runtime: host,
    loadAfter: loadavg().map((x) => Math.round(x * 100) / 100),
    rival: 'none: no JavaScript library takes host rules as plugins and scores and searches under them; the one comparison is incremental evaluation against the engine\'s own full rescoring',
    method: `each class in ${runs} processes of its own; a class timed in several rounds makes an untimed first call first, and a class timed in one round (the roster repair, the dense start and the large fill) is one cold call per process; never a forced collection in a timed process; the retained heap measured after two forced collections in a further process that times nothing; ns per operation`,
    corpus: { ...corpus, wrong: undefined },
    classes: rows,
    incremental,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (filepath !== null) writeFileSync(filepath, text);
  if (output === 'console') console.log(text);
}

if (process.argv[1] === SELF) main();
