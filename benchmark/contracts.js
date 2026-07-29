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
 * Three tables, because one number cannot honestly cover this:
 *
 *   1. **Compile** — turning a contract into something callable. Paid once at
 *      startup, so it is the least important of the three; it is here because
 *      it is where Jaren is slowest and hiding it would be dishonest.
 *   2. **Verdict** — the cheapest "is this valid?" each engine can give for
 *      input that IS valid.
 *   3. **Adapter** — the shape a real service runs: normalize the input,
 *      validate it, and map failures to a library-neutral issue list. Timed
 *      on INVALID input, because that is the path that allocates.
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

import { pad, padLeft, formatNs } from './lib/fmt.js';
import { measureNsPerOp as measureNs } from './lib/measure.js';
import { parseSuiteArgs } from './lib/args.js';
import { writeJsonResults } from './lib/results.js';

const z3 = z3mod.z;
const DEFAULT_ITERATIONS = 50_000;
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
    // Ajv caches compiled validators by schema object identity, so this must
    // be handed a distinct object each call or it measures a cache hit.
    compile: (schema) => { ajv.compile(schema); },
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

function main() {
  const options = parseSuiteArgs(process.argv, {
    defaultIterations: DEFAULT_ITERATIONS,
    engines: ENGINES,
  });

  if (options.help) {
    console.log('Usage: node benchmark/contracts.js [scenario] [--iterations n] [--engines a,b] [--output json]');
    return;
  }

  const scenarios = options.filter
    ? SCENARIOS.filter(s => s.key.includes(options.filter))
    : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`No scenario matches '${options.filter}'`);
    process.exit(2);
  }

  console.log('Contract validation — Jaren vs Zod vs Ajv');
  console.log(`Node ${process.version}, ${options.iterations} iterations per cell\n`);
  console.log('Table 2 (verdict) is NOT apples-to-apples: Jaren answers with a');
  console.log('predicate, Zod has no predicate mode and builds its normalized');
  console.log('output on the way. Table 3 is the comparable one.');

  const results = {};

  for (const scenario of scenarios) {
    // Distinct schema objects so an engine that caches by identity (Ajv) is
    // measured compiling, not looking up.
    const schemaPool = Array.from({ length: 64 }, () => structuredClone(scenario.schema));
    const built = {};
    const dropped = {};
    for (const key of options.engines) {
      const adapter = ADAPTERS[key];
      if (adapter === undefined) continue;
      try {
        const made = adapter(scenario);
        const instance = made.build();
        const reason = disagreement(instance, scenario);
        if (reason !== null) { dropped[key] = reason; continue; }
        built[key] = { made, instance };
      }
      catch (err) {
        dropped[key] = `threw: ${err.message}`;
      }
    }

    console.log(`\n${'='.repeat(72)}\n${scenario.title}\n${'='.repeat(72)}`);
    for (const [key, reason] of Object.entries(dropped))
      console.log(`  (dropped ${ENGINE_LABELS[key]}: ${reason})`);

    const rows = { compile: {}, verdict: {}, adapter: {} };
    for (const [key, entry] of Object.entries(built)) {
      let poolIndex = 0;
      rows.compile[key] = measureNs(
        () => entry.made.compile(schemaPool[poolIndex++ % schemaPool.length]),
        Math.max(200, options.iterations >> 6), 20);
      rows.verdict[key] = measureNs(() => entry.instance.verdict(scenario.wellFormed), options.iterations, 200);
      rows.adapter[key] = measureNs(() => entry.instance.adapt(scenario.invalid), options.iterations, 200);
    }

    const tables = [
      ['1. compile (once per process)', rows.compile],
      ['2. verdict on valid input (see caveat above)', rows.verdict],
      ['3. normalize + validate + map issues, on INVALID input', rows.adapter],
    ];
    for (const [title, row] of tables) {
      console.log(`\n${title}`);
      const baseline = row.jaren ?? null;
      for (const key of options.engines) {
        if (!(key in row) && !(key in dropped)) continue;
        printRow(ENGINE_LABELS[key], row[key] ?? null, baseline);
      }
    }

    results[scenario.key] = rows;
  }

  if (options.output === 'json') {
    writeJsonResults('contracts', {
      node: process.version,
      iterations: options.iterations,
      scenarios: results,
    }, options);
  }
}

main();
