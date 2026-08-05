//@ts-check
/**
 * @file Live queries (LIVE-FORMAT §§7–12): a registered query document
 * whose result is maintained as capture records arrive, emitting
 * RFC 6902 patches against its own `{ rows }` result document.
 *
 * The CLASSIFIER implements §7's normative table and nothing more —
 * it unwraps the one-element array pack and literal `$subsequence`
 * windows the same way the planner does, then reads the compiled
 * plan: translated filters, order terms and aggregates are exactly
 * the planner's, never a re-implementation. Everything outside the
 * table re-runs on invalidation with the reason named (`live.mode`).
 *
 * Maintenance is synchronous inside capture delivery (§8): inserts
 * carry their document in the patch, updates point-read the touched
 * row, deletes are answered from maintained state. Per-row semantics
 * reuse the ENGINE via packed one-row compilation (the residual
 * discipline) — a live row evaluates exactly as the query would.
 */

import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';
import { stableStringify } from '@jarenjs/core/object';

import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import { planQuery } from './plan.js';
import { createSortedWindow } from './window.js';

/** The store-level live bounds and their defaults (§12: printed,
 * never silent). */
export const LIVE_DEFAULTS = Object.freeze({ maxQueries: 64, maxMaintained: 10_000 });

const AGGREGATE_MEMBERS = new Map([
  ['$count', 'count'], ['$sum', 'sum'], ['$avg', 'avg'],
  ['$min', 'min'], ['$max', 'max'],
]);

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);

/** Unescape one RFC 6901 token. */
const unescapeToken = (token) => token.replace(/~1/g, '/').replace(/~0/g, '~');

/** Split an emitted pointer into unescaped segments. */
const segmentsOf = (path) => path.split('/').slice(1).map(unescapeToken);

/**
 * Peel the canonical wrappers off a document the way the planner
 * does: one-element array pack, then literal `$subsequence` windows,
 * then a top-level aggregate member.
 * @param {any} document
 */
function unwrapDocument(document) {
  let doc = Array.isArray(document) && document.length === 1 ? document[0] : document;
  let offset = 0;
  let limit = null;
  let windowed = false;
  while (isPlainObject(doc) && Array.isArray(doc.$subsequence)
    && Object.keys(doc).length === 1
    && typeof doc.$subsequence[1] === 'number'
    && (doc.$subsequence[2] === undefined || typeof doc.$subsequence[2] === 'number')) {
    windowed = true;
    offset += doc.$subsequence[1];
    const length = doc.$subsequence[2];
    if (length !== undefined) limit = limit === null ? length : Math.min(limit, length);
    doc = doc.$subsequence[0];
  }
  let aggregate = null;
  if (isPlainObject(doc)) {
    const keys = Object.keys(doc);
    if (keys.length === 1 && AGGREGATE_MEMBERS.has(keys[0])) {
      aggregate = { name: keys[0], fn: AGGREGATE_MEMBERS.get(keys[0]) };
      doc = doc[keys[0]];
      // a window INSIDE the aggregate is still a windowed aggregate
      while (isPlainObject(doc) && Array.isArray(doc.$subsequence)
        && Object.keys(doc).length === 1) {
        windowed = true;
        doc = doc.$subsequence[0];
      }
    }
  }
  return { inner: doc, windowed, offset, limit, aggregate };
}

/** The single for-binding name of a canonical flwor, or null. */
function bindingNameOf(inner) {
  if (!isPlainObject(inner) || !isPlainObject(inner.$for)) return null;
  const names = Object.keys(inner.$for);
  if (names.length !== 1) return null;
  return inner.$for[names[0]] === '$[*]' ? names[0] : null;
}

/** The whole-documents read behind a flwor: same binding, same
 * filter, the bare document returned — the SQL-narrowed source every
 * strategy initializes from. */
function documentsSource(binding, where) {
  return {
    $for: { [binding]: '$[*]' },
    ...(where !== undefined ? { $where: where } : {}),
    $return: `$${binding}`,
  };
}

/**
 * Recognise the canonical single-level group form (§7): one binding
 * over `$[*]`, optional `$where`, `$groupby` with ONE binding, and a
 * `$return` object whose members are the group key (`$g` plain or
 * defaulted) or a single-member aggregate over the group sequence.
 * @param {any} inner
 * @returns {null | { binding: string, group: string, groupExpr: any,
 *   where: any, members: { name: string, kind: 'key' | 'aggregate',
 *   fn?: string, operand?: any, defaulted?: boolean }[] }}
 */
function recogniseGroupForm(inner) {
  const binding = bindingNameOf(inner);
  if (binding === null || !isPlainObject(inner.$groupby)) return null;
  const allowed = new Set(['$for', '$where', '$groupby', '$return']);
  if (!Object.keys(inner).every((key) => allowed.has(key))) return null;
  const groupNames = Object.keys(inner.$groupby);
  if (groupNames.length !== 1) return null;
  const group = groupNames[0];
  if (!isPlainObject(inner.$return)) return null;
  const members = [];
  for (const name of Object.keys(inner.$return)) {
    const expr = inner.$return[name];
    if (expr === `$${group}`) {
      members.push({ name, kind: 'key', defaulted: false });
      continue;
    }
    if (isPlainObject(expr) && Array.isArray(expr.$default)
      && expr.$default.length === 2 && expr.$default[0] === `$${group}`
      && expr.$default[1] === null && Object.keys(expr).length === 1) {
      members.push({ name, kind: 'key', defaulted: true });
      continue;
    }
    if (isPlainObject(expr) && Object.keys(expr).length === 1
      && AGGREGATE_MEMBERS.has(Object.keys(expr)[0])) {
      const op = Object.keys(expr)[0];
      members.push({ name, kind: 'aggregate', fn: AGGREGATE_MEMBERS.get(op), operand: expr[op] });
      continue;
    }
    return null;
  }
  return { binding, group, groupExpr: inner.$groupby[group], where: inner.$where, members };
}

/**
 * Collect the top-level document members a compiled expression reads
 * through an item binding — the §8 member-level dependency set. Any
 * non-simple first step (wildcard, descendant, index) widens to the
 * whole collection.
 * @param {any} node - an analysis AST node
 * @param {{ whole: boolean, members: Set<string> }} into
 */
function collectTopMembers(node, into) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTopMembers(item, into);
    return;
  }
  if (node.kind === 'path' && node.rootSlot > 0 && node.external !== true) {
    const first = node.segments[0];
    if (first === undefined) {
      into.whole = true; // the bare binding: the whole document is read
    }
    else if (first.descendant !== true && first.selectors.length === 1
      && first.selectors[0].kind === 'name') {
      into.members.add(first.selectors[0].name);
    }
    else {
      into.whole = true;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'docPath') continue;
    collectTopMembers(node[key], into);
  }
}

/** Derive the member dependency set from an analysis root. */
function memberDeps(root) {
  const deps = { whole: false, members: new Set() };
  collectTopMembers(root, deps);
  return deps;
}

/**
 * Classify a collection query document against §7's table. Pure —
 * given the document and the collection's planner shape, returns the
 * strategy description, or a re-run description with the reason.
 * @param {any} document
 * @param {any} queryShape - the planner shape (collection, schema,
 *   columnByCanonical)
 * @param {boolean} keyed - whether documents carry their key (a
 *   declared key pointer); unkeyed rows cannot be tracked by key
 * @returns {any}
 */
export function classifyLiveQuery(document, queryShape, keyed) {
  const rerun = (reason) => ({ strategy: 'rerun', reason });
  const plannerReason = (planned) => {
    const forcing = planned.reasons[0]
      ?? { construct: 'residual', reason: 'the document did not translate' };
    return `'${forcing.construct}' — ${forcing.reason}`;
  };
  const { inner, windowed, offset, limit, aggregate } = unwrapDocument(document);

  if (aggregate !== null) {
    if (windowed) return rerun('a windowed aggregate maintains no accumulator');
    const planned = planQuery({ [aggregate.name]: inner }, queryShape, {});
    if (planned.mode !== 'native' || planned.plan.aggregate === null) {
      return rerun(plannerReason(planned));
    }
    if (!keyed) return rerun('rows without a document key cannot be tracked');
    return {
      strategy: 'accumulator',
      fn: planned.plan.aggregate.fn,
      operand: inner,
      deps: memberDeps(planned.analysis.root),
    };
  }

  const group = recogniseGroupForm(inner);
  if (group !== null) {
    if (windowed) return rerun('a windowed group re-runs');
    const carrier = documentsSource(group.binding, group.where);
    const planned = planQuery(carrier, queryShape, {});
    if (planned.mode !== 'native') {
      return rerun(`the group filter did not translate: ${plannerReason(planned)}`);
    }
    if (!keyed) return rerun('rows without a document key cannot be tracked');
    const rowDocument = {
      $for: { [group.binding]: '$[*]' },
      ...(group.where !== undefined ? { $where: group.where } : {}),
      $return: {
        k: [group.groupExpr],
        ...Object.fromEntries(group.members
          .filter((member) => member.kind === 'aggregate')
          .map((member) => [member.name, [member.operand]])),
      },
    };
    return {
      strategy: 'group', group, carrier, rowDocument,
      deps: memberDeps(analyzeQuery([rowDocument]).root),
    };
  }

  const planned = planQuery(inner, queryShape, {});
  if (planned.mode === 'set') return rerun(plannerReason(planned));
  if (!keyed) return rerun('rows without a document key cannot be tracked');

  if (planned.plan.order !== null) {
    if (offset > 0 || (planned.plan.window?.offset ?? 0) > 0) {
      return rerun('an offset window re-runs');
    }
    const returnCard = planned.analysis.root.return?.card ?? 1;
    if (returnCard > 2) return rerun('a one-to-many projection under an order re-runs');
    return {
      strategy: 'window',
      inner,
      order: planned.plan.order,
      limit: planned.plan.window?.limit ?? limit,
      deps: { whole: true, members: new Set() },
    };
  }
  if (planned.plan.window !== null || windowed) {
    return rerun('a limit without an order is not deterministic to maintain');
  }
  return {
    strategy: 'rows',
    inner,
    projected: planned.mode === 'row',
    deps: { whole: true, members: new Set() },
  };
}

// ————— shared machinery —————

/**
 * Diff two row arrays into sequential add/remove/replace ops under
 * `/rows`, relying on REFERENCE identity for unchanged rows (the §9
 * sharing contract makes identity the equality that matters). A
 * working copy is replayed op by op, so the emitted patch transforms
 * the old array into the new one BY CONSTRUCTION; a remove re-filled
 * at the same index merges into a replace.
 * @param {any[]} oldRows
 * @param {any[]} newRows
 * @returns {any[]} ops
 */
export function diffRows(oldRows, newRows) {
  const ops = [];
  const work = oldRows.slice();
  const wanted = new Set(newRows);
  for (let i = work.length - 1; i >= 0; i--) {
    if (!wanted.has(work[i])) {
      ops.push({ op: 'remove', path: `/rows/${i}` });
      work.splice(i, 1);
    }
  }
  for (let i = 0; i < newRows.length; i++) {
    if (work[i] === newRows[i]) continue;
    const found = work.indexOf(newRows[i], i + 1);
    if (found !== -1) {
      ops.push({ op: 'remove', path: `/rows/${found}` });
      work.splice(found, 1);
    }
    ops.push({ op: 'add', path: `/rows/${i}`, value: newRows[i] });
    work.splice(i, 0, newRows[i]);
  }
  // duplicate primitive values can leave a surplus tail (the Set
  // collapsed them): trim it
  for (let i = work.length - 1; i >= newRows.length; i--) {
    ops.push({ op: 'remove', path: `/rows/${i}` });
    work.splice(i, 1);
  }
  const merged = [];
  for (let i = 0; i < ops.length; i++) {
    const here = ops[i];
    const next = ops[i + 1];
    if (next !== undefined && here.op === 'remove' && next.op === 'add'
      && here.path === next.path) {
      merged.push({ op: 'replace', path: here.path, value: next.value });
      i++;
      continue;
    }
    merged.push(here);
  }
  return merged;
}

/** The shared emission tail: ops plus the next rows, or null when
 * nothing visibly changed. */
function diffAgainst(previousRows, nextRows) {
  const ops = diffRows(previousRows, nextRows);
  return ops.length === 0 ? null : { ops, rows: nextRows };
}

/** Reuse the previous row object when a fresh one is value-equal —
 * the structural-sharing half of §9 for re-evaluated rows. */
function sharedRow(previous, fresh) {
  return stableStringify(previous) === stableStringify(fresh) ? previous : fresh;
}

/**
 * Map fresh rows onto previous references where value-equal — the
 * sharing pass for strategies that rebuild their row list (window
 * re-placements, re-runs).
 * @param {any[]} previousRows
 * @param {any[]} nextRows
 */
function shareByValue(previousRows, nextRows) {
  const kept = new Set(nextRows.filter((row) => previousRows.includes(row)));
  /** @type {Map<string, any[]>} */
  const pool = new Map();
  for (const row of previousRows) {
    if (kept.has(row)) continue;
    const key = stableStringify(row) ?? '';
    const bucket = pool.get(key);
    if (bucket === undefined) pool.set(key, [row]);
    else bucket.push(row);
  }
  return nextRows.map((row) => {
    if (kept.has(row)) return row;
    const bucket = pool.get(stableStringify(row) ?? '');
    return bucket !== undefined && bucket.length > 0 ? bucket.shift() : row;
  });
}

/**
 * Extract this collection's touched keys from one capture record,
 * respecting the member-level dependency set (§8).
 * @param {any} record
 * @param {string} name - collection name
 * @param {{ whole: boolean, members: Set<string> }} deps
 * @returns {Map<string, { kind: 'insert' | 'delete' | 'update', doc?: any }> | null}
 */
function touchedKeys(record, name, deps) {
  /** @type {Map<string, any>} */
  const touched = new Map();
  for (const op of record.patch) {
    const segments = segmentsOf(op.path);
    if (segments[0] !== name) continue;
    const token = segments[1];
    if (segments.length === 2) {
      if (op.op === 'add') touched.set(token, { kind: 'insert', doc: op.value });
      else if (op.op === 'remove') touched.set(token, { kind: 'delete' });
      else touched.set(token, { kind: 'update' });
      continue;
    }
    if (!deps.whole && !deps.members.has(segments[2])) continue;
    if (!touched.has(token)) touched.set(token, { kind: 'update' });
  }
  return touched.size === 0 ? null : touched;
}

// ————— strategies —————

/**
 * `where` (+ per-row `select`): §7's incremental rows. Bookkeeping is
 * per source key — a projected row may yield 0..n items — and the
 * result keeps arrival order (§9).
 * @param {any} description
 * @param {any} context
 */
function rowsStrategy(description, context) {
  const { inner } = description;
  const binding = /** @type {string} */ (bindingNameOf(inner));
  const evaluate = compileJsonQuery([inner]);
  const source = documentsSource(binding, inner.$where);

  /** @type {Map<string, any[]>} arrival-ordered per-key items */
  const itemsByKey = new Map();
  const flatten = () => {
    const rows = [];
    for (const items of itemsByKey.values()) rows.push(...items);
    return rows;
  };

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) {
          const items = /** @type {any[]} */ (evaluate([doc], context.externals));
          if (items.length > 0) itemsByKey.set(context.keyOf(doc), items);
        }
        return flatten();
      }),
    entries: () => flatten().length,
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      let changed = false;
      for (const [token, change] of touched) {
        const previous = itemsByKey.get(token);
        const doc = change.kind === 'delete'
          ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(token);
        const fresh = doc === undefined
          ? []
          : /** @type {any[]} */ (evaluate([doc], context.externals));
        if (fresh.length === 0) {
          if (previous !== undefined) {
            itemsByKey.delete(token);
            changed = true;
          }
          continue;
        }
        if (previous === undefined) {
          itemsByKey.set(token, fresh);
          changed = true;
          continue;
        }
        const next = fresh.map((item, index) => sharedRow(previous[index], item));
        if (next.length !== previous.length
          || next.some((item, index) => item !== previous[index])) {
          itemsByKey.set(token, next);
          changed = true;
        }
      }
      return changed ? diffAgainst(previousRows, flatten()) : null;
    },
  };
}

/**
 * `orderBy` (+ `limit`): §7's maintained window over ALL matching
 * rows — which is what answers a delete inside the visible window
 * without a re-query — with the first `limit` entries visible and
 * ties broken by the key token.
 * @param {any} description
 * @param {any} context
 */
function windowStrategy(description, context) {
  const { inner, order, limit } = description;
  const binding = /** @type {string} */ (bindingNameOf(inner));
  const rowDocument = { ...inner };
  delete rowDocument.$orderby;
  const evaluate = compileJsonQuery([rowDocument]);
  const source = documentsSource(binding, inner.$where);
  const getters = order.map((term) => {
    const steps = term.ref.segments.map((segment) =>
      ('name' in segment ? segment.name : segment.index));
    return (doc) => {
      let value = doc;
      for (const step of steps) {
        if (value === null || typeof value !== 'object') return undefined;
        value = value[step];
      }
      return value;
    };
  });
  const sortedWindow = createSortedWindow(order, limit);

  const place = (token, doc) => {
    const items = /** @type {any[]} */ (evaluate([doc], context.externals));
    if (items.length === 0) return;
    sortedWindow.insert(token, getters.map((get) => get(doc)), items[0]);
  };
  const visibleRows = () => sortedWindow.visible().map((entry) => entry.item);

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) place(context.keyOf(doc), doc);
        return visibleRows();
      }),
    entries: () => sortedWindow.size(),
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      for (const [token, change] of touched) {
        sortedWindow.remove(token);
        if (change.kind === 'delete') continue;
        const doc = change.kind === 'insert' ? change.doc : context.readRow(token);
        if (doc !== undefined) place(token, doc);
      }
      return diffAgainst(previousRows, shareByValue(previousRows, visibleRows()));
    },
  };
}

/**
 * Whole-query aggregates: §7's running accumulator with per-row
 * contributions. `min`/`max` FALL BACK to a recompute over the
 * retained contributions when the current extremum's last holder
 * leaves — the documented fallback, counted in `stats().fallbacks`.
 * @param {any} description
 * @param {any} context
 */
function accumulatorStrategy(description, context) {
  const { fn, operand } = description;
  const isCount = fn === 'count';
  const evaluate = compileJsonQuery([operand]);
  const binding = bindingNameOf(operand);
  const source = binding === null
    ? { $for: { it: '$[*]' }, $return: '$it' }
    : documentsSource(binding, operand.$where);

  /** @type {Map<string, number | number[]>} */
  const contributions = new Map();
  const stats = { fallbacks: 0 };

  const contributionOf = (doc) => {
    const items = /** @type {any[]} */ (evaluate([doc], context.externals));
    if (items.length === 0) return undefined;
    return isCount ? items.length : items;
  };
  const fold = () => {
    let sum = 0;
    let count = 0;
    let extreme;
    for (const contribution of contributions.values()) {
      if (isCount) {
        count += /** @type {number} */ (contribution);
        continue;
      }
      for (const value of /** @type {number[]} */ (contribution)) {
        sum += value;
        count += 1;
        if (extreme === undefined
          || (fn === 'min' ? value < extreme : value > extreme)) extreme = value;
      }
    }
    if (fn === 'count') return count;
    if (fn === 'sum') return sum;
    if (count === 0) return undefined;
    return fn === 'avg' ? sum / count : extreme;
  };

  /** @type {any} */
  let current;
  const rowsOf = () => (current === undefined ? [] : [current]);

  return {
    init: () => chain(context.execute([source], { externals: context.externals }),
      (docs) => {
        for (const doc of /** @type {any[]} */ (docs)) {
          const contribution = contributionOf(doc);
          if (contribution !== undefined) {
            contributions.set(context.keyOf(doc), contribution);
          }
        }
        current = fold();
        return rowsOf();
      }),
    entries: () => contributions.size,
    stats: () => ({ ...stats }),
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      let changed = false;
      let extremumLeft = false;
      for (const [token, change] of touched) {
        const previous = contributions.get(token);
        const doc = change.kind === 'delete'
          ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(token);
        const next = doc === undefined ? undefined : contributionOf(doc);
        if (stableStringify(previous ?? null) === stableStringify(next ?? null)) continue;
        changed = true;
        if ((fn === 'min' || fn === 'max') && previous !== undefined
          && current !== undefined
          && /** @type {number[]} */ (previous).includes(current)) {
          extremumLeft = true;
        }
        if (next === undefined) contributions.delete(token);
        else contributions.set(token, next);
      }
      if (!changed) return null;
      if (extremumLeft) stats.fallbacks += 1;
      // count/sum/avg fold in O(state); the same recompute IS the
      // min/max fallback when the extremum's holder left
      current = fold();
      return diffAgainst(previousRows, shareByValue(previousRows, rowsOf()));
    },
  };
}

/**
 * Canonical single-level `groupBy` with aggregate returns: §7's
 * per-group deltas — the accumulator machinery once per group, groups
 * in first-appearance order.
 * @param {any} description
 * @param {any} context
 */
function groupStrategy(description, context) {
  const { group, rowDocument, carrier } = description;
  const evaluate = compileJsonQuery([rowDocument]);

  /** @type {Map<string, { key: any[], rows: Map<string, any>, row: any }>}
   * group token → per-row contributions, in first-appearance order */
  const groups = new Map();

  const contributionOf = (doc) => {
    const evaluated = /** @type {any[]} */ (evaluate([doc], context.externals));
    return evaluated.length === 0 ? undefined : evaluated[0];
  };
  const buildRow = (entry) => {
    /** @type {any} */
    const row = {};
    for (const member of group.members) {
      if (member.kind === 'key') {
        if (entry.key.length > 0) row[member.name] = entry.key[0];
        else if (member.defaulted) row[member.name] = null;
        continue;
      }
      let sum = 0;
      let count = 0;
      let extreme;
      let n = 0;
      for (const contribution of entry.rows.values()) {
        const items = /** @type {any[]} */ (contribution[member.name] ?? []);
        n += items.length;
        for (const value of items) {
          sum += value;
          count += 1;
          if (extreme === undefined
            || (member.fn === 'min' ? value < extreme : value > extreme)) extreme = value;
        }
      }
      if (member.fn === 'count') row[member.name] = n;
      else if (member.fn === 'sum') row[member.name] = sum;
      else if (count > 0) row[member.name] = member.fn === 'avg' ? sum / count : extreme;
      // an empty avg/min/max leaves the member absent, the engine's
      // empty-sequence rule
    }
    return row;
  };
  const rowsOf = () => [...groups.values()].map((entry) => entry.row);

  const placeRow = (token, doc, changedGroups) => {
    const contribution = doc === undefined ? undefined : contributionOf(doc);
    for (const [groupToken, entry] of groups) {
      if (!entry.rows.has(token)) continue;
      if (contribution !== undefined
        && stableStringify(entry.rows.get(token)) === stableStringify(contribution)) {
        return; // unchanged in place
      }
      entry.rows.delete(token);
      changedGroups.add(groupToken);
      break;
    }
    if (contribution === undefined) return;
    const groupToken = stableStringify(contribution.k) ?? '';
    let entry = groups.get(groupToken);
    if (entry === undefined) {
      entry = { key: contribution.k, rows: new Map(), row: null };
      groups.set(groupToken, entry);
    }
    entry.rows.set(token, contribution);
    changedGroups.add(groupToken);
  };
  const settle = (changedGroups) => {
    for (const groupToken of changedGroups) {
      const entry = groups.get(groupToken);
      if (entry === undefined) continue;
      if (entry.rows.size === 0) groups.delete(groupToken);
      else entry.row = sharedRow(entry.row, buildRow(entry));
    }
  };

  return {
    init: () => chain(context.execute([carrier], { externals: context.externals }),
      (docs) => {
        const changedGroups = new Set();
        for (const doc of /** @type {any[]} */ (docs)) {
          placeRow(context.keyOf(doc), doc, changedGroups);
        }
        settle(changedGroups);
        return rowsOf();
      }),
    entries: () => {
      let total = groups.size;
      for (const entry of groups.values()) total += entry.rows.size;
      return total;
    },
    apply(record, previousRows) {
      const touched = touchedKeys(record, context.name, description.deps);
      if (touched === null) return null;
      const changedGroups = new Set();
      for (const [token, change] of touched) {
        const doc = change.kind === 'delete'
          ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(token);
        placeRow(token, doc, changedGroups);
      }
      if (changedGroups.size === 0) return null;
      settle(changedGroups);
      return diffAgainst(previousRows, rowsOf());
    },
  };
}

/**
 * Everything outside the table: re-run the WHOLE query on
 * invalidation and diff against the previous result with value-equal
 * reference reuse — declared, honest, reported through `live.mode`.
 * @param {any} description
 * @param {any} context
 */
function rerunStrategy(description, context) {
  const stats = { reruns: 0 };
  const normalise = (result) => (result === undefined ? []
    : Array.isArray(result) ? result : [result]);
  return {
    init: () => chain(
      context.execute(context.document, { externals: context.externals }),
      normalise),
    entries: (rows) => rows.length,
    stats: () => ({ ...stats }),
    apply(record, previousRows) {
      stats.reruns += 1;
      const result = context.execute(context.document, { externals: context.externals });
      const next = shareByValue(previousRows, normalise(result));
      return diffAgainst(previousRows, next);
    },
  };
}

// ————— the registry —————

/**
 * The store-level live-query registry: registration against the §12
 * bounds, capture-record delivery in commit order, lifecycle.
 * @param {{ maxQueries: number, maxMaintained: number }} bounds
 */
export function createLiveRegistry(bounds) {
  /** @type {Set<any>} */
  const queries = new Set();

  /**
   * @param {any} definition - `{ name, tables, document, externals,
   *   demanded, classification, execute, readRow, keyOf }`; entity
   *   re-runs pass `readRow`/`keyOf` as null and their bound tables.
   */
  const register = (definition) => {
    if (queries.size >= bounds.maxQueries) {
      throw new DbCompileError('JD0052',
        `the store's live.maxQueries bound of ${bounds.maxQueries} was reached`);
    }
    const classification = definition.classification;
    if (definition.demanded === 'incremental' && classification.strategy === 'rerun') {
      throw new DbCompileError('JD0051',
        `the demanded incremental mode is unavailable: ${classification.reason}`);
    }

    const context = {
      name: definition.name,
      document: definition.document,
      externals: definition.externals ?? {},
      execute: definition.execute,
      readRow: definition.readRow,
      keyOf: definition.keyOf,
    };
    const strategy = classification.strategy === 'rows' ? rowsStrategy(classification, context)
      : classification.strategy === 'window' ? windowStrategy(classification, context)
        : classification.strategy === 'accumulator'
          ? accumulatorStrategy(classification, context)
          : classification.strategy === 'group' ? groupStrategy(classification, context)
            : rerunStrategy(classification, context);

    /** @type {Set<Function>} */
    const observers = new Set();
    const state = {
      status: 'live',
      result: { rows: /** @type {any[]} */ ([]) },
      /** @type {any} */
      error: null,
      stats: { records: 0, matched: 0, emissions: 0 },
    };
    const checkBound = (entries) => {
      if (entries > bounds.maxMaintained) {
        throw new DbRuntimeError('JD2060',
          `the maintained live state (${entries} entries) exceeded the `
          + `live.maxMaintained bound of ${bounds.maxMaintained}`,
          { collection: definition.name });
      }
    };

    const query = {
      deliver(record) {
        if (state.status !== 'live') return;
        let relevant = false;
        for (const table of record.collections) {
          if (definition.tables.has(table)) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        state.stats.records += 1;
        let outcome;
        try {
          outcome = strategy.apply(record, state.result.rows);
          if (outcome !== null) checkBound(strategy.entries(outcome.rows));
        }
        catch (error) {
          state.status = 'errored';
          state.error = error;
          queries.delete(query);
          const failure = { error };
          for (const observer of observers) {
            try {
              observer(failure);
            }
            catch { /* observer isolation, the capture precedent */ }
          }
          observers.clear();
          return;
        }
        if (outcome === null) return;
        state.stats.matched += 1;
        state.stats.emissions += 1;
        state.result = { rows: outcome.rows };
        const event = { patch: outcome.ops, seq: record.seq };
        for (const observer of observers) {
          try {
            observer(event);
          }
          catch { /* isolation */ }
        }
      },
      close() {
        if (state.status === 'live') state.status = 'closed';
        queries.delete(query);
        observers.clear();
      },
    };

    return chain(strategy.init(), (rows) => {
      checkBound(strategy.entries(rows));
      state.result = { rows };
      queries.add(query);
      const mode = Object.freeze({
        strategy: classification.strategy,
        mode: classification.strategy === 'rerun' ? 'rerun' : 'incremental',
        ...(classification.strategy === 'rerun' ? { reason: classification.reason } : {}),
      });
      return Object.freeze({
        get result() { return state.result; },
        get state() { return state.status; },
        get error() { return state.error; },
        mode,
        stats: () => ({ ...state.stats, ...(strategy.stats?.() ?? {}) }),
        subscribe(observer) {
          if (state.status !== 'live') throw new TypeError('the live query is closed');
          observers.add(observer);
          return () => observers.delete(observer);
        },
        close: () => query.close(),
      });
    });
  };

  return {
    register,
    count: () => queries.size,
    deliver(record) {
      for (const query of [...queries]) query.deliver(record);
    },
    closeAll() {
      for (const query of [...queries]) query.close();
    },
  };
}
