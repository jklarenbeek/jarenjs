//@ts-check
/**
 * @file Explicit bounded federation (QUERY-PEN §12.1). Source-local
 * documents execute at their providers; a connected mandatory equality
 * graph chooses the fetch order by declared estimates, with binding order
 * breaking ties. Hash membership only removes impossible candidates: the
 * query engine decides the resident result and its original tuple order.
 *
 * Packed joins emitted by successive LINQ joins execute inside out. Every
 * source and intermediate has a per-side budget, and one shared admission
 * counter covers the entire call. Intermediate phrase materialization is
 * capped through the query engine's own limits. Buffered providers and
 * intermediate byte sizes can only be checked after they produce an array;
 * cursor providers admit each retained row before holding it.
 *
 * No spill, distributed transaction, cross-source writes, or disconnected
 * cartesian products. Ordinary unrelated-source join() still refuses JL0005.
 */

import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { compileDocument, isProviderSource, providerRoot } from './provider.js';
import { memberSegment } from './expression.js';
import { parseJSONPath } from '@jarenjs/json/path';

/** The strategies this boundary knows. One, for now, and it says so. */
const STRATEGIES = new Set(['hash']);

/**
 * A positive integer budget, or the refusal that names it.
 * @param {any} value
 * @param {string} what
 * @returns {number}
 */
function budgetOf(value, what) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LinqBuildError('JL0005',
      `federate() needs a positive integer ${what} — a federated fetch holds rows in memory, `
      + 'and a bound is what makes that finite');
  }
  return value;
}

/**
 * The one member path a `'$it.a.b'` operand names, or `null` for
 * anything else (an operator call, a literal, the binding itself).
 * @param {any} node
 * @returns {{ binding: string, path: (string | number)[] } | null}
 */
function memberPathOf(node) {
  if (typeof node !== 'string' || !node.startsWith('$')) return null;
  const match = /^\$([^.[\]]+)([.[])/.exec(node);
  if (match === null) return null;
  try {
    const { segments } = parseJSONPath(`$${node.slice(match[1].length + 1)}`);
    if (!segments.every((segment) => !segment.descendant && segment.selectors.length === 1
      && ['name', 'index'].includes(segment.selectors[0].kind))) return null;
    return { binding: match[1], path: segments.map((segment) => {
      const selector = segment.selectors[0];
      return selector.kind === 'name' ? selector.name : selector.index;
    }) };
  }
  catch { return null; }
}

/** Read one member path out of a row; `undefined` where it is absent. */
function valueAt(row, path) {
  let value = row;
  for (const name of path) {
    if (value === null || typeof value !== 'object') return undefined;
    if (typeof name === 'number') {
      if (!Array.isArray(value)) return undefined;
      value = value[name < 0 ? value.length + name : name];
    }
    else {
      if (Array.isArray(value) || !Object.hasOwn(value, name)) return undefined;
      value = value[name];
    }
  }
  return value;
}

/**
 * The hash key of one join-key value, or `null` when the value cannot
 * be keyed at all.
 *
 * `null` is not "no key": it is the answer that this row must be kept
 * whatever the other side holds, because the engine's own comparison
 * decides it and a reduction may only ever drop rows that CANNOT pair.
 * A compound value is the case — `$eq` over two objects is a deep
 * comparison this table does not reproduce — so it opts out instead of
 * approximating.
 * @param {any} value
 * @returns {string | null}
 */
function hashKey(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return `s:${value}`;
  if (type === 'number') return Object.is(value, -0) ? 'n:0' : `n:${value}`;
  if (type === 'boolean') return `b:${value}`;
  return null;
}

/** The serialized size of one row, in bytes, as the budget counts it.
 * The encoder is built on first use: a module-level `new` is a side
 * effect, and a bundle that never federates should not pay for one. */
let encoder = null;
function byteSize(row) {
  const text = JSON.stringify(row);
  if (text === undefined) return 0;
  encoder ??= new TextEncoder();
  return encoder.encode(text).length;
}

/**
 * The FLWOR a terminal wrapped, and how to put a rewritten one back.
 *
 * An element terminal emits an ARRAY constructor around the query
 * (`[{ $for … }]`) so a provider answers exactly one array; an
 * aggregate wraps it in its own operator instead. The federation plans
 * the query and hands the WRAPPER back untouched, because what the
 * caller asked for around the join — one array, a count, a sum — is
 * the engine's to answer over the rows this boundary fetched.
 * @param {any} document
 * @returns {{ flwor: any, rewrap: (flwor: any) => any } | null}
 */
function locateFlwor(document) {
  if (document !== null && typeof document === 'object' && !Array.isArray(document)) {
    if (Object.hasOwn(document, '$for')) return { flwor: document, rewrap: (next) => next };
    const keys = Object.keys(document);
    if (keys.length === 1) {
      const inner = locateFlwor(document[keys[0]]);
      if (inner !== null) {
        return { flwor: inner.flwor,
          rewrap: (next) => ({ [keys[0]]: inner.rewrap(next) }) };
      }
    }
    return null;
  }
  if (Array.isArray(document) && document.length === 1) {
    const inner = locateFlwor(document[0]);
    if (inner !== null) return { flwor: inner.flwor, rewrap: (next) => [inner.rewrap(next)] };
  }
  return null;
}

/**
 * Split one federated document into the per-source work and the
 * resident document that decides over it, or refuse by name.
 *
 * The chain has already done the hard half: a side carrying filters or
 * a projection arrives PACKED as its own sub-document under the
 * binding, and a bare side arrives as its root path. Either way the
 * binding's value IS the child document, once its root is rewritten
 * from the federated name to the source's own.
 * @param {any} document
 * @param {Map<string, any>} members - federated name → member record
 * @returns {any}
 */
function planFederation(document, members, nested = false) {
  const located = locateFlwor(document);
  const query = located === null ? document : located.flwor;
  const bindings = query?.$for;
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new LinqBuildError('JL0005',
      'a federated document ranges over its sources with $for — this one has no bindings');
  }
  const names = Object.keys(bindings);
  if (names.length < (nested ? 1 : 2)) {
    throw new LinqBuildError('JL0005', 'a federated fetch needs at least two source bindings');
  }

  /** @type {any[]} */
  const sides = [];
  for (const binding of names) {
    const value = bindings[binding];
    // the two spellings the chain builds: a bare root, or the side's
    // own packed document (its `$where`, its `$orderby`, its `$return`)
    const packed = Array.isArray(value) && value.length === 1 ? value[0] : null;
    // A source-local phrase has one bare root; a packed join is planned
    // recursively and becomes a bounded intermediate side.
    const inner = packed === null ? [] : Object.keys(packed.$for ?? {});
    const root = packed === null ? value
      : (inner.length === 1 ? packed.$for[inner[0]] : null);
    if (typeof root !== 'string') {
      if (packed === null || inner.length === 0) {
        throw new LinqBuildError('JL0005',
          `the binding '${binding}' does not range over a federated source`);
      }
      const child = planFederation(packed, members, true);
      sides.push({ binding, nested: child, packed, root: null,
        member: { name: binding, estimatedRows: undefined } });
      continue;
    }
    const member = members.get(root);
    if (member === undefined) {
      throw new LinqBuildError('JL0005',
        `'${root}' is not one of this federation's sources `
        + `(${[...members.keys()].join(', ')})`);
    }
    sides.push({ binding, member, packed, root });
  }

  // A mandatory equality graph supplies the fetch order. OR branches
  // never prove an edge. Estimates choose among connected candidates;
  // equal or absent estimates retain binding declaration order.
  const edges = [];
  const visit = (where) => {
    if (Array.isArray(where?.$and)) { where.$and.forEach(visit); return; }
    const operands = where?.$eq;
    if (!Array.isArray(operands) || operands.length !== 2) return;
    const left = memberPathOf(operands[0]);
    const right = memberPathOf(operands[1]);
    if (left && right && left.binding !== right.binding
      && names.includes(left.binding) && names.includes(right.binding)) edges.push({ left, right });
  };
  visit(query.$where);
  const remaining = [...sides];
  const order = [];
  const selected = new Set();
  while (remaining.length > 0) {
    const candidates = remaining.filter((side) => selected.size === 0 || edges.some(({ left, right }) =>
      (left.binding === side.binding && selected.has(right.binding))
      || (right.binding === side.binding && selected.has(left.binding))));
    if (candidates.length === 0) throw new LinqBuildError('JL0005',
      'a federated join needs an equality between one member of each side in a connected binding graph');
    candidates.sort((a, b) => (a.member.estimatedRows ?? Infinity) - (b.member.estimatedRows ?? Infinity));
    const side = candidates[0];
    side.links = edges.flatMap(({ left, right }) => {
      const [own, other] = left.binding === side.binding ? [left, right] : [right, left];
      return own.binding === side.binding && selected.has(other.binding)
        ? [{ key: own.path, binding: other.binding, otherKey: other.path }] : [];
    });
    const edge = edges.find(({ left, right }) => left.binding === side.binding || right.binding === side.binding);
    side.key = edge === undefined ? [] : (edge.left.binding === side.binding ? edge.left.path : edge.right.path);
    order.push(side); selected.add(side.binding); remaining.splice(remaining.indexOf(side), 1);
  }
  // Bindings may independently project or alias the same source. Give
  // those sets separate input members so one cannot overwrite another.
  const used = new Set(sides.filter((side) => side.root !== null).map((side) => side.member.name));
  const roots = new Set();
  for (const side of sides) {
    side.inputName = side.member.name;
    if (side.root === null || roots.has(side.root)) {
      let name = `_federated${sides.indexOf(side)}`;
      while (used.has(name)) name += '_';
      used.add(name); side.inputName = name; side.root = `$${memberSegment(name)}[*]`;
    }
    roots.add(side.root);
  }
  return { strategy: 'hash', sides: order, build: order[0], probe: order[1],
    resident: located.rewrap({ ...query,
      $for: Object.fromEntries(sides.map((side) => [side.binding,
        side.packed === null ? side.root : [side.root]])) }) };
}

/**
 * Stream one side's rows, under its own budget.
 *
 * A source that offers a cursor is pulled one row at a time, so the
 * budget REFUSES before the row that would break it is held; one that
 * offers only `execute` answers whole, and the count is checked over
 * what came back — the budget is still honoured, but the memory was
 * already spent at the source, which `explain()` says.
 * @param {any} member
 * @param {any} document
 * @param {any} options
 * @param {{ maxRows: number, maxBytes: number }} budget
 * @param {(row: any) => boolean} keep
 * @param {any[]} open - cursors to close, in order
 * @returns {Promise<{ rows: any[], read: number, bytes: number, streamed: boolean }>}
 */
async function fetchSide(member, document, options, budget, keep, open, combined) {
  const kept = [];
  let read = 0;
  let bytes = 0;
  const admit = (row) => {
    read++;
    if (!keep(row)) return;
    if (kept.length + 1 > budget.maxRows) {
      throw new LinqRuntimeError('JL2008',
        `the federated fetch of '${member.name}' reached its ${budget.maxRows}-row budget — `
        + 'narrow the sides, or raise maxRows');
    }
    const size = byteSize(row);
    if (bytes + size > budget.maxBytes) {
      throw new LinqRuntimeError('JL2008',
        `the federated fetch of '${member.name}' reached its ${budget.maxBytes}-byte budget `
        + `at row ${kept.length + 1} — narrow the sides, or raise maxBytes`);
    }
    if (combined.rows + 1 > combined.maxRows || combined.bytes + size > combined.maxBytes) {
      throw new LinqRuntimeError('JL2008',
        'the federated fetch reached its combined row or byte budget — narrow the sides, or raise maxTotalRows/maxTotalBytes');
    }
    combined.rows++; combined.bytes += size;
    bytes += size;
    kept.push(row);
  };

  const signal = options?.signal;
  const stopIfAborted = () => {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error ? signal.reason
        : new LinqRuntimeError('JL2008',
          `the federated fetch of '${member.name}' was aborted`);
    }
  };

  const cursor = typeof member.provider.cursor === 'function'
    ? member.provider.cursor(document, options) : null;
  if (cursor !== null) {
    const opened = await cursor;
    open.push(opened);
    for (;;) {
      // between rows, because that is where a cursor can be let go
      // without abandoning a pull the source is still inside
      stopIfAborted();
      const next = await opened.next();
      if (next.done === true) break;
      admit(next.value);
    }
    return { rows: kept, read, bytes, streamed: true };
  }
  stopIfAborted();
  // Frame the sequence as one array so an array-valued row is still
  // one row. Cursor sources already supply that item boundary.
  const answer = await member.provider.execute([document], options);
  if (!Array.isArray(answer)) throw new LinqRuntimeError('JL2008',
    `the federated source '${member.name}' did not answer the requested array frame`);
  for (const row of answer) { stopIfAborted(); admit(row); }
  return { rows: kept, read, bytes, streamed: false };
}

/** One side's document, with the federated root rewritten to the source's own. */
function childDocument(side) {
  if (side.nested) return side.packed;
  const own = providerRoot(side.member.provider);
  if (side.packed === null) return { $for: { it: own }, $return: '$it' };
  const binding = Object.keys(side.packed.$for)[0];
  return { ...side.packed, $for: { ...side.packed.$for, [binding]: own } };
}

/**
 * An explicit federation boundary over two or more provider sources.
 *
 * @param {{ sources: Record<string, any>, maxRows: number, maxBytes: number,
 *   maxTotalRows?: number, maxTotalBytes?: number, strategy?: string }} spec
 * @returns {{ source: (name: string) => any, names: readonly string[] }}
 * @example
 * const fed = federate({
 *   sources: { orders: shop.entity('Order'), events: analytics },
 *   maxRows: 50_000,
 *   maxBytes: 32 * 1024 * 1024,
 * });
 * const rows = await fromAsync(fed.source('orders'))
 *   .join(fromAsync(fed.source('events')), (o) => o.id, (e) => e.orderId,
 *     (o, e) => ({ id: o.id, at: e.at }))
 *   .toArray();
 */
export function federate(spec) {
  const sources = spec?.sources;
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new LinqBuildError('JL0005',
      'federate() takes its sources as an object of name → provider');
  }
  const names = Object.keys(sources);
  if (names.length < 2) {
    throw new LinqBuildError('JL0005',
      'federate() needs at least two named sources — one source is an ordinary chain');
  }
  const strategy = spec.strategy ?? 'hash';
  if (!STRATEGIES.has(strategy)) {
    throw new LinqBuildError('JL0005',
      `federate() knows the strategies ${[...STRATEGIES].join(', ')}, not '${strategy}'`);
  }
  const budget = {
    maxRows: budgetOf(spec.maxRows, 'maxRows'),
    maxBytes: budgetOf(spec.maxBytes, 'maxBytes'),
  };

  const totals = {
    maxRows: budgetOf(spec.maxTotalRows ?? budget.maxRows * 2, 'maxTotalRows'),
    maxBytes: budgetOf(spec.maxTotalBytes ?? budget.maxBytes * 2, 'maxTotalBytes'),
  };

  /** The scope every member shares: what admits the join, and nothing else. */
  const scope = Object.freeze({ federation: true });
  /** @type {Map<string, any>} federated root → member */
  const members = new Map();
  /** @type {Map<string, any>} name → the source handle */
  const handles = new Map();

  for (const name of names) {
    const declared = sources[name];
    const provider = declared !== null && typeof declared === 'object'
      && 'provider' in declared ? declared.provider : declared;
    if (!isProviderSource(provider)) {
      throw new LinqBuildError('JL0001',
        `federate()'s source '${name}' is not a provider: it exposes no execute(document, options)`);
    }
    const estimatedRows = declared?.estimatedRows;
    if (estimatedRows !== undefined && (!Number.isInteger(estimatedRows) || estimatedRows < 0)) {
      throw new LinqBuildError('JL0005',
        `federate()'s source '${name}' declares a non-integer estimatedRows`);
    }
    // the federated root, which is what the chain binds and what the
    // resident document ranges over; the source's OWN root is what its
    // child document uses, and `childDocument` rewrites between them
    const root = `$${memberSegment(name)}[*]`;
    members.set(root, { name, root, provider, estimatedRows });
  }

  /**
   * Run one federated document: fetch each side under its budget, then
   * let the engine decide over what came back.
   * @param {any} document
   * @param {any} options
   */
  const execute = async (document, options) => {
    const plan = planFederation(document, members);
    /** @type {any[]} */
    const open = [];
    const combined = { ...totals, rows: 0, bytes: 0 };
    const run = async (current, intermediate = false) => {
      const fetched = new Map();
      for (const side of current.sides) {
        const tables = side.links.map((link) => {
          const keys = new Set();
          let unkeyed = false;
          for (const row of fetched.get(link.binding)) {
            const key = hashKey(valueAt(row, link.otherKey));
            if (key === null) unkeyed = true; else keys.add(key);
          }
          return { ...link, keys, unkeyed };
        });
        const keep = (row) => tables.every((table) => {
          const key = hashKey(valueAt(row, table.key));
          return table.unkeyed || key === null || table.keys.has(key);
        });
        const member = side.nested ? { ...side.member,
          provider: { execute: () => run(side.nested, true) } } : side.member;
        const found = await fetchSide(member, childDocument(side), options, budget, keep, open, combined);
        fetched.set(side.binding, found.rows);
      }
      const input = Object.fromEntries(current.sides.map((side) => [side.inputName, fetched.get(side.binding)]));
      const limits = intermediate ? { ...options?.limits,
        sequenceItems: Math.min(options?.limits?.sequenceItems ?? Infinity, budget.maxRows),
        resultItems: Math.min(options?.limits?.resultItems ?? Infinity, budget.maxRows) } : options?.limits;
      const compiled = compileDocument(intermediate ? [current.resident] : current.resident,
        { ...options, limits, externals: options?.externalNames ?? [] });
      try { return compiled(input, options?.externals ?? {}); }
      catch (error) {
        if (intermediate && error.code === 'JQ2009' && /sequenceItems|resultItems/.test(error.message)) throw new LinqRuntimeError('JL2008',
          'a federated intermediate join reached its row budget');
        throw error;
      }
    };
    try {
      const answer = await run(plan);
      // the fetch answered, so a cursor that will not close IS this
      // call's failure rather than something to swallow
      await closeAll(open);
      return answer;
    }
    catch (error) {
      // the call's own failure is the one the caller gets: a cursor
      // that also fails to close must not replace the budget's refusal
      await closeAll(open).catch(() => {});
      throw error;
    }
  };

  /**
   * Every cursor a call opened, closed exactly once — whether it
   * answered, refused, failed or was aborted. One that will not close
   * does not strand the others; the first failure is raised after all
   * of them have been tried.
   * @param {any[]} open
   */
  const closeAll = async (open) => {
    /** @type {unknown[]} */
    const failures = [];
    for (const cursor of open.splice(0)) {
      try {
        if (typeof cursor?.return === 'function') await cursor.return();
      }
      catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  };

  /** What the federation will do, without doing any of it. */
  const explain = (document) => {
    const plan = planFederation(document, members);
    const describe = (side) => ({
      source: side.member.name,
      root: side.root,
      estimatedRows: side.member.estimatedRows ?? null,
      key: `$${side.binding}${side.key.map((part) => typeof part === 'number' ? `[${part}]` : memberSegment(part)).join('')}`,
      document: childDocument(side),
      streaming: typeof side.member.provider?.cursor === 'function' ? 'row' : 'buffered',
      ...(side.nested ? { children: side.nested.sides.map(describe) } : {}),
    });
    return {
      strategy: plan.strategy,
      budget: { ...budget },
      combinedBudget: { maxTotalRows: totals.maxRows, maxTotalBytes: totals.maxBytes },
      order: plan.sides.map(describe),
      build: describe(plan.build),
      probe: describe(plan.probe),
      // the join itself is the engine's, over what the two fetches
      // brought back — this boundary bounds the fetch and nothing else
      resident: { document: plan.resident },
    };
  };

  const handleFor = (name) => {
    let handle = handles.get(name);
    if (handle === undefined) {
      const root = `$${memberSegment(name)}[*]`;
      if (!members.has(root)) {
        throw new LinqBuildError('JL0005',
          `'${name}' is not one of this federation's sources (${names.join(', ')})`);
      }
      handle = Object.freeze({ execute, explain, root, scope });
      handles.set(name, handle);
    }
    return handle;
  };

  return Object.freeze({
    source: handleFor,
    names: Object.freeze([...names]),
  });
}
