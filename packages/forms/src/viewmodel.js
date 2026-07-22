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

import { equalsJson } from '@jarenjs/core/object';

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
 * @property {string} [id] - Stable accessible element id derived from
 *   the pointer (session forms only).
 * @property {string|null} [describedBy] - The id of this node's error
 *   text (`aria-describedby` wiring), `null` when the node has no
 *   errors (session forms only).
 * @property {boolean} [dirty] - Whether this node's value differs from
 *   the session's initial data (session forms only).
 * @property {boolean} [touched] - Whether the session marked this
 *   pointer visited (session forms only).
 * @property {string[]} [serverErrors] - Server-reported messages for
 *   this pointer, kept distinct from the client-side `errors` (session
 *   forms only).
 */

/**
 * The submit/draft session of a form (blueprint contract B4): the
 * lifecycle state around one edited document. Everything is JSON — the
 * session lives in app state; this option only folds it into the tree.
 *
 * Hidden-field policy: fields excluded by `x-form` `visible` rules keep
 * their values in the data — the view model never prunes; whether a
 * submit drops them is a product decision made at the submit boundary.
 *
 * @typedef {Object} FormSessionOptions
 * @property {any} [initial] - The baseline document; each node's
 *   `dirty` is a JSON deep-compare of its value against this.
 * @property {string[] | Record<string, boolean>} [touched] - Pointers
 *   the operator has visited.
 * @property {boolean} [submitted] - Whether a submit was attempted;
 *   echoed in the root summary (renderers typically surface every
 *   error once true).
 * @property {Record<string, string | string[]> | Array<{ pointer: string, message: string }>} [serverErrors]
 *   Server-reported messages by JSON Pointer; folded onto the matching
 *   nodes as `serverErrors`, never mixed into the client `errors`.
 * @property {string | null} [submitStatus] - The submit task status
 *   (e.g. 'idle'/'pending'/'done'/'error'); echoed in the root summary.
 * @property {any} [requestId] - The in-flight submit's request
 *   identity; echoed in the root summary.
 * @property {string} [idPrefix] - Prefix for the stable accessible ids
 *   (default 'form'); ids are `<prefix>--<pointer segments joined
 *   with ->` and `'<prefix>--root'` for the root.
 */

/**
 * The root summary of a session form (`root.session`).
 * @typedef {Object} FormSessionSummary
 * @property {boolean} dirty - Whether ANY node is dirty.
 * @property {string[]} dirtyPaths - The dirty leaf pointers, in tree
 *   order (a navigation guard's evidence).
 * @property {boolean} submitted
 * @property {string | null} submitStatus
 * @property {any} requestId
 * @property {number} errorCount - Client-side error total.
 * @property {number} serverErrorCount - Server-reported error total.
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
 * @property {FormSessionOptions} [session] - Fold a form session
 *   (initial/touched/submitted/serverErrors/submit identity) into the
 *   tree: every node gains `id`/`describedBy`/`dirty`/`touched`/
 *   `serverErrors`, and the root gains a `session` summary. Absent, the
 *   tree is byte-identical to the sessionless shape.
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
  const session = options.session !== undefined
    ? compileSession(options.session, data)
    : null;
  const root = buildNode(model, '', data, ruleState, fieldErrors, false, false, session);
  if (root !== null && session !== null) {
    /** @type {any} */ (root).session = {
      dirty: session.dirtyPaths.length > 0,
      dirtyPaths: session.dirtyPaths,
      submitted: session.submitted,
      submitStatus: session.submitStatus,
      requestId: session.requestId,
      errorCount: session.errorCount,
      serverErrorCount: session.serverErrorCount,
    };
  }
  return root;
}

/**
 * Normalize the session options into the walk's working state.
 * @param {FormSessionOptions} session
 * @param {any} data
 */
function compileSession(session, data) {
  /** @type {Set<string>} */
  const touched = new Set();
  if (Array.isArray(session.touched)) {
    for (const pointer of session.touched) touched.add(pointer);
  }
  else if (session.touched !== null && typeof session.touched === 'object') {
    for (const pointer in session.touched) {
      if (session.touched[pointer] === true) touched.add(pointer);
    }
  }
  /** @type {Map<string, string[]>} */
  const serverErrors = new Map();
  const raw = session.serverErrors;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || typeof entry.pointer !== 'string') continue;
      const list = serverErrors.get(entry.pointer) ?? [];
      list.push(String(entry.message));
      serverErrors.set(entry.pointer, list);
    }
  }
  else if (raw !== null && typeof raw === 'object' && raw !== undefined) {
    for (const pointer in raw) {
      const value = raw[pointer];
      serverErrors.set(pointer, Array.isArray(value) ? value.map(String) : [String(value)]);
    }
  }
  return {
    hasInitial: 'initial' in session,
    initial: session.initial,
    data,
    touched,
    serverErrors,
    submitted: session.submitted === true,
    submitStatus: session.submitStatus ?? null,
    requestId: session.requestId ?? null,
    idPrefix: session.idPrefix ?? 'form',
    /** @type {string[]} */
    dirtyPaths: [],
    errorCount: 0,
    serverErrorCount: 0,
  };
}

/**
 * A stable accessible element id for a pointer: the segments joined
 * with '-', prefixed; the empty pointer is 'root'. Non-id characters
 * are escaped as their code point, so distinct pointers keep distinct
 * ids.
 * @param {string} prefix
 * @param {string} pointer
 * @returns {string}
 */
function pointerId(prefix, pointer) {
  if (pointer === '') return `${prefix}--root`;
  const safe = pointer.slice(1).replace(/\//g, '-')
    .replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.codePointAt(0)}_`);
  return `${prefix}--${safe}`;
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
 * @param {ReturnType<typeof compileSession> | null} [session]
 * @returns {FormViewNode|null}
 */
function buildNode(field, pointer, data, ruleState, fieldErrors, element, removable, session = null) {
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

  if (session !== null) {
    node.id = pointerId(session.idPrefix, pointer);
    node.touched = session.touched.has(pointer);
    const server = session.serverErrors.get(pointer);
    node.serverErrors = server !== undefined ? server.slice() : [];
    session.errorCount += errors.length;
    session.serverErrorCount += node.serverErrors.length;
    node.describedBy = errors.length > 0 || node.serverErrors.length > 0
      ? `${node.id}-error`
      : null;
    if (session.hasInitial) {
      const initialValue = getValueAtPointer(session.initial, pointer);
      node.dirty = !equalsJson(
        initialValue === undefined ? null : initialValue,
        raw === undefined ? null : raw);
    }
    else {
      node.dirty = false;
    }
  }

  const isContainer = (field.children !== null && field.children !== undefined)
    || field.kind === 'array';
  if (session !== null && node.dirty === true && !isContainer) {
    session.dirtyPaths.push(pointer);
  }

  if (field.children !== null && field.children !== undefined) {
    const children = [];
    for (const child of field.children) {
      const built = buildNode(
        child, `${pointer}/${child.key}`, data, ruleState, fieldErrors, false, false, session);
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
        template, `${pointer}/${i}`, data, ruleState, fieldErrors, true, !isTupleSlot, session);
      if (built !== null) items.push(built);
    }
    node.items = items;
    if (field.item !== null && field.item !== undefined) {
      node.addValue = createItemValue(field.item) ?? null;
    }
  }

  return node;
}
