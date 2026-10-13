//@ts-check
/** Collection groups use bounded per-group recomputation over maintained leaves. */
import { compileJsonQuery, stableKeyString } from '@jarenjs/json/query';
import { isJsonObject, stableStringify, semanticKey } from '@jarenjs/core/object';
import { utf8ByteLength } from '@jarenjs/core/string';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { DbRuntimeError } from './errors.js';

/** The dependency set of a strategy that reads every member of a row. */
const WHOLE = { whole: true, members: new Set() };

/**
 * Whether a query string reads the collection root: the root itself (`$`,
 * `$.…`, `$[…]`) or the root named inside a path filter
 * (`$it.items[?@.n > $[0].n]`). A filter cannot name a variable, so any
 * later `$` in a path is the root — or sits in a quoted name, where
 * answering yes only costs a re-run. A string opening with `$$` is the
 * literal escape (QUERY-FORMAT §3.2), which reads nothing.
 * @param {string} text
 * @returns {boolean}
 */
export const readsRoot = (text) => !text.startsWith('$$')
  && (/^\$(?:$|[.[])/.test(text) || (text.startsWith('$') && text.includes('$', 1)));

/** Whether a document fragment never reads the collection root (`$`,
 * `$.…`, `$[…]`, or the root inside a path filter — {@link readsRoot}): a
 * part the maintenance evaluates over a subset of the rows — one group,
 * one row — would see that subset as the collection. A `$const` is
 * quoted, never read.
 * @param {any} node
 * @returns {boolean} */
export function readsNoRoot(node) {
  if (typeof node === 'string') return !readsRoot(node);
  if (Array.isArray(node)) return node.every(readsNoRoot);
  if (!isJsonObject(node) || Object.hasOwn(node, '$const')) return true;
  return Object.values(node).every(readsNoRoot);
}

/** The identity a maintained result keeps an output's previous reference
 * by: its whole value, exact for the numbers JSON text cannot tell apart —
 * `NaN`, `±Infinity`, `-0` — which a computed output can hold, so a ratio
 * turning from `NaN` to `Infinity` is a change. Members are taken
 * unordered: a stored document's member order is not part of its value
 * (LIVE-FORMAT §9), as capture's patches cannot carry it. A value only a host
 * function returns (a class instance) is compared by its JSON text.
 * @param {any} value
 * @returns {string} */
export function valueKey(value) {
  try {
    return semanticKey(value);
  }
  catch {
    return stableStringify(value) ?? '';
  }
}

/** Reuse the previous row object when a fresh one is value-equal — the
 * structural-sharing half of §9 for re-evaluated rows.
 * @param {any} previous
 * @param {any} fresh
 * @returns {any} */
export function sharedRow(previous, fresh) {
  return valueKey(previous) === valueKey(fresh) ? previous : fresh;
}

/** The serialized size a maintained value is charged to `live.maxBytes`.
 * @param {any} value
 * @returns {number} */
export const bytesOf = (value) => utf8ByteLength(stableStringify(value));

/** Split an emitted pointer into unescaped segments.
 * @param {string} path
 * @returns {string[]} */
export const segmentsOf = (path) => path.split('/').slice(1).map(decodeJSONPointerSegment);

/** Whether the live evaluators can compile `document` the way they do —
 * with no options: the registered operators, the zone provider and the
 * profile limits ride only on `execute`'s residual. A document they cannot
 * compile stays on the re-run path, which executes it.
 * @param {any} document
 * @returns {boolean} */
export function compilesBare(document) {
  try {
    compileJsonQuery([document]);
    return true;
  }
  catch {
    return false;
  }
}

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
    if (typeof node === 'string' && readsRoot(node)) supported = false;
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

/**
 * Per-group recomputation: every source row is filed under its group key,
 * and a change re-evaluates the whole document over the rows of the groups
 * it reaches. Rows are filed through the row filter: `description.where`
 * when the description carries one (`null` for none) — a group emission's
 * own `$where` filters group objects, not rows — else the document's.
 * @param {any} description @param {any} context
 */
export function nestedGroupStrategy(description, context) {
  const { inner, binding, key } = description;
  const where = description.where === undefined ? inner.$where : description.where ?? undefined;
  const keyOf = compileJsonQuery([{ $for: { [binding]: '$[*]' },
    ...(where === undefined ? {} : { $where: where }), $return: [key] }]);
  const evaluate = compileJsonQuery([inner]);
  const aggregate = description.aggregate === undefined ? null
    : compileJsonQuery([{ [description.aggregate]: '$[*]' }]);
  const docs = new Map();
  const groups = new Map();
  const results = new Map();
  const positions = new Map();
  let maintainedBytes = 0;
  let resultCount = 0;
  const stats = { refreshedGroups: 0, dependencyReads: 0, reruns: 0 };
  const groupOf = (doc) => {
    const keys = keyOf([doc], context.externals);
    return keys.length === 0 ? null : stableKeyString(keys);
  };
  const sorted = (keys) => [...keys].sort((a, b) => positions.get(a) - positions.get(b));
  const check = () => {
    const entries = docs.size + resultCount + (aggregate === null ? 0 : 1);
    if (entries > context.maxMaintained) throw new DbRuntimeError('JD2060', 'group dependencies exceed live.maxMaintained');
    if (maintainedBytes > context.maxBytes) throw new DbRuntimeError('JD2060', 'group dependencies exceed live.maxBytes');
    return entries;
  };
  const add = (token, doc) => {
    const group = groupOf(doc);
    if (group === null) return null;
    const bytes = bytesOf(doc);
    if (docs.size + resultCount + 1 > context.maxMaintained || maintainedBytes + bytes > context.maxBytes)
      throw new DbRuntimeError('JD2060', 'group dependencies exceed live state credits');
    docs.set(token, doc);
    maintainedBytes += bytes;
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
    results.set(group, sharedRow(previous, next));
    stats.refreshedGroups++;
    check();
  };
  const flatten = () => {
    const rows = [...groups.keys()].sort((a, b) =>
      positions.get(sorted(groups.get(a))[0]) - positions.get(sorted(groups.get(b))[0]))
      .flatMap((group) => results.get(group) ?? []);
    return aggregate === null ? rows : aggregate(rows, context.externals);
  };
  return {
    close() { docs.clear(); groups.clear(); results.clear(); positions.clear(); },
    init() {
      const carrier = description.carrier ?? { $for: { [binding]: '$[*]' },
        ...(where === undefined ? {} : { $where: where }), $return: `$${binding}` };
      const source = [{ $subsequence: [carrier, 0, context.maxMaintained + 1] }];
      for (const doc of context.execute(source, { externals: context.externals })) add(context.keyOf(doc), doc);
      check();
      for (const group of groups.keys()) refresh(group);
      return flatten();
    }, entries: check, stats: () => ({ ...stats }),
    apply(record, previousRows) {
      const deps = description.deps ?? WHOLE;
      const changes = context.touchedKeys(record, deps) ?? new Map();
      // a key deleted and inserted again in one transaction reaches capture
      // as a diff of its members, yet it is a new row at the end of the
      // source order: a held row the dependencies skipped is re-read, as a
      // delete and an insert would be, when its position moved
      if (!deps.whole) {
        for (const token of context.touchedKeys(record, WHOLE)?.keys() ?? []) {
          if (!changes.has(token) && docs.has(token)
            && context.rowPosition(token) !== positions.get(token)) changes.set(token, { kind: 'update' });
        }
      }
      if (changes.size === 0) return null;
      const affected = new Set();
      for (const token of changes.keys()) {
        const previous = docs.get(token);
        if (previous !== undefined) {
          const group = groupOf(previous); affected.add(group); groups.get(group).delete(token);
          docs.delete(token); positions.delete(token); maintainedBytes -= bytesOf(previous);
        }
        const doc = context.readRow(token); stats.dependencyReads++;
        if (doc !== undefined) {
          const group = add(token, doc);
          if (group !== null) affected.add(group);
        }
      }
      check();
      for (const group of affected) refresh(group);
      return context.diff(previousRows, flatten());
    },
  };
}
