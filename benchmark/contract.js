#!/usr/bin/env node

/**
 * Contract benchmark — @jarenjs/contract vs find-my-way, hono and Fastify
 *
 * The rival here is not another JSON Schema engine, it is the routing and
 * dispatch stack a Node service actually runs. Four tables, because one
 * number cannot honestly cover a contract layer:
 *
 *   1. **match** — ns per route lookup over a real 123-route table
 *      (47 GET), probed round-robin with 8 requests: static hot paths,
 *      variable paths, the static-vs-variable specificity case
 *      (`/api/production-runs/prefill` beside `…/:id`) and a miss.
 *      Rivals: find-my-way (Fastify's router), hono's TrieRouter and
 *      SmartRouter, and a naive Map-plus-regex-scan — what a consumer
 *      writes by hand.
 *   2. **dispatch, in-process** — µs per request for the whole pipeline
 *      (route + decode + validate + handler + validate output +
 *      serialize) on three request shapes: a PUT with a 5-formulation ×
 *      4-ingredient JSON body, a GET with a coerced query string, and a
 *      bare GET.
 *   3. **dispatch, over loopback** — the same three shapes through real
 *      `node:http` servers on 127.0.0.1 and one keep-alive fetch client,
 *      sequential. The same code path for both engines, so no harness
 *      asymmetry.
 *   4. **revision** — ms to compute the contract revision of the 123-op
 *      document (SHA-256 over the canonical public projection).
 *      Informational: paid once per process.
 *
 * Fairness decisions, stated rather than buried:
 *
 * - **hono's RegExpRouter refuses this route table** and is therefore
 *   reported in the caveat with its error text rather than timed: the
 *   table registers a static path after a param sibling
 *   (`/api/enrichments/approve-all` after `/api/enrichments/:id/decide`),
 *   which that router does not support. SmartRouter consequently falls
 *   back to its TrieRouter on this table.
 * - **`fastify.inject` is Fastify's own harness** (light-my-request): it
 *   builds mock request/response streams per call, so table 2's Fastify
 *   column includes that cost and is not a pure router+validator figure.
 *   That is why the **harness-free rival** column exists — find-my-way +
 *   Ajv + fast-json-stringify called directly, the exact pieces Fastify
 *   composes — and why table 3 measures both stacks over a real socket
 *   where neither has a harness.
 * - **Each rival takes its fastest route.** Fastify validates with its
 *   own compiled Ajv and serializes responses with fast-json-stringify
 *   (`schema.response`); the direct rival uses the same two libraries
 *   without the framework; hono is timed at its router layer because its
 *   app layer does no validation to compare.
 * - **Every engine is checked before it is timed.** Table 1 engines must
 *   agree on all 8 probes (hit/miss, matched route and params) or they
 *   are dropped as a mismatch; table 2/3 engines must answer the same
 *   status and byte-parseable body for every request shape.
 * - **@jarenjs/contract validates the response before it leaves** (the
 *   server-broke-the-contract check, 500 on failure). The rivals do not
 *   have that behavior to buy; the `validateOutput: 'never'` column is
 *   the same pipeline with the check declared off, so its cost is
 *   visible instead of averaged away.
 *
 * Usage:
 *   node benchmark/contract.js
 *   node benchmark/contract.js --iterations 2000
 *   node benchmark/contract.js match
 *   node benchmark/contract.js --output json --filepath contract.json
 */

import http from 'node:http';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { toNodeHandler } from '@jarenjs/contract/node';

import FindMyWay from 'find-my-way';
import { TrieRouter } from 'hono/router/trie-router';
import { SmartRouter } from 'hono/router/smart-router';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import Fastify from 'fastify';
import Ajv from 'ajv/dist/2020.js';
import fastJson from 'fast-json-stringify';

import { ROUTES, PROBES, routesToContract, opId } from '../test/contract/helpers.js';
import { pad, padLeft, formatNs } from './lib/fmt.js';
import { measureNsPerOp as measureNs } from './lib/measure.js';
import { parseSuiteArgs } from './lib/args.js';
import { writeJsonResults } from './lib/results.js';

const DEFAULT_ITERATIONS = 20_000;

//#region fixtures — the 123-route table, three real request shapes

const GRAPH_ID = opId('PUT', '/api/recipe-versions/:id/graph');
const SEARCH_ID = opId('GET', '/api/taxonomy/search');
const CATALOG_ID = opId('GET', '/api/catalog');

/** The 5×4 body of the PUT: 5 formulations of 4 ingredients each. */
const GRAPH_BODY = {
  formulations: Array.from({ length: 5 }, (_, f) => ({
    id: f + 1,
    name: `formulation-${f + 1}`,
    ingredients: Array.from({ length: 4 }, (_, i) => ({
      sku: `SKU-${f}-${i}`, qty: (i + 1) * 0.5, unit: 'kg',
    })),
  })),
};

const GRAPH_SCHEMA = {
  type: 'object',
  required: ['formulations'],
  properties: {
    formulations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'ingredients'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sku', 'qty', 'unit'],
              properties: { sku: { type: 'string' }, qty: { type: 'number' }, unit: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const GRAPH_OUTPUT = {
  type: 'object',
  required: ['id', 'graph'],
  properties: { id: { type: 'string' }, graph: GRAPH_SCHEMA },
  additionalProperties: false,
};

const SEARCH_QUERY = {
  type: 'object',
  required: ['q', 'limit'],
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
};

const SEARCH_OUTPUT = {
  type: 'object',
  required: ['query', 'limit', 'items'],
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer' },
    items: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
};

const OK_OUTPUT = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
  additionalProperties: false,
};

/**
 * The dispatch contract: the full 123-route table, with the three
 * measured operations carrying real input/output schemas — the pipeline
 * still routes among 123 operations, as a deployment would.
 */
function dispatchDocument() {
  const doc = routesToContract(ROUTES);
  doc.operations[GRAPH_ID] = {
    kind: 'command',
    input: {
      type: 'object',
      required: ['id', 'graph'],
      properties: { id: { type: 'string' }, graph: GRAPH_SCHEMA },
    },
    output: GRAPH_OUTPUT,
    http: { method: 'PUT', path: '/api/recipe-versions/:id/graph', body: 'graph' },
  };
  doc.operations[SEARCH_ID] = {
    kind: 'read',
    input: SEARCH_QUERY,
    output: SEARCH_OUTPUT,
    http: { method: 'GET', path: '/api/taxonomy/search' },
  };
  doc.operations[CATALOG_ID] = {
    kind: 'read',
    output: OK_OUTPUT,
    http: { method: 'GET', path: '/api/catalog' },
  };
  return doc;
}

/** The three request shapes, as plain dispatch requests. */
const REQUESTS = [
  {
    name: 'PUT recipe-versions/77/graph — 5×4 JSON body',
    method: 'PUT',
    url: '/api/recipe-versions/77/graph',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(GRAPH_BODY),
    expect: { id: '77', graph: GRAPH_BODY },
  },
  {
    name: 'GET taxonomy/search?q=x&limit=20 — coerced query',
    method: 'GET',
    url: '/api/taxonomy/search?q=x&limit=20',
    headers: {},
    body: null,
    expect: { query: 'x', limit: 20, items: [] },
  },
  {
    name: 'GET catalog — bare route',
    method: 'GET',
    url: '/api/catalog',
    headers: {},
    body: null,
    expect: { ok: true },
  },
];

/** The handlers of the three measured operations. */
const HANDLERS = {
  [GRAPH_ID]: (/** @type {any} */ input) => ({ id: input.id, graph: input.graph }),
  [SEARCH_ID]: (/** @type {any} */ input) => ({ query: input.q, limit: input.limit, items: [] }),
  [CATALOG_ID]: () => ({ ok: true }),
};

//#endregion

//#region table 1 — match

/**
 * Each engine: `{ lookup(method, path) → { key, params } | null }`,
 * built over the same 123 routes with the operation id as the payload.
 * @type {Record<string, () => { lookup: (method: string, path: string) => { key: string, params: Record<string, string> } | null }>}
 */
const MATCH_ENGINES = {
  '@jarenjs/contract': () => {
    const contract = compileContract(routesToContract(ROUTES));
    return {
      lookup: (method, path) => {
        const hit = contract.match(method, path);
        return hit === null ? null : { key: hit.op.id, params: hit.params };
      },
    };
  },
  'find-my-way': () => {
    const router = FindMyWay();
    for (const [method, path] of ROUTES) router.on(method, path, () => {}, { key: opId(method, path) });
    return {
      lookup: (method, path) => {
        const hit = router.find(/** @type {any} */ (method), path);
        return hit === null ? null : { key: /** @type {any} */ (hit.store).key, params: /** @type {any} */ (hit.params) };
      },
    };
  },
  'hono TrieRouter': () => honoEngine(new TrieRouter()),
  'hono SmartRouter': () => honoEngine(new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] })),
  'naive Map + regex scan': () => {
    // what a consumer writes by hand: exact statics in a Map, params as
    // a linear regex scan in registration order — and, like most
    // hand-rolled routers, no percent-decoding of the captured params
    // (jaren's matcher decodes; that cost is included in its column)
    const statics = new Map();
    /** @type {{ method: string, re: RegExp, names: string[], key: string }[]} */
    const scans = [];
    for (const [method, path] of ROUTES) {
      const key = opId(method, path);
      if (!path.includes(':')) {
        statics.set(`${method} ${path}`, key);
        continue;
      }
      /** @type {string[]} */
      const names = [];
      const re = new RegExp('^' + path.split('/').map((seg) => {
        if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(seg.slice(1));
        return '([^/]+)';
      }).join('/') + '$');
      scans.push({ method, re, names, key });
    }
    return {
      lookup: (method, path) => {
        const exact = statics.get(`${method} ${path}`);
        if (exact !== undefined) return { key: exact, params: {} };
        for (const route of scans) {
          if (route.method !== method) continue;
          const m = route.re.exec(path);
          if (m === null) continue;
          /** @type {Record<string, string>} */
          const params = {};
          for (let i = 0; i < route.names.length; i++) params[route.names[i]] = m[i + 1];
          return { key: route.key, params };
        }
        return null;
      },
    };
  },
};

/**
 * A hono router behind the shared lookup shape. hono returns either
 * `[[handler, params][]]` or `[[handler, paramIndexMap][], paramStash]`
 * depending on the concrete router; both are decoded here.
 * @param {any} router
 */
function honoEngine(router) {
  for (const [method, path] of ROUTES) router.add(method, path, opId(method, path));
  return {
    lookup: (/** @type {string} */ method, /** @type {string} */ path) => {
      const result = router.match(method, path);
      const hits = result[0];
      if (hits.length === 0) return null;
      const [key, paramsOrIndex] = hits[0];
      const stash = result[1];
      if (stash === undefined) return { key, params: paramsOrIndex };
      /** @type {Record<string, string>} */
      const params = {};
      for (const name of Object.keys(paramsOrIndex)) params[name] = stash[paramsOrIndex[name]];
      return { key, params };
    },
  };
}

/**
 * An engine must resolve all 8 probes exactly — hit/miss, the matched
 * operation and the decoded params — or it is dropped, not timed.
 * @param {{ lookup: (method: string, path: string) => { key: string, params: Record<string, string> } | null }} engine
 * @returns {string | null} the disagreement, or null
 */
function matchDisagreement(engine) {
  for (const probe of PROBES) {
    const hit = engine.lookup(probe.method, probe.path);
    if (probe.key === null) {
      if (hit !== null) return `matches the miss probe ${probe.method} ${probe.path}`;
      continue;
    }
    if (hit === null) return `misses ${probe.method} ${probe.path}`;
    if (hit.key !== probe.key) return `resolves ${probe.path} to ${hit.key}, expected ${probe.key}`;
    const expected = JSON.stringify(probe.params);
    const got = JSON.stringify({ ...hit.params });
    if (got !== expected) return `params of ${probe.path}: ${got}, expected ${expected}`;
  }
  return null;
}

/**
 * @param {ReturnType<typeof parseSuiteArgs>} options
 * @returns {{ table: any, caveats: string[] }}
 */
function runMatchTable(options) {
  /** @type {string[]} */
  const caveats = [];
  try {
    const regexp = honoEngine(new RegExpRouter());
    regexp.lookup('GET', '/api/catalog');
    caveats.push('hono RegExpRouter unexpectedly accepted the table this run; it is still not timed.');
  }
  catch (err) {
    caveats.push(`hono RegExpRouter REFUSES this route table and is reported instead of timed: ${/** @type {Error} */ (err).name}: ${/** @type {Error} */ (err).message}.`);
  }

  const lookups = options.iterations * 100; // 20k default iterations → 2M timed lookups
  const warmup = Math.max(1, lookups / 10);
  console.log(`\n${'='.repeat(72)}\n1. match — 123 routes, 8 probes round-robin, ${lookups.toLocaleString()} lookups\n${'='.repeat(72)}`);
  for (const caveat of caveats) console.log(`  (${caveat})`);

  const columns = [];
  const results = [];
  let baseline = null;
  for (const [label, make] of Object.entries(MATCH_ENGINES)) {
    const engine = make();
    const reason = matchDisagreement(engine);
    if (reason !== null) {
      console.log(`  (dropped ${label}: ${reason})`);
      columns.push(label);
      results.push(null);
      continue;
    }
    const probes = PROBES;
    let i = 0;
    const ns = measureNs(() => {
      const probe = probes[i];
      engine.lookup(probe.method, probe.path);
      i = (i + 1) & 7;
    }, lookups, warmup);
    columns.push(label);
    results.push(ns);
    if (label === '@jarenjs/contract') baseline = ns;
    printRow(label, ns, baseline, label === '@jarenjs/contract');
  }

  return {
    caveats,
    table: {
      title: 'Route match — 123 routes, ns per lookup',
      columns,
      rows: [{ name: 'round-robin probe mix (7 hits + 1 miss)', results }],
    },
  };
}

//#endregion

//#region table 2 — dispatch, in-process

/** @param {any} value */
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Build the three in-process dispatch engines plus the output-unvalidated
 * jaren column. Each answers `run(request) → Promise<{ status, body }>`.
 */
async function buildDispatchEngines() {
  const doc = dispatchDocument();
  const contract = compileContract(doc);
  /** @type {Record<string, any>} */
  const handlers = {};
  for (const id of contract.ids) handlers[id] = HANDLERS[id] ?? (() => true);
  const validated = serveHttp(contract, handlers);
  const unvalidated = serveHttp(compileContract(doc), handlers, { validateOutput: 'never' });

  const fastify = Fastify({ logger: false });
  fastify.route({
    method: 'PUT', url: '/api/recipe-versions/:id/graph',
    schema: { body: GRAPH_SCHEMA, response: { 200: GRAPH_OUTPUT } },
    handler: async (req) => ({ id: /** @type {any} */ (req.params).id, graph: req.body }),
  });
  fastify.route({
    method: 'GET', url: '/api/taxonomy/search',
    schema: { querystring: SEARCH_QUERY, response: { 200: SEARCH_OUTPUT } },
    handler: async (req) => ({ query: /** @type {any} */ (req.query).q, limit: /** @type {any} */ (req.query).limit, items: [] }),
  });
  fastify.route({
    method: 'GET', url: '/api/catalog',
    schema: { response: { 200: OK_OUTPUT } },
    handler: async () => ({ ok: true }),
  });
  for (const [method, path] of ROUTES) {
    if ((method === 'PUT' && path === '/api/recipe-versions/:id/graph')
      || (method === 'GET' && (path === '/api/taxonomy/search' || path === '/api/catalog'))) continue;
    fastify.route({ method, url: path, handler: async () => true });
  }
  await fastify.ready();

  // the harness-free rival: the exact pieces Fastify composes, called
  // directly — find-my-way routes, Ajv validates (a coercing instance
  // for the query, like Fastify's), fast-json-stringify serializes
  const router = FindMyWay();
  const ajv = new Ajv({ allErrors: false, strict: false });
  const ajvCoercing = new Ajv({ allErrors: false, strict: false, coerceTypes: true });
  const validateGraph = ajv.compile(GRAPH_SCHEMA);
  const validateSearch = ajvCoercing.compile(SEARCH_QUERY);
  const outGraph = fastJson(/** @type {any} */ (GRAPH_OUTPUT));
  const outSearch = fastJson(/** @type {any} */ (SEARCH_OUTPUT));
  const outOk = fastJson(/** @type {any} */ (OK_OUTPUT));
  router.on('PUT', '/api/recipe-versions/:id/graph', () => {}, {
    run: (/** @type {any} */ params, /** @type {string | null} */ body) => {
      const graph = JSON.parse(/** @type {string} */ (body));
      if (!validateGraph(graph)) return { status: 400, body: '{"error":"invalid"}' };
      return { status: 200, body: outGraph({ id: params.id, graph }) };
    },
  });
  router.on('GET', '/api/taxonomy/search', () => {}, {
    run: (/** @type {any} */ _params, /** @type {string | null} */ _body, /** @type {string} */ queryString) => {
      /** @type {Record<string, string>} */
      const query = {};
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
      if (!validateSearch(query)) return { status: 400, body: '{"error":"invalid"}' };
      return { status: 200, body: outSearch({ query: query.q, limit: query.limit, items: [] }) };
    },
  });
  router.on('GET', '/api/catalog', () => {}, {
    run: () => ({ status: 200, body: outOk({ ok: true }) }),
  });
  for (const [method, path] of ROUTES) {
    if ((method === 'PUT' && path === '/api/recipe-versions/:id/graph')
      || (method === 'GET' && (path === '/api/taxonomy/search' || path === '/api/catalog'))) continue;
    router.on(method, path, () => {}, { run: () => ({ status: 200, body: 'true' }) });
  }

  return {
    contract,
    fastify,
    engines: /** @type {Record<string, (request: typeof REQUESTS[0]) => Promise<{ status: number, body: string }>>} */ ({
      '@jarenjs/contract': async (request) => {
        const r = await validated.dispatch({ method: request.method, url: request.url, headers: request.headers, body: request.body });
        return { status: r.status, body: /** @type {string} */ (r.body) };
      },
      'fastify inject': async (request) => {
        const r = await fastify.inject({
          method: /** @type {any} */ (request.method), url: request.url,
          headers: request.headers, payload: request.body ?? undefined,
        });
        return { status: r.statusCode, body: r.body };
      },
      'find-my-way + Ajv + fjs': async (request) => {
        const q = request.url.indexOf('?');
        const path = q === -1 ? request.url : request.url.slice(0, q);
        const hit = router.find(/** @type {any} */ (request.method), path);
        if (hit === null) return { status: 404, body: '{"error":"not found"}' };
        return /** @type {any} */ (hit.store).run(hit.params, request.body, q === -1 ? '' : request.url.slice(q + 1));
      },
      "@jarenjs/contract (validateOutput: 'never')": async (request) => {
        const r = await unvalidated.dispatch({ method: request.method, url: request.url, headers: request.headers, body: request.body });
        return { status: r.status, body: /** @type {string} */ (r.body) };
      },
    }),
  };
}

/** Structural equality over parsed JSON (member order is representation). */
function sameJson(/** @type {any} */ a, /** @type {any} */ b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(a[k], b[k]));
}

/**
 * @param {Record<string, (request: typeof REQUESTS[0]) => Promise<{ status: number, body: string }>>} engines
 * @returns {Promise<Record<string, string>>} label → disagreement, for the dropped
 */
async function dispatchDisagreements(engines) {
  /** @type {Record<string, string>} */
  const dropped = {};
  for (const [label, run] of Object.entries(engines)) {
    for (const request of REQUESTS) {
      const r = await run(request);
      if (r.status !== 200) {
        dropped[label] = `${request.name}: status ${r.status}`;
        break;
      }
      if (!sameJson(JSON.parse(r.body), request.expect)) {
        dropped[label] = `${request.name}: ${r.body.slice(0, 120)}`;
        break;
      }
    }
  }
  return dropped;
}

/**
 * @param {Record<string, (request: typeof REQUESTS[0]) => Promise<{ status: number, body: string }>>} engines
 * @param {ReturnType<typeof parseSuiteArgs>} options
 */
async function runDispatchTable(engines, options) {
  console.log(`\n${'='.repeat(72)}\n2. dispatch, in-process — ${options.iterations.toLocaleString()} requests per cell\n${'='.repeat(72)}`);
  const dropped = await dispatchDisagreements(engines);
  for (const [label, reason] of Object.entries(dropped)) console.log(`  (dropped ${label}: ${reason})`);

  const columns = Object.keys(engines);
  const rows = [];
  for (const request of REQUESTS) {
    console.log(`\n${request.name}`);
    const results = [];
    let baseline = null;
    for (const label of columns) {
      if (label in dropped) {
        results.push(null);
        continue;
      }
      const run = engines[label];
      const ns = await measureNsAsync(() => run(request), options.iterations, Math.max(200, options.iterations >> 4));
      results.push(ns);
      if (label === '@jarenjs/contract') baseline = ns;
      printRow(label, ns, baseline, label === '@jarenjs/contract');
    }
    rows.push({ name: request.name, results });
  }
  return { title: 'Dispatch, in-process — ns per request (route + validate + handler + serialize)', columns, rows };
}

/**
 * ns/op for an async operation, awaited each call.
 * @param {() => Promise<any>} fn
 * @param {number} iterations
 * @param {number} warmup
 */
async function measureNsAsync(fn, iterations, warmup) {
  for (let i = 0; i < warmup; i++) await fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  return Number(process.hrtime.bigint() - start) / iterations;
}

/**
 * Where table 2's time goes for the jaren pipeline: the serialization
 * share — `JSON.stringify` of each response value alone, beside the
 * whole dispatch. This is the number that schedules (or drops) a
 * schema-driven serializer.
 * @param {Record<string, (request: typeof REQUESTS[0]) => Promise<{ status: number, body: string }>>} engines
 * @param {any} table2
 */
async function measureSerialization(engines, table2) {
  const rows = [];
  const jarenColumn = table2.columns.indexOf('@jarenjs/contract');
  for (let i = 0; i < REQUESTS.length; i++) {
    const request = REQUESTS[i];
    const value = clone(request.expect);
    const stringifyNs = measureNs(() => JSON.stringify(value), 200_000, 20_000);
    const dispatchNs = table2.rows[i].results[jarenColumn];
    rows.push({
      name: request.name,
      stringifyNs,
      dispatchNs,
      share: dispatchNs === null ? null : stringifyNs / dispatchNs,
    });
  }
  console.log('\nSerialization share of the @jarenjs/contract request (JSON.stringify of the response value alone):');
  for (const row of rows) {
    console.log(`  ${pad(row.name, 48)} ${padLeft(formatNs(row.stringifyNs), 10)} of ${padLeft(formatNs(row.dispatchNs), 10)}  (${row.share === null ? 'n/a' : (row.share * 100).toFixed(1) + '%'})`);
  }
  return rows;
}

//#endregion

//#region table 3 — dispatch over loopback

/**
 * Both stacks behind real sockets; one keep-alive fetch client;
 * sequential requests. The same code path for both — no harness.
 * @param {any} built
 * @param {ReturnType<typeof parseSuiteArgs>} options
 */
async function runLoopbackTable(built, options) {
  const iterations = options.iterations;
  console.log(`\n${'='.repeat(72)}\n3. dispatch, over loopback — 127.0.0.1, ${iterations.toLocaleString()} sequential requests per cell\n${'='.repeat(72)}`);

  const doc = dispatchDocument();
  const contract = compileContract(doc);
  /** @type {Record<string, any>} */
  const handlers = {};
  for (const id of contract.ids) handlers[id] = HANDLERS[id] ?? (() => true);
  const jarenServer = http.createServer(toNodeHandler(serveHttp(contract, handlers)));
  await new Promise((resolve) => jarenServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  const jarenPort = /** @type {any} */ (jarenServer.address()).port;

  const fastify = built.fastify;
  await fastify.listen({ host: '127.0.0.1', port: 0 });
  const fastifyPort = /** @type {any} */ (fastify.server.address()).port;

  /** @param {number} port @param {typeof REQUESTS[0]} request */
  const once = async (port, request) => {
    const r = await fetch(`http://127.0.0.1:${port}${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return { status: r.status, body: await r.text() };
  };

  const columns = ['@jarenjs/contract over node:http', 'fastify'];
  const ports = [jarenPort, fastifyPort];
  const rows = [];
  for (const request of REQUESTS) {
    console.log(`\n${request.name}`);
    const results = [];
    let baseline = null;
    for (let e = 0; e < columns.length; e++) {
      const answer = await once(ports[e], request);
      if (answer.status !== 200 || !sameJson(JSON.parse(answer.body), request.expect)) {
        console.log(`  (dropped ${columns[e]}: status ${answer.status}, ${answer.body.slice(0, 120)})`);
        results.push(null);
        continue;
      }
      const ns = await measureNsAsync(() => once(ports[e], request), iterations, Math.max(100, iterations >> 4));
      results.push(ns);
      if (e === 0) baseline = ns;
      printRow(columns[e], ns, baseline, e === 0);
    }
    rows.push({ name: request.name, results });
  }

  await new Promise((resolve) => jarenServer.close(() => resolve(undefined)));
  await fastify.close();
  return { title: 'Dispatch, over loopback — ns per request (node:http, keep-alive fetch, sequential)', columns, rows };
}

//#endregion

//#region table 4 — revision

/** Fresh compiles, one digest each; the mean is the once-per-process cost. */
async function runRevisionTable() {
  console.log(`\n${'='.repeat(72)}\n4. revision — SHA-256 over the canonical public projection, once per process\n${'='.repeat(72)}`);
  const doc = routesToContract(ROUTES);
  const runs = 10;
  let total = 0n;
  for (let i = 0; i < runs; i++) {
    const contract = compileContract(doc);
    const start = process.hrtime.bigint();
    await contract.revision();
    total += process.hrtime.bigint() - start;
  }
  const ns = Number(total) / runs;
  console.log(`  ${pad('123-operation contract', 40)} ${padLeft(formatNs(ns), 12)}  (mean of ${runs} fresh compiles)`);
  return {
    title: 'Revision — ns to compute, informational (paid once per process)',
    columns: ['@jarenjs/contract'],
    rows: [{ name: `contract.revision() of the 123-operation document (mean of ${runs})`, results: [ns] }],
  };
}

//#endregion

/**
 * @param {string} label
 * @param {number | null} value
 * @param {number | null} baseline
 * @param {boolean} isBaseline
 */
function printRow(label, value, baseline, isBaseline) {
  let suffix = '';
  if (value !== null && baseline !== null && !isBaseline) {
    const ratio = value / baseline;
    suffix = ratio >= 1
      ? `  ${ratio.toFixed(1)}x slower than jaren`
      : `  ${(1 / ratio).toFixed(1)}x FASTER than jaren`;
  }
  console.log(`  ${pad(label, 40)} ${padLeft(value === null ? 'n/a' : formatNs(value), 12)}${suffix}`);
}

async function main() {
  const options = parseSuiteArgs(process.argv, {
    defaultIterations: DEFAULT_ITERATIONS,
    engines: [],
  });
  if (options.help) {
    console.log('Usage: node benchmark/contract.js [match|dispatch|loopback|revision] [--iterations n] [--output json --filepath f]');
    return;
  }
  const wants = (/** @type {string} */ name) => options.filter === null || name.includes(options.filter);

  console.log('Contract — @jarenjs/contract vs find-my-way, hono and Fastify');
  console.log(`Node ${process.version}, ${options.iterations} iterations per dispatch cell`);
  console.log('\nfastify inject is Fastify\'s own harness (mock streams included);');
  console.log('the find-my-way + Ajv + fast-json-stringify column is the harness-free');
  console.log('rival, and table 3 puts both stacks behind real sockets.');

  const tables = [];
  /** @type {string[]} */
  let caveats = [];
  let serialization = null;

  if (wants('match')) {
    const match = runMatchTable(options);
    tables.push(match.table);
    caveats = match.caveats;
  }
  if (wants('dispatch') || wants('loopback')) {
    const built = await buildDispatchEngines();
    if (wants('dispatch')) {
      const table2 = await runDispatchTable(built.engines, options);
      tables.push(table2);
      serialization = await measureSerialization(built.engines, table2);
    }
    if (wants('loopback')) tables.push(await runLoopbackTable(built, options));
    else await built.fastify.close();
  }
  if (wants('revision')) tables.push(await runRevisionTable());

  if (options.output === 'json') {
    writeJsonResults('contract', {
      caveat: 'fastify inject is Fastify\'s own request harness (light-my-request builds mock request/response streams per call), so its in-process column is not a pure router+validator figure; the find-my-way + Ajv + fast-json-stringify column is the same pieces with no harness, and the loopback table drives both stacks through real sockets. '
        + (caveats.length > 0 ? caveats.join(' ') : ''),
      tables,
      serialization,
    }, options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
