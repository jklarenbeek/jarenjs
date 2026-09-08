//@ts-check
/** Two-level groups use bounded per-parent recomputation over maintained leaves. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { stableStringify } from '@jarenjs/core/object';
import { DbRuntimeError } from './errors.js';
import { utf8Length } from './cursor.js';

/** Recognise nested groups whose parent key is a singular source member. @param {any} document */
export function classifyNestedGroup(document) {
  const inner = Array.isArray(document) && document.length === 1 ? document[0] : document;
  if (inner === null || typeof inner !== 'object' || !inner.$for || !inner.$groupby) return null;
  const bindings = Object.entries(inner.$for);
  const groups = Object.entries(inner.$groupby);
  if (bindings.length !== 1 || groups.length !== 1
    || !Object.keys(inner).every((key) => ['$for', '$where', '$groupby', '$return'].includes(key))) return null;
  const [binding, source] = bindings[0];
  if (!(source === '$[*]' || (Array.isArray(source) && source.length === 1 && source[0] === '$[*]'))) return null;
  const key = groups[0][1];
  if (typeof key !== 'string' || !key.startsWith(`$${binding}.`) || !/^\$[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let count = 0;
  let supported = true;
  const allowed = new Set(['$for', '$where', '$groupby', '$return', '$count', '$sum', '$avg', '$min', '$max', '$default', '$eq', '$ne', '$lt', '$le', '$gt', '$ge', '$and', '$or']);
  const visit = (node) => {
    if (typeof node === 'string' && (node === '$' || node.startsWith('$.') || node.startsWith('$['))) supported = false;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    if (node.$groupby) count++;
    if (node !== inner && node.$for) {
      const nested = Object.values(node.$for);
      if (nested.length !== 1 || !(nested[0] === `$${binding}`
        || (Array.isArray(nested[0]) && nested[0].length === 1 && nested[0][0] === `$${binding}`))) supported = false;
    }
    for (const [name, value] of Object.entries(node)) {
      if (node === inner && name === '$for') continue;
      if (name.startsWith('$') && !allowed.has(name)) supported = false;
      visit(value);
    }
  };
  visit(inner);
  if (count !== 2 || !supported) return null;
  return { strategy: 'nested-group', inner, binding, key };
}

/** @param {any} description @param {any} context */
export function nestedGroupStrategy(description, context) {
  const { inner, binding, key } = description;
  const keyOf = compileJsonQuery([{ $for: { [binding]: '$[*]' },
    ...(inner.$where === undefined ? {} : { $where: inner.$where }), $return: [key] }]);
  const evaluate = compileJsonQuery([inner]);
  const docs = new Map();
  const groups = new Map();
  const results = new Map();
  const positions = new Map();
  let maintainedBytes = 0;
  let resultCount = 0;
  const bytesOf = (value) => utf8Length(stableStringify(value));
  const stats = { refreshedGroups: 0, dependencyReads: 0, reruns: 0 };
  const groupOf = (doc) => stableStringify(keyOf([doc], context.externals));
  const sorted = (keys) => [...keys].sort((a, b) => positions.get(a) - positions.get(b));
  const check = () => {
    const entries = docs.size + resultCount;
    if (entries > context.maxMaintained) throw new DbRuntimeError('JD2060', 'nested group dependencies exceed live.maxMaintained');
    if (maintainedBytes > context.maxBytes) throw new DbRuntimeError('JD2060', 'nested group dependencies exceed live.maxBytes');
    return entries;
  };
  const add = (token, doc) => {
    const group = groupOf(doc);
    docs.set(token, doc);
    maintainedBytes += bytesOf(doc);
    positions.set(token, context.rowPosition(token));
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group).add(token);
    return group;
  };
  const refresh = (group) => {
    const keys = groups.get(group);
    if (!keys || keys.size === 0) {
      const previous = results.get(group);
      if (previous !== undefined) { maintainedBytes -= bytesOf(previous); resultCount -= previous.length; }
      groups.delete(group); results.delete(group); return;
    }
    const next = evaluate(sorted(keys).map((token) => docs.get(token)), context.externals);
    const previous = results.get(group);
    maintainedBytes += bytesOf(next) - (previous === undefined ? 0 : bytesOf(previous));
    resultCount += next.length - (previous?.length ?? 0);
    results.set(group, stableStringify(previous) === stableStringify(next) ? previous : next);
    stats.refreshedGroups++;
    check();
  };
  const flatten = () => [...groups.keys()].sort((a, b) =>
    positions.get(sorted(groups.get(a))[0]) - positions.get(sorted(groups.get(b))[0]))
    .flatMap((group) => results.get(group) ?? []);
  return {
    close() { docs.clear(); groups.clear(); results.clear(); positions.clear(); },
    init() {
      const source = [{ $subsequence: [{ $for: { it: '$[*]' }, $return: '$it' }, 0, context.maxMaintained + 1] }];
      for (const doc of context.execute(source, { externals: context.externals })) add(context.keyOf(doc), doc);
      check();
      for (const group of groups.keys()) refresh(group);
      return flatten();
    }, entries: check, stats: () => ({ ...stats }),
    apply(record, previousRows) {
      const changes = context.touchedKeys(record, { whole: true, members: new Set() });
      if (changes === null) return null;
      const affected = new Set();
      for (const token of changes.keys()) {
        const previous = docs.get(token);
        if (previous !== undefined) {
          const group = groupOf(previous); affected.add(group); groups.get(group).delete(token);
          docs.delete(token); positions.delete(token); maintainedBytes -= bytesOf(previous);
        }
        const doc = context.readRow(token); stats.dependencyReads++;
        if (doc !== undefined) affected.add(add(token, doc));
      }
      check();
      for (const group of affected) refresh(group);
      return context.diff(previousRows, flatten());
    },
  };
}
