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
 */

import { LinqBuildError } from './errors.js';

/** The fixed clause order a phrase may fill left-to-right. */
const SLOT_ORDER = ['where', 'groupby', 'orderby', 'return'];

/** The "this clause slot is unfilled" sentinel: a fresh object, so no
 * value a caller can express is ever mistaken for it. */
const EMPTY = Symbol('linq.emptySlot');

/** An open FLWOR phrase under construction. */
function openPhrase(source) {
  return {
    source, fold: EMPTY, where: EMPTY, groupby: EMPTY, orderby: EMPTY, ret: EMPTY,
  };
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
  const untouched = phrase.fold === EMPTY && phrase.where === EMPTY
    && phrase.groupby === EMPTY && phrase.orderby === EMPTY && phrase.ret === EMPTY;
  if (untouched) return phrase.source;
  const doc = {};
  if (phrase.fold !== EMPTY) doc.$fold = { acc: phrase.fold };
  doc.$for = { it: phrase.source };
  if (phrase.where !== EMPTY) doc.$where = phrase.where;
  if (phrase.groupby !== EMPTY) doc.$groupby = { g: phrase.groupby };
  if (phrase.orderby !== EMPTY) {
    doc.$orderby = phrase.orderby.length === 1 ? phrase.orderby[0] : phrase.orderby;
  }
  // the default group shape: an object member takes exactly one item,
  // so the member sequence packs into an array constructor and an
  // empty grouping key reads as null
  doc.$return = phrase.ret !== EMPTY ? phrase.ret : (phrase.groupby !== EMPTY
    ? { key: { $default: ['$g', null] }, items: ['$it'] }
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
 * @returns {any} the emitted query document (plain JSON)
 */
export function emitDocument(root, stages) {
  let phrase = openPhrase(root);
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
        // compile-time rewrite turns exactly this into a hash probe)
        phrase = openPhrase({
          $for: { it: closePhrase(phrase), it2: stage.inner },
          $where: stage.on,
          $return: stage.result,
        });
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
