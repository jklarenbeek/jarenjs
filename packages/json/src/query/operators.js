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
//     ordinary expression), 'raw' (a verbatim JSON value, not evaluated),
//     'schema' (a verbatim JSON Schema literal, compiled at query compile
//     time into an item predicate at `args[i].test` - the schema
//     arguments of $valid/$assert) or
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

import { equalsJson, compareJsonScalarLt } from '@jarenjs/core/object';
import { countCodePoints, compareCodePoints } from '@jarenjs/core/string';
import { compileIRegexp } from '@jarenjs/core/text/iregexp';
import {
  parseRFC3339Parts,
  epochOfRFC3339Parts,
  formatRFC3339Parts,
  partsFromEpoch,
  isDateOnlyRFC3339,
  isTimeOnlyRFC3339,
  isDateTimeRFC3339,
  isValidDuration,
  isDateUnit,
  addToParts,
  startOfParts,
  endOfParts,
  parseDuration,
  addDuration,
  monthsBetween,
  daysFromCivil,
  isoWeekOfYear,
  isoWeekdayFromDays,
  quarterOfYear,
  fixedUnitMs,
  compileDateFormat,
} from '@jarenjs/core/dates';
import {
  isPosition,
  bboxOf,
  bboxIntersects,
  bboxPolygon,
  geometryArea,
  geometryLength,
  centroidOf,
  containsPosition,
  geoDistance,
  geohashEncode,
  geohashBounds,
  geohashNeighbours,
  wktToGeoJson,
  geoJsonToWkt,
  simplifyGeometry,
} from '@jarenjs/core/geo';
import { JsonQueryCompileError, JsonQueryRuntimeError } from './errors.js';
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
// the schema operators $valid/$assert: [expr, schema] (section 8.11)
const ARGS_EXPR_SCHEMA = Object.freeze({ kinds: Object.freeze(['expr', 'schema']), min: 2 });

const RESULT_ONE = () => CARD_ONE;
const RESULT_OPT = () => CARD_OPT;
const RESULT_MANY = () => CARD_MANY;
// the operand's cardinality is preserved ($distinct, $reverse, $sort)
const resultOfOperand = (cards) => cards[0];
// a singleton operand stays a singleton; anything else may come out empty
const resultEmptyPropagates = (cards) => (cards[0] === CARD_ONE ? CARD_ONE : CARD_OPT);

// Static result-type declarations for `annotateTypes` (QUERY-FORMAT.md
// Appendix C.8): `resultType(argTypes)` returns a tag name from the
// closed lattice, or null for unknown. Declared only for the
// comparison, arithmetic, string and aggregate families, and only where
// the answer is certain — a wrong tag is a defect, `unknown` never is.
const RT_BOOLEAN = () => 'boolean';
const RT_NUMBER = () => 'number';
const RT_INTEGER = () => 'integer';
const RT_STRING = () => 'string';
// $min/$max keep their operand family: numbers yield a number, strings
// a string, anything else stays unknown (mixed input is JQ2001 anyway).
const RT_MINMAX = (types) => {
  const t = types[0].type;
  if (t === 'number' || t === 'integer') return 'number';
  return t === 'string' ? 'string' : null;
};

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
  return compareJsonScalarLt(a, b);
}
function itemLe(a, b) {
  return compareJsonScalarLt(a, b, true);
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
    resultType: RT_BOOLEAN,
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
function arithmeticEntry(makeApply, resultType = RT_NUMBER) {
  return {
    params: ARGS_2,
    result: (cards) => (cards[0] === CARD_ONE && cards[1] === CARD_ONE ? CARD_ONE : CARD_OPT),
    resultType,
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
function stringUnaryEntry(apply, resultType = RT_STRING) {
  return {
    params: UNARY,
    result: RESULT_ONE,
    resultType,
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
    resultType: RT_BOOLEAN,
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
    resultType: RT_BOOLEAN,
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
    resultType: RT_MINMAX,
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

/**
 * Check one evaluated `$range` bound. Shared with the compiler's
 * iteration fast path (compile.js), so a range that is iterated rather
 * than materialized still rejects exactly the same bounds.
 * @param {any} v - an evaluated bound
 * @param {string} docPath - the bound's document pointer
 * @returns {number} the bound
 * @throws {JsonQueryRuntimeError} JQ2001 when it is not an integer
 */
export function checkRangeBound(v, docPath) {
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw rangeBoundError(v, docPath);
  return v;
}

// the resource guard of $range (section 10.3, JQ2007)
const RANGE_LIMIT = 4294967296; // 2^32

//#endregion

//#region date and time operators (section 8.13)
// Dates are RFC 3339 strings - JSON has no date type - and every operator
// here is a pure function of its operand: there is deliberately no
// `current-dateTime`, because a query must give the same answer for the
// same input document forever (it is cached by document identity, saved
// as a rule, and used as a validation keyword).
//
// Components are read LEXICALLY, in the value's own offset, which is
// what `fn:year-from-dateTime` returns and what grouping by year or
// month means. Cross-offset comparison and arithmetic go through
// `$epoch`, which is the one place a value is shifted to UTC.

// a single RFC 3339 operand, decomposed (JQ2001 on anything else)
function dateParts(v, docPath) {
  const parts = parseRFC3339Parts(v);
  if (parts === null) {
    // a malformed string is the common case here, so show it rather than
    // reporting the useless fact that it was a string
    throw runtimeError('JQ2001', 'expected an RFC 3339 date, time, or date-time string, got '
      + (typeof v === 'string' ? JSON.stringify(v) : describeItem(v)), docPath);
  }
  return parts;
}

// a lexical component operator: empty propagates, a value whose half is
// missing (asking a full-date for its hours) is JQ2001
function dateComponentEntry(pick, half) {
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
        const n = pick(dateParts(v, docPath));
        if (n < 0)
          throw runtimeError('JQ2001', `'${v}' carries no ${half} component`, docPath);
        return n;
      };
    },
  };
}

// A calendar unit argument. Units are data, not vocabulary, so a bad one
// is a runtime JQ2001 rather than a compile error - the same treatment
// `$orderby`'s registered collation names get.
function unitArg(v, docPath) {
  if (!isDateUnit(v)) {
    throw runtimeError('JQ2001',
      `expected a calendar unit ('year', 'month', 'day', ...), got ${describeItem(v)}`, docPath);
  }
  return v;
}

// The shared shape of $date-add / $date-sub: [date, duration] applies an
// ISO 8601 duration, [date, amount, unit] applies one unit. Both return
// the same lexical form they were given, so a full-date stays a
// full-date - a query that buckets dates should not silently start
// producing date-times.
function dateShiftEntry(sign) {
  return {
    params: ARGS_2_3,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const dateGet = gets[0];
      const datePath = args[0].docPath;
      const secondGet = gets[1];
      const secondPath = args[1].docPath;
      const unitGet = gets.length === 3 ? gets[2] : null;
      const unitPath = unitGet === null ? '' : args[2].docPath;
      return (f) => {
        const value = dateGet(f);
        if (value === EMPTY)
          return EMPTY;
        const parts = dateParts(value, datePath);
        const second = secondGet(f);
        if (second === EMPTY)
          return EMPTY;
        if (unitGet === null) {
          const duration = parseDuration(second);
          if (duration === null) {
            throw runtimeError('JQ2001', 'expected an ISO 8601 duration, got '
              + (typeof second === 'string' ? JSON.stringify(second) : describeItem(second)),
            secondPath);
          }
          return formatRFC3339Parts(addDuration(parts, duration, sign));
        }
        if (typeof second !== 'number')
          throw runtimeError('JQ2001', `expected a number of units, got ${describeItem(second)}`, secondPath);
        const unit = unitArg(unitGet(f), unitPath);
        return formatRFC3339Parts(addToParts(parts, sign * second, unit));
      };
    },
  };
}

// $start-of / $end-of: truncate to a calendar unit, keeping the lexical
// form. A full-date's end of month is that month's last day, not its
// last millisecond - there is nowhere in a full-date to put one.
function dateTruncEntry(truncate) {
  return {
    params: ARGS_2,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const dateGet = gets[0];
      const datePath = args[0].docPath;
      const unitGet = gets[1];
      const unitPath = args[1].docPath;
      return (f) => {
        const value = dateGet(f);
        if (value === EMPTY)
          return EMPTY;
        const parts = dateParts(value, datePath);
        return formatRFC3339Parts(truncate(parts, unitArg(unitGet(f), unitPath)));
      };
    },
  };
}

//#region spatial operators (section 8.14)
// PostGIS's ST_* set, in the vocabulary this language already has. The
// operand is GeoJSON (RFC 7946) — a bare position, a geometry, a Feature
// or a FeatureCollection — because that is what a JSON document holds;
// there is no geometry type to construct first.
//
// Coordinates are longitude, latitude, in WGS 84 decimal degrees, and
// measurements are geodesic. That matters: a degree of longitude is not
// a fixed distance, so a planar answer is wrong by two thirds at Dutch
// latitudes. These operators never return a planar number.
//
// What is deliberately absent is real geometry-to-geometry intersection.
// `$bbox-intersects` says exactly what it tests, because an operator
// named `$intersects` that only compared bounding boxes would be a lie
// the first time two L-shapes shared a box and nothing else. So is any
// operator producing a PROJECTED coordinate: a projected position is
// the same `[x, y]` array as a geographic one, so a language that could
// make one could not stop it reaching `$distance`. Leaving it out makes
// "never measure on a projected coordinate" structural instead of
// advisory; `projectMercator` stays a kernel export for renderers.
//
// The conversion members carry geography in and out of the forms the
// rest of the world uses — Well-Known Text, geohash cells — and reduce
// a value for storage. Each is a call into the kernel and nothing else:
// the grammar, the cell arithmetic and Douglas-Peucker each exist once.

// A spatial operand, rejected uniformly: the empty sequence propagates
// at the call site, so this only ever sees a real item.
function geoArg(v, docPath) {
  if (v === EMPTY || v instanceof Seq || v === null || typeof v !== 'object') {
    throw runtimeError('JQ2001',
      `expected a GeoJSON value or a [longitude, latitude] position, got ${describeItem(v)}`,
      docPath);
  }
  return v;
}

// A cell string operand — the geohash family and `$geo-parse` take text
// where the rest of the family takes a value.
function geoTextArg(v, what, docPath) {
  if (typeof v !== 'string') {
    throw runtimeError('JQ2001',
      `expected ${what}, got ${describeItem(v)}`, docPath);
  }
  return v;
}

// The family's non-finite rule, in one place. A coordinate that is not a
// finite number has no measurement, and every kernel function that
// touches one launders it into something plausible: `haversineDistance`
// answers the antipodal distance, a NaN area compares false against zero
// and reports 0. A representative-position operator checks the one
// position it uses; an aggregate measurement has to know that EVERY
// position is finite, and `centroidOf` is the kernel walk that already
// answers it — NaN propagates through the mean, and a null mean is "no
// positions at all", which still measures (as zero) rather than being
// refused. No second finiteness walk exists.
function finitePosition(at) {
  return at !== null && Number.isFinite(at[0]) && Number.isFinite(at[1]) ? at : null;
}

function geoFinite(value) {
  const at = centroidOf(value);
  return at === null || finitePosition(at) !== null;
}

// the representative position §8.14 measures a value by: a bare position
// is itself, anything else is its centroid
function representative(value) {
  return finitePosition(isPosition(value) ? value : centroidOf(value));
}

// a unary spatial measurement: empty propagates, anything else is JQ2001
function geoUnaryEntry(measure, resultCard = resultEmptyPropagates, check = geoArg) {
  return {
    params: UNARY,
    result: resultCard,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        const out = measure(check(v, docPath));
        return out === null ? EMPTY : out;
      };
    },
  };
}

//#endregion

// the RFC 3339 type tests, shaped like the section 8.10 $is-* family:
// one item of the right lexical form, never an error
function dateTestEntry(test) {
  return {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets) => {
      const get = gets[0];
      return (f) => test(get(f));
    },
  };
}

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
  }, RT_INTEGER),
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
    resultType: RT_STRING,
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
    resultType: RT_STRING,
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
    resultType: RT_STRING,
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
  '$string-length': stringUnaryEntry(countCodePoints, RT_INTEGER),
  '$normalize-space': stringUnaryEntry(normalizeSpace),

  '$match': regexTestEntry(true),
  '$search': regexTestEntry(false),

  '$replace': {
    params: ARGS_3,
    result: RESULT_ONE,
    resultType: RT_STRING,
    compile: compileReplace,
  },

  //#endregion

  //#region section 8.8 - aggregates
  // Aggregates see their operand sequence as-is: an array item is one
  // item - D4 unpacking is a $for/quantifier rule, not a sequence rule.

  '$count': {
    params: UNARY,
    result: RESULT_ONE,
    resultType: RT_INTEGER,
    compile: (gets) => {
      const get = gets[0];
      return (f) => itemCount(get(f));
    },
  },

  '$sum': {
    params: UNARY,
    result: RESULT_ONE,
    resultType: RT_NUMBER,
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
    resultType: RT_NUMBER,
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
    compile: (gets, args, docPath, node) => {
      const fromGet = gets[0];
      const fromPath = args[0].docPath;
      const toGet = gets[1];
      const toPath = args[1].docPath;
      // the compilation's limits.sequenceItems tightens the resource
      // guard below its 2^32 ceiling
      const cap = node !== undefined && node.limits != null && node.limits.sequenceItems !== null
        ? Math.min(node.limits.sequenceItems, RANGE_LIMIT)
        : RANGE_LIMIT;
      return (f) => {
        const a = fromGet(f);
        const b = toGet(f);
        if (a === EMPTY || b === EMPTY) // XQuery `to`: empty operand, empty range
          return EMPTY;
        checkRangeBound(a, fromPath);
        checkRangeBound(b, toPath);
        if (a > b)
          return EMPTY;
        const n = b - a + 1;
        if (n > cap)
          throw runtimeError('JQ2007', `'$range' of ${n} items exceeds the ${cap === RANGE_LIMIT ? '2^32-item' : String(cap) + '-item'} resource guard`, docPath);
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

  '$entries': {
    params: UNARY,
    result: RESULT_MANY,
    compile: (gets) => {
      const get = gets[0];
      // the member-pair counterpart of `[*]` (which yields values only):
      // each OBJECT item contributes one `{ "key": name, "value": v }`
      // per member, in member order; non-object items contribute
      // nothing, like every other type mismatch in this family
      return (f) => {
        const v = get(f);
        const items = v instanceof Seq ? v.items : (v === EMPTY ? [] : [v]);
        const out = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
          for (const key of Object.keys(item))
            out.push({ key, value: item[key] });
        }
        return seqOf(out);
      };
    },
  },

  '$from-entries': {
    params: UNARY,
    result: RESULT_ONE,
    compile: (gets) => {
      const get = gets[0];
      // the inverse of $entries: assemble one object from
      // `{ "key": name, "value": v }` items, in sequence order. Later
      // pairs win on duplicate keys, like the $map constructor; items
      // without a string `key` contribute nothing; a missing `value`
      // member reads as null (undefined is not a JSON value)
      return (f) => {
        const v = get(f);
        const items = v instanceof Seq ? v.items : (v === EMPTY ? [] : [v]);
        /** @type {Record<string, any>} */
        const out = {};
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (typeof item !== 'object' || item === null || Array.isArray(item))
            continue;
          if (typeof item.key !== 'string')
            continue;
          out[item.key] = hasOwn(item, 'value') ? item.value : null;
        }
        return out;
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

  //#region section 8.11 - schema operators
  // JSON Schema as the type system: the schema argument is a verbatim
  // literal ('schema' kind), compiled once at query compile time into the
  // predicate at `args[1].test` by the host's compileTypeTest hook
  // (JQ0008 without one). Validation is per ITEM of the operand's result
  // sequence - the schema sees items, never the sequence itself.

  '$valid': {
    params: ARGS_EXPR_SCHEMA,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const get = gets[0];
      const test = args[1].test;
      if (args[0].card === CARD_ONE)
        return (f) => test(get(f));
      return (f) => {
        const v = get(f);
        if (v === EMPTY) // vacuously true, like $every
          return true;
        if (v instanceof Seq) {
          const items = v.items;
          for (let i = 0; i < items.length; i++) {
            if (!test(items[i]))
              return false;
          }
          return true;
        }
        return test(v);
      };
    },
  },

  '$assert': {
    params: ARGS_EXPR_SCHEMA,
    result: resultOfOperand,
    compile: (gets, args, docPath) => {
      const get = gets[0];
      const test = args[1].test;
      if (args[0].card === CARD_ONE) {
        return (f) => {
          const v = get(f);
          if (!test(v))
            throw runtimeError('JQ2008', `'$assert' failed: ${describeItem(v)} does not satisfy the schema`, docPath);
          return v;
        };
      }
      return (f) => {
        const v = get(f);
        if (v === EMPTY) // no items, nothing to fail
          return v;
        if (v instanceof Seq) {
          const items = v.items;
          for (let i = 0; i < items.length; i++) {
            if (!test(items[i]))
              throw runtimeError('JQ2008', `'$assert' failed: item ${i} (${describeItem(items[i])}) does not satisfy the schema`, docPath);
          }
          return v;
        }
        if (!test(v))
          throw runtimeError('JQ2008', `'$assert' failed: ${describeItem(v)} does not satisfy the schema`, docPath);
        return v;
      };
    },
  },

  //#endregion

  //#region section 8.13 - dates and times

  '$is-date': dateTestEntry(isDateOnlyRFC3339),
  '$is-time': dateTestEntry(isTimeOnlyRFC3339),
  '$is-datetime': dateTestEntry(isDateTimeRFC3339),
  '$is-duration': dateTestEntry(isValidDuration),

  //#endregion

  //#region section 8.14 - spatial

  '$bbox': geoUnaryEntry(bboxOf),
  // RESULT_OPT, not RESULT_ONE: an aggregate measurement over a value
  // carrying a non-finite coordinate is empty, not a plausible number
  '$area': geoUnaryEntry((v) => (geoFinite(v) ? geometryArea(v) : null), RESULT_OPT),
  '$length': geoUnaryEntry((v) => (geoFinite(v) ? geometryLength(v) : null), RESULT_OPT),
  '$centroid': geoUnaryEntry((v) => finitePosition(centroidOf(v))),

  '$distance': { // metres between two values' representative positions
    params: ARGS_2,
    result: RESULT_OPT,
    compile: (gets, args) => {
      const aGet = gets[0];
      const aPath = args[0].docPath;
      const bGet = gets[1];
      const bPath = args[1].docPath;
      return (f) => {
        const a = aGet(f);
        const b = bGet(f);
        if (a === EMPTY || b === EMPTY)
          return EMPTY;
        const pa = representative(geoArg(a, aPath));
        const pb = representative(geoArg(b, bPath));
        if (pa === null || pb === null)
          return EMPTY;
        const out = geoDistance(pa, pb);
        return out === null ? EMPTY : out;
      };
    },
  },

  '$within': { // is the first value's position inside the second's surface
    params: ARGS_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const pointGet = gets[0];
      const pointPath = args[0].docPath;
      const areaGet = gets[1];
      const areaPath = args[1].docPath;
      return (f) => {
        const point = pointGet(f);
        const area = areaGet(f);
        if (point === EMPTY || area === EMPTY)
          return false; // nothing is inside nothing
        // a bare position is itself; anything else is represented by its
        // centroid, the same rule $distance uses
        const at = representative(geoArg(point, pointPath));
        const surface = geoArg(area, areaPath);
        // a predicate answers its missing-operand value, not empty: the
        // surface has to be bounded too, or a NaN vertex makes an
        // even-odd crossing count report containment that is not there
        if (at === null || !geoFinite(surface))
          return false;
        return containsPosition(surface, at[0], at[1]);
      };
    },
  },

  '$bbox-intersects': { // do the two values' bounding boxes overlap
    params: ARGS_2,
    result: RESULT_ONE,
    compile: (gets, args) => {
      const aGet = gets[0];
      const aPath = args[0].docPath;
      const bGet = gets[1];
      const bPath = args[1].docPath;
      return (f) => {
        const a = aGet(f);
        const b = bGet(f);
        if (a === EMPTY || b === EMPTY)
          return false;
        const boxA = bboxOf(geoArg(a, aPath));
        const boxB = bboxOf(geoArg(b, bPath));
        return boxA !== null && boxB !== null && bboxIntersects(boxA, boxB);
      };
    },
  },

  '$geohash': { // a position as a base-32 cell string
    params: ARGS_1_2,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      const precisionGet = gets.length === 2 ? gets[1] : null;
      const precisionPath = precisionGet === null ? '' : args[1].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        const at = representative(geoArg(v, docPath));
        if (at === null)
          return EMPTY;
        let precision = 9;
        if (precisionGet !== null) {
          precision = precisionGet(f);
          if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
            throw runtimeError('JQ2001',
              `a geohash precision must be an integer from 1 to 12, got ${describeItem(precision)}`,
              precisionPath);
          }
        }
        return geohashEncode(at[0], at[1], precision);
      };
    },
  },

  // -- conversion: geography in and out of the forms the world uses --

  // Well-Known Text is what PostGIS, SpatiaLite, GEOS, JTS and every
  // `ST_AsText` emit, so without these a document can only carry such a
  // string through untouched. Text that is not well-formed WKT is empty
  // rather than an error, like every other "nothing to answer" here.
  '$geo-parse': geoUnaryEntry(wktToGeoJson, resultEmptyPropagates,
    (v, docPath) => geoTextArg(v, 'a Well-Known Text string', docPath)),

  // A value with no WKT spelling — a non-finite coordinate — is empty,
  // never written approximately.
  '$geo-text': geoUnaryEntry(geoJsonToWkt),

  '$geohash-bounds': geoUnaryEntry(
    (hash) => bboxPolygon(geohashBounds(hash)), resultEmptyPropagates,
    (v, docPath) => geoTextArg(v, 'a geohash cell string', docPath)),

  // The neighbourhood, not the cell: two points metres apart can sit in
  // different cells, so a proximity probe tests the nine cells and a
  // single prefix is bucketing. The cells come in reading order — north
  // -west first, the cell itself in the middle; cells past a pole do
  // not exist and are absent, so the sequence can be shorter.
  '$geohash-neighbours': {
    params: UNARY,
    result: RESULT_MANY,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        return seqOf(geohashNeighbours(geoTextArg(v, 'a geohash cell string', docPath)));
      };
    },
  },

  // Reduction for STORAGE and TRANSPORT: the same value with vertices
  // dropped, still valid GeoJSON a caller can keep or send. The chart
  // layer simplifies too, but only into its own drawing space, so
  // nothing there hands a document back.
  '$geo-simplify': {
    params: ARGS_2,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const valueGet = gets[0];
      const valuePath = args[0].docPath;
      const toleranceGet = gets[1];
      const tolerancePath = args[1].docPath;
      return (f) => {
        const v = valueGet(f);
        const tolerance = toleranceGet(f);
        if (v === EMPTY || tolerance === EMPTY)
          return EMPTY;
        // degrees, not metres: a planar vertex-dropping threshold. A
        // degree of longitude is not a fixed distance, so naming it a
        // distance is the confusion this family exists to prevent.
        if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
          throw runtimeError('JQ2001',
            `a simplification tolerance is a non-negative number of degrees, got ${describeItem(tolerance)}`,
            tolerancePath);
        }
        return simplifyGeometry(geoArg(v, valuePath), tolerance);
      };
    },
  },

  //#endregion

  //#region section 8.13 - dates and times, continued

  '$date-add': dateShiftEntry(1),
  '$date-sub': dateShiftEntry(-1),
  '$start-of': dateTruncEntry(startOfParts),
  '$end-of': dateTruncEntry(endOfParts),

  '$date-diff': { // whole units from the first date to the second
    params: ARGS_3,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const fromGet = gets[0];
      const fromPath = args[0].docPath;
      const toGet = gets[1];
      const toPath = args[1].docPath;
      const unitGet = gets[2];
      const unitPath = args[2].docPath;
      return (f) => {
        const fromValue = fromGet(f);
        const toValue = toGet(f);
        if (fromValue === EMPTY || toValue === EMPTY)
          return EMPTY;
        const from = dateParts(fromValue, fromPath);
        const to = dateParts(toValue, toPath);
        const unit = unitArg(unitGet(f), unitPath);
        // months, quarters and years have no fixed width, so they are
        // counted on the calendar; everything else divides an exact span
        if (unit === 'month' || unit === 'quarter' || unit === 'year') {
          const months = monthsBetween(from, to);
          return unit === 'month' ? months
            : Math.trunc(months / (unit === 'quarter' ? 3 : 12));
        }
        const fromMs = epochOfRFC3339Parts(from);
        const toMs = epochOfRFC3339Parts(to);
        if (fromMs !== fromMs || toMs !== toMs)
          throw runtimeError('JQ2001', 'cannot measure a span from a value with no date', fromPath);
        return Math.trunc((toMs - fromMs) / fixedUnitMs(unit));
      };
    },
  },

  '$date-format': { // an LDML pattern, compiled once when it is literal
    params: ARGS_2,
    result: resultEmptyPropagates,
    compile: (gets, args, docPath) => {
      const dateGet = gets[0];
      const datePath = args[0].docPath;
      const patternNode = args[1];
      // the common case is a literal pattern: compile it at query
      // compile time, so a bad one is a compile error, not a surprise
      if (patternNode.kind === 'literal' && typeof patternNode.value === 'string') {
        let format;
        try {
          format = compileDateFormat(patternNode.value);
        }
        catch (e) {
          // a literal pattern is authored, not data: reject the document
          throw new JsonQueryCompileError('JQ0003',
            `'$date-format' pattern: ${e instanceof Error ? e.message : 'invalid'}`,
            docPath, { cause: e });
        }
        return (f) => {
          const v = dateGet(f);
          return v === EMPTY ? EMPTY : format(dateParts(v, datePath));
        };
      }
      // a dynamic pattern gets the monomorphic per-callsite cache the
      // regex operators use: a filter almost always sees one pattern
      const patternGet = gets[1];
      const patternPath = patternNode.docPath;
      let lastPattern = null;
      let lastFormat = null;
      return (f) => {
        const v = dateGet(f);
        if (v === EMPTY)
          return EMPTY;
        const pattern = patternGet(f);
        if (typeof pattern !== 'string')
          throw runtimeError('JQ2001', `expected a date pattern, got ${describeItem(pattern)}`, patternPath);
        if (pattern !== lastPattern) {
          lastPattern = pattern;
          try {
            lastFormat = compileDateFormat(pattern);
          }
          catch (e) {
            lastFormat = null;
            throw runtimeError('JQ2001',
              `'$date-format' pattern: ${e instanceof Error ? e.message : 'invalid'}`, patternPath);
          }
        }
        return lastFormat(dateParts(v, datePath));
      };
    },
  },

  '$week': dateComponentEntry(
    (p) => (p.year < 0 ? -1 : isoWeekOfYear(p).week), 'date'),
  '$week-year': dateComponentEntry(
    (p) => (p.year < 0 ? -1 : isoWeekOfYear(p).year), 'date'),
  '$quarter': dateComponentEntry(
    (p) => (p.year < 0 ? -1 : quarterOfYear(p)), 'date'),
  '$weekday': dateComponentEntry(
    (p) => (p.year < 0 ? -1 : isoWeekdayFromDays(daysFromCivil(p.year, p.month, p.day))), 'date'),

  '$year': dateComponentEntry((p) => p.year, 'date'),
  '$month': dateComponentEntry((p) => p.month, 'date'),
  '$day': dateComponentEntry((p) => p.day, 'date'),
  '$hours': dateComponentEntry((p) => p.hours, 'time'),
  '$minutes': dateComponentEntry((p) => p.minutes, 'time'),
  '$seconds': dateComponentEntry((p) => p.seconds, 'time'),

  '$offset': { // minutes east of UTC; a bare full-date carries none
    params: UNARY,
    result: RESULT_OPT,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        const offset = dateParts(v, docPath).offset;
        return offset === null ? EMPTY : offset;
      };
    },
  },

  '$epoch': { // the one shift to UTC: milliseconds since 1970-01-01Z
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        const ms = epochOfRFC3339Parts(dateParts(v, docPath));
        if (ms !== ms) // a full-time has no instant to place
          throw runtimeError('JQ2001', `'${v}' carries no date component`, docPath);
        return ms;
      };
    },
  },

  '$datetime': { // the inverse of $epoch, in canonical UTC form
    params: UNARY,
    result: resultEmptyPropagates,
    compile: (gets, args) => {
      const get = gets[0];
      const docPath = args[0].docPath;
      return (f) => {
        const v = get(f);
        if (v === EMPTY)
          return EMPTY;
        if (typeof v !== 'number')
          throw runtimeError('JQ2001',
            `'$datetime' takes epoch milliseconds, got ${describeItem(v)}`, docPath);
        // outside ±8.64e15 ms, and outside years 0000-9999, there is no
        // RFC 3339 spelling of the instant. Rendering goes through the
        // kernel like every other date operator, so one query cannot
        // emit two spellings of the same fraction.
        const iso = Number.isFinite(v) && Math.abs(v) <= 8.64e15
          ? formatRFC3339Parts(partsFromEpoch(v))
          : '';
        if (!isDateTimeRFC3339(iso))
          throw runtimeError('JQ2001', `${v} is outside the range RFC 3339 can spell`, docPath);
        return iso;
      };
    },
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
