//@ts-check
/** Compile JSON protocol declarations to bounded pull-based page execution. */
import { deepFreeze, isJsonObject } from '@jarenjs/core/object';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { ContractCompileError } from '../errors.js';
import { providerHostError } from './execute.js';

const clone = (value) => JSON.parse(canonicalizeJson(value));
const fail = (reason, path = '') => { throw new ContractCompileError('JC0021', reason, path); };

/**
 * Compile selectors/transforms once using the existing Query/JSLT engines.
 * Named callbacks receive cloned protocol data only, never the run host.
 * These are trusted host functions, not a sandbox for arbitrary JavaScript.
 * @param {any} document
 * @param {{ callbacks?: Record<string, (value: any) => any>, compileSchema?: (schema: any) => (value: any) => boolean }} [options]
 */
export function compileProvider(document, options = {}) {
  let doc;
  try { doc = clone(document); }
  catch { fail('provider descriptor must be JSON'); }
  if (!isJsonObject(doc) || doc.$provider !== '0.1') fail('provider descriptor requires $provider:0.1');
  const known = ['id', '$provider', 'apiVersion', 'endpoint', 'protocol', 'method', 'safety', 'headers', 'query', 'body', 'graphql', 'response', 'pagination', 'limits', 'capability', 'inputSchema'];
  for (const key of Object.keys(doc)) if (!known.includes(key)) fail('unknown provider member', `/${key}`);
  for (const name of ['id', 'apiVersion', 'endpoint']) if (typeof doc[name] !== 'string' || !doc[name]) fail(`${name} must be nonempty`, `/${name}`);
  let endpoint;
  try { endpoint = new URL(doc.endpoint); }
  catch { fail('endpoint must be an absolute HTTP(S) URL', '/endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
    fail('endpoint must be HTTP(S), without embedded credentials or a fragment', '/endpoint');
  if (!['rest', 'graphql'].includes(doc.protocol) || !['safe-read', 'provider-idempotent', 'single-send'].includes(doc.safety))
    fail('protocol and replay safety must be declared');
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(doc.method)) fail('unsupported HTTP method', '/method');
  if (doc.headers !== undefined && (!isJsonObject(doc.headers) || Object.entries(doc.headers).some(([name, value]) =>
    typeof value !== 'string' || /authorization|cookie|token|secret|api[-_]key/i.test(name) || /[\r\n]/.test(name + value))))
    fail('headers must be public static strings; authentication belongs to host transport', '/headers');
  if (doc.capability !== undefined && !['json', 'upload', 'media', 'bulk', 'binary'].includes(doc.capability)) fail('unknown capability', '/capability');
  const limits = doc.limits ?? {};
  if (!isJsonObject(limits)) fail('limits must be an object', '/limits');
  for (const [name, fallback] of Object.entries({ pages: 3, rows: 256, bytes: 262144 })) {
    if (limits[name] === undefined) limits[name] = fallback;
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) fail('limits must be positive finite integers', `/limits/${name}`);
  }
  if (Object.keys(limits).some((name) => !['pages', 'rows', 'bytes'].includes(name))) fail('unknown limit', '/limits');
  const pagination = doc.pagination ?? {};
  if (!isJsonObject(pagination) || Object.keys(pagination).some((name) => !['cursorParam', 'cursorVariable', 'empty'].includes(name))
    || (pagination.empty !== undefined && !['complete', 'incomplete'].includes(pagination.empty))) fail('invalid pagination', '/pagination');
  for (const name of ['cursorParam', 'cursorVariable']) if (pagination[name] !== undefined && (typeof pagination[name] !== 'string' || !pagination[name])) fail('cursor target must be nonempty', `/pagination/${name}`);
  if (!isJsonObject(doc.response) || !Object.hasOwn(doc.response, 'rows') || !Object.hasOwn(doc.response, 'id')) fail('response needs rows and id selectors', '/response');
  for (const key of Object.keys(doc.response)) if (!['rows', 'id', 'cursor', 'hasMore', 'errors', 'cost', 'version', 'transform', 'schema'].includes(key)) fail('unknown response member', `/response/${key}`);
  const schema = (value, path) => {
    if (value === undefined) return () => true;
    if (typeof options.compileSchema !== 'function') fail('schema validation requires a declared compiler capability', path);
    try {
      const validate = options.compileSchema(value);
      if (typeof validate !== 'function') fail('schema compiler must return a validator', path);
      return validate;
    }
    catch { fail('schema could not be compiled', path); }
  };
  const validInput = schema(doc.inputSchema, '/inputSchema');
  const validResponse = schema(doc.response.schema, '/response/schema');

  const selector = (spec, path, fallback) => {
    if (spec === undefined) return () => fallback;
    try {
      if (isJsonObject(spec) && Object.hasOwn(spec, 'callback')) {
        if (Object.keys(spec).length !== 1 || typeof spec.callback !== 'string'
          || !Object.hasOwn(options.callbacks ?? {}, spec.callback) || typeof options.callbacks[spec.callback] !== 'function') fail('undeclared callback', path);
        const callback = options.callbacks[spec.callback];
        return (data) => clone(callback(clone(data)));
      }
      return compileJsonQuery(spec);
    }
    catch (error) { if (error instanceof ContractCompileError) throw error; fail('invalid selector', path); }
  };
  const rowsOf = selector(doc.response.rows, '/response/rows', []);
  const idOf = selector(doc.response.id, '/response/id', null);
  const cursorOf = selector(doc.response.cursor, '/response/cursor', null);
  const moreOf = selector(doc.response.hasMore, '/response/hasMore', undefined);
  const errorsOf = selector(doc.response.errors ?? (doc.protocol === 'graphql' ? '$.errors' : undefined), '/response/errors', null);
  const costOf = selector(doc.response.cost, '/response/cost', null);
  const versionOf = selector(doc.response.version, '/response/version', null);
  const queryOf = selector(doc.query, '/query', {});
  const bodyOf = selector(doc.body, '/body', undefined);
  let transform = (row) => row;
  if (doc.response.transform !== undefined) {
    const spec = doc.response.transform;
    if (spec?.kind === 'jslt') {
      try { transform = compileJsltStylesheet(spec.expression); }
      catch { fail('invalid JSLT transform', '/response/transform'); }
    }
    else if (spec?.kind === 'query') transform = selector(spec.expression, '/response/transform', null);
    else if (spec?.callback) transform = selector(spec, '/response/transform', null);
    else fail('transform must name query, jslt or a declared callback', '/response/transform');
  }
  let variablesOf;
  if (doc.protocol === 'graphql') {
    if (doc.method !== 'POST' || !isJsonObject(doc.graphql) || typeof doc.graphql.query !== 'string' || !doc.graphql.query.trim()
      || Object.keys(doc.graphql).some((name) => !['query', 'variables'].includes(name))) fail('GraphQL requires POST and a query with optional variables', '/graphql');
    variablesOf = selector(doc.graphql.variables, '/graphql/variables', {});
  }
  else if (doc.graphql !== undefined) fail('graphql belongs to the GraphQL dialect', '/graphql');
  if (['GET', 'HEAD'].includes(doc.method) && doc.body !== undefined) fail('GET/HEAD cannot carry a body', '/body');
  deepFreeze(doc);

  /** @param {any} input @param {any} context */
  async function* pages(input, context) {
    if (!context || typeof context.executor?.execute !== 'function') throw providerHostError('provider pages require an executor');
    let pageCount = 0, rowCount = 0, byteCount = 0, attempts = 0;
    let cursor = context.cursor ?? null;
    const cursors = new Set(cursor === null ? [] : [canonicalizeJson(cursor)]);
    const ids = new Set();
    const end = (state, reason) => ({ state, reason, pages: pageCount, rows: rowCount, bytes: byteCount, attempts, cursor });
    if (doc.capability && doc.capability !== 'json') { yield end('refused', 'unsupported-capability'); return; }
    if (!validInput(input)) { yield end('refused', 'input-schema'); return; }
    for (;;) {
      if (context.signal?.aborted) { yield end('incomplete', 'cancelled'); return; }
      if (pageCount >= limits.pages) { yield end('incomplete', 'page-limit'); return; }
      const data = { input: clone(input), cursor, apiVersion: doc.apiVersion, partition: context.partition ?? null, sourceVersion: context.sourceVersion ?? null };
      let request;
      try {
        const url = new URL(doc.endpoint);
        const query = queryOf(data);
        if (!isJsonObject(query)) throw new Error('query must return an object');
        for (const [name, value] of Object.entries(query)) {
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('query values must be scalar');
          if (value !== null) url.searchParams.set(name, String(value));
        }
        if (cursor !== null && pagination.cursorParam) url.searchParams.set(pagination.cursorParam, String(cursor));
        let body = bodyOf(data);
        if (doc.protocol === 'graphql') {
          const variables = clone(variablesOf(data));
          if (!isJsonObject(variables)) throw new Error('variables must be an object');
          if (pagination.cursorVariable) Object.defineProperty(variables, pagination.cursorVariable, { value: cursor, enumerable: true, configurable: true, writable: true });
          body = { query: doc.graphql.query, variables };
        }
        request = { url: url.href, method: doc.method, headers: { ...doc.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: canonicalizeJson(body) }), safety: doc.safety,
          account: context.account, idempotencyKey: context.idempotencyKey };
      }
      catch { yield end('refused', 'request-transform'); return; }
      const response = await context.executor.execute(request, { ...context, maxBytes: limits.bytes - byteCount });
      attempts += response.attempts;
      byteCount += response.bytes;
      if (response.state !== 'ok') { yield { ...end(response.state === 'refused' && response.reason !== 'byte-limit' ? 'refused' : 'incomplete', response.reason), response }; return; }
      if (byteCount > limits.bytes) { yield end('incomplete', 'byte-limit'); return; }
      let raw, rows, rowIds, next, hasMore, errors, cost, version;
      try {
        raw = JSON.parse(response.text);
        if (!validResponse(raw)) throw new Error('response schema failed');
        rows = rowsOf(raw);
        if (!Array.isArray(rows)) throw new Error('rows must be an array');
        rowIds = rows.map((row) => idOf(row));
        if (rowIds.some((id) => (typeof id !== 'string' || !id) && (typeof id !== 'number' || !Number.isSafeInteger(id)))) throw new Error('ids must be nonempty strings or safe integers');
        rows = rows.map((row) => clone(transform(clone(row))));
        next = cursorOf(raw) ?? null;
        if (next !== null && !['string', 'number'].includes(typeof next)) throw new Error('cursor must be a scalar');
        hasMore = moreOf(raw);
        if (hasMore !== undefined && typeof hasMore !== 'boolean') throw new Error('hasMore must be boolean');
        hasMore ??= next !== null;
        errors = errorsOf(raw) ?? null;
        cost = costOf(raw) ?? null;
        version = versionOf(raw) ?? null;
      }
      catch { yield { ...end('incomplete', 'response-transform'), text: response.text }; return; }
      pageCount++;
      rowCount += rows.length;
      let reason = null;
      if (errors !== null && (!Array.isArray(errors) || errors.length)) reason = 'partial-errors';
      else if (rowCount > limits.rows) reason = 'row-limit';
      else if (!rows.length && (hasMore || pagination.empty !== 'complete')) reason = 'empty-page';
      else if (rowIds.some((id) => ids.has(canonicalizeJson(id))) || new Set(rowIds.map((id) => canonicalizeJson(id))).size !== rowIds.length) reason = 'no-progress';
      else if (hasMore && (next === null || cursors.has(canonicalizeJson(next)))) reason = 'no-progress';
      const complete = reason === null && !hasMore;
      yield { state: 'page', raw, text: response.text, rows, ids: rowIds, cursor, continuation: hasMore ? next : null,
        complete, errors, cost, version, reason, bytes: response.bytes, attempts: response.attempts };
      if (reason !== null) { yield end('incomplete', reason); return; }
      if (complete) { yield end('complete', 'complete'); return; }
      for (const id of rowIds) ids.add(canonicalizeJson(id));
      cursors.add(canonicalizeJson(next));
      cursor = next;
    }
  }
  return Object.freeze({
    document: doc,
    pages,
    /** Collect a bounded pull; streaming consumers should iterate pages instead.
     * @param {any} input @param {any} context @returns {Promise<any>} */
    async pull(input, context) {
      const observations = [];
      for await (const page of pages(input, context)) {
        if (page.state === 'page') observations.push(page);
        else return { ...page, observations };
      }
    },
  });
}
