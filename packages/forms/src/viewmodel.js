//@ts-check
/**
 * @file The form view model — the render tree.
 *
 * `buildFormViewModel` composes everything this package knows about a
 * form at one instant — the field tree (model.js), the current data,
 * per-field validation (validate.js) and `x-form` rule state (rules.js)
 * — into ONE plain-JSON tree of render nodes. It is the "computed view"
 * layer the package README promised: no DOM, no framework, just the
 * document any renderer needs — a React component, a template engine,
 * or a JSLT stylesheet (the standard form rules of `@jarenjs/app`
 * dispatch over exactly this shape).
 *
 * Policies inherited from rules.js: a field whose rule state says
 * `visible: false` is EXCLUDED from the tree (renderers cannot leak
 * hidden data by accident); `enabled` and `computed` are carried on the
 * node. Array item templates expand per element of the actual data, so
 * node pointers are always concrete (`/lines/2/amount`), matching the
 * pointer keys of `evaluateFormRules` and `validateAllFields`.
 */

import { getValueAtPointer, createItemValue } from './data.js';
import { evaluateFormRules } from './rules.js';
import { validateAllFields } from './validate.js';

/** @typedef {import('./model.js').FormField} FormField */

const EMPTY_STATE = Object.freeze({});

/**
 * One node of the render tree. Everything is plain JSON.
 * @typedef {Object} FormViewNode
 * @property {string} pointer - Concrete data pointer ('' for the root).
 * @property {string} key - Property name, or the element index as a string.
 * @property {string} label
 * @property {string|null} description
 * @property {string} kind - The field kind (model.js).
 * @property {string} control - The rendering hint (model.js).
 * @property {boolean} required
 * @property {boolean} readOnly
 * @property {boolean} enabled - `x-form.enabled`, defaulting true.
 * @property {string|null} placeholder
 * @property {any} value - The current value (`x-form.computed` wins);
 *   `null` when the field is absent from the data.
 * @property {Array<{value: any, label: string, selected: boolean}>|null} options
 *   Select options, `selected` precomputed against the current value.
 * @property {string[]} errors - Localized messages: field validation
 *   first, then rule asserts.
 * @property {boolean} element - True when this node is an array element
 *   (item or tuple slot). Writers need this: RFC 6902 `add` is
 *   set-or-replace for object members but INSERT for array indices, so
 *   element nodes must be written with `replace`.
 * @property {boolean} removable - True for item-template elements
 *   (tuple slots are fixed).
 * @property {FormViewNode[]|null} children - Object members.
 * @property {FormViewNode[]|null} items - Array elements, expanded.
 * @property {any} addValue - Starter value for a new array item
 *   (`createItemValue`); only on array nodes with an item template.
 */

/**
 * Options for `buildFormViewModel`.
 * @typedef {Object} FormViewModelOptions
 * @property {object} [rules] - Compiled rules from `compileFormRules`;
 *   when given, `x-form` state (visible/enabled/computed/asserts) is
 *   evaluated and folded into the tree.
 * @property {boolean} [validateFields] - Run `validateAllFields` and
 *   fold the per-field errors in (default false: pristine forms show
 *   no errors until the app opts in).
 * @property {object} [catalog] - Compiled message catalog for error
 *   texts (compileMessageCatalog), default English.
 */

/**
 * Build the render tree for one form instant.
 *
 * @example
 * const model = buildFormModel(schema);
 * const rules = compileFormRules(model);
 * const tree = buildFormViewModel(model, data, { rules, validateFields: true });
 * // tree.children[0] -> { pointer: '/email', control: 'email',
 * //                       value: 'a@b.c', errors: [], ... }
 *
 * @param {FormField} model - The field tree from `buildFormModel`.
 * @param {any} data - The current form data.
 * @param {FormViewModelOptions} [options]
 * @returns {FormViewNode|null} The root render node (`null` only when a
 *   root rule hides the whole form).
 */
export function buildFormViewModel(model, data, options = {}) {
  const ruleState = options.rules !== undefined
    ? evaluateFormRules(options.rules, data, options.catalog)
    : EMPTY_STATE;
  const fieldErrors = options.validateFields === true
    ? validateAllFields(model, data, options.catalog)
    : EMPTY_STATE;
  return buildNode(model, '', data, ruleState, fieldErrors, false, false);
}

/**
 * @param {FormField} field
 * @param {string} pointer - The concrete pointer of this node (pointer
 *   segments follow the walk convention of validateAllFields:
 *   `parent + '/' + key`).
 * @param {any} data - The form data root.
 * @param {Record<string, any>} ruleState
 * @param {Record<string, any>} fieldErrors
 * @param {boolean} element
 * @param {boolean} removable
 * @returns {FormViewNode|null}
 */
function buildNode(field, pointer, data, ruleState, fieldErrors, element, removable) {
  const rs = ruleState[pointer];
  if (rs !== undefined && rs.visible === false) return null;

  const raw = getValueAtPointer(data, pointer);
  let value = field.kind === 'const' ? field.constValue : raw;
  if (rs !== undefined && rs.computed !== undefined) value = rs.computed;

  /** @type {string[]} */
  const errors = [];
  const fe = fieldErrors[pointer];
  if (fe !== undefined) {
    for (const e of fe) errors.push(e.message);
  }
  if (rs !== undefined && rs.errors !== undefined) {
    for (const e of rs.errors) errors.push(e.message);
  }

  /** @type {FormViewNode} */
  const node = {
    pointer,
    key: field.key ?? '',
    label: field.label ?? '',
    description: field.description ?? null,
    kind: field.kind,
    control: field.control,
    required: field.required === true,
    readOnly: field.readOnly === true,
    enabled: rs === undefined || rs.enabled !== false,
    placeholder: field.placeholder ?? null,
    value: value === undefined ? null : value,
    options: null,
    errors,
    element,
    removable,
    children: null,
    items: null,
    addValue: undefined,
  };

  if (field.enumValues !== null && field.enumValues !== undefined) {
    node.options = field.enumValues.map((v, i) => ({
      value: v,
      label: field.enumLabels?.[i] ?? String(v),
      selected: v === node.value,
    }));
  }

  if (field.children !== null && field.children !== undefined) {
    const children = [];
    for (const child of field.children) {
      const built = buildNode(
        child, `${pointer}/${child.key}`, data, ruleState, fieldErrors, false, false);
      if (built !== null) children.push(built);
    }
    node.children = children;
  }

  if (field.kind === 'array') {
    const array = Array.isArray(raw) ? raw : [];
    const items = [];
    for (let i = 0; i < array.length; i++) {
      const template = field.tuple !== null && field.tuple !== undefined && i < field.tuple.length
        ? field.tuple[i]
        : field.item;
      if (template === null || template === undefined) break;
      const isTupleSlot = field.tuple !== null && field.tuple !== undefined && i < field.tuple.length;
      const built = buildNode(
        template, `${pointer}/${i}`, data, ruleState, fieldErrors, true, !isTupleSlot);
      if (built !== null) items.push(built);
    }
    node.items = items;
    if (field.item !== null && field.item !== undefined) {
      node.addValue = createItemValue(field.item) ?? null;
    }
  }

  return node;
}
