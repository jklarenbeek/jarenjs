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
import { readsRoot, compilesBare, valueKey } from './live-nested.js';

/**
 * Compile eligibility from the existing planner and declared mapping: a
 * named `rerun`, or a `join`/`graph` description — the plan's bindings, each
 * with the input `member` it is evaluated from, and its equality edges; a
 * flat join binding one entity under several aliases also carries the
 * `document` that reads every later alias from its own member.
 * @param {any} document @param {any} entities @param {any} mapping @param {any} operators
 */
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
  // Whether a fragment reads an entity root — the root itself or the root
  // inside a path filter ({@link readsRoot}); a `$const` is quoted, never
  // read. Nested `$for` sources count only with `sources`: a graph
  // projection binds those itself.
  const globalRead = (node, sources = false) => {
    if (typeof node === 'string') return readsRoot(node);
    if (Array.isArray(node)) return node.some((item) => globalRead(item, sources));
    return node !== null && typeof node === 'object' && !Object.hasOwn(node, '$const')
      && Object.entries(node).some(([key, value]) => (sources || key !== '$for') && globalRead(value, sources));
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
  if (plan.group !== null) return rerun('an entity grouping has no bounded tuple accumulator');
  if (plan.order !== null) return rerun('an explicitly ordered entity join has no maintained ordering');
  // The evaluated document reads each binding from an input member: an
  // entity's first binding from the entity's own, every later alias of it
  // from a fresh member no declared root takes.
  const taken = new Set(roots.keys());
  const bindings = plan.bindings.map((binding, i) => {
    let member = binding.entity;
    if (plan.bindings.findIndex((other) => other.entity === binding.entity) < i) {
      member = `_alias${i}`;
      while (taken.has(member)) member += '_';
      taken.add(member);
    }
    return { ...binding, member, mapping: mapped.entities[binding.entity] };
  });
  const aliased = bindings.some((binding) => binding.member !== binding.entity);
  // Aliases are told apart only where the document names every binding as
  // a top-level `$for` source path, which the join planned as written does;
  // a graph projection or an allowing-empty join is planned through a
  // surrogate whose bindings the evaluated document nests.
  if (aliased && (strategy !== 'join' || surrogate !== document || entries.length !== bindings.length
    || bindings.some((binding, i) => entries[i][0] !== binding.name || typeof entries[i][1] !== 'string')))
    return rerun('a self join has ambiguous root invalidation');
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
  // A join evaluates its document over each outer row's connected rows
  // alone: a root read anywhere but the top-level `$for` — a nested query
  // over an entity root included — would see that subset as the entity.
  if (strategy === 'join' && Object.entries(inner).some(([key, value]) => key !== '$for' && globalRead(value, true)))
    return rerun('an entity root read outside the join bindings re-runs');
  // The maintenance evaluates the document with no options, where execute
  // carries the registered operators and the zone provider: a document that
  // needs them re-runs, named by the planner's reason for the operator in it
  // as written — a graph or allowing-empty join is planned through a
  // surrogate that leaves its return out, so the surrogate's plan cannot
  // name it, and a named zone is not the planner's to name.
  if (!compilesBare(inner)) {
    const written = surrogate === document ? planned : planEntityQuery(document, roots, mapped, operators);
    const named = written.reasons.find((reason) => !['$for', '$return'].includes(reason.construct));
    return rerun(`entity dependency plan: ${named?.reason
      ?? 'the document needs the store\'s registered operators or zone provider'}`);
  }
  if (!aliased) return { strategy, bindings, edges };
  const rewritten = { ...inner, $for: Object.fromEntries(bindings.map((binding, i) =>
    [binding.name, binding.member === binding.entity ? entries[i][1] : entityRoot(binding.member)])) };
  return { strategy, bindings, edges, document: rewritten };
}

/** Maintain tuples through inverse key dependencies; query evaluation uses only affected root subsets.
 * Each alias of an entity holds that entity's rows apart; a changed row is read once for all of them.
 * @param {any} description @param {any} context */
export function joinStrategy(description, context) {
  const { bindings, edges } = description;
  const document = description.document ?? context.document;
  const inner = Array.isArray(document) ? document[0] : document;
  const evaluate = compileJsonQuery([{ $subsequence: [inner, 0, context.maxMaintained + 1] }]);
  /** @type {Map<string, any[]>} the bindings over each entity, in document order */
  const aliasesOf = new Map();
  for (const binding of bindings) aliasesOf.set(binding.entity, [...(aliasesOf.get(binding.entity) ?? []), binding]);
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
  // Every alias of an entity caches, indexes and charges that entity's rows
  // on its own: a row read once is held by each (`undefined` releases it).
  const hold = (binding, token, row, position) => {
    const cache = caches.get(binding.name);
    const old = cache.get(token);
    if (old !== undefined) { indexRow(binding, old, false); inputCount--; maintainedBytes -= bytesOf(old); }
    if (row === undefined) { cache.delete(token); positions.get(binding.name).delete(token); }
    else {
      cache.set(token, row); indexRow(binding, row, true);
      inputCount++; maintainedBytes += bytesOf(row);
      positions.get(binding.name).set(token, position);
    }
    bound();
  };
  // A changed row walks equality edges in both directions to its bounded
  // outer owners. The same walk works for multi-entity projection chains.
  const connected = (binding, row) => {
    const found = new Map(bindings.map((b) => [b.name, new Map()]));
    // a row is queued once per binding, however many edges reach it, so the
    // fan-out bound counts connected rows rather than the paths to them
    const queued = new Map(bindings.map((b) => [b.name, new Set()]));
    queued.get(binding.name).add(keyOf(binding, row));
    const queue = [[binding, row]];
    for (let i = 0; i < queue.length; i++) {
      const [current, doc] = queue[i];
      found.get(current.name).set(keyOf(current, doc), doc);
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
          if (queued.get(target.name).has(token)) continue;
          queued.get(target.name).add(token);
          queue.push([target, caches.get(other.binding).get(token)]);
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
    const input = Object.fromEntries(bindings.map((binding) => [binding.member,
      binding === root ? [row] : sorted(binding, related.get(binding.name).values())]));
    const result = evaluate(input, context.externals);
    const fresh = result === undefined ? [] : Array.isArray(result) ? result : [result];
    const previous = items.get(key) ?? [];
    outputCount += fresh.length - previous.length;
    maintainedBytes += bytesOf(fresh) - (items.has(key) ? bytesOf(previous) : 0);
    items.set(key, fresh.map((item, i) => valueKey(previous[i]) === valueKey(item) ? previous[i] : item));
    counts.refreshedRoots++;
    bound();
  };
  const flatten = () => sorted(root, caches.get(root.name).values()).flatMap((row) => items.get(keyOf(root, row)) ?? []);
  return {
    close() { for (const cache of caches.values()) cache.clear(); for (const index of indices.values()) index.clear();
      for (const position of positions.values()) position.clear(); items.clear(); },
    init() {
      for (const [entity, aliases] of aliasesOf) {
        const document = [{ $subsequence: [{ $for: { it: entityRoot(entity) }, $return: '$it' }, 0, context.maxMaintained + 1] }];
        const rows = context.execute(document, { externals: context.externals });
        for (const row of rows) {
          const key = keyOf(aliases[0], row);
          const position = context.dependencyPosition(entity, key);
          for (const binding of aliases) hold(binding, key, row, position);
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
        if (aliasesOf.has(table)) changed.set(JSON.stringify([table, token]), { table, token });
      }
      // the outer owners a changed row reaches through any alias holding it
      const reach = () => {
        for (const { table, token } of changed.values()) for (const binding of aliasesOf.get(table)) {
          const row = caches.get(binding.name).get(token);
          if (binding === root) affected.add(token);
          if (row !== undefined) for (const key of connected(binding, row).get(root.name).keys()) affected.add(key);
        }
      };
      reach();
      // one logical read per changed row, whatever the number of its aliases
      for (const { table, token } of changed.values()) {
        const row = context.readDependency(table, token);
        counts.dependencyReads++;
        const position = row === undefined ? undefined : context.dependencyPosition(table, token);
        for (const binding of aliasesOf.get(table)) hold(binding, token, row, position);
      }
      reach();
      for (const key of affected) refresh(key);
      const next = flatten();
      return context.diff(previousRows, next);
    },
  };
}
