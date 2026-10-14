//@ts-check
/**
 * @file `fromAsync` — the SAME operator surface over async sources,
 * emitting the SAME query documents (the proof is a byte-identity
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
 *  - a PROVIDER origin (`fromAsync(store.entity('Post'))`) runs nothing
 *    here: everything up to the first `mapAsync` is ONE document the
 *    provider executes — a terminal's wrapper included, exactly as the
 *    synchronous surface pushes it, `execute` answering a promise if it
 *    must. Iteration hands that document to the provider's CURSOR
 *    when it offers one, so a `for await` pulls one row at a time from
 *    an open statement and a `break` releases it; the residual after
 *    the split streams locally, and a `join` exists on this surface
 *    only inside that pushed document.
 *
 * Early termination CLOSES the source: every consumer is a
 * `for await … break` chain, and async generators propagate `return()`
 * inward — a generator left suspended would hold a file handle or a
 * read transaction open.
 */

import {
  compileDocument, isProviderSource, providerRoot, providerRelations, sharesScope,
  SOURCE_OPTION_KEYS,
} from './provider.js';
import {
  emitDocument, wrapTerminal, snapshot, fanProjection, isReservedBinding, RESERVED_BINDINGS_TEXT,
  PROJECTING_STAGES, requireNonNegativeInteger, requireNoArgument, requireNoTrailingArgument, requireDefaultValue,
  readOptions, orderSpec,
  RUN_BINDINGS, mergeBindings,
} from './document.js';
import { adaptAsyncSource } from './sources.js';
import { applyMapAsync, normalizeMapAsyncOptions } from './concurrency.js';
import {
  captureExpression, toExpression, requireJsonBinding, requireListBindings, createHopSink, rowRoot,
  groupRoot,
} from './expression.js';
import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { schemaOf } from './schema-of.js';
import { semanticKey } from '@jarenjs/core/object';

/** Barrier stage kinds and the reason each materialises. A `join` is
 * never a barrier: over a provider it rides INSIDE the one pushed
 * document (the only place this surface joins), and over a single-pass
 * source — a cursor, a queue, a stream — it is refused, because the
 * inner side would have to read the source twice (QUERY-PEN.md §10). */
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
  #relations;

  /**
   * @param {{ kind: 'source', iterate: () => AsyncIterator<any>, rows: any }
   *   | { kind: 'provider', source: any, root: string }
   *   | { kind: 'sequence', runPrefix: (params: ReadonlyMap<string, any>) => any[],
   *       prefixDocument: () => any, lists: readonly string[] }} origin -
   *   a `source` origin keeps the rows it was handed, which a handle reads
   *   to tell a document builder (no rows) from a chain over rows; a
   *   `sequence` origin carries the parameters its prefix's `in()` calls
   *   read whole as lists
   * @param {readonly any[]} stages
   * @param {ReadonlyMap<string, any>} params
   * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
   *   pathFunctions?: any, limits?: any, registry?: object }} options
   * @param {{ table: any, resolve: (name: string) => any } | null} [relations] -
   *   the relation table of the rows the items ARE (a provider's, while
   *   no stage has projected them), or null — as on the sync surface
   */
  constructor(origin, stages, params, options, relations = null) {
    this.#origin = origin;
    this.#stages = stages;
    this.#params = params;
    this.#options = options;
    this.#relations = relations;
  }

  /** @param {any} stage @param {ReadonlyMap<string, any>} [params] */
  #with(stage, params = this.#params) {
    // the items stop being rows at a projection, and at the host boundary
    const projects = PROJECTING_STAGES.has(stage.kind) || stage.kind === 'mapAsync';
    return new AsyncSequence(this.#origin, [...this.#stages, stage], params, this.#options,
      projects ? null : this.#relations);
  }

  /**
   * Capture one callback over this sequence's items — the expression, the
   * relation hops it navigated and the parameters its `in()` calls read
   * whole as lists — exactly as the synchronous surface does, so the two
   * emit one document.
   * @param {any} fn
   * @param {(sink: ReturnType<typeof createHopSink>) => readonly any[]} [rootsOf]
   * @returns {{ expression: any, hops: readonly any[], lists: string[] }}
   */
  #capture(fn, rootsOf = (sink) => [this.#rowRoot('it', sink)]) {
    if (typeof fn !== 'function') {
      throw new LinqBuildError('JL0005', 'this operator takes a callback function');
    }
    const sink = createHopSink();
    /** @type {string[]} */
    const lists = [];
    const expression = captureExpression(fn, rootsOf(sink), new Set(this.#params.keys()), true, null, lists);
    return { expression, hops: sink.hops, lists };
  }

  /** Whether this sequence's items are a `groupBy`'s `{ key, items }`,
   * as on the synchronous surface. */
  #grouped() {
    for (let i = this.#stages.length - 1; i >= 0; i--) {
      const kind = this.#stages[i].kind;
      if (PROJECTING_STAGES.has(kind) || kind === 'mapAsync') return kind === 'groupBy';
    }
    return false;
  }

  /** @param {string} name @param {ReturnType<typeof createHopSink>} sink */
  #rowRoot(name, sink) {
    return rowRoot(name, this.#relations, sink, this.#grouped());
  }

  /** The relation hops every stage's callbacks navigated, in order. */
  #hops() {
    return this.#stages.flatMap((stage) => stage.hops ?? []);
  }

  /** The parameters an `in()` of some stage — or of the synchronous
   * prefix a `mapAsync` split off — reads whole as its list. */
  #lists() {
    const prefix = this.#origin.kind === 'sequence' ? this.#origin.lists : [];
    return [...prefix, ...this.#stages.flatMap((stage) => stage.lists ?? [])];
  }

  /** The declared names and bound values a run hands over, once every
   * parameter read as an `in()` list holds an array (`JL0004` otherwise).
   * @param {readonly string[]} [lists] - a terminal predicate's own */
  #externals(lists = []) {
    requireListBindings([...this.#lists(), ...lists], this.#params);
    return {
      names: [...this.#params.keys()],
      // a copy per run: a provider that writes into what it is handed must
      // not rewrite the sequence's own bindings
      values: snapshot(Object.fromEntries(this.#params)),
    };
  }

  /** Whether the chain so far goes to a provider as ONE document: a
   * provider origin with no `mapAsync` yet (the document arrives
   * whole; a host callback is where it splits). */
  #pushable() {
    return this.#origin.kind === 'provider'
      && !this.#stages.some((stage) => stage.kind === 'mapAsync');
  }

  /** Whether this sequence is a provider's own root, untouched — the
   * one `$for` source the emitter leaves unpacked (document.js). */
  #isBareRoot() {
    return this.#origin.kind === 'provider' && this.#stages.length === 0;
  }

  /** The root expression the stages iterate: a provider's own root, the
   * pushed synchronous prefix, or the whole input. */
  #rootExpression() {
    if (this.#origin.kind === 'sequence') return this.#origin.prefixDocument();
    return this.#origin.kind === 'provider' ? this.#origin.root : '$[*]';
  }

  /** The document for a run of stages over this origin's root. */
  #documentOf(stages) {
    return emitDocument(this.#rootExpression(), stages,
      { bareRoot: this.#origin.kind === 'provider' });
  }

  /** Hand one document to the provider, whole, with the bound
   * externals; `execute` may answer a value or a promise here.
   * @param {any} document @param {readonly string[]} [lists] - a terminal predicate's own */
  async #push(document, lists = []) {
    return this.#origin.source.execute(document, { externals: this.#externals(lists).values });
  }

  /** A pushed element window over `stages`: the provider must answer
   * exactly one array, as on the synchronous surface (`JL2006`). */
  async #pushWindow(terminal, args = undefined, stages = this.#stages) {
    const result = await this.#push(wrapTerminal(this.#documentOf(stages), terminal, args));
    if (!Array.isArray(result)) {
      throw new LinqRuntimeError('JL2006',
        `the provider answered ${terminal}() with ${result === undefined ? 'undefined'
          : `a ${typeof result}`} — an element terminal emits an array constructor, so a `
        + 'conforming execute() answers exactly one array (QUERY-PEN.md §8)');
    }
    return /** @type {any[]} */ (result);
  }

  /** A pushed aggregate or quantifier over the whole chain.
   * @param {string} terminal @param {readonly any[]} [args]
   * @param {readonly string[]} [lists] - the quantifier predicate's own */
  #pushTerminal(terminal, args = undefined, lists = []) {
    return this.#push(wrapTerminal(this.#documentOf(this.#stages), terminal, args), lists);
  }

  /** Compile one per-item evaluator: the stage expression under
   * `{$let: {it: '$'}}` with the terminal-window discipline. */
  #evaluator(returnExpr) {
    const { names } = this.#externals();
    return compileDocument({ $let: { it: '$' }, $return: returnExpr },
      { ...this.#options, externals: names });
  }

  //#region the operator surface (same vocabulary as Sequence)

  /** One predicate; a second argument is `JL0005`. @param {...undefined} unread */
  where(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'where');
    return this.#chainCaptured('where', 'predicate', predicate);
  }

  /** One projection; a second argument is `JL0005`. @param {...undefined} unread */
  select(projection, ...unread) {
    requireNoTrailingArgument(unread, 'select');
    return this.#chainCaptured('select', 'projection', projection);
  }

  /** One selector; C#'s result selector is `JL0005`, as on the sync
   * surface. @param {...undefined} unread */
  selectMany(selector, ...unread) {
    requireNoTrailingArgument(unread, 'selectMany');
    const { expression, hops, lists } = this.#capture(selector);
    return this.#with({
      kind: 'select', name: 'selectMany',
      projection: fanProjection(expression),
      hops,
      lists,
    });
  }

  /** @param {string} kind @param {string} slot @param {any} fn */
  #chainCaptured(kind, slot, fn) {
    // reuse the sync Sequence's capture through a local import-free
    // seam: capture lives in expression.js and is stage-agnostic
    const { expression, hops, lists } = this.#capture(fn);
    return this.#with({ kind, [slot]: expression, hops, lists });
  }

  /** @param {any} key @param {any} [options] @param {...undefined} unread */
  orderBy(key, options, ...unread) { return this.#orderStage('orderBy', key, false, options, unread); }
  /** @param {any} key @param {any} [options] @param {...undefined} unread */
  orderByDescending(key, options, ...unread) { return this.#orderStage('orderBy', key, true, options, unread); }
  /** @param {any} key @param {any} [options] @param {...undefined} unread */
  thenBy(key, options, ...unread) { return this.#orderStage('thenBy', key, false, options, unread); }
  /** @param {any} key @param {any} [options] @param {...undefined} unread */
  thenByDescending(key, options, ...unread) { return this.#orderStage('thenBy', key, true, options, unread); }

  /** @param {readonly any[]} unread - C#'s comparer, which `JL0005` refuses */
  #orderStage(kind, key, desc, options, unread) {
    const name = desc ? `${kind}Descending` : kind;
    requireNoTrailingArgument(unread, name);
    const { expression, hops, lists } = this.#capture(key);
    return this.#with({ kind, name, spec: orderSpec(expression, desc, options, `${name}()`), hops, lists });
  }

  /** One key selector; C#'s element and result selectors are `JL0005`
   * (the group is read by `select((g) => …)` after it).
   * @param {...undefined} unread */
  groupBy(key, ...unread) {
    requireNoTrailingArgument(unread, 'groupBy');
    const { expression, hops, lists } = this.#capture(key);
    return this.#with({ kind: 'groupBy', key: expression, hops, lists });
  }

  /** A seed and a step; C#'s result selector is `JL0005`.
   * @param {...undefined} unread */
  aggregate(seed, step, ...unread) {
    requireNoTrailingArgument(unread, 'aggregate');
    const { expression, hops, lists } = this.#capture(step, (sink) => ['acc', this.#rowRoot('it', sink)]);
    return this.#with({
      kind: 'aggregate',
      seed: toExpression(seed),
      step: expression,
      hops,
      lists,
    });
  }

  /** The inner side of a join, checked (QUERY-PEN.md §10): a join on
   * this surface rides INSIDE the one document a provider receives, so
   * it needs a provider origin with no `mapAsync` before it, an async
   * sequence over the same provider (or one sharing its scope) as the
   * inner side, and — as on the synchronous surface — one binding per
   * parameter name across the two sides. Over a single-pass source there
   * is no join: the inner side would read the source twice.
   * @param {any} inner @param {string} what
   * @returns {ReadonlyMap<string, any>} the merged parameter bindings */
  #requireJoinable(inner, what) {
    if (!this.#pushable()) {
      throw new LinqBuildError('JL0005',
        `${what} on the async surface is pushed whole to a provider — it needs a provider `
        + 'source and comes before any mapAsync; over an iterable, a cursor or a push queue '
        + 'there is no join, because a single-pass source cannot be read twice (QUERY-PEN.md §10)');
    }
    if (!(inner instanceof AsyncSequence) || !inner.#pushable()) {
      throw new LinqBuildError('JL0005',
        `${what} takes another async sequence over a provider (with no mapAsync) as its inner side`);
    }
    if (!sharesScope(this.#origin.source, inner.#origin.source)) {
      throw new LinqBuildError('JL0005',
        `${what}'s other side must derive from the same source, or from two providers sharing `
        + "one scope (one store's entity sets) — a query document reads one input");
    }
    return mergeBindings(this.#params, inner.#params, what);
  }

  /** Equi-join, pushed whole: the nested-`$for` shape the synchronous
   * surface emits (a store answers a two-root join in one statement);
   * the inner rows keep their relation table under `it2`. C#'s comparer
   * overload is `JL0005`. @param {...undefined} unread */
  join(inner, outerKey, innerKey, result, ...unread) {
    requireNoTrailingArgument(unread, 'join');
    const params = this.#requireJoinable(inner, 'join');
    const outer = this.#capture(outerKey);
    const key = this.#capture(innerKey, (sink) => [inner.#rowRoot('it2', sink)]);
    const projection = this.#capture(result,
      (sink) => [this.#rowRoot('it', sink), inner.#rowRoot('it2', sink)]);
    return this.#with({
      kind: 'join',
      inner: inner.toDocument(),
      innerBare: inner.#isBareRoot(),
      on: { $eq: [outer.expression, key.expression] },
      result: projection.expression,
      hops: [...inner.#hops(), ...outer.hops, ...key.hops, ...projection.hops],
      lists: [...inner.#lists(), ...outer.lists, ...key.lists, ...projection.lists],
    }, params);
  }

  /** Group-join, pushed whole: the `$let`-bound group of the synchronous
   * surface, under the same rule as `join`. @param {...undefined} unread */
  groupJoin(inner, outerKey, innerKey, result, ...unread) {
    requireNoTrailingArgument(unread, 'groupJoin');
    const params = this.#requireJoinable(inner, 'groupJoin');
    const innerDoc = inner.toDocument();
    const outer = this.#capture(outerKey);
    const key = this.#capture(innerKey, (sink) => [inner.#rowRoot('it2', sink)]);
    const group = {
      $for: { it2: inner.#isBareRoot() ? innerDoc : [innerDoc] },
      $where: { $eq: [outer.expression, key.expression] },
      $return: '$it2',
    };
    const projection = this.#capture(result,
      (sink) => [this.#rowRoot('it', sink), groupRoot(inner.#relations, sink)]);
    return this.#with({
      kind: 'groupJoin',
      group,
      projection: projection.expression,
      hops: [...inner.#hops(), ...outer.hops, ...key.hops, ...projection.hops],
      lists: [...inner.#lists(), ...outer.lists, ...key.lists, ...projection.lists],
    }, params);
  }

  /** @param {number} count @param {...undefined} unread */
  skip(count, ...unread) {
    requireNoTrailingArgument(unread, 'skip');
    return this.#with({ kind: 'skip', count: requireNonNegativeInteger(count, 'skip') });
  }

  /** @param {number} count @param {...undefined} unread */
  take(count, ...unread) {
    requireNoTrailingArgument(unread, 'take');
    return this.#with({ kind: 'take', count: requireNonNegativeInteger(count, 'take') });
  }

  /** Drop repeated items. Reads no argument, and no key either:
   * `select(sel).distinct()` keeps the first of each repeated projection
   * (the keys, not the rows), and a selector handed here is `JL0005`.
   * @param {...undefined} unread */
  distinct(...unread) {
    requireNoArgument(unread, 'distinct', 'select(sel).distinct()');
    return this.#with({ kind: 'distinct' });
  }

  /** Reverse the order. Reads no argument (`JL0005` otherwise).
   * @param {...undefined} unread */
  reverse(...unread) {
    requireNoArgument(unread, 'reverse', 'where(pred).reverse()');
    return this.#with({ kind: 'reverse' });
  }

  /** Async sources are single-pass, so only a CONSTANT array can join
   * the stream (`JL0005` otherwise; the format doc says why).
   * @param {any} other @param {...undefined} unread */
  concat(other, ...unread) {
    requireNoTrailingArgument(unread, 'concat');
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

  /** @param {any} [fallback] @param {...undefined} unread */
  defaultIfEmpty(fallback = null, ...unread) {
    requireNoTrailingArgument(unread, 'defaultIfEmpty');
    const expr = toExpression(fallback);
    return this.#with({ kind: 'defaultIfEmpty', fallback: expr, value: expr?.$const ?? fallback });
  }

  /** @param {any} schema @param {...undefined} unread */
  ofType(schema, ...unread) {
    requireNoTrailingArgument(unread, 'ofType');
    return this.#with({ kind: 'ofType', schema: schemaOf(schema) });
  }

  /** @param {any} schema @param {...undefined} unread */
  cast(schema, ...unread) {
    requireNoTrailingArgument(unread, 'cast');
    return this.#with({ kind: 'cast', schema: schemaOf(schema) });
  }

  zip() {
    throw new LinqBuildError('JL0006',
      'zip is unsupported: the query grammar has no positional co-iteration (see QUERY-PEN.md §4)');
  }

  /** The bounded-concurrency boundary (QUERY-PEN.md §11).
   * @param {...undefined} unread */
  mapAsync(fn, options, ...unread) {
    requireNoTrailingArgument(unread, 'mapAsync');
    if (typeof fn !== 'function') {
      throw new LinqBuildError('JL0005', 'mapAsync takes an async callback');
    }
    return this.#with({ kind: 'mapAsync', fn, options: normalizeMapAsyncOptions(options) });
  }

  /** @param {...undefined} unread */
  params(bindings, ...unread) {
    requireNoTrailingArgument(unread, 'params');
    validateParams(bindings);
    const merged = new Map(this.#params);
    for (const name of Object.keys(bindings)) {
      merged.set(name, requireJsonBinding(name, bindings[name]));
    }
    return new AsyncSequence(this.#origin, this.#stages, merged, this.#options, this.#relations);
  }

  //#endregion

  //#region documents and reporting

  /** The chain as one query document — refuses when a `mapAsync` sits
   * in the chain, because a host callback has no document form. A deep
   * snapshot, as on the sync surface: the emitted tree embeds the
   * stages' captured expressions, and handing those out by reference
   * made the document a live window into an immutable sequence.
   * @param {...undefined} unread */
  toDocument(...unread) {
    requireNoTrailingArgument(unread, 'toDocument');
    if (this.#stages.some((s) => s.kind === 'mapAsync')) {
      throw new LinqBuildError('JL0005',
        'toDocument() cannot represent mapAsync (a host callback); explain() reports the split');
    }
    return snapshot(this.#documentOf(this.#stages));
  }

  /** Barriers, the split, the relation hops the callbacks navigated,
   * and — when representable — the document; plus `streaming` and
   * `barrier`, what this surface's own execution does. Stages are named
   * by the OPERATOR the caller wrote (`selectMany`, `orderByDescending`),
   * and a `thenBy` is part of the `$orderby` barrier it extends, not a
   * barrier of its own. @param {...undefined} unread */
  explain(...unread) {
    requireNoTrailingArgument(unread, 'explain');
    const firstMap = this.#stages.findIndex((s) => s.kind === 'mapAsync');
    // over a provider nothing before the split materialises HERE — the
    // provider runs the pushed document — so only the residual can hold
    // a barrier of this surface's own
    const local = this.#origin.kind === 'provider'
      ? (firstMap < 0 ? [] : this.#stages.slice(firstMap))
      : this.#stages;
    const barriers = [];
    for (const stage of local) {
      if (BARRIERS[stage.kind] !== undefined && stage.kind !== 'thenBy') {
        barriers.push({ operator: stage.name ?? stage.kind, reason: BARRIERS[stage.kind] });
      }
    }
    // what THIS surface does with the item stream: one item at a time,
    // or a buffer at the first local barrier. Over a provider the pushed
    // document's own class — a set residual, an unbindable external — is
    // the provider's to report: `explain(document, { externals: bindings })`
    // on the source answers it, and its cursor carries the same answer
    const first = barriers[0];
    const out = {
      barriers,
      streaming: first === undefined ? 'row' : 'buffered',
      barrier: first === undefined ? null : { construct: first.operator, reason: first.reason },
      hops: snapshot(this.#hops()),
      bindings: this.#externals().values,
    };
    if (firstMap < 0) {
      out.document = this.toDocument();
    }
    else {
      out.split = {
        pushed: snapshot(this.#documentOf(this.#stages.slice(0, firstMap))),
        residual: this.#stages.slice(firstMap).map((s) => s.name ?? s.kind),
      };
    }
    return out;
  }

  /** What a run binds, unchecked ({@link RUN_BINDINGS}): for a handle's
   * `live()`, `execute()`, `query()` and `explain()`, which check the list
   * rule against the externals they hand the store, and the provider or
   * the rows in memory the chain was built over. */
  [RUN_BINDINGS]() {
    const origin = this.#origin;
    return {
      bindings: snapshot(Object.fromEntries(this.#params)),
      lists: this.#lists(),
      source: origin.kind === 'provider' ? origin.source : null,
      rows: origin.kind === 'source' ? origin.rows : null,
    };
  }

  //#endregion

  //#region execution

  /** The item stream: segments of streamable stages around engine-run
   * barrier chunks. @returns {AsyncGenerator<any>} */
  async* [Symbol.asyncIterator]() {
    const { names, values } = this.#externals();
    const stages = this.#stages;
    let stream;
    let i = 0;
    if (this.#origin.kind === 'sequence') {
      stream = arrayStream(this.#origin.runPrefix(this.#params));
    }
    else if (this.#origin.kind === 'provider') {
      // everything up to the first mapAsync is ONE document the provider
      // runs whole; the residual continues locally over its rows
      const firstMap = stages.findIndex((s) => s.kind === 'mapAsync');
      i = firstMap < 0 ? stages.length : firstMap;
      stream = this.#providerStream(stages.slice(0, i), values);
    }
    else {
      stream = this.#origin.iterate();
    }
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

  /**
   * The pushed window as a STREAM. A provider that offers the cursor
   * protocol (`cursor(document, options)` — as the store's entity sets
   * do) is handed the unwrapped document and answers one
   * item per pull from an open statement; the generator's `for await`
   * releases that statement on break, throw and exhaustion alike,
   * exactly once. A provider without one keeps the element window it
   * always had: the `toArray`-wrapped document run whole, its array
   * iterated — a materialisation, which is what such a provider can do.
   * @param {readonly any[]} stages - the stages up to the split
   * @param {Record<string, any>} values - the bound externals
   * @returns {AsyncIterator<any>}
   */
  #providerStream(stages, values) {
    const source = this.#origin.source;
    if (typeof source.cursor === 'function') {
      return source.cursor(this.#documentOf(stages), { externals: values });
    }
    return this.#materializedWindow(stages);
  }

  /** The legacy element window, iterated: one `toArray` push, run whole.
   * @param {readonly any[]} stages */
  async* #materializedWindow(stages) {
    yield* await this.#pushWindow('toArray', undefined, stages);
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

  /** The whole result as one array. Over a provider with no `mapAsync`
   * this is ONE pushed window — the terminal asked for the array, so the
   * store answers it in one statement rather than one row at a time;
   * everywhere else it drains the item stream. Reads no argument:
   * `select(sel).toArray()` maps them (`JL0005` otherwise).
   * @param {...undefined} unread */
  async toArray(...unread) {
    requireNoArgument(unread, 'toArray', 'select(sel).toArray()');
    if (this.#pushable()) return this.#pushWindow('toArray');
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

  /** The first item. Reads no argument: `where(pred).first()` is the
   * first match (`JL0005` otherwise).
   * @param {...undefined} unread */
  async first(...unread) {
    requireNoArgument(unread, 'first', 'where(pred).first()');
    const w = this.#pushable() ? await this.#pushWindow('first') : await this.#window(1);
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'first() found no element');
    return w[0];
  }

  /** The first item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).firstOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  async firstOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'firstOrDefault');
    const w = this.#pushable() ? await this.#pushWindow('first') : await this.#window(1);
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The only item. Reads no argument: `where(pred).single()` is the one
   * match (`JL0005` otherwise).
   * @param {...undefined} unread */
  async single(...unread) {
    requireNoArgument(unread, 'single', 'where(pred).single()');
    const w = this.#pushable() ? await this.#pushWindow('single') : await this.#window(2);
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'single() found no element');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'single() found more than one element');
    return w[0];
  }

  /** The only item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).singleOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  async singleOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'singleOrDefault');
    const w = this.#pushable() ? await this.#pushWindow('single') : await this.#window(2);
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'singleOrDefault() found more than one element');
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The last item. Reads no argument: `where(pred).last()` is the last
   * match (`JL0005` otherwise).
   * @param {...undefined} unread */
  async last(...unread) {
    requireNoArgument(unread, 'last', 'where(pred).last()');
    const w = this.#pushable() ? await this.#pushWindow('last') : await this.#lastWindow();
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'last() found no element');
    return w[0];
  }

  /** The last item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).lastOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  async lastOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'lastOrDefault');
    const w = this.#pushable() ? await this.#pushWindow('last') : await this.#lastWindow();
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The last item as a window, read from the whole stream. */
  async #lastWindow() {
    const all = await this.toArray();
    return all.length === 0 ? [] : [all[all.length - 1]];
  }

  /** @param {number} index @param {...undefined} unread */
  async elementAt(index, ...unread) {
    requireNoTrailingArgument(unread, 'elementAt');
    requireNonNegativeInteger(index, 'elementAt');
    const w = this.#pushable()
      ? await this.#pushWindow('elementAt', [index]) : await this.skip(index).#window(1);
    if (w.length === 0) throw new LinqRuntimeError('JL2003', `elementAt(${index}) is out of range`);
    return w[0];
  }

  /** The item at `index`, or the value when out of range; reads no
   * predicate, so a callback there is `JL0005`.
   * @param {number} index @param {any} [defaultValue] @param {...undefined} unread */
  async elementAtOrDefault(index, defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'elementAtOrDefault',
      'where(pred).elementAtOrDefault(index, value)');
    requireNonNegativeInteger(index, 'elementAtOrDefault');
    const w = this.#pushable()
      ? await this.#pushWindow('elementAt', [index]) : await this.skip(index).#window(1);
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The number of items. Reads no argument: `where(pred).count()` counts
   * the ones a predicate keeps (`JL0005` otherwise).
   * @param {...undefined} unread */
  async count(...unread) {
    requireNoArgument(unread, 'count', 'where(pred).count()');
    if (this.#pushable()) return this.#pushTerminal('count');
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for await (const item of this) n++;
    return n;
  }

  /** Aggregate terminals run the ENGINE over the collected items, so
   * their semantics (type errors included) match the sync surface
   * exactly. @param {string} terminal */
  async #aggregateTerminal(terminal) {
    if (this.#pushable()) return this.#pushTerminal(terminal);
    const items = await this.toArray();
    const { names, values } = this.#externals();
    const compiled = compileDocument(wrapTerminal('$[*]', terminal),
      { ...this.#options, externals: names });
    return compiled(items, values);
  }

  /** Reads no argument: `select(sel).sum()` folds a projection (`JL0005` otherwise).
   * @param {...undefined} unread */
  async sum(...unread) {
    requireNoArgument(unread, 'sum', 'select(sel).sum()');
    return this.#aggregateTerminal('sum');
  }

  /** Reads no argument: `select(sel).average()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  async average(...unread) {
    requireNoArgument(unread, 'average', 'select(sel).average()');
    const v = await this.#aggregateTerminal('average');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'average() of an empty sequence');
    return v;
  }

  /** Reads no argument: `select(sel).min()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  async min(...unread) {
    requireNoArgument(unread, 'min', 'select(sel).min()');
    const v = await this.#aggregateTerminal('min');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'min() of an empty sequence');
    return v;
  }

  /** Reads no argument: `select(sel).max()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  async max(...unread) {
    requireNoArgument(unread, 'max', 'select(sel).max()');
    const v = await this.#aggregateTerminal('max');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'max() of an empty sequence');
    return v;
  }

  /** @param {any} [predicate] @param {...undefined} unread */
  async any(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'any');
    if (this.#pushable()) {
      if (predicate === undefined) return this.#pushTerminal('exists');
      const { expression, lists } = this.#capture(predicate);
      return this.#pushTerminal('some', [expression], lists);
    }
    const seq = predicate === undefined ? this : this.where(predicate);
    for await (const item of seq) {
      void item;
      return true; // for-await return closes the source
    }
    return false;
  }

  /** @param {any} predicate @param {...undefined} unread */
  async all(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'all');
    const { expression, lists } = this.#capture(predicate);
    if (this.#pushable()) return this.#pushTerminal('every', [expression], lists);
    const values = this.#externals(lists).values;
    const q = this.#evaluator(expression);
    for await (const item of this) {
      if (!q.ebv(item, values)) return false;
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

/** @param {any} bindings */
function validateParams(bindings) {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new LinqBuildError('JL0004', 'params takes an object of name → value bindings');
  }
  for (const name of Object.keys(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new LinqBuildError('JL0004', `'${name}' is not a valid parameter name`);
    }
    if (isReservedBinding(name)) {
      throw new LinqBuildError('JL0004',
        `'${name}' is reserved (the emitted document's own binding names: ${RESERVED_BINDINGS_TEXT})`);
    }
  }
}

/**
 * Build an async sequence over an async source (QUERY-PEN.md §10), or
 * over a provider (§12): an `execute` duck is asked for BEFORE the
 * iterable shapes, and its items are bound through its own root — as
 * `from()` binds them, so the two surfaces emit one document.
 * @param {any} source - async iterable, sync iterable, cursor, push
 *   queue, or a provider
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   the engine registries, as `from()` takes them — the same closed set
 * @param {...undefined} unread - reads nothing: an argument after `options` is `JL0005`
 * @returns {AsyncSequence}
 */
export function fromAsync(source, options, ...unread) {
  requireNoTrailingArgument(unread, 'fromAsync');
  if (isProviderSource(source)) {
    return new AsyncSequence(
      { kind: 'provider', source, root: providerRoot(source) },
      [], new Map(), readOptions(options, SOURCE_OPTION_KEYS, 'fromAsync()'), providerRelations(source));
  }
  const iterate = adaptAsyncSource(source);
  return new AsyncSequence({ kind: 'source', iterate, rows: source }, [], new Map(),
    readOptions(options, SOURCE_OPTION_KEYS, 'fromAsync()'));
}

/**
 * The `Sequence.prototype.mapAsync` seam: the sync chain becomes the
 * PREFIX (compiled in memory or pushed WHOLE to its provider), and the
 * async surface continues locally from its rows. `explain()` reports
 * the split (the residual honesty, applied to the async boundary), and
 * holds the prefix's `in()` lists to the bindings as its runs do.
 * @param {{ runPrefix: (params: ReadonlyMap<string, any>) => any[],
 *   prefixDocument: () => any, params: ReadonlyMap<string, any>,
 *   options: { compileTypeTest?: any }, lists: readonly string[] }} carrier
 * @param {any} fn
 * @param {any} options
 * @returns {AsyncSequence}
 */
export function asyncFromSequence(carrier, fn, options) {
  const { runPrefix, prefixDocument, lists } = carrier;
  const base = new AsyncSequence({ kind: 'sequence', runPrefix, prefixDocument, lists },
    [], carrier.params, carrier.options);
  return base.mapAsync(fn, options);
}

//#endregion
