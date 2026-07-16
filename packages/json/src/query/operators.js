//#region Jaren JSON Query operator registry
// The single table of the section-8 operator vocabulary (QUERY-FORMAT.md):
// every operator declares its signature once - `name -> { params, result,
// compile }` - and gets uniform compile-time checking from it. The
// query-language analogue of the `FUNCTIONS` table in path.js.
//
//   - `params` describes the argument shape. The string 'expr' is the
//     single form (`{"$op": operand}`: the value IS the one argument);
//     `{ kinds, min, variadic? }` is the array form (`{"$op": [a, b]}`),
//     where `kinds[i]` is the expectation of position i - 'expr' (an
//     ordinary expression), 'raw' (a verbatim JSON value, not evaluated;
//     reserved for the schema arguments of the type-system work order) or
//     'name' (a variable name string). `min` is the minimum argument
//     count; the maximum is `kinds.length`, or unbounded when `variadic`
//     (the last kind repeats). normalize.js validates arity and shape
//     from this descriptor (JQ0003), so compile functions never re-check
//     structure.
//   - `result(cards)` is the operator's static cardinality contribution:
//     given the argument cardinalities it returns the result cardinality
//     (an upper approximation; CARD_ONE means "always exactly one item").
//   - `compile(gets, args, docPath)` returns the getter closure.
//     `gets[i]` is the compiled getter of argument i (`null` for
//     'raw'/'name' positions - their value is compile-time data at
//     `args[i].value`); `args[i]` is the frozen argument AST node
//     carrying `card` and `docPath`; `docPath` locates the operator key
//     itself (e.g. `/$idiv`).
//
// All runtime error conditions of the operator library (JQ2xxx,
// QUERY-FORMAT.md section 10.3) are raised here.

import { equalsJson } from '@jarenjs/core/object';
import { countCodePoints, compareCodePoints } from '@jarenjs/core/string';
import { compileIRegexp } from '@jarenjs/core/text/iregexp';
import { JsonQueryRuntimeError } from './errors.js';
import {
  EMPTY, Seq, seqOf, appendItem, ebv, itemCount, firstItem,
  stableKeyString, describeItem,
} from './runtime.js';
import {
  CARD_ZERO, CARD_ONE, CARD_OPT, CARD_MANY, joinCard, sumCard,
} from './normalize.js';
import { compileExistsTest } from './compile.js';

const hasOwn = Object.hasOwn;

//#region parameter and result descriptors

// the single form: the operator's value is its one operand expression
const UNARY = 'expr';
// array forms; frozen and shared across entries
const ARGS_2 = Object.freeze({ kinds: Object.freeze(['expr', 'expr']), min: 2 });
const ARGS_3 = Object.freeze({ kinds: Object.freeze(['expr', 'expr', 'expr']), min: 3 });
const ARGS_1_2 = Object.freeze({ kinds: Object.freeze(['expr', 'expr']), min: 1 });
const ARGS_2_3 = Object.freeze({ kinds: Object.freeze(['expr', 'expr', 'expr']), min: 2 });
const ARGS_0N = Object.freeze({ kinds: Object.freeze(['expr']), min: 0, variadic: true });
const ARGS_1N = Object.freeze({ kinds: Object.freeze(['expr']), min: 1, variadic: true });

const RESULT_ONE = () => CARD_ONE;
const RESULT_OPT = () => CARD_OPT;
const RESULT_MANY = () => CARD_MANY;
// the operand's cardinality is preserved ($distinct, $reverse, $sort)
const resultOfOperand = (cards) => cards[0];
// a singleton operand stays a singleton; anything else may come out empty
const resultEmptyPropagates = (cards) => (cards[0] === CARD_ONE ? CARD_ONE : CARD_OPT);

//#endregion

//#region runtime argument helpers

function runtimeError(code, message, docPath) {
  return new JsonQueryRuntimeError(code, message, docPath);
}

// string parameter rule (section 8.7): the empty sequence reads as '',
// a single string is itself, anything else is JQ2001
function stringArg(v, docPath) {
  if (typeof v === 'string')
    return v;
  if (v === EMPTY)
    return '';
  throw runtimeError('JQ2001', `expected a string, got ${describeItem(v)}`, docPath);
}

// numeric position/length parameter: a single number, everything else -
// including the empty sequence - is JQ2001
function numberArg(v, docPath) {
  if (typeof v !== 'number')
    throw runtimeError('JQ2001', `expected a number, got ${describeItem(v)}`, docPath);
  return v;
}

// the $string cast table (section 8.10); callers handle the empty sequence
function castString(v, docPath) {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    default:
      if (v === null)
        return 'null';
      throw runtimeError('JQ2001', `cannot cast ${describeItem(v)} to a string`, docPath);
  }
}

// the $number cast table (section 8.10): strings must be JSON numbers
// (strict RFC 8259 grammar - no leading '+', no bare '.', no whitespace)
const JSON_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

function castNumber(v, docPath) {
  switch (typeof v) {
    case 'number':
      return v;
    case 'boolean':
      return v ? 1 : 0;
    case 'string':
      if (JSON_NUMBER_RE.test(v))
        return Number(v);
      throw runtimeError('JQ2001', `'${v}' is not a JSON number`, docPath);
    default:
      throw runtimeError('JQ2001', `cannot cast ${describeItem(v)} to a number`, docPath);
  }
}

//#endregion

//#region shared compile helpers

// per-element appliers of $seq: CARD_ONE elements push directly,
// everything else flattens through appendItem (same discipline as the
// array constructor in compile.js)
function compileSeqOp(gets, args) {
  if (gets.length === 0)
    return () => EMPTY;
  if (gets.length === 1) // {"$seq": [e]} is e
    return gets[0];
  const alen = gets.length;
  const appliers = new Array(alen);
  for (let i = 0; i < alen; i++) {
    const get = gets[i];
    appliers[i] = args[i].card === CARD_ONE
      ? (f, acc) => acc.push(get(f))
      : (f, acc) => appendItem(acc, get(f));
  }
  return (f) => {
    const acc = [];
    for (let i = 0; i < alen; i++)
      appliers[i](f, acc);
    return seqOf(acc);
  };
}

// item comparison rules (section 8.4): $eq/$ne deep structural JSON
// equality (D2); ordering only between two numbers or two strings, any
// other pair is simply false (no witness, no error)
function itemEq(a, b) {
  return equalsJson(a, b);
}
function itemNe(a, b) {
  return !equalsJson(a, b);
}
function itemLt(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a < b;
  if (typeof a === 'string')
    return typeof b === 'string' && compareCodePoints(a, b) < 0;
  return false;
}
function itemLe(a, b) {
  if (typeof a === 'number')
    return typeof b === 'number' && a <= b;
  if (typeof a === 'string')
    return typeof b === 'string' && compareCodePoints(a, b) <= 0;
  return false;
}
function itemGt(a, b) {
  return itemLt(b, a);
}
function itemGe(a, b) {
  return itemLe(b, a);
}

// existential general comparison (section 8.4): true iff some pair of
// items compares true; either side empty means no witnessing pair
// (contrast the path filter dialect where Nothing == Nothing holds -
// section 5.2)
function comparisonEntry(itemCmp) {
  return {
    params: ARGS_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const left = gets[0];
      const right = gets[1];
      if (args[0].card === CARD_ONE && args[1].card === CARD_ONE)
        // the common case: two singletons, one direct item comparison
        return (f) => itemCmp(left(f), right(f));
      return (f) => {
        const lv = left(f);
        if (lv === EMPTY)
          return false;
        const rv = right(f);
        if (rv === EMPTY)
          return false;
        if (lv instanceof Seq) {
          const li = lv.items;
          if (rv instanceof Seq) {
            const ri = rv.items;
            for (let i = 0; i < li.length; i++) {
              for (let j = 0; j < ri.length; j++) {
                if (itemCmp(li[i], ri[j]))
                  return true;
              }
            }
            return false;
          }
          for (let i = 0; i < li.length; i++) {
            if (itemCmp(li[i], rv))
              return true;
          }
          return false;
        }
        if (rv instanceof Seq) {
          const ri = rv.items;
          for (let j = 0; j < ri.length; j++) {
            if (itemCmp(lv, ri[j]))
              return true;
          }
          return false;
        }
        return itemCmp(lv, rv);
      };
    },
  };
}

function arithOperandError(v, docPath) {
  return runtimeError('JQ2001', `arithmetic requires a number operand, got ${describeItem(v)}`, docPath);
}

// IEEE double arithmetic (section 8.5, D1): empty operands propagate,
// non-number singletons and longer sequences are JQ2001. `makeApply`
// builds the two-number kernel (it closes over the operator docPath for
// the JQ2002 zero-divisor errors of $idiv/$mod).
function arithmeticEntry(makeApply) {
  return {
    params: ARGS_2,
    result: (cards) => (cards[0] === CARD_ONE && cards[1] === CARD_ONE ? CARD_ONE : CARD_OPT),
    compile: (gets, args, docPath) => {
      const apply = makeApply(docPath);
      const left = gets[0];
      const right = gets[1];
      const leftPath = args[0].docPath;
      const rightPath = args[1].docPath;
      if (args[0].card === CARD_ONE && args[1].card === CARD_ONE) {
        // singleton operands: type guard only, no sequence checks
        return (f) => {
          const a = left(f);
          if (typeof a !== 'number')
            throw arithOperandError(a, leftPath);
          const b = right(f);
          if (typeof b !== 'number')
            throw arithOperandError(b, rightPath);
          return apply(a, b);
        };
      }
      return (f) => {
        const a = left(f);
        if (a === EMPTY) // empty propagation (XQuery)
          return EMPTY;
        if (typeof a !== 'number')
          throw arithOperandError(a, leftPath);
        const b = right(f);
        if (b === EMPTY)
          return EMPTY;
        if (typeof b !== 'number')
          throw arithOperandError(b, rightPath);
        return apply(a, b);
      };
    },
  };
}

// variadic EBV logic (section 8.6): left-to-right with short-circuit -
// operands after the deciding one are not evaluated
function logicEntry(stopOn) {
  return {
    params: ARGS_1N,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const paths = args.map((a) => a.docPath);
      const flen = gets.length;
      return (f) => {
        for (let i = 0; i < flen; i++) {
          if (ebv(gets[i](f), paths[i]) === stopOn)
            return stopOn;
        }
        return !stopOn;
      };
    },
  };
}

//#endregion

//#region string operators

// unary string operator: coerce per stringArg, apply the kernel
function stringUnaryEntry(apply) {
  return {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => apply(stringArg(get(f), docPath));
    },
  };
}

// binary string operator over two coerced string arguments
function stringPairEntry(test) {
  return {
    params: ARGS_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const aGet = gets[0];
      const aPath = args[0].docPath;
      const bGet = gets[1];
      const bPath = args[1].docPath;
      return (f) => test(stringArg(aGet(f), aPath), stringArg(bGet(f), bPath));
    },
  };
}

// fn:normalize-space: strip leading/trailing XML whitespace (space, tab,
// LF, CR) and collapse internal runs to a single space
function normalizeSpace(s) {
  let out = '';
  let pending = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) {
      pending = out !== '';
      continue;
    }
    if (pending) {
      out += ' ';
      pending = false;
    }
    out += s[i];
  }
  return out;
}

// $match (anchored) / $search (free): I-Regexp (RFC 9485, D5). Literal
// patterns compile at query-compile time; dynamic patterns get the
// per-callsite monomorphic cache (the compileRegexTest approach in
// segments.js). A syntactically invalid I-Regexp yields false, the
// RFC 9535 match()/search() behavior.
function regexTestEntry(fullMatch) {
  return {
    params: ARGS_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const inGet = gets[0];
      const inPath = args[0].docPath;
      const patNode = args[1];
      if (patNode.kind === 'literal' && typeof patNode.value === 'string') {
        const re = compileIRegexp(patNode.value, fullMatch);
        if (re === null)
          return (f) => {
            stringArg(inGet(f), inPath); // the input type rule still applies
            return false;
          };
        return (f) => re.test(stringArg(inGet(f), inPath));
      }
      const patGet = gets[1];
      const patPath = patNode.docPath;
      let lastPattern = null;
      let lastRegExp = null;
      return (f) => {
        const s = stringArg(inGet(f), inPath);
        const p = stringArg(patGet(f), patPath);
        if (p !== lastPattern) {
          lastPattern = p;
          lastRegExp = compileIRegexp(p, fullMatch);
        }
        return lastRegExp !== null && lastRegExp.test(s);
      };
    },
  };
}

// $replace pattern compilation: null marks an invalid I-Regexp, false a
// pattern that matches the zero-length string (an error per F&O
// fn:replace, err:FORX0002/FORX0003 -> JQ2001), otherwise the global
// RegExp used for replace-all
function replaceRegexp(pattern) {
  const re = compileIRegexp(pattern, false);
  if (re === null)
    return null;
  if (re.test(''))
    return false;
  return new RegExp(re.source, 'gu');
}

function replaceRegexpError(gre, pattern, docPath) {
  return runtimeError('JQ2001', gre === null
    ? `'${pattern}' is not a valid I-Regexp pattern`
    : `'$replace' pattern '${pattern}' matches the zero-length string`, docPath);
}

function compileReplace(gets, args) {
  const sGet = gets[0];
  const sPath = args[0].docPath;
  const patNode = args[1];
  const patPath = patNode.docPath;
  const repGet = gets[2];
  const repPath = args[2].docPath;
  if (patNode.kind === 'literal' && typeof patNode.value === 'string') {
    const gre = replaceRegexp(patNode.value);
    return (f) => {
      const s = stringArg(sGet(f), sPath);
      const rep = stringArg(repGet(f), repPath);
      if (gre === null || gre === false)
        throw replaceRegexpError(gre, patNode.value, patPath);
      // function replacement: `rep` is inserted literally, no `$`-group
      // references (I-Regexp guarantees no capture semantics - D5)
      return s.replace(gre, () => rep);
    };
  }
  const patGet = gets[1];
  let lastPattern = null;
  let lastGre = null;
  return (f) => {
    const s = stringArg(sGet(f), sPath);
    const p = stringArg(patGet(f), patPath);
    const rep = stringArg(repGet(f), repPath);
    if (p !== lastPattern) {
      lastPattern = p;
      lastGre = replaceRegexp(p);
    }
    if (lastGre === null || lastGre === false)
      throw replaceRegexpError(lastGre, p, patPath);
    return s.replace(lastGre, () => rep);
  };
}

//#endregion

//#region aggregate operators

function aggregateNumber(v, docPath) {
  if (typeof v !== 'number')
    throw runtimeError('JQ2001', `aggregate items must be numbers, got ${describeItem(v)}`, docPath);
  return v;
}

function minmaxError(v, docPath) {
  return runtimeError('JQ2001', `'$min'/'$max' items must be all numbers or all strings, got ${describeItem(v)}`, docPath);
}

// $min/$max (section 8.8): empty -> empty; items all numbers or all
// strings (Unicode scalar value order), mixed or anything else JQ2001;
// any NaN item makes a numeric result NaN (F&O fn:min/fn:max)
function minmaxEntry(isMax) {
  return {
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        if (!(v instanceof Seq)) {
          const t = typeof v;
          if (t !== 'number' && t !== 'string')
            throw minmaxError(v, docPath);
          return v;
        }
        const items = v.items;
        let best = items[0];
        const numeric = typeof best === 'number';
        if (!numeric && typeof best !== 'string')
          throw minmaxError(best, docPath);
        let sawNaN = numeric && best !== best;
        for (let i = 1; i < items.length; i++) {
          const item = items[i];
          if (typeof item === 'number') {
            if (!numeric)
              throw minmaxError(item, docPath);
            if (item !== item)
              sawNaN = true;
            else if (isMax ? item > best : item < best)
              best = item;
          }
          else if (typeof item === 'string') {
            if (numeric)
              throw minmaxError(item, docPath);
            const c = compareCodePoints(item, best);
            if (isMax ? c > 0 : c < 0)
              best = item;
          }
          else {
            throw minmaxError(item, docPath);
          }
        }
        return sawNaN ? NaN : best;
      };
    },
  };
}

//#endregion

//#region sequence operators

function sortError(v, docPath) {
  return runtimeError('JQ2005', `'$sort' items must be all numbers or all strings, got ${describeItem(v)}`, docPath);
}

// number order for $sort: NaN equal to itself and less than every other
// number (the section 6.6 order-by rule)
function compareNumberKeys(a, b) {
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  if (a !== a)
    return b !== b ? 0 : -1;
  return b !== b ? 1 : 0;
}

function rangeBoundError(v, docPath) {
  return runtimeError('JQ2001', `'$range' bounds must be integral numbers, got ${describeItem(v)}`, docPath);
}

// the resource guard of $range (section 10.3, JQ2007)
const RANGE_LIMIT = 4294967296; // 2^32

//#endregion

//#region the registry

/**
 * The complete v0.1 operator vocabulary (QUERY-FORMAT.md section 8), one
 * entry per operator: `{ params, result, compile }` (see the module
 * comment for the descriptor contract). Frozen; the closed vocabulary is
 * exactly the keys of this table plus the phrase keys and escape hatches
 * handled by normalize.js.
 */
export const OPERATORS = Object.freeze({

  //#region section 8.2 - sequences

  '$seq': {
    params: ARGS_0N,
    result: (cards) => {
      let card = CARD_ZERO;
      for (let i = 0; i < cards.length; i++)
        card = sumCard(card, cards[i]);
      return card;
    },
    compile: compileSeqOp,
  },

  '$exists': {
    params: UNARY,
    result: RESULT_ONE,
    // existence never materializes a result sequence (the path.js
    // compileExists analogue lives in compile.js, keyed on the node)
    compile: (gets, args) => compileExistsTest(args[0]),
  },

  '$empty': {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const test = compileExistsTest(args[0]);
      return (f) => !test(f);
    },
  },

  //#endregion

  //#region section 8.3 - conditional

  '$if': {
    params: ARGS_2_3,
    result: (cards) => joinCard(cards[1], cards.length === 3 ? cards[2] : CARD_ZERO),
    compile: (gets, args) => {
      const cond = gets[0];
      const condPath = args[0].docPath;
      const then = gets[1];
      if (gets.length === 2) // missing else means the empty sequence
        return (f) => (ebv(cond(f), condPath) ? then(f) : EMPTY);
      const alt = gets[2];
      return (f) => (ebv(cond(f), condPath) ? then(f) : alt(f));
    },
  },

  //#endregion

  //#region section 8.4 - comparisons

  '$eq': comparisonEntry(itemEq),
  '$ne': comparisonEntry(itemNe),
  '$lt': comparisonEntry(itemLt),
  '$le': comparisonEntry(itemLe),
  '$gt': comparisonEntry(itemGt),
  '$ge': comparisonEntry(itemGe),

  //#endregion

  //#region section 8.5 - arithmetic

  '$add': arithmeticEntry(() => (a, b) => a + b),
  '$sub': arithmeticEntry(() => (a, b) => a - b),
  '$mul': arithmeticEntry(() => (a, b) => a * b),
  // IEEE 754 double division: /0 is +-Infinity or NaN (D1)
  '$div': arithmeticEntry(() => (a, b) => a / b),
  // truncating division; zero divisor errors (section 8.5)
  '$idiv': arithmeticEntry((docPath) => (a, b) => {
    if (b === 0)
      throw runtimeError('JQ2002', "'$idiv' by zero", docPath);
    return Math.trunc(a / b);
  }),
  // XQuery double mod takes the sign of the dividend = JS %
  '$mod': arithmeticEntry((docPath) => (a, b) => {
    if (b === 0)
      throw runtimeError('JQ2002', "'$mod' by zero", docPath);
    return a % b;
  }),

  '$neg': {
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      if (args[0].card === CARD_ONE) {
        return (f) => {
          const a = get(f);
          if (typeof a !== 'number')
            throw arithOperandError(a, docPath);
          return -a;
        };
      }
      return (f) => {
        const a = get(f);
        if (a === EMPTY)
          return EMPTY;
        if (typeof a !== 'number')
          throw arithOperandError(a, docPath);
        return -a;
      };
    },
  },

  //#endregion

  //#region section 8.6 - logic

  '$and': logicEntry(false),
  '$or': logicEntry(true),

  '$not': {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => !ebv(get(f), docPath);
    },
  },

  //#endregion

  //#region section 8.7 - strings

  '$concat': {
    params: ARGS_0N,
    result: RESULT_ONE,
    compile: (gets, args) => {
      if (gets.length === 0)
        return () => '';
      const paths = args.map((a) => a.docPath);
      const flen = gets.length;
      return (f) => {
        let s = '';
        for (let i = 0; i < flen; i++) {
          const v = gets[i](f);
          // an empty operand contributes '' (section 8.7)
          s += v === EMPTY ? '' : castString(v, paths[i]);
        }
        return s;
      };
    },
  },

  '$string-join': {
    params: ARGS_1_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const seqGet = gets[0];
      const seqPath = args[0].docPath;
      const sepGet = gets.length === 2 ? gets[1] : null;
      const sepPath = sepGet === null ? '' : args[1].docPath;
      return (f) => {
        const v = seqGet(f);
        const sep = sepGet === null ? '' : stringArg(sepGet(f), sepPath);
        if (v === EMPTY)
          return '';
        if (!(v instanceof Seq)) // items cast per $string, like $concat
          return castString(v, seqPath);
        const items = v.items;
        let s = castString(items[0], seqPath);
        for (let i = 1; i < items.length; i++)
          s += sep + castString(items[i], seqPath);
        return s;
      };
    },
  },

  '$substring': {
    params: ARGS_2_3,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const sGet = gets[0];
      const sPath = args[0].docPath;
      const startGet = gets[1];
      const startPath = args[1].docPath;
      const lenGet = gets.length === 3 ? gets[2] : null;
      const lenPath = lenGet === null ? '' : args[2].docPath;
      return (f) => {
        const s = stringArg(sGet(f), sPath);
        // F&O fn:substring bounds (fn:round = Math.round), 0-based (D6):
        // code points at positions p with round(start) <= p, and
        // p < round(start) + round(len) when len is given. NaN bounds
        // satisfy no comparison and select nothing.
        const from = Math.round(numberArg(startGet(f), startPath));
        const to = lenGet === null ? Infinity : from + Math.round(numberArg(lenGet(f), lenPath));
        if (from !== from || to !== to) // a NaN bound selects nothing
          return '';
        if (from <= 0 && to === Infinity)
          return s;
        let out = '';
        let p = 0;
        for (const ch of s) {
          if (p >= to)
            break;
          if (p >= from)
            out += ch;
          p++;
        }
        return out;
      };
    },
  },

  '$contains': stringPairEntry((s, sub) => s.includes(sub)),
  '$starts-with': stringPairEntry((s, prefix) => s.startsWith(prefix)),
  '$ends-with': stringPairEntry((s, suffix) => s.endsWith(suffix)),

  '$upper': stringUnaryEntry((s) => s.toUpperCase()),
  '$lower': stringUnaryEntry((s) => s.toLowerCase()),
  '$string-length': stringUnaryEntry(countCodePoints),
  '$normalize-space': stringUnaryEntry(normalizeSpace),

  '$match': regexTestEntry(true),
  '$search': regexTestEntry(false),

  '$replace': {
    params: ARGS_3,
    result: RESULT_ONE,
    compile: compileReplace,
  },

  //#endregion

  //#region section 8.8 - aggregates
  // Aggregates see their operand sequence as-is: an array item is one
  // item - D4 unpacking is a $for/quantifier rule, not a sequence rule.

  '$count': {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets) => {
      const get = gets[0];
      return (f) => itemCount(get(f));
    },
  },

  '$sum': {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY) // $sum of the empty sequence is 0 (F&O)
          return 0;
        if (v instanceof Seq) {
          const items = v.items;
          let sum = 0;
          for (let i = 0; i < items.length; i++)
            sum += aggregateNumber(items[i], docPath);
          return sum;
        }
        return aggregateNumber(v, docPath);
      };
    },
  },

  '$avg': {
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY) // $avg of the empty sequence is empty (F&O)
          return EMPTY;
        if (v instanceof Seq) {
          const items = v.items;
          let sum = 0;
          for (let i = 0; i < items.length; i++)
            sum += aggregateNumber(items[i], docPath);
          return sum / items.length;
        }
        return aggregateNumber(v, docPath);
      };
    },
  },

  '$min': minmaxEntry(false),
  '$max': minmaxEntry(true),

  //#endregion

  //#region section 8.9 - sequence operators

  '$distinct': {
    params: UNARY,
    result: resultOfOperand,
    compile: (gets) => {
      const get = gets[0];
      return (f) => {
        const v = get(f);
        if (!(v instanceof Seq)) // zero or one item: already distinct
          return v;
        // deep equality via the grouping key relation (section 6.5):
        // NaN is one distinct value, -0 deduplicates with 0
        const items = v.items;
        const seen = new Set();
        const out = [];
        for (let i = 0; i < items.length; i++) {
          const key = stableKeyString(items[i]);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(items[i]);
          }
        }
        return seqOf(out);
      };
    },
  },

  '$reverse': {
    params: UNARY,
    result: resultOfOperand,
    compile: (gets) => {
      const get = gets[0];
      return (f) => {
        const v = get(f);
        if (!(v instanceof Seq))
          return v;
        const items = v.items;
        const out = new Array(items.length);
        for (let i = 0; i < items.length; i++)
          out[i] = items[items.length - 1 - i];
        return seqOf(out);
      };
    },
  },

  '$sort': {
    params: UNARY,
    result: resultOfOperand,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        if (!(v instanceof Seq)) {
          const t = typeof v;
          if (t !== 'number' && t !== 'string')
            throw sortError(v, docPath);
          return v;
        }
        const items = v.items;
        const numeric = typeof items[0] === 'number';
        const expected = numeric ? 'number' : 'string';
        for (let i = 0; i < items.length; i++) {
          if (typeof items[i] !== expected)
            throw sortError(items[i], docPath);
        }
        const out = items.slice();
        out.sort(numeric ? compareNumberKeys : compareCodePoints); // stable
        return seqOf(out);
      };
    },
  },

  '$head': {
    params: UNARY,
    result: (cards) => (cards[0] === CARD_MANY ? CARD_OPT : cards[0]),
    compile: (gets) => {
      const get = gets[0];
      return (f) => firstItem(get(f));
    },
  },

  '$tail': {
    params: UNARY,
    result: (cards) => (cards[0] === CARD_MANY ? CARD_MANY : CARD_ZERO),
    compile: (gets) => {
      const get = gets[0];
      return (f) => {
        const v = get(f);
        if (!(v instanceof Seq)) // zero or one item: nothing after the head
          return EMPTY;
        return seqOf(v.items.slice(1));
      };
    },
  },

  '$subsequence': {
    params: ARGS_2_3,
    result: (cards) => (cards[0] === CARD_MANY ? CARD_MANY : (cards[0] === CARD_ZERO ? CARD_ZERO : CARD_OPT)),
    compile: (gets, args) => {
      const seqGet = gets[0];
      const startGet = gets[1];
      const startPath = args[1].docPath;
      const lenGet = gets.length === 3 ? gets[2] : null;
      const lenPath = lenGet === null ? '' : args[2].docPath;
      return (f) => {
        const v = seqGet(f);
        // same F&O bounds as $substring, over item positions (D6)
        const from = Math.round(numberArg(startGet(f), startPath));
        const to = lenGet === null ? Infinity : from + Math.round(numberArg(lenGet(f), lenPath));
        if (v === EMPTY || from !== from || to !== to)
          return EMPTY;
        if (!(v instanceof Seq))
          return (from <= 0 && to > 0) ? v : EMPTY;
        const items = v.items;
        const lo = from > 0 ? from : 0;
        const hi = to < items.length ? to : items.length;
        if (lo >= hi)
          return EMPTY;
        return seqOf(items.slice(lo, hi));
      };
    },
  },

  '$index-of': {
    params: ARGS_2,
    result: (cards) => (cards[0] === CARD_MANY ? CARD_MANY : (cards[0] === CARD_ZERO ? CARD_ZERO : CARD_OPT)),
    compile: (gets, args) => {
      const seqGet = gets[0];
      const itemGet = gets[1];
      const itemPath = args[1].docPath;
      return (f) => {
        const v = seqGet(f);
        const target = itemGet(f);
        if (target === EMPTY || target instanceof Seq)
          throw runtimeError('JQ2001',
            `'$index-of' takes a single search item, got ${describeItem(target)}`, itemPath);
        // deep equality per D2 (the $eq relation: NaN matches nothing),
        // 0-based positions (D6)
        if (v === EMPTY)
          return EMPTY;
        if (!(v instanceof Seq))
          return equalsJson(v, target) ? 0 : EMPTY;
        const items = v.items;
        const out = [];
        for (let i = 0; i < items.length; i++) {
          if (equalsJson(items[i], target))
            out.push(i);
        }
        return seqOf(out);
      };
    },
  },

  '$range': {
    params: ARGS_2,
    result: RESULT_MANY,
    compile: (gets, args, docPath) => {
      const fromGet = gets[0];
      const fromPath = args[0].docPath;
      const toGet = gets[1];
      const toPath = args[1].docPath;
      return (f) => {
        const a = fromGet(f);
        const b = toGet(f);
        if (a === EMPTY || b === EMPTY) // XQuery `to`: empty operand, empty range
          return EMPTY;
        if (typeof a !== 'number' || !Number.isInteger(a))
          throw rangeBoundError(a, fromPath);
        if (typeof b !== 'number' || !Number.isInteger(b))
          throw rangeBoundError(b, toPath);
        if (a > b)
          return EMPTY;
        const n = b - a + 1;
        if (n > RANGE_LIMIT)
          throw runtimeError('JQ2007', `'$range' of ${n} items exceeds the 2^32-item resource guard`, docPath);
        const out = new Array(n);
        for (let i = 0; i < n; i++)
          out[i] = a + i;
        return seqOf(out);
      };
    },
  },

  '$get': {
    params: ARGS_2,
    result: RESULT_OPT,
    compile: (gets) => {
      const targetGet = gets[0];
      const keyGet = gets[1];
      // the dynamic counterpart of path leaves: object + string key,
      // array + integer index (negative counts from the end, like the
      // RFC 9535 index selector); anything else is simply empty
      return (f) => {
        const target = targetGet(f);
        const key = keyGet(f);
        if (target === EMPTY || target instanceof Seq || key === EMPTY || key instanceof Seq)
          return EMPTY;
        if (typeof key === 'string') {
          if (typeof target !== 'object' || target === null || Array.isArray(target))
            return EMPTY;
          return hasOwn(target, key) ? target[key] : EMPTY;
        }
        if (typeof key === 'number' && Array.isArray(target) && Number.isInteger(key)) {
          const idx = key < 0 ? target.length + key : key;
          return (idx >= 0 && idx < target.length) ? target[idx] : EMPTY;
        }
        return EMPTY;
      };
    },
  },

  //#endregion

  //#region section 8.10 - types and casts

  '$is-string': isTypeEntry((v) => typeof v === 'string'),
  '$is-number': isTypeEntry((v) => typeof v === 'number'),
  '$is-boolean': isTypeEntry((v) => typeof v === 'boolean'),
  '$is-null': isTypeEntry((v) => v === null),
  '$is-array': isTypeEntry(Array.isArray),
  '$is-object': isTypeEntry((v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Seq)),

  '$string': {
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        return v === EMPTY ? EMPTY : castString(v, docPath);
      };
    },
  },

  '$number': {
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        return v === EMPTY ? EMPTY : castNumber(v, docPath);
      };
    },
  },

  '$boolean': { // the EBV as an operator: a 2+ item operand is JQ2003
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => ebv(get(f), docPath);
    },
  },

  '$coalesce': {
    params: ARGS_1N,
    result: coalesceCard,
    compile: compileCoalesce,
  },

  '$default': { // sugar for $coalesce of exactly two
    params: ARGS_2,
    result: coalesceCard,
    compile: compileCoalesce,
  },

  //#endregion
});

// singleton type predicates (section 8.10): true iff the operand is one
// item of the type - the empty sequence and 2+ item sequences are false,
// not errors (EMPTY is a symbol and Seq is excluded per test)
function isTypeEntry(test) {
  return {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets) => {
      const get = gets[0];
      return (f) => test(get(f));
    },
  };
}

// $coalesce cardinality: operands past the first CARD_ONE one are never
// reached, statically empty operands contribute nothing
function coalesceCard(cards) {
  let seen = false;
  let many = false;
  let terminal = false;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (c === CARD_ZERO)
      continue;
    seen = true;
    if (c === CARD_MANY)
      many = true;
    if (c === CARD_ONE) {
      terminal = true;
      break;
    }
  }
  if (!seen)
    return CARD_ZERO;
  if (many)
    return CARD_MANY;
  return terminal ? CARD_ONE : CARD_OPT;
}

// first operand whose result is non-empty, lazily: operands after it are
// not evaluated and cannot raise errors
function compileCoalesce(gets) {
  if (gets.length === 1)
    return gets[0];
  const flen = gets.length;
  return (f) => {
    for (let i = 0; i < flen; i++) {
      const v = gets[i](f);
      if (v !== EMPTY)
        return v;
    }
    return EMPTY;
  };
}

//#endregion

//#endregion
