//@ts-check
/**
 * @file The JSON Schema constraint-keyword vocabulary, grouped by the
 * value family each keyword constrains. Before this file the same
 * keyword lists were spelled four times (forms' constraint extraction,
 * emit's dropped-constraint table, the validator's `$data` dispatch
 * order and its `$ref`-sibling detection) — and a keyword added to one
 * list silently missed the others. Each site composes the list it wants
 * from these groups and appends its own extras; the loops stay where
 * they are, because the drift risk was always in the data, not the
 * code.
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
