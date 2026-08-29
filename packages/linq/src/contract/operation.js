//@ts-check
/**
 * @file The operation declarations of the contract pen — `read()`,
 * `command()`, `subscribe()` (CONTRACT-FORMAT §3's three kinds) and
 * `error()` (an entry of an operation's `errors` map) — plus the policy
 * vocabulary §3.1 fixes.
 *
 * These write no document: they carry a checked spec that
 * `defineContract` lowers, because the schemas an operation names are
 * hoisted into the contract's own `$defs` and only the whole document
 * knows them. The pen refuses its own surface (a member it does not
 * know, a policy value outside its declared set) and leaves the
 * format's cross-member rules — a read that declares idempotency, a
 * body-located member on a GET, two operations sharing a route shape —
 * to `compileContract`, which is the only judge of them.
 *
 * No default is ever written: §3.1's defaults are materialized by the
 * compiler and marked inferred by `describe()`. A pen that wrote them
 * would turn every default into a declaration and move the revision for
 * nothing.
 */

import { LinqBuildError } from '../errors.js';
import { describeValue } from '../json-boundary.js';

/** The operation brand: how `defineContract` tells a declaration apart. */
export const OPERATION = Symbol.for('@jarenjs/linq/contract-operation');

/** The error-declaration brand. */
export const ERROR_DECLARATION = Symbol.for('@jarenjs/linq/contract-error');

/** The three kinds §3 declares. */
export const KINDS = Object.freeze(['read', 'command', 'subscribe']);

/** The members an operation spec accepts, in the order §12.1 fixes. */
export const OPERATION_MEMBERS = Object.freeze(['input', 'output', 'errors', 'policy', 'http', 'doc']);

/**
 * The policy members, in the order the pen writes them: §12.1's public
 * order with the two server-side knobs (`limits`, `errors`) in their
 * §3.1 positions — the projection drops those two, so their place is
 * the source document's own.
 */
export const POLICY_MEMBERS = Object.freeze([
  'task', 'idempotency', 'revision', 'cache', 'limits', 'errors', 'retry', 'stream', 'audience',
]);

/** The value sets §3.1's table declares, by member. */
export const POLICY_VALUES = Object.freeze({
  __proto__: null,
  task: ['switch', 'exhaust', 'concat', 'parallel'],
  idempotency: ['none', 'optional', 'required'],
  cache: ['none', 'revision'],
  audience: ['public', 'server'],
});

/** An error code: `^[a-z][a-z0-9-]*$` (§3's table). */
const CODE = /^[a-z][a-z0-9-]*$/;

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A member set the pen knows, or `JL0101` naming the one it does not.
 * @param {any} spec
 * @param {readonly string[]} members
 * @param {string} what
 * @param {string} at
 */
function closedTo(spec, members, what, at) {
  for (const key of Object.keys(spec)) {
    if (!members.includes(key)) {
      throw new LinqBuildError('JL0101',
        `${what} does not take '${key}' — it takes ${members.join(', ')}`, `${at}/${key}`);
    }
  }
}

/**
 * One entry of `policy.retry`/`policy.stream`/`policy.limits`/
 * `policy.errors`, checked against §3.1's table.
 * @param {string} member
 * @param {any} value
 * @param {string} at
 * @returns {any} the member's emitted value
 */
function policyMember(member, value, at) {
  const set = POLICY_VALUES[member];
  if (set !== undefined) {
    if (!set.includes(value)) {
      throw new LinqBuildError('JL0101',
        `policy.${member} is one of ${set.join(', ')}, got ${describeValue(value)}`, at);
    }
    return value;
  }
  if (member === 'revision') {
    if (typeof value !== 'string' || !value.startsWith('input:')) {
      throw new LinqBuildError('JL0101',
        'policy.revision is "input:<json-pointer>" — where in the input the revision a '
        + `command asserts lives, got ${describeValue(value)}`, at);
    }
    return value;
  }
  if (member === 'limits') {
    if (!isPlainObject(value)) {
      throw new LinqBuildError('JL0101', 'policy.limits is { maxBodyBytes }', at);
    }
    closedTo(value, ['maxBodyBytes'], 'policy.limits', at);
    if (!Number.isInteger(value.maxBodyBytes) || value.maxBodyBytes <= 0) {
      throw new LinqBuildError('JL0101',
        `policy.limits.maxBodyBytes is a positive integer, got ${describeValue(value.maxBodyBytes)}`,
        `${at}/maxBodyBytes`);
    }
    return { maxBodyBytes: value.maxBodyBytes };
  }
  if (member === 'errors') {
    if (!isPlainObject(value)) {
      throw new LinqBuildError('JL0101', 'policy.errors is { details }', at);
    }
    closedTo(value, ['details'], 'policy.errors', at);
    if (!['none', 'paths', 'full'].includes(value.details)) {
      throw new LinqBuildError('JL0101',
        `policy.errors.details is one of none, paths, full, got ${describeValue(value.details)}`,
        `${at}/details`);
    }
    return { details: value.details };
  }
  if (member === 'retry') {
    if (!isPlainObject(value)) {
      throw new LinqBuildError('JL0101', 'policy.retry is { max, on }', at);
    }
    closedTo(value, ['max', 'on'], 'policy.retry', at);
    if (!Number.isInteger(value.max) || value.max < 0) {
      throw new LinqBuildError('JL0101',
        `policy.retry.max is an integer ≥ 0, got ${describeValue(value.max)}`, `${at}/max`);
    }
    if (!Array.isArray(value.on) || value.on.some((code) => typeof code !== 'string')) {
      throw new LinqBuildError('JL0101',
        'policy.retry.on is an array of error codes (declared codes, or JC2xxx taxonomy codes)',
        `${at}/on`);
    }
    return { max: value.max, on: value.on.slice() };
  }
  // stream
  if (!isPlainObject(value)) {
    throw new LinqBuildError('JL0101', 'policy.stream is { resume?, heartbeatMs?, maxPatchBytes? }', at);
  }
  closedTo(value, ['resume', 'heartbeatMs', 'maxPatchBytes'], 'policy.stream', at);
  const stream = {};
  if (value.resume !== undefined) {
    if (value.resume !== 'snapshot' && value.resume !== 'replay') {
      throw new LinqBuildError('JL0101',
        `policy.stream.resume is snapshot or replay, got ${describeValue(value.resume)}`,
        `${at}/resume`);
    }
    stream.resume = value.resume;
  }
  if (value.heartbeatMs !== undefined) {
    if (!Number.isInteger(value.heartbeatMs) || value.heartbeatMs < 1000) {
      throw new LinqBuildError('JL0101',
        `policy.stream.heartbeatMs is an integer ≥ 1000, got ${describeValue(value.heartbeatMs)}`,
        `${at}/heartbeatMs`);
    }
    stream.heartbeatMs = value.heartbeatMs;
  }
  if (value.maxPatchBytes !== undefined) {
    if (!Number.isInteger(value.maxPatchBytes) || value.maxPatchBytes <= 0) {
      throw new LinqBuildError('JL0101',
        'policy.stream.maxPatchBytes is a positive integer, got '
        + `${describeValue(value.maxPatchBytes)}`, `${at}/maxPatchBytes`);
    }
    stream.maxPatchBytes = value.maxPatchBytes;
  }
  return stream;
}

/**
 * One operation's `policy`, in the pen's member order, declared members
 * only.
 * @param {any} policy
 * @param {string} at
 * @returns {any}
 */
export function emitPolicy(policy, at) {
  if (!isPlainObject(policy)) {
    throw new LinqBuildError('JL0101',
      `policy is a plain object of the members CONTRACT-FORMAT §3.1 declares, got `
      + `${describeValue(policy)}`, at);
  }
  closedTo(policy, POLICY_MEMBERS, 'policy', at);
  const out = {};
  for (const member of POLICY_MEMBERS) {
    if (policy[member] === undefined) continue;
    out[member] = policyMember(member, policy[member], `${at}/${member}`);
  }
  return out;
}

/**
 * One entry of an operation's `errors` map — `{ status?, schema? }`.
 * The `schema` may be a schema-pen builder (hoisted into the contract's
 * `$defs` like any other) or a JSON Schema written by hand.
 *
 * @param {any} [spec] - `{ status?, schema? }`
 * @returns {any} the declaration, frozen and branded
 * @throws {LinqBuildError} `JL0101` a member the declaration does not take
 * @example
 * error({ status: 409, schema: Conflict });
 */
export function error(spec = {}) {
  if (!isPlainObject(spec)) {
    throw new LinqBuildError('JL0101',
      `error() takes { status?, schema? }, got ${describeValue(spec)}`);
  }
  closedTo(spec, ['status', 'schema'], 'error()', '');
  if (spec.status !== undefined
    && (!Number.isInteger(spec.status) || spec.status < 100 || spec.status > 599)) {
    throw new LinqBuildError('JL0101',
      `error() status is an integer in 100–599, got ${describeValue(spec.status)}`, '/status');
  }
  const out = {};
  if (spec.status !== undefined) out.status = spec.status;
  if (spec.schema !== undefined) out.schema = spec.schema;
  Object.defineProperty(out, ERROR_DECLARATION, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * The `errors` map of an operation, checked: codes match §3's pattern,
 * every entry is an `error()` declaration or the same members by hand.
 * @param {any} errors
 * @param {string} at
 * @returns {[string, any][]} code → `{ status?, schema? }`, in declaration order
 */
export function readErrors(errors, at) {
  if (!isPlainObject(errors)) {
    throw new LinqBuildError('JL0101',
      `errors is a plain object of code → error(), got ${describeValue(errors)}`, at);
  }
  return Object.keys(errors).map((code) => {
    if (!CODE.test(code)) {
      throw new LinqBuildError('JL0101',
        `an error code matches ^[a-z][a-z0-9-]*$, got '${code}'`, `${at}/${code}`);
    }
    const declared = errors[code];
    if (!isPlainObject(declared)) {
      throw new LinqBuildError('JL0101',
        `errors.${code} is error({ status?, schema? }), got ${describeValue(declared)}`,
        `${at}/${code}`);
    }
    return [code, declared[ERROR_DECLARATION] === true ? declared : error(declared)];
  });
}

/**
 * One operation spec, checked against §3's member set. There are two
 * doors into `defineContract`'s emitter and both run this: a
 * `read()`/`command()`/`subscribe()` declaration, which has no position
 * in the document yet, and an operation written by hand as `{ kind,
 * …members }`, which does. A member this pen does not know must not
 * reach the document whichever door it came through — the pen emits only
 * what it was given, so an unchecked member is either dropped in silence
 * or written into a document the grammar refuses.
 * @param {string} kind
 * @param {any} spec
 * @param {string} [at] - the docPath of the operation being assembled;
 *   absent at declaration, where the operation has no id yet
 */
export function checkOperation(kind, spec, at) {
  const base = at ?? '';
  if (!isPlainObject(spec)) {
    throw new LinqBuildError('JL0101',
      `${kind}() takes { input?, output, errors?, policy?, http?, doc? }, got `
      + `${describeValue(spec)}`, at);
  }
  closedTo(spec, OPERATION_MEMBERS, `${kind}()`, base);
  if (spec.output === undefined) {
    throw new LinqBuildError('JL0101',
      `${kind}() needs an output — every operation declares one (true for "any value")`,
      `${base}/output`);
  }
  if (spec.doc !== undefined && typeof spec.doc !== 'string') {
    throw new LinqBuildError('JL0101',
      `${kind}() doc is a string, got ${describeValue(spec.doc)}`, `${base}/doc`);
  }
}

/**
 * One operation declaration of `kind`.
 * @param {string} kind
 * @param {any} spec
 * @returns {any}
 */
function operation(kind, spec) {
  checkOperation(kind, spec);
  const out = { kind, spec };
  Object.defineProperty(out, OPERATION, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * A `read` operation: a query whose result may be cached and whose
 * input members default to the query string.
 * @param {any} spec - `{ input?, output, errors?, policy?, http?, doc? }`
 * @returns {any}
 * @example
 * read({ output: Catalog, http: http({ method: 'GET', path: '/api/catalog' }) });
 */
export function read(spec) { return operation('read', spec); }

/**
 * A `command` operation: a state change whose input members default to
 * the request body.
 * @param {any} spec - `{ input?, output, errors?, policy?, http?, doc? }`
 * @returns {any}
 * @example
 * command({ input: SaveInput, output: Product, errors: { conflict: error({ status: 409 }) } });
 */
export function command(spec) { return operation('command', spec); }

/**
 * A `subscribe` operation (§17): its `output` is the snapshot schema
 * and its emissions travel the stream binding. The compiler enforces
 * the shape the wire requires (`GET`, `task: switch`, `idempotency:
 * none`, the forced media); the pen writes what is declared.
 * @param {any} spec - `{ input?, output, errors?, policy?, http?, doc? }`
 * @returns {any}
 * @example
 * subscribe({ output: Board, policy: { stream: { resume: 'replay' } } });
 */
export function subscribe(spec) { return operation('subscribe', spec); }

/**
 * Whether a value is an operation declaration.
 * @param {any} value
 * @returns {boolean}
 */
export function isOperation(value) {
  return value !== null && typeof value === 'object' && value[OPERATION] === true;
}
