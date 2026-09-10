//@ts-check
/** Persistence rules compile through the existing query evaluator. SQL lowering
 * accepts a bounded scalar subset and reports its writer population explicitly. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { DbCompileError, DbRuntimeError } from './errors.js';

/** @param {any} rules @param {string} path @returns {any[]} */
export function normalizeInvariants(rules, path) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) throw new DbCompileError('JD0005', 'invariants must be an array', path);
  const names = new Set();
  return rules.map((rule) => {
    const fail = (reason) => { throw new DbCompileError('JD0005', reason, path); };
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('an invariant must be an object');
    for (const key of Object.keys(rule))
      if (!['name', 'on', 'assert', 'enforcement', 'audit'].includes(key)) fail(`unknown invariant member '${key}'`);
    if (typeof rule.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.name) || names.has(rule.name)) fail('invariant names must be distinct identifiers');
    names.add(rule.name);
    if (!['database', 'store'].includes(rule.enforcement)) fail('invariant enforcement must be database or store');
    if (!Array.isArray(rule.on) || !rule.on.length || new Set(rule.on).size !== rule.on.length
      || rule.on.some((op) => !['insert', 'update', 'delete'].includes(op))) fail('invariant on must name distinct insert/update/delete operations');
    if (rule.assert === undefined) fail('invariant assert is required');
    if (rule.audit !== undefined && (rule.enforcement !== 'database' || !rule.audit
      || typeof rule.audit.entity !== 'string' || !rule.audit.values || typeof rule.audit.values !== 'object'
      || Array.isArray(rule.audit.values) || Object.keys(rule.audit).some((k) => !['entity', 'values'].includes(k)))) fail('audit is a database effect with an entity and values');
    return { ...rule, evaluate: compileJsonQuery(rule.assert) };
  });
}

/** @param {string} name @returns {DbRuntimeError} */
export function invariantFailure(name) {
  const error = new DbRuntimeError('JD2096', `persistence invariant '${name}' rejected the mutation`);
  error.class = 'constraint';
  error.retryable = false;
  return error;
}

/** @param {any[]} rules @param {string} op @param {any} before @param {any} after */
export function checkInvariants(rules, op, before, after) {
  for (const rule of rules) {
    if (rule.enforcement === 'store' && rule.on.includes(op)
      && rule.evaluate({ old: before ?? null, new: after ?? null, op }) !== true)
      throw invariantFailure(rule.name);
  }
}
