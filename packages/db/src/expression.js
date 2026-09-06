//@ts-check
/**
 * @file Model-declared index expressions: a CLOSED abstract syntax tree
 * over declared members, JSON scalars and registered deterministic
 * functions — and never SQL text.
 *
 * An index over a function is a schema dependency: a database whose
 * column is computed by `lower(…)` cannot be written from a connection
 * that has no `lower`. That hazard is the reason this vocabulary is a
 * DECLARATION rather than an escape hatch — the model names the
 * function, every store that opens the model is handed the same
 * declaration, and a store that cannot honour one refuses at open with
 * `JD0004` before a single statement runs. A raw-SQL index would have
 * had the same hazard with none of the checking.
 *
 * Three node kinds, and no fourth:
 *
 * ```jsonc
 * { "member": "$.email" }                       // a singular member path
 * { "value": "x" }                              // a JSON scalar
 * { "call": "lower", "args": [ <node>, … ] }    // a declared function
 * ```
 *
 * A DECLARATION is what the host supplies per name:
 *
 * ```jsonc
 * { "arity": 1, "deterministic": true,
 *   "apply": (value) => …,   // for an engine that registers functions
 *   "sql": "lower" }         // for one that cannot, and whose function is IMMUTABLE
 * ```
 *
 * Neither half is optional in general: an engine that registers
 * functions needs `apply`, one that does not needs `sql`, and a
 * declaration missing the half its engine needs is `JD0004` at open —
 * not a column that silently computes something else. Nothing here
 * creates a function on the server; `sql` is a promise the host makes
 * about one that already exists.
 */

import { DbCompileError } from './errors.js';

/** The three node kinds, closed. */
export const EXPRESSION_KINDS = Object.freeze(['member', 'value', 'call']);

/** How deep a declared expression may nest. A bound, not a taste: the
 * canonical form is hashed, compared and emitted, and an unbounded one
 * would let a model document cost a store its stack at open. */
export const EXPRESSION_DEPTH = 8;

/**
 * @param {string} reason
 * @param {string} docPath
 * @returns {DbCompileError}
 */
function refuse(reason, docPath) {
  return new DbCompileError('JD0004', reason, docPath);
}

/**
 * Normalize one expression node, refusing everything the vocabulary
 * does not name. The result is frozen and canonical: a member's path is
 * the string it was declared as, a value is the scalar itself, and a
 * call carries its resolved arity.
 * @param {any} node
 * @param {string} docPath
 * @param {Record<string, any>} declarations - the host's function
 *   declarations, by name
 * @param {number} [depth]
 * @returns {any}
 */
export function normalizeExpression(node, docPath, declarations, depth = 0) {
  if (depth > EXPRESSION_DEPTH) {
    throw refuse(`an index expression nests deeper than ${EXPRESSION_DEPTH}`, docPath);
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    throw refuse('an index expression node must be an object', docPath);
  const kinds = EXPRESSION_KINDS.filter((kind) => Object.hasOwn(node, kind));
  if (kinds.length !== 1) {
    throw refuse(
      `an index expression node is exactly one of ${EXPRESSION_KINDS.map((k) => `'${k}'`).join(', ')}`
      + `${kinds.length === 0 ? '' : `, and this one names ${kinds.length}`}`, docPath);
  }
  const [kind] = kinds;

  if (kind === 'member') {
    if (typeof node.member !== 'string' || node.member.length === 0)
      throw refuse('a member node takes a JSONPath string', `${docPath}/member`);
    for (const extra of Object.keys(node)) {
      if (extra !== 'member')
        throw refuse(`a member node takes no '${extra}'`, `${docPath}/${extra}`);
    }
    return Object.freeze({ member: node.member });
  }

  if (kind === 'value') {
    const value = node.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw refuse('a value node takes a JSON string, number or boolean — a null or a '
        + 'compound has no place in an index expression', `${docPath}/value`);
    }
    if (typeof value === 'number' && !Number.isFinite(value))
      throw refuse('a value node takes a finite number', `${docPath}/value`);
    for (const extra of Object.keys(node)) {
      if (extra !== 'value')
        throw refuse(`a value node takes no '${extra}'`, `${docPath}/${extra}`);
    }
    return Object.freeze({ value });
  }

  if (typeof node.call !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.call))
    throw refuse('a call node names a function by identifier', `${docPath}/call`);
  for (const extra of Object.keys(node)) {
    if (extra !== 'call' && extra !== 'args')
      throw refuse(`a call node takes no '${extra}'`, `${docPath}/${extra}`);
  }
  const args = node.args ?? [];
  if (!Array.isArray(args))
    throw refuse('a call node\'s args is an array', `${docPath}/args`);

  const declared = declarations?.[node.call];
  if (declared === undefined) {
    const known = Object.keys(declarations ?? {}).sort();
    throw refuse(`the index expression names the function '${node.call}', which this store was `
      + `not given: the declared functions are ${known.length === 0
        ? 'none' : known.map((name) => `'${name}'`).join(', ')} — pass them as `
      + 'openStore({ expressions })', `${docPath}/call`);
  }
  if (declared.deterministic !== true) {
    throw refuse(`the function '${node.call}' is not declared deterministic, and an index over `
      + 'a function that may answer differently for one row is an index that lies',
    `${docPath}/call`);
  }
  if (!Number.isInteger(declared.arity) || declared.arity < 0)
    throw refuse(`the function '${node.call}' declares no whole arity`, `${docPath}/call`);
  if (args.length !== declared.arity) {
    throw refuse(`the function '${node.call}' takes ${declared.arity} argument(s) and the `
      + `expression gives it ${args.length}`, `${docPath}/args`);
  }
  return Object.freeze({
    call: node.call,
    args: Object.freeze(args.map((argument, i) =>
      normalizeExpression(argument, `${docPath}/args/${i}`, declarations, depth + 1))),
  });
}

/**
 * The canonical text of one normalized expression: the identity two
 * declarations of the same expression share, and the identity the shape
 * hash and the migration diff read.
 *
 * ORDER-PRESERVING, deliberately: `sub(a, b)` and `sub(b, a)` are
 * different expressions and must be different columns, so nothing here
 * sorts.
 * @param {any} node
 * @returns {string}
 */
export function canonicalExpression(node) {
  if (Object.hasOwn(node, 'member')) return `m(${JSON.stringify(node.member)})`;
  if (Object.hasOwn(node, 'value')) return `v(${JSON.stringify(node.value)})`;
  return `${node.call}(${node.args.map(canonicalExpression).join(',')})`;
}

/**
 * Every member path one expression reads, in the order it reads them.
 * @param {any} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function expressionMembers(node, out = []) {
  if (Object.hasOwn(node, 'member')) out.push(node.member);
  else if (Object.hasOwn(node, 'call')) for (const argument of node.args)
    expressionMembers(argument, out);
  return out;
}

/**
 * Every function one expression calls, sorted and deduplicated — what a
 * store registers before it can so much as SELECT from the table.
 * @param {any} node
 * @param {Set<string>} [out]
 * @returns {string[]}
 */
export function expressionFunctions(node, out = new Set()) {
  if (Object.hasOwn(node, 'call')) {
    out.add(node.call);
    for (const argument of node.args) expressionFunctions(argument, out);
  }
  return [...out].sort();
}

/**
 * A short, stable, readable column stem for one expression: the
 * outermost call and the members it reads. Distinct expressions that
 * sanitize to one stem are separated by the DDL planner's own
 * collision suffixing; the canonical text is what decides identity.
 * @param {any} node
 * @returns {string}
 */
export function expressionStem(node) {
  const call = Object.hasOwn(node, 'call') ? node.call : 'x';
  const members = expressionMembers(node)
    .map((path) => path.replace(/^\$\.?/, '').replace(/[^A-Za-z0-9]+/g, '_'))
    .filter((part) => part.length > 0);
  return [call, ...members].join('_').replace(/^_+|_+$/g, '');
}

/**
 * The SQL an expression compiles to on one dialect, and the check that
 * it can be compiled at all.
 *
 * The two engines take different halves of a declaration: one registers
 * the function and calls it by a generated name, the other calls the
 * IMMUTABLE function the host promised already exists. A declaration
 * missing the half its engine needs is `JD0004` HERE — at planning,
 * before any DDL — which is the whole point of resolving it at open.
 * @param {any} node - a normalized expression
 * @param {any} dialect
 * @param {{ docColumnSql: string, declarations: Record<string, any>,
 *   registered: boolean, docPath: string }} context - `registered` is
 *   whether this connection can register a deterministic function
 * @returns {string}
 */
export function expressionSql(node, dialect, context) {
  if (Object.hasOwn(node, 'value')) {
    return typeof node.value === 'string'
      ? dialect.stringLiteral(node.value)
      : typeof node.value === 'boolean'
        ? dialect.booleanLiteral(node.value)
        : String(node.value);
  }
  if (Object.hasOwn(node, 'member')) {
    const pathText = dialect.jsonPathText(context.segmentsOf(node.member));
    if (pathText === null) {
      throw refuse(`the index expression reads '${node.member}', a member name the dialect's `
        + 'JSON path grammar cannot carry', context.docPath);
    }
    // the member's own SCALAR, not its JSON text: a declared function is
    // a function of the VALUE, and `lower` of a string must be the same
    // answer on both engines rather than one of them quoting it first
    return dialect.jsonExtract(context.docColumnSql, pathText, 'scalar');
  }
  const declared = context.declarations[node.call];
  const args = node.args.map((argument) => expressionSql(argument, dialect, context));
  if (context.registered) {
    if (typeof declared.apply !== 'function') {
      throw refuse(`the function '${node.call}' has no 'apply': this connection computes an `
        + 'index expression by registering a deterministic function, and there is nothing '
        + 'to register', context.docPath);
    }
    return `${registeredName(node.call)}(${args.join(', ')})`;
  }
  if (typeof declared.sql !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(declared.sql)) {
    throw refuse(`the function '${node.call}' has no 'sql' name: this connection cannot register `
      + 'a function, so an index over one needs the name of an IMMUTABLE function the server '
      + 'already has — and it is an identifier, never SQL text', context.docPath);
  }
  return `${declared.sql}(${args.join(', ')})`;
}

/**
 * The SQL name a declared function is registered under. Namespaced, so
 * a model's `lower` never shadows the engine's own.
 * @param {string} name
 * @returns {string}
 */
export function registeredName(name) {
  return `jaren_x_${name}`;
}

/**
 * Register every function a set of expressions calls on one connection.
 * @param {any} connection
 * @param {readonly string[]} names
 * @param {Record<string, any>} declarations
 * @returns {any} value-or-promise
 */
export function registerExpressionFunctions(connection, names, declarations) {
  if (names.length === 0 || connection.registerFunction === null) return null;
  for (const name of names) {
    connection.registerFunction(registeredName(name),
      { deterministic: true, varargs: false }, declarations[name].apply);
  }
  return null;
}
