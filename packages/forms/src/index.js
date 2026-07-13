//@ts-check

/**
 * @jarenjs/forms - framework-agnostic form model generation for JSON Schema.
 *
 * buildFormModel(schema) turns a schema into a renderable field tree;
 * validateField gives immediate per-field feedback powered by @jarenjs/core
 * primitives, before the complete schema validation (@jarenjs/validate)
 * runs. The data helpers keep form values in plain JSON semantics,
 * addressed by JSON pointer.
 */

export {
  buildFormModel,
  resolveSchema,
  getFieldKind,
  humanizeKey,
} from './model.js';

export {
  validateField,
  validateAllFields,
} from './validate.js';

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
