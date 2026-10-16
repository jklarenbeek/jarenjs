//@ts-check
import dialectSchema from './schema.json' with { type: 'json' };
import queryMeta from './meta/query.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import draft2020 from '../json-schema-2020-12/index.js';

/**
 * The URI of the Jaren 2020-12 dialect: a schema whose `$schema` names it
 * is a JSON Schema 2020-12 schema that may also carry `$query`, and
 * validating it against this meta-schema checks every `$query` value
 * against the Jaren JSON Query grammar.
 */
export const dialect = 'https://jarenjs.dev/schemas/2020-12/schema';

/**
 * The URI of the Jaren query vocabulary (the `$query` keyword), declared
 * required (`true`) in the dialect's `$vocabulary`.
 */
export const queryVocabulary = 'https://jarenjs.dev/schemas/2020-12/vocab/query';

/**
 * The documents of the Jaren 2020-12 dialect, ready for
 * `addMetaSchema([...jaren2020], dialect)`: the dialect meta-schema first,
 * then the query vocabulary meta-schema, the query grammar
 * `@jarenjs/json` publishes (`@jarenjs/json/schemas/jaren-query.schema.json`,
 * the same object, not a copy) and the standard 2020-12 meta-schemas the
 * dialect extends.
 * @type {Record<string, unknown>[]}
 */
const jaren2020 = [
  dialectSchema,
  queryMeta,
  querySchema,
  ...draft2020,
];

export default jaren2020;
