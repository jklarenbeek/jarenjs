//@ts-check
/**
 * @file `@jarenjs/linq/schema` — JSON Schema by code. Named builders
 * write standard 2020-12 documents (every keyword the validator
 * supports, `$query` through the chain's own capture, `$defs`/`$ref`
 * recursion, the normalizer's annotations), and the hand-authored
 * declarations beside them carry `Infer<>`/`Input<>`, proven against
 * emit's generated types and the validator's verdicts over one corpus.
 * The document is the deliverable; nothing here imports an engine.
 */

export {
  string, number, integer, boolean, nil, literal, enumOf,
  object, array, tuple, record,
  union, discriminated, intersection,
  named, ref, lazy, any, never, when, from, document,
  datetime, date, time, duration,
  SchemaBuilder, StringBuilder, NumberBuilder, ArrayBuilder, TupleBuilder,
  ObjectBuilder, WhenBuilder, NeverBuilder,
  requireJson,
} from './builders.js';
export { isSchemaBuilder, schemaOf, SCHEMA_BUILDER } from './brand.js';
