//#region XQuery text front-end (XQUERY-FRONTEND.md)
// parseXQuery: a strict, single-pass recursive-descent parser (char-code
// level, the path.js discipline) for a defined subset of XQuery 3.1 text
// syntax, emitting Jaren JSON Query documents (QUERY-FORMAT.md). This is
// a front-end only: the JSON query document stays the canonical language
// and compileJsonQuery the only engine - the parser never evaluates
// anything and never emits an invalid document.
//
// Everything outside the subset fails with a named, positioned
// XQuerySyntaxError. The `unsupported ...` message prefixes are the
// classification signal for compliance tooling (the QT3 harness) - keep
// them stable:
//
//   - `unsupported construct '<name>'`  - a recognized XQuery construct
//     outside the subset (instance of, path expressions, typeswitch, ...)
//   - `unsupported function '<name>'` / `'<name>#<arity>'` - a function
//     (or an arity of one) outside the mapping tables (fn:, xs:, map:, array:)
//   - `unsupported clause order: ...` - a FLWOR clause sequence that
//     cannot be expressed by mechanically nesting phrases (section below)
//   - `unsupported variable name '<name>'` / `unsupported lookup index 0`
//
// 1-based/0-based rule (D6, documented in XQUERY-FRONTEND.md): positional
// *inputs* are adjusted at parse time so XQuery text means what it says
// (`?N` lookups, substring/subsequence starts, array:get indexes emit
// N-1); fn:index-of results are shifted to 1-based in the emission; the
// positional *bindings* keep the JSON format's 0-based convention
// (`at $i`, `count $c`).

//#region imports & shared tables

import {
  CC_TAB,
  CC_LF,
  CC_CR,
  CC_SPACE,
  CC_BANG,
  CC_DQUOTE,
  CC_DOLLAR,
  CC_HASH,
  CC_PERCENT,
  CC_AMP,
  CC_SQUOTE,
  CC_LPAREN,
  CC_RPAREN,
  CC_STAR,
  CC_PLUS,
  CC_COMMA,
  CC_MINUS,
  CC_DOT,
  CC_SLASH,
  CC_COLON,
  CC_SEMICOLON,
  CC_LT,
  CC_EQ,
  CC_GT,
  CC_QUESTION,
  CC_AT,
  CC_LBRACKET,
  CC_RBRACKET,
  CC_LBRACE,
  CC_PIPE,
  CC_RBRACE,
  isDigitCode,
  isNameStartCode,
  isNameCharCode,
} from '@jarenjs/core/scan';

import { civilFromDays, daysFromCivil, daysInMonth } from '@jarenjs/core/dates';
import { setObjectMember } from '@jarenjs/core/object';
import { LabeledSyntaxError, NESTING_CEILING } from '../errors.js';
import { DEFAULT_DECIMAL_FORMAT, FormatRefusal, compilePicture } from '../query/format-number.js';

const CC_BACKTICK = 0x60;

const hasOwn = Object.hasOwn;

/**
 * Error thrown when XQuery text is not valid for the supported subset -
 * either invalid XQuery 3.1 syntax or a recognized construct outside the
 * subset (mirrors JSONPathSyntaxError: `source` and `position` locate the
 * offending token).
 */
export class XQuerySyntaxError extends LabeledSyntaxError {
  constructor(message, source, position) {
    super('XQuerySyntaxError', 'XQuery', message, source, position);
  }
}

// value comparisons map onto the same operators as general comparisons -
// a documented front-end approximation (singleton inputs behave
// identically; see XQUERY-FRONTEND.md)
const VALUE_COMPS = Object.freeze({
  eq: '$eq', ne: '$ne', lt: '$lt', le: '$le', gt: '$gt', ge: '$ge',
});

// keywords that cannot start an expression in the subset. A bare one is
// still a name test (a path expression, unsupported); it is reported as a
// misplaced keyword only when the next token shows it was meant as one
const EXPR_KEYWORDS = new Set([
  'for', 'let', 'some', 'every', 'if', 'then', 'else', 'return', 'where',
  'order', 'group', 'stable', 'count', 'satisfies', 'in', 'at', 'to',
  'and', 'or', 'div', 'idiv', 'mod', 'union', 'intersect', 'except',
  'instance', 'treat', 'castable', 'cast', 'is', 'case', 'default',
  'ascending', 'descending', 'least', 'greatest', 'collation', 'empty',
  'allowing', 'by', 'declare', 'import', 'module', 'external', 'variable',
]);

// the words that open a prolog declaration after 'declare' (XQuery 3.1 Setter,
// VarDecl, FunctionDecl, NamespaceDecl, DefaultNamespaceDecl, ContextItemDecl,
// OptionDecl and DecimalFormatDecl, plus the XQuery Update `updating` and
// XQuery 1.0 `revalidation` forms); any other word after it leaves 'declare' a
// name test
const DECLARATION_KINDS = new Set([
  'variable', 'function', 'namespace', 'default', 'option', 'base-uri',
  'boundary-space', 'copy-namespaces', 'construction', 'ordering', 'context',
  'decimal-format', 'revalidation', 'updating',
]);

// words that follow an operand as an operator
const OPERATOR_WORDS = new Set([
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'div', 'idiv', 'mod', 'to',
  'union', 'intersect', 'except', 'instance', 'treat', 'castable', 'cast', 'is',
]);

// computed node constructor keywords (keyword followed by '{')
const NODE_CTOR_KEYWORDS = new Set([
  'element', 'attribute', 'text', 'comment', 'document', 'namespace',
  'processing-instruction',
]);

// FLWOR clause positions in the fixed semantic order of the JSON format
// (QUERY-FORMAT.md section 6.1, D7)
const CLAUSE_SLOT = Object.freeze({
  for: 0, let: 1, where: 2, groupby: 3, orderby: 4, count: 5,
});

const CLAUSE_LABEL = Object.freeze({
  for: 'for', let: 'let', where: 'where', groupby: 'group by',
  orderby: 'order by', count: 'count',
});

// sentinel for the '?*' wildcard lookup key
const STAR_KEY = Object.freeze({ star: true });

//#endregion

//#region function mapping table

// 1-based -> 0-based (D6) for positional *input* arguments: number
// literals fold at parse time, everything else subtracts at runtime.
// An integral shift commutes with the F&O round() the engine applies.
function toZeroBased(e) {
  return typeof e === 'number' ? e - 1 : { '$sub': [e, 1] };
}

function fnUnary(op) {
  return { min: 1, max: 1, emit: (args) => ({ [op]: args[0] }) };
}

// a function whose arguments are the operator's operand list
function fnArgs(op, min, max) {
  return { min, max, emit: (args) => ({ [op]: args }) };
}

// substring/subsequence: F&O's 1-based start becomes 0-based (D6);
// the optional length argument is a count and passes through unchanged
function fnAdjustedStart(op) {
  return {
    min: 2, max: 3,
    emit: (args) => {
      const out = [args[0], toZeroBased(args[1])];
      if (args.length === 3)
        out.push(args[2]);
      return { [op]: out };
    },
  };
}

// fn:index-of: the engine's $index-of answers 0-based positions (D6); each
// one is shifted to F&O's 1-based position. The operands are evaluated in
// the binding, outside the scope of the name the shift introduces.
const INDEX_VAR = 'io_at';

// A date value is equal only to a value of its own type, and F&O's
// fn:index-of reads two values that do not compare as unequal: a search of
// dates of one type among values of another finds nothing, where the
// engine would compare their texts. Both operands are still evaluated.
const indexOfFunction = Object.freeze({
  min: 2,
  max: 2,
  emit: (args, refuse, [within, sought]) => ({
    '$for': { [INDEX_VAR]: { '$index-of': args } },
    '$return': within !== sought && [within, sought].some(isDateTypeName) && [within, sought].every((t) => t === 'none' || isDateTypeName(t))
      ? { '$seq': [] }
      : { '$add': ['$' + INDEX_VAR, 1] },
  }),
});

//#region xs: constructors and fn:tokenize

// The XSD lexical spaces the numeric constructors read, written once as
// the unsigned I-Regexp text the emitted documents match with `$match`
// (which anchors) and the parser folds literals with (a RegExp built from
// the same text): one grammar, two readers. The sign is read apart.
const LEXICAL = Object.freeze({
  integer: '[0-9]+',
  decimal: '([0-9]+(\\.[0-9]*)?|\\.[0-9]+)',
  double: '([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?',
});

const LEXICAL_RE = Object.freeze({
  integer: new RegExp(`^[+-]?(?:${LEXICAL.integer})$`),
  decimal: new RegExp(`^[+-]?(?:${LEXICAL.decimal})$`),
  double: new RegExp(`^[+-]?(?:${LEXICAL.double})$`),
});

// the variable a cast binds its operand to: the operand is evaluated once,
// outside the binding's scope, and nothing the user wrote is evaluated
// beneath any of the names a cast introduces
const CAST_VAR = 'xs_arg';
const CAST_ARG = '$' + CAST_VAR;

// JSON has no literal for the non-finite doubles; each emission builds its
// own (a caller may edit the document it is handed)
const notANumber = () => ({ '$div': [0, 0] });
const positiveInfinity = () => ({ '$div': [1, 0] });
const negativeInfinity = () => ({ '$div': [-1, 0] });

// A refusal the front-end can only make when the query runs - a cast that
// fails (XQuery raises FORG0001 when the cast is evaluated, never when the
// query is read), a type error of a date value, a value outside the
// front-end's domain - raises the engine's `$error` (JQ2017) with XQuery's
// code in its errors namespace (`err:FORG0001`) and a message that names
// the refusal. `code` and `message` are expressions; an emitted literal
// message never starts with '$'.
const xqueryCode = (code) => 'err:' + code;

// the code of a runtime refusal XQuery would not make: a value the
// front-end does not read (a date outside its domain), where XQuery answers
const UNSUPPORTED_VALUE = 'unsupported';

function raisedWith(code, message) {
  return { '$error': [code, message] };
}

// The code of a cast that fails on a literal operand: a string outside the
// type's lexical space or a number outside its range is FORG0001; a number
// or a boolean has no date, nor has a date value of a type that does not
// cast to the asked one (XPTY0004).
function failedLiteralCast(name, e, operandType) {
  const typeError = isDateTypeName(operandType) || (isDateTypeName(name) && literalText(e) === null);
  return raisedWith(xqueryCode(typeError ? 'XPTY0004' : 'FORG0001'), `xs:${name}: ${literalOperandText(e)}`);
}

// The code of a cast that fails on the one item at CAST_ARG, read as the
// cast runs: a date value (`operandType`) that does not cast is XPTY0004; a
// string outside the lexical space is FORG0001; a number is FOCA0002 when it
// is NaN or an infinity, FORG0001 outside the type's range, and has no date
// (XPTY0004); anything else - null, an array, an object, a boolean that is
// no date, two or more items - is the type error XPTY0004.
function failedCast(name, operandType) {
  const message = {
    '$if': [isAtomic(CAST_ARG), { '$concat': [`xs:${name}: `, CAST_ARG] }, `xs:${name}: the operand is not one atomic value`],
  };
  if (isDateTypeName(operandType))
    return raisedWith(xqueryCode('XPTY0004'), message);
  const number = isDateTypeName(name)
    ? xqueryCode('XPTY0004')
    : { '$if': [isFiniteNumber(CAST_ARG), xqueryCode('FORG0001'), xqueryCode('FOCA0002')] };
  const code = {
    '$if': [
      { '$is-string': CAST_ARG }, xqueryCode('FORG0001'),
      { '$if': [{ '$is-number': CAST_ARG }, number, xqueryCode('XPTY0004')] }],
  };
  return raisedWith(code, message);
}

// what a literal operand folds to when the cast cannot succeed
const CAST_FAILS = Symbol('cast fails');

// the text of an emitted string that stands for a string literal, or null
// when the string is a variable or path reference (Rule 2 escaping: a
// literal starting with '$' is emitted with one more)
function literalText(e) {
  if (typeof e !== 'string')
    return null;
  if (e.charCodeAt(0) !== CC_DOLLAR)
    return e;
  return e.charCodeAt(1) === CC_DOLLAR ? e.slice(1) : null;
}

// the text a failed literal cast quotes: the literal as it was written
function literalOperandText(e) {
  const text = literalText(e) ?? dateLiteralText(e);
  return text === null ? String(e) : text;
}

// The static type of an emitted expression that carries xs:date,
// xs:dateTime or xs:time values: the parser reads every use of such a
// value by its type (XQUERY-FRONTEND.md section 4.9). An expression the
// constructors and casts emit is registered here by identity; a literal
// value is emitted as `{"$const": text}` so that it has one.
const DATE_TYPES = new WeakMap();

const isDateTypeName = (t) => t === 'date' || t === 'dateTime' || t === 'time';
const isDateOrMaybe = (t) => isDateTypeName(t) || t === 'maybe';

// a date literal the parser emitted: its text, or null
function dateLiteralText(e) {
  return e !== null && typeof e === 'object' && DATE_TYPES.has(e) && typeof e.$const === 'string' ? e.$const : null;
}

function typedDateLiteral(name, text) {
  const e = { '$const': text };
  DATE_TYPES.set(e, name);
  return e;
}

const trimXsdWhiteSpace = (s) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

// true when the number `e` is finite: an infinity or NaN minus itself is NaN
const isFiniteNumber = (e) => ({ '$eq': [{ '$sub': [e, e] }, 0] });
// one string, number, boolean or null: an item `$string` writes as its text
const isAtomic = (e) => ({ '$or': ['$is-string', '$is-number', '$is-boolean', '$is-null'].map((op) => ({ [op]: e })) });

// the number a numeric cast gives a string literal: a number, the
// non-finite document, or CAST_FAILS when the text is outside the type's
// lexical space (XSD white space around it is not part of it)
function foldNumericText(type, text) {
  const trimmed = trimXsdWhiteSpace(text);
  if (type === 'double') {
    if (trimmed === 'NaN')
      return notANumber();
    if (trimmed === 'INF' || trimmed === '+INF')
      return positiveInfinity();
    if (trimmed === '-INF')
      return negativeInfinity();
  }
  if (!LEXICAL_RE[type].test(trimmed))
    return CAST_FAILS;
  const n = Number(trimmed);
  if (type === 'double') {
    // a spelling beyond the double range is the infinity of its sign
    if (n === Infinity)
      return positiveInfinity();
    return n === -Infinity ? negativeInfinity() : n;
  }
  // an integer or a decimal has no negative zero and no infinity
  return Number.isFinite(n) ? n + 0 : CAST_FAILS;
}

// What a numeric cast gives a literal operand (a string, a number or a
// boolean), CAST_FAILS, or undefined when the operand is not a literal.
// xs:float is xs:double throughout: the engine has no single precision.
function foldNumericOperand(type, e) {
  if (typeof e === 'boolean')
    return e ? 1 : 0;
  if (typeof e === 'number') {
    if (type === 'integer')
      return Math.trunc(e) + 0;
    return type === 'decimal' ? e + 0 : e;
  }
  const text = literalText(e);
  return text === null ? undefined : foldNumericText(type, text);
}

// The readings below take the one item at CAST_ARG and give the value the
// cast makes of it, or the empty sequence when the cast cannot make one;
// they never raise, so a cast is its reading or the error, and `castable
// as` asks whether the reading gave a value.

// A string read by the type's lexical space: white space trimmed, the sign
// read apart, the digits put in the JSON number grammar `$number` reads.
// Leading zeros go behind a sentinel (an I-Regexp has no anchors; the text
// was matched against the lexical space first, so it holds none), the digit
// before a bare dot, exponent or end comes back, and a trailing dot gets its
// zero. A decimal or an integer beyond the double range is no value, and
// has no negative zero.
function readLexicalNumber(type) {
  const signed = { '$if': ['$xs_negative', { '$neg': '$xs_value' }, '$xs_value'] };
  const digits = {
    '$let': {
      xs_digits: { '$substring': [{ '$replace': [{ '$concat': ['\uffff', '$xs_unsigned'] }, '\uffff0+', '\uffff'] }, 1] },
      xs_leading: { '$if': [{ '$match': ['$xs_digits', '([.eE].*)?'] }, { '$concat': ['0', '$xs_digits'] }, '$xs_digits'] },
      xs_json: {
        '$if': [
          { '$ends-with': ['$xs_leading', '.'] },
          { '$concat': ['$xs_leading', '0'] },
          { '$replace': [{ '$replace': ['$xs_leading', '\\.e', '.0e'] }, '\\.E', '.0E'] },
        ],
      },
      xs_value: { '$number': '$xs_json' },
    },
    '$return': type === 'double'
      ? signed
      : { '$let': { xs_signed: signed }, '$return': { '$if': [isFiniteNumber('$xs_signed'), { '$add': ['$xs_signed', 0] }] } },
  };
  const unsigned = {
    '$let': {
      xs_negative: { '$starts-with': ['$xs_text', '-'] },
      xs_unsigned: { '$if': [{ '$or': ['$xs_negative', { '$starts-with': ['$xs_text', '+'] }] }, { '$substring': ['$xs_text', 1] }, '$xs_text'] },
    },
    '$return': { '$if': [{ '$match': ['$xs_unsigned', LEXICAL[type]] }, digits] },
  };
  const special = type !== 'double' ? unsigned : {
    '$if': [
      { '$eq': ['$xs_text', 'NaN'] }, notANumber(),
      { '$if': [
        { '$or': [{ '$eq': ['$xs_text', 'INF'] }, { '$eq': ['$xs_text', '+INF'] }] }, positiveInfinity(),
        { '$if': [{ '$eq': ['$xs_text', '-INF'] }, negativeInfinity(), unsigned] }] }],
  };
  return { '$let': { xs_text: { '$normalize-space': CAST_ARG } }, '$return': special };
}

// A number read by the type's value rule: a double takes it as it is, a
// decimal takes a finite one, an integer a finite one without its fraction;
// neither has a negative zero.
function readNumber(type) {
  if (type === 'double')
    return CAST_ARG;
  const value = type === 'integer' ? { '$idiv': [CAST_ARG, 1] } : CAST_ARG;
  return { '$if': [isFiniteNumber(CAST_ARG), { '$add': [value, 0] }] };
}

// A numeric type: a string by the lexical space, a number by the type's
// value rule, a boolean as 1 or 0; nothing else (null, an array, an object,
// two or more items) has a value.
function numericType(type) {
  return {
    fold: (e) => foldNumericOperand(type, e),
    read: () => ({
      '$if': [
        { '$is-string': CAST_ARG }, readLexicalNumber(type),
        { '$if': [
          { '$is-number': CAST_ARG }, readNumber(type),
          { '$if': [{ '$is-boolean': CAST_ARG }, { '$number': CAST_ARG }] }] }],
    }),
  };
}

// The integer `e` (a number) when it lies in [low, high), the empty
// sequence otherwise; an absent bound does not limit. Every bound is an
// integer the double holds exactly (2^63 and 2^64 included), so the test
// is exact on the value the engine holds.
function inRange(e, low, high) {
  const tests = [];
  if (low !== undefined)
    tests.push({ '$ge': [e, low] });
  if (high !== undefined)
    tests.push({ '$lt': [e, high] });
  return tests.length === 1 ? tests[0] : { '$and': tests };
}

// The integer types XSD derives by range: the integer reading, kept only
// in [low, high). xs:long and xs:unsignedLong reach past 2^53, where an
// integer is a double (D1): their texts and literals are read as the
// double nearest them first, then the range is checked on that double.
function integerRangeType(low, high) {
  const integer = numericType('integer');
  const inside = (n) => (low === undefined || n >= low) && (high === undefined || n < high);
  return {
    fold: (e) => {
      const n = integer.fold(e);
      return n === undefined || n === CAST_FAILS || inside(n) ? n : CAST_FAILS;
    },
    read: () => ({
      '$for': { xs_int: integer.read() },
      '$where': inRange('$xs_int', low, high),
      '$return': '$xs_int',
    }),
  };
}

// The XSD boolean lexical space (white space around it is not part of it)
const BOOLEAN_TRUE_TEXTS = Object.freeze(['true', '1']);
const BOOLEAN_FALSE_TEXTS = Object.freeze(['false', '0']);

// xs:boolean: a boolean is itself, a number is false only for 0 and NaN
// (the `$boolean` of a number), a string is `true`/`1` or `false`/`0` once
// trimmed; `$boolean` itself would be the EBV, for which "false" is true
const booleanType = Object.freeze({
  fold: (e) => {
    if (typeof e === 'boolean')
      return e;
    if (typeof e === 'number')
      return e !== 0;
    const literal = literalText(e);
    if (literal === null)
      return undefined;
    const trimmed = trimXsdWhiteSpace(literal);
    if (BOOLEAN_TRUE_TEXTS.includes(trimmed))
      return true;
    return BOOLEAN_FALSE_TEXTS.includes(trimmed) ? false : CAST_FAILS;
  },
  read: () => {
    // true when the trimmed operand text is one of `texts`
    const isOneOf = (texts) => ({
      '$or': texts.map((word) => ({ '$eq': [{ '$normalize-space': CAST_ARG }, word] })),
    });
    return {
      '$if': [
        { '$is-boolean': CAST_ARG }, CAST_ARG,
        { '$if': [
          { '$is-number': CAST_ARG }, { '$boolean': CAST_ARG },
          { '$if': [
            { '$is-string': CAST_ARG },
            { '$if': [isOneOf(BOOLEAN_TRUE_TEXTS), true, { '$if': [isOneOf(BOOLEAN_FALSE_TEXTS), false] }] }] }] }],
    };
  },
});

// xs:string is `$string`, which takes a string, a number, a boolean or
// null (QUERY-FORMAT section 8.10); no literal folds
const stringType = Object.freeze({
  fold: () => undefined,
  read: () => ({
    '$if': [
      isAtomic(CAST_ARG),
      { '$string': CAST_ARG },
    ],
  }),
});

// xs:date, xs:dateTime and xs:time. The engine's dates are RFC 3339
// strings (QUERY-FORMAT.md section 8.13), and every operator the front-end
// maps reads a constructed date as the string it is: `eq` and `lt` compare
// code points and `string()` is the text. So a value is admitted only where
// the code-point order of its text is its time order and the text is the
// XSD canonical form: an xs:date without a timezone, an xs:dateTime or an
// xs:time in UTC without a fraction of a second, in the years 0000 to 9999
// RFC 3339 spells. A value XSD reads outside that domain (another timezone,
// a fraction, a year RFC 3339 cannot spell) is refused by name, never
// answered: as the query is read for a literal operand, with JQ2001 when
// the cast runs for any other.
//
// The text of an xs:dateTime may stand for a string or for a constructed
// xs:dateTime, which casts to an xs:date or an xs:time where the string
// does not (and an xs:date to an xs:dateTime); such an operand is refused
// rather than read one way.

const XSD_TIME = '([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?';
const XSD_TIMEZONE = '(Z|[+-][0-9]{2}:[0-9]{2})?';
const XSD_DATE = '(-?(?:[1-9][0-9]{3,}|0[0-9]{3}))-([0-9]{2})-([0-9]{2})';

// the XSD lexical spaces, with their fields as groups
const XSD_DATE_RE = new RegExp(`^${XSD_DATE}${XSD_TIMEZONE}$`);
const XSD_DATETIME_RE = new RegExp(`^${XSD_DATE}T${XSD_TIME}${XSD_TIMEZONE}$`);
const XSD_TIME_RE = new RegExp(`^${XSD_TIME}${XSD_TIMEZONE}$`);

// the same shapes as I-Regexp texts for `$match` (no groups are read)
const DATE_SHAPE = '-?[0-9]{4,}-[0-9]{2}-[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})?';
const DATETIME_SHAPE = '-?[0-9]{4,}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?';
const TIME_SHAPE = '[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?';

// the domain's texts: digits that `$is-date`/`$is-datetime`/`$is-time` then
// check as a calendar (a day of the month, a leap year) and a clock
const DOMAIN_TIME = '([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z';
const DATE_DOMAIN = '[0-9]{4}-[0-9]{2}-[0-9]{2}';

// A time of day read by XSD, or null: hours 00 to 23 or 24:00:00 exactly,
// minutes and seconds 00 to 59, a timezone within 14 hours. `utc` is a
// zone of zero, `exact` a fraction of zeros or none.
function readXsdClock(hh, mm, ss, fraction, zone) {
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const exact = fraction === undefined || /^\.0+$/.test(fraction);
  if (minutes > 59 || seconds > 59 || hours > 24 || (hours === 24 && (minutes !== 0 || seconds !== 0 || !exact)))
    return null;
  if (zone !== undefined && zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4));
    if (zoneMinutes > 59 || zoneHours > 14 || (zoneHours === 14 && zoneMinutes !== 0))
      return null;
  }
  return { hours, minutes, seconds, exact, zoned: zone !== undefined, utc: zone === 'Z' || zone === '+00:00' || zone === '-00:00' };
}

// A calendar date read by XSD (year 0000 included), or null; `spellable`
// is a year RFC 3339 writes (0000 to 9999).
function readXsdCalendar(yyyy, mm, dd) {
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    return null;
  return { year, month, day, spellable: /^[0-9]{4}$/.test(yyyy) };
}

// A text read in an XSD lexical space, or null: `{ calendar, clock, zone }`
// with the halves the type has.
function readXsdDate(text) {
  const f = XSD_DATE_RE.exec(text);
  const calendar = f === null ? null : readXsdCalendar(f[1], f[2], f[3]);
  return calendar === null ? null : { calendar, zone: f[4] };
}

function readXsdDateTime(text) {
  const f = XSD_DATETIME_RE.exec(text);
  const calendar = f === null ? null : readXsdCalendar(f[1], f[2], f[3]);
  const clock = calendar === null ? null : readXsdClock(f[4], f[5], f[6], f[7], f[8]);
  return clock === null ? null : { calendar, clock };
}

function readXsdTime(text) {
  const f = XSD_TIME_RE.exec(text);
  const clock = f === null ? null : readXsdClock(f[1], f[2], f[3], f[4], f[5]);
  return clock === null ? null : { clock };
}

const pad2 = (n) => String(n).padStart(2, '0');

const dateText = ({ year, month, day }) => `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;

// the clock of the domain's text: UTC, no fraction, 24:00:00 as 00:00:00;
// a reason the clock is outside the domain otherwise
function clockText(clock) {
  if (!clock.zoned)
    return { reason: 'without a timezone' };
  if (!clock.utc)
    return { reason: 'with a timezone other than Z' };
  if (!clock.exact)
    return { reason: 'with a fraction of a second' };
  return { text: `${pad2(clock.hours % 24)}:${pad2(clock.minutes)}:${pad2(clock.seconds)}Z` };
}

// What a date cast gives a string literal: the canonical text, CAST_FAILS
// for a text outside the type's lexical space (XQuery's FORG0001), or the
// refusal `refuse` throws for a value outside the domain.
function foldDateText(name, text, refuse) {
  const trimmed = trimXsdWhiteSpace(text);
  const outside = (reason) => refuse(`unsupported construct 'xs:${name} ${reason}'`);
  if (name === 'date') {
    const date = readXsdDate(trimmed);
    if (date === null)
      return CAST_FAILS;
    if (date.zone !== undefined)
      return outside('with a timezone');
    return date.calendar.spellable ? dateText(date.calendar) : outside('outside the years 0000 to 9999');
  }
  const value = name === 'time' ? readXsdTime(trimmed) : readXsdDateTime(trimmed);
  if (value === null)
    return CAST_FAILS;
  const clock = clockText(value.clock);
  if (clock.reason !== undefined)
    return outside(clock.reason);
  if (name === 'time')
    return clock.text;
  // 24:00:00 is midnight of the next day (XSD's canonical form)
  const { calendar } = value;
  const day = value.clock.hours === 24
    ? civilFromDays(daysFromCivil(calendar.year, calendar.month, calendar.day) + 1)
    : calendar;
  if (!calendar.spellable || day.year > 9999)
    return outside('outside the years 0000 to 9999');
  return `${dateText(day)}T${clock.text}`;
}

// How a value of the date type `from` casts to the date type `to`: itself,
// the time of a dateTime, no value (XQuery's XPTY0004), or the reason the
// value it casts to is outside the domain (a dateTime's date keeps its
// timezone, a date's dateTime has none).
function dateConversion(from, to) {
  if (from === to)
    return 'same';
  if (from === 'dateTime' && to === 'time')
    return 'time-part';
  if (from === 'dateTime' && to === 'date')
    return 'with a timezone';
  if (from === 'date' && to === 'dateTime')
    return 'without a timezone';
  return 'none';
}

// The reading of a computed xs:dateTime text `$xs_value` at 24:00:00: the
// midnight that starts the next day, the error `unread` past 9999-12-31,
// no value for a day the calendar does not have, and `otherwise` for any
// other text.
function nextDay(unread, otherwise) {
  return {
    '$if': [
      { '$match': ['$xs_value', `${DATE_DOMAIN}T24:00:00Z`] },
      {
        '$let': { xs_day: { '$concat': [{ '$substring': ['$xs_value', 0, 10] }, 'T00:00:00Z'] } },
        '$return': { '$if': [
          { '$is-datetime': '$xs_day' },
          { '$if': [{ '$eq': ['$xs_day', '9999-12-31T00:00:00Z'] }, unread, { '$date-add': ['$xs_day', 1, 'day'] }] },
        ] },
      },
      otherwise,
    ],
  };
}

// A date type. Its operand is read by its static type: a value of another
// date type converts as XQuery casts it, a number or a boolean has no
// value (XQuery casts neither to a date), a string literal folds, and a
// computed string is read by the domain's text and checked as a calendar
// and a clock. A string in the shape of a value of this type the domain
// refuses raises; so does, for an operand that may be a date value of any
// type (`maybe`), a string in the shape of another date type, which may
// stand for a value of that type that casts here. Any other string has no
// value.
function dateType(name) {
  const domain = { date: DATE_DOMAIN, dateTime: `${DATE_DOMAIN}T${DOMAIN_TIME}`, time: DOMAIN_TIME }[name];
  const check = { date: '$is-date', dateTime: '$is-datetime', time: '$is-time' }[name];
  const own = { date: DATE_SHAPE, dateTime: DATETIME_SHAPE, time: TIME_SHAPE }[name];
  const other = { date: [DATETIME_SHAPE], dateTime: [DATE_SHAPE], time: [DATETIME_SHAPE] }[name];
  const unread = raisedWith(UNSUPPORTED_VALUE, { '$concat': [`xs:${name}: `, '$xs_text', ' is a value the front-end does not read'] });
  const outsideDomain = (operandType) => ({ '$if': [
    { '$or': (operandType === 'maybe' ? [own, ...other] : [own]).map((shape) => ({ '$match': ['$xs_text', shape] })) },
    unread,
  ] });
  // the text a literal folds to (see foldDateText): a zone of zero is `Z`,
  // a fraction of zeros is dropped, and 24:00:00 is midnight of the next day
  const value = name === 'date' ? '$xs_text' : { '$replace': ['$xs_text', '(\\.0+)?([+-]00:00|Z)$', 'Z'] };
  const readString = (operandType) => ({
    '$let': { xs_text: { '$normalize-space': CAST_ARG } },
    '$return': {
      '$let': { xs_value: name === 'time' ? { '$replace': [value, '^24:00:00Z$', '00:00:00Z'] } : value },
      '$return': {
        '$if': [
          { '$match': ['$xs_value', domain] },
          { '$if': [{ [check]: '$xs_value' }, '$xs_value'] },
          name === 'dateTime' ? nextDay(unread, outsideDomain(operandType)) : outsideDomain(operandType),
        ],
      },
    },
  });
  return {
    fold: (e, refuse, operandType) => {
      if (typeof e === 'boolean' || typeof e === 'number')
        return CAST_FAILS;
      if (isDateTypeName(operandType)) {
        const conversion = dateConversion(operandType, name);
        if (conversion !== 'same' && conversion !== 'time-part' && conversion !== 'none')
          return refuse(`unsupported construct 'xs:${name} ${conversion}'`);
        // a computed operand is read when the cast runs: it may be empty
        const text = dateLiteralText(e);
        if (text === null)
          return undefined;
        if (conversion === 'none')
          return CAST_FAILS;
        return conversion === 'same' ? e : typedDateLiteral(name, text.slice(11));
      }
      const text = literalText(e);
      return text === null ? undefined : foldDateText(name, text, refuse);
    },
    read: (operandType) => {
      if (isDateTypeName(operandType)) {
        const conversion = dateConversion(operandType, name);
        return conversion === 'same' ? CAST_ARG : conversion === 'time-part' ? { '$substring': [CAST_ARG, 11] } : { '$seq': [] };
      }
      return { '$if': [{ '$is-string': CAST_ARG }, readString(operandType)] };
    },
  };
}

// The `xs:` types the JSON model has a value for, by local name. The engine
// has one number type (D1), so the numeric types differ in the values they
// accept and the errors they raise, not in the value they give.
const XS_TYPES = Object.freeze({
  'string': stringType,
  'boolean': booleanType,
  'integer': numericType('integer'),
  'decimal': numericType('decimal'),
  'double': numericType('double'),
  'float': numericType('double'),
  'long': integerRangeType(-(2 ** 63), 2 ** 63),
  'int': integerRangeType(-(2 ** 31), 2 ** 31),
  'short': integerRangeType(-(2 ** 15), 2 ** 15),
  'byte': integerRangeType(-(2 ** 7), 2 ** 7),
  'unsignedLong': integerRangeType(0, 2 ** 64),
  'unsignedInt': integerRangeType(0, 2 ** 32),
  'unsignedShort': integerRangeType(0, 2 ** 16),
  'unsignedByte': integerRangeType(0, 2 ** 8),
  'nonNegativeInteger': integerRangeType(0, undefined),
  'positiveInteger': integerRangeType(1, undefined),
  'nonPositiveInteger': integerRangeType(undefined, 1),
  'negativeInteger': integerRangeType(undefined, 0),
  'date': dateType('date'),
  'dateTime': dateType('dateTime'),
  'time': dateType('time'),
});

// `e cast as xs:<name>?` (the constructor function) and, when
// `emptyAllowed` is false, `e cast as xs:<name>`, which raises on the empty
// sequence. A literal operand folds; any other is bound once to CAST_VAR,
// outside every name the reading introduces, and read when the query runs,
// so the cast is lazy. `refuse(message)` throws the positioned
// `unsupported ...` error for a value the subset does not read;
// `operandType` is the operand's static date type (see typeOf). A cast to a
// date type is registered with its type.
function castTo(name, e, emptyAllowed, refuse, operandType) {
  const cast = castExpression(name, e, emptyAllowed, refuse, operandType);
  if (isDateTypeName(name) && cast !== null && typeof cast === 'object')
    DATE_TYPES.set(cast, name);
  return cast;
}

function castExpression(name, e, emptyAllowed, refuse, operandType) {
  // `$string` is the cast to xs:string? itself
  if (name === 'string' && emptyAllowed)
    return { '$string': e };
  const type = XS_TYPES[name];
  const folded = type.fold(e, refuse, operandType);
  if (folded === CAST_FAILS)
    return failedLiteralCast(name, e, operandType);
  if (folded !== undefined)
    return isDateTypeName(name) && typeof folded === 'string' ? typedDateLiteral(name, folded) : folded;
  const cast = { '$coalesce': [type.read(operandType), failedCast(name, operandType)] };
  return {
    '$let': { [CAST_VAR]: e },
    '$return': {
      '$if': emptyAllowed
        ? [{ '$exists': CAST_ARG }, cast]
        : [{ '$exists': CAST_ARG }, cast, raisedWith(xqueryCode('XPTY0004'), `xs:${name}: the empty sequence`)],
    },
  };
}

// `e castable as xs:<name>` (`?` when `emptyAllowed`): whether the cast
// would give a value - never an error. A literal operand folds to the
// answer.
function castableAs(name, e, emptyAllowed, refuse, operandType) {
  const type = XS_TYPES[name];
  const folded = type.fold(e, refuse, operandType);
  if (folded !== undefined)
    return folded !== CAST_FAILS;
  return {
    '$let': { [CAST_VAR]: e },
    '$return': { '$if': [{ '$exists': CAST_ARG }, { '$exists': type.read(operandType) }, emptyAllowed] },
  };
}

// The `xs:` constructor functions: `xs:T(e)` is `e cast as xs:T?`.
const XS_TABLE = Object.freeze(Object.fromEntries(Object.keys(XS_TYPES).map((name) => [
  name,
  { min: 1, max: 1, emit: (args, refuse, types) => castTo(name, args[0], true, refuse, types[0]) },
])));

// fn:tokenize is `$tokenize`, the pieces between the matches of an
// I-Regexp (D5). F&O's flags argument is read as the query is read: no
// flags (`""`) is the two-argument call, and `q` (the pattern is plain
// text) escapes a literal pattern into an I-Regexp that matches that text.
// The other flags change what a pattern matches in ways an I-Regexp
// cannot (`i`, `s`, `m`, `x`) and are refused by name, as is a flag
// computed when the query runs; a letter F&O does not define is F&O's
// FORX0001, raised when the call is evaluated.
const TOKENIZE_FLAGS_UNSUPPORTED = 'smix';
const TOKENIZE_FLAGS = 'smixq';

// the I-Regexp that matches `text` and nothing else: every character an
// I-Regexp reads as syntax escaped, `^` and `$` included (the translation
// to a RegExp reads both as anchors), `$` as a class since `\$` is no
// I-Regexp escape
function literalPattern(text) {
  return text.replace(/[\\|.?*+(){}[\]^]/g, '\\$&').replace(/\$/g, '[$]');
}

const tokenizeFunction = Object.freeze({
  min: 1,
  max: 3,
  emit: (args, refuse) => {
    if (args.length === 1)
      return { '$tokenize': [{ '$normalize-space': args[0] }, ' '] };
    if (args.length === 2)
      return { '$tokenize': args };
    const flags = literalText(args[2]);
    if (flags === null)
      return refuse("unsupported construct 'tokenize flags other than a literal'");
    for (const flag of flags) {
      if (!TOKENIZE_FLAGS.includes(flag))
        return raisedWith(xqueryCode('FORX0001'), `fn:tokenize: invalid flags '${flags}'`);
    }
    for (const flag of TOKENIZE_FLAGS_UNSUPPORTED) {
      if (flags.includes(flag))
        return refuse(`unsupported construct 'tokenize flag ${flag}'`);
    }
    if (flags === '')
      return { '$tokenize': [args[0], args[1]] };
    const pattern = literalText(args[1]);
    if (pattern === null)
      return refuse("unsupported construct 'tokenize flag q with a computed pattern'");
    return { '$tokenize': [args[0], emitString(literalPattern(pattern))] };
  },
});

//#endregion

//#region fn:format-number

// fn:format-number is `$format-number` (QUERY-FORMAT.md section 8.7). F&O
// reads the decimal format's name with the white space around it removed
// (an EQName holds none): a literal name is trimmed as the query is read,
// and a computed one is passed as it is.
//
// A percent or per-mille picture multiplies the value by 100 or 1000 as a
// double (F&O section 4.7.5), so the product carries the double's rounding
// and overflows to the infinity of its sign (`Infinity%`), where
// `$format-number` scales the value's decimal digits exactly. Under the
// default decimal format (the two-argument call) a literal picture names its
// sign: the value is multiplied here, formatted under the picture with the
// sign as a passive character no picture holds, and the sign put back.
const PICTURE_MULTIPLIERS = Object.freeze({ '%': 100, '\u2030': 1000 });
const PASSIVE_SIGN = '\uffff';

// the multiplier sign every sub-picture of a default-format picture holds
// once, MIXED_SIGNS when the two sub-pictures hold different ones, or null:
// none, or a picture F&O refuses (which `$format-number` then refuses as
// the query compiles)
const MIXED_SIGNS = Symbol('mixed signs');

function pictureMultiplierSign(picture) {
  if (picture.includes(PASSIVE_SIGN))
    return null;
  try {
    compilePicture(picture, DEFAULT_DECIMAL_FORMAT);
  }
  catch (e) {
    if (e instanceof FormatRefusal)
      return null;
    throw e;
  }
  let sign = null;
  for (const sub of picture.split(';')) {
    const signs = Array.from(sub).filter((ch) => hasOwn(PICTURE_MULTIPLIERS, ch));
    if (signs.length !== 1)
      return null;
    if (sign !== null && signs[0] !== sign)
      return MIXED_SIGNS;
    sign = signs[0];
  }
  return sign;
}

const formatNumberFunction = Object.freeze({
  min: 2,
  max: 3,
  emit: (args, refuse) => {
    if (args.length === 3) {
      const name = literalText(args[2]);
      return { '$format-number': name === null ? args : [args[0], args[1], emitString(trimXsdWhiteSpace(name))] };
    }
    const picture = literalText(args[1]);
    const sign = picture === null ? null : pictureMultiplierSign(picture);
    if (sign === null)
      return { '$format-number': args };
    if (sign === MIXED_SIGNS)
      return refuse("unsupported construct 'format-number picture with a percent and a per-mille sub-picture'");
    const passive = picture.split(sign).join(PASSIVE_SIGN);
    return {
      '$replace': [
        { '$format-number': [{ '$mul': [args[0], PICTURE_MULTIPLIERS[sign]] }, emitString(passive)] },
        PASSIVE_SIGN,
        sign,
      ],
    };
  },
});

//#endregion

//#region fn:remove, fn:insert-before, fn:compare

// `e` with every node `replacements` holds (by identity) replaced by its
// value there; the rest is shared, never edited
function replaced(e, replacements) {
  if (replacements.has(e))
    return replacements.get(e);
  if (e === null || typeof e !== 'object')
    return e;
  let out = null;
  for (const key of Object.keys(e)) {
    const member = replaced(e[key], replacements);
    if (member !== e[key]) {
      out ??= Array.isArray(e) ? e.slice() : { ...e };
      // a map key the user wrote may be '__proto__'
      Object.defineProperty(out, key, { value: member, writable: true, enumerable: true, configurable: true });
    }
  }
  return out ?? e;
}

// the variable a guard of a date use binds its operands to (see `typed`)
const TYPED_VAR = 'ty_args';

// The operands of a composed function, each evaluated once and outside
// every name the composition introduces: one array per operand, in an
// array bound to `name` (an array constructor keeps the items of an
// operand together in its one member), read back by `$name[i][*]`.
function withOperands(name, args, body) {
  return {
    '$let': { [name]: args.map((a) => [a]) },
    '$return': body(args.map((_, i) => `$${name}[${i}][*]`)),
  };
}

// An F&O position is an xs:integer: one finite integral number. Anything
// else (the empty sequence, a fraction, NaN, an infinity) is the type
// error: the number less its truncation is 0 only for a finite integral
// one (an infinity less itself is NaN), and `$idiv` raises on what is not
// one number.
function withIntegerPosition(fn, at, body) {
  return {
    '$if': [
      { '$eq': [{ '$sub': [at, { '$idiv': [at, 1] }] }, 0] },
      body,
      raisedWith(xqueryCode('XPTY0004'), { '$concat': [`fn:${fn}: position `, at] }),
    ],
  };
}

// the items of `seq` before the 1-based position `at` (`$subsequence` is
// 0-based, D6)
const itemsBefore = (seq, at) => ({ '$subsequence': [seq, 0, { '$sub': [at, 1] }] });

// fn:remove: the target without the item at the position (the 0-based
// start `at` is the item after it); a position outside the target removes
// nothing
const removeFunction = Object.freeze({
  min: 2,
  max: 2,
  emit: (args) => withOperands('rm_args', args, ([target, at]) => withIntegerPosition('remove', at, {
    '$seq': [itemsBefore(target, at), { '$subsequence': [target, at] }],
  })),
});

// fn:insert-before: the inserts before the item at the position; a
// position below 1 inserts before the first item, one past the end appends
const insertBeforeFunction = Object.freeze({
  min: 3,
  max: 3,
  emit: (args) => withOperands('ib_args', args, ([target, at, inserts]) => withIntegerPosition('insert-before', at, {
    '$seq': [itemsBefore(target, at), inserts, { '$subsequence': [target, { '$sub': [at, 1] }] }],
  })),
});

const CODEPOINT_COLLATION = 'http://www.w3.org/2005/xpath-functions/collation/codepoint';

// fn:compare under the Unicode codepoint collation, the one the engine
// has: -1, 0 or 1 as the first string sorts before, with or after the
// second (`$lt` orders strings by code point), the empty sequence when
// either is empty. An operand that is neither one string nor empty is the
// type error, raised by `$string-length`, which takes nothing else.
const compareFunction = Object.freeze({
  min: 2,
  max: 3,
  emit: (args, refuse) => {
    if (args.length === 3 && literalText(args[2]) !== CODEPOINT_COLLATION)
      return refuse("unsupported construct 'collation'");
    return withOperands('cmp_args', args.slice(0, 2), ([a, b]) => {
      const fits = (e) => ({ '$or': [{ '$empty': e }, { '$is-string': e }] });
      return {
        '$if': [
          { '$and': [fits(a), fits(b)] },
          { '$if': [
            { '$and': [{ '$exists': a }, { '$exists': b }] },
            { '$if': [{ '$lt': [a, b] }, -1, { '$if': [{ '$eq': [a, b] }, 0, 1] }] }] },
          { '$seq': [{ '$string-length': a }, { '$string-length': b }] },
        ],
      };
    });
  },
});

//#endregion

//#region fn:error

// XQuery's errors namespace, which the `err` prefix is bound to
const ERRORS_NAMESPACE = 'http://www.w3.org/2005/xqt-errors';

const NCNAME = '[\\p{L}_][\\p{L}\\p{N}_.\\-]*';
const LEXICAL_QNAME_RE = new RegExp(`^(?:(${NCNAME}):)?(${NCNAME})$`, 'u');

// The code text of an error QName the query names by a constructor, as the
// raised error carries it: `err:<local>` in the errors namespace, the local
// name in no namespace, `Q{uri}local` in any other. Registered by identity:
// a QName is read only as the code fn:error raises (the parser emits it
// for the first argument of fn:error alone, and fn:error takes it out).
const QNAME_CODES = new WeakMap();

// `fn:QName(uri, lexical)` or `xs:QName(lexical)` over literal names, read
// as the query is read; `refuse(message)` throws the positioned refusal
function emitQName(xs, written, args, refuse) {
  if (args.length !== (xs ? 1 : 2))
    return refuse(`unsupported function '${written}#${args.length}'`);
  const texts = args.map(literalText);
  if (texts.includes(null))
    return refuse("unsupported construct 'a QName of a computed name'");
  const lexical = xs ? trimXsdWhiteSpace(texts[0]) : texts[1];
  const name = LEXICAL_QNAME_RE.exec(lexical);
  if (name === null)
    return refuse("unsupported construct 'a QName that is not a name'");
  const [, prefix, local] = name;
  let uri = texts[0];
  if (xs) {
    // the prefixes xs:QName resolves: `err`, and none (no namespace)
    if (prefix !== undefined && prefix !== 'err')
      return refuse(`unsupported construct 'xs:QName with the prefix ${prefix}'`);
    uri = prefix === undefined ? '' : ERRORS_NAMESPACE;
  }
  else if (uri === '' && prefix !== undefined) {
    return refuse("unsupported construct 'a QName with a prefix and no namespace'");
  }
  const code = uri === ERRORS_NAMESPACE ? xqueryCode(local) : uri === '' ? local : `Q{${uri}}${local}`;
  const node = { '$const': code };
  QNAME_CODES.set(node, code);
  return node;
}

// fn:error([code [, description [, error object]]]) is `$error`: the code
// a QName constructor names, `err:FOER0000` without one; a code of another
// type is XQuery's type error, raised where the call is evaluated.
const errorFunction = Object.freeze({
  min: 0,
  max: 3,
  emit: (args, refuse, types) => {
    const rest = args.slice(1);
    if (args.length === 0 || isEmptySeqExpr(args[0]))
      return { '$error': [xqueryCode('FOER0000'), ...rest] };
    const code = QNAME_CODES.get(args[0]);
    if (code !== undefined)
      return { '$error': [code, ...rest] };
    const atomic = literalText(args[0]) !== null || typeof args[0] === 'number' || typeof args[0] === 'boolean';
    if (atomic || isDateTypeName(types[0]))
      return raisedWith(xqueryCode('XPTY0004'), 'fn:error takes an xs:QName as its code');
    return refuse("unsupported construct 'fn:error code other than a QName constructor'");
  },
});

//#endregion

// The supported built-in functions (bare or `fn:`-prefixed), one entry
// per name: `{ min, max, emit(args, refuse) }` over already-emitted
// argument expressions; `refuse(message)` throws the positioned
// `unsupported ...` error for an argument shape the entry cannot map.
// Arities outside [min, max] - including F&O arities that exist but are
// not in the subset, like fn:sum#2 or the 0-argument context-item forms -
// fail as `unsupported function 'name#arity'`.
const FN_TABLE = Object.freeze({
  'count': fnUnary('$count'),
  'sum': fnUnary('$sum'),
  'avg': fnUnary('$avg'),
  'min': fnUnary('$min'),
  'max': fnUnary('$max'),
  'exists': fnUnary('$exists'),
  'empty': fnUnary('$empty'),
  'not': fnUnary('$not'),
  'boolean': fnUnary('$boolean'),
  'string': fnUnary('$string'),
  'number': fnUnary('$number'),
  'reverse': fnUnary('$reverse'),
  'head': fnUnary('$head'),
  'tail': fnUnary('$tail'),
  'distinct-values': fnUnary('$distinct'),
  'upper-case': fnUnary('$upper'),
  'lower-case': fnUnary('$lower'),
  'string-length': fnUnary('$string-length'),
  'normalize-space': fnUnary('$normalize-space'),
  'contains': fnArgs('$contains', 2, 2),
  'starts-with': fnArgs('$starts-with', 2, 2),
  'ends-with': fnArgs('$ends-with', 2, 2),
  'substring-before': fnArgs('$substring-before', 2, 2),
  'substring-after': fnArgs('$substring-after', 2, 2),
  'translate': fnArgs('$translate', 3, 3),
  // fn:matches tests a *substring* match (F&O), which is `$search`;
  // `$match` is the anchored RFC 9535 match() - see XQUERY-FRONTEND.md
  'matches': fnArgs('$search', 2, 2),
  'index-of': indexOfFunction,
  'concat': fnArgs('$concat', 2, Infinity),
  'string-join': fnArgs('$string-join', 1, 2),
  'replace': fnArgs('$replace', 3, 3),
  'substring': fnAdjustedStart('$substring'),
  'subsequence': fnAdjustedStart('$subsequence'),
  'tokenize': tokenizeFunction,
  'abs': fnUnary('$abs'),
  'floor': fnUnary('$floor'),
  'ceiling': fnUnary('$ceiling'),
  'round': fnArgs('$round', 1, 2),
  'round-half-to-even': fnArgs('$round-half-to-even', 1, 2),
  'remove': removeFunction,
  'insert-before': insertBeforeFunction,
  'compare': compareFunction,
  'format-number': formatNumberFunction,
  'error': errorFunction,
  // XQuery has no boolean literals; fn:true()/fn:false() are the spelling
  'true': { min: 0, max: 0, emit: () => true },
  'false': { min: 0, max: 0, emit: () => false },
});

// The arguments F&O types as a string (`xs:string?`, `xs:string`): a date
// value there is XPTY0004, where the engine would read its text.
const STRING_ARGUMENTS = Object.freeze({
  'string-length': [0], 'substring': [0], 'upper-case': [0], 'lower-case': [0], 'normalize-space': [0],
  'contains': [0, 1], 'starts-with': [0, 1], 'ends-with': [0, 1], 'matches': [0, 1],
  'substring-before': [0, 1], 'substring-after': [0, 1], 'replace': [0, 1, 2], 'translate': [0, 1, 2],
  'tokenize': [0, 1, 2], 'compare': [0, 1, 2], 'string-join': [1], 'format-number': [1, 2],
  'error': [1],
});

// The functions whose result is items of some of their arguments: the
// result carries those arguments' date types.
const ITEM_ARGUMENTS = Object.freeze({
  'head': [0], 'tail': [0], 'reverse': [0], 'subsequence': [0], 'distinct-values': [0],
  'min': [0], 'max': [0], 'remove': [0], 'insert-before': [0, 2],
});

// The functions that compare the items of some of their arguments: a date
// compares only with a value of its own type, so an argument that may or
// may not hold a date is refused (see `operandTypes`)
const COMPARED_ARGUMENTS = Object.freeze({
  'min': [0], 'max': [0], 'distinct-values': [0], 'index-of': [0, 1],
});

const MAP_FN_TABLE = Object.freeze({
  'get': { min: 2, max: 2, emit: (args) => ({ '$get': args }) },
});

const ARRAY_FN_TABLE = Object.freeze({
  // array:get's 1-based position becomes a 0-based (D6) $get index
  'get': { min: 2, max: 2, emit: (args) => ({ '$get': [args[0], toZeroBased(args[1])] }) },
});

//#endregion

//#region emission helpers

// Rule-2 escaping (QUERY-FORMAT.md section 3.2): a literal string that
// starts with '$' must be emitted with one extra leading '$'
function emitString(s) {
  return s.charCodeAt(0) === CC_DOLLAR ? '$' + s : s;
}

// member names foldable into RFC 9535 dot shorthand; everything else
// (NCNames with '-', '.', or non-ASCII) uses the bracketed name selector.
// NCNames can never contain a quote or backslash, so no escaping needed.
const SHORTHAND_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `{"$seq": []}` - the emitted form of '()' (used to fold `else ()`)
function isEmptySeqExpr(e) {
  if (typeof e !== 'object' || e === null || Array.isArray(e))
    return false;
  const keys = Object.keys(e);
  return keys.length === 1 && keys[0] === '$seq'
    && Array.isArray(e.$seq) && e.$seq.length === 0;
}

// the variable a lookup on a sequence-valued base binds that base to; the
// wrapper's return is the lookup path alone, so nothing the user wrote is
// evaluated beneath the name
const LOOKUP_VAR = 'lk_base';

// A variable reference or a path folded from one: the emitted strings that
// start with a single '$' ('$$' escapes a literal string).
function isPathExpr(e) {
  return typeof e === 'string' && e.charCodeAt(0) === CC_DOLLAR && e.charCodeAt(1) !== CC_DOLLAR;
}

// the name of the variable a path expression reads, or undefined
const pathVariable = (e) => /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(e)?.[1];

// True when the emitted expression evaluates to at most one item whatever
// the input, so a lookup on it is exactly the single-item `$get`: literals,
// map and array constructors, `head`, any `$get` (a member is one item), and
// a conditional whose branches are such. Anything else may
// be a sequence, and a lookup on it is XQuery's per-item lookup.
function isAtMostOneItem(e) {
  if (typeof e === 'string')
    return !isPathExpr(e);
  if (e === null || typeof e !== 'object')
    return true;
  if (Array.isArray(e))
    return true;
  const keys = Object.keys(e);
  if (keys.length === 1) {
    if (keys[0] === '$head' || keys[0] === '$map' || keys[0] === '$get')
      return true;
    if (keys[0] === '$if')
      return e.$if.slice(1).every(isAtMostOneItem);
    if (keys[0] === '$seq')
      return e.$seq.length === 0;
  }
  return keys.every((k) => k.charCodeAt(0) !== CC_DOLLAR);
}

//#endregion

//#region parser

// XML NameChar, pragmatically: name start, digits, '-' and '.'
function isXmlNameCharCode(c) {
  return isNameCharCode(c) || c === CC_MINUS || c === CC_DOT;
}

/**
 * Parse XQuery 3.1 text (the supported subset, see XQUERY-FRONTEND.md)
 * into a Jaren JSON Query document.
 * @param {string} source - the XQuery text (e.g. `for $b in $doc?store?book?* return $b?title`)
 * @returns {any} a valid query document for `compileJsonQuery` (envelope omitted)
 * @throws {XQuerySyntaxError} when the text is invalid or uses a construct
 *   outside the subset (named `unsupported ...` messages), or when it nests
 *   deeper than the query compiler's ceiling of 256 levels
 */
export function parseXQuery(source) {
  if (typeof source !== 'string')
    throw new XQuerySyntaxError('query must be a string', String(source), 0);

  const len = source.length;
  let pos = 0;
  // expression nesting: every ExprSingle, and every phrase a FLWOR's
  // clauses nest into, is one level of the emitted document
  let depth = 0;
  // where the first argument of the fn:error call being read starts: a
  // QName constructor there is the code it raises (-1 outside one)
  let errorCodeAt = -1;

  function fail(message, at = pos) {
    throw new XQuerySyntaxError(message, source, at);
  }

  // One level deeper; past the ceiling the text is refused by position
  // rather than by a stack overflow further down the recursive descent.
  // Not an `unsupported ...` message: nothing outside the subset is used.
  function enter(at) {
    if (++depth > NESTING_CEILING)
      fail(`the expression nests deeper than ${NESTING_CEILING} levels`, at);
  }

  //#region static date types

  // A date value is the RFC 3339 string the engine holds (section 4.9),
  // so every operator would read it as a string; XQuery reads it by its
  // type and raises where a string would answer. The parser types every
  // expression that can carry one: 'date', 'dateTime' or 'time' (its
  // values are of that type, if any), 'none' (no date value), 'empty',
  // 'nested' (an array or a map holding a date value) or 'maybe' (a date
  // value may be among its items). A use XQuery types as an error raises
  // XQuery's code when it is evaluated; a use whose operand may or may not
  // be a date is refused by name.
  const scope = new Map();
  const shadowed = [];

  function bind(name, type) {
    shadowed.push([name, scope.get(name)]);
    scope.set(name, type);
  }

  function unbindTo(mark) {
    while (shadowed.length > mark) {
      const [name, previous] = shadowed.pop();
      if (previous === undefined)
        scope.delete(name);
      else
        scope.set(name, previous);
    }
  }

  function joinTypes(a, b) {
    if (a === b || b === 'empty')
      return a;
    if (a === 'empty')
      return b;
    if (a === 'maybe' || b === 'maybe' || isDateTypeName(a) || isDateTypeName(b))
      return 'maybe';
    return a === 'nested' || b === 'nested' ? 'nested' : 'none';
  }

  const holdsDates = (t) => t !== 'none' && t !== 'empty';

  function typeOf(e) {
    if (typeof e === 'string') {
      if (e.charCodeAt(0) !== CC_DOLLAR || e.charCodeAt(1) === CC_DOLLAR)
        return 'none';
      const name = pathVariable(e);
      if (name === undefined)
        return 'none';
      const type = scope.get(name) ?? 'none';
      // a lookup into a date value or a container of one
      return e.length === name.length + 1 || !holdsDates(type) ? type : 'maybe';
    }
    if (Array.isArray(e))
      return e.some((member) => holdsDates(typeOf(member))) ? 'nested' : 'none';
    if (e === null || typeof e !== 'object')
      return 'none';
    const registered = DATE_TYPES.get(e);
    if (registered !== undefined)
      return registered;
    if (isEmptySeqExpr(e))
      return 'empty';
    if (hasOwn(e, '$seq'))
      return e.$seq.reduce((type, item) => joinTypes(type, typeOf(item)), 'empty');
    if (hasOwn(e, '$if'))
      return joinTypes(typeOf(e.$if[1]), e.$if.length === 3 ? typeOf(e.$if[2]) : 'empty');
    if (hasOwn(e, '$get'))
      return holdsDates(typeOf(e.$get[0])) ? 'maybe' : 'none';
    if (hasOwn(e, '$let') && hasOwn(e.$let, LOOKUP_VAR))
      return holdsDates(typeOf(e.$let[LOOKUP_VAR])) ? 'maybe' : 'none';
    // it never gives a value, so it joins as the empty sequence does
    if (hasOwn(e, '$error'))
      return 'empty';
    const keys = Object.keys(e);
    if (keys.length > 0 && keys.every((key) => key.charCodeAt(0) !== CC_DOLLAR))
      return keys.some((key) => holdsDates(typeOf(e[key]))) ? 'nested' : 'none';
    return 'none';
  }

  // the type of one item a `for` binds: an array's members are its items (D4)
  function itemTypeOf(e) {
    const type = typeOf(e);
    return type === 'nested' ? 'maybe' : type;
  }

  // the static types of `operands`, refused by name (`use`) when one may or
  // may not hold a date value
  function operandTypes(operands, use, at) {
    const types = operands.map(typeOf);
    if (types.includes('maybe'))
      fail(`unsupported construct '${use} of a value that may be a date'`, at);
    return types;
  }

  // `original`, raising XQuery's `code` where it is evaluated with every one
  // of `operands` non-empty (`all`) or any one of them (`!all`), the message
  // `says(type)`; refused by name (`use`) when an operand may or may not hold
  // a date value. Each operand is emitted once, so a guard nested in a guard
  // grows the document by a constant: with `all`, `original` holds nothing
  // but the operands, which are bound once to TYPED_VAR; without, a date
  // operand that passes the test is the empty sequence, which `original`
  // reads in its place.
  function typed(original, operands, { code, use, says, at, all = false }) {
    const types = operandTypes(operands, use, at);
    const dates = operands.filter((_, i) => isDateTypeName(types[i]));
    if (dates.length === 0)
      return original;
    const raise = raisedWith(xqueryCode(code), `${says(types.find(isDateTypeName))} (position ${at})`);
    if (all)
      return withOperands(TYPED_VAR, operands, (refs) => ({
        '$if': [
          { '$and': refs.map((ref) => ({ '$exists': ref })) },
          raise,
          replaced(original, new Map(operands.map((e, i) => [e, refs[i]]))),
        ],
      }));
    const tests = dates.map((e) => ({ '$exists': e }));
    // a variable reference stays: it is short, and a name it spells may be
    // bound again within `original`
    const objects = dates.filter((e) => e !== null && typeof e === 'object');
    return {
      '$if': [
        tests.length === 1 ? tests[0] : { '$or': tests },
        raise,
        replaced(original, new Map(objects.map((e) => [e, { '$seq': [] }]))),
      ],
    };
  }

  // `original`, which reads the effective boolean value of `operand`
  // (FORG0006 for a date value)
  const readsEbv = (original, operand, at) => typed(original, [operand], {
    code: 'FORG0006', use: 'the effective boolean value', at, says: (type) => `an xs:${type} has no effective boolean value`,
  });

  const ebv = (e, at) => readsEbv(e, e, at);

  //#endregion

  function cc(at) {
    return at < len ? source.charCodeAt(at) : -1;
  }

  // whitespace and nestable (: ... :) comments (XQuery A.2.1 ws:explicit
  // does not occur in the subset, so comments are legal between any two
  // tokens and are handled uniformly here)
  function skipWS() {
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR) {
        pos++;
        continue;
      }
      if (c === CC_LPAREN && cc(pos + 1) === CC_COLON) {
        const start = pos;
        pos += 2;
        let depth = 1;
        while (depth > 0) {
          if (pos >= len)
            fail('unterminated comment', start);
          const d = source.charCodeAt(pos);
          if (d === CC_LPAREN && cc(pos + 1) === CC_COLON) {
            depth++;
            pos += 2;
          }
          else if (d === CC_COLON && cc(pos + 1) === CC_RPAREN) {
            depth--;
            pos += 2;
          }
          else {
            pos++;
          }
        }
        continue;
      }
      break;
    }
  }

  //#region scalar tokens

  function parseNCName() {
    const start = pos;
    if (!isNameStartCode(cc(pos)))
      fail('expected a name');
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c >= 0xD800 && c <= 0xDFFF) {
        // raw surrogates must form a well-formed pair
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in name');
        pos += 2;
        continue;
      }
      if (!isXmlNameCharCode(c))
        break;
      pos++;
    }
    return source.slice(start, pos);
  }

  // reads the NCName at pos when it equals `word` (consuming it),
  // returning its start position; -1 otherwise (nothing consumed)
  function tryKeyword(word) {
    const save = pos;
    skipWS();
    if (isNameStartCode(cc(pos))) {
      const at = pos;
      if (parseNCName() === word)
        return at;
    }
    pos = save;
    return -1;
  }

  function expectKeyword(word) {
    skipWS();
    const at = pos;
    if (!isNameStartCode(cc(pos)) || parseNCName() !== word)
      fail(`expected '${word}'`, at);
  }

  // variable name after a consumed '$' ('$' is a delimiting terminal, so
  // whitespace and comments may separate it from the name): an NCName
  // restricted to the JSON format's variable lexeme [A-Za-z_][A-Za-z0-9_]*
  // (JQ0003 rule) - an NCName like `foo-bar` or `a.b` is valid XQuery but
  // cannot map
  function parseVarName() {
    skipWS();
    const at = pos;
    const name = parseNCName();
    if (name === 'Q' && cc(pos) === CC_LBRACE)
      fail("unsupported construct 'URI-qualified name'", at);
    if (cc(pos) === CC_COLON && isNameStartCode(cc(pos + 1)))
      fail("unsupported construct 'namespaced variable'", at);
    if (!VAR_NAME_RE.test(name))
      fail(`unsupported variable name '${name}'`, at);
    return name;
  }

  // string literal, both quote kinds, doubled-quote escape; `&` character
  // and entity references are outside the subset
  function parseStringLiteral() {
    const quote = source.charCodeAt(pos);
    const start = pos;
    pos++;
    let out = '';
    let chunk = pos;
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (c === quote) {
        if (cc(pos + 1) === quote) { // '' / "" escape
          out += source.slice(chunk, pos + 1);
          pos += 2;
          chunk = pos;
          continue;
        }
        out += source.slice(chunk, pos);
        pos++;
        return out;
      }
      if (c === CC_AMP)
        fail("unsupported construct 'character reference'", pos);
      if (c >= 0xD800 && c <= 0xDFFF) {
        const d = cc(pos + 1);
        if (c >= 0xDC00 || d < 0xDC00 || d > 0xDFFF)
          fail('lone surrogate in string literal');
        pos += 2;
        continue;
      }
      pos++;
    }
    return fail('unterminated string literal', start);
  }

  // IntegerLiteral | DecimalLiteral | DoubleLiteral (XQuery A.2 - unlike
  // JSON: leading zeros, '1.' and '.5' are all legal; no sign). The value
  // is emitted as a JSON number, so only the double's value survives.
  function parseNumberLiteral() {
    const start = pos;
    if (cc(pos) === CC_DOT) {
      pos++; // callers guarantee a digit follows
      while (isDigitCode(cc(pos)))
        pos++;
    }
    else {
      while (isDigitCode(cc(pos)))
        pos++;
      if (cc(pos) === CC_DOT) {
        pos++;
        while (isDigitCode(cc(pos)))
          pos++;
      }
    }
    const e = cc(pos);
    if (e === 0x65 || e === 0x45) { // e | E
      pos++;
      const s = cc(pos);
      if (s === CC_PLUS || s === CC_MINUS)
        pos++;
      if (!isDigitCode(cc(pos)))
        fail('expected a digit in the exponent');
      while (isDigitCode(cc(pos)))
        pos++;
    }
    // XQuery A.2.2: a numeric literal must not be followed directly by
    // '.' or a name start character (e.g. `10div 3` is not `10 div 3`)
    const n = cc(pos);
    if (n === CC_DOT || isNameStartCode(n))
      fail('a numeric literal must be followed by a delimiter');
    const value = Number(source.slice(start, pos));
    // an overflowing DoubleLiteral is a valid XQuery double (INF) but has
    // no JSON literal form - the parser must never emit an invalid document
    if (!Number.isFinite(value))
      fail("unsupported construct 'non-finite number literal'", start);
    return value;
  }

  //#endregion

  //#region expressions by precedence

  // Expr ::= ExprSingle ("," ExprSingle)* - the XQuery comma is $seq
  function parseExpr() {
    const first = parseExprSingle();
    skipWS();
    if (cc(pos) !== CC_COMMA)
      return first;
    const items = [first];
    while (cc(pos) === CC_COMMA) {
      pos++;
      items.push(parseExprSingle());
      skipWS();
    }
    return { '$seq': items };
  }

  // Every nested expression enters here, so this is where nesting is
  // counted against the ceiling.
  function parseExprSingle() {
    skipWS();
    enter(pos);
    const expr = parseExprSingleBody();
    depth--;
    return expr;
  }

  // ExprSingle ::= FLWORExpr | QuantifiedExpr | IfExpr | OrExpr
  // (SwitchExpr, TypeswitchExpr and TryCatchExpr are recognized and
  // rejected by name)
  function parseExprSingleBody() {
    skipWS();
    const at = pos;
    if (isNameStartCode(cc(pos))) {
      const save = pos;
      const ident = parseNCName();
      skipWS();
      const next = cc(pos);
      if (ident === 'for' || ident === 'let') {
        if (next === CC_DOLLAR)
          return parseFlwor(ident);
        if (ident === 'for' && isNameStartCode(next)) {
          const save2 = pos;
          const w = parseNCName();
          pos = save2;
          if (w === 'sliding' || w === 'tumbling')
            fail("unsupported construct 'window clause'", at);
        }
      }
      else if ((ident === 'some' || ident === 'every') && next === CC_DOLLAR) {
        return parseQuantified(ident);
      }
      else if (ident === 'if' && next === CC_LPAREN) {
        return parseIf();
      }
      else if ((ident === 'switch' || ident === 'typeswitch') && next === CC_LPAREN) {
        fail(`unsupported construct '${ident} expression'`, at);
      }
      else if (ident === 'try' && next === CC_LBRACE) {
        fail("unsupported construct 'try/catch expression'", at);
      }
      pos = save;
    }
    return parseOr();
  }

  function parseOr() {
    return parseLogical('or', '$or', parseAnd);
  }

  function parseAnd() {
    return parseLogical('and', '$and', parseComparison);
  }

  // `a or b ...` / `a and b ...`: each operand is read by its effective
  // boolean value
  function parseLogical(word, op, parseOperand) {
    skipWS();
    let at = pos;
    const first = parseOperand();
    let items = null;
    for (;;) {
      const save = pos;
      skipWS();
      if (isNameStartCode(cc(pos)) && parseNCName() === word) {
        if (items === null)
          items = [ebv(first, at)];
        skipWS();
        at = pos;
        items.push(ebv(parseOperand(), at));
        continue;
      }
      pos = save;
      return items === null ? first : { [op]: items };
    }
  }

  // ComparisonExpr ::= StringConcatExpr ((ValueComp | GeneralComp) StringConcatExpr)?
  // Value comparisons map onto the general-comparison operators (front-end
  // approximation); node comparisons (`is`, `<<`, `>>`) are unsupported.
  function parseComparison() {
    const left = parseStringConcat();
    const save = pos;
    skipWS();
    const at = pos;
    let op = null;
    const c = cc(pos);
    if (c === CC_EQ) {
      if (cc(pos + 1) === CC_GT)
        fail("unsupported construct 'arrow expression'", at);
      pos++;
      op = '$eq';
    }
    else if (c === CC_BANG) {
      if (cc(pos + 1) !== CC_EQ)
        fail("unsupported construct 'simple map operator'", at);
      pos += 2;
      op = '$ne';
    }
    else if (c === CC_LT) {
      if (cc(pos + 1) === CC_LT)
        fail("unsupported construct 'node comparison'", at);
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        op = '$le';
      }
      else {
        pos++;
        op = '$lt';
      }
    }
    else if (c === CC_GT) {
      if (cc(pos + 1) === CC_GT)
        fail("unsupported construct 'node comparison'", at);
      if (cc(pos + 1) === CC_EQ) {
        pos += 2;
        op = '$ge';
      }
      else {
        pos++;
        op = '$gt';
      }
    }
    else if (isNameStartCode(c)) {
      const ident = parseNCName();
      if (hasOwn(VALUE_COMPS, ident))
        op = VALUE_COMPS[ident];
      else if (ident === 'is')
        fail("unsupported construct 'node comparison'", at);
      else {
        pos = save;
        return left;
      }
    }
    else {
      pos = save;
      return left;
    }
    skipWS();
    const right = parseStringConcat();
    // the arrow binds tighter than a comparison, so '=>' after the right-hand
    // side is an arrow expression on it
    const afterRight = pos;
    skipWS();
    if (cc(pos) === CC_EQ && cc(pos + 1) === CC_GT)
      fail("unsupported construct 'arrow expression'", pos);
    pos = afterRight;
    const comparison = { [op]: [left, right] };
    // two values of one date type compare in time order; a date value and
    // any other value is XPTY0004
    const leftType = typeOf(left);
    if (isDateTypeName(leftType) && leftType === typeOf(right))
      return comparison;
    return typed(comparison, [left, right], {
      code: 'XPTY0004', use: 'a comparison', at, all: true, says: (type) => `an xs:${type} compares only with an xs:${type}`,
    });
  }

  // StringConcatExpr ::= RangeExpr ("||" RangeExpr)* - variadic $concat.
  // A single '|' is the (unsupported) union operator.
  function parseStringConcat() {
    const first = parseRange();
    let items = null;
    for (;;) {
      const save = pos;
      skipWS();
      if (cc(pos) === CC_PIPE) {
        if (cc(pos + 1) === CC_PIPE) {
          pos += 2;
          if (items === null)
            items = [first];
          items.push(parseRange());
          continue;
        }
        fail("unsupported construct 'union expression'");
      }
      pos = save;
      return items === null ? first : { '$concat': items };
    }
  }

  // RangeExpr ::= AdditiveExpr ("to" AdditiveExpr)?
  function parseRange() {
    const first = parseAdditive();
    const save = pos;
    skipWS();
    if (isNameStartCode(cc(pos)) && parseNCName() === 'to')
      return { '$range': [first, parseAdditive()] };
    pos = save;
    return first;
  }

  function parseAdditive() {
    let expr = parseMultiplicative();
    for (;;) {
      const save = pos;
      skipWS();
      const c = cc(pos);
      if (c === CC_PLUS) {
        pos++;
        expr = { '$add': [expr, parseMultiplicative()] };
        continue;
      }
      if (c === CC_MINUS) {
        const at = pos;
        pos++;
        const right = parseMultiplicative();
        // XQuery subtracts two dates into a duration, a type outside the
        // subset; every other date operand is XPTY0004, which `$sub` raises
        if (isDateOrMaybe(typeOf(expr)) && isDateOrMaybe(typeOf(right)))
          fail("unsupported construct 'date arithmetic'", at);
        expr = { '$sub': [expr, right] };
        continue;
      }
      pos = save;
      return expr;
    }
  }

  // MultiplicativeExpr ::= CastableExpr (("*" | "div" | "idiv" | "mod") CastableExpr)*
  // The other grammar levels between multiplicative and castable (union,
  // intersect, except, instance of, treat as) are outside the subset and
  // rejected here by name.
  function parseMultiplicative() {
    let expr = parseCastable();
    for (;;) {
      const save = pos;
      skipWS();
      const at = pos;
      const c = cc(pos);
      if (c === CC_STAR) {
        pos++;
        expr = { '$mul': [expr, parseCastable()] };
        continue;
      }
      if (isNameStartCode(c)) {
        const ident = parseNCName();
        if (ident === 'div') {
          expr = { '$div': [expr, parseCastable()] };
          continue;
        }
        if (ident === 'idiv') {
          expr = { '$idiv': [expr, parseCastable()] };
          continue;
        }
        if (ident === 'mod') {
          expr = { '$mod': [expr, parseCastable()] };
          continue;
        }
        if (ident === 'instance')
          fail("unsupported construct 'instance of'", at);
        if (ident === 'treat')
          fail("unsupported construct 'treat as'", at);
        // one cast and one castable at most, in that order (XPST0003)
        if (ident === 'castable' || ident === 'cast')
          fail(`unexpected '${ident}' after a cast or castable expression`, at);
        if (ident === 'union' || ident === 'intersect' || ident === 'except')
          fail(`unsupported construct '${ident} expression'`, at);
      }
      pos = save;
      return expr;
    }
  }

  // CastableExpr ::= CastExpr ("castable" "as" SingleType)?
  // CastExpr ::= UnaryExpr ("cast" "as" SingleType)?
  // (the arrow level between cast and unary is outside the subset)
  function parseCastable() {
    let expr = parseUnary();
    let at = tryKeyword('cast');
    if (at !== -1) {
      const type = parseSingleType('cast as');
      expr = castTo(type.name, expr, type.emptyAllowed, (message) => fail(message, at), typeOf(expr));
    }
    at = tryKeyword('castable');
    if (at !== -1) {
      const type = parseSingleType('castable as');
      expr = castableAs(type.name, expr, type.emptyAllowed, (message) => fail(message, at), typeOf(expr));
    }
    return expr;
  }

  // SingleType ::= SimpleTypeName "?"?, after a consumed `cast` or
  // `castable`: an `xs:` type the JSON model has a value for (XS_TYPES);
  // any other type is refused by name. `?` admits the empty sequence.
  function parseSingleType(construct) {
    expectKeyword('as');
    skipWS();
    const at = pos;
    let name = parseNCName();
    if (name === 'Q' && cc(pos) === CC_LBRACE)
      fail("unsupported construct 'URI-qualified name'", at);
    let written = name;
    let prefix = null;
    if (cc(pos) === CC_COLON && isNameStartCode(cc(pos + 1))) {
      pos++;
      prefix = name;
      name = parseNCName();
      written = prefix + ':' + name;
    }
    if (prefix !== 'xs' || !hasOwn(XS_TYPES, name))
      fail(`unsupported construct '${construct} ${written}'`, at);
    const save = pos;
    skipWS();
    if (cc(pos) === CC_QUESTION) {
      pos++;
      return { name, emptyAllowed: true };
    }
    pos = save;
    return { name, emptyAllowed: false };
  }

  // UnaryExpr ::= ("-" | "+")* ValueExpr. Unary '+' is a no-op in this
  // mapping; each '-' emits $neg, folding into number literals directly.
  function parseUnary() {
    skipWS();
    let c = cc(pos);
    if (c === CC_MINUS || c === CC_PLUS) {
      const at = pos;
      let negs = 0;
      while (c === CC_MINUS || c === CC_PLUS) {
        if (c === CC_MINUS)
          negs++;
        pos++;
        skipWS();
        c = cc(pos);
      }
      let expr = parsePostfix();
      // unary minus is `$neg`, which raises on a date; unary plus emits
      // nothing, so a date operand is raised here (XPTY0004)
      if (negs === 0)
        return typed(expr, [expr], { code: 'XPTY0004', use: 'unary plus', at, says: (type) => `unary plus takes a number, not an xs:${type}` });
      for (let i = 0; i < negs; i++)
        expr = typeof expr === 'number' ? -expr : { '$neg': expr };
      return expr;
    }
    return parsePostfix();
  }

  //#endregion

  //#region postfix lookups & path folding

  // postfix operators outside the subset, each with a named error
  function checkUnsupportedPostfix(c) {
    if (c === CC_LPAREN)
      fail("unsupported construct 'dynamic function call'");
    if (c === CC_LBRACKET)
      fail("unsupported construct 'predicate'");
    if (c === CC_HASH)
      fail("unsupported construct 'named function reference'");
    if (c === CC_SLASH)
      fail("unsupported construct 'path expression'");
  }

  // '?' consumed: KeySpecifier ::= NCName | IntegerLiteral | "*"
  // (a ParenthesizedExpr key is outside the subset)
  function parseLookupKey() {
    skipWS();
    const c = cc(pos);
    if (c === CC_STAR) {
      pos++;
      return STAR_KEY;
    }
    if (isDigitCode(c))
      return { index: parseLookupIndex() };
    if (isNameStartCode(c))
      return { name: parseNCName() };
    if (c === CC_LPAREN)
      fail("unsupported construct 'parenthesized lookup key'");
    return fail('expected a lookup key');
  }

  function parseLookupIndex() {
    const at = pos;
    while (isDigitCode(cc(pos)))
      pos++;
    if (cc(pos) === CC_DOT || isNameStartCode(cc(pos)))
      fail('expected an integer lookup key', at);
    const n = Number(source.slice(at, pos));
    if (!Number.isSafeInteger(n))
      fail('integer out of interoperable range', at);
    if (n === 0)
      fail('unsupported lookup index 0 (XQuery arrays are 1-based)', at);
    return n - 1; // 1-based XQuery -> 0-based RFC 9535 (D6)
  }

  // The path segment one lookup key adds to a variable-rooted path string
  function lookupSegment(key) {
    if (key === STAR_KEY)
      return '[*]';
    if (hasOwn(key, 'index'))
      return '[' + key.index + ']';
    return SHORTHAND_RE.test(key.name) ? '.' + key.name : "['" + key.name + "']";
  }

  // PostfixExpr. A lookup applies to every item of its base, so a chain
  // folds into one variable-rooted RFC 9535 path string: `$b?price?1`
  // becomes "$b.price[0]". A base that is at most one item keeps the
  // single-item `$get` (`map{...}?a`); any other base is bound once and the
  // whole chain becomes a path over that binding. Unary lookup (`?name` on
  // the context item) is outside the subset via parsePrimary.
  function parsePostfix() {
    skipWS();
    let expr;
    if (cc(pos) === CC_DOLLAR) {
      pos++;
      expr = '$' + parseVarName();
    }
    else {
      expr = parsePrimary();
    }
    let bound; // the base a wrapped chain applies to
    for (;;) {
      const save = pos;
      skipWS();
      const c = cc(pos);
      if (c === CC_QUESTION) {
        pos++;
        const key = parseLookupKey();
        if (isPathExpr(expr)) {
          expr += lookupSegment(key);
        }
        else if (key !== STAR_KEY && isAtMostOneItem(expr)) {
          expr = { '$get': [expr, hasOwn(key, 'index') ? key.index : key.name] };
        }
        else {
          bound = expr;
          expr = '$' + LOOKUP_VAR + lookupSegment(key);
        }
        continue;
      }
      checkUnsupportedPostfix(c);
      pos = save;
      return bound === undefined ? expr : { '$let': { [LOOKUP_VAR]: bound }, '$return': expr };
    }
  }

  //#endregion

  //#region primary expressions

  function parsePrimary() {
    skipWS();
    const at = pos;
    const c = cc(pos);
    if (c === CC_SQUOTE || c === CC_DQUOTE)
      return emitString(parseStringLiteral());
    if (isDigitCode(c))
      return parseNumberLiteral();
    if (c === CC_DOT) {
      if (isDigitCode(cc(pos + 1)))
        return parseNumberLiteral();
      if (cc(pos + 1) === CC_DOT)
        fail("unsupported construct 'path expression'", at);
      fail("unsupported construct 'context item expression'", at);
    }
    if (c === CC_LPAREN)
      return parseParenthesized();
    if (c === CC_LBRACKET)
      return parseSquareArray();
    if (c === CC_QUESTION)
      fail("unsupported construct 'unary lookup'", at);
    if (c === CC_SLASH || c === CC_AT || c === CC_STAR)
      fail("unsupported construct 'path expression'", at);
    if (c === CC_LT)
      fail("unsupported construct 'node constructor'", at);
    if (c === CC_BACKTICK)
      fail("unsupported construct 'string constructor'", at);
    if (isNameStartCode(c))
      return parseNamedPrimary(at);
    return fail('expected an expression');
  }

  function parseParenthesized() {
    pos++; // consume '('
    skipWS();
    if (cc(pos) === CC_HASH)
      fail("unsupported construct 'pragma'", pos - 1);
    if (cc(pos) === CC_RPAREN) {
      pos++;
      return { '$seq': [] }; // '()' - the empty sequence
    }
    const expr = parseExpr();
    skipWS();
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    return expr;
  }

  // SquareArrayConstructor `[a, b]`: each member expression becomes one
  // array-constructor element. The JSON array constructor flattens each
  // element's sequence, so a non-singleton member deviates from XQuery's
  // sequence-valued members (which JSON cannot hold) - documented.
  function parseSquareArray() {
    pos++; // consume '['
    skipWS();
    if (cc(pos) === CC_RBRACKET) {
      pos++;
      return [];
    }
    const items = [];
    for (;;) {
      items.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RBRACKET) {
        pos++;
        return items;
      }
      fail("expected ',' or ']'");
    }
  }

  // CurlyArrayConstructor `array { E }`: the enclosed expression's
  // sequence flattens into the members - exactly the JSON array
  // constructor's behavior.
  function parseCurlyArray() {
    pos++; // consume '{'
    skipWS();
    if (cc(pos) === CC_RBRACE) {
      pos++;
      return [];
    }
    const items = [parseExprSingle()];
    for (;;) {
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        items.push(parseExprSingle());
        continue;
      }
      if (c === CC_RBRACE) {
        pos++;
        return items;
      }
      fail("expected ',' or '}'");
    }
  }

  // MapConstructor `map { K : V, ... }`: a plain-object map constructor
  // when every key is a string literal without a leading '$', else the
  // general `$map` form (computed keys evaluate at runtime, JQ2004).
  // Static keys that can never be strings, and duplicate literal keys
  // (XQDY0137), are rejected at parse time.
  function parseMapConstructor() {
    pos++; // consume '{'
    skipWS();
    if (cc(pos) === CC_RBRACE) {
      pos++;
      return {};
    }
    const keys = [];
    const values = [];
    const literals = []; // the literal string value per key, or null
    const seen = new Set();
    for (;;) {
      skipWS();
      const keyAt = pos;
      const literal = (cc(pos) === CC_SQUOTE || cc(pos) === CC_DQUOTE);
      const key = parseExprSingle();
      const scalarKey = typeof key === 'number' || typeof key === 'boolean' || key === null;
      if (scalarKey || Array.isArray(key))
        fail("unsupported construct 'non-string map key'", keyAt);
      if (literal && typeof key === 'string') {
        // a quoted key that parsed to a bare string is a literal (a
        // leading '$' would have been '$$'-escaped by emitString)
        const raw = key.charCodeAt(0) === CC_DOLLAR ? key.slice(1) : key;
        if (seen.has(raw))
          fail(`duplicate map key '${raw}'`, keyAt);
        seen.add(raw);
        literals.push(raw);
      }
      else {
        literals.push(null);
      }
      skipWS();
      if (cc(pos) !== CC_COLON)
        fail("expected ':'");
      pos++;
      keys.push(key);
      values.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RBRACE) {
        pos++;
        break;
      }
      fail("expected ',' or '}'");
    }
    let plain = true;
    for (let i = 0; i < keys.length; i++) {
      if (literals[i] === null || literals[i].charCodeAt(0) === CC_DOLLAR) {
        plain = false;
        break;
      }
    }
    if (plain) {
      const out = {};
      for (let i = 0; i < keys.length; i++)
        setObjectMember(out, keys[i], values[i]);
      return out;
    }
    const pairs = new Array(keys.length);
    for (let i = 0; i < keys.length; i++)
      pairs[i] = [keys[i], values[i]];
    return { '$map': pairs };
  }

  function parseNamedPrimary(at) {
    let name = parseNCName();
    let written = name;
    let prefix = null;
    if (cc(pos) === CC_COLON && isNameStartCode(cc(pos + 1))) {
      pos++;
      prefix = name;
      name = parseNCName();
      written = prefix + ':' + name;
    }
    skipWS();
    const next = cc(pos);
    if (next === CC_LPAREN) {
      if (prefix === null && name === 'function')
        fail("unsupported construct 'inline function expression'", at);
      pos++; // consume '('
      const isCode = at === errorCodeAt;
      let args;
      if ((prefix === null || prefix === 'fn') && name === 'error') {
        const outer = errorCodeAt;
        skipWS();
        errorCodeAt = pos;
        args = parseArguments();
        errorCodeAt = outer;
      }
      else {
        args = parseArguments();
      }
      if (isCode && name === 'QName' && (prefix === null || prefix === 'fn' || prefix === 'xs'))
        return emitQName(prefix === 'xs', written, args, (message) => fail(message, at));
      return emitFunctionCall(prefix, name, written, args, at);
    }
    if (next === CC_HASH)
      fail("unsupported construct 'named function reference'", at);
    if (next === CC_LBRACE && prefix === null) {
      if (name === 'map')
        return parseMapConstructor();
      if (name === 'array')
        return parseCurlyArray();
      if (NODE_CTOR_KEYWORDS.has(name))
        fail("unsupported construct 'computed node constructor'", at);
      if (name === 'ordered' || name === 'unordered')
        fail(`unsupported construct '${name} expression'`, at);
      if (name === 'validate')
        fail("unsupported construct 'validate expression'", at);
    }
    if (prefix === null && name === 'function')
      fail("unsupported construct 'inline function expression'", at);
    if (prefix === null && EXPR_KEYWORDS.has(name) && followedByKeywordRole())
      fail(`unexpected keyword '${name}'`, at);
    // a bare (or prefixed) name in expression position is an axis step
    return fail("unsupported construct 'path expression'", at);
  }

  // true when the next token shows that a keyword-named name was meant as a
  // keyword: a variable reference, a number or a string literal, or a word
  // that is not an operator. A name test is followed by the end, a closer or
  // an operator, never by one of those.
  function followedByKeywordRole() {
    const c = cc(pos);
    if (c === CC_DOLLAR || c === CC_DQUOTE || c === CC_SQUOTE || isDigitCode(c))
      return true;
    if (!isNameStartCode(c))
      return false;
    const save = pos;
    const word = parseNCName();
    pos = save;
    return !OPERATOR_WORDS.has(word);
  }

  function parseArguments() {
    skipWS();
    if (cc(pos) === CC_RPAREN) {
      pos++;
      return [];
    }
    const args = [];
    for (;;) {
      skipWS();
      if (cc(pos) === CC_QUESTION) {
        // a bare '?' argument is a partial-application placeholder
        const at = pos;
        const save = pos;
        pos++;
        skipWS();
        const c = cc(pos);
        pos = save;
        if (c === CC_COMMA || c === CC_RPAREN)
          fail("unsupported construct 'argument placeholder'", at);
        fail("unsupported construct 'unary lookup'", at);
      }
      args.push(parseExprSingle());
      skipWS();
      const c = cc(pos);
      if (c === CC_COMMA) {
        pos++;
        continue;
      }
      if (c === CC_RPAREN) {
        pos++;
        return args;
      }
      fail("expected ',' or ')'");
    }
  }

  function emitFunctionCall(prefix, local, written, args, at) {
    let table;
    if (prefix === null || prefix === 'fn')
      table = FN_TABLE;
    else if (prefix === 'map')
      table = MAP_FN_TABLE;
    else if (prefix === 'array')
      table = ARRAY_FN_TABLE;
    else if (prefix === 'xs')
      table = XS_TABLE;
    else
      return fail(`unsupported function '${written}'`, at);
    if (!hasOwn(table, local))
      return fail(`unsupported function '${written}'`, at);
    const def = table[local];
    if (args.length < def.min || args.length > def.max)
      return fail(`unsupported function '${written}#${args.length}'`, at);
    const types = args.map(typeOf);
    if (table === FN_TABLE && hasOwn(COMPARED_ARGUMENTS, local))
      operandTypes(COMPARED_ARGUMENTS[local].map((i) => args[i]), `fn:${local}`, at);
    let out = def.emit(args, (message) => fail(message, at), types);
    if (table !== FN_TABLE)
      return out;
    const items = ITEM_ARGUMENTS[local];
    if (items !== undefined && out !== null && typeof out === 'object')
      DATE_TYPES.set(out, items.reduce((type, i) => (i < args.length ? joinTypes(type, types[i]) : type), 'empty'));
    const strings = (STRING_ARGUMENTS[local] ?? []).filter((i) => i < args.length).map((i) => args[i]);
    if (strings.length > 0)
      out = typed(out, strings, {
        code: 'XPTY0004', use: `a string argument of fn:${local}`, at, says: (type) => `fn:${local} takes a string, not an xs:${type}`,
      });
    if (local === 'boolean' || local === 'not')
      out = readsEbv(out, args[0], at);
    return out;
  }

  //#endregion

  //#region if, quantifiers

  // IfExpr ::= "if" "(" Expr ")" "then" ExprSingle "else" ExprSingle
  // (`else ()` folds to the two-argument $if form)
  function parseIf() {
    pos++; // consume '('
    skipWS();
    const condAt = pos;
    const cond = ebv(parseExpr(), condAt);
    skipWS();
    if (cc(pos) !== CC_RPAREN)
      fail("expected ')'");
    pos++;
    expectKeyword('then');
    const thenExpr = parseExprSingle();
    expectKeyword('else');
    const elseExpr = parseExprSingle();
    if (isEmptySeqExpr(elseExpr))
      return { '$if': [cond, thenExpr] };
    return { '$if': [cond, thenExpr, elseExpr] };
  }

  // QuantifiedExpr ::= ("some" | "every") "$" VarName "in" ExprSingle
  //                    ("," "$" VarName "in" ExprSingle)* "satisfies" ExprSingle
  // Distinct names merge into one binding object; a repeated name starts
  // a nested quantifier phrase (XQuery shadowing; one binding object
  // cannot bind a name twice - JQ0007). Nesting quantifiers of the same
  // polarity is equivalent to one quantifier over the combined tuples.
  function parseQuantified(kw) {
    const key = kw === 'some' ? '$some' : '$every';
    const bindings = [];
    const mark = shadowed.length;
    for (;;) {
      skipWS();
      if (cc(pos) !== CC_DOLLAR)
        fail(`expected '$' after '${kw}'`);
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      expectKeyword('in');
      const expr = parseExprSingle();
      bind(name, itemTypeOf(expr));
      bindings.push([name, expr]);
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    expectKeyword('satisfies');
    skipWS();
    const condAt = pos;
    const cond = ebv(parseExprSingle(), condAt);
    unbindTo(mark);
    const groups = [];
    let group = {};
    for (let i = 0; i < bindings.length; i++) {
      const name = bindings[i][0];
      if (hasOwn(group, name)) {
        groups.push(group);
        group = {};
      }
      setObjectMember(group, name, bindings[i][1]);
    }
    groups.push(group);
    let out = cond;
    for (let i = groups.length - 1; i >= 0; i--)
      out = { [key]: groups[i], '$satisfies': out };
    return out;
  }

  // 'as SequenceType' declarations are outside the subset everywhere
  function checkTypeDeclaration() {
    const at = tryKeyword('as');
    if (at >= 0)
      fail("unsupported construct 'type declaration'", at);
  }

  //#endregion

  //#region FLWOR

  // FLWORExpr ::= (ForClause | LetClause) IntermediateClause* ReturnClause.
  // Clauses parse into a flat list in source order; assembleFlwor packs
  // them into (possibly nested) JSON FLWOR phrases.
  function parseFlwor(firstKw) {
    const clauses = [];
    const mark = shadowed.length;
    parseBindingClause(firstKw, clauses);
    for (;;) {
      skipWS();
      const at = pos;
      if (!isNameStartCode(cc(pos)))
        fail('expected a FLWOR clause');
      const kw = parseNCName();
      if (kw === 'for' || kw === 'let') {
        requireDollar(kw, at);
        parseBindingClause(kw, clauses);
        continue;
      }
      if (kw === 'where') {
        skipWS();
        const exprAt = pos;
        clauses.push({ kind: 'where', expr: ebv(parseExprSingle(), exprAt), at });
        continue;
      }
      if (kw === 'group') {
        expectKeyword('by');
        parseGroupByClause(clauses, at);
        continue;
      }
      if (kw === 'stable') {
        expectKeyword('order');
        expectKeyword('by');
        parseOrderByClause(clauses, at);
        continue;
      }
      if (kw === 'order') {
        expectKeyword('by');
        parseOrderByClause(clauses, at);
        continue;
      }
      if (kw === 'count') {
        skipWS();
        if (cc(pos) !== CC_DOLLAR)
          fail("expected '$' after 'count'");
        pos++;
        const name = parseVarName();
        bind(name, 'none');
        clauses.push({ kind: 'count', name, at });
        continue;
      }
      if (kw === 'return') {
        const ret = parseExprSingle();
        const type = typeOf(ret);
        unbindTo(mark);
        const flwor = assembleFlwor(clauses, ret);
        if (flwor !== ret && flwor !== null && typeof flwor === 'object')
          DATE_TYPES.set(flwor, type);
        return flwor;
      }
      return fail(`expected a FLWOR clause, got '${kw}'`, at);
    }
  }

  function requireDollar(kw, clauseAt) {
    skipWS();
    if (cc(pos) === CC_DOLLAR)
      return;
    if (kw === 'for' && isNameStartCode(cc(pos))) {
      const save = pos;
      const w = parseNCName();
      pos = save;
      if (w === 'sliding' || w === 'tumbling')
        fail("unsupported construct 'window clause'", clauseAt);
    }
    fail(`expected '$' after '${kw}'`);
  }

  // ForClause / LetClause with comma-separated bindings; each binding
  // becomes one clause entry (a multi-binding clause and consecutive
  // clauses of the same kind are equivalent - both merge when packed)
  function parseBindingClause(kind, clauses) {
    for (;;) {
      skipWS();
      const at = pos;
      if (cc(pos) !== CC_DOLLAR)
        fail(`expected '$' after '${kind}'`);
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      if (kind === 'for') {
        const allowingAt = tryKeyword('allowing');
        if (allowingAt >= 0)
          fail("unsupported construct 'allowing empty'", allowingAt);
        let atName = null;
        if (tryKeyword('at') >= 0) {
          skipWS();
          if (cc(pos) !== CC_DOLLAR)
            fail("expected '$' after 'at'");
          pos++;
          skipWS();
          const atNameAt = pos;
          atName = parseVarName();
          if (atName === name)
            fail(`duplicate variable '$${name}'`, atNameAt);
        }
        expectKeyword('in');
        const expr = parseExprSingle();
        bind(name, itemTypeOf(expr));
        if (atName !== null)
          bind(atName, 'none');
        clauses.push({ kind: 'for', name, atName, expr, at });
      }
      else {
        skipWS();
        if (cc(pos) !== CC_COLON || cc(pos + 1) !== CC_EQ)
          fail("expected ':='");
        pos += 2;
        const expr = parseExprSingle();
        bind(name, typeOf(expr));
        clauses.push({ kind: 'let', name, expr, at });
      }
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      return;
    }
  }

  // GroupByClause: only the `group by $new := expr` form maps - the JSON
  // $groupby key is always a fresh grouping variable (JQ0007 forbids
  // rebinding); the bare `group by $x` form is outside the subset
  function parseGroupByClause(clauses, at) {
    const keys = [];
    for (;;) {
      skipWS();
      const bindAt = pos;
      if (cc(pos) !== CC_DOLLAR)
        fail("expected '$' after 'group by'");
      pos++;
      const name = parseVarName();
      checkTypeDeclaration();
      skipWS();
      if (cc(pos) !== CC_COLON || cc(pos + 1) !== CC_EQ)
        fail("unsupported construct 'group by' binding without ':='", bindAt);
      pos += 2;
      skipWS();
      const exprAt = pos;
      const expr = parseExprSingle();
      const collationAt = tryKeyword('collation');
      if (collationAt >= 0)
        fail("unsupported construct 'collation'", collationAt);
      // a date and a value of another type are two keys, where the engine
      // would compare their texts
      bind(name, operandTypes([expr], 'a group by key', exprAt)[0]);
      keys.push({ name, expr, at: bindAt });
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    clauses.push({ kind: 'groupby', keys, at });
  }

  // OrderByClause: OrderSpec ::= ExprSingle ("ascending" | "descending")?
  // ("empty" ("least" | "greatest"))? - collation is outside the subset
  function parseOrderByClause(clauses, at) {
    const specs = [];
    for (;;) {
      skipWS();
      const keyAt = pos;
      const key = parseExprSingle();
      // a date and a value of another type do not order (XPTY0004), where
      // the engine would order their texts: a variable or a path that may
      // hold a date is checked where the phrase returns (see
      // guardOrderKeys), any other key is refused
      const mayBeDate = isPathExpr(key) && typeOf(key) === 'maybe';
      if (!isPathExpr(key))
        operandTypes([key], 'an order by key', keyAt);
      let desc = false;
      let greatest = false;
      if (tryKeyword('ascending') < 0 && tryKeyword('descending') >= 0)
        desc = true;
      if (tryKeyword('empty') >= 0) {
        if (tryKeyword('greatest') >= 0)
          greatest = true;
        else if (tryKeyword('least') < 0)
          fail("expected 'least' or 'greatest'");
      }
      const collationAt = tryKeyword('collation');
      if (collationAt >= 0)
        fail("unsupported construct 'collation'", collationAt);
      specs.push({ key, desc, greatest, mayBeDate, at: keyAt });
      skipWS();
      if (cc(pos) === CC_COMMA) {
        pos++;
        continue;
      }
      break;
    }
    clauses.push({ kind: 'orderby', specs, at });
  }

  // A key spec in default form is the bare key expression; explicit
  // modifiers use the {$key, $dir, $empty} object with only non-default
  // members. An array-constructor key always takes the explicit form: a
  // bare array in $orderby position reads as a list of key specs.
  function emitOrderBySpec(spec) {
    if (!spec.desc && !spec.greatest && !Array.isArray(spec.key))
      return spec.key;
    const out = { '$key': spec.key };
    if (spec.desc)
      out.$dir = 'desc';
    if (spec.greatest)
      out.$empty = 'greatest';
    return out;
  }

  function emitOrderBy(specs) {
    if (specs.length === 1)
      return emitOrderBySpec(specs[0]);
    const out = new Array(specs.length);
    for (let i = 0; i < specs.length; i++)
      out[i] = emitOrderBySpec(specs[i]);
    return out;
  }

  // `ret`, the return of a phrase ordered by `specs`, refusing a tuple whose
  // key may be a date. The engine has ordered the keys without an error, so
  // they are numbers or strings, and a key in no date's shape is no date: a
  // string in one may be a date the engine compared with another string's
  // text, and raises (`unsupported`). The key is a variable or a path
  // (parseOrderByClause), read again here: the phrase binds no other name
  // before its return but `countName`, which such a key may not read.
  function guardOrderKeys(specs, countName, ret) {
    const keys = specs.filter((spec) => spec.mayBeDate).map((spec) => spec.key);
    if (keys.length === 0)
      return ret;
    const counted = specs.find((spec) => spec.mayBeDate && pathVariable(spec.key) === countName);
    if (counted !== undefined)
      fail("unsupported construct 'an order by key of a value that may be a date'", counted.at);
    const mayBeDate = (key) => ({
      '$and': [{ '$is-string': key }, { '$or': [DATE_SHAPE, DATETIME_SHAPE, TIME_SHAPE].map((shape) => ({ '$match': [key, shape] })) }],
    });
    return {
      '$if': [
        keys.length === 1 ? mayBeDate(keys[0]) : { '$or': keys.map(mayBeDate) },
        raisedWith(UNSUPPORTED_VALUE, 'order by: a key that may be a date is a value the front-end does not order'),
        ret,
      ],
    };
  }

  //#region clause packing
  // The JSON FLWOR phrase holds at most one clause per kind, applied in
  // the fixed semantic order $for -> $let -> $where -> $groupby ->
  // $orderby -> $count -> $return (D7). The parser packs the source
  // clause list greedily into that order and expresses everything else
  // by nesting - which is only sound for the per-tuple clauses:
  //
  //   - for/let/where nest into $return freely (a nested phrase runs
  //     once per surviving tuple, exactly XQuery's tuple-stream
  //     semantics); a bare leading `where` nests as `$if`.
  //   - group by / order by / count operate on the *whole* tuple stream.
  //     Nesting them under a phrase that iterates ($for or $groupby)
  //     would wrongly scope them to one tuple, so that clause order is
  //     rejected: `unsupported clause order: '<kw>' after '<kw>'`.
  //
  // A name collision (XQuery shadowing, JQ0007 in one phrase) also forces
  // a split - the nested phrase then shadows, exactly XQuery semantics.

  function assembleFlwor(clauses, ret) {
    return buildChain(clauses, 0, ret, false);
  }

  function buildChain(clauses, i, ret, enclosingMulti) {
    if (i >= clauses.length)
      return ret;
    // each phrase (or leading $if) the clauses nest into is one level
    enter(clauses[i].at);
    const chain = buildLevel(clauses, i, ret, enclosingMulti);
    depth--;
    return chain;
  }

  function buildLevel(clauses, i, ret, enclosingMulti) {
    const c = clauses[i];
    if (c.kind === 'where') // a leading tuple filter is $if
      return { '$if': [c.expr, buildChain(clauses, i + 1, ret, enclosingMulti)] };
    if (c.kind === 'groupby' || c.kind === 'orderby' || c.kind === 'count')
      fail(`unsupported clause order: '${CLAUSE_LABEL[c.kind]}' after '${CLAUSE_LABEL[clauses[i - 1].kind]}'`, c.at);
    return buildPhrase(clauses, i, ret, enclosingMulti);
  }

  function buildPhrase(clauses, i, ret, enclosingMulti) {
    const names = new Set();
    let forObj = null;
    let letObj = null;
    let whereExpr = null;
    let groupObj = null;
    let orderSpecs = null;
    let countName = null;
    let lastSlot = -1;
    let multi = false; // this phrase iterates: $for or $groupby present

    for (; i < clauses.length; i++) {
      const c = clauses[i];
      const slot = CLAUSE_SLOT[c.kind];
      if (c.kind === 'for' || c.kind === 'let') {
        // equal slots merge (consecutive bindings of one kind); a slot
        // regression or a name collision closes the phrase
        if (slot < lastSlot)
          break;
        if (names.has(c.name) || (c.kind === 'for' && c.atName !== null && names.has(c.atName)))
          break;
        if (c.kind === 'for') {
          if (forObj === null)
            forObj = {};
          setObjectMember(forObj, c.name, c.atName === null ? c.expr : { '$in': c.expr, '$at': c.atName });
          names.add(c.name);
          if (c.atName !== null)
            names.add(c.atName);
          multi = true;
        }
        else {
          if (letObj === null)
            letObj = {};
          setObjectMember(letObj, c.name, c.expr);
          names.add(c.name);
        }
        lastSlot = slot;
        continue;
      }
      if (slot <= lastSlot)
        break;
      if (c.kind === 'where') {
        whereExpr = c.expr;
        lastSlot = slot;
        continue;
      }
      // whole-stream clauses cannot nest under an iterating phrase
      if (enclosingMulti)
        fail(`unsupported clause order: '${CLAUSE_LABEL[c.kind]}' after '${CLAUSE_LABEL[clauses[i - 1].kind]}'`, c.at);
      if (c.kind === 'groupby') {
        groupObj = {};
        for (let k = 0; k < c.keys.length; k++) {
          const g = c.keys[k];
          if (hasOwn(groupObj, g.name))
            fail(`duplicate variable '$${g.name}'`, g.at);
          if (names.has(g.name))
            fail(`unsupported construct 'group by' rebinding variable '$${g.name}'`, g.at);
          setObjectMember(groupObj, g.name, g.expr);
        }
        for (let k = 0; k < c.keys.length; k++)
          names.add(c.keys[k].name);
        multi = true;
        lastSlot = slot;
        continue;
      }
      if (c.kind === 'orderby') {
        orderSpecs = c.specs;
        lastSlot = slot;
        continue;
      }
      // count
      if (names.has(c.name))
        fail(`unsupported construct 'count' rebinding variable '$${c.name}'`, c.at);
      countName = c.name;
      names.add(c.name);
      lastSlot = slot;
    }

    let retExpr = i < clauses.length
      ? buildChain(clauses, i, ret, enclosingMulti || multi)
      : ret;
    if (orderSpecs !== null)
      retExpr = guardOrderKeys(orderSpecs, countName, retExpr);

    const phrase = {};
    if (forObj !== null)
      phrase.$for = forObj;
    if (letObj !== null)
      phrase.$let = letObj;
    if (whereExpr !== null)
      phrase.$where = whereExpr;
    if (groupObj !== null)
      phrase.$groupby = groupObj;
    if (orderSpecs !== null)
      phrase.$orderby = emitOrderBy(orderSpecs);
    if (countName !== null)
      phrase.$count = countName;
    phrase.$return = retExpr;
    return phrase;
  }

  //#endregion

  //#endregion

  //#region prolog

  const declared = new Set();

  // `xquery version "..." (encoding "...")? ;` - parsed, ignored
  function parseVersionDecl() {
    const save = pos;
    if (tryKeyword('xquery') < 0)
      return;
    skipWS();
    if (!isNameStartCode(cc(pos))) {
      pos = save;
      return;
    }
    const w = parseNCName();
    if (w !== 'version' && w !== 'encoding') {
      pos = save;
      return;
    }
    skipWS();
    if (cc(pos) !== CC_SQUOTE && cc(pos) !== CC_DQUOTE)
      fail(`expected a string literal after '${w}'`);
    parseStringLiteral();
    if (w === 'version') {
      const save2 = pos;
      if (tryKeyword('encoding') >= 0) {
        skipWS();
        if (cc(pos) !== CC_SQUOTE && cc(pos) !== CC_DQUOTE)
          fail("expected a string literal after 'encoding'");
        parseStringLiteral();
      }
      else {
        pos = save2;
      }
    }
    skipWS();
    if (cc(pos) !== CC_SEMICOLON)
      fail("expected ';'");
    pos++;
  }

  // `declare variable $name external;` - validated and ignored: in the
  // JSON format use is the declaration (spec section 9); the engine
  // collects free variables as externals. Everything else in a prolog is
  // outside the subset, each with a named error.
  function parseVariableDecl(declAt) {
    skipWS();
    if (cc(pos) !== CC_DOLLAR)
      fail("expected '$' after 'declare variable'");
    pos++;
    skipWS();
    const nameAt = pos;
    const name = parseVarName();
    if (declared.has(name))
      fail(`duplicate variable declaration '$${name}'`, nameAt);
    checkTypeDeclaration();
    skipWS();
    if (cc(pos) === CC_COLON && cc(pos + 1) === CC_EQ)
      fail("unsupported construct 'variable declaration with default value'", declAt);
    expectKeyword('external');
    skipWS();
    if (cc(pos) === CC_COLON && cc(pos + 1) === CC_EQ)
      fail("unsupported construct 'variable declaration with default value'", declAt);
    if (cc(pos) !== CC_SEMICOLON)
      fail("expected ';'");
    pos++;
    declared.add(name);
  }

  function parseProlog() {
    parseVersionDecl();
    for (;;) {
      const save = pos;
      skipWS();
      const at = pos;
      if (!isNameStartCode(cc(pos))) {
        pos = save;
        return;
      }
      const w = parseNCName();
      if (w === 'declare') {
        skipWS();
        if (cc(pos) === CC_PERCENT)
          fail("unsupported construct 'annotation'");
        // nothing declarable follows: 'declare' is a name test, not a prolog
        const kind = isNameStartCode(cc(pos)) ? parseNCName() : '';
        if (!DECLARATION_KINDS.has(kind)) {
          pos = save;
          return;
        }
        if (kind === 'variable') {
          parseVariableDecl(at);
          continue;
        }
        fail(`unsupported construct 'declare ${kind}'`, at);
      }
      // 'import' and 'module' are declarations only before 'module' / 'schema'
      // and 'namespace'; anywhere else they are name tests like any other
      if (w === 'import') {
        const kind = tryKeyword('module') >= 0 ? 'module' : tryKeyword('schema') >= 0 ? 'schema' : null;
        if (kind !== null)
          fail(`unsupported construct 'import ${kind}'`, at);
      }
      else if (w === 'module' && tryKeyword('namespace') >= 0) {
        fail("unsupported construct 'library module'", at);
      }
      pos = save;
      return;
    }
  }

  //#endregion

  // Module ::= VersionDecl? Prolog QueryBody
  parseProlog();
  skipWS();
  if (pos >= len)
    fail('empty query', 0);
  const body = parseExpr();
  skipWS();
  if (pos !== len)
    fail('unexpected token');
  return body;
}

//#endregion

//#endregion
