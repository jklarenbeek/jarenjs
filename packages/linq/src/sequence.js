//@ts-check
/**
 * @file The deferred, immutable `Sequence`. Every operator returns a
 * NEW sequence; nothing runs until a terminal operation; a sequence may
 * be enumerated repeatedly and each enumeration re-reads its source —
 * the C# contract, including the part that surprises people
 * (LINQ-FORMAT.md §5 has the worked example).
 *
 * The chain is data: `toDocument()` emits one Jaren query document, and
 * a terminal either compiles it in memory (the reference semantics) or
 * hands it WHOLE to a provider (`execute(document, options)`, D2) —
 * which is what makes a query loggable, storable, diffable and
 * authorable by a constrained decoder.
 */

import { captureExpression, toExpression } from './expression.js';
import { emitDocument, wrapTerminal } from './document.js';
import { classifySource, compileDocument, executeInMemory } from './provider.js';
import { asyncFromSequence } from './async.js';
import { LinqBuildError, LinqRuntimeError } from './errors.js';

/** Binding names the emitted documents own; parameters may not shadow
 * them (LINQ-FORMAT.md §7). */
const RESERVED_NAMES = new Set(['it', 'it2', 'acc', 'g']);

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A deep, independent copy of an emitted query document. Plain data
 * only, which is exactly what a document is — every captured expression
 * has already passed the JSON-domain boundary in `expression.js`, so
 * there is nothing here a structural copy would lose.
 * @param {any} node
 * @returns {any}
 */
function snapshot(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(snapshot);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(node)) defineOwn(out, key, snapshot(node[key]));
  return out;
}

/**
 * Assign an OWN property, so a `__proto__` member stays a member instead
 * of silently replacing the object's prototype and vanishing.
 * @param {Record<string, any>} target
 * @param {string} key
 * @param {any} value
 */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key,
    { value, writable: true, enumerable: true, configurable: true });
}

/** @param {number} value @param {string} what */
function requireIndex(value, what) {
  if (!Number.isInteger(value) || value < 0) {
    throw new LinqBuildError('JL0005', `${what} takes a non-negative integer, got ${value}`);
  }
  return value;
}

/** The immutable query sequence. Construct via `from`/`fromDocument`. */
export class Sequence {
  #source;
  #sourceKind;
  #root;
  #stages;
  #params;
  #options;

  /**
   * @param {any} source
   * @param {'provider' | 'iterable'} sourceKind
   * @param {any} root - the root expression items come from
   * @param {readonly any[]} stages
   * @param {ReadonlyMap<string, any>} params
   * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
   *   pathFunctions?: any, limits?: any, registry?: object }} options
   */
  constructor(source, sourceKind, root, stages, params, options) {
    this.#source = source;
    this.#sourceKind = sourceKind;
    this.#root = root;
    this.#stages = stages;
    this.#params = params;
    this.#options = options;
  }

  /** @param {any} stage */
  #with(stage) {
    return new Sequence(this.#source, this.#sourceKind, this.#root,
      [...this.#stages, stage], this.#params, this.#options);
  }

  #declared() {
    return new Set(this.#params.keys());
  }

  /** @param {(...roots: any[]) => any} fn @param {readonly any[]} roots */
  #capture(fn, roots = ['it']) {
    if (typeof fn !== 'function') {
      throw new LinqBuildError('JL0005', 'this operator takes a callback function');
    }
    return captureExpression(fn, roots, this.#declared());
  }

  //#region operators (each returns a new immutable Sequence)

  /** Filter: `.where(it => it.age.gt(21))` → FLWOR `$where`. */
  where(predicate) {
    return this.#with({ kind: 'where', predicate: this.#capture(predicate) });
  }

  /** Project: `.select(it => ({ id: it.id }))` → `$return`. */
  select(projection) {
    return this.#with({ kind: 'select', projection: this.#capture(projection) });
  }

  /** Project-and-flatten: a multi-item projection concatenates (the
   * FLWOR `$return` already flattens per tuple). */
  selectMany(selector) {
    return this.#with({ kind: 'select', projection: this.#capture(selector) });
  }

  /** @param {any} key @param {boolean} desc @param {any} [options] */
  #orderStage(kind, key, desc, options) {
    const spec = { $key: this.#capture(key) };
    if (desc) spec.$dir = 'desc';
    if (options !== undefined) {
      if (options.empty !== undefined) spec.$empty = options.empty;
      if (options.collation !== undefined) spec.$collation = options.collation;
    }
    return this.#with({ kind, spec });
  }

  /** Sort ascending → an `$orderby` key spec (`$dir`/`$empty`/
   * `$collation` exposed through `options`).
   * @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options] */
  orderBy(key, options) {
    return this.#orderStage('orderBy', key, false, options);
  }

  /** @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options] */
  orderByDescending(key, options) {
    return this.#orderStage('orderBy', key, true, options);
  }

  /** Secondary sort key; must directly follow `orderBy*` (JL0005).
   * @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options] */
  thenBy(key, options) {
    return this.#orderStage('thenBy', key, false, options);
  }

  /** @param {(...roots: any[]) => any} key
   * @param {{ empty?: string, collation?: string }} [options] */
  thenByDescending(key, options) {
    return this.#orderStage('thenBy', key, true, options);
  }

  /** Group → `$groupby`; downstream items are `{ key, items }`. */
  groupBy(key) {
    return this.#with({ kind: 'groupBy', key: this.#capture(key) });
  }

  /** Both sides read ONE input document in 0.1 — a query document has
   * one root. Cross-source composition arrives with the relational order.
   * @param {Sequence} inner @param {string} what */
  #requireSameSource(inner, what) {
    if (!(inner instanceof Sequence)) {
      throw new LinqBuildError('JL0005', `${what} takes another sequence as its inner side`);
    }
    if (inner.#source !== this.#source) {
      throw new LinqBuildError('JL0005',
        `${what}'s other side must derive from the same source in 0.1 — `
        + 'a query document reads one input; load both collections under one root '
        + '(the relational order lifts this)');
    }
  }

  /** Equi-join → nested `$for` + `$where` equality (the engine rewrites
   * this shape to a hash join; that is why it is fast). */
  join(inner, outerKey, innerKey, result) {
    this.#requireSameSource(inner, 'join');
    return this.#with({
      kind: 'join',
      inner: inner.toDocument(),
      on: {
        $eq: [this.#capture(outerKey), this.#capture(innerKey, ['it2'])],
      },
      result: this.#capture(result, ['it', 'it2']),
    });
  }

  /** Group-join: the result selector receives the outer item and the
   * MATCHING inner group as an expression (`(u, g) => ({ n: g.count() })`). */
  groupJoin(inner, outerKey, innerKey, result) {
    this.#requireSameSource(inner, 'groupJoin');
    const group = {
      $for: { it2: inner.toDocument() },
      $where: { $eq: [this.#capture(outerKey), this.#capture(innerKey, ['it2'])] },
      $return: '$it2',
    };
    return this.#with({
      kind: 'select',
      projection: this.#capture(result, ['it', { doc: group, pathable: false }]),
    });
  }

  /** Seeded fold → `$fold` (the accumulator clause). Only the seeded
   * form exists: JSON has no way to spell an unseeded lambda's implicit
   * first element without one. */
  aggregate(seed, step) {
    return this.#with({
      kind: 'aggregate',
      seed: toExpression(seed),
      step: this.#capture(step, ['acc', 'it']),
    });
  }

  skip(count) {
    return this.#with({ kind: 'skip', count: requireIndex(count, 'skip') });
  }

  take(count) {
    return this.#with({ kind: 'take', count: requireIndex(count, 'take') });
  }

  distinct() {
    return this.#with({ kind: 'distinct' });
  }

  reverse() {
    return this.#with({ kind: 'reverse' });
  }

  /** Concatenate another sequence over the SAME source, or a constant
   * array (embedded verbatim; its elements join the stream).
   *
   * The same-source check is not a formality. A query document reads ONE
   * input, so the other sequence contributes its expression, not its
   * data — and a sequence built over a different source would have its
   * expression evaluated against THIS source, quietly reading the wrong
   * rows twice instead of concatenating two inputs. */
  concat(other) {
    let expr;
    if (other instanceof Sequence) {
      this.#requireSameSource(other, 'concat');
      expr = other.toDocument();
    }
    else if (Array.isArray(other)) {
      expr = { $for: { it: { $const: other } }, $return: '$it' };
    }
    else {
      throw new LinqBuildError('JL0005', 'concat takes a sequence or a constant array');
    }
    return this.#with({ kind: 'concat', other: expr });
  }

  /** `$default`: the sequence, or the fallback when it is empty. */
  defaultIfEmpty(fallback = null) {
    return this.#with({ kind: 'defaultIfEmpty', fallback: toExpression(fallback) });
  }

  /** Keep only items matching the JSON Schema (`$valid` filter). */
  ofType(schema) {
    return this.#with({ kind: 'ofType', schema });
  }

  /** Assert every item against the JSON Schema (`$assert`). */
  cast(schema) {
    return this.#with({ kind: 'cast', schema });
  }

  /** Cross into the async surface: everything BEFORE this call is the
   * prefix — compiled in memory, or pushed WHOLE to the provider — and
   * `mapAsync` plus everything after runs locally over its rows.
   * `explain()` on the result reports the split (LINQ-FORMAT.md §11).
   * @param {(item: any, signal: AbortSignal) => any} fn
   * @param {{ concurrency: number, mode?: string, ordered?: boolean }} options */
  mapAsync(fn, options) {
    return asyncFromSequence({
      runPrefix: () => this.toArray(),
      prefixDocument: () => this.toDocument(),
      params: this.#params,
      options: this.#options,
    }, fn, options);
  }

  /** Recorded `unsupported` (LINQ-FORMAT.md §4): the grammar has no
   * positional co-iteration. */
  zip() {
    throw new LinqBuildError('JL0006',
      'zip is unsupported: the query grammar has no positional co-iteration (see LINQ-FORMAT.md §4)');
  }

  /** Declare (and bind) external parameters: `.params({ tenantId })`.
   * Callbacks read them through their last argument (`(it, p) =>
   * it.tenant.eq(p.tenantId)`); the emitted document carries them as
   * externals — the seam that becomes bound SQL parameters. */
  params(bindings) {
    if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
      throw new LinqBuildError('JL0004', 'params takes an object of name → value bindings');
    }
    const merged = new Map(this.#params);
    for (const name of Object.keys(bindings)) {
      if (!VAR_NAME_RE.test(name)) {
        throw new LinqBuildError('JL0004', `'${name}' is not a valid parameter name`);
      }
      if (RESERVED_NAMES.has(name)) {
        throw new LinqBuildError('JL0004',
          `'${name}' is reserved (the emitted document's own binding names: it, it2, acc, g)`);
      }
      merged.set(name, bindings[name]);
    }
    return new Sequence(this.#source, this.#sourceKind, this.#root,
      this.#stages, merged, this.#options);
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
   * enumeration answered differently. A snapshot cannot do that. */
  toDocument() {
    return snapshot(emitDocument(this.#root, this.#stages));
  }

  /** The compiled view of the chain: the document, its externals and
   * its dependency sets.
   *
   * This always explains the IN-MEMORY compilation — it is the reference
   * semantics, and it is not the provider's plan. It cannot report SQL
   * pushdown, index use, residual execution or a strict refusal, and it
   * will fail on an operator or collation only the provider can compile.
   * For a provider's real plan, emit `toDocument()` and call that
   * provider's own explanation. */
  explain() {
    const document = this.toDocument();
    const compiled = compileDocument(document, {
      ...this.#options,
      externals: [...this.#params.keys()],
    });
    return {
      document,
      externals: [...compiled.externals],
      dependencies: compiled.dependencies,
    };
  }

  /** @param {string} terminal @param {readonly any[]} [args] */
  #execute(terminal, args) {
    const document = wrapTerminal(this.toDocument(), terminal, args);
    const externalNames = [...this.#params.keys()];
    const externals = Object.fromEntries(this.#params);
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
    // array item and element extraction is unambiguous
    return /** @type {any[]} */ (this.#execute(terminal, args));
  }

  toArray() {
    return this.#window('toArray');
  }

  * [Symbol.iterator]() {
    yield* this.toArray();
  }

  first() {
    const w = this.#window('first');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'first() found no element');
    return w[0];
  }

  /** @param {any} [defaultValue] */
  firstOrDefault(defaultValue) {
    const w = this.#window('first');
    return w.length === 0 ? defaultValue : w[0];
  }

  single() {
    const w = this.#window('single');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'single() found no element');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'single() found more than one element');
    return w[0];
  }

  /** @param {any} [defaultValue] */
  singleOrDefault(defaultValue) {
    const w = this.#window('single');
    if (w.length > 1) throw new LinqRuntimeError('JL2002', 'singleOrDefault() found more than one element');
    return w.length === 0 ? defaultValue : w[0];
  }

  last() {
    const w = this.#window('last');
    if (w.length === 0) throw new LinqRuntimeError('JL2001', 'last() found no element');
    return w[0];
  }

  /** @param {any} [defaultValue] */
  lastOrDefault(defaultValue) {
    const w = this.#window('last');
    return w.length === 0 ? defaultValue : w[0];
  }

  elementAt(index) {
    requireIndex(index, 'elementAt');
    const w = this.#window('elementAt', [index]);
    if (w.length === 0) throw new LinqRuntimeError('JL2003', `elementAt(${index}) is out of range`);
    return w[0];
  }

  /** @param {number} index @param {any} [defaultValue] */
  elementAtOrDefault(index, defaultValue) {
    requireIndex(index, 'elementAtOrDefault');
    const w = this.#window('elementAt', [index]);
    return w.length === 0 ? defaultValue : w[0];
  }

  count() {
    return this.#execute('count');
  }

  sum() {
    return this.#execute('sum');
  }

  /** C#: `Average()` over an empty sequence throws. */
  average() {
    const v = this.#execute('average');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'average() of an empty sequence');
    return v;
  }

  min() {
    const v = this.#execute('min');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'min() of an empty sequence');
    return v;
  }

  max() {
    const v = this.#execute('max');
    if (v === undefined) throw new LinqRuntimeError('JL2001', 'max() of an empty sequence');
    return v;
  }

  /** `any()` is existence; `any(pred)` is the `$some` quantifier.
   * @param {(...roots: any[]) => any} [predicate] */
  any(predicate) {
    if (predicate === undefined) return this.#execute('exists');
    return this.#execute('some', [this.#capture(predicate)]);
  }

  /** The `$every` quantifier (vacuously true over the empty sequence). */
  all(predicate) {
    return this.#execute('every', [this.#capture(predicate)]);
  }

  //#endregion
}

/**
 * Build a sequence over an iterable or a provider (D2). Dispatch
 * happens ONCE, here: an `execute` duck is a provider and is never
 * enumerated locally; any iterable gets the in-memory reference
 * semantics; anything else is `JL0001` now, not at enumeration time.
 * @param {any} source
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   the engine registries this sequence compiles against, under the
 *   engine's own option names: `compileTypeTest` enables `ofType`/`cast`,
 *   `collations` makes `orderBy(..., {collation})` executable in memory,
 *   `functions`/`pathFunctions` make `$call` and custom path functions
 *   resolvable, and `limits` bounds step and result counts. Pass
 *   `registry` when the hooks are rebuilt per call, so compiled documents
 *   still share a cache partition.
 * @returns {Sequence}
 */
export function from(source, options = {}) {
  return new Sequence(source, classifySource(source), '$[*]', [], new Map(), options);
}

/**
 * Attach a hand-written (or stored) query document to a source. The
 * document's result is the item sequence; further operators chain over
 * it. A version envelope is unwrapped so the expression embeds.
 * @param {any} source - iterable or provider, as `from`
 * @param {any} document - a Jaren query document
 * @param {{ compileTypeTest?: any, functions?: any, collations?: any,
 *   pathFunctions?: any, limits?: any, registry?: object }} [options] -
 *   as {@link from}. A SAVED document is the case `limits` exists for:
 *   bound its steps and results before running it.
 * @returns {Sequence}
 */
export function fromDocument(source, document, options = {}) {
  let root = document;
  if (root !== null && typeof root === 'object' && !Array.isArray(root)
    && Object.hasOwn(root, '$expr')) {
    root = root.$expr;
  }
  return new Sequence(source, classifySource(source), root, [], new Map(), options);
}
