//@ts-check
/**
 * @file `fromAsync` — the SAME operator surface over async sources,
 * emitting the SAME query documents (the D5 proof is a byte-identity
 * test), with terminals returning promises. The rule: the pipeline is
 * synchronous, the boundaries are async — a compiled Jaren query never
 * awaits; what is asynchronous is where rows come from (`fromAsync`
 * sources, providers) and where element-wise work happens (`mapAsync`,
 * the ONE bounded-concurrency boundary).
 *
 * Execution walks the stage list over the item stream:
 *
 *  - STREAMABLE stages (`where`, `select`/`selectMany`, `skip`,
 *    `take`, `distinct`, `ofType`, `cast`, `defaultIfEmpty`,
 *    constant `concat`) apply per item through per-stage compiled
 *    evaluators (`{$let: {it: '$'}}` documents — the engine itself, one
 *    item at a time), so memory stays flat.
 *  - BARRIER stages (`orderBy`, `groupBy`, `join`, `aggregate`,
 *    `reverse`) materialise: the stream so far is buffered and the
 *    maximal run of document stages executes through the sync engine
 *    over the buffer — inherent (the engine itself materialises for
 *    `$orderby`/`$groupby`), not incidental, and `explain()` names the
 *    forcing operator.
 *  - `mapAsync` applies the bounded-concurrency machinery between
 *    segments; it is NOT translatable to a document, so `toDocument()`
 *    refuses (`JL0005`) and `explain()` reports the split.
 *
 * Early termination CLOSES the source: every consumer is a
 * `for await … break` chain, and async generators propagate `return()`
 * inward — a generator left suspended would hold a file handle or a
 * read transaction open.
 */

import { compileDocument } from './provider.js';
import { emitDocument, wrapTerminal, snapshot, fanProjection } from './document.js';
import { adaptAsyncSource } from './sources.js';
import { applyMapAsync, normalizeMapAsyncOptions } from './concurrency.js';
import { captureExpression, toExpression, requireJsonBinding } from './expression.js';
import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { schemaOf } from './schema-of.js';
import { semanticKey } from '@jarenjs/core/object';

/** Barrier stage kinds and the reason each materialises. There is no
 * `join` here: a join's inner side re-reads the source, and an async
 * source is single-pass (LINQ-FORMAT.md §10). */
const BARRIERS = {
  orderBy: '$orderby materialises the tuple stream to sort it',
  thenBy: '$orderby materialises the tuple stream to sort it',
  groupBy: '$groupby materialises the tuple stream to group it',
  aggregate: '$fold folds the whole stream into one value',
  reverse: '$reverse needs the last item first',
};

/**
 * The distinct/grouping key.
 *
 * ONE relation, shared with the synchronous query engine: the async
 * operators must not decide two items are the same when a sync
 * `distinct()` over the same data keeps them apart. The hand-rolled
 * serializer this replaced had its own idea of sameness, and conflated
 * `Infinity` with `null` (both stringify to `null`), `NaN` with the
 * sentinel STRING it substituted for `NaN` (which a real string could
 * therefore forge), and any two objects carrying an own `__proto__`.
 * `semanticKey` is the suite's injective identity, so the async side uses
 * that — and for a value it refuses to key, falls back to the ITEM'S OWN
 * identity rather than a shared bucket.
 * @param {any} value
 * @returns {string | object}
 */
function itemKey(value) {
  try {
    return semanticKey(value);
  }
  catch {
    // a Date, a Map, a class instance, a cycle: not keyable as data, so
    // it counts as distinct from everything, including another one like
    // it. That is the safe direction — folding two together would drop a
    // row `distinct()` was asked to keep.
    return { unkeyable: value };
  }
}

/** The deferred async sequence. Construct via `fromAsync` or
 * `Sequence.prototype.mapAsync`. */
export class AsyncSequence {
  #origin;
  #stages;
  #params;
  #options;

  /**
   * @param {{ kind: 'source', iterate: () => AsyncIterator<any> }
   *   | { kind: 'sequence', runPrefix: (params: ReadonlyMap<string, any>) => any[],
   *       prefixDocument: () => any }} origin
   * @param {readonly any[]} stages
   * @param {ReadonlyMap<string, any>} params
   * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
   *   pathFunctions?: any, limits?: any, registry?: object }} options
   */
  constructor(origin, stages, params, options) {
    this.#origin = origin;
    this.#stages = stages;
    this.#params = params;
    this.#options = options;
  }

  /** @param {any} stage */
  #with(stage) {
    return new AsyncSequence(this.#origin, [...this.#stages, stage], this.#params, this.#options);
  }

  #externals() {
    return {
      names: [...this.#params.keys()],
      values: Object.fromEntries(this.#params),
    };
  }

  /** Compile one per-item evaluator: the stage expression under
   * `{$let: {it: '$'}}` with the terminal-window discipline. */
  #evaluator(returnExpr) {
    const { names } = this.#externals();
    return compileDocument({ $let: { it: '$' }, $return: returnExpr },
      { ...this.#options, externals: names });
  }

  //#region the operator surface (same vocabulary as Sequence)

  where(predicate) { return this.#chainCaptured('where', 'predicate', predicate); }
  select(projection) { return this.#chainCaptured('select', 'projection', projection); }
  selectMany(selector) {
    return this.#with({
      kind: 'select', name: 'selectMany',
      projection: fanProjection(captureFor(this.#params, selector)),
    });
  }

  /** @param {string} kind @param {string} slot @param {any} fn */
  #chainCaptured(kind, slot, fn) {
    // reuse the sync Sequence's capture through a local import-free
    // seam: capture lives in expression.js and is stage-agnostic
    return this.#with({ kind, [slot]: captureFor(this.#params, fn) });
  }

  orderBy(key, options) { return this.#orderStage('orderBy', key, false, options); }
  orderByDescending(key, options) { return this.#orderStage('orderBy', key, true, options); }
  thenBy(key, options) { return this.#orderStage('thenBy', key, false, options); }
  thenByDescending(key, options) { return this.#orderStage('thenBy', key, true, options); }

  #orderStage(kind, key, desc, options) {
    const spec = { $key: captureFor(this.#params, key) };
    if (desc) spec.$dir = 'desc';
    if (options !== undefined) {
      if (options.empty !== undefined) spec.$empty = options.empty;
      if (options.collation !== undefined) spec.$collation = options.collation;
    }
    return this.#with({ kind, name: desc ? `${kind}Descending` : kind, spec });
  }

  groupBy(key) { return this.#with({ kind: 'groupBy', key: captureFor(this.#params, key) }); }

  aggregate(seed, step) {
    return this.#with({
      kind: 'aggregate',
      seed: toExpression(seed),
      step: captureFor(this.#params, step, ['acc', 'it']),
    });
  }

  skip(count) { return this.#with({ kind: 'skip', count: requireIndex(count, 'skip') }); }
  take(count) { return this.#with({ kind: 'take', count: requireIndex(count, 'take') }); }
  distinct() { return this.#with({ kind: 'distinct' }); }
  reverse() { return this.#with({ kind: 'reverse' }); }

  /** Async sources are single-pass, so only a CONSTANT array can join
   * the stream (`JL0005` otherwise; the format doc says why). */
  concat(other) {
    if (!Array.isArray(other)) {
      throw new LinqBuildError('JL0005',
        'concat on an async sequence takes a constant array — an async source cannot be re-iterated for a second sequence');
    }
    // the JSON boundary (§5) and one copy at build time: the stage owns
    // its constants, and hands out a fresh copy per enumeration
    const items = toExpression(other).$const;
    return this.#with({
      kind: 'concat',
      other: { $for: { it: { $const: items } }, $return: '$it' },
      items,
    });
  }

  defaultIfEmpty(fallback = null) {
    const expr = toExpression(fallback);
    return this.#with({ kind: 'defaultIfEmpty', fallback: expr, value: expr?.$const ?? fallback });
  }

  ofType(schema) { return this.#with({ kind: 'ofType', schema: schemaOf(schema) }); }
  cast(schema) { return this.#with({ kind: 'cast', schema: schemaOf(schema) }); }

  zip() {
    throw new LinqBuildError('JL0006',
      'zip is unsupported: the query grammar has no positional co-iteration (see LINQ-FORMAT.md §4)');
  }

  /** The bounded-concurrency boundary (LINQ-FORMAT.md §11). */
  mapAsync(fn, options) {
    if (typeof fn !== 'function') {
      throw new LinqBuildError('JL0005', 'mapAsync takes an async callback');
    }
    return this.#with({ kind: 'mapAsync', fn, options: normalizeMapAsyncOptions(options) });
  }

  params(bindings) {
    validateParams(bindings);
    const merged = new Map(this.#params);
    for (const name of Object.keys(bindings)) {
      requireJsonBinding(name, bindings[name]);
      merged.set(name, bindings[name]);
    }
    return new AsyncSequence(this.#origin, this.#stages, merged, this.#options);
  }

  //#endregion

  //#region documents and reporting

  /** The chain as one query document — refuses when a `mapAsync` sits
   * in the chain, because a host callback has no document form. A deep
   * snapshot, as on the sync surface: the emitted tree embeds the
   * stages' captured expressions, and handing those out by reference
   * made the document a live window into an immutable sequence. */
  toDocument() {
    if (this.#stages.some((s) => s.kind === 'mapAsync')) {
      throw new LinqBuildError('JL0005',
        'toDocument() cannot represent mapAsync (a host callback); explain() reports the split');
    }
    const root = this.#origin.kind === 'sequence'
      ? this.#origin.prefixDocument()
      : '$[*]';
    return snapshot(emitDocument(root, this.#stages));
  }

  /** Barriers, the split, and — when representable — the document.
   * Stages are named by the OPERATOR the caller wrote (`selectMany`,
   * `orderByDescending`), and a `thenBy` is part of the `$orderby`
   * barrier it extends, not a barrier of its own. */
  explain() {
    const barriers = [];
    for (const stage of this.#stages) {
      if (BARRIERS[stage.kind] !== undefined && stage.kind !== 'thenBy') {
        barriers.push({ operator: stage.name ?? stage.kind, reason: BARRIERS[stage.kind] });
      }
    }
    const firstMap = this.#stages.findIndex((s) => s.kind === 'mapAsync');
    const out = { barriers };
    if (firstMap < 0) {
      out.document = this.toDocument();
    }
    else {
      const prefix = this.#stages.slice(0, firstMap);
      out.split = {
        pushed: snapshot(this.#origin.kind === 'sequence'
          ? this.#origin.prefixDocument()
          : emitDocument('$[*]', prefix)),
        residual: this.#stages.slice(firstMap).map((s) => s.name ?? s.kind),
      };
    }
    return out;
  }

  //#endregion

  //#region execution

  /** The item stream: segments of streamable stages around engine-run
   * barrier chunks. @returns {AsyncGenerator<any>} */
  async* [Symbol.asyncIterator]() {
    const { names, values } = this.#externals();
    let stream = this.#origin.kind === 'sequence'
      ? arrayStream(this.#origin.runPrefix(this.#params))
      : this.#origin.iterate();

    const stages = this.#stages;
    let i = 0;
    while (i < stages.length) {
      const stage = stages[i];
      if (BARRIERS[stage.kind] !== undefined) {
        // the maximal run of document stages executes over the buffer
        let j = i;
        while (j < stages.length && stages[j].kind !== 'mapAsync') j++;
        // the same RESULT-WINDOW discipline the synchronous terminals use:
        // the engine maps a result to `undefined | item | items[]`, so one
        // array-valued item is indistinguishable from several scalar ones
        // and a barrier read `[[1,2]]` back as `[1,2]`. Wrapping the phrase
        // makes the result exactly one item — the array of items — so a
        // nested array round-trips through every barrier unchanged.
        const doc = wrapTerminal(emitDocument('$[*]', stages.slice(i, j)), 'toArray');
        const compiled = compileDocument(doc, { ...this.#options, externals: names });
        const buffer = await collect(stream);
        stream = arrayStream(compiled([...buffer], values) ?? []);
        i = j;
        continue;
      }
      if (stage.kind === 'mapAsync') {
        stream = applyMapAsync(stream, stage.fn, stage.options);
        i++;
        continue;
      }
      stream = this.#applyStreamStage(stream, stage, values);
      i++;
    }
    yield* iterateAndClose(stream);
  }

  /** @param {AsyncIterator<any>} stream @param {any} stage @param {any} values */
  #applyStreamStage(stream, stage, values) {
    const self = this;
    switch (stage.kind) {
      case 'where': {
        const q = this.#evaluator(stage.predicate);
        return (async function* () {
          for await (const item of iterateAndClose(stream)) {
            if (q.ebv(item, values)) yield item;
          }
        })();
      }
      case 'select': {
        const q = this.#evaluator([stage.projection]);
        return (async function* () {
          for await (const item of iterateAndClose(stream)) {
            yield* /** @type {any[]} */ (q(item, values));
          }
        })();
      }
      case 'ofType': {
        const q = this.#evaluator({ $valid: ['$it', stage.schema] });
        return (async function* () {
          for await (const item of iterateAndClose(stream)) {
            if (q(item, values) === true) yield item;
          }
        })();
      }
      case 'cast': {
        const q = this.#evaluator([{ $assert: ['$it', stage.schema] }]);
        return (async function* () {
          for await (const item of iterateAndClose(stream)) {
            yield* /** @type {any[]} */ (q(item, values));
          }
        })();
      }
      case 'skip': {
        return (async function* () {
          let remaining = stage.count;
          for await (const item of iterateAndClose(stream)) {
            if (remaining > 0) { remaining--; continue; }
            yield item;
          }
        })();
      }
      case 'take': {
        return (async function* () {
          if (stage.count === 0) {
            if (typeof stream.return === 'function') await stream.return(undefined);
            return;
          }
          let remaining = stage.count;
          for await (const item of iterateAndClose(stream)) {
            yield item;
            if (--remaining === 0) break; // for-await break closes the source
          }
        })();
      }
      case 'distinct': {
        return (async function* () {
          const seen = new Set();
          for await (const item of iterateAndClose(stream)) {
            const key = itemKey(item);
            if (seen.has(key)) continue;
            seen.add(key);
            yield item;
          }
        })();
      }
      case 'concat': {
        // a fresh copy per enumeration: a consumer that writes into a
        // yielded constant must not rewrite what the next enumeration
        // answers (the sync surface hands out the engine's frozen values)
        return (async function* () {
          yield* iterateAndClose(stream);
          for (const item of stage.items) yield snapshot(item);
        })();
      }
      default: { // 'defaultIfEmpty'
        void self;
        return (async function* () {
          let any = false;
          for await (const item of iterateAndClose(stream)) {
            any = true;
            yield item;
          }
          if (!any) yield snapshot(stage.value ?? null);
        })();
      }
    }
  }

  async toArray() {
    return collect(this[Symbol.asyncIterator]());
  }

  /** @param {number} n */
  async #window(n) {
    const out = [];
    for await (const item of this) {
      out.push(item);
      if (out.length === n) break;
    }
    return out;
  }

  async first() {
    const w = await this.#window(1);
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'first() found no element');
    return w[0];
  }

  /** @param {any} [defaultValue] */
  async firstOrDefault(defaultValue) {
    const w = await this.#window(1);
    return w.length === 0 ? defaultValue : w[0];
  }

  async single() {
    const w = await this.#window(2);
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'single() found no element');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'single() found more than one element');
    return w[0];
  }

  /** @param {any} [defaultValue] */
  async singleOrDefault(defaultValue) {
    const w = await this.#window(2);
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'singleOrDefault() found more than one element');
    return w.length === 0 ? defaultValue : w[0];
  }

  async last() {
    const all = await this.toArray();
    if (all.length === 0) throw new LinqRuntimeError('JL2001', 'last() found no element');
    return all[all.length - 1];
  }

  /** @param {any} [defaultValue] */
  async lastOrDefault(defaultValue) {
    const all = await this.toArray();
    return all.length === 0 ? defaultValue : all[all.length - 1];
  }

  /** @param {number} index */
  async elementAt(index) {
    requireIndex(index, 'elementAt');
    const w = await this.skip(index).#window(1);
    if (w.length === 0) throw new LinqRuntimeError('JL2003', `elementAt(${index}) is out of range`);
    return w[0];
  }

  /** @param {number} index @param {any} [defaultValue] */
  async elementAtOrDefault(index, defaultValue) {
    requireIndex(index, 'elementAtOrDefault');
    const w = await this.skip(index).#window(1);
    return w.length === 0 ? defaultValue : w[0];
  }

  async count() {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for await (const item of this) n++;
    return n;
  }

  /** Aggregate terminals run the ENGINE over the collected items, so
   * their semantics (type errors included) match the sync surface
   * exactly. @param {string} terminal */
  async #aggregateTerminal(terminal) {
    const items = await this.toArray();
    const { names, values } = this.#externals();
    const compiled = compileDocument(wrapTerminal('$[*]', terminal),
      { ...this.#options, externals: names });
    return compiled(items, values);
  }

  async sum() { return this.#aggregateTerminal('sum'); }

  async average() {
    const v = await this.#aggregateTerminal('average');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'average() of an empty sequence');
    return v;
  }

  async min() {
    const v = await this.#aggregateTerminal('min');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'min() of an empty sequence');
    return v;
  }

  async max() {
    const v = await this.#aggregateTerminal('max');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'max() of an empty sequence');
    return v;
  }

  /** @param {any} [predicate] */
  async any(predicate) {
    const seq = predicate === undefined ? this : this.where(predicate);
    for await (const item of seq) {
      void item;
      return true; // for-await return closes the source
    }
    return false;
  }

  /** @param {any} predicate */
  async all(predicate) {
    const q = this.#evaluator(captureFor(this.#params, predicate));
    for await (const item of this) {
      if (!q.ebv(item, this.#externals().values)) return false;
    }
    return true;
  }

  //#endregion
}

//#region helpers (module-private)

/** @param {any[]} items */
async function* arrayStream(items) {
  yield* items;
}

/** Wrap a bare iterator so `for await` semantics (close-on-break,
 * close-on-throw) apply uniformly. @param {AsyncIterator<any>} iterator */
function iterateAndClose(iterator) {
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

/** @param {AsyncIterator<any> | AsyncIterable<any>} stream */
async function collect(stream) {
  const out = [];
  const iterable = typeof (/** @type {any} */ (stream))[Symbol.asyncIterator] === 'function'
    ? /** @type {AsyncIterable<any>} */ (stream)
    : iterateAndClose(/** @type {AsyncIterator<any>} */ (stream));
  for await (const item of iterable) out.push(item);
  return out;
}

/** @param {number} value @param {string} what */
function requireIndex(value, what) {
  if (!Number.isInteger(value) || value < 0) {
    throw new LinqBuildError('JL0005', `${what} takes a non-negative integer, got ${value}`);
  }
  return value;
}

/** @param {ReadonlyMap<string, any>} params @param {any} fn @param {readonly any[]} [roots] */
function captureFor(params, fn, roots = ['it']) {
  if (typeof fn !== 'function') {
    throw new LinqBuildError('JL0005', 'this operator takes a callback function');
  }
  return captureExpression(fn, roots, new Set(params.keys()));
}

/** @param {any} bindings */
function validateParams(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new LinqBuildError('JL0004', 'params takes an object of name → value bindings');
  }
  for (const name of Object.keys(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new LinqBuildError('JL0004', `'${name}' is not a valid parameter name`);
    }
    if (name === 'it' || name === 'it2' || name === 'acc' || name === 'g') {
      throw new LinqBuildError('JL0004',
        `'${name}' is reserved (the emitted document's own binding names: it, it2, acc, g)`);
    }
  }
}

/**
 * Build an async sequence over an async source (LINQ-FORMAT.md §10).
 * @param {any} source - async iterable, sync iterable, cursor or push
 *   queue
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   the engine registries, as `from()` takes them
 * @returns {AsyncSequence}
 */
export function fromAsync(source, options = {}) {
  return new AsyncSequence(
    { kind: 'source', iterate: adaptAsyncSource(source) },
    [], new Map(), options);
}

/**
 * The `Sequence.prototype.mapAsync` seam: the sync chain becomes the
 * PREFIX (compiled in memory or pushed WHOLE to its provider), and the
 * async surface continues locally from its rows. `explain()` reports
 * the split (D8's residual honesty, applied to the async boundary).
 * @param {{ runPrefix: (params: ReadonlyMap<string, any>) => any[],
 *   prefixDocument: () => any, params: ReadonlyMap<string, any>,
 *   options: { compileTypeTest?: any } }} carrier
 * @param {any} fn
 * @param {any} options
 * @returns {AsyncSequence}
 */
export function asyncFromSequence(carrier, fn, options) {
  const base = new AsyncSequence(
    { kind: 'sequence', runPrefix: carrier.runPrefix, prefixDocument: carrier.prefixDocument },
    [], carrier.params, carrier.options);
  return base.mapAsync(fn, options);
}

//#endregion
