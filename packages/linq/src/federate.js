//@ts-check
/**
 * @file The federation boundary (QUERY-PEN.md §13): an EXPLICIT opt-in
 * to reading two different provider sources under one query document.
 *
 * The rule everywhere else in this package is that a query document
 * reads ONE input, and a join whose sides come from two unrelated
 * sources is `JL0005` at build time. That refusal is not a limitation
 * to route around — it is what keeps a chain honest about where the
 * work happens. A cross-source join cannot be pushed anywhere: someone
 * has to hold rows in memory, and a surface that did it implicitly
 * would turn a one-line chain into an unbounded fetch of two
 * databases.
 *
 * So it is spelled out instead. `federate()` takes the sources by
 * name, takes the budgets that make the fetch finite, and hands back
 * one provider-compatible source per name, all sharing one scope — so
 * the join the chain already knows how to build is admitted, and the
 * federation is what executes it:
 *
 *   1. each binding's own document — the filters and the projection the
 *      chain already packed per side — runs against ITS source;
 *   2. the smaller side (declared estimate, else the first named) is
 *      streamed into a hash table keyed by the join key, counting rows
 *      and serialized bytes against the budget as it fills;
 *   3. the other side is streamed and PROBED: a row whose key no build
 *      row carries cannot join, so it is dropped before it costs
 *      anything;
 *   4. the caller's own document runs in the engine over the two
 *      reduced sets — the resident join, which is what decides.
 *
 * Step 4 is why this file spells no join semantics of its own. The
 * engine's `$eq` decides which rows pair, its ordering orders them and
 * its projection shapes them; the hash table exists to bound the FETCH,
 * never to answer the query. A reduction that dropped a row the engine
 * would have joined would be a wrong answer, so the probe keeps
 * anything it cannot key (a compound key value) rather than guessing.
 *
 * Non-goals, named rather than discovered: no spill (a budget is a
 * refusal, not a disk), no distributed transaction, no cross-source
 * write, and no non-equality join — without an equality key the fetch
 * is the cross product, which is exactly what the budget exists to
 * refuse.
 */

import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { compileDocument, isProviderSource, providerRoot } from './provider.js';
import { memberSegment } from './expression.js';

/** The strategies this boundary knows. One, for now, and it says so. */
const STRATEGIES = new Set(['hash']);

/**
 * A positive integer budget, or the refusal that names it.
 * @param {any} value
 * @param {string} what
 * @returns {number}
 */
function budgetOf(value, what) {
  if (!Number.isInteger(value) || value < 1) {
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
 * @returns {{ binding: string, path: string[] } | null}
 */
function memberPathOf(node) {
  if (typeof node !== 'string' || !node.startsWith('$')) return null;
  const parts = node.slice(1).split('.');
  if (parts.length < 2) return null;
  const [binding, ...path] = parts;
  if (binding === '' || path.some((name) => name === '')) return null;
  return { binding, path };
}

/** Read one member path out of a row; `undefined` where it is absent. */
function valueAt(row, path) {
  let value = row;
  for (const name of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[name];
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
function planFederation(document, members) {
  const located = locateFlwor(document);
  const query = located === null ? document : located.flwor;
  const bindings = query?.$for;
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new LinqBuildError('JL0005',
      'a federated document ranges over its sources with $for — this one has no bindings');
  }
  const names = Object.keys(bindings);
  if (names.length !== 2) {
    throw new LinqBuildError('JL0005',
      `a federated fetch joins exactly two sources, not ${names.length} — `
      + 'federate one pair at a time, or load the third side yourself');
  }

  /** @type {any[]} */
  const sides = [];
  for (const binding of names) {
    const value = bindings[binding];
    // the two spellings the chain builds: a bare root, or the side's
    // own packed document (its `$where`, its `$orderby`, its `$return`)
    const packed = Array.isArray(value) && value.length === 1 ? value[0] : null;
    // a packed side ranges over ONE root: a side that is itself a join
    // is a federation of a federation, which this boundary does not
    // plan and will not guess at
    const inner = packed === null ? [] : Object.keys(packed.$for ?? {});
    const root = packed === null ? value
      : (inner.length === 1 ? packed.$for[inner[0]] : null);
    if (typeof root !== 'string') {
      throw new LinqBuildError('JL0005',
        `the binding '${binding}' does not range over a federated source`);
    }
    const member = members.get(root);
    if (member === undefined) {
      throw new LinqBuildError('JL0005',
        `'${root}' is not one of this federation's sources `
        + `(${[...members.keys()].join(', ')})`);
    }
    sides.push({ binding, member, packed, root });
  }

  const key = joinKey(query.$where, sides);
  // the estimate decides which side fills the table: a hash join holds
  // the BUILD side whole, so the smaller declared side is the one to
  // hold. Undeclared estimates keep the caller's own order, which is
  // stable and says so in `explain()`
  const [first, second] = sides;
  const build = (second.member.estimatedRows ?? Infinity)
    < (first.member.estimatedRows ?? Infinity) ? second : first;
  const probe = build === first ? second : first;
  return {
    strategy: 'hash',
    build: { ...build, key: key[build.binding] },
    probe: { ...probe, key: key[probe.binding] },
    // the resident document is the caller's own with each side reduced
    // to its root: the packed work has already run at the source, and
    // whatever the terminal wrapped around the query is put back
    resident: located.rewrap({ ...query,
      $for: Object.fromEntries(sides.map((side) => [side.binding, side.root])) }),
  };
}

/**
 * The equality key that links the two sides, or the refusal.
 * @param {any} where
 * @param {any[]} sides
 * @returns {Record<string, string[]>}
 */
function joinKey(where, sides) {
  const conjuncts = where === undefined || where === null ? []
    : (Array.isArray(where?.$and) ? where.$and : [where]);
  const [a, b] = sides;
  for (const conjunct of conjuncts) {
    const operands = conjunct?.$eq;
    if (!Array.isArray(operands) || operands.length !== 2) continue;
    const left = memberPathOf(operands[0]);
    const right = memberPathOf(operands[1]);
    if (left === null || right === null) continue;
    if (left.binding === a.binding && right.binding === b.binding)
      return { [a.binding]: left.path, [b.binding]: right.path };
    if (left.binding === b.binding && right.binding === a.binding)
      return { [b.binding]: left.path, [a.binding]: right.path };
  }
  throw new LinqBuildError('JL0005',
    'a federated join needs an equality between one member of each side — without one the '
    + 'fetch is the cross product of two sources, which is what the budget exists to refuse '
    + '(a non-equality condition still applies, but it cannot bound the fetch)');
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
async function fetchSide(member, document, options, budget, keep, open) {
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
  const answer = await member.provider.execute(document, options);
  for (const row of itemsOf(answer)) admit(row);
  return { rows: kept, read, bytes, streamed: false };
}

/** The engine's answer shape as a row list: none, one, or many. */
function itemsOf(answer) {
  if (answer === undefined) return [];
  return Array.isArray(answer) ? answer : [answer];
}

/** One side's document, with the federated root rewritten to the source's own. */
function childDocument(side) {
  const own = providerRoot(side.member.provider);
  if (side.packed === null) return { $for: { it: own }, $return: '$it' };
  const binding = Object.keys(side.packed.$for)[0];
  return { ...side.packed, $for: { ...side.packed.$for, [binding]: own } };
}

/**
 * An explicit federation boundary over two or more provider sources.
 *
 * @param {{ sources: Record<string, any>, maxRows: number, maxBytes: number,
 *   strategy?: string }} spec
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
    try {
      const buildDoc = childDocument(plan.build);
      const built = await fetchSide(plan.build.member, buildDoc, options, budget,
        () => true, open);
      // the table is the REDUCTION, never the answer: it says which
      // keys can pair, and the engine decides which rows do
      const keys = new Set();
      let unkeyed = false;
      for (const row of built.rows) {
        const key = hashKey(valueAt(row, plan.build.key));
        if (key === null) unkeyed = true;
        else keys.add(key);
      }
      const probeDoc = childDocument(plan.probe);
      const probed = await fetchSide(plan.probe.member, probeDoc, options, budget,
        (row) => {
          if (unkeyed) return true;
          const key = hashKey(valueAt(row, plan.probe.key));
          return key === null || keys.has(key);
        }, open);

      const input = {
        [plan.build.member.name]: built.rows,
        [plan.probe.member.name]: probed.rows,
      };
      const compiled = compileDocument(plan.resident,
        { ...options, externals: options?.externalNames ?? [] });
      const answer = compiled(input, options?.externals ?? {});
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
      key: `$${side.binding}.${side.key.join('.')}`,
      document: childDocument(side),
      streaming: typeof side.member.provider.cursor === 'function' ? 'row' : 'buffered',
    });
    return {
      strategy: plan.strategy,
      budget: { ...budget },
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
