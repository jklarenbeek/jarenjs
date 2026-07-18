//@ts-check

/**
 * @jarenjs/forms - framework-agnostic form model generation for JSON Schema.
 *
 * buildFormModel(schema) turns a schema into a renderable field tree;
 * validateField gives immediate per-field feedback powered by @jarenjs/core
 * primitives, and the `x-form` rules (rules.js) add cross-field behavior -
 * visibility, enablement, computed values, preemptive assertions - as
 * compiled Jaren JSON Queries, before the complete compiled schema
 * validation runs (app-wired; forms never imports the validator). The
 * data helpers keep form values in plain JSON semantics, addressed by
 * JSON pointer through the @jarenjs/json compiled pointer engine.
 */

export {
  buildFormModel,
  resolveSchema,
  getFieldKind,
  humanizeKey,
  escapePointerKey,
} from './model.js';

export {
  compileFormRules,
  evaluateFormRules,
  formRulesToQueryAssertions,
} from './rules.js';

export {
  validateField,
  validateAllFields,
} from './validate.js';

export {
  formsMessagesEn,
  compileMessageTemplate,
  compileMessageCatalog,
} from './messages.js';

export {
  createInitialData,
  createItemValue,
  parseFieldInput,
  parsePointer,
  getValueAtPointer,
  setValueAtPointer,
  appendItem,
  removeItemAt,
} from './data.js';

export {
  FORM_FORMATS,
  getFormatInfo,
} from './formats.js';
