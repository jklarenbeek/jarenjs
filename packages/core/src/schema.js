//@ts-check
/**
 * @file The JSON Schema constraint-keyword vocabulary, grouped by the
 * value family each keyword constrains. Forms' constraint extraction,
 * emit's dropped-constraint table and the validator's dispatch and
 * `$ref`-sibling detection compose their lists from these shared groups
 * and append their own extras. Consumers own their processing loops;
 * the shared vocabulary keeps keyword membership consistent.
 *
 * ORDER IS PART OF THE CONTRACT: the validator's `$data` dispatch
 * applies keywords in list order and its error order is observable
 * behaviour, so the internal order of each group is fixed. Membership
 * consumers are order-insensitive by construction.
 */

/** Keywords constraining numeric values, in dispatch order. */
export const NUMERIC_CONSTRAINTS = Object.freeze([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

/** Keywords constraining string values, in dispatch order. */
export const STRING_CONSTRAINTS = Object.freeze([
  'minLength', 'maxLength', 'pattern', 'format',
]);

/** Keywords constraining array values, in dispatch order. */
export const ARRAY_CONSTRAINTS = Object.freeze([
  'minItems', 'maxItems', 'uniqueItems',
]);

/** Keywords constraining object values, in dispatch order. */
export const OBJECT_CONSTRAINTS = Object.freeze([
  'minProperties', 'maxProperties',
]);
