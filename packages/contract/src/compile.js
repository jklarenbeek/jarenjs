//@ts-check
/**
 * @file `compileContract`: a `$contract` document (docs/CONTRACT-FORMAT.md
 * §2) becomes a frozen `Contract` — per-operation validators, transport
 * normalizers, the materialized HTTP binding with every default resolved,
 * and one path matcher over the operation table.
 *
 * Two stages, like every compiler in the suite: everything is decided
 * here, once; nothing that runs per request allocates or re-reads the
 * document. The document is TRUSTED input but is still read totally: it
 * is first snapshotted through guarded access into plain JSON (a
 * throwing accessor, a non-JSON member or a cycle is `JC0001` at the
 * member), then validated rule by rule against a CLOSED vocabulary
 * (`JC0013` — a silently ignored `policy` member is a behavior bug), and
 * only then compiled. Every refusal is a `ContractCompileError` with the
 * `docPath` of the member at fault.
 *
 * `$ref` resolution rides the validator: the document is registered under
 * a synthetic id and each operation schema is compiled as a `$ref` into
 * it, so `#/$defs/Product` means the contract's own `$defs` and an
 * absolute `$id` means one of `options.schemas`. Unresolved is `JC0007`
 * at compile — never at request time.
 */

import { isJsonObject, setObjectMember, deepFreeze } from '@jarenjs/core/object';
import { JarenValidator } from '@jarenjs/validate';
import {
  compileNormalizer, collectSameDocumentAnchors, resolveSameDocumentRef,
} from '@jarenjs/validate/normalize';
import { encodeJSONPointerSegment, parseJSONPointer } from '@jarenjs/json/pointer';

import { ContractCompileError } from './errors.js';
import { parsePathTemplate, pathShape, compileRoutes } from './path.js';
import { describeContract } from './describe.js';

//#region vocabulary

const CONTRACT_VERSION = '0.1';

const ROOT_MEMBERS = new Set(['$contract', 'id', 'version', 'compat', '$defs', 'operations']);
const OP_MEMBERS = new Set(['kind', 'input', 'output', 'errors', 'policy', 'http', 'doc']);
const POLICY_MEMBERS = new Set(['task', 'idempotency', 'revision', 'cache', 'limits', 'errors', 'retry', 'audience']);
const LIMITS_MEMBERS = new Set(['maxBodyBytes']);
const POLICY_ERRORS_MEMBERS = new Set(['details']);
const RETRY_MEMBERS = new Set(['max', 'on']);
const HTTP_MEMBERS = new Set(['method', 'path', 'in', 'body', 'status', 'media']);
const ERROR_DECL_MEMBERS = new Set(['status', 'schema']);

const KINDS = Object.freeze(['read', 'command']);
const TASKS = Object.freeze(['switch', 'exhaust', 'concat', 'parallel']);
const IDEMPOTENCY = Object.freeze(['none', 'optional', 'required']);
const CACHE = Object.freeze(['none', 'revision']);
const DETAILS = Object.freeze(['none', 'paths', 'full']);
const AUDIENCES = Object.freeze(['public', 'server']);
const METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const LOCATIONS = Object.freeze(['path', 'query', 'header', 'body']);

const DEFAULT_MAX_BODY_BYTES = 1048576;
const DEFAULT_MEDIA = 'application/json';
const DEFAULT_STATUS = 200;
const DEFAULT_ERROR_STATUS = 400;

/** The contract `id`: an identifier that may carry hyphens. */
const CONTRACT_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** An operation id: dotted lowercase words. */
const OP_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;
/** A declared error code: a lowercase hyphenated word. */
const ERROR_CODE = /^[a-z][a-z0-9-]*$/;
/** A media type: `type/subtype` with optional parameters. */
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;.*)?$/;

/** JSON-value keywords whose content is data, not schema — not walked for `$ref`. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/** One synthetic `$id` per compile, so a shared validator never sees two documents under one name. */
let compileSequence = 0;

//#endregion

//#region helpers

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} docPath
 * @param {Error} [cause]
 * @returns {ContractCompileError}
 */
function refuse(code, reason, docPath, cause) {
  return new ContractCompileError(code, reason, docPath, cause);
}

/**
 * @param {unknown} v
 * @returns {Error | undefined}
 */
function asCause(v) {
  return v instanceof Error ? v : undefined;
}

/**
 * Append one reference token to a JSON Pointer.
 * @param {string} base
 * @param {string | number} key
 * @returns {string}
 */
function at(base, key) {
  return `${base}/${encodeJSONPointerSegment(key)}`;
}

/**
 * A URI fragment addressing `pointer` inside the registered document.
 * Reference tokens are RFC 6901-escaped and then percent-encoded, which
 * the validator decodes; `~` is unreserved so `~0`/`~1` survive.
 * @param {(string | number)[]} tokens
 * @returns {string}
 */
function fragment(tokens) {
  let out = '#';
  for (let i = 0; i < tokens.length; i++) {
    out += '/' + encodeURIComponent(encodeJSONPointerSegment(tokens[i]));
  }
  return out;
}

/**
 * True for a JSON Schema value: an object or a boolean.
 * @param {unknown} v
 * @returns {boolean}
 */
function isSchema(v) {
  return typeof v === 'boolean' || isJsonObject(v);
}

/**
 * Whether a media type carries JSON: `application/json` or any `+json`
 * structured syntax suffix; parameters are ignored.
 * @param {string} media
 * @returns {boolean}
 */
function isJsonMedia(media) {
  const semi = media.indexOf(';');
  const bare = (semi === -1 ? media : media.slice(0, semi)).trim().toLowerCase();
  return bare === 'application/json' || bare.endsWith('+json');
}

/**
 * Freeze a compiled structure at every level, functions included, so a
 * host cannot reshape what a binding will read per request.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function freezeAll(value) {
  if (typeof value === 'function') return Object.freeze(value);
  if (typeof value !== 'object' || value === null) return value;
  if (Object.isFrozen(value)) return value;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) freezeAll(/** @type {any} */ (value)[keys[i]]);
  return Object.freeze(value);
}

/**
 * Snapshot a document member into plain JSON through guarded access.
 * TOTAL: an accessor that throws, a member that is not a JSON value
 * (function, symbol, bigint, non-finite number, class instance), or a
 * cycle is `JC0001` at the member's `docPath`. `undefined` members are
 * absent, as JSON would have them.
 * @param {unknown} value
 * @param {string} docPath
 * @param {Set<object>} path - containers on the current descent
 * @returns {any}
 */
function snapshot(value, docPath, path) {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw refuse('JC0001', 'a non-finite number is not a JSON value', docPath);
      return value;
    case 'object':
      break;
    default:
      throw refuse('JC0001', `a ${typeof value} is not a JSON value`, docPath);
  }
  if (value === null) return null;
  const obj = /** @type {any} */ (value);
  let isArray;
  let proto;
  let keys;
  try {
    isArray = Array.isArray(obj);
    proto = isArray ? null : Object.getPrototypeOf(obj);
    keys = isArray ? null : Object.keys(obj);
  }
  catch (err) {
    throw refuse('JC0001', 'the member threw when read', docPath, asCause(err));
  }
  if (!isArray && proto !== Object.prototype && proto !== null) {
    throw refuse('JC0001', 'a class instance is not a JSON value (expected a plain object)', docPath);
  }
  if (path.has(obj)) throw refuse('JC0001', 'the document is cyclic', docPath);
  path.add(obj);
  let out;
  if (isArray) {
    let length;
    try {
      length = obj.length;
    }
    catch (err) {
      throw refuse('JC0001', 'the member threw when read', docPath, asCause(err));
    }
    out = new Array(length);
    for (let i = 0; i < length; i++) {
      let item;
      try {
        item = obj[i];
      }
      catch (err) {
        throw refuse('JC0001', 'the member threw when read', at(docPath, i), asCause(err));
      }
      out[i] = item === undefined ? null : snapshot(item, at(docPath, i), path);
    }
  }
  else {
    out = {};
    const names = /** @type {string[]} */ (keys);
    for (let i = 0; i < names.length; i++) {
      const key = names[i];
      let member;
      try {
        member = obj[key];
      }
      catch (err) {
        throw refuse('JC0001', 'the member threw when read', at(docPath, key), asCause(err));
      }
      if (member === undefined) continue;
      setObjectMember(out, key, snapshot(member, at(docPath, key), path));
    }
  }
  path.delete(obj);
  return out;
}

//#endregion

//#region references

/**
 * The reference resolver of one compile: same-document refs through the
 * document's anchors, absolute refs through the validator's registry.
 * @typedef {Object} RefScope
 * @property {any} src - the snapshotted document
 * @property {Map<string, object>} anchors
 * @property {JarenValidator<any>} validator
 */

/**
 * A URI fragment as a same-document reference: percent-decoded when it
 * decodes, kept verbatim otherwise (the resolver then fails to find it).
 * @param {string} frag
 * @returns {string}
 */
function decodeFragment(frag) {
  try {
    return decodeURIComponent(frag);
  }
  catch {
    return frag;
  }
}

/**
 * Follow a `$ref` chain to the schema it names, or `undefined` when a
 * link does not resolve. Bounded so a reference cycle terminates.
 * @param {any} node
 * @param {RefScope} scope
 * @returns {any}
 */
function effectiveSchema(node, scope) {
  let cur = node;
  for (let hops = 0; hops < 32 && isJsonObject(cur) && typeof cur.$ref === 'string'; hops++) {
    const ref = cur.$ref;
    let target;
    if (ref.startsWith('#')) {
      target = resolveSameDocumentRef(ref, scope.src, scope.anchors);
    }
    else {
      const hash = ref.indexOf('#');
      const base = hash === -1 ? ref : ref.slice(0, hash);
      const frag = hash === -1 ? '#' : ref.slice(hash);
      const external = scope.validator.getSchema(base);
      target = external === null || external === undefined
        ? undefined
        : resolveSameDocumentRef(decodeFragment(frag), external, collectSameDocumentAnchors(external));
    }
    if (target === undefined) return undefined;
    cur = target;
  }
  return cur;
}

/**
 * Walk a schema subtree and refuse (`JC0007`) the first `$ref` that
 * resolves neither inside the document nor to a registered `$id`, at
 * the `$ref` member's own `docPath`. A subtree declaring its own `$id`
 * is an embedded resource with another base and is left to the
 * validator's whole-document probe.
 * @param {any} node
 * @param {string} docPath
 * @param {RefScope} scope
 * @param {boolean} isRoot
 */
function checkRefs(node, docPath, scope, isRoot) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) checkRefs(node[i], at(docPath, i), scope, false);
    return;
  }
  if (!isJsonObject(node)) return;
  if (!isRoot && typeof node.$id === 'string') return;
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ref.startsWith('#')) {
      if (resolveSameDocumentRef(ref, scope.src, scope.anchors) === undefined) {
        throw refuse('JC0007', `the $ref '${ref}' does not resolve inside the document`, at(docPath, '$ref'));
      }
    }
    else {
      const hash = ref.indexOf('#');
      const base = hash === -1 ? ref : ref.slice(0, hash);
      const external = scope.validator.getSchema(base);
      if (external === null || external === undefined) {
        throw refuse('JC0007',
          `the $ref '${ref}' names no registered schema (register it through options.schemas)`,
          at(docPath, '$ref'));
      }
      // the validator resolves a pointer fragment into a registered schema
      // lazily (a missing pointer surfaces at validation time), so the
      // fragment is checked here — unresolved must be a compile refusal
      if (hash !== -1 && resolveSameDocumentRef(decodeFragment(ref.slice(hash)), external, collectSameDocumentAnchors(external)) === undefined) {
        throw refuse('JC0007',
          `the $ref '${ref}' names a registered schema but its fragment does not resolve inside it`,
          at(docPath, '$ref'));
      }
    }
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (DATA_KEYWORDS.has(key)) continue;
    checkRefs(node[key], at(docPath, key), scope, false);
  }
}

//#endregion

//#region the compiled shapes

/**
 * A compiled validator: whatever the injected validator's `compile`
 * returns — `{ valid, errors }` under the default collect-errors
 * validator, a boolean under a boolean one.
 * @typedef {(value: unknown) => any} CompiledValidate
 */

/**
 * The transport half of an operation's input: the members that travel
 * as strings (path, query, header) and the normalizer that decodes them
 * with `coerceTypes` scoped to exactly those members. `repeated` lists
 * the query and header members whose effective schema type is `array` —
 * a decoder collects repeats of those into an array (a repeated query
 * key; a repeated header line or a comma-separated header list) before
 * normalizing; every other query member is last-wins and every other
 * header member is a single line. Body members are never here.
 * `schemas` holds each transport member's declared schema (what the
 * normalizer was compiled over) and `required` the transport members the
 * input schema requires — what a URL builder validates without the body.
 * @typedef {Object} InputTransport
 * @property {(value: any) => any} normalize
 * @property {{ path: readonly string[], query: readonly string[], header: readonly string[], repeated: readonly string[] }} members
 * @property {Readonly<Record<string, any>>} schemas
 * @property {readonly string[]} required
 */

/**
 * @typedef {Object} CompiledInput
 * @property {any} schema - the declared input schema (frozen source)
 * @property {any} effective - the object schema `schema` resolves to: itself,
 *   or the end of its `$ref` chain (inside the document or a registered
 *   schema) — whose `properties` are the operation's members; frozen
 * @property {CompiledValidate} validate
 * @property {InputTransport | null} transport - `null` when no member travels as a string
 */

/**
 * @typedef {Object} CompiledOutput
 * @property {any} schema
 * @property {CompiledValidate} validate
 */

/**
 * @typedef {Object} CompiledErrorDecl
 * @property {number} status
 * @property {any} schema - `null` when undeclared
 * @property {CompiledValidate | null} validate
 */

/**
 * The resolved policy, every default materialized.
 * @typedef {Object} CompiledPolicy
 * @property {'switch' | 'exhaust' | 'concat' | 'parallel'} task
 * @property {'none' | 'optional' | 'required'} idempotency
 * @property {string | null} revision - `input:<json-pointer>` or null
 * @property {'none' | 'revision'} cache
 * @property {{ maxBodyBytes: number }} limits
 * @property {{ details: 'none' | 'paths' | 'full' }} errors
 * @property {{ max: number, on: readonly string[] } | null} retry
 * @property {'public' | 'server'} audience - who may see the operation: `server`
 *   keeps it out of the public projection and every projection built on it
 */

/**
 * The materialized HTTP binding. `template` is the parsed canonical
 * template (segments in order — the input of a URL builder); `in` maps
 * every declared input member to its location; `body` names the member
 * whose value IS the request body, or `null` when the body is the object
 * of body-located members; `opaque` is true for non-JSON `media`.
 * @typedef {Object} CompiledHttp
 * @property {string} method
 * @property {string} path
 * @property {import('./path.js').ParsedPathTemplate} template
 * @property {readonly string[]} variables
 * @property {Readonly<Record<string, 'path' | 'query' | 'header' | 'body'>>} in
 * @property {string | null} body
 * @property {number} status
 * @property {string} media
 * @property {boolean} opaque
 */

/**
 * @typedef {Object} CompiledOperation
 * @property {string} id
 * @property {'read' | 'command'} kind
 * @property {string | null} doc
 * @property {CompiledInput | null} input
 * @property {CompiledOutput} output
 * @property {Readonly<Record<string, CompiledErrorDecl>>} errors
 * @property {CompiledPolicy} policy
 * @property {CompiledHttp} http
 */

/**
 * @typedef {Object} Contract
 * @property {any} doc - the source document, deep-frozen
 * @property {string | null} id
 * @property {string | null} version
 * @property {readonly string[]} compat
 * @property {Readonly<Record<string, CompiledOperation>>} operations
 * @property {readonly string[]} ids - operation ids in document order
 * @property {(method: string, path: string) => { op: CompiledOperation, params: Readonly<Record<string, string>> } | null} match
 * @property {(path: string) => string[]} allowed - the methods under which
 *   this path shape reaches an operation, sorted (`[]` for none) — what a
 *   405 answers in `Allow`; the path only, query split off, like `match`
 * @property {() => any} describe - a pure-JSON summary (docs/CONTRACT-FORMAT.md §3)
 * @property {any} $defs - frozen view of the document's `$defs` (`{}` when absent)
 */

/**
 * @typedef {Object} CompileContractOptions
 * @property {JarenValidator<any>} [validator] - the validator every schema
 *   compiles through; default `new JarenValidator({ collectErrors: true, skipErrors: false })`
 * @property {Record<string, any>[]} [schemas] - schemas registered by `$id` before compile, so
 *   an absolute `$ref` resolves
 */

//#endregion

//#region per-member validation

/**
 * @param {any} src
 * @param {RefScope} scope
 */
function checkRoot(src, scope) {
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    if (!ROOT_MEMBERS.has(keys[i])) {
      throw refuse('JC0013',
        `unknown document member '${keys[i]}' — the root vocabulary is closed ($contract, id, version, compat, $defs, operations)`,
        at('', keys[i]));
    }
  }
  if (src.$contract !== CONTRACT_VERSION) {
    throw refuse('JC0001',
      src.$contract === undefined
        ? 'the document does not declare "$contract": "0.1"'
        : `unknown contract format version ${JSON.stringify(src.$contract)} (this compiler speaks '0.1')`,
      '/$contract');
  }
  if (src.id !== undefined && (typeof src.id !== 'string' || !CONTRACT_ID.test(src.id))) {
    throw refuse('JC0015', 'id must be an identifier string ([A-Za-z_][A-Za-z0-9_-]*)', '/id');
  }
  if (src.version !== undefined && (typeof src.version !== 'string' || src.version === '')) {
    throw refuse('JC0015', 'version must be a non-empty string', '/version');
  }
  if (src.compat !== undefined) {
    if (!Array.isArray(src.compat)) throw refuse('JC0015', 'compat must be an array of version strings', '/compat');
    for (let i = 0; i < src.compat.length; i++) {
      if (typeof src.compat[i] !== 'string' || src.compat[i] === '') {
        throw refuse('JC0015', 'compat entries must be non-empty version strings', at('/compat', i));
      }
    }
  }
  if (src.$defs !== undefined) {
    if (!isJsonObject(src.$defs)) throw refuse('JC0001', '$defs must be an object of named schemas', '/$defs');
    const names = Object.keys(src.$defs);
    for (let i = 0; i < names.length; i++) {
      if (!isSchema(src.$defs[names[i]])) {
        throw refuse('JC0001', `$defs entry '${names[i]}' is not a schema (an object or a boolean)`, at('/$defs', names[i]));
      }
    }
    checkRefs(src.$defs, '/$defs', scope, false);
  }
  if (!isJsonObject(src.operations) || Object.keys(src.operations).length === 0) {
    throw refuse('JC0002', 'operations must be an object with at least one operation', '/operations');
  }
}

/**
 * Validate `errors` and return the resolved declarations (statuses
 * defaulted, schemas checked); validators are compiled later.
 * @param {any} errors
 * @param {string} base - `/operations/<id>/errors`
 * @param {RefScope} scope
 * @returns {{ code: string, status: number, schema: any }[]}
 */
function checkErrors(errors, base, scope) {
  if (errors === undefined) return [];
  if (!isJsonObject(errors)) throw refuse('JC0011', 'errors must be an object of code → { status?, schema? }', base);
  const out = [];
  const codes = Object.keys(errors);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const path = at(base, code);
    if (!ERROR_CODE.test(code)) {
      throw refuse('JC0011', `error code '${code}' must match ^[a-z][a-z0-9-]*$`, path);
    }
    const decl = errors[code];
    if (!isJsonObject(decl)) throw refuse('JC0011', `error '${code}' must be an object { status?, schema? }`, path);
    const members = Object.keys(decl);
    for (let j = 0; j < members.length; j++) {
      if (!ERROR_DECL_MEMBERS.has(members[j])) {
        throw refuse('JC0013', `unknown error member '${members[j]}' — an error declaration is { status?, schema? }`, at(path, members[j]));
      }
    }
    let status = DEFAULT_ERROR_STATUS;
    if (decl.status !== undefined) {
      if (!Number.isInteger(decl.status) || decl.status < 100 || decl.status > 599) {
        throw refuse('JC0011', `error '${code}' status must be an integer in 100–599`, at(path, 'status'));
      }
      status = decl.status;
    }
    let schema = null;
    if (decl.schema !== undefined) {
      if (!isSchema(decl.schema)) throw refuse('JC0011', `error '${code}' schema must be a schema (an object or a boolean)`, at(path, 'schema'));
      checkRefs(decl.schema, at(path, 'schema'), scope, false);
      schema = decl.schema;
    }
    out.push({ code, status, schema });
  }
  return out;
}

/**
 * Validate `policy` and return it with every default materialized.
 * @param {any} policy
 * @param {'read' | 'command'} kind
 * @param {readonly string[] | null} inputMembers - the input's declared property names, `null` when the operation declares no input
 * @param {string} base - `/operations/<id>/policy`
 * @returns {CompiledPolicy}
 */
function checkPolicy(policy, kind, inputMembers, base) {
  const p = policy === undefined ? {} : policy;
  if (!isJsonObject(p)) throw refuse('JC0014', 'policy must be an object', base);
  const members = Object.keys(p);
  for (let i = 0; i < members.length; i++) {
    if (!POLICY_MEMBERS.has(members[i])) {
      throw refuse('JC0013',
        `unknown policy member '${members[i]}' — the policy vocabulary is closed (task, idempotency, revision, cache, limits, errors, retry, audience)`,
        at(base, members[i]));
    }
  }
  const task = p.task === undefined ? (kind === 'read' ? 'switch' : 'exhaust') : p.task;
  if (!TASKS.includes(task)) {
    throw refuse('JC0014', `policy.task must be one of switch, exhaust, concat, parallel`, at(base, 'task'));
  }
  const idempotency = p.idempotency === undefined ? 'none' : p.idempotency;
  if (!IDEMPOTENCY.includes(idempotency)) {
    throw refuse('JC0014', 'policy.idempotency must be one of none, optional, required', at(base, 'idempotency'));
  }
  if (kind === 'read' && idempotency !== 'none') {
    throw refuse('JC0014', 'a read operation is idempotent by nature; policy.idempotency must be none (or absent)', at(base, 'idempotency'));
  }
  let revision = null;
  if (p.revision !== undefined) {
    if (typeof p.revision !== 'string' || !p.revision.startsWith('input:')) {
      throw refuse('JC0014', 'policy.revision must be a string "input:<json-pointer>"', at(base, 'revision'));
    }
    let tokens;
    try {
      tokens = parseJSONPointer(p.revision.slice('input:'.length));
    }
    catch (err) {
      throw refuse('JC0014', 'policy.revision must carry a valid RFC 6901 pointer after "input:"', at(base, 'revision'), asCause(err));
    }
    // the pointer must address a declared input member: the first
    // reference token names one of input.properties (deeper tokens are
    // not checked — a member's schema may be a $ref or open)
    if (inputMembers === null) {
      throw refuse('JC0014', 'policy.revision names an input member but the operation has no input', at(base, 'revision'));
    }
    if (tokens.length > 0 && !inputMembers.includes(String(tokens[0]))) {
      throw refuse('JC0014', `policy.revision points at '/${String(tokens[0])}' but input declares no member '${String(tokens[0])}'`, at(base, 'revision'));
    }
    revision = p.revision;
  }
  const cache = p.cache === undefined ? 'none' : p.cache;
  if (!CACHE.includes(cache)) {
    throw refuse('JC0014', 'policy.cache must be one of none, revision', at(base, 'cache'));
  }
  let maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  if (p.limits !== undefined) {
    if (!isJsonObject(p.limits)) throw refuse('JC0014', 'policy.limits must be an object', at(base, 'limits'));
    const lm = Object.keys(p.limits);
    for (let i = 0; i < lm.length; i++) {
      if (!LIMITS_MEMBERS.has(lm[i])) {
        throw refuse('JC0013', `unknown limits member '${lm[i]}' — limits is { maxBodyBytes? }`, at(at(base, 'limits'), lm[i]));
      }
    }
    if (p.limits.maxBodyBytes !== undefined) {
      if (!Number.isInteger(p.limits.maxBodyBytes) || p.limits.maxBodyBytes <= 0) {
        throw refuse('JC0014', 'policy.limits.maxBodyBytes must be a positive integer', at(at(base, 'limits'), 'maxBodyBytes'));
      }
      maxBodyBytes = p.limits.maxBodyBytes;
    }
  }
  /** @type {'none' | 'paths' | 'full'} */
  let details = 'paths';
  if (p.errors !== undefined) {
    if (!isJsonObject(p.errors)) throw refuse('JC0014', 'policy.errors must be an object', at(base, 'errors'));
    const em = Object.keys(p.errors);
    for (let i = 0; i < em.length; i++) {
      if (!POLICY_ERRORS_MEMBERS.has(em[i])) {
        throw refuse('JC0013', `unknown policy.errors member '${em[i]}' — policy.errors is { details? }`, at(at(base, 'errors'), em[i]));
      }
    }
    if (p.errors.details !== undefined) {
      if (!DETAILS.includes(p.errors.details)) {
        throw refuse('JC0014', 'policy.errors.details must be one of none, paths, full', at(at(base, 'errors'), 'details'));
      }
      details = p.errors.details;
    }
  }
  let retry = null;
  if (p.retry !== undefined) {
    const rp = at(base, 'retry');
    if (!isJsonObject(p.retry)) throw refuse('JC0014', 'policy.retry must be an object { max, on }', rp);
    const rm = Object.keys(p.retry);
    for (let i = 0; i < rm.length; i++) {
      if (!RETRY_MEMBERS.has(rm[i])) {
        throw refuse('JC0013', `unknown retry member '${rm[i]}' — retry is { max, on }`, at(rp, rm[i]));
      }
    }
    if (!Number.isInteger(p.retry.max) || p.retry.max < 0) {
      throw refuse('JC0014', 'policy.retry.max must be an integer ≥ 0', at(rp, 'max'));
    }
    if (!Array.isArray(p.retry.on)) throw refuse('JC0014', 'policy.retry.on must be an array of error codes', at(rp, 'on'));
    for (let i = 0; i < p.retry.on.length; i++) {
      if (typeof p.retry.on[i] !== 'string' || p.retry.on[i] === '') {
        throw refuse('JC0014', 'policy.retry.on entries must be error code strings', at(at(rp, 'on'), i));
      }
    }
    // a command may only be retried under a key the server can deduplicate
    // on: a retried command without one runs twice
    if (kind === 'command' && idempotency !== 'required') {
      throw refuse('JC0014',
        "policy.retry on a command requires policy.idempotency 'required' — a retried command without an idempotency key runs twice",
        rp);
    }
    retry = { max: p.retry.max, on: p.retry.on.slice() };
  }
  const audience = p.audience === undefined ? 'public' : p.audience;
  if (!AUDIENCES.includes(audience)) {
    throw refuse('JC0014', 'policy.audience must be one of public, server', at(base, 'audience'));
  }
  return { task, idempotency, revision, cache, limits: { maxBodyBytes }, errors: { details }, retry, audience };
}

/**
 * Validate `http` and materialize the binding: the canonical
 * `POST /<op-id>` with every member in the body when absent, otherwise
 * the declared binding with template canonicalized, locations defaulted
 * (path variables → `path`; `read` → `query`; `command` → `body`) and
 * every cross-rule (`JC0009`, `JC0016`, `JC0017`) applied. Returns the
 * compiled http and the location table by member.
 * @param {any} http
 * @param {string} id
 * @param {'read' | 'command'} kind
 * @param {readonly string[]} members - the input's declared property names
 * @param {string} base - `/operations/<id>/http`
 * @returns {CompiledHttp}
 */
function checkHttp(http, id, kind, members, base) {
  /** @type {Record<string, 'path' | 'query' | 'header' | 'body'>} */
  const locations = {};
  if (http === undefined) {
    const template = parsePathTemplate(`/${id}`);
    for (let i = 0; i < members.length; i++) setObjectMember(locations, members[i], 'body');
    return {
      method: 'POST', path: template.path, template, variables: template.variables,
      in: locations, body: null, status: DEFAULT_STATUS, media: DEFAULT_MEDIA, opaque: false,
    };
  }
  if (!isJsonObject(http)) throw refuse('JC0012', 'http must be an object { method, path, in?, body?, status?, media? }', base);
  const hm = Object.keys(http);
  for (let i = 0; i < hm.length; i++) {
    if (!HTTP_MEMBERS.has(hm[i])) {
      throw refuse('JC0013',
        `unknown http member '${hm[i]}' — the http vocabulary is closed (method, path, in, body, status, media)`,
        at(base, hm[i]));
    }
  }
  if (typeof http.method !== 'string' || !METHODS.includes(http.method)) {
    throw refuse('JC0012',
      `http.method must be an uppercase token of ${METHODS.join(', ')}` + (typeof http.method === 'string' && METHODS.includes(http.method.toUpperCase()) ? ` (write '${http.method.toUpperCase()}')` : ''),
      at(base, 'method'));
  }
  const method = http.method;
  let status = DEFAULT_STATUS;
  if (http.status !== undefined) {
    if (!Number.isInteger(http.status) || http.status < 200 || http.status > 299) {
      throw refuse('JC0012', 'http.status must be an integer in 200–299', at(base, 'status'));
    }
    status = http.status;
  }
  let media = DEFAULT_MEDIA;
  if (http.media !== undefined) {
    if (typeof http.media !== 'string' || !MEDIA_TYPE.test(http.media)) {
      throw refuse('JC0012', 'http.media must be a media type string (type/subtype)', at(base, 'media'));
    }
    media = http.media;
  }
  if (http.path === undefined) throw refuse('JC0008', 'http.path is required when http is declared', at(base, 'path'));
  let template;
  try {
    template = parsePathTemplate(http.path);
  }
  catch (err) {
    throw refuse('JC0008', `http.path is not a valid template: ${asCause(err)?.message ?? 'malformed'}`, at(base, 'path'), asCause(err));
  }
  const variables = template.variables;
  for (let i = 0; i < variables.length; i++) {
    if (!members.includes(variables[i])) {
      throw refuse('JC0009', `path variable '${variables[i]}' is not a member of input.properties`, at(base, 'path'));
    }
  }
  let bodyMember = null;
  if (http.body !== undefined) {
    if (typeof http.body !== 'string' || !members.includes(http.body)) {
      throw refuse('JC0009', 'http.body must name a member of input.properties whose value is the request body', at(base, 'body'));
    }
    if (variables.includes(http.body)) {
      throw refuse('JC0009', `http.body '${http.body}' is a path variable and cannot also be the body`, at(base, 'body'));
    }
    bodyMember = http.body;
  }
  const inMap = http.in === undefined ? {} : http.in;
  if (!isJsonObject(inMap)) throw refuse('JC0009', 'http.in must be an object of member → path | query | header | body', at(base, 'in'));
  const inKeys = Object.keys(inMap);
  for (let i = 0; i < inKeys.length; i++) {
    const m = inKeys[i];
    const loc = inMap[m];
    const path = at(at(base, 'in'), m);
    if (!members.includes(m)) throw refuse('JC0009', `http.in names '${m}', which is not a member of input.properties`, path);
    if (typeof loc !== 'string' || !LOCATIONS.includes(loc)) {
      throw refuse('JC0009', `http.in.${m} must be one of path, query, header, body`, path);
    }
    if (variables.includes(m) && loc !== 'path') {
      throw refuse('JC0009', `'${m}' is a path variable and cannot travel as ${loc}`, path);
    }
    if (!variables.includes(m) && loc === 'path') {
      throw refuse('JC0009', `'${m}' is mapped to path but the template declares no {${m}}`, path);
    }
    if (bodyMember !== null && m === bodyMember && loc !== 'body') {
      throw refuse('JC0009', `'${m}' is the http.body member and cannot travel as ${loc}`, path);
    }
  }
  const defaultLocation = kind === 'read' ? 'query' : 'body';
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    /** @type {'path' | 'query' | 'header' | 'body'} */
    let loc;
    if (variables.includes(m)) loc = 'path';
    else if (m === bodyMember) loc = 'body';
    else if (inMap[m] !== undefined) loc = inMap[m];
    else loc = defaultLocation;
    if (bodyMember !== null && m !== bodyMember && loc === 'body') {
      throw refuse('JC0009',
        `'${m}' would travel in the body, but http.body names '${bodyMember}' as the whole body — map '${m}' to query or header`,
        inMap[m] !== undefined ? at(at(base, 'in'), m) : at(base, 'body'));
    }
    setObjectMember(locations, m, loc);
  }
  if (method === 'GET' || method === 'HEAD') {
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (locations[m] === 'body') {
        throw refuse('JC0016',
          `a ${kind} operation bound to ${method} cannot carry '${m}' in the body (a GET body)`,
          m === bodyMember ? at(base, 'body') : (inMap[m] !== undefined ? at(at(base, 'in'), m) : at(base, 'method')));
      }
    }
  }
  const opaque = !isJsonMedia(media);
  if (opaque) {
    // an opaque body is bytes the contract never decodes (§4.5): a
    // body-located member could never be validated, so the transport
    // members of an opaque operation are ALWAYS its whole input
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      if (locations[m] === 'body') {
        const declaredBy = m === bodyMember ? 'http.body' : (inMap[m] !== undefined ? `http.in.${m}` : `the default location of a ${kind} member`);
        throw refuse('JC0017',
          `an opaque operation (media ${media}) cannot carry '${m}' in the body (placed there by ${declaredBy}) — its body is bytes the contract never decodes; map '${m}' to query or header, or make the operation JSON`,
          m === bodyMember ? at(base, 'body') : (inMap[m] !== undefined ? at(at(base, 'in'), m) : at(base, 'media')));
      }
    }
  }
  return {
    method, path: template.path, template, variables, in: locations, body: bodyMember,
    status, media, opaque,
  };
}

//#endregion

/**
 * Compile a `$contract` document (docs/CONTRACT-FORMAT.md) into a frozen
 * `Contract`: every operation's `input`/`output`/error validators, its
 * transport normalizer, its resolved policy and materialized HTTP
 * binding, and one `match(method, path)` over the whole table.
 * Synchronous; total for a hostile document; no I/O.
 *
 * @param {unknown} doc - the contract document
 * @param {CompileContractOptions} [options]
 * @returns {Contract}
 * @throws {ContractCompileError} when the document violates the format (`JC0001–JC0017`)
 * @example
 * const contract = compileContract({
 *   $contract: '0.1',
 *   operations: {
 *     'catalog.load': { kind: 'read', output: true, http: { method: 'GET', path: '/api/catalog' } },
 *   },
 * });
 * contract.match('GET', '/api/catalog').op.id; // 'catalog.load'
 */
export function compileContract(doc, options = {}) {
  const validator = options.validator ?? new JarenValidator({ collectErrors: true, skipErrors: false });
  if (options.schemas !== undefined) {
    if (!Array.isArray(options.schemas)) throw new TypeError('compileContract: options.schemas must be an array of schemas with $id');
    for (let i = 0; i < options.schemas.length; i++) {
      const s = options.schemas[i];
      if (!isJsonObject(s) || typeof s.$id !== 'string') {
        throw new TypeError(`compileContract: options.schemas[${i}] must be a schema object with a string $id`);
      }
      validator.addSchema(s);
    }
  }

  if (!isJsonObject(doc)) throw refuse('JC0001', 'the contract document must be an object', '');
  const src = deepFreeze(snapshot(doc, '', new Set()));
  /** @type {RefScope} */
  const scope = { src, anchors: collectSameDocumentAnchors(src), validator };

  checkRoot(src, scope);

  // ——— per-operation structure ———
  /** @type {Set<string>} method + shape */
  const shapes = new Set();
  /** @type {string[]} */
  const ids = [];
  /** @type {{ id: string, kind: 'read' | 'command', doc: string | null, input: any, inputEffective: any, members: string[], output: any, errors: { code: string, status: number, schema: any }[], policy: CompiledPolicy, http: CompiledHttp }[]} */
  const parsed = [];
  const opIds = Object.keys(src.operations);
  for (let n = 0; n < opIds.length; n++) {
    const id = opIds[n];
    const base = at('/operations', id);
    if (!OP_ID.test(id)) {
      throw refuse('JC0003', `operation id '${id}' must match ^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$`, base);
    }
    const op = src.operations[id];
    if (!isJsonObject(op)) throw refuse('JC0002', `operation '${id}' must be an object`, base);
    const om = Object.keys(op);
    for (let i = 0; i < om.length; i++) {
      if (!OP_MEMBERS.has(om[i])) {
        throw refuse('JC0013',
          `unknown operation member '${om[i]}' — the operation vocabulary is closed (kind, input, output, errors, policy, http, doc)`,
          at(base, om[i]));
      }
    }
    if (op.kind === 'subscribe') {
      throw refuse('JC0004',
        "kind 'subscribe' is reserved: format 0.1 has no stream binding to carry a subscription, so it is refused rather than silently downgraded to a read",
        at(base, 'kind'));
    }
    if (!KINDS.includes(op.kind)) {
      throw refuse('JC0004', "kind must be 'read' or 'command'", at(base, 'kind'));
    }
    /** @type {'read' | 'command'} */
    const kind = op.kind;
    if (op.doc !== undefined && typeof op.doc !== 'string') {
      throw refuse('JC0015', 'doc must be a string', at(base, 'doc'));
    }
    if (op.output === undefined) throw refuse('JC0006', 'output is required (a schema; `true` accepts anything)', at(base, 'output'));
    if (!isSchema(op.output)) throw refuse('JC0006', 'output must be a schema (an object or a boolean)', at(base, 'output'));
    checkRefs(op.output, at(base, 'output'), scope, false);

    let inputEffective = null;
    /** @type {string[]} */
    let members = [];
    let declaredMembers = null;
    if (op.input !== undefined) {
      if (!isJsonObject(op.input)) throw refuse('JC0005', 'input must be an object schema (or a $ref to one)', at(base, 'input'));
      checkRefs(op.input, at(base, 'input'), scope, false);
      inputEffective = effectiveSchema(op.input, scope);
      if (!isJsonObject(inputEffective) || inputEffective.type !== 'object') {
        throw refuse('JC0005', 'input must be a schema whose effective type is object (declare "type": "object")', at(base, 'input'));
      }
      members = isJsonObject(inputEffective.properties) ? Object.keys(inputEffective.properties) : [];
      declaredMembers = members;
    }

    const errors = checkErrors(op.errors, at(base, 'errors'), scope);
    const policy = checkPolicy(op.policy, kind, declaredMembers, at(base, 'policy'));
    const http = checkHttp(op.http, id, kind, members, at(base, 'http'));

    const shape = `${http.method} ${pathShape(http.template)}`;
    if (shapes.has(shape)) {
      throw refuse('JC0010', `operation '${id}' shares the route shape ${shape} with an earlier operation`,
        op.http === undefined ? base : at(at(base, 'http'), 'path'));
    }
    shapes.add(shape);

    ids.push(id);
    parsed.push({
      id, kind, doc: op.doc === undefined ? null : op.doc,
      input: op.input === undefined ? null : op.input, inputEffective, members,
      output: op.output, errors, policy, http,
    });
  }

  // ——— references: the validator's whole-document probe ———
  const synthetic = `urn:jaren:contract:${++compileSequence}`;
  validator.addSchema({ ...src, $id: synthetic });
  try {
    validator.compile({ $ref: `${synthetic}#` });
  }
  catch (err) {
    throw refuse('JC0007', `a $ref in the document does not resolve: ${asCause(err)?.message ?? 'unresolved'}`, '', asCause(err));
  }

  /**
   * @param {(string | number)[]} tokens
   * @param {string} docPath
   * @returns {CompiledValidate}
   */
  function compileAt(tokens, docPath) {
    try {
      return validator.compile({ $ref: synthetic + fragment(tokens) });
    }
    catch (err) {
      throw refuse('JC0007', `the schema failed to compile: ${asCause(err)?.message ?? 'unresolved'}`, docPath, asCause(err));
    }
  }

  // ——— compilation ———
  /** @type {Record<string, CompiledOperation>} */
  const operations = {};
  /** @type {{ method: string, path: string, key: string }[]} */
  const routes = [];
  for (let n = 0; n < parsed.length; n++) {
    const p = parsed[n];
    const base = at('/operations', p.id);

    /** @type {CompiledInput | null} */
    let input = null;
    if (p.input !== null) {
      const validate = compileAt(['operations', p.id, 'input'], at(base, 'input'));
      /** @type {InputTransport | null} */
      let transport = null;
      const pathMembers = [];
      const queryMembers = [];
      const headerMembers = [];
      const repeated = [];
      /** @type {Record<string, any>} */
      const pick = {};
      for (let i = 0; i < p.members.length; i++) {
        const m = p.members[i];
        const loc = p.http.in[m];
        if (loc === 'body') continue;
        const schema = p.inputEffective.properties[m];
        setObjectMember(pick, m, schema);
        if (loc === 'path') pathMembers.push(m);
        else {
          if (loc === 'query') queryMembers.push(m);
          else headerMembers.push(m);
          const eff = effectiveSchema(schema, scope);
          const type = isJsonObject(eff) ? eff.type : undefined;
          if (type === 'array' || (Array.isArray(type) && type.includes('array'))) repeated.push(m);
        }
      }
      if (pathMembers.length + queryMembers.length + headerMembers.length > 0) {
        // the sub-schema is rooted on the document itself, so every
        // same-document `$ref` a member schema carries resolves exactly as
        // it does for the validator
        const sub = { ...src, type: 'object', properties: pick };
        const normalize = compileNormalizer(sub, { coerceTypes: true });
        const declaredRequired = Array.isArray(p.inputEffective.required) ? p.inputEffective.required : [];
        transport = {
          normalize,
          members: { path: pathMembers, query: queryMembers, header: headerMembers, repeated },
          schemas: pick,
          required: declaredRequired.filter((/** @type {unknown} */ r) => typeof r === 'string' && Object.hasOwn(pick, r)),
        };
      }
      input = { schema: p.input, effective: p.inputEffective, validate, transport };
    }

    /** @type {CompiledOutput} */
    const output = { schema: p.output, validate: compileAt(['operations', p.id, 'output'], at(base, 'output')) };

    /** @type {Record<string, CompiledErrorDecl>} */
    const errors = {};
    for (let i = 0; i < p.errors.length; i++) {
      const e = p.errors[i];
      setObjectMember(errors, e.code, {
        status: e.status,
        schema: e.schema,
        validate: e.schema === null
          ? null
          : compileAt(['operations', p.id, 'errors', e.code, 'schema'], at(at(at(base, 'errors'), e.code), 'schema')),
      });
    }

    /** @type {CompiledOperation} */
    const compiled = {
      id: p.id, kind: p.kind, doc: p.doc,
      input, output, errors, policy: p.policy, http: p.http,
    };
    setObjectMember(operations, p.id, freezeAll(compiled));
    routes.push({ method: p.http.method, path: p.http.path, key: p.id });
  }

  const router = compileRoutes(routes);

  /**
   * @param {string} method
   * @param {string} path
   */
  function match(method, path) {
    const found = router.match(method, path);
    return found === null ? null : { op: operations[found.key], params: found.params };
  }

  /** @type {Contract} */
  const contract = {
    doc: src,
    id: src.id === undefined ? null : src.id,
    version: src.version === undefined ? null : src.version,
    compat: Object.freeze(src.compat === undefined ? [] : src.compat.slice()),
    operations: Object.freeze(operations),
    ids: Object.freeze(ids),
    match,
    allowed: router.allowed,
    describe: () => describeContract(contract),
    $defs: src.$defs === undefined ? Object.freeze({}) : src.$defs,
  };
  return freezeAll(contract);
}
