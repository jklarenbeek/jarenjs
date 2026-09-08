//@ts-check
/** Indexed dependency maintenance over bounded, mapped entity roots. */
import { compileJsonQuery } from '@jarenjs/json/query';
import { stableStringify } from '@jarenjs/core/object';
import { decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { planEntityQuery, entityRoot } from './plan.js';
import { joinTableRoots } from './model.js';
import { keyToken } from './capture.js';
import { DbRuntimeError } from './errors.js';
import { utf8Length } from './cursor.js';

/** Compile eligibility from the existing planner and declared mapping. @param {any} document @param {any} entities @param {any} mapping @param {any} operators */
export function classifyEntityLive(document, entities, mapping, operators) {
  const extra = joinTableRoots(entities, mapping);
  const roots = new Map([...entities, ...extra.entities]);
  const mapped = { ...mapping, entities: { ...mapping.entities, ...extra.mappings } };
  // Canonical allowing-empty equality subquery: its native surrogate settles
  // the dependency columns; the original expression still evaluates the tuple.
  let surrogate = document;
  let strategy = 'join';
  const inner = Array.isArray(document) && document.length === 1 ? document[0] : document;
  const entries = Object.entries(inner?.$for ?? {});
  const globalRead = (node) => {
    if (typeof node === 'string') return node === '$' || node.startsWith('$.') || node.startsWith('$[');
    if (Array.isArray(node)) return node.some(globalRead);
    return node !== null && typeof node === 'object'
      && Object.entries(node).some(([key, value]) => key !== '$for' && globalRead(value));
  };
  if (entries.length === 1 && typeof entries[0][1] === 'string'
    && Object.keys(inner).every((key) => ['$for', '$return'].includes(key))) {
    const bindings = { ...inner.$for };
    const predicates = [];
    let valid = true;
    const visit = (node) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node.$for !== undefined) {
        if (!Object.keys(node).every((key) => ['$for', '$where', '$return'].includes(key)) || node.$where === undefined) { valid = false; return; }
        for (const [name, source] of Object.entries(node.$for)) {
          if (Object.hasOwn(bindings, name) || typeof source !== 'string') { valid = false; return; }
          bindings[name] = source;
        }
        predicates.push(node.$where);
        visit(node.$return);
      }
      else Object.values(node).forEach(visit);
    };
    visit(inner.$return);
    if (valid && predicates.length > 0 && !globalRead(inner.$return)) {
      const terms = predicates.flatMap((predicate) => predicate.$and ?? [predicate]);
      surrogate = [{ $for: bindings, $where: terms.length === 1 ? terms[0] : { $and: terms }, $return: `$${entries[0][0]}` }];
      strategy = 'graph';
    }
  }
  if (entries.length === 2 && Object.keys(inner).every((key) => ['$for', '$return'].includes(key))) {
    const [outer, right] = entries;
    const allowing = right[1];
    const subquery = allowing?.$in;
    const nested = Object.entries(subquery?.$for ?? {});
    const equality = subquery?.$where?.$eq;
    if (allowing?.['$allowing-empty'] === true && Object.keys(allowing).length === 2
      && nested.length === 1 && subquery.$return === `$${nested[0][0]}`
      && Object.keys(subquery).length === 3 && Object.keys(subquery.$where).length === 1
      && Array.isArray(equality) && equality.length === 2 && equality.every((part) => typeof part === 'string')
      && typeof outer[1] === 'string' && typeof nested[0][1] === 'string' && !globalRead(inner.$return)) {
      const prefix = `$${nested[0][0]}.`;
      surrogate = [{ $for: { [outer[0]]: outer[1], [right[0]]: nested[0][1] },
        $where: { $eq: equality.map((part) => part.startsWith(prefix) ? `$${right[0]}.${part.slice(prefix.length)}` : part) },
        $return: `$${outer[0]}` }];
    }
  }
  const planned = planEntityQuery(surrogate, roots, mapped, operators);
  const rerun = (reason) => ({ strategy: 'rerun', reason });
  if (planned.mode !== 'native') return rerun(`entity dependency plan: ${planned.reasons[0]?.reason ?? 'unmapped expression'}`);
  const plan = planned.plan;
  if (plan.window !== null) return rerun('an entity offset or limit window re-runs');
  if (plan.aggregate !== null) return rerun('an entity aggregate has no bounded tuple accumulator');
  if (plan.order !== null) return rerun('an explicitly ordered entity join has no maintained ordering');
  const bindings = plan.bindings.map((binding) => ({ ...binding, mapping: mapped.entities[binding.entity] }));
  if (new Set(bindings.map((b) => b.entity)).size !== bindings.length) return rerun('a self join has ambiguous root invalidation');
  const indexed = (binding, column) => {
    const m = binding.mapping;
    return m.keys[0] === column || m.indexes.some((index) => index.property === column)
      || m.foreignKeys.some((fk) => fk.column === column);
  };
  const edges = plan.joins.flatMap((join) => join.on);
  for (const edge of edges) {
    if (edge.op !== 'eq') return rerun('a non-equality join refinement re-runs');
    for (const side of [edge.left, edge.right]) {
      if (!indexed(bindings.find((binding) => binding.name === side.binding), side.column))
        return rerun(`join dependency '${side.binding}.${side.column}' has no declared index`);
    }
  }
  if (bindings.some((binding) => binding.mapping.keys.length === 0)) return rerun('a join root has no stable key');
  return { strategy, bindings, edges };
}

/** Maintain tuples through inverse key dependencies; query evaluation uses only affected root subsets.
 * @param {any} description @param {any} context */
export function joinStrategy(description, context) {
  const { bindings, edges } = description;
  const inner = Array.isArray(context.document) ? context.document[0] : context.document;
  const evaluate = compileJsonQuery([{ $subsequence: [inner, 0, context.maxMaintained + 1] }]);
  const caches = new Map(bindings.map((binding) => [binding.name, new Map()]));
  const positions = new Map(bindings.map((binding) => [binding.name, new Map()]));
  const indices = new Map();
  const items = new Map();
  let inputCount = 0;
  let outputCount = 0;
  let maintainedBytes = 0;
  const bytesOf = (value) => utf8Length(stableStringify(value));
  const counts = { dependencyReads: 0, refreshedRoots: 0, reruns: 0 };
  const root = bindings[0];
  const keyOf = (binding, row) => keyToken(binding.mapping.keys.map((name) => row[name]));
  const sorted = (binding, values) => [...values].sort((a, b) =>
    positions.get(binding.name).get(keyOf(binding, a)) - positions.get(binding.name).get(keyOf(binding, b)));
  const signature = (binding, column) => JSON.stringify([binding, column]);
  for (const edge of edges) for (const side of [edge.left, edge.right]) indices.set(signature(side.binding, side.column), new Map());
  const bound = () => {
    const size = inputCount + outputCount;
    if (size > context.maxMaintained) throw new DbRuntimeError('JD2060', `the join dependency state exceeds live.maxMaintained (${context.maxMaintained})`);
    if (maintainedBytes > context.maxBytes) throw new DbRuntimeError('JD2060', 'the join dependency state exceeds live.maxBytes');
    return size;
  };
  const indexRow = (binding, row, insert) => {
    const token = keyOf(binding, row);
    for (const [signatureKey, index] of indices) {
      const [name, column] = JSON.parse(signatureKey);
      if (name !== binding.name) continue;
      const value = row[column];
      if (value === undefined || value === null) continue;
      const key = stableStringify(value);
      if (insert) {
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(token);
      }
      else {
        const set = index.get(key); set?.delete(token);
        if (set?.size === 0) index.delete(key);
      }
    }
  };
  // A changed row walks equality edges in both directions to its bounded
  // outer owners. The same walk works for multi-entity projection chains.
  const connected = (binding, row) => {
    const found = new Map(bindings.map((b) => [b.name, new Map()]));
    const queue = [[binding, row]];
    for (let i = 0; i < queue.length; i++) {
      const [current, doc] = queue[i];
      const key = keyOf(current, doc);
      if (found.get(current.name).has(key)) continue;
      found.get(current.name).set(key, doc);
      // When finding owners, arriving at an owner completes this path.
      // When evaluating one owner, crossing back to its siblings would
      // widen a selective dependency into the entire connected component.
      if (binding !== root && current === root) continue;
      for (const edge of edges) {
        const own = edge.left.binding === current.name ? edge.left : edge.right.binding === current.name ? edge.right : null;
        if (own === null || doc[own.column] === undefined || doc[own.column] === null) continue;
        const other = own === edge.left ? edge.right : edge.left;
        if (binding === root && other.binding === root.name) continue;
        const target = bindings.find((b) => b.name === other.binding);
        for (const token of indices.get(signature(other.binding, other.column)).get(stableStringify(doc[own.column])) ?? []) {
          const match = caches.get(other.binding).get(token);
          if (!found.get(target.name).has(token)) queue.push([target, match]);
        }
      }
      if (queue.length > context.maxMaintained * Math.max(1, edges.length * 2))
        throw new DbRuntimeError('JD2060', 'the join dependency fan-out exceeds live.maxMaintained');
    }
    return found;
  };
  const refresh = (key) => {
    const row = caches.get(root.name).get(key);
    if (row === undefined) {
      const previous = items.get(key);
      if (previous !== undefined) { outputCount -= previous.length; maintainedBytes -= bytesOf(previous); }
      items.delete(key); return;
    }
    const related = connected(root, row);
    const input = Object.fromEntries(bindings.map((binding) => [binding.entity,
      binding === root ? [row] : sorted(binding, related.get(binding.name).values())]));
    const result = evaluate(input, context.externals);
    const fresh = result === undefined ? [] : Array.isArray(result) ? result : [result];
    const previous = items.get(key) ?? [];
    outputCount += fresh.length - previous.length;
    maintainedBytes += bytesOf(fresh) - (items.has(key) ? bytesOf(previous) : 0);
    items.set(key, fresh.map((item, i) => stableStringify(previous[i]) === stableStringify(item) ? previous[i] : item));
    counts.refreshedRoots++;
    bound();
  };
  const flatten = () => sorted(root, caches.get(root.name).values()).flatMap((row) => items.get(keyOf(root, row)) ?? []);
  return {
    close() { for (const cache of caches.values()) cache.clear(); for (const index of indices.values()) index.clear();
      for (const position of positions.values()) position.clear(); items.clear(); },
    init() {
      for (const binding of bindings) {
        const document = [{ $subsequence: [{ $for: { it: entityRoot(binding.entity) }, $return: '$it' }, 0, context.maxMaintained + 1] }];
        const rows = context.execute(document, { externals: context.externals });
        for (const row of rows) {
          const key = keyOf(binding, row);
          caches.get(binding.name).set(key, row); indexRow(binding, row, true);
          inputCount++; maintainedBytes += bytesOf(row);
          bound();
          positions.get(binding.name).set(key, context.dependencyPosition(binding.entity, key));
        }
        bound();
      }
      for (const key of caches.get(root.name).keys()) refresh(key);
      return flatten();
    },
    entries: bound,
    stats: () => ({ ...counts }),
    apply(record, previousRows) {
      const changed = new Map();
      const affected = new Set();
      for (const operation of record.patch) {
        const [table, token] = operation.path.split('/').slice(1).map(decodeJSONPointerSegment);
        const binding = bindings.find((b) => b.entity === table);
        if (binding) changed.set(JSON.stringify([binding.name, token]), { binding, token });
      }
      for (const { binding, token } of changed.values()) {
        const old = caches.get(binding.name).get(token);
        if (binding === root) affected.add(token);
        if (old !== undefined) for (const key of connected(binding, old).get(root.name).keys()) affected.add(key);
      }
      for (const { binding, token } of changed.values()) {
        const cache = caches.get(binding.name);
        const old = cache.get(token);
        if (old !== undefined) { indexRow(binding, old, false); inputCount--; maintainedBytes -= bytesOf(old); }
        const row = context.readDependency(binding.entity, token);
        counts.dependencyReads++;
        if (row === undefined) { cache.delete(token); positions.get(binding.name).delete(token); }
        else {
          cache.set(token, row); indexRow(binding, row, true);
          inputCount++; maintainedBytes += bytesOf(row);
          positions.get(binding.name).set(token, context.dependencyPosition(binding.entity, token));
        }
        bound();
      }
      for (const { binding, token } of changed.values()) {
        const row = caches.get(binding.name).get(token);
        if (row !== undefined) for (const key of connected(binding, row).get(root.name).keys()) affected.add(key);
      }
      for (const key of affected) refresh(key);
      const next = flatten();
      return context.diff(previousRows, next);
    },
  };
}
