#!/usr/bin/env node

/**
 * Contract validation benchmark — Jaren vs Zod vs Ajv
 *
 * The rival here is not another JSON Schema engine, it is the
 * validate-and-normalize library a TypeScript service actually uses. So the
 * comparison is against **Zod 4, Zod 3 and zod/mini**, with **Ajv** included
 * because it is the incumbent JSON Schema engine and leaving it out would
 * flatter us.
 *
 * Four tables, because one number cannot honestly cover this:
 *
 *   1. **Compile** — turning a contract into something callable. Paid once at
 *      startup, so it is the least important; it is here because every Zod
 *      flavor builds faster than Jaren and hiding that would be dishonest.
 *   2. **Verdict** — the cheapest "is this valid?" each engine can give for
 *      input that IS valid.
 *   3. **Adapter** — the shape a real service runs: normalize the input,
 *      validate it, and map failures to a library-neutral issue list. Timed
 *      on INVALID input, because that is the path that allocates.
 *   4. **First calls** — the adapter's first calls after a fresh process
 *      builds the contract, before the engine has settled.
 *
 * Fairness decisions, stated rather than buried:
 *
 * - **The verdict table is not apples-to-apples, and the ratio flatters
 *   Jaren.** Jaren's boolean mode answers with a predicate and allocates
 *   nothing. Zod has no predicate mode: its cheapest verdict is `safeParse`,
 *   which also builds a normalized output object. That output is not wasted
 *   work in a real handler — it is what you go on to use — which is exactly
 *   why table 3 exists and is the one to quote.
 * - **Table 3 is the apples-to-apples one.** Every engine produces the same
 *   two things: a normalized value and a neutral issue list.
 * - **Ajv normalizes by mutating its input.** To keep the comparison honest
 *   it is handed a fresh structuredClone of the input each iteration, since
 *   Jaren and Zod both produce a new value and leave the caller's alone. The
 *   clone is charged to Ajv because not cloning would measure a different
 *   (and, for a shared request body, incorrect) program.
 * - **Each rival takes its own fastest route.** Zod 4 uses its top-level
 *   string formats, Zod 3 the `.string().uuid()` chain it has, zod/mini its
 *   function-style API. Ajv compiles with its own normalization options on.
 * - **Every engine is checked before it is timed.** An engine must accept the
 *   valid input, reject the invalid one, and produce the expected normalized
 *   value; one that disagrees is reported as a mismatch and dropped from the
 *   table rather than silently timed doing less work.
 * - **Each engine is timed in a process of its own**, as a service runs one
 *   validation library. Side by side in one process the engines slow each
 *   other down: zod 4 and zod/mini share a core, and a call site that meets
 *   every engine's objects is optimized for none of them. `--shared` times
 *   them all in one process instead.
 * - **Builds are timed after every per-call row**, because a build leaves
 *   garbage that would otherwise be collected inside the rows after it.
 * - **The first calls are a table of their own.** The other tables time an
 *   engine once it has settled, which takes Jaren's adapter tens of
 *   thousands of calls and the rivals a few thousand; a service meets the
 *   calls before that after every start, so each engine also builds one
 *   contract in a fresh process and times its first adapter calls, each
 *   cell the median of three such processes.
 *
 * Usage:
 *   node benchmark/contracts.js
 *   node benchmark/contracts.js --iterations 50000
 *   node benchmark/contracts.js command
 *   node benchmark/contracts.js --output json --filepath results.json
 */

import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import * as jarenFormats from '@jarenjs/formats';
import { parseJSONPointerPath } from '@jarenjs/json';

import * as z4 from 'zod';
import * as zmini from 'zod/mini';
import * as z3mod from 'zod3';

// The scenarios declare draft 2020-12, which is Ajv's separate build.
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pad, padLeft, formatNs } from './lib/fmt.js';
import { measureNsPerOp as measureNs } from './lib/measure.js';
import { parseSuiteArgs } from './lib/args.js';
import { writeJsonResults } from './lib/results.js';

const z3 = z3mod.z;
const DEFAULT_ITERATIONS = 50_000;
const SCHEMA_POOL = 4096;
const SELF = fileURLToPath(import.meta.url);

const CAVEAT = 'The verdict table is not apples-to-apples and its ratio flatters Jaren: Jaren answers with a predicate that allocates nothing, while Zod has no predicate mode and builds its normalized output on the way. The adapter table is the comparable one. Compiling a schema with defaults costs Jaren more than one without: it checks each default against every schema the default meets, so normalizing never turns a request its validator accepts into one it refuses. Handed a default its own schema refuses, ajv fills it and then refuses the request, zod 3 refuses the request, and zod 4 and zod/mini return the default unchecked.';

/** The warm-up table's call counts: the first calls a fresh process makes of one contract's adapter. */
const COLD_CALLS = [1_000, 10_000];
/** The fresh processes each warm-up cell is the median of: one process's first calls move with its own start. */
const COLD_PROCESSES = 3;
const ENGINES = ['jaren', 'zod4', 'zod3', 'zodmini', 'ajv'];

const ENGINE_LABELS = {
  jaren: '@jarenjs/validate',
  zod4: 'zod 4',
  zod3: 'zod 3',
  zodmini: 'zod/mini',
  ajv: 'ajv',
};

//#region scenarios

const UUID = '5f2b1c2e-9a7d-4f3e-8b1a-2c4d6e8f0a1b';
const WHEN = '2026-07-29T10:15:30Z';

/**
 * Each scenario carries the same contract expressed four ways, plus the
 * inputs and the normalized value every engine must agree on.
 */
const SCENARIOS = [
  {
    key: 'command',
    title: 'command — uuid, enum, date-time; no defaults',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        action: { enum: ['move', 'cancel', 'confirm'] },
        at: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'action', 'at'],
      additionalProperties: false,
    },
    normalizeOptions: { removeAdditional: true },
    zod4: () => z4.z.object({
      id: z4.z.uuid(),
      action: z4.z.enum(['move', 'cancel', 'confirm']),
      at: z4.z.iso.datetime(),
    }),
    zod3: () => z3.object({
      id: z3.string().uuid(),
      action: z3.enum(['move', 'cancel', 'confirm']),
      at: z3.string().datetime(),
    }),
    zodmini: () => zmini.object({
      id: zmini.uuid(),
      action: zmini.enum(['move', 'cancel', 'confirm']),
      at: zmini.iso.datetime(),
    }),
    wellFormed: { id: UUID, action: 'move', at: WHEN },
    raw: { id: UUID, action: 'move', at: WHEN, stray: 'ignored' },
    invalid: { id: 'not-a-uuid', action: 'explode', at: WHEN },
    expect: { id: UUID, action: 'move', at: WHEN },
  },
  {
    key: 'config',
    title: 'config — defaults and numeric coercion',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        host: { type: 'string', default: 'localhost' },
        port: { type: 'integer', default: 8080 },
        retries: { type: 'integer', default: 3 },
        timeoutMs: { type: 'integer', default: 30000 },
      },
      required: ['host', 'port', 'retries', 'timeoutMs'],
      additionalProperties: false,
    },
    normalizeOptions: { useDefaults: true, removeAdditional: true, coerceTypes: true },
    zod4: () => z4.z.object({
      host: z4.z.string().default('localhost'),
      port: z4.z.coerce.number().int().default(8080),
      retries: z4.z.coerce.number().int().default(3),
      timeoutMs: z4.z.coerce.number().int().default(30000),
    }),
    zod3: () => z3.object({
      host: z3.string().default('localhost'),
      port: z3.coerce.number().int().default(8080),
      retries: z3.coerce.number().int().default(3),
      timeoutMs: z3.coerce.number().int().default(30000),
    }),
    zodmini: () => zmini.object({
      host: zmini._default(zmini.string(), 'localhost'),
      port: zmini._default(zmini.coerce.number().check(zmini.int()), 8080),
      retries: zmini._default(zmini.coerce.number().check(zmini.int()), 3),
      timeoutMs: zmini._default(zmini.coerce.number().check(zmini.int()), 30000),
    }),
    wellFormed: { host: 'localhost', port: 9000, retries: 3, timeoutMs: 30000 },
    raw: { port: '9000', stray: 'ignored' },
    invalid: { port: 'not-a-port', stray: 'ignored' },
    expect: { port: 9000, host: 'localhost', retries: 3, timeoutMs: 30000 },
  },
  {
    key: 'collection',
    title: 'collection — 50 nested records',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', minLength: 1 },
              qty: { type: 'integer', minimum: 1 },
            },
            required: ['sku', 'qty'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    normalizeOptions: { removeAdditional: true },
    zod4: () => z4.z.object({
      items: z4.z.array(z4.z.object({ sku: z4.z.string().min(1), qty: z4.z.number().int().min(1) })),
    }),
    zod3: () => z3.object({
      items: z3.array(z3.object({ sku: z3.string().min(1), qty: z3.number().int().min(1) })),
    }),
    zodmini: () => zmini.object({
      items: zmini.array(zmini.object({
        sku: zmini.string().check(zmini.minLength(1)),
        qty: zmini.number().check(zmini.int(), zmini.minimum(1)),
      })),
    }),
    wellFormed: { items: Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}`, qty: i + 1 })) },
    raw: { items: Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}`, qty: i + 1 })) },
    invalid: { items: Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}`, qty: i === 25 ? 0 : i + 1 })) },
    expect: { items: Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}`, qty: i + 1 })) },
  },
];

//#endregion

//#region adapters
// Each adapter exposes the same four operations so the tables compare the
// same program: compile, verdict, normalize+validate+map, and the neutral
// issue shape `{ path: (string|number)[], code: string }`.

function jarenAdapter(scenario) {
  const validator = new JarenValidator({ collectErrors: true, formatAssertion: true })
    .addFormats(jarenFormats.stringFormats)
    .addFormats(jarenFormats.dateTimeFormats);
  const predicate = new JarenValidator({ formatAssertion: true })
    .addFormats(jarenFormats.stringFormats)
    .addFormats(jarenFormats.dateTimeFormats);
  return {
    compile: (schema) => {
      compileNormalizer(schema, scenario.normalizeOptions);
      predicate.compile(schema);
    },
    build: () => {
      const normalize = compileNormalizer(scenario.schema, scenario.normalizeOptions);
      const check = predicate.compile(scenario.schema);
      const collect = validator.compile(scenario.schema);
      return {
        verdict: (data) => check(data),
        adapt: (data) => {
          const shaped = normalize(data);
          const result = collect(shaped);
          if (result.valid) return { ok: true, value: shaped };
          return {
            ok: false,
            issues: result.errors.map(e => ({
              path: parseJSONPointerPath(e.instancePath),
              code: e.keyword,
            })),
          };
        },
      };
    },
  };
}

function zodAdapter(makeSchema, parse) {
  return (_scenario) => ({
    compile: () => { makeSchema(); },   // Zod builds a fresh schema every call

    build: () => {
      const schema = makeSchema();
      return {
        verdict: (data) => parse(schema, data).success,
        adapt: (data) => {
          const result = parse(schema, data);
          if (result.success) return { ok: true, value: result.data };
          return {
            ok: false,
            issues: result.error.issues.map(i => ({ path: i.path, code: i.code })),
          };
        },
      };
    },
  });
}

function ajvAdapter(scenario) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  // Ajv's normalization is in-place, so the adapter below hands it a copy.
  const ajvNormalizing = new Ajv({
    allErrors: true, strict: false,
    useDefaults: true, removeAdditional: true, coerceTypes: true,
  });
  addFormats(ajvNormalizing);
  return {
    // Ajv caches compiled validators by schema object identity, so a schema
    // object it has seen compiles as a cache hit. Each build drops its entry
    // again (a Map delete, charged to Ajv), so every timed build is a real
    // one however often the pool below repeats an object.
    compile: (schema) => { ajv.compile(schema); ajv.removeSchema(schema); },
    build: () => {
      const check = ajv.compile(scenario.schema);
      const shape = ajvNormalizing.compile(scenario.schema);
      return {
        verdict: (data) => check(data),
        adapt: (data) => {
          const copy = structuredClone(data);
          if (shape(copy)) return { ok: true, value: copy };
          return {
            ok: false,
            issues: shape.errors.map(e => ({
              path: parseJSONPointerPath(e.instancePath),
              code: e.keyword,
            })),
          };
        },
      };
    },
  };
}

const ADAPTERS = {
  jaren: jarenAdapter,
  zod4: (s) => zodAdapter(s.zod4, (schema, data) => schema.safeParse(data))(s),
  zod3: (s) => zodAdapter(s.zod3, (schema, data) => schema.safeParse(data))(s),
  zodmini: (s) => zodAdapter(s.zodmini, (schema, data) => zmini.safeParse(schema, data))(s),
  ajv: ajvAdapter,
};

//#endregion

//#region agreement check

/**
 * Deep equality that ignores member order. Engines append materialized
 * defaults in different places - Jaren after the members that were present,
 * Zod in schema order - and that is a representation difference, not a
 * disagreement about the value.
 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
}

/**
 * An engine is timed only when it agrees on every answer: an already-valid
 * document is accepted, an invalid one is rejected with at least one issue,
 * and normalizing the raw input produces the expected value.
 * @returns {string|null} A reason to drop the engine, or null when it agrees
 */
function disagreement(built, scenario) {
  if (built.verdict(scenario.wellFormed) !== true)
    return 'rejects the well-formed input';
  if (built.verdict(scenario.invalid) !== false)
    return 'accepts the invalid input';
  const ok = built.adapt(scenario.raw);
  if (!ok.ok) return 'adapter rejects the raw input';
  if (!sameValue(ok.value, scenario.expect))
    return `normalizes differently (${JSON.stringify(ok.value)})`;
  const bad = built.adapt(scenario.invalid);
  if (bad.ok) return 'adapter accepts the invalid input';
  if (!Array.isArray(bad.issues) || bad.issues.length === 0)
    return 'reports no issues';
  return null;
}

//#endregion

function printRow(label, value, baseline) {
  let suffix = '';
  if (value !== null && baseline !== null && label !== ENGINE_LABELS.jaren) {
    const ratio = value / baseline;
    suffix = ratio >= 1
      ? `  ${ratio.toFixed(1)}x slower than jaren`
      : `  ${(1 / ratio).toFixed(1)}x FASTER than jaren`;
  }
  const cell = value === null ? 'n/a' : formatNs(value);
  console.log(`  ${pad(label, 20)} ${padLeft(cell, 12)}${suffix}`);
}

/**
 * Build every engine of `engines` for each scenario, then time its rows in
 * this process: every per-call row of every scenario first, then the build
 * rows, whose garbage would otherwise be collected inside the rows after
 * them.
 * @returns {{ results: Record<string, any>, dropped: Record<string, Record<string, string>> }}
 */
function measureHere(options, scenarios, engines) {
  const built = {};
  const dropped = {};
  for (const scenario of scenarios) {
    built[scenario.key] = {};
    dropped[scenario.key] = {};
    for (const key of engines) {
      try {
        const made = ADAPTERS[key](scenario);
        const instance = made.build();
        const reason = disagreement(instance, scenario);
        if (reason === null) built[scenario.key][key] = { made, instance };
        else dropped[scenario.key][key] = reason;
      }
      catch (err) {
        dropped[scenario.key][key] = `threw: ${err.message}`;
      }
    }
  }
  const results = Object.fromEntries(scenarios.map((s) => [s.key, { compile: {}, verdict: {}, adapter: {} }]));
  for (const scenario of scenarios) {
    for (const [key, entry] of Object.entries(built[scenario.key])) {
      results[scenario.key].verdict[key] = measureNs(() => entry.instance.verdict(scenario.wellFormed), options.iterations, 200);
      results[scenario.key].adapter[key] = measureNs(() => entry.instance.adapt(scenario.invalid), options.iterations, 200);
    }
  }
  for (const scenario of scenarios) {
    // Distinct schema objects, as a service compiles each contract once: a
    // schema object an engine has just walked builds faster from the cache,
    // so the pool is large enough that a build never meets a recent one.
    const schemaPool = Array.from({ length: SCHEMA_POOL }, () => structuredClone(scenario.schema));
    for (const [key, entry] of Object.entries(built[scenario.key])) {
      let poolIndex = 0;
      results[scenario.key].compile[key] = measureNs(
        () => entry.made.compile(schemaPool[poolIndex++ % SCHEMA_POOL]),
        Math.max(200, options.iterations >> 6), 20);
    }
  }
  return { results, dropped };
}

/**
 * Run this file once per engine and gather what each process measured.
 * Engines sharing one process slow each other down: zod 4 and zod/mini
 * share a core, and a function called with every engine's objects is
 * optimized for none of them, so each engine is timed in a process of its
 * own, as a service runs one validation library.
 */
function measureEachAlone(options, scenarios, engines, dir) {
  const results = Object.fromEntries(scenarios.map((s) => [s.key, { compile: {}, verdict: {}, adapter: {} }]));
  const dropped = Object.fromEntries(scenarios.map((s) => [s.key, {}]));
  for (const key of engines) {
    const file = join(dir, `${key}.json`);
    child([...filterArgs(options), '--engines', key, '--iterations', String(options.iterations), '--child', '--filepath', file]);
    const alone = JSON.parse(readFileSync(file, 'utf8'));
    for (const scenario of scenarios) {
      for (const table of ['compile', 'verdict', 'adapter']) {
        const value = alone.results[scenario.key][table][key];
        if (value !== undefined) results[scenario.key][table][key] = value;
      }
      const reason = alone.dropped[scenario.key][key];
      if (reason !== undefined) dropped[scenario.key][key] = reason;
    }
  }
  return { results, dropped };
}

/**
 * The warm-up table: each engine builds one scenario's contract in a fresh
 * process and times its first adapter calls, as a service's first requests
 * after a start meet them. The other tables time an engine once it has
 * settled, which can take some engines tens of thousands of calls.
 * @returns {Record<string, Record<string, Record<number, number>>>} scenario -> engine -> calls -> ns/op
 */
function measureColdStarts(scenarios, engines, dropped, dir) {
  const cold = {};
  for (const scenario of scenarios) {
    cold[scenario.key] = {};
    for (const key of engines) {
      if (key in dropped[scenario.key]) continue;
      const starts = [];
      for (let p = 0; p < COLD_PROCESSES; p++) {
        const file = join(dir, `${scenario.key}.${key}.cold${p}.json`);
        child([scenario.key, '--engines', key, '--cold', '--filepath', file]);
        starts.push(JSON.parse(readFileSync(file, 'utf8')));
      }
      cold[scenario.key][key] = Object.fromEntries(COLD_CALLS.map((calls) => [calls, medianOf(starts.map((start) => start[calls]))]));
    }
  }
  return cold;
}

/** In a fresh process: build one engine's adapter for one scenario and time its first calls. */
function coldStart(options, scenarios) {
  const [scenario] = scenarios;
  const [key] = options.engines;
  const instance = ADAPTERS[key](scenario).build();
  const out = {};
  let done = 0;
  let ns = 0;
  for (const calls of COLD_CALLS) {
    const start = process.hrtime.bigint();
    for (; done < calls; done++)
      instance.adapt(scenario.invalid);
    ns += Number(process.hrtime.bigint() - start);
    out[calls] = ns / calls;
  }
  writeFileSync(options.filepath, JSON.stringify(out));
}

/** The middle value of an odd count, or the mean of the middle two. */
function medianOf(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const filterArgs = (options) => (options.filter === null ? [] : [options.filter]);

function child(args) {
  const result = spawnSync(process.execPath, [...process.execArgv, SELF, ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.status !== 0)
    throw new Error(`contracts.js ${args.join(' ')} exited with status ${result.status}`);
}

function main() {
  const options = parseSuiteArgs(process.argv, {
    defaultIterations: DEFAULT_ITERATIONS,
    engines: ENGINES,
    init: { cold: false, child: false, shared: false },
    extra: (arg, _next, opts) => {
      if (arg === '--cold' || arg === '--child' || arg === '--shared') {
        opts[arg.slice(2)] = true;
        return true;
      }
      return false;
    },
  });

  if (options.help) {
    console.log('Usage: node benchmark/contracts.js [scenario] [--iterations n] [--engines a,b] [--shared] [--output json]');
    console.log('  Each engine is timed in a process of its own; --shared times them all in this one.');
    return;
  }

  const scenarios = options.filter
    ? SCENARIOS.filter(s => s.key.includes(options.filter))
    : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`No scenario matches '${options.filter}'`);
    process.exit(2);
  }
  const engines = options.engines.filter((key) => key in ADAPTERS);

  if (options.cold) {
    coldStart(options, scenarios);
    return;
  }
  if (options.child) {
    writeFileSync(options.filepath, JSON.stringify(measureHere(options, scenarios, engines)));
    return;
  }

  console.log('Contract validation — Jaren vs Zod vs Ajv');
  console.log(`Node ${process.version}, ${options.iterations} iterations per cell or more, ${options.shared ? 'every engine in this process' : 'each engine in a process of its own'}\n`);
  console.log('Table 2 (verdict) is NOT apples-to-apples: Jaren answers with a');
  console.log('predicate, Zod has no predicate mode and builds its normalized');
  console.log('output on the way. Table 3 is the comparable one.');

  const isolated = engines.length > 1 && !options.shared;
  const dir = mkdtempSync(join(tmpdir(), 'jaren-contracts-'));
  let measured;
  let cold = null;
  try {
    measured = isolated
      ? measureEachAlone(options, scenarios, engines, dir)
      : measureHere(options, scenarios, engines);
    if (isolated) cold = measureColdStarts(scenarios, engines, measured.dropped, dir);
  }
  finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { results, dropped } = measured;

  for (const scenario of scenarios) {
    console.log(`\n${'='.repeat(72)}\n${scenario.title}\n${'='.repeat(72)}`);
    for (const [key, reason] of Object.entries(dropped[scenario.key]))
      console.log(`  (dropped ${ENGINE_LABELS[key]}: ${reason})`);
    const rows = results[scenario.key];
    const tables = [
      ['1. compile (once per process)', rows.compile],
      ['2. verdict on valid input (see caveat above)', rows.verdict],
      ['3. normalize + validate + map issues, on INVALID input', rows.adapter],
      ...(cold === null ? [] : COLD_CALLS.map((calls) => [
        `4. the first ${calls.toLocaleString('en-US')} adapter calls in a fresh process`,
        Object.fromEntries(Object.entries(cold[scenario.key]).map(([key, byCalls]) => [key, byCalls[calls]])),
      ])),
    ];
    for (const [title, row] of tables) {
      console.log(`\n${title}`);
      const baseline = row.jaren ?? null;
      for (const key of engines) {
        if (!(key in row) && !(key in dropped[scenario.key])) continue;
        printRow(ENGINE_LABELS[key], row[key] ?? null, baseline);
      }
    }
  }

  if (options.output === 'json') {
    // The site's generic table renderer consumes
    // `{ tables: [{ title, columns, rows: [{ name, results[] }] }] }`, so the
    // matrix is transposed here: one table per measurement, one row per
    // scenario, one column per engine. A dropped engine is `null`, which the
    // renderer shows as a dash.
    const measurements = [
      ['compile', 'Compile — once per process'],
      ['verdict', 'Verdict on valid input — see the caveat above'],
      ['adapter', 'Normalize + validate + map issues, on invalid input'],
    ];
    const tables = measurements.map(([key, title]) => ({
      title,
      columns: engines.map((k) => ENGINE_LABELS[k]),
      rows: scenarios.map((s) => ({
        name: s.title,
        results: engines.map((k) => results[s.key][key][k] ?? null),
      })),
    }));
    if (cold !== null) {
      for (const calls of COLD_CALLS) {
        tables.push({
          title: `First ${calls.toLocaleString('en-US')} calls in a fresh process — normalize + validate + map issues, on invalid input`,
          columns: engines.map((k) => ENGINE_LABELS[k]),
          rows: scenarios.map((s) => ({
            name: s.title,
            results: engines.map((k) => cold[s.key][k]?.[calls] ?? null),
          })),
        });
      }
    }
    writeJsonResults('contracts', {
      node: process.version,
      iterations: options.iterations,
      caveat: CAVEAT,
      tables,
    }, options);
  }
}

main();
