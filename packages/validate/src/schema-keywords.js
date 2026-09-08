//@ts-check

/** Schema-valued keywords, including arrays of schemas, shared by reference walks. */
export const TRAVERSE_SCHEMA_OBJECTS = [
  'items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems',
  'additionalProperties', 'propertyNames', 'unevaluatedProperties',
  'not', 'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else',
];

/** Maps of named schemas recognized by the validator's reference registration. */
export const TRAVERSE_SCHEMA_MAPS = [
  'properties', 'patternProperties',
  'dependencies', 'dependentSchemas', 'dependentRequired',
  'definitions', '$defs', 'components',
];
