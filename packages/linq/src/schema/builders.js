//@ts-check
/**
 * @file The schema builders — one small immutable class per kind of
 * JSON Schema node. A builder holds frozen STATE (its kind, its
 * children, the constraint keywords it collected, the annotations it
 * carries); every method answers a new builder; `.schema` assembles the
 * document once and memoizes it. Nothing here evaluates a schema: a
 * builder refuses only what it cannot spell (`JL0101`, `JL0102`) or
 * what a document could not carry faithfully (`JL0103`, `JL0104`), and
 * leaves every question of meaning to the validator's compiler.
 *
 * The base class is what a subclass extends — the model pen adds its
 * vocabulary by subclassing through `with()`, never by patching a
 * prototype it imported.
 */

import { isJsonValue } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { SCHEMA_BUILDER, isSchemaBuilder } from './brand.js';
import { assemble } from './emit.js';
import { captureCheck } from './check.js';

/** Kinds that carry a single scalar `type` — the only nodes `coerceToType` runs on. */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** A `$defs` name that spells as a `$ref` fragment without encoding. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * The keywords the pen writes itself, or that would change what a
 * document asserts: `meta()` refuses them so an annotation is never a
 * back door around a builder.
 */
const OWNED = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', '$anchor', '$dynamicRef',
  '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', '$query',
  '$data', 'data',
  'type', 'nullable', 'const', 'enum',
  'properties', 'required', 'additionalProperties', 'patternProperties',
  'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired',
  'dependentSchemas', 'dependencies', 'unevaluatedProperties',
  'items', 'prefixItems', 'additionalItems', 'contains', 'minContains',
  'maxContains', 'minItems', 'maxItems', 'uniqueItems', 'unevaluatedItems',
  'minLength', 'maxLength', 'pattern', 'format',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'formatMinimum', 'formatMaximum', 'formatExclusiveMinimum', 'formatExclusiveMaximum',
  'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
  'default', 'title', 'description', 'examples', 'errorMessage',
  'x-coerce', 'x-trim',
]);

/** @param {any} value */
function hasNegativeZero(value) {
  if (typeof value === 'number') return Object.is(value, -0);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  return Object.keys(value).some((key) => hasNegativeZero(value[key]));
}

/** What a refused value is, for a message. @param {any} value */
function describeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') return `a ${value.constructor?.name ?? 'non-plain'} instance`;
  return `a ${typeof value}`;
}

/**
 * The JSON boundary every value entering a document crosses — the
 * constant rule the chain applies to captured literals, applied here to
 * defaults, literals, examples and annotations.
 * @param {any} value
 * @param {string} what - the receiving keyword or method
 * @returns {any} the value, unchanged
 */
export function requireJson(value, what) {
  if (isJsonValue(value) && !hasNegativeZero(value)) return value;
  throw new LinqBuildError('JL0101',
    `${what} received ${describeValue(value)}, which is not JSON — a document carries `
    + 'null, booleans, finite numbers (never -0), strings, arrays and plain objects, '
    + 'and nothing else');
}

/** @param {any} value @param {string} what */
function requireBuilder(value, what) {
  if (isSchemaBuilder(value)) return value;
  throw new LinqBuildError('JL0101',
    `${what} takes a schema builder, got ${describeValue(value)} — wrap a hand-written `
    + 'JSON Schema with from()');
}

/** A builder, or a hand-written JSON Schema wrapped as one. @param {any} value @param {string} what */
function builderOrJson(value, what) {
  if (isSchemaBuilder(value)) return value;
  if (typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value))) {
    return from(value);
  }
  return requireBuilder(value, what);
}

/** @param {any} value @param {string} what */
function requireString(value, what) {
  if (typeof value === 'string') return value;
  throw new LinqBuildError('JL0101', `${what} takes a string, got ${describeValue(value)}`);
}

/** @param {any} value @param {string} what */
function requireCount(value, what) {
  if (Number.isInteger(value) && value >= 0) return value;
  throw new LinqBuildError('JL0101',
    `${what} takes a non-negative integer, got ${describeValue(value)}`);
}

/** @param {any} value @param {string} what */
function requireNumber(value, what) {
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new LinqBuildError('JL0101', `${what} takes a finite number, got ${describeValue(value)}`);
}

/** @param {any} value @param {string} what */
function requireName(value, what) {
  if (typeof value === 'string' && NAME_RE.test(value)) return value;
  throw new LinqBuildError('JL0101',
    `${what} takes a definition name (letters, digits, '_', '.', '-', not starting `
    + `with a digit), got ${describeValue(value)}`);
}

/** @param {any} value @param {string} what @returns {[string, any][]} */
function requireBuilderMap(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinqBuildError('JL0101',
      `${what} takes a plain object of builders, got ${describeValue(value)}`);
  }
  return Object.keys(value).map((key) => [key, requireBuilder(value[key], `${what}.${key}`)]);
}

/**
 * Replace or append one annotation, keeping the order annotations were
 * first set in.
 * @param {readonly (readonly [string, any])[]} annotations
 * @param {string} key
 * @param {any} value
 * @returns {readonly (readonly [string, any])[]}
 */
function annotate(annotations, key, value) {
  const index = annotations.findIndex(([k]) => k === key);
  const next = annotations.slice();
  if (index === -1) next.push(Object.freeze([key, value]));
  else next[index] = Object.freeze([key, value]);
  return Object.freeze(next);
}

/** The state every kind shares. @param {string} kind @param {object} own */
function initial(kind, own) {
  return Object.freeze({
    kind,
    keywords: Object.freeze({}),
    annotations: Object.freeze([]),
    checks: Object.freeze([]),
    nullable: false,
    optional: false,
    ...own,
  });
}

/** The immutable base every builder shares. */
export class SchemaBuilder {
  #state;
  #document;

  /** @param {any} state - frozen builder state */
  constructor(state) {
    this.#state = state;
  }

  /** The brand: `true` on every builder, absent on a document. */
  get [SCHEMA_BUILDER]() { return true; }

  /** The frozen state (kind, children, keywords, annotations). */
  get state() { return this.#state; }

  /**
   * A new builder of the same class with part of the state replaced —
   * the one way state changes, for this class and for a subclass.
   * @param {object} patch
   * @returns {this}
   */
  with(patch) {
    const Kind = /** @type {any} */ (this.constructor);
    return new Kind(Object.freeze({ ...this.#state, ...patch }));
  }

  /** The document: assembled once, deep-frozen, `$defs` hoisted. */
  get schema() {
    if (this.#document === undefined) this.#document = assemble(this);
    return this.#document;
  }

  /** `JSON.stringify(builder)` is the document. */
  toJSON() { return this.schema; }

  /** As an object member: left out of `required`. */
  optional() { return this.with({ optional: true }); }

  /** Admit `null`: folded into `type` where there is one, an `anyOf` otherwise. */
  nullable() {
    if (this.#hasAnnotation('x-coerce')) {
      throw new LinqBuildError('JL0102',
        'a coerced value cannot be nullable — the normalizer coerces only a single-typed '
        + 'scalar, so a nullable coercion would never run; drop coerce() or nullable()');
    }
    return this.with({ nullable: true });
  }

  /** `default`: materialized by the normalizer's `useDefaults`. @param {any} value */
  default(value) { return this.annotate('default', requireJson(value, 'default()')); }

  /** `description`. @param {string} text */
  describe(text) { return this.annotate('description', requireString(text, 'describe()')); }

  /** `title`. @param {string} text */
  title(text) { return this.annotate('title', requireString(text, 'title()')); }

  /** One more entry of `examples`. @param {any} value */
  example(value) {
    const current = this.#annotation('examples') ?? [];
    return this.annotate('examples', [...current, requireJson(value, 'example()')]);
  }

  /**
   * Annotations written verbatim; a keyword the pen owns is refused.
   * @param {Record<string, any>} annotations
   */
  meta(annotations) {
    if (annotations === null || typeof annotations !== 'object' || Array.isArray(annotations)) {
      throw new LinqBuildError('JL0101',
        `meta() takes a plain object of annotations, got ${describeValue(annotations)}`);
    }
    let next = this;
    for (const key of Object.keys(annotations)) {
      if (OWNED.has(key)) {
        throw new LinqBuildError('JL0104',
          `meta() cannot write '${key}' — the pen owns that keyword; spell it through the `
          + 'builder method that emits it, or wrap a hand-written schema with from()');
      }
      next = next.annotate(key, requireJson(annotations[key], `meta().${key}`));
    }
    return next;
  }

  /** `errorMessage`: the validator's author-supplied message spec. @param {any} spec */
  message(spec) { return this.annotate('errorMessage', requireJson(spec, 'message()')); }

  /**
   * A cross-field rule as `$query`: a callback captured through the
   * chain's recording proxy (the value at `$`, and `{ root, path }`),
   * or a hand-written query document embedded verbatim.
   * @param {((value: any, externals: any) => any) | object} rule
   */
  check(rule) {
    const query = typeof rule === 'function'
      ? captureCheck(rule)
      : requireJson(rule, 'check()');
    return this.with({ checks: Object.freeze([...this.#state.checks, query]) });
  }

  /** `x-coerce: true` — the normalizer's per-field coercion predicate. */
  coerce() {
    if (!SCALARS.has(this.#state.kind)) {
      throw new LinqBuildError('JL0102',
        `coerce() applies to a scalar (string, number, integer, boolean, nil); a `
        + `${this.#state.kind} has no single type the normalizer could coerce to`);
    }
    if (this.#state.nullable) {
      throw new LinqBuildError('JL0102',
        'a nullable value cannot be coerced — the normalizer coerces only a single-typed '
        + 'scalar, so the coercion would never run; drop nullable() or coerce()');
    }
    return this.annotate('x-coerce', true);
  }

  /** `x-trim: true` — the normalizer's per-field trim predicate. */
  trim() {
    if (this.#state.kind !== 'string') {
      throw new LinqBuildError('JL0102',
        `trim() applies to a string; a ${this.#state.kind} carries no whitespace to trim`);
    }
    return this.annotate('x-trim', true);
  }

  /**
   * Set one annotation keyword.
   * @param {string} key
   * @param {any} value
   * @returns {this}
   */
  annotate(key, value) {
    return this.with({ annotations: annotate(this.#state.annotations, key, value) });
  }

  /** @param {string} key */
  #annotation(key) {
    const found = this.#state.annotations.find(([k]) => k === key);
    return found === undefined ? undefined : found[1];
  }

  /** @param {string} key */
  #hasAnnotation(key) {
    return this.#state.annotations.some(([k]) => k === key);
  }

  /**
   * One constraint keyword, in the order first set.
   * @param {string} key
   * @param {any} value
   * @returns {this}
   */
  keyword(key, value) {
    return this.with({ keywords: Object.freeze({ ...this.#state.keywords, [key]: value }) });
  }
}

/** `{ type: 'string' }` and the string constraints. */
export class StringBuilder extends SchemaBuilder {
  /** `minLength`. @param {number} n */
  min(n) { return this.keyword('minLength', requireCount(n, 'min()')); }
  /** `maxLength`. @param {number} n */
  max(n) { return this.keyword('maxLength', requireCount(n, 'max()')); }
  /** `minLength` and `maxLength` together. @param {number} n */
  length(n) { return this.min(n).max(n); }
  /**
   * `pattern`: a regular expression source (a `RegExp` without flags is
   * taken by its source — the keyword has no flags to carry).
   * @param {string | RegExp} source
   */
  pattern(source) {
    if (source instanceof RegExp) {
      if (source.flags !== '') {
        throw new LinqBuildError('JL0102',
          `pattern() cannot carry the flags '${source.flags}' — a JSON Schema pattern is a `
          + 'bare regular expression source; spell the flag inside the expression, or drop it');
      }
      return this.keyword('pattern', source.source);
    }
    return this.keyword('pattern', requireString(source, 'pattern()'));
  }
  /** `format`. @param {string} name */
  format(name) { return this.keyword('format', requireString(name, 'format()')); }
  /** `format: 'email'`. */
  email() { return this.format('email'); }
  /** `format: 'uuid'`. */
  uuid() { return this.format('uuid'); }
  /** `format: 'uri'`. */
  uri() { return this.format('uri'); }
}

/** `{ type: 'number' | 'integer' }` and the numeric constraints. */
export class NumberBuilder extends SchemaBuilder {
  /** `minimum`. @param {number} n */
  min(n) { return this.keyword('minimum', requireNumber(n, 'min()')); }
  /** `maximum`. @param {number} n */
  max(n) { return this.keyword('maximum', requireNumber(n, 'max()')); }
  /** `exclusiveMinimum`. @param {number} n */
  gt(n) { return this.keyword('exclusiveMinimum', requireNumber(n, 'gt()')); }
  /** `exclusiveMaximum`. @param {number} n */
  lt(n) { return this.keyword('exclusiveMaximum', requireNumber(n, 'lt()')); }
  /** `multipleOf` (strictly positive). @param {number} n */
  multipleOf(n) {
    if (!(requireNumber(n, 'multipleOf()') > 0)) {
      throw new LinqBuildError('JL0101', `multipleOf() takes a positive number, got ${n}`);
    }
    return this.keyword('multipleOf', n);
  }
  /** `type: 'integer'`. */
  int() { return this.with({ kind: 'integer' }); }
}

/** `{ type: 'array', items }` and the array constraints. */
export class ArrayBuilder extends SchemaBuilder {
  /** `minItems`. @param {number} n */
  min(n) { return this.keyword('minItems', requireCount(n, 'min()')); }
  /** `maxItems`. @param {number} n */
  max(n) { return this.keyword('maxItems', requireCount(n, 'max()')); }
  /** `minItems` and `maxItems` together. @param {number} n */
  length(n) { return this.min(n).max(n); }
  /** `uniqueItems: true`. */
  unique() { return this.keyword('uniqueItems', true); }
  /** `contains`. @param {any} builder */
  contains(builder) { return this.with({ contains: requireBuilder(builder, 'contains()') }); }
}

/** `{ type: 'array', prefixItems }` — every position required, the rest open. */
export class TupleBuilder extends SchemaBuilder {
  /** `items`: what may follow the positions (`never()` closes the tuple). @param {any} builder */
  rest(builder) { return this.with({ rest: requireBuilder(builder, 'rest()') }); }
}

/** `{ type: 'object', properties, required, additionalProperties: false }`. */
export class ObjectBuilder extends SchemaBuilder {
  /** Drop `additionalProperties: false`: the object admits other members. */
  open() { return this.with({ open: true }); }
  /** `minProperties`. @param {number} n */
  minProperties(n) { return this.keyword('minProperties', requireCount(n, 'minProperties()')); }
  /** `maxProperties`. @param {number} n */
  maxProperties(n) { return this.keyword('maxProperties', requireCount(n, 'maxProperties()')); }
  /** `patternProperties`. @param {Record<string, any>} map pattern → builder */
  patternProperties(map) {
    return this.with({ patterns: Object.freeze(requireBuilderMap(map, 'patternProperties()')) });
  }
  /** `propertyNames`. @param {any} builder */
  propertyNames(builder) { return this.with({ names: requireBuilder(builder, 'propertyNames()') }); }
  /** `dependentRequired`. @param {Record<string, string[]>} map */
  dependentRequired(map) {
    requireJson(map, 'dependentRequired()');
    if (map === null || typeof map !== 'object' || Array.isArray(map)
      || Object.keys(map).some((key) => !Array.isArray(map[key])
        || map[key].some((name) => typeof name !== 'string'))) {
      throw new LinqBuildError('JL0101',
        'dependentRequired() takes a plain object mapping a member name to an array of member names');
    }
    return this.with({ dependent: map });
  }
  /** More members (a later spelling of a name replaces the earlier one). @param {Record<string, any>} props */
  extend(props) {
    const added = requireBuilderMap(props, 'extend()');
    const kept = this.state.props.filter(([key]) => !added.some(([k]) => k === key));
    return this.with({ props: Object.freeze([...kept, ...added]) });
  }
  /** Only these members. @param {readonly string[]} keys */
  pick(keys) {
    const names = requireKeys(keys, 'pick()', this.state.props);
    return this.with({ props: Object.freeze(this.state.props.filter(([key]) => names.includes(key))) });
  }
  /** All but these members. @param {readonly string[]} keys */
  omit(keys) {
    const names = requireKeys(keys, 'omit()', this.state.props);
    return this.with({ props: Object.freeze(this.state.props.filter(([key]) => !names.includes(key))) });
  }
  /** Every member optional. */
  partial() {
    return this.with({
      props: Object.freeze(this.state.props.map(([key, member]) => [key, member.optional()])),
    });
  }
  /** These members required again (every member, when no keys are given). @param {readonly string[]} [keys] */
  required(keys) {
    const names = keys === undefined
      ? this.state.props.map(([key]) => key)
      : requireKeys(keys, 'required()', this.state.props);
    return this.with({
      props: Object.freeze(this.state.props.map(([key, member]) =>
        (names.includes(key) ? [key, member.with({ optional: false })] : [key, member]))),
    });
  }
}

/** @param {any} keys @param {string} what @param {readonly any[]} props */
function requireKeys(keys, what, props) {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw new LinqBuildError('JL0101', `${what} takes an array of member names`);
  }
  for (const key of keys) {
    if (!props.some(([name]) => name === key)) {
      throw new LinqBuildError('JL0101', `${what}: '${key}' is not a member of this object`);
    }
  }
  return keys;
}

/** `{ if, then, else }` — a conditional; typed `unknown`, as emit reads it. */
export class WhenBuilder extends SchemaBuilder {
  /**
   * The `then` branch. (A builder carrying this method is thenable-shaped:
   * an awaited or promise-resolved `when()` reaches here with a function,
   * which is refused by name rather than resolved as a schema.)
   * @param {any} builder
   */
  then(builder) {
    if (typeof builder === 'function') {
      throw new LinqBuildError('JL0101',
        'a when() builder is not a promise — it was awaited or handed to a promise '
        + 'resolution; keep builders out of async return positions');
    }
    return this.with({ then: requireBuilder(builder, 'then()') });
  }
  /** The `else` branch. @param {any} builder */
  else(builder) { return this.with({ else: requireBuilder(builder, 'else()') }); }
}

/** `false` — the schema nothing satisfies; it carries no keywords. */
export class NeverBuilder extends SchemaBuilder {
  /** @param {string} key @param {any} value */
  annotate(key, value) {
    void value;
    throw new LinqBuildError('JL0102',
      `never() is the boolean schema false, which carries no '${key}' — annotate the member `
      + 'that holds it, or nullable() it first');
  }
  /** @param {any} rule */
  check(rule) {
    void rule;
    throw new LinqBuildError('JL0102', 'never() is the boolean schema false; nothing reaches a check on it');
  }
}

// ————— the named exports —————

/** `{ type: 'string' }`. */
export function string() { return new StringBuilder(initial('string', {})); }
/** `{ type: 'number' }`. */
export function number() { return new NumberBuilder(initial('number', {})); }
/** `{ type: 'integer' }`. */
export function integer() { return new NumberBuilder(initial('integer', {})); }
/** `{ type: 'boolean' }`. */
export function boolean() { return new SchemaBuilder(initial('boolean', {})); }
/** `{ type: 'null' }`. */
export function nil() { return new SchemaBuilder(initial('null', {})); }
/** `{}` — anything. */
export function any() { return new SchemaBuilder(initial('any', {})); }
/** `false` — nothing. */
export function never() { return new NeverBuilder(initial('never', {})); }

/** `{ const: value }`. @param {any} value */
export function literal(value) {
  return new SchemaBuilder(initial('literal', { value: requireJson(value, 'literal()') }));
}

/** `{ enum: values }`. @param {readonly any[]} values */
export function enumOf(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new LinqBuildError('JL0101', 'enumOf() takes a non-empty array of JSON values');
  }
  return new SchemaBuilder(initial('enum', {
    values: Object.freeze(values.map((value) => requireJson(value, 'enumOf()'))),
  }));
}

/** A closed object (`additionalProperties: false`) of named members. @param {Record<string, any>} props */
export function object(props) {
  return new ObjectBuilder(initial('object', {
    props: Object.freeze(requireBuilderMap(props, 'object()')),
    open: false,
    patterns: Object.freeze([]),
    names: null,
    dependent: null,
  }));
}

/** `{ type: 'array', items }`. @param {any} items */
export function array(items) {
  return new ArrayBuilder(initial('array', {
    items: requireBuilder(items, 'array()'), contains: null,
  }));
}

/** `{ type: 'array', prefixItems, minItems }`. @param {readonly any[]} items */
export function tuple(items) {
  if (!Array.isArray(items)) {
    throw new LinqBuildError('JL0101', 'tuple() takes an array of builders');
  }
  return new TupleBuilder(initial('tuple', {
    items: Object.freeze(items.map((item, i) => requireBuilder(item, `tuple()[${i}]`))),
    rest: null,
  }));
}

/** `{ type: 'object', additionalProperties: values }`. @param {any} values */
export function record(values) {
  return new SchemaBuilder(initial('record', { values: requireBuilder(values, 'record()') }));
}

/** @param {any} options @param {string} what */
function requireOptions(options, what) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new LinqBuildError('JL0101', `${what} takes a non-empty array of builders or schemas`);
  }
  return Object.freeze(options.map((option, i) => builderOrJson(option, `${what}[${i}]`)));
}

/** `{ anyOf: options }`. @param {readonly any[]} options */
export function union(options) {
  return new SchemaBuilder(initial('union', { options: requireOptions(options, 'union()') }));
}

/**
 * `{ oneOf: options }` where every option is an object declaring the
 * discriminator as a `literal()` or `enumOf()` member.
 * @param {string} key
 * @param {readonly any[]} options
 */
export function discriminated(key, options) {
  requireString(key, 'discriminated()');
  const parts = requireOptions(options, 'discriminated()');
  parts.forEach((option, i) => {
    const st = option.state;
    const member = st.kind === 'object' ? st.props.find(([name]) => name === key) : undefined;
    const tag = member === undefined ? null : member[1].state.kind;
    if (tag !== 'literal' && tag !== 'enum') {
      throw new LinqBuildError('JL0102',
        `discriminated('${key}') option ${i} does not declare '${key}' as a literal() or `
        + 'enumOf() member — without the tag on every option the oneOf is not a '
        + 'discriminated union; use union() for an untagged one');
    }
  });
  return new SchemaBuilder(initial('discriminated', { key, options: parts }));
}

/** `{ allOf: parts }` — parts that are objects must be `open()`. @param {readonly any[]} parts */
export function intersection(parts) {
  return new SchemaBuilder(initial('intersection', { options: requireOptions(parts, 'intersection()') }));
}

/**
 * A definition: hoisted to `$defs` and referenced wherever it is used.
 * @param {string} name
 * @param {any} builder
 */
export function named(name, builder) {
  return new SchemaBuilder(initial('named', {
    name: requireName(name, 'named()'), target: requireBuilder(builder, 'named()'),
  }));
}

/** A reference to a definition by name. @param {string} name */
export function ref(name) {
  return new SchemaBuilder(initial('ref', { name: requireName(name, 'ref()') }));
}

/** A deferred reference to a NAMED builder — the recursion spelling. @param {() => any} thunk */
export function lazy(thunk) {
  if (typeof thunk !== 'function') {
    throw new LinqBuildError('JL0101', 'lazy() takes a function returning a named builder');
  }
  return new SchemaBuilder(initial('lazy', { thunk }));
}

/** `{ if: cond }`, extended by `.then()`/`.else()`. @param {any} cond */
export function when(cond) {
  return new WhenBuilder(initial('when', {
    cond: requireBuilder(cond, 'when()'), then: null, else: null,
  }));
}

/** A hand-written JSON Schema, embedded verbatim. @param {object | boolean} json */
export function from(json) {
  if (typeof json !== 'boolean'
    && (json === null || typeof json !== 'object' || Array.isArray(json))) {
    throw new LinqBuildError('JL0101',
      `from() takes a JSON Schema object or boolean, got ${describeValue(json)}`);
  }
  return new SchemaBuilder(initial('raw', { json: requireJson(json, 'from()') }));
}

/** `{ type: 'string', format: 'date-time' }`. */
export function datetime() { return string().format('date-time'); }
/** `{ type: 'string', format: 'date' }`. */
export function date() { return string().format('date'); }
/** `{ type: 'string', format: 'time' }`. */
export function time() { return string().format('time'); }
/** `{ type: 'string', format: 'duration' }`. */
export function duration() { return string().format('duration'); }

/** The dialect a standalone document may declare. */
const DRAFTS = Object.freeze({ '2020-12': 'https://json-schema.org/draft/2020-12/schema' });

/**
 * A standalone document: the builder's schema, with `$schema` first when
 * a draft is named. The pen writes the 2020-12 vocabulary and no other.
 * @param {any} root
 * @param {{ draft?: '2020-12' }} [options]
 * @returns {any} the deep-frozen document
 */
export function document(root, options = {}) {
  const schema = requireBuilder(root, 'document()').schema;
  if (options.draft === undefined) return schema;
  const uri = DRAFTS[options.draft];
  if (uri === undefined) {
    throw new LinqBuildError('JL0102',
      `document() writes the 2020-12 vocabulary only; '${options.draft}' is not a draft it `
      + 'can declare');
  }
  if (typeof schema === 'boolean') {
    throw new LinqBuildError('JL0102', 'a boolean schema cannot declare a $schema');
  }
  return Object.freeze({ $schema: uri, ...schema });
}
