//@ts-check
/**
 * @file `toOpenApi`: the public projection of a compiled contract as a
 * valid, deterministic OpenAPI 3.1 document (docs/CONTRACT-FORMAT.md
 * §12.2), in two stages that each own one concern:
 *
 *  1. **The keyword policy** (this file, JavaScript) walks every schema
 *     the projection carries and maps it into the OpenAPI 3.1 dialect —
 *     `#/$defs/X` → `#/components/schemas/X`, `nullable: true` → `null`
 *     in `type` — or refuses what it cannot map honestly (`JC0060`: a
 *     boolean `required`, a `components` member inside a schema, a
 *     same-document `$ref` that lands outside `$defs`) or drops and
 *     REPORTS what is Jaren-side (`$query`, `$data`, `errorMessage`,
 *     `x-form` and other `x-*`) in the `dropped` list with the `docPath`
 *     of the keyword in the contract document. Nothing unsupported passes
 *     through silently. It also derives, per operation, the facts a
 *     document cannot carry for a `$ref` input — the member table with
 *     each member's location, requiredness and effective schema — from
 *     the compiled operation.
 *  2. **The stylesheet** (`openapi.jslt.json`, a JSLT document compiled
 *     once at module scope) shapes the document: `paths` grouped by
 *     canonical path and sorted by path then method, the operation
 *     object in a fixed member order, parameters, the request body, the
 *     success response, the declared errors grouped by status into
 *     wire-error schemas (`code` enum-pinned, `details` the declared
 *     schema), the binding's own statuses as shared
 *     `components.responses`, `components.schemas` from `$defs`, and the
 *     `x-jaren-policy` extension.
 *
 * Rendered twice, the document is byte-identical; a test validates it
 * against the vendored OpenAPI 3.1 meta-schema with `JarenValidator`.
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { ContractCompileError, ContractHostError, CONTRACT_CODES } from '../errors.js';
import { HTTP_ERRORS } from '../http/wire.js';
import { publicProjection, retainedOperations } from './public.js';
import OPENAPI_STYLESHEET from './openapi.jslt.json' with { type: 'json' };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 */

/**
 * One keyword the projection dropped, with where it was.
 * @typedef {Object} DroppedKeyword
 * @property {string} docPath - JSON Pointer of the keyword in the contract document
 * @property {string} keyword
 * @property {string} reason
 */

/**
 * @typedef {Object} OpenApiOptions
 * @property {{ title?: string, version?: string, [k: string]: unknown }} [info] -
 *   the `info` object; `title` defaults to the contract id, `version` to
 *   the contract version
 * @property {{ url: string, description?: string }[]} [servers] - the `servers` array, verbatim
 * @property {boolean} [lenient=false] - drop and report a boolean `required`
 *   and an unmappable same-document `$ref` instead of refusing (`JC0060`)
 */

/**
 * @typedef {Object} OpenApiResult
 * @property {Record<string, unknown>} document - the OpenAPI 3.1 document
 * @property {DroppedKeyword[]} dropped - every keyword the keyword policy removed
 */

/** The stylesheet, compiled once. */
const render = compileJsltStylesheet(OPENAPI_STYLESHEET, { compileTypeTest: createTypeTestCompiler() });

/** Jaren-side keywords the OpenAPI dialect has no reading for — dropped and reported. */
const JAREN_KEYWORDS = new Set(['$query', '$data', 'errorMessage']);
/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = new Set([
  'items', 'additionalItems', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema',
]);
/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
/** Keywords whose value is a map of schemas (the keys are names, never keywords). */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
/** Keywords whose value is data, copied verbatim. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'example']);

const COMPONENT_REF = '#/components/schemas/';

/**
 * The binding's own responses, shared by every operation they apply to
 * (`components.responses`): name → status, the taxonomy codes the binding
 * answers with that status, and when the response applies. Built from
 * `HTTP_ERRORS`, the single source of the statuses.
 * @type {readonly { name: string, status: number, codes: readonly string[], when: 'always' | 'body' | 'idempotent' }[]}
 */
const SHARED_RESPONSES = Object.freeze([
  { name: 'BadRequest', status: 400, codes: codesWithStatus(400), when: 'always' },
  { name: 'NotFound', status: 404, codes: codesWithStatus(404), when: 'always' },
  { name: 'IdempotencyConflict', status: 409, codes: codesWithStatus(409), when: 'idempotent' },
  { name: 'PayloadTooLarge', status: 413, codes: codesWithStatus(413), when: 'always' },
  { name: 'UnsupportedMediaType', status: 415, codes: codesWithStatus(415), when: 'body' },
  { name: 'InternalError', status: 500, codes: codesWithStatus(500), when: 'always' },
]);

/**
 * The taxonomy codes answered with a status, in code order.
 * @param {number} status
 * @returns {string[]}
 */
function codesWithStatus(status) {
  const out = [];
  const codes = Object.keys(HTTP_ERRORS);
  for (let i = 0; i < codes.length; i++) {
    if (HTTP_ERRORS[/** @type {keyof typeof HTTP_ERRORS} */ (codes[i])].status === status) out.push(codes[i]);
  }
  return out;
}

/**
 * @param {string} base
 * @param {string | number} key
 * @returns {string}
 */
function at(base, key) {
  return `${base}/${encodeJSONPointerSegment(key)}`;
}

//#region the keyword policy

/**
 * @typedef {Object} MapContext
 * @property {boolean} lenient
 * @property {DroppedKeyword[]} dropped
 * @property {Set<string>} defs - the `$defs` names the projection carries
 * @property {Map<object, any>} mapped - source schema node → its mapped
 *   copy; every node is mapped once (the projection's roots cover every
 *   member), so a member's mapped schema is a lookup, and a keyword is
 *   reported once
 */

/**
 * @param {MapContext} ctx
 * @param {string} docPath
 * @param {string} keyword
 * @param {string} reason
 */
function drop(ctx, docPath, keyword, reason) {
  ctx.dropped.push({ docPath: at(docPath, keyword), keyword, reason });
}

/**
 * Refuse a keyword (`JC0060`), or under `lenient` drop and report it.
 * @param {MapContext} ctx
 * @param {string} docPath
 * @param {string} keyword
 * @param {string} reason
 * @param {boolean} lenientDrops - whether `lenient` may drop it (a `components` member never)
 */
function refuseOrDrop(ctx, docPath, keyword, reason, lenientDrops) {
  if (ctx.lenient && lenientDrops) {
    drop(ctx, docPath, keyword, reason);
    return;
  }
  throw new ContractCompileError('JC0060', `the OpenAPI projection cannot carry '${keyword}' here: ${reason}`
    + (lenientDrops ? ' (toOpenApi({ lenient: true }) drops it and reports it in `dropped`)' : ''), at(docPath, keyword));
}

/**
 * Map a same-document reference to its place in the OpenAPI document.
 * `#/$defs/X…` becomes `#/components/schemas/X…`; anything else inside the
 * document (`#`, an anchor, a pointer into an operation) has no place
 * there — refused, or dropped under `lenient`. An absolute reference is
 * kept as written. Returns `undefined` for a dropped reference.
 * @param {string} ref
 * @param {string} docPath - of the schema node
 * @param {MapContext} ctx
 * @returns {string | undefined}
 */
function mapRef(ref, docPath, ctx) {
  if (!ref.startsWith('#')) return ref;
  if (ref.startsWith('#/$defs/')) {
    const rest = ref.slice('#/$defs/'.length);
    const slash = rest.indexOf('/');
    const name = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash)).replaceAll('~1', '/').replaceAll('~0', '~');
    if (ctx.defs.has(name)) return COMPONENT_REF + rest;
  }
  refuseOrDrop(ctx, docPath, '$ref',
    `the same-document reference '${ref}' lands outside the projection's $defs and would not resolve in the OpenAPI document — keep shared schemas in $defs`,
    true);
  return undefined;
}

/**
 * Add `'null'` to a `type` for `nullable: true`; `undefined` when `type`
 * is absent (then `nullable` says nothing the dialect can carry).
 * @param {unknown} type
 * @returns {unknown}
 */
function nullableType(type) {
  if (typeof type === 'string') return type === 'null' ? type : [type, 'null'];
  if (Array.isArray(type)) return type.includes('null') ? type : [...type, 'null'];
  return undefined;
}

/**
 * Map one schema (object, boolean, or whatever the document carries) into
 * the OpenAPI 3.1 dialect. Fresh objects throughout; data keywords are
 * shared as they are.
 * @param {any} node
 * @param {string} docPath
 * @param {MapContext} ctx
 * @returns {any}
 */
function mapSchema(node, docPath, ctx) {
  if (!isJsonObject(node)) return node;
  const seen = ctx.mapped.get(node);
  if (seen !== undefined) return seen;
  /** @type {Record<string, any>} */
  const out = {};
  ctx.mapped.set(node, out);
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = node[key];
    if (key === '$ref' && typeof value === 'string') {
      const mapped = mapRef(value, docPath, ctx);
      if (mapped !== undefined) out.$ref = mapped;
      continue;
    }
    if (key === 'nullable') {
      if (value === true) {
        const type = nullableType(node.type);
        if (type === undefined) drop(ctx, docPath, key, 'nullable: true without a type — OpenAPI 3.1 carries nullability in type, and there is none to widen');
        else out.type = type;
      }
      else drop(ctx, docPath, key, 'asserts nothing in OpenAPI 3.1 (only nullable: true maps, to "null" in type)');
      continue;
    }
    if (key === 'type' && node.nullable === true && nullableType(value) !== undefined) {
      out.type = nullableType(value);
      continue;
    }
    if (key === 'required' && typeof value === 'boolean') {
      refuseOrDrop(ctx, docPath, key, 'a boolean required (draft-04 style) has no meaning in OpenAPI 3.1 — declare the member in the parent\'s required array', true);
      continue;
    }
    if (key === 'components') {
      refuseOrDrop(ctx, docPath, key, 'a components member inside a schema is an OpenAPI document member, not a schema keyword', false);
      continue;
    }
    if (JAREN_KEYWORDS.has(key) || key.startsWith('x-')) {
      drop(ctx, docPath, key, 'a Jaren-side keyword the OpenAPI dialect has no reading for');
      continue;
    }
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
      continue;
    }
    if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = mapSchema(value, at(docPath, key), ctx);
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      const arr = new Array(value.length);
      for (let j = 0; j < value.length; j++) arr[j] = mapSchema(value[j], at(at(docPath, key), j), ctx);
      out[key] = arr;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
      /** @type {Record<string, any>} */
      const map = {};
      const names = Object.keys(value);
      for (let j = 0; j < names.length; j++) {
        setObjectMember(map, names[j], mapSchema(value[names[j]], at(at(docPath, key), names[j]), ctx));
      }
      out[key] = map;
      continue;
    }
    if (key === 'dependencies' && isJsonObject(value)) {
      /** @type {Record<string, any>} */
      const map = {};
      const names = Object.keys(value);
      for (let j = 0; j < names.length; j++) {
        const dep = value[names[j]];
        setObjectMember(map, names[j], Array.isArray(dep) ? dep : mapSchema(dep, at(at(docPath, key), names[j]), ctx));
      }
      out[key] = map;
      continue;
    }
    out[key] = value;
  }
  return out;
}

//#endregion

//#region the operation view

/**
 * The first line of a doc string, and whether there is more.
 * @param {string} doc
 * @returns {{ summary: string, long: boolean }}
 */
function docLines(doc) {
  const nl = doc.indexOf('\n');
  if (nl === -1) return { summary: doc.trim(), long: false };
  return { summary: doc.slice(0, nl).trim(), long: doc.slice(nl + 1).trim().length > 0 };
}

/**
 * The stylesheet's view of one operation: the projection's own members
 * plus what only the compiled operation knows — the member table (name,
 * location, requiredness, effective schema), the body, the success
 * response and the declared errors with string statuses, and the shared
 * binding responses that apply.
 * @param {CompiledOperation} op
 * @param {Record<string, any>} projected - the operation's public projection, schemas mapped
 * @param {MapContext} ctx
 * @returns {Record<string, unknown>}
 */
function operationView(op, projected, ctx) {
  const base = at('/operations', op.id);
  const http = op.http;
  /** @type {{ name: string, in: string, required: boolean, schema: any }[]} */
  const parameters = [];
  /** @type {Record<string, any>} */
  const bodyMembers = {};
  /** @type {string[]} */
  const bodyRequired = [];
  let bodyCount = 0;
  let bodyMemberRequired = false;
  const eff = effectiveInput(op);
  const declaredRequired = eff !== null && Array.isArray(eff.required) ? /** @type {unknown[]} */ (eff.required) : [];
  const members = Object.keys(http.in);
  for (let i = 0; i < members.length; i++) {
    const name = members[i];
    const loc = http.in[name];
    // the member's schema as the projection mapped it: the effective
    // input's property (the projection's `input` may be a $ref — the
    // compiled operation resolved it), already walked as part of the
    // input or of the $defs entry it lives in; a member of a registered
    // external schema is mapped here, at the input's docPath
    const mapped = mappedMember(effectiveMemberSchema(op, name), at(base, 'input'), ctx);
    const required = loc === 'path' || declaredRequired.includes(name);
    if (loc === 'body') {
      setObjectMember(bodyMembers, name, mapped);
      if (required) bodyRequired.push(name);
      bodyCount++;
      if (name === http.body) bodyMemberRequired = required;
    }
    else parameters.push({ name, in: loc, required, schema: mapped });
  }
  if (op.policy.idempotency !== 'none') {
    parameters.push({
      name: 'Idempotency-Key', in: 'header', required: op.policy.idempotency === 'required',
      schema: { type: 'string', minLength: 1 },
      description: 'The caller-generated idempotency key the server deduplicates this command on (policy.idempotency '
        + op.policy.idempotency + ').',
    });
  }
  /** @type {Record<string, unknown> | undefined} */
  let body;
  if (http.body !== null) {
    body = { media: http.media, required: bodyMemberRequired, schema: bodyMembers[http.body] };
  }
  else if (bodyCount > 0) {
    const whole = bodyCount === members.length;
    /** @type {Record<string, unknown>} */
    let schema;
    if (whole) schema = projected.input;
    else {
      schema = { type: 'object', properties: bodyMembers };
      if (bodyRequired.length > 0) schema.required = bodyRequired;
      if (eff !== null && eff.additionalProperties !== undefined) {
        schema.additionalProperties = mappedMember(eff.additionalProperties, at(base, 'input'), ctx);
      }
    }
    body = { media: http.media, required: bodyRequired.length > 0, schema };
  }
  /** @type {Record<string, unknown>} */
  const success = { status: String(http.status), media: http.media };
  if (http.status !== 204 && http.method !== 'HEAD') {
    success.schema = http.opaque ? { type: 'string', format: 'binary' } : projected.output;
  }
  /** @type {Record<string, unknown>[]} */
  const errors = [];
  const codes = Object.keys(op.errors);
  for (let i = 0; i < codes.length; i++) {
    const decl = op.errors[codes[i]];
    /** @type {Record<string, unknown>} */
    const e = { code: codes[i], status: String(decl.status), declared: true };
    if (decl.schema !== null) e.schema = projected.errors[codes[i]].schema;
    errors.push(e);
  }
  for (let i = 0; i < SHARED_RESPONSES.length; i++) {
    const shared = SHARED_RESPONSES[i];
    if (shared.when === 'body' && body === undefined) continue;
    if (shared.when === 'idempotent' && op.policy.idempotency === 'none') continue;
    for (let j = 0; j < shared.codes.length; j++) {
      errors.push({ code: shared.codes[j], status: String(shared.status), declared: false, shared: shared.name });
    }
  }
  /** @type {Record<string, unknown>} */
  const view = { id: op.id, tag: op.id.split('.')[0], method: http.method.toLowerCase(), path: http.path };
  if (op.doc !== null) {
    const lines = docLines(op.doc);
    if (lines.summary !== '') view.summary = lines.summary;
    if (lines.long) view.description = op.doc;
  }
  view.parameters = parameters;
  if (body !== undefined) view.body = body;
  view.success = success;
  view.errors = errors;
  view.policy = policyExtension(op);
  return view;
}

/**
 * The effective input schema of an operation — the declared `input` with
 * its `$ref` chain followed — or `null` for an input-less operation.
 * @param {CompiledOperation} op
 * @returns {any}
 */
function effectiveInput(op) {
  return op.input === null ? null : op.input.effective;
}

/**
 * The mapped copy of a schema node the projection has walked (a member of
 * an input, or of the `$defs` entry a `$ref` input resolves to); a node
 * it has not — a member of a registered external schema — is mapped now,
 * reported at `docPath`.
 * @param {any} schema
 * @param {string} docPath
 * @param {MapContext} ctx
 * @returns {any}
 */
function mappedMember(schema, docPath, ctx) {
  if (!isJsonObject(schema)) return schema;
  const seen = ctx.mapped.get(schema);
  return seen !== undefined ? seen : mapSchema(schema, docPath, ctx);
}

/**
 * The declared schema of a body-located member, read from the effective
 * input (the projection's `input` may be a `$ref`; the compiled operation
 * resolved it).
 * @param {CompiledOperation} op
 * @param {string} name
 * @returns {any}
 */
function effectiveMemberSchema(op, name) {
  const eff = effectiveInput(op);
  return eff !== null && isJsonObject(eff.properties) ? eff.properties[name] : undefined;
}

/**
 * The `x-jaren-policy` extension: the client-facing policy verbatim.
 * @param {CompiledOperation} op
 * @returns {Record<string, unknown>}
 */
function policyExtension(op) {
  const p = op.policy;
  /** @type {Record<string, unknown>} */
  const out = { task: p.task, idempotency: p.idempotency, cache: p.cache };
  if (p.revision !== null) out.revision = p.revision;
  if (p.retry !== null) out.retry = { max: p.retry.max, on: p.retry.on.slice() };
  return out;
}

//#endregion

/**
 * Project a compiled contract to an OpenAPI 3.1 document.
 * @param {Contract} contract
 * @param {OpenApiOptions} [options]
 * @returns {OpenApiResult}
 * @throws {ContractHostError} `JC1008` — not a compiled contract, or a malformed option
 * @throws {ContractCompileError} `JC0060` — a schema keyword the projection refuses (see `lenient`)
 * @example
 * const { document, dropped } = toOpenApi(contract, { info: { title: 'Shop', version: '5' } });
 * document.paths['/api/catalog'].get.operationId; // 'catalog.load'
 */
export function toOpenApi(contract, options = {}) {
  if (!isJsonObject(options)) throw new ContractHostError('JC1008', 'toOpenApi: options must be an object');
  const ops = retainedOperations(contract, undefined, 'toOpenApi');
  const lenient = options.lenient === undefined ? false : options.lenient;
  if (typeof lenient !== 'boolean') throw new ContractHostError('JC1008', 'toOpenApi: options.lenient must be a boolean');
  if (options.info !== undefined && !isJsonObject(options.info)) {
    throw new ContractHostError('JC1008', 'toOpenApi: options.info must be an object { title, version, ... }');
  }
  if (options.servers !== undefined) {
    if (!Array.isArray(options.servers)) throw new ContractHostError('JC1008', 'toOpenApi: options.servers must be an array of { url, description? }');
    for (let i = 0; i < options.servers.length; i++) {
      const s = options.servers[i];
      if (!isJsonObject(s) || typeof s.url !== 'string') {
        throw new ContractHostError('JC1008', `toOpenApi: options.servers[${i}] must be { url: string, description? }`);
      }
    }
  }
  /** @type {Record<string, unknown>} */
  const info = { ...options.info };
  if (typeof info.title !== 'string') info.title = contract.id === null ? 'jaren-contract' : contract.id;
  if (typeof info.version !== 'string') info.version = contract.version === null ? '0' : contract.version;

  const pub = /** @type {any} */ (publicProjection(contract));
  /** @type {MapContext} */
  const ctx = { lenient, dropped: [], defs: new Set(Object.keys(pub.$defs ?? {})), mapped: new Map() };

  /** @type {Record<string, any>} */
  const schemas = {};
  const defNames = Object.keys(pub.$defs ?? {});
  for (let i = 0; i < defNames.length; i++) {
    setObjectMember(schemas, defNames[i], mapSchema(pub.$defs[defNames[i]], at('/$defs', defNames[i]), ctx));
  }
  /** @type {Record<string, unknown>[]} */
  const operations = [];
  /** @type {Set<string>} */
  const sharedUsed = new Set();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const base = at('/operations', op.id);
    const src = pub.operations[op.id];
    // walked in document order — $defs first, then per operation input,
    // output, errors — so `dropped` reads like the document
    /** @type {Record<string, any>} */
    const projected = { input: undefined, output: undefined, errors: {} };
    if (src.input !== undefined) projected.input = mapSchema(src.input, at(base, 'input'), ctx);
    projected.output = mapSchema(src.output, at(base, 'output'), ctx);
    const codes = Object.keys(src.errors ?? {});
    for (let j = 0; j < codes.length; j++) {
      const decl = src.errors[codes[j]];
      setObjectMember(projected.errors, codes[j], {
        schema: decl.schema === undefined ? undefined : mapSchema(decl.schema, at(at(at(base, 'errors'), codes[j]), 'schema'), ctx),
      });
    }
    const view = operationView(op, projected, ctx);
    for (const e of /** @type {any[]} */ (view.errors)) if (e.shared !== undefined) sharedUsed.add(e.shared);
    operations.push(view);
  }
  /** @type {Record<string, unknown>} */
  const shared = {};
  for (let i = 0; i < SHARED_RESPONSES.length; i++) {
    const s = SHARED_RESPONSES[i];
    if (!sharedUsed.has(s.name)) continue;
    shared[s.name] = {
      status: String(s.status),
      codes: s.codes.slice(),
      description: `Answered by the binding, not the handler — ${s.codes.map((c) => `${c}: ${CONTRACT_CODES[/** @type {keyof typeof CONTRACT_CODES} */ (c)]}`).join('; ')}.`,
    };
  }
  const input = {
    info,
    servers: options.servers === undefined ? [] : options.servers,
    schemas,
    operations,
    shared,
  };
  const document = /** @type {Record<string, unknown>} */ (render(input));
  return { document, dropped: ctx.dropped };
}
