//@ts-check
/**
 * @file `@jarenjs/linq/schema` — JSON Schema by code. Named builders
 * write standard 2020-12 documents (the structural keywords, the
 * constraints and the annotations, each with a method of its own;
 * `$query` through the chain's own capture; `$defs`/`$ref` recursion;
 * the normalizer's predicates — SCHEMA-PEN.md §6.2 lists the
 * twenty-five owned keywords that have no method and are written with
 * `keyword()` or `from()` instead), and the hand-authored
 * declarations beside them carry `Infer<>`/`Input<>`, proven against
 * emit's generated types and the validator's verdicts over one corpus.
 * The document is the deliverable; nothing here imports an engine.
 */

import {
  SchemaBuilder, StringBuilder, NumberBuilder, ArrayBuilder, TupleBuilder,
  ObjectBuilder, WhenBuilder, NeverBuilder,
} from './builders.js';
import { createFactories } from './factories.js';

export const {
  string, number, integer, boolean, nil, literal, enumOf,
  object, array, tuple, record, union, discriminated, intersection,
  named, ref, lazy, any, never, when, from, document,
  datetime, date, time, duration,
} = /** @type {any} */ (createFactories({
  Base: SchemaBuilder, String: StringBuilder, Number: NumberBuilder,
  Array: ArrayBuilder, Tuple: TupleBuilder, Object: ObjectBuilder,
  When: WhenBuilder, Never: NeverBuilder,
}));

export {
  SchemaBuilder, StringBuilder, NumberBuilder, ArrayBuilder, TupleBuilder,
  ObjectBuilder, WhenBuilder, NeverBuilder, requireJson,
} from './builders.js';
export { createFactories } from './factories.js';
export { isSchemaBuilder, schemaOf, SCHEMA_BUILDER } from './brand.js';
