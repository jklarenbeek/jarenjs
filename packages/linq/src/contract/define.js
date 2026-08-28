//@ts-check
/**
 * @file `defineContract({ id?, version?, compat? }, operations)` — one
 * `$contract` 0.1 document, deep-frozen, that `compileContract` takes
 * unchanged.
 *
 * Two rules make the pen's document and its own public projection
 * comparable member for member. First, the member ORDER is §12.1's, the
 * normative one the revision hashes: root `$contract, id, version,
 * compat, $defs, operations`; operation `kind, input, output, errors,
 * policy, http, doc`; error `status, schema`; http `method, path, in,
 * body, status, media`; `$defs` in first-reference order. Second, no
 * DEFAULT is written: `describe()` marks a default inferred, and a pen
 * that wrote them would turn every default into a declaration and move
 * the revision for nothing.
 *
 * Every `named()` builder any operation reaches becomes one entry of the
 * contract's own `$defs`, referenced `#/$defs/<name>` — the schema pen's
 * hoisting walk over several roots instead of one. Nothing here imports
 * `@jarenjs/contract`: the compiler stays the only judge of what the
 * document means.
 */

import { cloneJson, deepFreeze, setObjectMember } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson } from '../json-boundary.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { createHoist, emitInto, hoistedDefs } from '../schema/emit.js';
import { http as httpBinding, isHttpBinding } from './http.js';
import { emitPolicy, isOperation, KINDS, readErrors } from './operation.js';

const CONTRACT_VERSION = '0.1';
const HEAD_MEMBERS = ['id', 'version', 'compat'];

/** `[A-Za-z_][A-Za-z0-9_-]*` — a contract id (§2.1). */
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One schema position — `input`, `output`, an error's `schema` — as the
 * document carries it: a builder emitted into the shared `$defs`
 * context, or a JSON Schema written by hand, copied.
 * @param {any} value
 * @param {any} ctx - the hoisting context
 * @param {string} at
 * @returns {any}
 */
function schemaAt(value, ctx, at) {
  if (isSchemaBuilder(value)) return emitInto(value, ctx, at);
  const json = requireJson(value, `the schema at ${at}`);
  if (typeof json !== 'boolean' && !isPlainObject(json)) {
    throw new LinqBuildError('JL0101',
      `a schema is an object, true or false — got ${describeValue(value)}`, at);
  }
  return cloneJson(json);
}

/**
 * The kind and spec of one declared operation: a `read()`/`command()`/
 * `subscribe()` declaration, or the same members written by hand with a
 * `kind`.
 * @param {any} declared
 * @param {string} at
 * @returns {{ kind: string, spec: any }}
 */
function declarationOf(declared, at) {
  if (isOperation(declared)) return declared;
  if (!isPlainObject(declared)) {
    throw new LinqBuildError('JL0101',
      `an operation is read(), command() or subscribe() — got ${describeValue(declared)}`, at);
  }
  if (!KINDS.includes(declared.kind)) {
    throw new LinqBuildError('JL0102',
      `an operation kind is one of ${KINDS.join(', ')} — got ${describeValue(declared.kind)}`,
      `${at}/kind`);
  }
  const { kind, ...spec } = declared;
  return { kind, spec };
}

/**
 * Emit one operation, in §12.1's member order, declared members only.
 * @param {string} id
 * @param {any} declared
 * @param {any} ctx - the hoisting context
 * @returns {any}
 */
function emitOperation(id, declared, ctx) {
  const at = `/operations/${id}`;
  const { kind, spec } = declarationOf(declared, at);
  const out = { kind };
  if (spec.input !== undefined) out.input = schemaAt(spec.input, ctx, `${at}/input`);
  out.output = schemaAt(spec.output, ctx, `${at}/output`);
  if (spec.errors !== undefined) {
    const declaredErrors = readErrors(spec.errors, `${at}/errors`);
    const errors = {};
    for (const [code, entry] of declaredErrors) {
      const e = {};
      if (entry.status !== undefined) e.status = entry.status;
      if (entry.schema !== undefined) {
        e.schema = schemaAt(entry.schema, ctx, `${at}/errors/${code}/schema`);
      }
      setObjectMember(errors, code, e);
    }
    out.errors = errors;
  }
  if (spec.policy !== undefined) out.policy = emitPolicy(spec.policy, `${at}/policy`);
  if (spec.http !== undefined) {
    out.http = isHttpBinding(spec.http) ? { ...spec.http } : { ...httpBinding(spec.http) };
  }
  if (spec.doc !== undefined) out.doc = spec.doc;
  return out;
}

/**
 * The contract under construction: frozen on creation, its document
 * assembled once. `document` and `toJSON()` are the same deep-frozen
 * `$contract` 0.1 JSON; the phantom the declarations carry is what
 * `ContractOf<>` reads.
 */
export class Contract {
  #document;

  /**
   * @param {any} document - the assembled document
   */
  constructor(document) {
    this.#document = document;
    Object.freeze(this);
  }

  /** The deep-frozen `$contract` 0.1 document. */
  get document() { return this.#document; }

  /** The document — what `JSON.stringify` writes. @returns {any} */
  toJSON() { return this.#document; }
}

/**
 * Write a `$contract` 0.1 document.
 *
 * @param {any} meta - `{ id?, version?, compat? }` (§2.1)
 * @param {any} operations - operation id → `read()` / `command()` / `subscribe()`
 * @returns {Contract} the contract, its `document` deep-frozen JSON
 * @throws {LinqBuildError} `JL0101` a value the pen cannot spell;
 *   `JL0102` a kind or path template the format reserves; `JL0103` two
 *   distinct builders under one `$defs` name, or a `ref()` nothing defines
 * @example
 * const shop = defineContract({ id: 'shop', version: '5' }, {
 *   'catalog.load': read({ output: Catalog, http: http({ method: 'GET', path: '/api/catalog' }) }),
 * });
 * compileContract(shop.document).ids;   // ['catalog.load']
 */
export function defineContract(meta, operations) {
  if (!isPlainObject(meta)) {
    throw new LinqBuildError('JL0101',
      `defineContract() takes ({ id?, version?, compat? }, operations), got `
      + `${describeValue(meta)} as its first argument`);
  }
  for (const key of Object.keys(meta)) {
    if (!HEAD_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `defineContract() does not take '${key}' — the head is ${HEAD_MEMBERS.join(', ')}; `
        + 'everything else is an operation', `/${key}`);
    }
  }
  if (meta.id !== undefined && (typeof meta.id !== 'string' || !ID.test(meta.id))) {
    throw new LinqBuildError('JL0101',
      `defineContract() id matches [A-Za-z_][A-Za-z0-9_-]*, got ${describeValue(meta.id)}`, '/id');
  }
  if (meta.version !== undefined && typeof meta.version !== 'string') {
    throw new LinqBuildError('JL0101',
      `defineContract() version is a string, got ${describeValue(meta.version)}`, '/version');
  }
  if (meta.compat !== undefined
    && (!Array.isArray(meta.compat) || meta.compat.some((v) => typeof v !== 'string'))) {
    throw new LinqBuildError('JL0101',
      'defineContract() compat is an array of peer version strings', '/compat');
  }
  if (!isPlainObject(operations)) {
    throw new LinqBuildError('JL0101',
      `defineContract() operations is a plain object of id → operation, got `
      + `${describeValue(operations)}`, '/operations');
  }
  const ids = Object.keys(operations);
  if (ids.length === 0) {
    throw new LinqBuildError('JL0101',
      'defineContract() needs at least one operation', '/operations');
  }

  const ctx = createHoist();
  const emitted = ids.map((id) => [id, emitOperation(id, operations[id], ctx)]);
  const defs = hoistedDefs(ctx);

  const out = { $contract: CONTRACT_VERSION };
  if (meta.id !== undefined) out.id = meta.id;
  if (meta.version !== undefined) out.version = meta.version;
  if (meta.compat !== undefined) out.compat = meta.compat.slice();
  if (defs !== null) out.$defs = defs;
  const ops = {};
  for (const [id, op] of emitted) setObjectMember(ops, id, op);
  out.operations = ops;
  return new Contract(deepFreeze(out));
}

/**
 * Bind a contract client to the contract that types it. Identity at
 * runtime: `invoke`, `url` and `subscribe` are narrowed by the pen's
 * phantoms, and nothing is added to the binding.
 * @template C
 * @param {any} client - any contract client (local, http, port)
 * @param {C} contract - the pen's contract; the type argument only
 * @returns {any}
 * @example
 * const api = typedClient(openLocalClient(compileContract(shop.document), handlers), shop);
 * const outcome = await api.invoke('product.save', { id: 1, revision: 4, product });
 */
export function typedClient(client, contract) {
  void contract;
  return client;
}

/**
 * Bind a handler table to the contract it serves. Identity at runtime:
 * the table is checked against the operation ids and each handler's
 * input and output typed by the pen's phantoms.
 * @template C
 * @template H
 * @param {C} contract - the pen's contract; the type argument only
 * @param {H} handlers - operation id → handler
 * @returns {H}
 * @example
 * serveHttp(compiled, typedHandlers(shop, { 'catalog.load': () => catalog }));
 */
export function typedHandlers(contract, handlers) {
  void contract;
  return handlers;
}

/**
 * Bind `contractTools`' output to the contract that types it. Identity
 * at runtime: each tool's `name` and `execute` argument are narrowed by
 * the pen's phantoms.
 * @template C
 * @param {any} tools - what `contractTools(compiled, client)` answered
 * @param {C} contract - the pen's contract; the type argument only
 * @returns {any}
 * @example
 * for (const tool of typedTools(contractTools(compiled, client), shop)) toolbox.add(tool);
 */
export function typedTools(tools, contract) {
  void contract;
  return tools;
}
