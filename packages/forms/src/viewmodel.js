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
import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';

import { getValueAtPointer, createItemValue, changedPointers } from './data.js';
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
 * @property {import('./formats.js').FormatPreview|null} preview - The
 *   format's preview hint, carried through for a host that renders it;
 *   a host without a renderer for `preview.kind` ignores it.
 * @property {any} value - The current value (`x-form.computed` wins);
 *   `null` when the field is absent from the data.
 * @property {Array<{value: any, key: string, label: string, selected: boolean}>|null} options
 *   Select options, `selected` precomputed against the current value.
 *   `key` is the option's value as JSON text — what a string-valued
 *   control (a DOM `<option>`) can carry and hand back losslessly.
 * @property {string} [json] - The value as indented JSON text, on
 *   `json`-control nodes only: the editable text for a structured
 *   value, precomputed like `options`.
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
 *   the session's initial data — presence-aware: a member added or
 *   removed is dirty even when the compared values coincide as `null`
 *   (session forms only).
 * @property {boolean} [touched] - Whether the session marked this
 *   pointer visited (session forms only).
 * @property {string[]} [serverErrors] - Server-reported messages for
 *   this pointer, kept distinct from the client-side `errors` (session
 *   forms only).
 * @property {FormSessionSummary} [session] - The root summary (root
 *   node of session forms only).
 */

/**
 * The submit/draft session of a form: the lifecycle state around one
 * edited document. Everything is JSON — the
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
 * The root summary of a session form (`root.session`) — the
 * navigation-guard authority: derived from a full JSON comparison of
 * the initial document against the current data, independent of what
 * is rendered, so removed members, hidden retained values and
 * missing-versus-`null` membership changes all count. The visible
 * per-node `dirty`/`errors` members remain the render-layer summary.
 * @typedef {Object} FormSessionSummary
 * @property {boolean} dirty - Whether the current data differs from the
 *   initial document ANYWHERE.
 * @property {string[]} dirtyPaths - Every changed pointer between the
 *   initial document and the current data, in diff-walk (document)
 *   order. A member added or removed — including an explicit-`null`
 *   membership change and a shortened array tail — contributes the
 *   pointer of the added/removed location.
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
 * @property {import('./rules.js').RuleMemo} [memo] - A memo from
 *   `createRuleMemo`, reused across calls so only the rules a change
 *   can reach are re-evaluated. Keep one per form session; the tree it
 *   produces is the same either way.
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
    ? evaluateFormRules(options.rules, data, options.catalog, options.memo)
    : EMPTY_STATE;
  const fieldErrors = options.validateFields === true
    ? validateAllFields(model, data, options.catalog)
    : EMPTY_STATE;
  const session = options.session !== undefined
    ? compileSession(options.session, data)
    : null;
  const root = buildNode(model, '', data, ruleState, fieldErrors, false, false, session);
  if (root !== null && session !== null) {
    root.session = {
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
  const hasInitial = 'initial' in session;
  // the navigation-guard evidence is a FULL diff of the two documents,
  // never a walk of the rendered tree: removed members, hidden retained
  // values and null-membership changes must all surface
  const dirtyPaths = hasInitial ? changedPointers(session.initial, data) : [];
  return {
    hasInitial,
    initial: session.initial,
    data,
    touched,
    serverErrors,
    submitted: session.submitted === true,
    submitStatus: session.submitStatus ?? null,
    requestId: session.requestId ?? null,
    idPrefix: session.idPrefix ?? 'form',
    dirtyPaths,
    errorCount: 0,
    serverErrorCount: 0,
  };
}


/**
 * A stable accessible element id for a pointer: the encoded segments
 * joined with '-', prefixed; the empty pointer is 'root'. The encoding
 * is INJECTIVE — distinct pointers always get distinct ids:
 *
 *  - every character outside `[A-Za-z0-9]` (including `-` and `_`
 *    themselves) is escaped as `_<codepoint>_` BEFORE the segments are
 *    joined, so a literal '-' or '_' inside a member name can never
 *    collide with the separator or an escape (`/a/b` → `f-a-b`,
 *    `/a-b` → `f-a_45_b`);
 *  - member ids carry the structural marker `f-`, so the root
 *    sentinel lives in a DISJOINT namespace: a member named `root`
 *    (`<prefix>--f-root`) can never collide with the root itself
 *    (`<prefix>--root`), and an empty member name (`<prefix>--f-`) is
 *    distinct from both.
 * @param {string} prefix
 * @param {string} pointer
 * @returns {string}
 */
function pointerId(prefix, pointer) {
  if (pointer === '') return `${prefix}--root`;
  const safe = pointer.slice(1)
    .replace(/[^A-Za-z0-9/]/gu, (ch) => `_${ch.codePointAt(0)}_`)
    .replace(/\//g, '-');
  return `${prefix}--f-${safe}`;
}

/**
 * @param {FormField} field
 * @param {string} pointer - The concrete RFC 6901 pointer of this node
 *   (segments encoded with `encodeJSONPointerSegment`, the walk
 *   convention shared with the model, rule and validation pointers).
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
    preview: field.preview ?? null,
    value: value === undefined ? null : value,
    options: null,
    errors,
    element,
    removable,
    children: null,
    items: null,
    addValue: undefined,
  };

  if (field.control === 'json') {
    // the editable text for a structured value: precomputed here so the
    // renderer needs no encoder, mirroring how `options` are precomputed
    node.json = node.value === null || node.value === undefined
      ? ''
      : JSON.stringify(node.value, null, 2);
  }

  if (field.enumValues !== null && field.enumValues !== undefined) {
    node.options = field.enumValues.map((v, i) => ({
      value: v,
      // `key` is the JSON text of `value`: a DOM select carries strings,
      // so a renderer needs something reversible to put in the control
      // and hand back. Encoding here keeps the round trip lossless for
      // number, boolean and null enums, which `String(v)` is not.
      key: JSON.stringify(v) ?? 'null',
      label: field.enumLabels?.[i] ?? String(v),
      selected: equalsJson(v, node.value),
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
      // presence-aware: adding or removing a member whose value is
      // null is a membership change, so it is dirty
      const initialValue = getValueAtPointer(session.initial, pointer);
      node.dirty = (initialValue === undefined) !== (raw === undefined)
        || (initialValue !== undefined && !equalsJson(initialValue, raw));
    }
    else {
      node.dirty = false;
    }
  }

  if (field.children !== null && field.children !== undefined) {
    const children = [];
    for (const child of field.children) {
      const built = buildNode(
        child, `${pointer}/${encodeJSONPointerSegment(child.key)}`, data, ruleState,
        fieldErrors, false, false, session);
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
      // A tuple slot is removable only as the array's LAST element:
      // dropping one from the middle would slide every later value into
      // a slot with a different schema. Whether the shortened tuple is
      // still valid is `minItems`' answer to give, not this layer's.
      const removable = !isTupleSlot || i === array.length - 1;
      const built = buildNode(
        template, `${pointer}/${i}`, data, ruleState, fieldErrors, true, removable, session);
      if (built !== null) items.push(built);
    }
    node.items = items;
    if (field.tuple !== null && field.tuple !== undefined && array.length < field.tuple.length) {
      // a tuple shorter than its schema grows one slot at a time, each
      // starting from ITS OWN template — that is what makes a tuple
      // loaded short (or absent) fillable at all
      node.addValue = createItemValue(field.tuple[array.length]) ?? null;
    }
    else if (field.item !== null && field.item !== undefined) {
      node.addValue = createItemValue(field.item) ?? null;
    }
  }

  return node;
}
