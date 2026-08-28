//@ts-check
/**
 * @file `@jarenjs/linq/forms` — the form by code. The schema pen's every
 * name, rebuilt from SUBCLASSES that carry the `x-form` vocabulary
 * (`form({ visible, enabled, assert, computed, message })`), plus
 * `assertOnSubmit()`, the one call that answers the same rules' Layer-3
 * `$query` twin. A rule is an ANNOTATION: the document a form pen writes
 * validates exactly as the schema pen's does, and `buildFormModel`,
 * `compileFormRules` and `evaluateFormRules` read the rules off it.
 * Nothing here imports `@jarenjs/forms`.
 */

import {
  SchemaBuilder, StringBuilder, NumberBuilder, ArrayBuilder, TupleBuilder,
  ObjectBuilder, WhenBuilder, NeverBuilder,
} from '../schema/builders.js';
import { createFactories } from '../schema/factories.js';
import { withForm } from './rules.js';

/** The rule-aware classes: new classes, one mixin, no patched prototype. */
export const FormBuilder = withForm(SchemaBuilder);
export const FormStringBuilder = withForm(StringBuilder);
export const FormNumberBuilder = withForm(NumberBuilder);
export const FormArrayBuilder = withForm(ArrayBuilder);
export const FormTupleBuilder = withForm(TupleBuilder);
export const FormObjectBuilder = withForm(ObjectBuilder);
export const FormWhenBuilder = withForm(WhenBuilder);
export const FormNeverBuilder = withForm(NeverBuilder);

export const {
  string, number, integer, boolean, nil, literal, enumOf,
  object, array, tuple, record, union, discriminated, intersection,
  named, ref, lazy, any, never, when, from, document,
  datetime, date, time, duration,
} = /** @type {any} */ (createFactories({
  Base: FormBuilder, String: FormStringBuilder, Number: FormNumberBuilder,
  Array: FormArrayBuilder, Tuple: FormTupleBuilder, Object: FormObjectBuilder,
  When: FormWhenBuilder, Never: FormNeverBuilder,
}));

export { withForm } from './rules.js';
export { assertOnSubmit } from './submit.js';
export { isSchemaBuilder, schemaOf, SCHEMA_BUILDER } from '../schema/brand.js';
