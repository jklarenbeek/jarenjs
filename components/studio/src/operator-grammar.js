//@ts-check
/**
 * @file The query and JSLT grammars of an operator registry: the
 * published grammars plus one phrase per operator the registry mounts.
 * The published grammars close the operator vocabulary to the core
 * operators, so an `app`, `fsm` or `dag` document that computes with a
 * pack operator (`{"$sqrt": 16}`) fails its meta-schema even under a host
 * that mounts the pack. `grammarsFor(registryOptions)` reads the registry's
 * `toOptions().extensions` (the descriptors the query compiler itself
 * reads) and returns copies of both grammars whose `objectExpression`
 * also admits those operators, each with the operand shape its compile
 * accepts: a single operand expression, or an array of as many operand
 * expressions as its signature declares.
 *
 * With no extension operator the answer is the published grammar
 * objects themselves, so a core-only validator is compiled from exactly
 * the published bytes. `usesOperator` lets a caller keep the core
 * grammar for a document that names none of the registry's operators,
 * so the registry changes no verdict of such a document;
 * `createGrammarValidators` packages that choice with a validator kept
 * per operator set (the studio's validator and the document host each
 * compile the app meta-schema with their own options, and the studio's
 * validator the fsm and dag ones). A
 * `$call` function (`kind: 'fn'`) needs no phrase: `callPhrase` already
 * admits any function name, and the compile checks it.
 */

import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };

/** Registries whose grammars are kept; a host builds a handful at most. */
const MAX_KEPT = 8;

/** @type {Map<string, { query: any, jslt: any }>} */
const kept = new Map();

/** An operand of kind `expr` is an expression; a `raw`, `schema` or
 * `name` operand is read by the compile alone. @param {unknown} kind */
const operandOf = (kind) => (kind === 'expr' ? { $ref: '#/$defs/expression' } : true);

/**
 * The operand schema of one extension operator: the value shape
 * `normalizeParams` accepts for its `params` descriptor. An operator
 * with its own `normalize` reads a shape no descriptor states, so any
 * value passes the grammar and its compile judges it.
 * @param {any} entry - an `options.extensions` entry
 * @returns {any}
 */
function operandSchema(entry) {
  if (typeof entry?.normalize === 'function') return true;
  const params = entry?.params;
  if (typeof params === 'string') return operandOf(params);
  const kinds = Array.isArray(params?.kinds) ? params.kinds : [];
  const min = typeof params?.min === 'number' ? params.min : kinds.length;
  /** @type {Record<string, any>} */
  const shape = { type: 'array', items: kinds.every((kind) => kind === 'expr') ? operandOf('expr') : true, minItems: min };
  if (params?.variadic !== true) shape.maxItems = kinds.length;
  return shape;
}

/**
 * The extension operators of a registry's options, sorted by name, each
 * with its operand schema.
 * @param {any} registryOptions - a registry's `toOptions()`
 * @returns {Array<[string, any]>}
 */
function extensionOperators(registryOptions) {
  const extensions = registryOptions?.extensions;
  if (extensions === null || typeof extensions !== 'object') return [];
  return Object.keys(extensions).sort().map((name) => [name, operandSchema(extensions[name])]);
}

/**
 * One grammar with a phrase per operand shape appended to its
 * `objectExpression` alternatives.
 * @param {any} schema - a published grammar (never modified)
 * @param {Array<[string, any]>} operators
 */
function withOperators(schema, operators) {
  const copy = structuredClone(schema);
  /** @type {Map<string, { names: string[], operand: any }>} */
  const byShape = new Map();
  for (const [name, operand] of operators) {
    const key = JSON.stringify(operand);
    const group = byShape.get(key) ?? { names: [], operand };
    group.names.push(name);
    byShape.set(key, group);
  }
  let index = 0;
  for (const { names, operand } of byShape.values()) {
    const def = `registeredOperatorPhrase${index++}`;
    copy.$defs[def] = {
      type: 'object', minProperties: 1, maxProperties: 1,
      propertyNames: { enum: names },
      additionalProperties: operand,
    };
    copy.$defs.objectExpression.oneOf.push({ $ref: `#/$defs/${def}` });
  }
  return copy;
}

/**
 * The query and JSLT grammars of a registry: the published ones when it
 * mounts no extension operator, copies that admit its operators
 * otherwise. Kept per operator set, so a registry's grammars are built
 * once.
 * @param {any} registryOptions - a registry's `toOptions()`
 * @returns {{ query: any, jslt: any, key: string }} `key` names the
 *   operator set (`''` for the core grammar), for a caller's own cache
 */
export function grammarsFor(registryOptions) {
  const operators = extensionOperators(registryOptions);
  if (operators.length === 0) return { query: querySchema, jslt: jsltSchema, key: '' };
  const key = JSON.stringify(operators);
  let grammars = kept.get(key);
  if (grammars === undefined) {
    grammars = { query: withOperators(querySchema, operators), jslt: withOperators(jsltSchema, operators) };
    if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value ?? '');
    kept.set(key, grammars);
  }
  return { ...grammars, key };
}

/**
 * A validator chooser for documents that embed the query and JSLT
 * grammars: the core validator for a document that names none of the
 * registry's operators, else one compiled over the registry's grammars,
 * kept per operator set.
 * @template V
 * @param {V} core - the validator over the published grammars
 * @param {(query: any, jslt: any) => V} compile - a validator over these grammars
 * @returns {(doc: unknown, registryOptions: any) => V}
 */
export function createGrammarValidators(core, compile) {
  /** @type {Map<string, V>} */
  const compiled = new Map();
  return (doc, registryOptions) => {
    if (!usesOperator(doc, registryOptions)) return core;
    const { query, jslt, key } = grammarsFor(registryOptions);
    let validator = compiled.get(key);
    if (validator === undefined) {
      validator = compile(query, jslt);
      if (compiled.size >= MAX_KEPT) compiled.delete(compiled.keys().next().value ?? '');
      compiled.set(key, validator);
    }
    return validator;
  };
}

/**
 * Whether a document holds an object with a member named after one of
 * the registry's extension operators — the only documents whose verdict
 * the registry's grammar can change.
 * @param {unknown} doc
 * @param {any} registryOptions - a registry's `toOptions()`
 */
export function usesOperator(doc, registryOptions) {
  const extensions = registryOptions?.extensions;
  if (extensions === null || typeof extensions !== 'object') return false;
  const pending = [doc];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const item of node) pending.push(item); continue; }
    for (const key of Object.keys(node)) {
      if (Object.hasOwn(extensions, key)) return true;
      pending.push(/** @type {Record<string, unknown>} */ (node)[key]);
    }
  }
  return false;
}
