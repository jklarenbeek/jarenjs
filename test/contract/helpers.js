//@ts-check
/**
 * @file Shared fixtures for the contract tests: the partner's 123-route
 * table as a `$contract` document (one operation per `[method, path]`,
 * `:id`-style templates left as written so canonicalization is
 * exercised), the 8 routing probes with their expected hits, and the
 * loaders.
 */

import { readFileSync } from 'node:fs';

/** @param {string} rel */
export const load = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

/** @type {[string, string][]} */
export const ROUTES = load('./fixtures/wms-routes.json');

/**
 * The 8 probes: static hot paths, variable paths, the static-vs-variable
 * specificity case, and a miss. `key` is the operation id the probe must
 * resolve to (`null` for a miss), `params` the decoded bindings.
 * @type {{ method: string, path: string, key: string | null, params: Record<string, string> }[]}
 */
export const PROBES = [
  { method: 'GET', path: '/api/catalog', key: opId('GET', '/api/catalog'), params: {} },
  { method: 'GET', path: '/api/products/12345', key: opId('GET', '/api/products/:id'), params: { id: '12345' } },
  { method: 'PUT', path: '/api/recipe-versions/77/graph', key: opId('PUT', '/api/recipe-versions/:id/graph'), params: { id: '77' } },
  { method: 'GET', path: '/api/production-runs/prefill', key: opId('GET', '/api/production-runs/prefill'), params: {} },
  { method: 'GET', path: '/api/production-runs/42', key: opId('GET', '/api/production-runs/:id'), params: { id: '42' } },
  { method: 'PATCH', path: '/api/variants/9/inventory-locations/1001', key: opId('PATCH', '/api/variants/:id/inventory-locations/:warehouseitemId'), params: { id: '9', warehouseitemId: '1001' } },
  { method: 'POST', path: '/api/warehouse/corrections', key: opId('POST', '/api/warehouse/corrections'), params: {} },
  { method: 'GET', path: '/api/nope/404', key: null, params: {} },
];

/**
 * A deterministic operation id for a route: the lowercased method and
 * every segment reduced to `[a-z0-9]` (a variable contributes its name),
 * dotted — `PUT /api/recipe-versions/:id/graph` → `put.api.recipeversions.id.graph`.
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
export function opId(method, path) {
  const parts = [method.toLowerCase()];
  for (const seg of path.split('/').slice(1)) {
    const word = (seg.startsWith(':') ? seg.slice(1) : seg).toLowerCase().replace(/[^a-z0-9]/g, '');
    parts.push(word);
  }
  return parts.join('.');
}

/**
 * The variable names of a `:name`-style route, in order.
 * @param {string} path
 * @returns {string[]}
 */
export function variablesOf(path) {
  return path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
}

/**
 * Build a `$contract` document from `[method, path]` pairs: GET/HEAD are
 * reads, everything else a command; every path variable is a string
 * member of `input.properties`; `output` is `true`.
 * @param {[string, string][]} routes
 * @returns {any}
 */
export function routesToContract(routes) {
  /** @type {Record<string, any>} */
  const operations = {};
  const seen = new Set();
  for (const [method, path] of routes) {
    const id = opId(method, path);
    if (seen.has(id)) throw new Error(`fixture id collision: ${id}`);
    seen.add(id);
    const variables = variablesOf(path);
    /** @type {any} */
    const op = {
      kind: method === 'GET' || method === 'HEAD' ? 'read' : 'command',
      output: true,
      http: { method, path },
    };
    if (variables.length > 0) {
      op.input = {
        type: 'object',
        required: variables,
        properties: Object.fromEntries(variables.map((v) => [v, { type: 'string' }])),
      };
    }
    operations[id] = op;
  }
  return { $contract: '0.1', id: 'wms', operations };
}

//#region http

/**
 * The shop fixture's default handlers — every operation answers
 * something valid; a test overrides the ones it exercises.
 * @returns {Record<string, (input: any, ctx: any) => any>}
 */
export function shopHandlers() {
  return {
    'catalog.load': () => ({ revision: 1, products: [{ id: 1, name: 'a', price: 1 }] }),
    'product.save': (input) => ({ id: input.id, name: input.product.name, price: input.product.price }),
    'image.bytes': () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) }),
    'product.search': (input) => [{ id: 1, name: input.q ?? 'n', price: input.limit ?? 0 }],
    'product.remove': () => true,
  };
}

/**
 * A request object for `dispatch`: lowercase header names, `null` body by
 * default.
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string | string[]>} [headers]
 * @param {string | Uint8Array | null} [body]
 */
export function req(method, url, headers = {}, body = null) {
  return { method, url, headers, body };
}

/**
 * A JSON request: the body serialized, `content-type` set.
 * @param {string} method
 * @param {string} url
 * @param {unknown} value
 * @param {Record<string, string | string[]>} [headers]
 */
export function jsonReq(method, url, value, headers = {}) {
  return req(method, url, { 'content-type': 'application/json', ...headers }, JSON.stringify(value));
}

/**
 * The parsed JSON body of a response (`null` for no body).
 * @param {{ body: string | Uint8Array | null }} response
 */
export function json(response) {
  return response.body === null ? null : JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
}

//#endregion
