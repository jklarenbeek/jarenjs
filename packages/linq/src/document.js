//@ts-check
/**
 * @file Chain → document emission: the stage list a `Sequence` carries
 * folds into ONE Jaren query document (QUERY-FORMAT.md). The item
 * binding is always named `it` — nested phrases shadow it legally, the
 * emitted JSON stays hand-readable, and every captured expression
 * references `$it…` regardless of chain depth.
 *
 * Folding rule: consecutive stages join one FLWOR phrase while their
 * clause slots stay free AND the chain order agrees with the phrase's
 * fixed semantic order (`$where` → `$groupby` → `$orderby` → `$return`,
 * QUERY-FORMAT §6.1). A stage that would violate either closes the
 * phrase (default `$return: "$it"`) and opens a new segment iterating
 * the closed one — `orderBy().where()` really does sort first and
 * filter second, exactly as written.
 *
 * Empty clause slots carry {@link EMPTY}, never `null`. `null` is a
 * legal query expression — `where(() => null)` filters everything out,
 * `select(() => null)` projects nulls, `groupBy(() => null)` is one
 * null-keyed group — so a slot that used `null` for "nothing here" could
 * not tell an absent clause from a null-valued one, and silently emitted
 * the document WITHOUT the clause. Every such query then returned its
 * unfiltered, unprojected source.
 *
 * An item is an item. The engine's `$for` unpacks an item that is an
 * array into its members, one level (QUERY-FORMAT §6.2, D4) — the
 * ergonomic default for a path like `$.tags`, and the wrong default for
 * a chain, where an array-valued ROW (a CSV record, a pair) is one item
 * the C# contract never splits. So every source a phrase iterates is
 * bound through an ARRAY CONSTRUCTOR — `{ "$for": { "it": ["$[*]"] } }`
 * — whose one array item is unpacked exactly once, into the rows as
 * they are; a reseated phrase is packed the same way, because a `$for`
 * over an inner phrase's result would unpack again. The one source left
 * bare is a PROVIDER's own root (`'$.Post[*]'`): a stored document is an
 * object, so D4 never applies there, and the bare root is the shape the
 * provider's planner pushes. The streaming async surface keeps items by
 * construction, so the two surfaces agree on every row shape.
 */

import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';
import { LinqBuildError, spellValue } from './errors.js';

/**
 * Validate a sequence window's count or a positional terminal's index.
 * @param {number} value
 * @param {string} what - The operator named by a refusal
 * @returns {number} The unchanged count or index
 */
export function requireNonNegativeInteger(value, what) {
  if (!Number.isInteger(value) || value < 0) {
    throw new LinqBuildError('JL0005', `${what} takes a non-negative integer, got ${spellValue(value)}`);
  }
  return value;
}

/**
 * Refuse an argument a member does not read. A terminal acts on the
 * sequence it ends: `count((r) => r.n > 3)` would count every row,
 * `sum((r) => r.n)` would fold the unprojected items and
 * `first((r) => r.n > 3)` would answer the first row, the callback never
 * called; `distinct((r) => r.n)` would drop only whole-row repeats. The
 * one passed is `JL0005` naming the spelling that does
 * what it was written to do. An `undefined` is a caller forwarding an
 * optional argument it did not receive, not an argument.
 * @param {readonly any[]} args - what the terminal was handed
 * @param {string} name - the member's spelling, for the refusal
 * @param {string} instead - the chain that reads the argument
 */
export function requireNoArgument(args, name, instead) {
  if (anyPassed(args)) {
    throw new LinqBuildError('JL0005',
      `${name}() takes no argument — it reads none, so the one passed would be ignored; `
      + `filter or project first: ${instead}`);
  }
}

/**
 * Whether a call handed over anything: an `undefined` is a caller
 * forwarding an optional argument it did not receive, not an argument.
 * @param {readonly any[]} args
 * @returns {boolean}
 */
function anyPassed(args) {
  return args.some((arg) => arg !== undefined);
}

/**
 * The spelling that does what an argument past the last one a member
 * reads meant, per row of members that share it (`@` stands for the
 * member's own name). A member in no row (`where`, `select`, `concat`,
 * `ofType`, `cast`, `params`) chains twice: `@(a).@(b)`.
 * @type {Readonly<Record<string, string>>}
 */
const UNREAD = {
  'skip take': 'skip(a).take(b)',
  'any all': 'where(a).@(b)',
  'orderBy thenBy': '@(key, { collation }); no comparer',
  'join groupJoin': 'no comparer; keys compare as the engine does',
  'toDocument explain': 'call it bare',
  selectMany: '@(sel).select(resultSel)',
  groupBy: '@(key).select((g) => ({ key: g.key, items: [g.items.all().member] }))',
  aggregate: '@(seed, step).select(resultSel)',
  mapAsync: '@(fn, { concurrency })',
  elementAt: 'elementAtOrDefault(index, value)',
  defaultIfEmpty: '@(value)',
};

/**
 * Refuse an argument after the ones a member reads. A selector, count or
 * schema handed past the last parameter was never called or applied:
 * `groupBy(key, (r) => r.n)` grouped whole rows,
 * `aggregate(0, step, (x) => x)` answered the fold, `take(1, 2)` took
 * one, `join(…, comparer)` compared as the engine does. The one passed
 * is `JL0005` naming the spelling that does what the extra one meant.
 * `undefined` is no argument.
 * @param {readonly any[]} unread - what followed the last parameter read
 * @param {string} name - the member's spelling (`orderByDescending` reads as `orderBy`)
 */
export function requireNoTrailingArgument(unread, name) {
  if (!anyPassed(unread)) return;
  const key = name.replace('Descending', '');
  const row = Object.keys(UNREAD).find((names) => names.split(' ').includes(key));
  const how = UNREAD[/** @type {string} */ (row)] ?? '@(a).@(b)';
  throw new LinqBuildError('JL0005',
    `${name}() would ignore the argument past its last; ${how.replaceAll('@', name)}`);
}

/**
 * Refuse a callback in the default slot of `firstOrDefault`,
 * `lastOrDefault` or `singleOrDefault`, and an argument after it. The
 * slot takes the VALUE answered for an empty sequence, never a
 * predicate: `firstOrDefault((r) => r.n > 3)` answered the first row
 * (or, over an empty sequence, the function itself), the predicate never
 * called. A default is a JSON-shaped item of the sequence's own kind, and
 * a function is none, so the one passed is `JL0005` naming the spelling
 * that reads a predicate; a caller who wants a callable fallback writes
 * `firstOrDefault() ?? fn`. `undefined` is no argument.
 * @param {readonly any[]} args - what the terminal was handed
 * @param {string} name - the terminal's spelling, for the refusal
 * @param {string} [instead] - the chain that reads a predicate; the
 *   `where(pred).<name>(value)` of the three terminals by default
 */
export function requireDefaultValue(args, name, instead = `where(pred).${name}(value)`) {
  if (typeof args[0] === 'function' || anyPassed(args.slice(1))) {
    throw new LinqBuildError('JL0005',
      `${name}() takes one default value, not a predicate — it reads no callback, so the one `
      + `passed would be ignored or answered as the default; filter first: ${instead}`);
  }
}

/**
 * The parameter bindings of a sequence and of the sequence it embeds whole
 * (a `join`, `groupJoin` or `concat` side), as ONE document carries them.
 * A name both sides bind must bind to the same value: the same reference,
 * or the same JSON — two literals spelled alike are one binding, not two.
 * Bindings are query data (`requireJsonBinding`), so their JSON text is
 * their identity, member order included.
 * @param {ReadonlyMap<string, any>} own
 * @param {ReadonlyMap<string, any>} inner
 * @param {string} what - the operator, for the message
 * @returns {Map<string, any>}
 */
export function mergeBindings(own, inner, what) {
  const merged = new Map(own);
  for (const [name, value] of inner) {
    if (merged.has(name)) {
      const held = merged.get(name);
      if (held !== value && JSON.stringify(held) !== JSON.stringify(value)) {
        throw new LinqBuildError('JL0004',
          `parameter '${name}' is bound to different values by the two sides of ${what} — `
          + 'one document carries one binding per name; bind it once, or rename one side');
      }
    }
    else merged.set(name, value);
  }
  return merged;
}

/**
 * One of the chain's closed option bags (QUERY-PEN §8.1, §11, §12):
 * `undefined` is the defaults; anything but a plain object, or a member
 * outside `known`, is `JL0005` naming the nearest member — a misspelt
 * bound dropped in silence would leave the query unbounded.
 * @param {any} options
 * @param {readonly string[]} known - the members the operator reads
 * @param {string} what - the operator, for the message
 * @returns {Record<string, any>} the options as given, or `{}`
 */
export function readOptions(options, known, what) {
  if (options === undefined) return {};
  if (!isPlainOptions(options)) throw new LinqBuildError('JL0005', `${what} takes a plain options object`);
  refuseUnknownMembers(options, known, (key, hint) =>
    new LinqBuildError('JL0005', `${what} does not take '${key}'${hint}`));
  return options;
}

/**
 * The key both chain classes answer, unchecked, with what a run of the
 * chain binds: `{ bindings, lists, source }` — its own parameter bindings,
 * the parameters its `in()` calls read whole as lists, and the provider
 * it was built over (`null` over rows in memory). The caller is
 * `live()`, which registers the chain under externals of its own merged
 * over those bindings, so it holds the list rule to the merged set, and
 * which registers the chain's document only over the source it names;
 * `explain()` and the terminals check the bindings they run with
 * themselves.
 */
export const RUN_BINDINGS = Symbol();

/** The members an ordering stage's options carry. */
const ORDER_OPTIONS = Object.freeze(['empty', 'collation']);

/**
 * One `$orderby` key spec, as both surfaces emit it: the key, the
 * direction, and the two options. What their VALUES may be is the
 * engine's to judge (`JQ0003`); the set itself is closed here.
 * @param {any} key - the captured key expression
 * @param {boolean} desc
 * @param {any} options
 * @param {string} what - the operator as written, for the message
 * @returns {any} the key spec
 */
export function orderSpec(key, desc, options, what) {
  const { empty, collation } = readOptions(options, ORDER_OPTIONS, what);
  /** @type {Record<string, any>} */
  const spec = { $key: key };
  if (desc) spec.$dir = 'desc';
  if (empty !== undefined) spec.$empty = empty;
  if (collation !== undefined) spec.$collation = collation;
  return spec;
}

/** The binding names the emitted documents own (QUERY-PEN §7): the
 * item bindings, the accumulator and the group — and the relation-hop
 * bindings `r1`, `r2`, … a capture allocates (expression.js). A
 * parameter may shadow none of them. */
export const RESERVED_BINDINGS = Object.freeze(['it', 'it2', 'acc', 'g']);
const HOP_BINDING_RE = /^r[1-9][0-9]*$/;

/**
 * Whether a parameter name collides with a binding the document owns.
 * @param {string} name
 * @returns {boolean}
 */
export function isReservedBinding(name) {
  return RESERVED_BINDINGS.includes(name) || HOP_BINDING_RE.test(name);
}

/** The reserved names, for a refusal's message. */
export const RESERVED_BINDINGS_TEXT = 'it, it2, acc, g, and r1, r2, … for relation hops';

/** The member a `groupBy`'s items carry the group's rows in. Spelled
 * once: the emitter writes it here and `expression.js` gives that member
 * its fan, so `g.items.count()` counts the ROWS the way a group-join's
 * `g.count()` already does. */
export const GROUP_ITEMS = 'items';

/** The stage kinds after which the items are no longer the source's
 * rows: a relation name on them is an ordinary member (QUERY-PEN §3).
 * The async surface adds its host boundary, `mapAsync`. */
export const PROJECTING_STAGES = new Set(['select', 'groupBy', 'join', 'groupJoin', 'aggregate']);

/** The fixed clause order a phrase may fill left-to-right. */
const SLOT_ORDER = ['bindings', 'where', 'groupby', 'orderby', 'return'];

/** The "this clause slot is unfilled" sentinel: a fresh object, so no
 * value a caller can express is ever mistaken for it. */
const EMPTY = Symbol('linq.emptySlot');

/**
 * An open FLWOR phrase under construction. `bare` marks a source the
 * phrase iterates WITHOUT packing (a provider's root); every other
 * source is packed so an array item stays one item.
 * @param {any} source
 * @param {boolean} [bare]
 */
function openPhrase(source, bare = false) {
  return {
    source, bare,
    fold: EMPTY, bindings: EMPTY, where: EMPTY, groupby: EMPTY, orderby: EMPTY, ret: EMPTY,
  };
}

/** Whether no clause of the phrase has been filled. */
function untouched(phrase) {
  return phrase.fold === EMPTY && phrase.bindings === EMPTY && phrase.where === EMPTY
    && phrase.groupby === EMPTY && phrase.orderby === EMPTY && phrase.ret === EMPTY;
}

/**
 * The expression a phrase's items come from, as a `$for` source: packed
 * (D4 unpacks the one array item back into the rows) unless the source
 * is a bare provider root.
 * @param {any} phrase
 */
function iterated(phrase) {
  return phrase.bare ? phrase.source : [phrase.source];
}

/**
 * A closed phrase as the SOURCE of another `$for` (a join side): a bare
 * untouched root stays bare; anything else is packed.
 * @param {any} phrase
 */
function packed(phrase) {
  return phrase.bare && untouched(phrase) ? phrase.source : [closePhrase(phrase)];
}

/**
 * A `selectMany` projection: the projected value iterated one level —
 * an array member's elements, a constructed array's members, a scalar
 * as itself — so `Seq<R[]>` really flattens to `Seq<R>`. The nested
 * phrase rebinds `it` legally: its source is evaluated in the enclosing
 * scope (the row), its body sees the element.
 * @param {any} projection - a captured expression
 * @returns {any}
 */
export function fanProjection(projection) {
  return { $for: { it: projection }, $return: '$it' };
}

/**
 * A deep, independent copy of an emitted query document. Plain data
 * only, which is exactly what a document is — every captured expression
 * has already passed the JSON-domain boundary in `expression.js`, so
 * there is nothing here a structural copy would lose.
 * @param {any} node
 * @returns {any}
 */
export function snapshot(node) {
  if (node === null || typeof node !== 'object') return node;
  // an explicit stack, not recursion: a grouping nested by hand is as deep
  // as its author wrote it, and a deep one must not overflow the copy
  /** @param {any} source @returns {any} */
  const shell = (source) => (Array.isArray(source) ? new Array(source.length) : {});
  const root = shell(node);
  const pending = [node, root];
  while (pending.length > 0) {
    const out = pending.pop();
    const source = pending.pop();
    const keys = Array.isArray(source) ? null : Object.keys(source);
    const count = keys === null ? source.length : keys.length;
    for (let i = 0; i < count; i++) {
      const key = keys === null ? i : keys[i];
      let item = source[key];
      if (item !== null && typeof item === 'object') {
        const copy = shell(item);
        pending.push(item, copy);
        item = copy;
      }
      if (keys === null) out[key] = item;
      else defineOwn(out, /** @type {string} */ (key), item);
    }
  }
  return root;
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

/** Whether every slot AFTER `slot` is still empty — chain order must
 * agree with the phrase's fixed semantic order. */
function laterSlotsFree(phrase, slot) {
  for (let i = SLOT_ORDER.indexOf(slot) + 1; i < SLOT_ORDER.length; i++) {
    const later = SLOT_ORDER[i];
    if (phrase[later === 'return' ? 'ret' : later] !== EMPTY) return false;
  }
  return true;
}

/** Whether `slot` may be filled fresh (itself empty, order respected). */
function slotFree(phrase, slot) {
  return phrase[slot === 'return' ? 'ret' : slot] === EMPTY
    && laterSlotsFree(phrase, slot);
}

/** Close a phrase into a query expression. */
function closePhrase(phrase) {
  if (untouched(phrase)) return phrase.source;
  const doc = {};
  if (phrase.fold !== EMPTY) doc.$fold = { acc: phrase.fold };
  doc.$for = { it: iterated(phrase) };
  if (phrase.bindings !== EMPTY) doc.$let = phrase.bindings;
  if (phrase.where !== EMPTY) doc.$where = phrase.where;
  if (phrase.groupby !== EMPTY) doc.$groupby = { g: phrase.groupby };
  if (phrase.orderby !== EMPTY) {
    doc.$orderby = phrase.orderby.length === 1 ? phrase.orderby[0] : phrase.orderby;
  }
  // the default group shape: an object member takes exactly one item,
  // so the member sequence packs into an array constructor and an
  // empty grouping key reads as null
  doc.$return = phrase.ret !== EMPTY ? phrase.ret : (phrase.groupby !== EMPTY
    ? { key: { $default: ['$g', null] }, [GROUP_ITEMS]: ['$it'] }
    : '$it');
  return doc;
}

/** Combine two predicates. */
const andJoin = (a, b) => (a === EMPTY ? b : { $and: [a, b] });

/**
 * Emit the query document for a stage list.
 * @param {any} root - the root expression the items come from
 *   (`'$[*]'` for a plain source; a stripped document for
 *   `fromDocument`)
 * @param {readonly any[]} stages
 * @param {{ bareRoot?: boolean }} [options] - `bareRoot` iterates the
 *   root without packing (a provider's own root; see the header)
 * @returns {any} the emitted query document (plain JSON)
 */
export function emitDocument(root, stages, options = undefined) {
  let phrase = openPhrase(root, options?.bareRoot === true);
  /** Close the open phrase and reopen over its result. */
  const reseat = () => { phrase = openPhrase(closePhrase(phrase)); };

  for (const stage of stages) {
    switch (stage.kind) {
      case 'where':
        // a second where in the same phrase COMBINES ($and); only a
        // later-slot occupant (orderby/groupby/return) forces a segment
        if (!laterSlotsFree(phrase, 'where')) reseat();
        phrase.where = andJoin(phrase.where, stage.predicate);
        break;
      case 'select': // also selectMany: a multi-item projection flattens
        if (!slotFree(phrase, 'return')) reseat();
        phrase.ret = stage.projection;
        reseat(); // later operators see projected items
        break;
      case 'orderBy':
        if (!slotFree(phrase, 'orderby')) reseat();
        phrase.orderby = [stage.spec];
        break;
      case 'thenBy': {
        if (phrase.orderby === EMPTY || phrase.ret !== EMPTY) {
          throw new LinqBuildError('JL0005',
            'thenBy/thenByDescending must directly follow orderBy/orderByDescending');
        }
        phrase.orderby = [...phrase.orderby, stage.spec];
        break;
      }
      case 'groupBy':
        if (!slotFree(phrase, 'groupby')) reseat();
        phrase.groupby = stage.key;
        reseat(); // later operators see { key, items } groups
        break;
      case 'join':
        // the hash-join shape: nested bindings + equality (the engine's
        // compile-time rewrite turns exactly this into a hash probe;
        // packed sources keep it — the probe is keyed on the bindings,
        // not on the sources' spelling)
        phrase = openPhrase({
          $for: { it: packed(phrase), it2: stage.innerBare ? stage.inner : [stage.inner] },
          $where: stage.on,
          $return: stage.result,
        });
        break;
      case 'groupJoin':
        // the matching group bound as an ARRAY value (`$let`, one item)
        // so the projection can index it, fan it and place it in a
        // member; its aggregates fan over the members (expression.js)
        if (!slotFree(phrase, 'bindings')) reseat();
        phrase.bindings = { g: [stage.group] };
        phrase.ret = stage.projection;
        reseat();
        break;
      case 'aggregate': {
        // the seeded fold: its own phrase, closed immediately — the
        // result is one accumulated value, not a tuple stream
        if (phrase.fold !== EMPTY || phrase.where !== EMPTY || phrase.groupby !== EMPTY
          || phrase.orderby !== EMPTY || phrase.ret !== EMPTY) reseat();
        phrase.fold = stage.seed;
        phrase.ret = stage.step;
        reseat();
        break;
      }
      case 'skip':
        phrase = openPhrase({ $subsequence: [closePhrase(phrase), stage.count] });
        break;
      case 'take':
        phrase = openPhrase({ $subsequence: [closePhrase(phrase), 0, stage.count] });
        break;
      case 'distinct':
        phrase = openPhrase({ $distinct: closePhrase(phrase) });
        break;
      case 'reverse':
        phrase = openPhrase({ $reverse: closePhrase(phrase) });
        break;
      case 'concat':
        phrase = openPhrase({ $seq: [closePhrase(phrase), stage.other] });
        break;
      case 'defaultIfEmpty':
        phrase = openPhrase({ $default: [closePhrase(phrase), stage.fallback] });
        break;
      case 'ofType': // keep only items the schema accepts
        // the second $valid argument is a SCHEMA literal — verbatim by
        // the registry's `schema` parameter kind, never an expression
        phrase = openPhrase(closePhrase(phrase));
        phrase.where = { $valid: ['$it', stage.schema] };
        break;
      case 'cast': // assert every item against the schema
        phrase = openPhrase(closePhrase(phrase));
        phrase.ret = { $assert: ['$it', stage.schema] };
        break;
      /* c8 ignore next 2 -- stages are produced by Sequence alone */
      default:
        throw new LinqBuildError('JL0005', `unknown stage kind '${stage.kind}'`);
    }
  }
  return closePhrase(phrase);
}

/**
 * Wrap the emitted expression per terminal so results extract without
 * ambiguity: the engine maps a result to `undefined | item | array of
 * items`, and a SINGLE item that is itself an array would be
 * indistinguishable from two items — so every element-window terminal
 * emits `[window]` (one array item, Rule 3 constructor: elements
 * flatten) and reads its elements.
 * @param {any} expr - the emitted chain expression
 * @param {string} terminal
 * @param {readonly any[]} [args]
 * @returns {any}
 */
export function wrapTerminal(expr, terminal, args = []) {
  switch (terminal) {
    case 'toArray': return [expr];
    case 'first': return [{ $subsequence: [expr, 0, 1] }];
    case 'single': return [{ $subsequence: [expr, 0, 2] }];
    case 'last': return [{ $subsequence: [{ $reverse: expr }, 0, 1] }];
    case 'elementAt': return [{ $subsequence: [expr, args[0], 1] }];
    case 'count': return { $count: expr };
    case 'sum': return { $sum: expr };
    case 'average': return { $avg: expr };
    case 'min': return { $min: expr };
    case 'max': return { $max: expr };
    case 'exists': return { $exists: expr };
    case 'some': return { $some: { it: expr }, $satisfies: args[0] };
    case 'every': return { $every: { it: expr }, $satisfies: args[0] };
    /* c8 ignore next 2 -- terminals are produced by Sequence alone */
    default:
      throw new LinqBuildError('JL0005', `unknown terminal '${terminal}'`);
  }
}
