//@ts-check
/** The scalar vocabulary of a declared schema type, once: which types a
 * member can be mapped from, and the comparison kind each one implies. A
 * leaf module, so a dialect reads it without the model compiler. */

/** The schema types whose members are scalar columns and values. @type {ReadonlySet<string>} */
export const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

/**
 * The comparison KIND a declared schema type implies — what a column
 * over that member holds, and therefore how its expression has to read
 * the member out of the document. On a dynamically typed engine the
 * kind changes nothing; on one whose columns carry a real SQL type it
 * is the difference between a `text` column and a type error.
 * @param {string | undefined} schemaType
 * @returns {'text' | 'number' | 'boolean' | undefined}
 */
export function columnKindFor(schemaType) {
  switch (schemaType) {
    case 'string': return 'text';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return undefined;
  }
}
