//@ts-check
/**
 * @file The named factory functions of a pen — `string()`, `object()`,
 * `union()`, `document()`, … — built ONCE per set of builder classes.
 * `@jarenjs/linq/schema` calls this with the base classes; a pen that
 * extends the schema pen (`./model`) calls it with its subclasses, so
 * the wiring exists exactly once and no subpath patches another's
 * prototype. Every factory answers an instance of the class it was
 * handed, and `with()` keeps that class through every method.
 */

import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder } from './brand.js';
import {
  initial, requireJson, requireBuilder, requireString, requireName,
  requireBuilderMap, describeValue,
} from './builders.js';

/**
 * @typedef {object} BuilderClasses
 * @property {any} Base - the class every untyped kind is built from
 * @property {any} String
 * @property {any} Number
 * @property {any} Array
 * @property {any} Tuple
 * @property {any} Object
 * @property {any} When
 * @property {any} Never
 */

/**
 * Build the factory functions for one set of builder classes.
 * @param {BuilderClasses} classes
 * @returns {Record<string, Function>} the named factories, frozen
 */
export function createFactories(classes) {
  const {
    Base: BaseBuilder, String: StringBuilder, Number: NumberBuilder,
    Array: ArrayBuilder, Tuple: TupleBuilder, Object: ObjectBuilder,
    When: WhenBuilder, Never: NeverBuilder,
  } = classes;

  /** A builder, or a hand-written JSON Schema wrapped as one. @param {any} value @param {string} what */
  function builderOrJson(value, what) {
    if (isSchemaBuilder(value)) return value;
    if (typeof value === 'boolean' || (value !== null && typeof value === 'object' && !Array.isArray(value))) {
      return from(value);
    }
    return requireBuilder(value, what);
  }


  /** `{ type: 'string' }`. */
  function string() { return new StringBuilder(initial('string', {})); }
  /** `{ type: 'number' }`. */
  function number() { return new NumberBuilder(initial('number', {})); }
  /** `{ type: 'integer' }`. */
  function integer() { return new NumberBuilder(initial('integer', {})); }
  /** `{ type: 'boolean' }`. */
  function boolean() { return new BaseBuilder(initial('boolean', {})); }
  /** `{ type: 'null' }`. */
  function nil() { return new BaseBuilder(initial('null', {})); }
  /** `{}` — anything. */
  function any() { return new BaseBuilder(initial('any', {})); }
  /** `false` — nothing. */
  function never() { return new NeverBuilder(initial('never', {})); }

  /** `{ const: value }`. @param {any} value */
  function literal(value) {
    return new BaseBuilder(initial('literal', { value: requireJson(value, 'literal()') }));
  }

  /** `{ enum: values }`. @param {readonly any[]} values */
  function enumOf(values) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new LinqBuildError('JL0101', 'enumOf() takes a non-empty array of JSON values');
    }
    return new BaseBuilder(initial('enum', {
      values: Object.freeze(values.map((value) => requireJson(value, 'enumOf()'))),
    }));
  }

  /** A closed object (`additionalProperties: false`) of named members. @param {Record<string, any>} props */
  function object(props) {
    return new ObjectBuilder(initial('object', {
      props: Object.freeze(requireBuilderMap(props, 'object()')),
      open: false,
      patterns: Object.freeze([]),
      names: null,
      dependent: null,
    }));
  }

  /** `{ type: 'array', items }`. @param {any} items */
  function array(items) {
    return new ArrayBuilder(initial('array', {
      items: requireBuilder(items, 'array()'), contains: null,
    }));
  }

  /** `{ type: 'array', prefixItems, minItems }`. @param {readonly any[]} items */
  function tuple(items) {
    if (!Array.isArray(items)) {
      throw new LinqBuildError('JL0101', 'tuple() takes an array of builders');
    }
    return new TupleBuilder(initial('tuple', {
      items: Object.freeze(items.map((item, i) => requireBuilder(item, `tuple()[${i}]`))),
      rest: null,
    }));
  }

  /** `{ type: 'object', additionalProperties: values }`. @param {any} values */
  function record(values) {
    return new BaseBuilder(initial('record', { values: requireBuilder(values, 'record()') }));
  }

  /** @param {any} options @param {string} what */
  function requireOptions(options, what) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new LinqBuildError('JL0101', `${what} takes a non-empty array of builders or schemas`);
    }
    return Object.freeze(options.map((option, i) => builderOrJson(option, `${what}[${i}]`)));
  }

  /** `{ anyOf: options }`. @param {readonly any[]} options */
  function union(options) {
    return new BaseBuilder(initial('union', { options: requireOptions(options, 'union()') }));
  }

  /**
   * `{ oneOf: options }` where every option is an object declaring the
   * discriminator as a `literal()` or `enumOf()` member.
   * @param {string} key
   * @param {readonly any[]} options
   */
  function discriminated(key, options) {
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
    return new BaseBuilder(initial('discriminated', { key, options: parts }));
  }

  /** `{ allOf: parts }` — parts that are objects must be `open()`. @param {readonly any[]} parts */
  function intersection(parts) {
    return new BaseBuilder(initial('intersection', { options: requireOptions(parts, 'intersection()') }));
  }

  /**
   * A definition: hoisted to `$defs` and referenced wherever it is used.
   * @param {string} name
   * @param {any} builder
   */
  function named(name, builder) {
    return new BaseBuilder(initial('named', {
      name: requireName(name, 'named()'), target: requireBuilder(builder, 'named()'),
    }));
  }

  /** A reference to a definition by name. @param {string} name */
  function ref(name) {
    return new BaseBuilder(initial('ref', { name: requireName(name, 'ref()') }));
  }

  /** A deferred reference to a NAMED builder — the recursion spelling. @param {() => any} thunk */
  function lazy(thunk) {
    if (typeof thunk !== 'function') {
      throw new LinqBuildError('JL0101', 'lazy() takes a function returning a named builder');
    }
    return new BaseBuilder(initial('lazy', { thunk }));
  }

  /** `{ if: cond }`, extended by `.then()`/`.else()`. @param {any} cond */
  function when(cond) {
    return new WhenBuilder(initial('when', {
      cond: requireBuilder(cond, 'when()'), then: null, else: null,
    }));
  }

  /** A hand-written JSON Schema, embedded verbatim. @param {object | boolean} json */
  function from(json) {
    if (typeof json !== 'boolean'
      && (json === null || typeof json !== 'object' || Array.isArray(json))) {
      throw new LinqBuildError('JL0101',
        `from() takes a JSON Schema object or boolean, got ${describeValue(json)}`);
    }
    return new BaseBuilder(initial('raw', { json: requireJson(json, 'from()') }));
  }

  /** `{ type: 'string', format: 'date-time' }`. */
  function datetime() { return string().format('date-time'); }
  /** `{ type: 'string', format: 'date' }`. */
  function date() { return string().format('date'); }
  /** `{ type: 'string', format: 'time' }`. */
  function time() { return string().format('time'); }
  /** `{ type: 'string', format: 'duration' }`. */
  function duration() { return string().format('duration'); }

  /** The dialect a standalone document may declare. */
    const DRAFTS = Object.freeze({ '2020-12': 'https://json-schema.org/draft/2020-12/schema' });

  /**
   * A standalone document: the builder's schema, with `$schema` first when
   * a draft is named. The pen writes the 2020-12 vocabulary and no other.
   * @param {any} root
   * @param {{ draft?: '2020-12' }} [options]
   * @returns {any} the deep-frozen document
   */
  function document(root, options = {}) {
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

  return Object.freeze({
    string, number, integer, boolean, nil, literal, enumOf,
    object, array, tuple, record, union, discriminated, intersection,
    named, ref, lazy, any, never, when, from, document,
    datetime, date, time, duration,
  });
}
