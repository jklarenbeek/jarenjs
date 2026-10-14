//@ts-check
/**
 * @file The deferred, immutable `Sequence`. Every operator returns a
 * NEW sequence; nothing runs until a terminal operation; a sequence may
 * be enumerated repeatedly and each enumeration re-reads its source —
 * the C# contract, including the part that surprises people
 * (QUERY-PEN.md §5 has the worked example).
 *
 * The chain is data: `toDocument()` emits one Jaren query document, and
 * a terminal either compiles it in memory (the reference semantics) or
 * hands it WHOLE to a provider (`execute(document, options)`) —
 * which is what makes a query loggable, storable, diffable and
 * authorable by a constrained decoder.
 */

import { compileJsonQuery } from '@jarenjs/json/query';

import {
  captureExpression, toExpression, requireJsonBinding, requireListBindings, createHopSink, rowRoot,
  groupRoot,
} from './expression.js';
import {
  emitDocument, wrapTerminal, snapshot, fanProjection, isReservedBinding, RESERVED_BINDINGS_TEXT,
  PROJECTING_STAGES, requireNonNegativeInteger, requireNoArgument, requireNoTrailingArgument, requireDefaultValue,
  readOptions, orderSpec,
  RUN_BINDINGS, mergeBindings,
} from './document.js';
import {
  classifySource, compileDocument, executeInMemory, providerRoot, providerRelations, sharesScope,
  SOURCE_OPTION_KEYS,
} from './provider.js';
import { asyncFromSequence } from './async.js';
import { LinqBuildError, LinqRuntimeError } from './errors.js';
import { schemaOf } from './schema-of.js';

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The immutable query sequence. Construct via `from`/`fromDocument`. */
export class Sequence {
  #source;
  #sourceKind;
  #root;
  #stages;
  #params;
  #options;
  #relations;

  /**
   * @param {any} source
   * @param {'provider' | 'iterable'} sourceKind
   * @param {any} root - the root expression items come from
   * @param {readonly any[]} stages
   * @param {ReadonlyMap<string, any>} params
   * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
   *   pathFunctions?: any, limits?: any, registry?: object }} options
   * @param {{ table: any, resolve: (name: string) => any } | null} [relations] -
   *   the relation table of the rows the items ARE (a provider's, while
   *   no stage has projected them), or null
   */
  constructor(source, sourceKind, root, stages, params, options, relations = null) {
    this.#source = source;
    this.#sourceKind = sourceKind;
    this.#root = root;
    this.#stages = stages;
    this.#params = params;
    this.#options = options;
    this.#relations = relations;
  }

  /** @param {any} stage @param {ReadonlyMap<string, any>} [params] */
  #with(stage, params = this.#params) {
    return new Sequence(this.#source, this.#sourceKind, this.#root,
      [...this.#stages, stage], params, this.#options,
      PROJECTING_STAGES.has(stage.kind) ? null : this.#relations);
  }

  /** @param {ReadonlyMap<string, any>} params */
  #rebound(params) {
    return new Sequence(this.#source, this.#sourceKind, this.#root,
      this.#stages, params, this.#options, this.#relations);
  }

  /** Whether this sequence's items are a `groupBy`'s `{ key, items }`
   * — the last stage that reseated them was the grouping. Read from the
   * stages rather than carried, so it cannot fall out of step with what
   * the emitter writes. */
  #grouped() {
    for (let i = this.#stages.length - 1; i >= 0; i--) {
      if (PROJECTING_STAGES.has(this.#stages[i].kind)) {
        return this.#stages[i].kind === 'groupBy';
      }
    }
    return false;
  }

  /** The `it` (or `it2`) root of a capture over this sequence's items:
   * an entity's rows carry their relation table, so a relation name
   * hops; a group's rows carry their member, so `g.items` aggregates as
   * rows.
   * @param {string} name @param {ReturnType<typeof createHopSink>} sink */
  #rowRoot(name, sink) {
    return rowRoot(name, this.#relations, sink, this.#grouped());
  }

  /** The group root of a group-join over this sequence's items as the
   * inner side. @param {ReturnType<typeof createHopSink>} sink */
  #groupRoot(sink) {
    return groupRoot(this.#relations, sink);
  }

  /** The relation hops every stage's callbacks navigated, in order. */
  #hops() {
    return this.#stages.flatMap((stage) => stage.hops ?? []);
  }

  /** The parameters an `in()` of some stage reads whole as its list. */
  #lists() {
    return this.#stages.flatMap((stage) => stage.lists ?? []);
  }

  /** The bound externals a run hands over, once every parameter read as
   * an `in()` list holds an array (`JL0004` otherwise).
   * @param {readonly string[]} [lists] - a terminal predicate's own */
  #externals(lists = []) {
    requireListBindings([...this.#lists(), ...lists], this.#params);
    // a copy per run: a provider handed the sequence's own values could write
    // into them, and the next run (or explain) would read what it wrote
    return snapshot(Object.fromEntries(this.#params));
  }

  /** Whether this sequence is a provider's own root, untouched — the
   * one `$for` source the emitter leaves unpacked (document.js). */
  #isBareRoot() {
    return this.#sourceKind === 'provider' && this.#stages.length === 0;
  }

  #declared() {
    return new Set(this.#params.keys());
  }

  /**
   * Capture one callback over this sequence's items: the expression, the
   * relation hops it navigated (one sink per capture, so two roots of one
   * callback number their hop bindings together), and the parameters its
   * `in()` calls read whole as lists.
   * @param {(...roots: any[]) => any} fn
   * @param {(sink: ReturnType<typeof createHopSink>) => readonly any[]} [rootsOf] -
   *   the roots, given the capture's sink; the item root by default
   * @returns {{ expression: any, hops: readonly any[], lists: string[] }}
   */
  #capture(fn, rootsOf = (sink) => [this.#rowRoot('it', sink)]) {
    if (typeof fn !== 'function') {
      throw new LinqBuildError('JL0005', 'this operator takes a callback function');
    }
    const sink = createHopSink();
    /** @type {string[]} */
    const lists = [];
    const expression = captureExpression(fn, rootsOf(sink), this.#declared(), true, null, lists);
    return { expression, hops: sink.hops, lists };
  }

  //#region operators (each returns a new immutable Sequence)

  /** Filter: `.where(it => it.age.gt(21))` → FLWOR `$where`. Reads one
   * predicate; a second argument is `JL0005` (chain a second `where`).
   * @param {...undefined} unread */
  where(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'where');
    const { expression, hops, lists } = this.#capture(predicate);
    return this.#with({ kind: 'where', predicate: expression, hops, lists });
  }

  /** Project: `.select(it => ({ id: it.id }))` → `$return`. Reads one
   * projection (`JL0005` for another).
   * @param {...undefined} unread */
  select(projection, ...unread) {
    requireNoTrailingArgument(unread, 'select');
    const { expression, hops, lists } = this.#capture(projection);
    return this.#with({ kind: 'select', projection: expression, hops, lists });
  }

  /** Project-and-flatten: the projected value is iterated one level
   * (an array member's elements, a constructed array's members), so
   * `Seq<R[]>` really answers `Seq<R>`; the FLWOR `$return` then
   * concatenates per tuple. Reads one selector: C#'s result selector
   * `(item, element) => …` is `JL0005`, because the nested phrase
   * rebinds `it` and the outer item is not in reach of a second callback.
   * @param {...undefined} unread */
  selectMany(selector, ...unread) {
    requireNoTrailingArgument(unread, 'selectMany');
    const { expression, hops, lists } = this.#capture(selector);
    return this.#with({ kind: 'select', projection: fanProjection(expression), hops, lists });
  }

  /** @param {any} key @param {boolean} desc @param {any} options
   * @param {readonly any[]} unread - C#'s comparer, which `JL0005` refuses */
  #orderStage(kind, key, desc, options, unread) {
    const name = desc ? `${kind}Descending` : kind;
    requireNoTrailingArgument(unread, name);
    const { expression, hops, lists } = this.#capture(key);
    const spec = orderSpec(expression, desc, options, `${name}()`);
    return this.#with({ kind, spec, hops, lists });
  }

  /** Sort ascending → an `$orderby` key spec (`$dir`/`$empty`/
   * `$collation` exposed through `options`).
   * @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options]
   * @param {...undefined} unread */
  orderBy(key, options, ...unread) {
    return this.#orderStage('orderBy', key, false, options, unread);
  }

  /** @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options]
   * @param {...undefined} unread */
  orderByDescending(key, options, ...unread) {
    return this.#orderStage('orderBy', key, true, options, unread);
  }

  /** Secondary sort key; must directly follow `orderBy*` (JL0005).
   * @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options]
   * @param {...undefined} unread */
  thenBy(key, options, ...unread) {
    return this.#orderStage('thenBy', key, false, options, unread);
  }

  /** @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options]
   * @param {...undefined} unread */
  thenByDescending(key, options, ...unread) {
    return this.#orderStage('thenBy', key, true, options, unread);
  }

  /** Group → `$groupby`; downstream items are `{ key, items }` — whole
   * rows. Reads one key selector: C#'s element and result selectors are
   * `JL0005` (the second argument is one or the other, which a function
   * cannot say), and `select((g) => …)` after the grouping reads the
   * group.
   * @param {...undefined} unread */
  groupBy(key, ...unread) {
    requireNoTrailingArgument(unread, 'groupBy');
    const { expression, hops, lists } = this.#capture(key);
    return this.#with({ kind: 'groupBy', key: expression, hops, lists });
  }

  /** Both sides read ONE input document — a query document has one
   * root — so the other side derives from the same source, or (for a
   * join) from a provider sharing this one's scope: two entity sets of
   * one store are two roots of ONE multi-entity input, and the store
   * answers their equijoin in one statement (QUERY-PEN.md §8). A
   * `concat` stays same-source: its other side contributes an
   * expression over THIS input, never a second one. Returns the merged
   * parameter bindings: the inner side's declared externals ride along,
   * because its document is embedded whole and would otherwise run
   * against the outer's bindings only — a name both sides bind
   * differently is `JL0004`, never silently the outer's.
   * @param {Sequence} inner @param {string} what
   * @param {boolean} [scoped] - whether a shared provider scope suffices
   * @returns {ReadonlyMap<string, any>} */
  #requireSameSource(inner, what, scoped = false) {
    if (!(inner instanceof Sequence)) {
      throw new LinqBuildError('JL0005', `${what} takes another sequence as its inner side`);
    }
    if (inner.#source !== this.#source && !(scoped && sharesScope(this.#source, inner.#source))) {
      throw new LinqBuildError('JL0005',
        `${what}'s other side must derive from the same source`
        + (scoped ? ", or from two providers sharing one scope (one store's entity sets)" : '')
        + ' — a query document reads one input; load both collections under one root'
        + (scoped ? ', or join two entity sets of one store' : ''));
    }
    return mergeBindings(this.#params, inner.#params, what);
  }

  /** Equi-join → nested `$for` + `$where` equality (the engine rewrites
   * this shape to a hash join; that is why it is fast). The inner side's
   * rows keep their relation table under `it2`, so a hop from the joined
   * row lowers as one from the root does. C#'s comparer overload is
   * `JL0005`: keys compare as the engine does.
   * @param {...undefined} unread */
  join(inner, outerKey, innerKey, result, ...unread) {
    requireNoTrailingArgument(unread, 'join');
    const params = this.#requireSameSource(inner, 'join', true);
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

  /** Group-join: the result selector receives the outer item and the
   * MATCHING inner group, bound as an array value (`$let`) so it can be
   * indexed (`g.at(0)`), fanned (`g.all()`), placed in a member
   * (`{ matches: g }`) and aggregated over its members
   * (`(u, g) => ({ n: g.count() })`); the fanned rows keep the inner
   * side's relation table (`g.all().author`). C#'s comparer overload is
   * `JL0005`, as on `join`.
   * @param {...undefined} unread */
  groupJoin(inner, outerKey, innerKey, result, ...unread) {
    requireNoTrailingArgument(unread, 'groupJoin');
    const params = this.#requireSameSource(inner, 'groupJoin', true);
    const innerDoc = inner.toDocument();
    const outer = this.#capture(outerKey);
    const key = this.#capture(innerKey, (sink) => [inner.#rowRoot('it2', sink)]);
    const group = {
      $for: { it2: inner.#isBareRoot() ? innerDoc : [innerDoc] },
      $where: { $eq: [outer.expression, key.expression] },
      $return: '$it2',
    };
    const projection = this.#capture(result,
      (sink) => [this.#rowRoot('it', sink), inner.#groupRoot(sink)]);
    return this.#with({
      kind: 'groupJoin',
      group,
      projection: projection.expression,
      hops: [...inner.#hops(), ...outer.hops, ...key.hops, ...projection.hops],
      lists: [...inner.#lists(), ...outer.lists, ...key.lists, ...projection.lists],
    }, params);
  }

  /** Seeded fold → `$fold` (the accumulator clause). Only the seeded
   * form exists: JSON has no way to spell an unseeded lambda's implicit
   * first element without one. C#'s result selector is `JL0005`:
   * `aggregate(seed, step).select(resultSel)` projects the folded value.
   * @param {...undefined} unread */
  aggregate(seed, step, ...unread) {
    if (typeof seed === 'function' && step === undefined) {
      throw new LinqBuildError('JL0006',
        'aggregate(fn) is unsupported: JSON cannot spell the implicit first element as a '
        + 'lambda seed — pass a seed, aggregate(seed, fn) (see QUERY-PEN.md §4)');
    }
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

  /** Drop the first `count` items. @param {number} count @param {...undefined} unread */
  skip(count, ...unread) {
    requireNoTrailingArgument(unread, 'skip');
    return this.#with({ kind: 'skip', count: requireNonNegativeInteger(count, 'skip') });
  }

  /** Keep the first `count` items. @param {number} count @param {...undefined} unread */
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

  /** Concatenate another sequence over the SAME source, or a constant
   * array (embedded verbatim; its elements join the stream).
   *
   * The same-source check is not a formality. A query document reads ONE
   * input, so the other sequence contributes its expression, not its
   * data — and a sequence built over a different source would have its
   * expression evaluated against THIS source, quietly reading the wrong
   * rows twice instead of concatenating two inputs.
   * @param {...undefined} unread */
  concat(other, ...unread) {
    requireNoTrailingArgument(unread, 'concat');
    let expr;
    let params = this.#params;
    /** @type {string[]} */
    let lists = [];
    if (other instanceof Sequence) {
      params = this.#requireSameSource(other, 'concat');
      expr = other.toDocument();
      lists = other.#lists();
    }
    else if (Array.isArray(other)) {
      // the same JSON boundary a captured constant crosses (§5): a Date
      // or a Map in the array would embed as {} and NaN would fold to null
      expr = { $for: { it: { $const: toExpression(other).$const } }, $return: '$it' };
    }
    else {
      throw new LinqBuildError('JL0005', 'concat takes a sequence or a constant array');
    }
    return this.#with({ kind: 'concat', other: expr, lists }, params);
  }

  /** `$default`: the sequence, or the fallback when it is empty.
   * @param {any} [fallback] @param {...undefined} unread */
  defaultIfEmpty(fallback = null, ...unread) {
    requireNoTrailingArgument(unread, 'defaultIfEmpty');
    return this.#with({ kind: 'defaultIfEmpty', fallback: toExpression(fallback) });
  }

  /** Keep only items matching the JSON Schema (`$valid` filter) — a
   * document, or a schema-pen builder, whose document is taken.
   * @param {any} schema @param {...undefined} unread */
  ofType(schema, ...unread) {
    requireNoTrailingArgument(unread, 'ofType');
    return this.#with({ kind: 'ofType', schema: schemaOf(schema) });
  }

  /** Assert every item against the JSON Schema (`$assert`).
   * @param {any} schema @param {...undefined} unread */
  cast(schema, ...unread) {
    requireNoTrailingArgument(unread, 'cast');
    return this.#with({ kind: 'cast', schema: schemaOf(schema) });
  }

  /** Cross into the async surface: everything BEFORE this call is the
   * prefix — compiled in memory, or pushed WHOLE to the provider — and
   * `mapAsync` plus everything after runs locally over its rows.
   * `explain()` on the result reports the split (QUERY-PEN.md §11).
   * @param {(item: any, signal: AbortSignal) => any} fn
   * @param {{ concurrency: number, mode?: string, ordered?: boolean }} options
   * @param {...undefined} unread */
  mapAsync(fn, options, ...unread) {
    requireNoTrailingArgument(unread, 'mapAsync');
    return asyncFromSequence({
      // the prefix runs under the bindings the ASYNC sequence holds at
      // enumeration time — a `params()` after the split rebinds the
      // whole document, exactly as it would on the sync surface
      runPrefix: (params) => this.#rebound(params).toArray(),
      prefixDocument: () => this.toDocument(),
      params: this.#params,
      options: this.#options,
      // so the async side's explain() checks the prefix's lists too
      lists: this.#lists(),
    }, fn, options);
  }

  /** Recorded `unsupported` (QUERY-PEN.md §4): the grammar has no
   * positional co-iteration. */
  zip() {
    throw new LinqBuildError('JL0006',
      'zip is unsupported: the query grammar has no positional co-iteration (see QUERY-PEN.md §4)');
  }

  /** Declare (and bind) external parameters: `.params({ tenantId })`.
   * Callbacks read them through their last argument (`(it, p) =>
   * it.tenant.eq(p.tenantId)`); the emitted document carries them as
   * externals — the seam that becomes bound SQL parameters.
   * @param {...undefined} unread */
  params(bindings, ...unread) {
    requireNoTrailingArgument(unread, 'params');
    if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
      throw new LinqBuildError('JL0004', 'params takes an object of name → value bindings');
    }
    const merged = new Map(this.#params);
    for (const name of Object.keys(bindings)) {
      if (!VAR_NAME_RE.test(name)) {
        throw new LinqBuildError('JL0004', `'${name}' is not a valid parameter name`);
      }
      if (isReservedBinding(name)) {
        throw new LinqBuildError('JL0004',
          `'${name}' is reserved (the emitted document's own binding names: ${RESERVED_BINDINGS_TEXT})`);
      }
      merged.set(name, requireJsonBinding(name, bindings[name]));
    }
    return this.#rebound(merged);
  }

  //#endregion

  //#region documents and execution

  /** The chain as ONE query document — public API, not a debug toy:
   * loggable, cacheable, storable, diffable, transportable, and
   * compilable by a bare `compileJsonQuery` with no linq involvement.
   *
   * A DEEP, independent snapshot. The emitted tree embeds the captured
   * expressions a stage holds, so handing them out by reference made this
   * a live window into a sequence documented as immutable: writing into
   * the returned document rewrote the predicate, and the next
   * enumeration answered differently. A snapshot cannot do that.
   * @param {...undefined} unread */
  toDocument(...unread) {
    requireNoTrailingArgument(unread, 'toDocument');
    return snapshot(emitDocument(this.#root, this.#stages,
      { bareRoot: this.#sourceKind === 'provider' }));
  }

  /** The compiled view of the chain: the document, its externals, its
   * dependency sets and the relation hops its callbacks navigated (the
   * member, the relation's kind and the binding the lowered phrase
   * ranges over — QUERY-PEN §4, relation navigation).
   *
   * This always explains the IN-MEMORY compilation — it is the reference
   * semantics, and it is not the provider's plan. It cannot report SQL
   * pushdown, index use, residual execution or a strict refusal, and it
   * will fail on an operator or collation only the provider can compile.
   * For a provider's real plan, emit `toDocument()` and call that
   * provider's own explanation — a lowered hop is a residual there.
   * @param {...undefined} unread */
  explain(...unread) {
    requireNoTrailingArgument(unread, 'explain');
    const document = this.toDocument();
    const compiled = compileDocument(document, {
      ...this.#options,
      externals: [...this.#params.keys()],
    });
    return {
      document,
      externals: [...compiled.externals],
      dependencies: compiled.dependencies,
      hops: snapshot(this.#hops()),
      bindings: this.#externals(),
    };
  }

  /** What a run binds, unchecked ({@link RUN_BINDINGS}): for `live()`,
   * which checks the list rule against the externals it registers, and
   * the source the chain was built over. */
  [RUN_BINDINGS]() {
    return {
      bindings: snapshot(Object.fromEntries(this.#params)),
      lists: this.#lists(),
      source: this.#sourceKind === 'provider' ? this.#source : null,
    };
  }

  /** @param {string} terminal @param {readonly any[]} [args]
   * @param {readonly string[]} [lists] - the terminal predicate's own */
  #execute(terminal, args, lists = []) {
    const document = wrapTerminal(this.toDocument(), terminal, args);
    const externalNames = [...this.#params.keys()];
    const externals = this.#externals(lists);
    if (this.#sourceKind === 'provider') {
      const result = this.#source.execute(document, { externals });
      // A `Sequence` terminal is a VALUE — `toArray(): T[]`,
      // `count(): number`. A provider whose `execute` answers a promise
      // (the wasm/OPFS drivers do) cannot satisfy that, and the old seam
      // let the promise through under the value's type: `count()` handed
      // back a `Promise` typed `number`, and `first()` indexed the promise
      // and returned `undefined` — a wrong answer with no error anywhere.
      // Refuse at the seam instead, and name the surface that does work.
      if (result !== null && typeof result === 'object'
        && typeof (/** @type {any} */ (result).then) === 'function') {
        throw new LinqRuntimeError('JL2004',
          `this provider's execute() answered a promise, and a Sequence terminal is a `
          + 'value — an asynchronous provider cannot back the synchronous surface. '
          + 'Emit the document with toDocument() and await the provider directly, or '
          + 'use a synchronous provider.');
      }
      return result;
    }
    return executeInMemory(this.#source, document, {
      ...this.#options,
      externalNames, externals,
    });
  }

  /** @param {string} terminal @param {readonly any[]} [args] */
  #window(terminal, args) {
    // element terminals emit `[window]`, so the result is always one
    // array item and element extraction is unambiguous — for a provider
    // that keeps the contract; one that answers anything else is named,
    // rather than indexed into a TypeError or an `undefined` typed `T[]`
    const result = this.#execute(terminal, args);
    if (!Array.isArray(result)) {
      throw new LinqRuntimeError('JL2006',
        `the provider answered ${terminal}() with ${result === undefined ? 'undefined'
          : `a ${typeof result}`} — an element terminal emits an array constructor, so a `
        + 'conforming execute() answers exactly one array (QUERY-PEN.md §8)');
    }
    return /** @type {any[]} */ (result);
  }

  /** Every item. Reads no argument: `select(sel).toArray()` maps them
   * (`JL0005` otherwise).
   * @param {...undefined} unread */
  toArray(...unread) {
    requireNoArgument(unread, 'toArray', 'select(sel).toArray()');
    return this.#window('toArray');
  }

  * [Symbol.iterator]() {
    if (this.#sourceKind === 'provider' && typeof this.#source.syncQuery === 'function') {
      const document = this.toDocument();
      const cursor = this.#source.syncQuery(document === this.#root
        ? { $for: { it: this.#root }, $return: '$it' } : document,
      { externals: this.#externals() });
      if (cursor == null || typeof cursor[Symbol.iterator] !== 'function')
        throw new LinqRuntimeError('JL2004', 'syncQuery() must return a synchronous iterable cursor');
      yield* cursor;
      return;
    }
    yield* this.toArray();
  }

  /** The first item. Reads no argument: `where(pred).first()` is the
   * first match (`JL0005` otherwise).
   * @param {...undefined} unread */
  first(...unread) {
    requireNoArgument(unread, 'first', 'where(pred).first()');
    const w = this.#window('first');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'first() found no element');
    return w[0];
  }

  /** The first item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).firstOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  firstOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'firstOrDefault');
    const w = this.#window('first');
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The only item. Reads no argument: `where(pred).single()` is the one
   * match (`JL0005` otherwise).
   * @param {...undefined} unread */
  single(...unread) {
    requireNoArgument(unread, 'single', 'where(pred).single()');
    const w = this.#window('single');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'single() found no element');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'single() found more than one element');
    return w[0];
  }

  /** The only item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).singleOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  singleOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'singleOrDefault');
    const w = this.#window('single');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'singleOrDefault() found more than one element');
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The last item. Reads no argument: `where(pred).last()` is the last
   * match (`JL0005` otherwise).
   * @param {...undefined} unread */
  last(...unread) {
    requireNoArgument(unread, 'last', 'where(pred).last()');
    const w = this.#window('last');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'last() found no element');
    return w[0];
  }

  /** The last item, or the value for an empty sequence; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).lastOrDefault(value)`).
   * @param {any} [defaultValue] @param {...undefined} unread */
  lastOrDefault(defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'lastOrDefault');
    const w = this.#window('last');
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The item at `index`; `JL2003` out of range. @param {number} index
   * @param {...undefined} unread */
  elementAt(index, ...unread) {
    requireNoTrailingArgument(unread, 'elementAt');
    requireNonNegativeInteger(index, 'elementAt');
    const w = this.#window('elementAt', [index]);
    if (w.length === 0) throw new LinqRuntimeError('JL2003', `elementAt(${index}) is out of range`);
    return w[0];
  }

  /** The item at `index`, or the value when out of range; reads no
   * predicate, so a callback there is `JL0005`
   * (`where(pred).elementAtOrDefault(index, value)`).
   * @param {number} index @param {any} [defaultValue] @param {...undefined} unread */
  elementAtOrDefault(index, defaultValue, ...unread) {
    requireDefaultValue([defaultValue, ...unread], 'elementAtOrDefault',
      'where(pred).elementAtOrDefault(index, value)');
    requireNonNegativeInteger(index, 'elementAtOrDefault');
    const w = this.#window('elementAt', [index]);
    return w.length === 0 ? defaultValue : w[0];
  }

  /** The number of items. Reads no argument: `where(pred).count()` counts
   * the ones a predicate keeps (`JL0005` otherwise).
   * @param {...undefined} unread */
  count(...unread) {
    requireNoArgument(unread, 'count', 'where(pred).count()');
    return this.#execute('count');
  }

  /** Reads no argument: `select(sel).sum()` folds a projection (`JL0005` otherwise).
   * @param {...undefined} unread */
  sum(...unread) {
    requireNoArgument(unread, 'sum', 'select(sel).sum()');
    return this.#execute('sum');
  }

  /** C#: `Average()` over an empty sequence throws. Reads no argument:
   * `select(sel).average()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  average(...unread) {
    requireNoArgument(unread, 'average', 'select(sel).average()');
    const v = this.#execute('average');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'average() of an empty sequence');
    return v;
  }

  /** Reads no argument: `select(sel).min()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  min(...unread) {
    requireNoArgument(unread, 'min', 'select(sel).min()');
    const v = this.#execute('min');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'min() of an empty sequence');
    return v;
  }

  /** Reads no argument: `select(sel).max()` (`JL0005` otherwise).
   * @param {...undefined} unread */
  max(...unread) {
    requireNoArgument(unread, 'max', 'select(sel).max()');
    const v = this.#execute('max');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'max() of an empty sequence');
    return v;
  }

  /** `any()` is existence; `any(pred)` is the `$some` quantifier.
   * @param {(...roots: any[]) => any} [predicate] @param {...undefined} unread */
  any(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'any');
    if (predicate === undefined) return this.#execute('exists');
    const { expression, lists } = this.#capture(predicate);
    return this.#execute('some', [expression], lists);
  }

  /** The `$every` quantifier (vacuously true over the empty sequence).
   * @param {(...roots: any[]) => any} predicate @param {...undefined} unread */
  all(predicate, ...unread) {
    requireNoTrailingArgument(unread, 'all');
    const { expression, lists } = this.#capture(predicate);
    return this.#execute('every', [expression], lists);
  }

  //#endregion
}

/**
 * Build a sequence over an iterable or a provider. Dispatch
 * happens ONCE, here: an `execute` duck is a provider and is never
 * enumerated locally; any iterable gets the in-memory reference
 * semantics; anything else is `JL0001` now, not at enumeration time.
 * @param {any} source - an iterable, or a provider; a provider carrying
 *   `root` binds its items through that root (`'$.Post[*]'` for an entity
 *   set), one carrying `relations` lets a relation member navigate (§3),
 *   one carrying `roots` and no `root` of its own is `JL0007`
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   the engine registries this sequence compiles against, under the
 *   engine's own option names: `compileTypeTest` enables `ofType`/`cast`,
 *   `collations` makes `orderBy(..., {collation})` executable in memory,
 *   `functions`/`pathFunctions` make `$call` and custom path functions
 *   resolvable, and `limits` bounds step and result counts. Pass
 *   `registry` when the hooks are rebuilt per call, so compiled documents
 *   still share a cache partition. A closed set: any other member, or an
 *   argument that is not a plain object, is `JL0005`.
 * @param {...undefined} unread - reads nothing: an argument after `options` is `JL0005`
 * @returns {Sequence}
 */
export function from(source, options, ...unread) {
  requireNoTrailingArgument(unread, 'from');
  const kind = classifySource(source);
  const root = kind === 'provider' ? providerRoot(source) : '$[*]';
  const relations = kind === 'provider' ? providerRelations(source) : null;
  return new Sequence(source, kind, root, [], new Map(),
    readOptions(options, SOURCE_OPTION_KEYS, 'from()'), relations);
}

/**
 * Attach a hand-written (or stored) query document to a source. The
 * document's result is the item sequence; further operators chain over
 * it. A version envelope is unwrapped so the expression embeds — only
 * the envelope this version knows (`{ $query: '0.1', $expr }`, nothing
 * else); any other spelling is handed to the engine first so its own
 * verdict (`JQ0006` for a version this consumer does not implement,
 * `JQ0003` for a stray member) is what surfaces, never a silent run of
 * a future document as a 0.1 one.
 * @param {any} source - iterable or provider, as `from`
 * @param {any} document - a Jaren query document
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   as {@link from}. A SAVED document is the case `limits` exists for:
 *   bound its steps and results before running it.
 * @param {...undefined} unread - reads nothing: an argument after `options` is `JL0005`
 * @returns {Sequence}
 */
export function fromDocument(source, document, options, ...unread) {
  requireNoTrailingArgument(unread, 'fromDocument');
  const read = readOptions(options, SOURCE_OPTION_KEYS, 'fromDocument()');
  let root = document;
  if (root !== null && typeof root === 'object' && !Array.isArray(root)
    && (Object.hasOwn(root, '$expr') || Object.hasOwn(root, '$query'))) {
    const keys = Object.keys(root);
    const known = root.$query === '0.1' && keys.length === 2 && Object.hasOwn(root, '$expr');
    if (!known) {
      compileJsonQuery(root); // the engine's verdict, or —
      throw new LinqBuildError('JL0005',
        "a version envelope is exactly { $query: '0.1', $expr: … } (QUERY-FORMAT §4.1)");
    }
    root = root.$expr;
  }
  // a copy: the sequence is immutable, and a document its author still holds
  // must not be a way to rewrite it
  return new Sequence(source, classifySource(source), snapshot(root), [], new Map(), read);
}
