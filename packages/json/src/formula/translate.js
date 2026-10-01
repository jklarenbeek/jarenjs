//@ts-check
/**
 * @file A saved JavaScript formula body translated into a JSON Query
 * document (FORMULA-FORMAT, "Translating a saved source"). The body is
 * parsed by `./javascript.js`; nothing is evaluated. Each statement and
 * expression of the declared subset becomes an operator; a construct outside
 * it becomes a reason, and a translation that holds except in a named case
 * carries a difference, both with their position in the source.
 *
 * The statements translate by continuation: `const x = e; rest` is a `$let`
 * around the rest, `if (c) return a; rest` is `$if(c, a, rest)`, and a
 * variable reassigned (or an array pushed to) inside an `if` that does not
 * return is rebound to `$if(c, new, old)` for the statements after it.
 *
 * Exactness rests on two documented preconditions rather than on a
 * difference at every site: each field holds the JSON type the body uses it
 * as (JavaScript coerces where the query refuses the row), and a value read
 * where a guard (`if (x == null) return …`, `!x`, `x?.y`) has not proven it
 * present is reported where JavaScript and the query part ways.
 */

import { parseFormulaBody, positionOf, FormulaSyntaxError } from './javascript.js';

/** The noncharacter the anchor and trim compositions mark an end with. */
const SENTINEL = '￿';
/** ECMAScript white space and line terminators, as an I-Regexp class body (`\s`, `trim`). */
const JS_SPACE = '\t\n\u000b\f\r    -     　﻿';
/** Any character, as an I-Regexp class. */
const ANYTHING = '[\\p{L}\\P{L}]';

/** @param {Set<string>} a @param {Set<string>} b */
const union = (a, b) => new Set([...a, ...b]);
/** @param {Set<string>} a @param {Set<string>} b */
const intersect = (a, b) => new Set([...a].filter((k) => b.has(k)));

/** The option keys the translator reads. */
const OPTION_KEYS = new Set(['argument', 'helperObject', 'helpers', 'skip', 'explain', 'explanationMember', 'locales']);

/**
 * Translate a formula body.
 * @param {string} source - the body (the statements of a function body)
 * @param {TranslateOptions} [options]
 * @returns {Translation}
 */
export function translateFormulaBody(source, options = {}) {
  const opts = readOptions(options);
  /** @type {Reason[]} */
  const reasons = [];
  /** @type {Difference[]} */
  const differences = [];
  const at = (/** @type {number} */ offset) => positionOf(source, offset);
  const reason = (/** @type {string} */ kind, /** @type {any} */ node, /** @type {string} */ message) => {
    reasons.push({ kind, at: at(node?.start ?? 0), message });
  };
  const differ = (/** @type {string} */ kind, /** @type {any} */ node, /** @type {string} */ note) => {
    differences.push({ kind, at: at(node?.start ?? 0), note });
  };

  let ast;
  try { ast = parseFormulaBody(source); }
  catch (e) {
    if (!(e instanceof FormulaSyntaxError)) throw e;
    return finish(null, 'value', [], [{ kind: 'syntax', at: at(e.offset), message: e.message }], []);
  }

  const usesOutcome = mentions(ast, (name) => name === opts.skip || name === opts.explain, opts.helperObject)
    || (opts.explanationMember !== null && returnsExplanationObject(ast, opts.explanationMember));
  const resultMode = usesOutcome ? 'outcome' : 'value';
  /** @type {Map<string, { name: string, version: string }>} */
  const callHelpers = new Map();
  const names = new Set();
  let counter = 0;

  /** A fresh query variable name for a JavaScript name. @param {string} js */
  function fresh(js) {
    let base = /^[A-Za-z_][A-Za-z0-9_]*$/.test(js) ? js : js.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
    if (base === 'context' || base === 'computed') base = `${base}_`;
    let name = base;
    while (names.has(name)) name = `${base}_${++counter}`;
    names.add(name);
    return name;
  }

  //#region values

  /**
   * What the translator knows about a value.
   * @typedef {Object} Value
   * @property {any} q - the query expression
   * @property {string} type - number, string, boolean, null, array, object, regexp, skip or unknown
   * @property {boolean} absent - it may be undefined
   * @property {boolean} nullable - it may be null
   * @property {string | null} key - the fact key that proves it present, when it is a read
   * @property {boolean} [pathable] - `q` is a path string a member can extend
   * @property {any} [literal] - the JavaScript value, when it is a constant
   * @property {{ pattern: string, flags: string, node: any }} [regex]
   * @property {any} [table] - the object literal a constant table was built from
   * @property {string} [element] - an array's element type, when known
   * @property {boolean} [fromArray] - an element of an array (a callback's parameter, a find, an index)
   */

  /** @returns {Value} */
  const value = (/** @type {any} */ q, /** @type {string} */ type, absent = false, nullable = false, key = null) =>
    ({ q, type, absent, nullable, key });
  const EMPTY = () => value({ $seq: [] }, 'undefined', true, false);
  const nullish = (/** @type {Value} */ v, /** @type {Env} */ env) => (v.absent || v.nullable) && !(v.key && env.facts.has(v.key));

  /** A string literal in a query: a leading `$` is escaped as `$$`. @param {string} s */
  const str = (s) => (s.startsWith('$') ? `$${s}` : s);

  /** The items of an array value, as a sequence. @param {Value} v */
  function itemsOf(v) {
    if (v.pathable) return `${v.q}[*]`;
    const name = fresh('items');
    return { $let: { [name]: v.q }, $return: `$${name}[*]` };
  }

  /** Bind a value once when it is read twice. @param {Value} v @param {(ref: any) => any} use */
  function once(v, use) {
    if (v.pathable || typeof v.q !== 'object' || v.q === null) return use(v.q);
    const name = fresh('t');
    return { $let: { [name]: v.q }, $return: use(`$${name}`) };
  }

  //#endregion

  //#region environment

  /**
   * @typedef {{ vars: Map<string, any>, facts: Set<string> }} Env
   */

  /** @param {Env} env @param {Iterable<string>} keys @returns {Env} */
  function withFacts(env, keys) {
    const facts = new Set(env.facts);
    for (const key of keys) {
      // a present member proves every member before it present
      let k = key;
      for (;;) {
        facts.add(k);
        const cut = Math.max(k.lastIndexOf('.'), k.lastIndexOf('['));
        if (cut <= 0) break;
        k = k.slice(0, cut);
      }
    }
    return { vars: env.vars, facts };
  }

  /** @param {Env} env @param {string} name @param {any} info @returns {Env} */
  function withVar(env, name, info) {
    const vars = new Map(env.vars);
    vars.set(name, info);
    return { vars, facts: env.facts };
  }

  /** The value a variable reads as. @param {any} info */
  function readVar(info) {
    if (info.inline) return { ...info.value };
    return { ...info.value, q: `$${info.qname}`, pathable: true };
  }

  /** A read a guard has proven present is neither undefined nor null. @param {Value} v @param {Env} env @returns {Value} */
  function prove(v, env) {
    return v.key && env.facts.has(v.key) ? { ...v, absent: false, nullable: false } : v;
  }

  //#endregion

  //#region facts: what a test proves when it is true or false

  /**
   * The fact keys proven present (neither null nor undefined) when `node`
   * evaluates truthy (`truth`) or falsy.
   * @param {any} node @param {Env} env @param {boolean} truth @returns {Set<string>}
   */
  function factsWhen(node, env, truth) {
    const none = new Set();
    switch (node.type) {
      case 'Identifier': case 'Member': {
        const key = keyOf(node, env);
        return truth && key ? new Set([key]) : none;
      }
      case 'Unary':
        return node.operator === '!' ? factsWhen(node.argument, env, !truth) : none;
      case 'Logical': {
        const a = (/** @type {boolean} */ t) => factsWhen(node.left, env, t);
        const b = (/** @type {boolean} */ t) => factsWhen(node.right, env, t);
        if (node.operator === '&&')
          return truth ? union(a(true), b(true)) : intersect(a(false), union(a(true), b(false)));
        if (node.operator === '||')
          return truth ? intersect(a(true), union(a(false), b(true))) : union(a(false), b(false));
        return none;
      }
      case 'Binary': {
        const { operator, left, right } = node;
        const isNullish = (/** @type {any} */ n) => (n.type === 'Literal' && n.value === null) || (n.type === 'Identifier' && n.name === 'undefined');
        const side = isNullish(right) ? left : isNullish(left) ? right : null;
        if (side && (operator === '==' || operator === '!=')) {
          const key = keyOf(side, env);
          const present = operator === '==' ? !truth : truth;
          return present && key ? new Set([key]) : none;
        }
        // equal to a literal that is not nullish: present
        if (truth && (operator === '===' || operator === '==')) {
          const literal = (/** @type {any} */ n) => n.type === 'Literal' && n.value !== null;
          const key = literal(right) ? keyOf(left, env) : literal(left) ? keyOf(right, env) : null;
          return key ? new Set([key]) : none;
        }
        // x > c (c ≥ 0) or x >= c (c > 0) holds for neither null (0) nor undefined (NaN)
        if (truth) {
          const num = (/** @type {any} */ n) => (n.type === 'Literal' && typeof n.value === 'number' ? n.value : null);
          let subject = null;
          if ((operator === '>' && num(right) !== null && num(right) >= 0) || (operator === '>=' && num(right) !== null && num(right) > 0)) subject = left;
          if ((operator === '<' && num(left) !== null && num(left) >= 0) || (operator === '<=' && num(left) !== null && num(left) > 0)) subject = right;
          const key = subject ? keyOf(subject, env) : null;
          return key ? new Set([key]) : none;
        }
        return none;
      }
      default:
        return none;
    }
  }

  /** The fact key of a read (`row.a.b`, an alias's key), or null. @param {any} node @param {Env} env */
  function keyOf(node, env) {
    if (node.type === 'Identifier') {
      if (node.name === opts.argument) return 'row';
      const info = env.vars.get(node.name);
      return info ? info.value.key : null;
    }
    if (node.type === 'Member') {
      const base = keyOf(node.object, env);
      if (!base) return null;
      if (!node.computed) return `${base}.${node.property}`;
      if (node.property.type === 'Literal' && (typeof node.property.value === 'string' || typeof node.property.value === 'number'))
        return `${base}[${JSON.stringify(String(node.property.value))}]`;
      return null;
    }
    return null;
  }

  //#endregion

  //#region expressions

  /**
   * Translate an expression.
   * @param {any} node @param {Env} env @returns {Value}
   */
  function tx(node, env) {
    switch (node.type) {
      case 'Literal': {
        const v = node.value;
        if (typeof v === 'string') return { ...value(str(v), 'string'), literal: v };
        if (typeof v === 'number') return { ...value(v, 'number'), literal: v };
        if (typeof v === 'boolean') return { ...value(v, 'boolean'), literal: v };
        return { ...value(null, 'null', false, true), literal: null };
      }
      case 'Template': return template(node, env);
      case 'RegExp': return { ...value(null, 'regexp'), regex: { pattern: node.pattern, flags: node.flags, node } };
      case 'Identifier': return identifier(node, env);
      case 'Member': return member(node, env);
      case 'Call': return call(node, env);
      case 'New': return newExpression(node);
      case 'Array': return arrayLiteral(node, env);
      case 'Object': return objectLiteral(node, env);
      case 'Unary': return unary(node, env);
      case 'Binary': return binary(node, env);
      case 'Logical': return logical(node, env);
      case 'Conditional': {
        const test = condition(node.test, env);
        const a = tx(node.consequent, withFacts(env, factsWhen(node.test, env, true)));
        const b = tx(node.alternate, withFacts(env, factsWhen(node.test, env, false)));
        return value({ $if: [test, a.q, b.q] }, a.type === b.type ? a.type : 'unknown', a.absent || b.absent, a.nullable || b.nullable);
      }
      case 'Arrow':
        reason('function', node, 'a function outside the callback of map, filter, find, some, every or sort');
        return EMPTY();
      case 'Assignment': case 'Update':
        reason('assignment', node, 'an assignment inside an expression; assign in a statement of its own');
        return EMPTY();
      case 'Sequence':
        reason('sequence', node, 'the comma operator');
        return EMPTY();
      case 'Spread':
        reason('spread', node, 'a spread outside an array literal');
        return EMPTY();
      case 'Unsupported':
        reason(node.what, node, `'${node.what}' is not translated`);
        return EMPTY();
      default:
        reason('syntax', node, `a ${node.type} expression is not translated`);
        return EMPTY();
    }
  }

  /** A test in a boolean position: its effective boolean value. @param {any} node @param {Env} env */
  function condition(node, env) {
    if (node.type === 'Logical' && node.operator !== '??') {
      const left = condition(node.left, env);
      const rightEnv = withFacts(env, factsWhen(node.left, env, node.operator === '&&'));
      const right = condition(node.right, rightEnv);
      return { [node.operator === '&&' ? '$and' : '$or']: [left, right] };
    }
    if (node.type === 'Unary' && node.operator === '!') return { $not: condition(node.argument, env) };
    const v = tx(node, env);
    if (v.type === 'boolean') return v.q;
    return { $boolean: v.q };
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function identifier(node, env) {
    const { name } = node;
    if (name === opts.argument) return { ...value('$', 'object', false, false, 'row'), pathable: true };
    const info = env.vars.get(name);
    if (info) return prove(readVar(info), env);
    if (name === 'undefined') return EMPTY();
    if (name === 'NaN') return value({ $div: [0, 0] }, 'number');
    if (name === 'Infinity') return value({ $div: [1, 0] }, 'number');
    if (name === opts.skip) return value({ kind: 'skip' }, 'skip');
    reason('unknown-name', node, `'${name}' is neither a variable of the body, the row nor a helper this translation maps`);
    return EMPTY();
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function member(node, env) {
    // text.split(separator)[0]: the text before the first separator
    if (node.computed && node.property.type === 'Literal' && node.property.value === 0 && node.object.type === 'Call'
      && node.object.callee.type === 'Member' && !node.object.callee.computed && node.object.callee.property === 'split')
      return splitFirst(node, env);
    // helpers.X reads as the bare helper name X
    if (!node.computed && node.object.type === 'Identifier' && node.object.name === opts.helperObject && !env.vars.has(opts.helperObject))
      return identifier({ ...node, type: 'Identifier', name: node.property }, env);
    const object = tx(node.object, env);
    if (!node.optional && !node.object.optionalChain && nullish(object, env) && !(object.type === 'undefined'))
      differ('absent-receiver', node, node.destructured
        ? 'JavaScript throws a TypeError destructuring null or undefined; the query reads nothing'
        : 'JavaScript throws a TypeError reading a member of null or undefined; the query reads nothing');
    if (!node.computed && node.property === 'length') {
      if (object.type === 'string') return value({ '$string-length': object.q }, 'number', object.absent, false);
      if (object.type === 'array') return value({ $count: itemsOf(object) }, 'number');
      reason('length', node, '.length of a value whose type (string or array) the translation cannot tell');
      return EMPTY();
    }
    const key = keyOf(node, env);
    const absent = true;
    if (!node.computed) {
      if (object.pathable) return prove({ ...value(`${object.q}${segment(node.property)}`, 'unknown', absent, true, key), pathable: true }, env);
      return prove(value({ $get: [object.q, str(node.property)] }, 'unknown', absent, true, key), env);
    }
    const property = node.property;
    if (property.type === 'Literal' && typeof property.value === 'string') {
      if (object.pathable) return prove({ ...value(`${object.q}${segment(property.value)}`, 'unknown', absent, true, key), pathable: true }, env);
      return prove(value({ $get: [object.q, str(property.value)] }, 'unknown', absent, true, key), env);
    }
    if (property.type === 'Literal' && typeof property.value === 'number' && Number.isInteger(property.value) && property.value >= 0) {
      if (object.type === 'object' || object.table) return value({ $get: [object.q, String(property.value)] }, 'unknown', absent, true, key);
      if (object.pathable) return { ...value(`${object.q}[${property.value}]`, elementType(object), absent, true, key), pathable: true, fromArray: true };
      return { ...value({ $get: [object.q, property.value] }, elementType(object), absent, true, key), fromArray: true };
    }
    // a dynamic key into a constant table
    const k = tx(property, env);
    if (object.table) {
      differ('prototype-key', node, 'JavaScript also finds a key on Object.prototype (constructor, toString, …) where the table has none; the query finds nothing');
      return value({ $get: [object.q, k.type === 'string' ? k.q : { $string: k.q }] }, 'unknown', true, true);
    }
    if (object.type === 'array') return { ...value({ $get: [object.q, k.q] }, elementType(object), true, true), fromArray: true };
    reason('computed-member', node, 'a computed member of a value that is neither a constant table nor an array');
    return EMPTY();
  }

  /** The type of an array's elements, when known. @param {Value} v */
  const elementType = (v) => v.element ?? 'unknown';

  /** A JSONPath member segment. @param {string} name */
  function segment(name) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `.${name}`;
    return `[${JSON.stringify(name).replace(/^"|"$/g, "'").replace(/\\"/g, '"').replace(/'(?=.)/g, (m, i) => (i === 0 ? m : "\\'"))}]`;
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function template(node, env) {
    const parts = [];
    for (let i = 0; i < node.quasis.length; i++) {
      if (node.quasis[i] !== '') parts.push(str(node.quasis[i]));
      if (i < node.expressions.length) parts.push(stringPart(node.expressions[i], env));
    }
    if (parts.length === 0) return value('', 'string');
    if (parts.length === 1 && typeof parts[0] === 'string' && node.expressions.length === 0) return value(parts[0], 'string');
    return value({ $concat: parts.length === 1 ? [parts[0], ''] : parts }, 'string');
  }

  /** An operand of string concatenation. @param {any} node @param {Env} env */
  function stringPart(node, env) {
    const v = tx(node, env);
    if (v.type === 'array' || v.type === 'object') reason('string-of-object', node, 'an array or object made into text (JavaScript joins or prints [object Object])');
    if (v.absent && !(v.key && env.facts.has(v.key)))
      differ('concat-undefined', node, "JavaScript writes 'undefined' where the query writes nothing");
    return v.q;
  }

  /** A `new` other than the two translated forms (in `call`). @param {any} node @returns {Value} */
  function newExpression(node) {
    reason('new', node, 'a new expression other than new Date(text).getTime() or new Intl.NumberFormat(…).format(n)');
    return EMPTY();
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function arrayLiteral(node, env) {
    const members = [];
    for (const element of node.elements) {
      if (element === null) { reason('array-hole', node, 'an array hole'); continue; }
      if (element.type === 'Spread') {
        // a spread uses its value as an array (the type precondition)
        const v = tx(element.argument, env);
        if (nullish(v, env)) differ('absent-receiver', element, 'JavaScript throws a TypeError spreading null or undefined; the query spreads nothing');
        members.push(itemsOf(v));
        continue;
      }
      const v = tx(element, env);
      if (nullish(v, env) && v.absent) differ('absent-element', element, 'JavaScript keeps undefined as an element; the query drops it');
      members.push(v.q);
    }
    const element = node.elements.length > 0 && node.elements.every((/** @type {any} */ e) => e && e.type === 'Literal' && typeof e.value === 'string') ? 'string' : 'unknown';
    return { ...value(members, 'array'), element };
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function objectLiteral(node, env) {
    /** @type {Record<string, any>} */
    const out = {};
    let constant = true;
    for (const property of node.properties) {
      if (property.type === 'Spread' || property.computed) { reason('object-spread', property, 'a spread or computed key in an object literal'); continue; }
      const key = String(property.key);
      if (key.startsWith('$')) { reason('object-key', property, `the key '${key}' starts with '$', which a query reads as an operator`); continue; }
      if (key === '__proto__') { reason('object-key', property, "the key '__proto__'"); continue; }
      const v = tx(property.value, env);
      if (v.literal === undefined) constant = false;
      out[key] = v.q;
    }
    return { ...value(out, 'object'), table: constant ? node : undefined };
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function unary(node, env) {
    if (node.operator === '!') return value({ $not: condition(node.argument, env) }, 'boolean');
    // void 0: undefined, as compilers spell it
    if (node.operator === 'void' && node.argument.type === 'Literal') return EMPTY();
    if (node.operator === '-') {
      const v = tx(node.argument, env);
      if (typeof v.q === 'number') return { ...value(-v.q, 'number'), literal: -v.q };
      arithmeticOperand(v, node.argument, env);
      return value({ $neg: v.q }, 'number', v.absent);
    }
    if (node.operator === 'typeof') reason('typeof', node, 'typeof');
    else reason('operator', node, `the operator '${node.operator}'`);
    return EMPTY();
  }

  /** Note an arithmetic operand that may be null or undefined. @param {Value} v @param {any} node @param {Env} env */
  function arithmeticOperand(v, node, env) {
    if (nullish(v, env)) differ('nullish-arithmetic', node, 'JavaScript computes with undefined (NaN) or null (0); the query yields nothing for undefined and refuses null');
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function binary(node, env) {
    const { operator } = node;
    if (operator === '+') return plus(node, env);
    if (operator === '-' || operator === '*' || operator === '/' || operator === '%') {
      const a = tx(node.left, env);
      const b = tx(node.right, env);
      arithmeticOperand(a, node.left, env);
      arithmeticOperand(b, node.right, env);
      if (operator === '%' && !(typeof b.q === 'number' && b.q !== 0))
        differ('remainder-by-zero', node, 'JavaScript computes NaN for a remainder by zero; the query refuses it (JQ2002)');
      const op = { '-': '$sub', '*': '$mul', '/': '$div', '%': '$mod' }[operator];
      return value({ [/** @type {string} */ (op)]: [a.q, b.q] }, 'number', a.absent || b.absent);
    }
    if (operator === '<' || operator === '>' || operator === '<=' || operator === '>=') {
      const a = tx(node.left, env);
      const b = tx(node.right, env);
      // JavaScript compares null as 0: it differs only where 0 would pass
      const passes = (/** @type {number} */ x, /** @type {number} */ y) => ({ '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y })[/** @type {'<'} */ (operator)];
      if (a.nullable && nullish(a, env) && !(typeof b.literal === 'number' && !passes(0, b.literal)))
        differ('nullish-comparison', node.left, 'JavaScript compares null as 0; the query compares nothing');
      if (b.nullable && nullish(b, env) && !(typeof a.literal === 'number' && !passes(a.literal, 0)))
        differ('nullish-comparison', node.right, 'JavaScript compares null as 0; the query compares nothing');
      const op = { '<': '$lt', '>': '$gt', '<=': '$le', '>=': '$ge' }[operator];
      return value({ [/** @type {string} */ (op)]: [a.q, b.q] }, 'boolean');
    }
    if (operator === '===' || operator === '!==' || operator === '==' || operator === '!=') return equality(node, env);
    reason('operator', node, `the operator '${operator}'`);
    return EMPTY();
  }

  /** `+`: concatenation once an operand is text, addition otherwise. @param {any} node @param {Env} env @returns {Value} */
  function plus(node, env) {
    // flatten the left-associative chain (a parenthesized operand is one operand)
    const operands = [node.right];
    let n = node.left;
    while (n.type === 'Binary' && n.operator === '+' && !n.parenthesized) { operands.unshift(n.right); n = n.left; }
    operands.unshift(n);
    const values = operands.map((o) => ({ o, v: tx(o, env) }));
    // JavaScript adds until the first text operand, then concatenates
    const firstText = values.findIndex(({ v }) => v.type === 'string');
    if (firstText < 0) {
      let q = values[0].v.q;
      arithmeticOperand(values[0].v, values[0].o, env);
      for (const { o, v } of values.slice(1)) { arithmeticOperand(v, o, env); q = { $add: [q, v.q] }; }
      return value(q, 'number', values.some(({ v }) => v.absent));
    }
    const parts = [];
    let head = null;
    if (firstText > 1) {
      // the numbers before the first text are added first
      head = values[0].v.q;
      for (const { o, v } of values.slice(1, firstText)) { arithmeticOperand(v, o, env); head = { $add: [head, v.q] }; }
      parts.push(head);
    }
    for (const [i, { o, v }] of values.entries()) {
      if (i < firstText && firstText > 1) continue;
      if (v.type === 'array' || v.type === 'object') reason('string-of-object', o, 'an array or object made into text');
      if (v.absent && !(v.key && env.facts.has(v.key)))
        differ('concat-undefined', o, "JavaScript writes 'undefined' where the query writes nothing");
      parts.push(v.q);
    }
    return value({ $concat: parts }, 'string');
  }

  /** @param {any} node @param {Env} env @returns {Value} */
  function equality(node, env) {
    const { operator, left, right } = node;
    const negate = operator === '!==' || operator === '!=';
    const loose = operator === '==' || operator === '!=';
    const isNull = (/** @type {any} */ n) => n.type === 'Literal' && n.value === null;
    const isUndefined = (/** @type {any} */ n) => n.type === 'Identifier' && n.name === 'undefined' && !env.vars.has('undefined');
    let q;
    const other = isNull(right) || isUndefined(right) ? left : isNull(left) || isUndefined(left) ? right : null;
    if (other) {
      const v = tx(other, env);
      const nullSide = isNull(right) || isNull(left);
      if (loose) q = { '$is-null': { $default: [v.q, null] } };
      else if (nullSide) q = { $eq: [v.q, null] };
      else q = { $empty: v.q };
    }
    else {
      const a = tx(left, env);
      const b = tx(right, env);
      if (a.type === 'skip' || b.type === 'skip') { reason('skip-value', node, 'a comparison with the skip sentinel'); return EMPTY(); }
      const primitive = (/** @type {Value} */ v) => ['number', 'string', 'boolean', 'null', 'undefined'].includes(v.type);
      if ([a, b].some((v) => v.type === 'object' || v.type === 'array') || (a.fromArray && b.fromArray && !primitive(a) && !primitive(b)))
        differ('identity', node, 'JavaScript compares objects by identity; the query compares them by value');
      const aAbsent = nullish(a, env) && a.absent;
      const bAbsent = nullish(b, env) && b.absent;
      if (aAbsent && bAbsent) q = once(a, (x) => once(b, (y) => ({ $if: [{ $and: [{ $empty: x }, { $empty: y }] }, true, { $eq: [x, y] }] })));
      else q = { $eq: [a.q, b.q] };
      if (loose && ![a, b].some((v) => v.type === 'number' || v.type === 'string' || v.type === 'boolean'))
        differ('loose-equality', node, "JavaScript's == converts between types ('1' == 1); the query compares values of one type");
    }
    return value(negate ? { $not: q } : q, 'boolean');
  }

  /** `&&`, `||`, `??` in a value position. @param {any} node @param {Env} env @returns {Value} */
  function logical(node, env) {
    const a = tx(node.left, env);
    if (node.operator === '??') {
      const b = tx(node.right, env);
      const q = once(a, (x) => ({ $if: [{ '$is-null': { $default: [x, null] } }, b.q, x] }));
      return { ...value(q, a.type === 'unknown' ? b.type : a.type, b.absent, b.nullable, null), fromArray: Boolean(a.fromArray && b.fromArray), element: a.element ?? b.element };
    }
    const truthy = node.operator === '||';
    const b = tx(node.right, withFacts(env, factsWhen(node.left, env, !truthy)));
    const q = once(a, (x) => ({ $if: [a.type === 'boolean' ? x : { $boolean: x }, truthy ? x : b.q, truthy ? b.q : x] }));
    return value(q, a.type === b.type ? a.type : 'unknown', a.absent || b.absent, a.nullable || b.nullable);
  }

  //#endregion

  //#region calls

  /** @param {any} node @param {Env} env @returns {Value} */
  function call(node, env) {
    const { callee } = node;
    if (callee.type === 'Identifier' || (callee.type === 'Member' && !callee.computed && callee.object.type === 'Identifier'
      && callee.object.name === opts.helperObject && !env.vars.has(opts.helperObject))) {
      const name = callee.type === 'Identifier' ? callee.name : callee.property;
      if (!env.vars.has(name)) return functionCall(node, name, env);
    }
    if (callee.type === 'Member' && !callee.computed) {
      const object = callee.object;
      if (object.type === 'Identifier' && !env.vars.has(object.name)) {
        if (object.name === 'Math') return mathCall(node, callee.property, env);
        if (object.name === 'Date' && callee.property === 'now') {
          if (node.args.length) reason('arguments', node, 'Date.now() takes no argument');
          differ('clock', node, 'the clock is the host\'s: evaluate with context.now (epoch milliseconds)');
          return value('$context.now', 'number');
        }
      }
      if (object.type === 'New' && object.callee.type === 'Member' && !object.callee.computed
        && object.callee.object.type === 'Identifier' && object.callee.object.name === 'Intl' && object.callee.property === 'NumberFormat'
        && callee.property === 'format') {
        if (node.args.length !== 1) { reason('arguments', node, 'Intl.NumberFormat().format takes one value'); return EMPTY(); }
        return localeFormat(node, tx(node.args[0], env), object.args, env);
      }
      if (object.type === 'New' && object.callee.type === 'Identifier' && object.callee.name === 'Date' && callee.property === 'getTime') {
        if (object.args.length !== 1) { reason('date', object, 'new Date() without exactly one argument'); return EMPTY(); }
        differ('date-parse', object, 'JavaScript also reads dates that are not RFC 3339 (implementation-defined); the query refuses them');
        return value({ $epoch: tx(object.args[0], env).q }, 'number');
      }
      return method(node, callee, env);
    }
    reason('call', node, 'a call of something other than a helper, Math, Date.now or a method');
    return EMPTY();
  }

  /** A helper: the skip and explanation names, or one the host mapped. @param {any} node @param {string} name @param {Env} env @returns {Value} */
  function functionCall(node, name, env) {
    if (name === 'String') {
      if (node.args.length !== 1) { reason('arguments', node, 'String() of one value'); return EMPTY(); }
      return value({ $string: stringPart(node.args[0], env) }, 'string');
    }
    if (name === 'Number') {
      if (node.args.length !== 1) { reason('arguments', node, 'Number() of one value'); return EMPTY(); }
      const v = tx(node.args[0], env);
      if (v.type === 'number') return v;
      differ('number-parse', node, "JavaScript's Number() reads '' and blanks as 0 and accepts hex; the query's $number reads them as NaN");
      return value({ $number: v.q }, 'number', v.absent);
    }
    if (name === opts.explain) {
      reason('explanation', node, `${name}() outside a returned value`);
      return EMPTY();
    }
    const helper = opts.helpers[name];
    if (!helper) {
      reason('helper', node, `'${name}' is not a helper this translation maps`);
      return EMPTY();
    }
    const args = node.args.map((/** @type {any} */ a) => {
      if (a.type === 'Spread') { reason('spread', a, 'a spread argument'); return EMPTY(); }
      return tx(a, env);
    });
    for (const d of helper.differences ?? []) differ(d.kind, node, d.note);
    const type = helper.returns ?? 'unknown';
    if (helper.call) {
      callHelpers.set(helper.call.name, helper.call);
      return { ...value({ $call: [helper.call.name, ...args.map((/** @type {Value} */ a) => a.q)] }, type, true, true), element: helper.element };
    }
    const { params, expression } = helper.native;
    if (args.length > params.length) reason('arguments', node, `${name}() takes ${params.length} argument(s)`);
    /** @type {Record<string, any>} */
    const bindings = {};
    /** @type {Record<string, string>} */
    const renames = {};
    params.forEach((/** @type {string} */ p, /** @type {number} */ i) => {
      const local = fresh(`${p}_${name}`);
      renames[p] = local;
      bindings[local] = i < args.length ? args[i].q : { $seq: [] };
    });
    return { ...value({ $let: bindings, $return: renameVariables(expression, renames) }, type, helper.absent ?? true, helper.nullable ?? true), element: helper.element };
  }

  /** @param {any} node @param {string} name @param {Env} env @returns {Value} */
  function mathCall(node, name, env) {
    const args = node.args.map((/** @type {any} */ a) => tx(a, env));
    args.forEach((/** @type {Value} */ a, /** @type {number} */ i) => arithmeticOperand(a, node.args[i], env));
    const one = () => { if (args.length !== 1) reason('arguments', node, `Math.${name}() of one value`); return args[0]?.q ?? null; };
    switch (name) {
      case 'round': return value({ $round: [one()] }, 'number');
      case 'floor': return value({ $floor: one() }, 'number');
      case 'ceil': return value({ $ceiling: one() }, 'number');
      case 'abs': return value({ $abs: one() }, 'number');
      case 'max': case 'min':
        if (args.length === 0) { reason('arguments', node, `Math.${name}() of nothing`); return EMPTY(); }
        return value({ [name === 'max' ? '$max' : '$min']: { $seq: args.map((/** @type {Value} */ a) => a.q) } }, 'number');
      default:
        reason('math', node, `Math.${name} is not translated`);
        return EMPTY();
    }
  }

  /** @param {any} node @param {any} callee @param {Env} env @returns {Value} */
  function method(node, callee, env) {
    const name = callee.property;
    const receiver = tx(callee.object, env);
    if (!callee.optional && nullish(receiver, env) && receiver.type !== 'regexp')
      differ('absent-receiver', callee, `JavaScript throws a TypeError calling .${name}() on null or undefined; the query reads nothing`);
    const args = node.args;
    // a regular expression's test
    if (receiver.type === 'regexp') {
      if (name !== 'test' || args.length !== 1) { reason('regex', node, `a regular expression's .${name}()`); return EMPTY(); }
      return regexTest(receiver, tx(args[0], env));
    }
    if (name === 'toFixed') return toFixed(node, receiver, env);
    if (name === 'toLocaleString') return localeFormat(node, receiver, args, env);
    if (name === 'toString' && args.length === 0) return value({ $string: receiver.q }, 'string', receiver.absent);
    const arrayMethod = ['map', 'filter', 'find', 'some', 'every', 'sort', 'join', 'includes', 'push', 'concat', 'indexOf', 'slice', 'reduce', 'forEach', 'flatMap', 'findIndex'].includes(name);
    const stringMethod = ['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'trim', 'trimStart', 'trimEnd', 'startsWith', 'endsWith', 'replace', 'replaceAll', 'split', 'match', 'normalize', 'charAt', 'substring', 'padStart', 'padEnd', 'repeat'].includes(name);
    const isArray = receiver.type === 'array' || (receiver.type !== 'string' && arrayMethod && !stringMethod);
    if (name === 'includes' && receiver.type !== 'array' && receiver.type !== 'string') {
      reason('includes', node, '.includes() on a value the translation cannot tell is text or an array');
      return EMPTY();
    }
    if (isArray) return arrayCall(node, name, receiver, env);
    return stringCall(node, name, receiver, env);
  }

  /** @param {any} node @param {string} name @param {Value} s @param {Env} env @returns {Value} */
  function stringCall(node, name, s, env) {
    const args = node.args;
    const absent = s.absent;
    switch (name) {
      case 'toLowerCase': return value({ $lower: s.q }, 'string', absent);
      case 'toUpperCase': return value({ $upper: s.q }, 'string', absent);
      case 'toLocaleLowerCase': case 'toLocaleUpperCase': {
        const tag = args[0]?.type === 'Literal' ? String(args[0].value).toLowerCase() : null;
        if (args.length > 1 || (args.length === 1 && (tag === null || /^(tr|az|lt)\b/.test(tag)))) {
          reason('locale', node, `.${name}() in a language with its own case rules`);
          return EMPTY();
        }
        return value({ [name === 'toLocaleLowerCase' ? '$lower' : '$upper']: s.q }, 'string', absent);
      }
      case 'trim': case 'trimStart': case 'trimEnd': return value(trim(s.q, name), 'string', absent);
      case 'startsWith': case 'endsWith': case 'includes': {
        if (args.length !== 1) { reason('arguments', node, `.${name}() with a position`); return EMPTY(); }
        const op = { startsWith: '$starts-with', endsWith: '$ends-with', includes: '$contains' }[name];
        return value({ [/** @type {string} */ (op)]: [s.q, tx(args[0], env).q] }, 'boolean');
      }
      case 'replace': case 'replaceAll': return replaceCall(node, name, s, env);
      case 'split': {
        // only the first part: `text.split(' ')[0]`
        reason('split', node, '.split() other than its first part (text.split(x)[0])');
        return EMPTY();
      }
      default:
        reason('method', node, `.${name}() is not translated`);
        return EMPTY();
    }
  }

  /** The text before the first separator: `text.split(sep)[0]`. @param {any} member @param {Env} env */
  function splitFirst(member, env) {
    const call = member.object;
    const s = tx(call.callee.object, env);
    if (!call.callee.optional && nullish(s, env))
      differ('absent-receiver', call.callee, 'JavaScript throws a TypeError calling .split() on null or undefined; the query reads nothing');
    const sep = call.args[0];
    if (call.args.length !== 1 || sep.type !== 'Literal' || typeof sep.value !== 'string' || sep.value === '') {
      reason('split', call, '.split() by something other than a non-empty literal text');
      return EMPTY();
    }
    return value({ $replace: [s.q, `${escapeRegExp(sep.value)}${ANYTHING}*`, ''] }, 'string', s.absent);
  }

  /** @param {any} node @param {string} name @param {Value} s @param {Env} env @returns {Value} */
  function replaceCall(node, name, s, env) {
    const [pattern, replacement] = node.args;
    if (node.args.length !== 2) { reason('arguments', node, `.${name}() of a pattern and a replacement`); return EMPTY(); }
    if (replacement.type === 'Arrow') { reason('replace', replacement, 'a replacement function'); return EMPTY(); }
    const r = tx(replacement, env);
    if (r.type !== 'string') { reason('replace', replacement, 'a replacement that is not a text'); return EMPTY(); }
    let replacementQ = r.q;
    if (replacement.type === 'Literal') {
      // JavaScript reads $$, $&, $1, $` and $' in a replacement; the query inserts it as written
      if (/\$[&`'0-9<]/.test(replacement.value)) { reason('replace', replacement, 'a replacement that refers to the match ($&, $1, …)'); return EMPTY(); }
      replacementQ = str(replacement.value.replace(/\$\$/g, '$'));
    }
    else differ('replacement-pattern', replacement, "JavaScript reads $&, $1, … in a computed replacement; the query inserts it as written");
    const p = tx(pattern, env);
    if (p.type === 'regexp') {
      const global = name === 'replaceAll' || p.regex?.flags.includes('g');
      const rewritten = rewriteRegExp(/** @type {any} */ (p.regex), pattern);
      if (!rewritten) return EMPTY();
      if (rewritten.ignoreCase) { reason('regex', pattern, 'a case-insensitive pattern in .replace(): the replaced text keeps its case'); return EMPTY(); }
      if (!global && !rewritten.anchored && !rewritten.singleMatch) {
        reason('replace-first', node, '.replace() of the first match only (no g flag), where more than one can match');
        return EMPTY();
      }
      if (rewritten.anchored) {
        // the ends marked by a sentinel, matched, then unmarked
        const marked = { $concat: [SENTINEL, s.q, SENTINEL] };
        return value({ $replace: [{ $replace: [marked, rewritten.pattern, replacementQ] }, SENTINEL, ''] }, 'string', s.absent);
      }
      return value({ $replace: [s.q, rewritten.pattern, replacementQ] }, 'string', s.absent);
    }
    if (pattern.type === 'Literal' && typeof pattern.value === 'string' && pattern.value !== '') {
      const all = name === 'replaceAll';
      if (!all && !singleOccurrence(node.callee.object, pattern.value)) {
        reason('replace-first', node, ".replace() of a text's first occurrence, where more than one can occur");
        return EMPTY();
      }
      return value({ $replace: [s.q, escapeRegExp(pattern.value), replacementQ] }, 'string', s.absent);
    }
    reason('replace', pattern, '.replace() of something other than a literal text or regular expression');
    return EMPTY();
  }

  /** A text that holds the pattern at most once: `n.toFixed(d)` holds one point. @param {any} node @param {string} pattern */
  function singleOccurrence(node, pattern) {
    return pattern === '.' && node.type === 'Call' && node.callee.type === 'Member' && node.callee.property === 'toFixed';
  }

  /** A regular expression's test of a text. @param {Value} re @param {Value} subject @returns {Value} */
  function regexTest(re, subject) {
    const rewritten = rewriteRegExp(/** @type {any} */ (re.regex), re.regex?.node);
    if (!rewritten) return EMPTY();
    if (subject.type !== 'string') differ('regex-coercion', re.regex?.node, 'JavaScript tests the text of any value (null as "null"); the query tests text only');
    let text = subject.type === 'string' ? subject.q : { $string: subject.q };
    if (rewritten.ignoreCase) text = { $lower: text };
    if (rewritten.anchored) text = { $concat: [SENTINEL, text, SENTINEL] };
    return value({ $search: [text, rewritten.pattern] }, 'boolean');
  }

  /** @param {any} node @param {string} name @param {Value} a @param {Env} env @returns {Value} */
  function arrayCall(node, name, a, env) {
    const args = node.args;
    switch (name) {
      case 'join': {
        const sep = args.length === 0 ? ',' : tx(args[0], env).q;
        return value({ '$string-join': [itemsOf(a), sep] }, 'string');
      }
      case 'includes': {
        if (args.length !== 1) { reason('arguments', node, '.includes() with a position'); return EMPTY(); }
        const x = fresh('x');
        return value({ $some: { [x]: itemsOf(a) }, $satisfies: { $eq: [`$${x}`, tx(args[0], env).q] } }, 'boolean');
      }
      case 'concat':
        return { ...value([itemsOf(a), ...args.map((/** @type {any} */ x) => { const v = tx(x, env); return v.type === 'array' ? itemsOf(v) : v.q; })], 'array'), element: a.element };
      case 'map': case 'filter': case 'find': case 'some': case 'every':
        return callback(node, name, a, env);
      case 'sort': return sortCall(node, a, env);
      default:
        reason('method', node, `.${name}() is not translated`);
        return EMPTY();
    }
  }

  /** map, filter, find, some, every with an arrow callback. @param {any} node @param {string} name @param {Value} a @param {Env} env @returns {Value} */
  function callback(node, name, a, env) {
    const fn = node.args[0];
    if (node.args.length !== 1 || fn.type !== 'Arrow' || fn.params.length < 1 || fn.params.length > 2) {
      if (fn?.type === 'Identifier' && fn.name === 'Boolean' && name === 'find') {
        const x = fresh('x');
        return { ...value({ $head: { $for: { [x]: itemsOf(a) }, $where: { $boolean: `$${x}` }, $return: `$${x}` } }, a.element ?? 'unknown', true, true), fromArray: true };
      }
      reason('callback', node, `.${name}() takes an arrow function of the element (and its index) here`);
      return EMPTY();
    }
    const x = fresh(fn.params[0]);
    const binding = fn.params.length === 2 ? { [x]: { $in: itemsOf(a), $at: fresh(fn.params[1]) } } : { [x]: itemsOf(a) };
    // an element is a value of the array: present, of the type the body uses it as
    let inner = withVar(env, fn.params[0], { qname: x, value: { ...value(`$${x}`, a.element ?? 'unknown', false, false, `var:${x}`), fromArray: true } });
    if (fn.params.length === 2) {
      const i = binding[x].$at;
      inner = withVar(inner, fn.params[1], { qname: i, value: value(`$${i}`, 'number', false, false, `var:${i}`) });
    }
    const body = arrowValue(fn, inner);
    switch (name) {
      case 'map': {
        if (body.absent) differ('absent-element', fn, 'JavaScript keeps undefined as an element; the query drops it');
        return { ...value([{ $for: binding, $return: body.q }], 'array'), element: body.type };
      }
      case 'filter':
        return { ...value([{ $for: binding, $where: truthOf(body), $return: `$${x}` }], 'array'), element: a.element };
      case 'find':
        return { ...value({ $head: { $for: binding, $where: truthOf(body), $return: `$${x}` } }, a.element ?? 'unknown', true, true), fromArray: true };
      // a quantifier binds no position: with an index, test the FLWOR's matches instead
      case 'some':
        if (fn.params.length === 2) return value({ $exists: { $for: binding, $where: truthOf(body), $return: `$${x}` } }, 'boolean');
        return value({ $some: binding, $satisfies: truthOf(body) }, 'boolean');
      default:
        if (fn.params.length === 2) return value({ $empty: { $for: binding, $where: { $not: truthOf(body) }, $return: `$${x}` } }, 'boolean');
        return value({ $every: binding, $satisfies: truthOf(body) }, 'boolean');
    }
  }

  /** A callback's result as a boolean. @param {Value} v */
  const truthOf = (v) => (v.type === 'boolean' ? v.q : { $boolean: v.q });

  /** An arrow's body: an expression, or a block of statements ending in a return. @param {any} fn @param {Env} env @returns {Value} */
  function arrowValue(fn, env) {
    if (fn.expression) {
      // a boolean test keeps its guards: translate it as a condition
      const t = fn.body;
      if (t.type === 'Logical' && t.operator !== '??' || (t.type === 'Unary' && t.operator === '!')) return value(condition(t, env), 'boolean');
      return tx(t, env);
    }
    const q = statements(fn.body.body, 0, env, () => ({ $seq: [] }), 'value');
    return value(q, 'unknown', true, true);
  }

  /** `.sort((a, b) => key(a) - key(b))`: ascending, or descending with the operands swapped. @param {any} node @param {Value} a @param {Env} env @returns {Value} */
  function sortCall(node, a, env) {
    const fn = node.args[0];
    const fail = () => { reason('sort', node, '.sort() other than (a, b) => key(a) - key(b) or key(b) - key(a)'); return EMPTY(); };
    if (node.args.length !== 1 || fn.type !== 'Arrow' || !fn.expression || fn.params.length !== 2) return fail();
    const [p, r] = fn.params;
    const body = fn.body;
    if (body.type !== 'Binary' || body.operator !== '-') return fail();
    const uses = (/** @type {any} */ n, /** @type {string} */ name) => mentions(n, (id) => id === name, null);
    let dir;
    if (uses(body.left, p) && !uses(body.left, r) && uses(body.right, r) && !uses(body.right, p)) dir = 'asc';
    else if (uses(body.left, r) && !uses(body.left, p) && uses(body.right, p) && !uses(body.right, r)) dir = 'desc';
    else return fail();
    const keyNode = dir === 'asc' ? body.left : body.right;
    const twin = dir === 'asc' ? body.right : body.left;
    if (shape(keyNode, p) !== shape(twin, r)) return fail();
    const x = fresh(p);
    const inner = withVar(env, p, { qname: x, value: { ...value(`$${x}`, a.element ?? 'unknown', false, false, `var:${x}`), fromArray: true } });
    const key = tx(keyNode, inner);
    if (key.absent || key.nullable) differ('sort-key', fn, 'JavaScript leaves a NaN comparison in place; the query orders a missing key first');
    return { ...value([{ $for: { [x]: itemsOf(a) }, $orderby: [{ $key: key.q, $dir: dir }], $return: `$${x}` }], 'array'), element: a.element };
  }

  /** A node's source shape with one name abstracted. @param {any} node @param {string} name */
  function shape(node, name) {
    return JSON.stringify(node, (k, v) => (k === 'start' || k === 'end' || k === 'outerStart' || k === 'outerEnd' ? undefined
      : v && v.type === 'Identifier' && v.name === name ? { type: 'Param' } : v));
  }

  //#endregion

  //#region numbers as text

  /** `n.toFixed(d)`: rounded on the exact value, half away from zero, then written. @param {any} node @param {Value} n @param {Env} env @returns {Value} */
  function toFixed(node, n, env) {
    const d = node.args[0];
    const digits = node.args.length === 0 ? 0 : d.type === 'Literal' && Number.isInteger(d.value) && d.value >= 0 && d.value <= 20 ? d.value : null;
    if (digits === null || node.args.length > 1) { reason('toFixed', node, '.toFixed() of a literal number of digits (0 to 20)'); return EMPTY(); }
    arithmeticOperand(n, node.callee.object, env);
    const picture = digits === 0 ? '0' : `0.${'0'.repeat(digits)}`;
    const q = once(n, (x) => ({ '$format-number': [{ $if: [{ $lt: [x, 0] }, { $neg: { $round: [{ $neg: x }, digits] } }, { $round: [{ $add: [x, 0] }, digits] }] }, picture] }));
    return value(q, 'string');
  }

  /**
   * `n.toLocaleString(tag, options)` and `new Intl.NumberFormat(tag,
   * options).format(n)`, for a language the host described.
   * @param {any} node @param {Value} n @param {any[]} args @param {Env} env @returns {Value}
   */
  function localeFormat(node, n, args, env) {
    const [tagNode, optionsNode] = args;
    if (!tagNode || tagNode.type !== 'Literal' || typeof tagNode.value !== 'string' || args.length > 2) {
      reason('locale', node, 'number formatting without a literal language tag');
      return EMPTY();
    }
    const locale = opts.locales[tagNode.value];
    if (!locale) { reason('locale', tagNode, `the language '${tagNode.value}' is not one this translation describes`); return EMPTY(); }
    /** @type {Record<string, any>} */
    const o = {};
    if (optionsNode) {
      if (optionsNode.type !== 'Object') { reason('locale', optionsNode, 'formatting options that are not an object literal'); return EMPTY(); }
      for (const p of optionsNode.properties) {
        if (p.type !== 'Property' || p.computed || p.value.type !== 'Literal') { reason('locale', p, 'a formatting option that is not a literal'); return EMPTY(); }
        o[p.key] = p.value.value;
      }
    }
    for (const key of Object.keys(o)) {
      if (!['style', 'currency', 'minimumFractionDigits', 'maximumFractionDigits'].includes(key)) {
        reason('locale', optionsNode, `the formatting option '${key}'`);
        return EMPTY();
      }
    }
    arithmeticOperand(n, node, env);
    const style = o.style ?? 'decimal';
    if (style === 'currency') {
      const picture = locale.currencies?.[o.currency];
      if (!picture || o.minimumFractionDigits !== undefined || o.maximumFractionDigits !== undefined) {
        reason('locale', optionsNode ?? node, `currency '${o.currency}' formatting this translation has no measured picture for`);
        return EMPTY();
      }
      // ICU writes NaN with the currency's prefix: the picture would write NaN alone
      const nan = `${picture.slice(0, picture.search(/[#0-9]/))}${locale.nan ?? 'NaN'}`;
      return value(once(n, (x) => ({ $if: [{ $eq: [x, x] }, { '$format-number': [x, picture, locale.decimalFormat] }, nan] })), 'string');
    }
    if (style !== 'decimal') { reason('locale', optionsNode, `the formatting style '${style}'`); return EMPTY(); }
    const min = o.minimumFractionDigits ?? 0;
    const max = o.maximumFractionDigits ?? Math.max(min, 3);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 20 || min > max) {
      reason('locale', optionsNode, 'fraction digits outside 0 to 20, or a minimum above the maximum');
      return EMPTY();
    }
    const { grouping, decimal } = locale;
    const picture = `#${grouping}##0${max > 0 ? `${decimal}${'0'.repeat(min)}${'#'.repeat(max - min)}` : ''}`;
    return value({ '$format-number': [n.q, picture, locale.decimalFormat] }, 'string');
  }

  //#endregion

  //#region regular expressions

  /**
   * A JavaScript regular expression as an I-Regexp: exact where I-Regexp
   * can say the same (`\d`, `\s`, `.` and the classes spelled out), with the
   * anchors marked by a sentinel; refused where it cannot (captures,
   * lookaround, lazy quantifiers, back references).
   * @param {{ pattern: string, flags: string }} re @param {any} node
   * @returns {{ pattern: string, anchored: boolean, ignoreCase: boolean, singleMatch: boolean } | null}
   */
  function rewriteRegExp(re, node) {
    const { pattern, flags } = re;
    for (const f of flags) if (!'gi'.includes(f)) { reason('regex', node, `the regular expression flag '${f}'`); return null; }
    let out = '';
    let anchored = false;
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '\\') {
        const e = pattern[++i];
        if (e === undefined) { reason('regex', node, 'a trailing backslash'); return null; }
        const classes = /** @type {Record<string, [string, string]>} */ ({ d: ['0-9', '[0-9]'], D: ['', '[^0-9]'], w: ['A-Za-z0-9_', '[A-Za-z0-9_]'], W: ['', '[^A-Za-z0-9_]'], s: [JS_SPACE, `[${JS_SPACE}]`], S: ['', `[^${JS_SPACE}]`] });
        if (classes[e]) {
          if (inClass) {
            if (!classes[e][0]) { reason('regex', node, `\\${e} inside a character class`); return null; }
            out += classes[e][0];
          }
          else out += classes[e][1];
          continue;
        }
        if (e === 'b' || e === 'B') {
          if (inClass) { out += '\b'; continue; }
          differ('regex-subset', node, `I-Regexp has no word boundary (\\${e}): it is left out, so the pattern also matches inside words`);
          continue;
        }
        if (/[1-9k]/.test(e)) { reason('regex', node, 'a back reference'); return null; }
        if (e === 'u' || e === 'x') {
          const hex = e === 'u' ? (pattern[i + 1] === '{' ? pattern.slice(i + 2, pattern.indexOf('}', i)) : pattern.slice(i + 1, i + 5)) : pattern.slice(i + 1, i + 3);
          if (!/^[0-9a-fA-F]+$/.test(hex)) { reason('regex', node, 'a malformed escape'); return null; }
          i += e === 'u' && pattern[i + 1] === '{' ? hex.length + 2 : hex.length;
          out += escapeRegExp(String.fromCodePoint(parseInt(hex, 16)), inClass);
          continue;
        }
        const single = /** @type {Record<string, string>} */ ({ n: '\\n', r: '\\r', t: '\\t', f: '\f', v: '\u000b', 0: '\u0000' })[e];
        if (single !== undefined) { out += single; continue; }
        if (e === 'p' || e === 'P') {
          const close = pattern.indexOf('}', i);
          out += `\\${pattern.slice(i, close + 1)}`;
          i = close;
          continue;
        }
        out += escapeRegExp(e, inClass);
        continue;
      }
      if (inClass) {
        if (c === ']') { inClass = false; out += c; continue; }
        if (c === '[' ) { out += '\\['; continue; }
        out += c === '-' || c === '^' ? c : escapeRegExp(c, true);
        continue;
      }
      if (c === '[') {
        inClass = true;
        out += '[';
        if (pattern[i + 1] === '^') { out += '^'; i++; }
        if (pattern[i + 1] === ']') { reason('regex', node, 'an empty character class'); return null; }
        continue;
      }
      if (c === '(') {
        if (pattern[i + 1] === '?') {
          if (pattern[i + 2] === ':') { out += '('; i += 2; continue; }
          if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') {
            const close = pattern.indexOf('>', i);
            out += '(';
            i = close;
            continue;
          }
          reason('regex', node, 'a lookahead or lookbehind');
          return null;
        }
        out += '(';
        continue;
      }
      if ((c === '*' || c === '+' || c === '?' || c === '}') && pattern[i + 1] === '?') { reason('regex', node, 'a lazy quantifier'); return null; }
      if (c === '^' || c === '$') { anchored = true; out += SENTINEL; continue; }
      if (c === '.') { out += '[^\\n\\r  ]'; continue; }
      out += c;
    }
    const ignoreCase = flags.includes('i');
    if (ignoreCase && /[A-Z]/.test(out.replace(/\\p\{[^}]*\}/g, ''))) {
      reason('regex', node, 'a case-insensitive pattern with capitals in it');
      return null;
    }
    try {
      if (new RegExp(`^(?:${out})$`, 'u').test('')) { reason('regex', node, 'a pattern that matches the empty text, which the query refuses to replace'); return null; }
    }
    catch {
      reason('regex', node, 'a pattern the rewrite could not read');
      return null;
    }
    // a pattern anchored at the start, or both ends, matches once
    const singleMatch = anchored && !/\|/.test(out);
    return { pattern: out, anchored, ignoreCase, singleMatch };
  }

  //#endregion

  //#region statements

  /**
   * Translate statements `list[i…]`, `after` continuing past their end.
   * @param {any[]} list @param {number} i @param {Env} env @param {(env: Env) => any} after @param {string} mode
   * @returns {any}
   */
  function statements(list, i, env, after, mode) {
    if (i >= list.length) return after(env);
    const s = list[i];
    switch (s.type) {
      case 'Empty': return statements(list, i + 1, env, after, mode);
      case 'Block': return statements([...s.body, ...list.slice(i + 1)], 0, env, after, mode);
      case 'Declaration': {
        /** @type {Record<string, any>} */
        const bindings = {};
        let e = env;
        let j = i;
        // consecutive declarations share one $let
        while (j < list.length && list[j].type === 'Declaration') {
          for (const d of list[j].declarations.flatMap(expandPattern)) {
            const v = d.init ? tx(d.init, e) : EMPTY();
            if (v.type === 'skip') reason('skip-value', d, 'the skip sentinel kept in a variable');
            const inline = v.literal !== undefined && v.type !== 'object' && list[j].kind === 'const';
            if (inline) { e = withVar(e, d.name, { inline: true, value: { ...v, key: null } }); continue; }
            const qname = fresh(d.name);
            bindings[qname] = v.q;
            e = withVar(e, d.name, { qname, kind: list[j].kind, value: { ...v, pathable: false, key: v.key ?? `var:${qname}` } });
          }
          j++;
        }
        const rest = statements(list, j, e, after, mode);
        return Object.keys(bindings).length ? { $let: bindings, $return: rest } : rest;
      }
      case 'Return':
        if (s.lineBreak) reason('return-line-break', s, 'a line break right after return: JavaScript returns undefined there, whatever follows');
        return mode === 'outcome' ? outcomeOf(s.argument, env) : s.argument ? tx(s.argument, env).q : { $seq: [] };
      case 'If': return ifStatement(list, i, env, after, mode);
      case 'ExpressionStatement': {
        const effect = assignment(s.expression, env);
        if (!effect) return statements(list, i + 1, env, after, mode);
        const qname = fresh(effect.name);
        const info = env.vars.get(effect.name);
        const e = withVar(env, effect.name, { qname, kind: info.kind, value: { ...effect.value, pathable: false, key: `var:${qname}` } });
        return { $let: { [qname]: effect.value.q }, $return: statements(list, i + 1, e, after, mode) };
      }
      case 'Throw':
        reason('throw', s, 'a throw statement');
        return statements(list, i + 1, env, after, mode);
      case 'Unsupported':
        reason(s.what === 'for' || s.what === 'while' || s.what === 'do' ? 'loop' : s.what, s, `a ${s.what} statement`);
        return statements(list, i + 1, env, after, mode);
      default:
        reason('statement', s, `a ${s.type} statement`);
        return statements(list, i + 1, env, after, mode);
    }
  }

  /**
   * A destructuring declarator as plain ones: `const { a, b: c } = e` is
   * `a = e.a` and `c = e.b`, through one bound temporary when `e` is not a
   * read. Defaults, nesting, array patterns and a rest are a reason.
   * @param {any} d @returns {any[]}
   */
  function expandPattern(d) {
    if (!d.pattern) return [d];
    const { pattern } = d;
    const simple = pattern.type === 'ObjectPattern' && pattern.properties.every((/** @type {any} */ p) => p.type === 'PatternProperty'
      && !p.computed && p.value.type === 'Identifier');
    if (!simple) {
      reason('destructuring', pattern, 'a destructuring with a default, a nested or array pattern, or a rest');
      return [];
    }
    let from = d.init;
    const out = [];
    if (from.type !== 'Identifier' && from.type !== 'Member') {
      // a name no source can spell
      const name = `\u0000from${pattern.start}`;
      out.push({ type: 'Declarator', name, init: from, start: d.start, end: d.end });
      from = { type: 'Identifier', name, start: from.start, end: from.end };
    }
    for (const p of pattern.properties) {
      const init = { type: 'Member', object: from, property: String(p.key), computed: false, optional: false, start: p.start, end: p.end, destructured: true };
      out.push({ type: 'Declarator', name: p.value.name, init, start: p.start, end: p.end });
    }
    return out;
  }

  /** @param {any[]} list @param {number} i @param {Env} env @param {(env: Env) => any} after @param {string} mode */
  function ifStatement(list, i, env, after, mode) {
    const s = list[i];
    const test = condition(s.test, env);
    const yes = withFacts(env, factsWhen(s.test, env, true));
    const no = withFacts(env, factsWhen(s.test, env, false));
    const rest = list.slice(i + 1);
    if (returns(s.consequent) === 'never' && (!s.alternate || returns(s.alternate) === 'never')
      && assignsOnly(s.consequent) && (!s.alternate || assignsOnly(s.alternate))) {
      // rebind what the branches change, and go on once
      const a = effects(flat(s.consequent), yes);
      const b = s.alternate ? effects(flat(s.alternate), no) : new Map();
      /** @type {Record<string, any>} */
      const bindings = {};
      let e = env;
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const before = readVar(env.vars.get(name));
        const t = a.get(name) ?? before;
        const f = b.get(name) ?? before;
        const qname = fresh(name);
        bindings[qname] = { $if: [test, t.q, f.q] };
        const info = env.vars.get(name);
        e = withVar(e, name, { qname, kind: info.kind, value: { ...value(`$${qname}`, t.type === f.type ? t.type : 'unknown', t.absent || f.absent, t.nullable || f.nullable, `var:${qname}`), element: t.element ?? f.element } });
      }
      const next = statements(list, i + 1, e, after, mode);
      return Object.keys(bindings).length ? { $let: bindings, $return: next } : next;
    }
    // a branch that returns: each branch goes on with the statements after it
    return {
      $if: [test, statements([...flat(s.consequent), ...rest], 0, yes, after, mode),
        statements([...(s.alternate ? flat(s.alternate) : []), ...rest], 0, no, after, mode)],
    };
  }

  /** A statement's list. @param {any} s */
  const flat = (s) => (s.type === 'Block' ? s.body : [s]);

  /** Whether a statement always, never or sometimes returns (or throws). @param {any} s @returns {'always'|'never'|'mixed'} */
  function returns(s) {
    switch (s.type) {
      case 'Return': case 'Throw': return 'always';
      case 'If': {
        const a = returns(s.consequent);
        const b = s.alternate ? returns(s.alternate) : 'never';
        return a === b ? a : 'mixed';
      }
      case 'Block': {
        let seen = 'never';
        for (const t of s.body) {
          const r = returns(t);
          if (r === 'always') return seen === 'never' ? 'always' : 'mixed';
          if (r === 'mixed') seen = 'mixed';
        }
        return /** @type {'never'|'mixed'} */ (seen);
      }
      default: return 'never';
    }
  }

  /** Whether a branch only assigns and pushes. @param {any} s @returns {boolean} */
  function assignsOnly(s) {
    if (s.type === 'Block') return s.body.every(assignsOnly);
    if (s.type === 'If') return assignsOnly(s.consequent) && (!s.alternate || assignsOnly(s.alternate));
    if (s.type === 'Empty') return true;
    return s.type === 'ExpressionStatement' && isEffect(s.expression);
  }

  /** @param {any} e */
  function isEffect(e) {
    if (e.type === 'Assignment' && e.target.type === 'Identifier') return true;
    return e.type === 'Call' && e.callee.type === 'Member' && !e.callee.computed && e.callee.property === 'push' && e.callee.object.type === 'Identifier';
  }

  /** The values a branch of assignments and pushes leaves its variables with. @param {any[]} list @param {Env} env @returns {Map<string, Value>} */
  function effects(list, env) {
    /** @type {Map<string, Value>} */
    const changed = new Map();
    let e = env;
    for (const s of list) {
      if (s.type === 'Empty') continue;
      if (s.type === 'Block') {
        for (const [k, v] of effects(s.body, e)) { changed.set(k, v); e = withVar(e, k, { inline: true, value: v }); }
        continue;
      }
      if (s.type === 'If') {
        const test = condition(s.test, e);
        const a = effects(flat(s.consequent), withFacts(e, factsWhen(s.test, e, true)));
        const b = s.alternate ? effects(flat(s.alternate), withFacts(e, factsWhen(s.test, e, false))) : new Map();
        for (const name of new Set([...a.keys(), ...b.keys()])) {
          const before = readVar(e.vars.get(name));
          const t = a.get(name) ?? before;
          const f = b.get(name) ?? before;
          const v = { ...value({ $if: [test, t.q, f.q] }, t.type === f.type ? t.type : 'unknown', t.absent || f.absent, t.nullable || f.nullable), element: t.element ?? f.element };
          changed.set(name, v);
          e = withVar(e, name, { inline: true, value: v });
        }
        continue;
      }
      const effect = assignment(s.expression, e);
      if (!effect) continue;
      changed.set(effect.name, effect.value);
      e = withVar(e, effect.name, { inline: true, value: effect.value });
    }
    return changed;
  }

  /**
   * An assignment to a `let` variable, or a push to an array variable: the
   * variable and its new value. Anything else is a reason.
   * @param {any} e @param {Env} env @returns {{ name: string, value: Value } | null}
   */
  function assignment(e, env) {
    if (e.type === 'Assignment' && e.target.type === 'Identifier') {
      const name = e.target.name;
      const info = env.vars.get(name);
      if (!info || info.kind === 'const') { reason('assignment', e, `an assignment to '${name}', which is not a let variable of the body`); return null; }
      if (e.operator === '=') return { name, value: tx(e.value, env) };
      const op = e.operator.slice(0, -1);
      if (!['+', '-', '*', '/'].includes(op)) { reason('assignment', e, `the assignment operator '${e.operator}'`); return null; }
      const synthetic = { type: 'Binary', operator: op, left: e.target, right: e.value, start: e.start, end: e.end };
      return { name, value: tx(synthetic, env) };
    }
    if (e.type === 'Call' && e.callee.type === 'Member' && !e.callee.computed && e.callee.property === 'push' && e.callee.object.type === 'Identifier') {
      const name = e.callee.object.name;
      const info = env.vars.get(name);
      if (!info) { reason('push', e, `a push to '${name}', which is not a variable of the body`); return null; }
      const current = readVar(info);
      if (current.type !== 'array') { reason('push', e, `a push to '${name}', which the translation cannot tell is an array`); return null; }
      const items = e.args.map((/** @type {any} */ a) => {
        const v = tx(a, env);
        if (nullish(v, env) && v.absent) differ('absent-element', a, 'JavaScript keeps undefined as an element; the query drops it');
        return v.q;
      });
      return { name, value: { ...value([itemsOf(current), ...items], 'array'), element: current.element } };
    }
    reason('statement', e, 'an expression statement other than an assignment to a let variable or a push to an array');
    return null;
  }

  /**
   * A returned value in outcome mode: the skip sentinel or undefined skips,
   * an explanation explains, anything else is the value.
   * @param {any} node @param {Env} env @returns {any}
   */
  function outcomeOf(node, env) {
    if (!node) return { kind: 'skip' };
    if (node.type === 'Conditional') {
      return { $if: [condition(node.test, env), outcomeOf(node.consequent, withFacts(env, factsWhen(node.test, env, true))),
        outcomeOf(node.alternate, withFacts(env, factsWhen(node.test, env, false)))] };
    }
    if (node.type === 'Logical' && node.operator !== '??' && returnsSkip(node.right)) {
      const left = tx(node.left, env);
      const truthy = node.operator === '||';
      return once(left, (x) => ({ $if: [left.type === 'boolean' ? x : { $boolean: x }, truthy ? valueOutcome({ ...left, q: x }, env) : outcomeOf(node.right, env),
        truthy ? outcomeOf(node.right, withFacts(env, factsWhen(node.left, env, false))) : valueOutcome({ ...left, q: x }, env)] }));
    }
    if (node.type === 'Identifier' && (node.name === opts.skip || node.name === 'undefined') && !env.vars.has(node.name)) return { kind: 'skip' };
    // the host's other spelling of an explanation: { [explanationMember]: text }
    if (opts.explanationMember !== null && node.type === 'Object' && node.properties.length === 1
      && node.properties[0].type === 'Property' && !node.properties[0].computed && node.properties[0].key === opts.explanationMember) {
      const textValue = tx(node.properties[0].value, env);
      return { kind: 'explanation', text: textValue.type === 'string' ? textValue.q : { $string: { $default: [textValue.q, ''] } } };
    }
    if (isHelperCall(node, opts.explain, env)) {
      const [v, text] = node.args;
      if (!v) return { kind: 'skip' };
      if (v.type === 'Identifier' && v.name === opts.skip) return { kind: 'skip' };
      const val = tx(v, env);
      const textValue = text ? tx(text, env) : value('', 'string');
      if (text && (textValue.type === 'array' || textValue.type === 'object')) reason('string-of-object', text, 'an array or object as the explanation');
      const textQ = textValue.type === 'string' ? textValue.q : { $string: { $default: [textValue.q, ''] } };
      if (!nullish(val, env) || !val.absent) return { kind: 'explanation', text: textQ, value: val.q };
      return once(val, (x) => ({ $if: [{ $empty: x }, { kind: 'skip' }, { kind: 'explanation', text: textQ, value: x }] }));
    }
    return valueOutcome(tx(node, env), env);
  }

  /** @param {any} node */
  function returnsSkip(node) {
    return node.type === 'Identifier' && node.name === opts.skip;
  }

  /** @param {any} node @param {string | null} name @param {Env} env */
  function isHelperCall(node, name, env) {
    if (!name || node.type !== 'Call') return false;
    const c = node.callee;
    if (c.type === 'Identifier') return c.name === name && !env.vars.has(name);
    return c.type === 'Member' && !c.computed && c.property === name && c.object.type === 'Identifier' && c.object.name === opts.helperObject;
  }

  /** A value outcome; an undefined value skips. @param {Value} v @param {Env} env */
  function valueOutcome(v, env) {
    if (v.type === 'skip') return { kind: 'skip' };
    if (!v.absent || (v.key && env.facts.has(v.key))) return { kind: 'value', value: v.q };
    return once(v, (x) => ({ $if: [{ $empty: x }, { kind: 'skip' }, { kind: 'value', value: x }] }));
  }

  //#endregion

  // a statement after one that always returns never runs: its author meant something else
  (function unreachable(/** @type {any} */ node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(unreachable); return; }
    const list = node.type === 'Body' || node.type === 'Block' ? node.body : null;
    if (list) {
      const end = list.findIndex((/** @type {any} */ st) => returns(st) === 'always');
      if (end >= 0 && end < list.length - 1) reason('unreachable', list[end + 1], 'a statement after a return never runs');
    }
    for (const key of Object.keys(node)) if (key !== 'start' && key !== 'end') unreachable(node[key]);
  })(ast);

  // the body: statements, falling off the end returns undefined
  const root = { vars: new Map(), facts: new Set(['row']) };
  const expression = statements(ast.body, 0, root, () => (resultMode === 'outcome' ? { kind: 'skip' } : { $seq: [] }), resultMode);
  // a member of a value returned as its own statement (split(…)[0]) is translated through splitFirst: see member()
  return finish(expression, resultMode, [...callHelpers.values()], reasons, differences);

  /** @param {any} expr @param {string} mode @param {any[]} helpers @param {Reason[]} rs @param {Difference[]} ds @returns {Translation} */
  function finish(expr, mode, helpers, rs, ds) {
    const byPosition = (/** @type {any} */ a, /** @type {any} */ b) => a.at.offset - b.at.offset || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
    // one site read twice reports once
    const unique = (/** @type {any[]} */ list) => list.filter((x, i) => list.findIndex((y) => y.kind === x.kind && y.at.offset === x.at.offset) === i);
    rs = unique(rs).sort(byPosition);
    ds = unique(ds).sort(byPosition);
    const state = rs.length ? 'untranslatable' : ds.length ? 'translated-with-differences' : 'translated';
    return {
      state,
      ...(rs.length ? {} : { expression: expr, resultMode: mode, helpers: helpers.sort((a, b) => (a.name < b.name ? -1 : 1)) }),
      differences: ds,
      reasons: rs,
    };
  }
}

/**
 * Read and check the options: closed, every key known.
 * @param {any} options
 */
function readOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('translation options must be an object');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw new TypeError(`unknown translation option '${key}'`);
  const name = (/** @type {any} */ v, /** @type {string} */ what, /** @type {string | null} */ fallback) => {
    if (v === undefined) return fallback;
    if (v === null) return null;
    if (typeof v !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v)) throw new TypeError(`${what} must be a JavaScript name`);
    return v;
  };
  const helpers = options.helpers ?? {};
  if (helpers === null || typeof helpers !== 'object' || Array.isArray(helpers)) throw new TypeError('helpers must be an object');
  for (const [key, h] of Object.entries(helpers)) {
    const ok = h && typeof h === 'object' && ((h.call && typeof h.call.name === 'string' && typeof h.call.version === 'string' && !h.native)
      || (h.native && Array.isArray(h.native.params) && h.native.params.every((/** @type {any} */ p) => typeof p === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) && 'expression' in h.native && !h.call));
    if (!ok) throw new TypeError(`helper '${key}' must be { call: { name, version } } or { native: { params, expression } }`);
    for (const d of h.differences ?? []) if (!d || typeof d.kind !== 'string' || typeof d.note !== 'string') throw new TypeError(`helper '${key}' differences must be { kind, note }`);
  }
  const locales = options.locales ?? {};
  for (const [tag, l] of Object.entries(locales)) {
    if (!l || typeof l.decimalFormat !== 'string' || typeof l.grouping !== 'string' || typeof l.decimal !== 'string')
      throw new TypeError(`locale '${tag}' must be { decimalFormat, grouping, decimal, currencies?, nan? }`);
  }
  return {
    argument: /** @type {string} */ (name(options.argument, 'argument', 'row')),
    helperObject: name(options.helperObject, 'helperObject', 'helpers'),
    helpers: /** @type {Record<string, any>} */ (helpers),
    skip: name(options.skip, 'skip', 'SKIP'),
    explain: name(options.explain, 'explain', 'because'),
    explanationMember: name(options.explanationMember, 'explanationMember', null),
    locales: /** @type {Record<string, any>} */ (locales),
  };
}

/** Whether a body returns an object literal whose one member names an explanation. @param {any} node @param {string} member @returns {boolean} */
function returnsExplanationObject(node, member) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => returnsExplanationObject(n, member));
  if (node.type === 'Return' && node.argument?.type === 'Object' && node.argument.properties.length === 1
    && node.argument.properties[0].key === member && !node.argument.properties[0].computed) return true;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object' && key !== 'start' && key !== 'end' && returnsExplanationObject(v, member)) return true;
  }
  return false;
}

/**
 * Whether an AST mentions an identifier the predicate accepts, bare or as a
 * member of the helpers' parameter.
 * @param {any} node @param {(name: string) => boolean} test @param {string | null} helperObject
 */
function mentions(node, test, helperObject) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => mentions(n, test, helperObject));
  if (node.type === 'Identifier' && test(node.name)) return true;
  if (node.type === 'Member' && !node.computed && node.object.type === 'Identifier' && node.object.name === helperObject && test(node.property)) return true;
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end') continue;
    const v = node[key];
    if (v && typeof v === 'object' && mentions(v, test, helperObject)) return true;
  }
  return false;
}

/** Rename a native template's parameters (`$value`, `$value.x`, `$value[*]`). @param {any} q @param {Record<string, string>} renames @returns {any} */
function renameVariables(q, renames) {
  if (typeof q === 'string') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(q);
    if (m && Object.hasOwn(renames, m[1]) && (m[2] === '' || m[2][0] === '.' || m[2][0] === '[')) return `$${renames[m[1]]}${m[2]}`;
    return q;
  }
  if (Array.isArray(q)) return q.map((x) => renameVariables(x, renames));
  if (q && typeof q === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(q)) out[k] = k === '$const' ? v : renameVariables(v, renames);
    return out;
  }
  return q;
}

/** Escape a text for an I-Regexp. @param {string} text @param {boolean} [inClass] */
function escapeRegExp(text, inClass = false) {
  return inClass ? text.replace(/[\\\][^-]/g, '\\$&') : text.replace(/[.*+?()[\]{}|\\^$-]/g, '\\$&');
}

/**
 * Trim a text as JavaScript's `trim`, `trimStart` and `trimEnd` do (its white
 * space and line terminators): the QUERY-FORMAT §8.7 composition.
 * @param {any} q @param {string} which
 */
function trim(q, which) {
  const space = `[${JS_SPACE}]*`;
  const end = which === 'trimStart' ? q : { $replace: [{ $concat: [q, SENTINEL] }, `${space}${SENTINEL}`, ''] };
  if (which === 'trimEnd') return end;
  return { $replace: [{ $concat: [SENTINEL, end] }, `${SENTINEL}${space}`, ''] };
}

/**
 * @typedef {Object} TranslateOptions
 * @property {string} [argument] - the row's parameter name (default `row`)
 * @property {string | null} [helperObject] - the helpers' parameter name, whose members read as bare helper names (default `helpers`)
 * @property {Record<string, HelperMapping>} [helpers] - the helpers the body calls
 * @property {string | null} [skip] - the skip sentinel's name (default `SKIP`)
 * @property {string | null} [explain] - the explanation helper's name (default `because`)
 * @property {string | null} [explanationMember] - a returned object literal whose one member has
 *   this name is an explanation, its value the text (default none)
 * @property {Record<string, { decimalFormat: string, grouping: string, decimal: string, currencies?: Record<string, string>, nan?: string }>} [locales]
 *   the languages number formatting may name, each with the decimal format registered for it and its currency pictures
 */
/**
 * @typedef {Object} HelperMapping
 * @property {{ name: string, version: string }} [call] - a `$call` of the host helper
 * @property {{ params: string[], expression: any }} [native] - an expansion into query operators over its parameters
 * @property {string} [returns] - the type it returns (number, string, boolean, array, object)
 * @property {string} [element] - an array result's element type
 * @property {boolean} [absent] - whether it can return undefined (default true)
 * @property {boolean} [nullable] - whether it can return null (default true)
 * @property {{ kind: string, note: string }[]} [differences] - where it differs from the JavaScript helper
 */
/** @typedef {{ kind: string, at: { offset: number, line: number, column: number }, message: string }} Reason */
/** @typedef {{ kind: string, at: { offset: number, line: number, column: number }, note: string }} Difference */
/**
 * @typedef {Object} Translation
 * @property {'translated' | 'translated-with-differences' | 'untranslatable'} state
 * @property {any} [expression] - the JSON Query expression (absent when untranslatable)
 * @property {'value' | 'outcome'} [resultMode]
 * @property {{ name: string, version: string }[]} [helpers] - the host helpers it calls
 * @property {Difference[]} differences
 * @property {Reason[]} reasons
 */
