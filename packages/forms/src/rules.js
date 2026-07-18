//@ts-check

/**
 * `x-form` rules: cross-field form behavior as compiled Jaren JSON Queries.
 *
 * The `x-form` annotation is one namespaced keyword - safe under every
 * metaschema, invisible to validators - carrying query documents for
 * per-keystroke form behavior:
 *
 *   visible  - EBV query: should the field be shown?
 *   enabled  - EBV query: should the field accept input?
 *   assert   - EBV query: cross-field preemptive validation
 *   computed - query whose plain-JSON result is the field's derived value
 *   message  - MessageSpec shown when `assert` fails: an inline template
 *              string, or `{ "$msgid": ..., "message"?: ..., "params"?: ... }`
 *              resolving through a message catalog (see messages.js)
 *
 * Unknown members are ignored (forward compatibility). Every rule kind
 * shares one query context: the input document `$` is the WHOLE form data
 * root (cross-field is the point), and exactly two externals are bound
 * per evaluation - `value`, the field's current value (`null` when the
 * field is absent: `undefined` is not a JSON value and has no defined
 * behavior in the engine), and `pointer`, the field's data pointer
 * string. Any other free name is a compile-time error naming it.
 *
 * Error policy (recorded here as the module contract):
 *   - `visible`/`enabled` runtime errors (JQ2xxx, e.g. the JQ2003
 *     multi-item EBV) evaluate to `true` - FAIL OPEN: a broken rule must
 *     never hide data or lock a control the user needs.
 *   - `assert` runtime errors evaluate to failed - FAIL CLOSED: an
 *     assertion that cannot be computed has not been satisfied.
 *   - `computed` runtime errors leave the value absent - there is no
 *     derived value to show.
 * Compile errors always throw, with the field's data pointer prepended.
 *
 * Rules compile ONCE per model (compileFormRules) and evaluate per
 * keystroke as cheap closures (evaluateFormRules) - the same two-stage
 * shape as every other Jaren compiler. Rules on array item templates
 * compile once and dispatch per element (see expandItemRule): this
 * compiled-once/evaluate-per-node mechanism is the seed of the JSLT
 * template layer (packages/json/docs/JSLT-PRELUDE.md section 7).
 */

import {
  compileJsonQuery,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

import {
  compileJSONPointer,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json/pointer';

import { escapePointerKey } from './model.js';

import {
  compileMessageTemplate,
  renderFormsMessage,
  formsMessages,
} from './messages.js';

/** The externals every rule query may reference, and no others. */
const ALLOWED_EXTERNALS = ['value', 'pointer'];

/** The msgid of the default assert failure text ('Invalid value'), in the
 * built-in English catalog (messages.js). */
const DEFAULT_ASSERT_MSGID = 'x-form/assert';

/**
 * @typedef {object} RuleResult
 * @property {boolean} [visible] - EBV of the field's `visible` rule
 * @property {boolean} [enabled] - EBV of the field's `enabled` rule
 * @property {any} [computed] - Plain-JSON result of the `computed` rule
 * @property {Array<import('./validate.js').FieldError>} [errors]
 *   `[{ keyword: 'x-form/assert', params, msgid, message }]` when the
 *   `assert` rule fails (the validateField error shape, so error
 *   rendering works unchanged; `params` always carries the `pointer`)
 */

/**
 * Marker for the array-item position in a template pointer's part list
 * (the `-` segment of `/lines/-`): evaluation expands it per element.
 */
const ITEM = Symbol('forms.ItemTemplate');

/**
 * Compile one rule member, prefixing compile errors with the field's
 * data pointer and enforcing the externals whitelist.
 */
function compileRuleQuery(doc, fieldPointer, member, options) {
  let query;
  try {
    query = compileJsonQuery(doc, options);
  }
  catch (e) {
    if (e instanceof Error)
      e.message = `${fieldPointer} x-form/${member}: ${e.message}`;
    throw e;
  }
  const externals = query.externals;
  for (let i = 0; i < externals.length; i++) {
    const name = externals[i];
    if (!ALLOWED_EXTERNALS.includes(name))
      throw new Error(
        `${fieldPointer} x-form/${member}: query cannot bind external '${name}' (only 'value' and 'pointer' are bound)`);
  }
  return query;
}

/**
 * A compiled `x-form.message` MessageSpec: inline text compiles into a
 * render closure; a `$msgid` form resolves through the active catalog at
 * failure time (English fallback), with the inline `message` template as
 * the catalog-miss fallback.
 * @typedef {object} CompiledRuleMessage
 * @property {string|null} msgid - Catalog key, or null for a plain inline message
 * @property {((params: object) => string)|null} render - Compiled inline template
 * @property {object|null} params - Author params, merged into the error's params
 */

/**
 * @typedef {object} CompiledFieldRules
 * @property {string} pointer - The field's data pointer (template pointers keep `-`)
 * @property {Array<string|symbol>} parts - Decoded segments; ITEM marks an array-item slot
 * @property {boolean} templated - Whether `parts` contains an ITEM slot
 * @property {((root: any) => any)|null} getValue - Compiled getter (non-template fields)
 * @property {function|null} visible
 * @property {function|null} enabled
 * @property {function|null} assert
 * @property {function|null} computed
 * @property {CompiledRuleMessage|null} message
 */

/**
 * Compile the `message` member of an `x-form` rule. A plain string stays
 * valid (backward compatible: it is the inline-template MessageSpec);
 * the object form carries `$msgid`/`message`/`params`.
 * @param {unknown} raw - The rule's `message` value
 * @param {string} fieldPointer - The field's data pointer, for compile errors
 * @returns {CompiledRuleMessage|null} The compiled spec, or null when absent
 */
function compileRuleMessageSpec(raw, fieldPointer) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string')
    return { msgid: null, render: compileMessageTemplate(raw), params: null };
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${fieldPointer} x-form/message: must be a string or a MessageSpec object`);
  const spec = /** @type {any} */ (raw);
  if (spec.$msgid !== undefined && typeof spec.$msgid !== 'string')
    throw new Error(`${fieldPointer} x-form/message: '$msgid' must be a string`);
  if (spec.message !== undefined && typeof spec.message !== 'string')
    throw new Error(`${fieldPointer} x-form/message: 'message' must be a string`);
  if (spec.$msgid === undefined && spec.message === undefined)
    throw new Error(`${fieldPointer} x-form/message: needs '$msgid' and/or 'message'`);
  if (spec.params !== undefined && (spec.params === null || typeof spec.params !== 'object' || Array.isArray(spec.params)))
    throw new Error(`${fieldPointer} x-form/message: 'params' must be an object`);
  return {
    msgid: spec.$msgid !== undefined ? spec.$msgid : null,
    render: spec.message !== undefined ? compileMessageTemplate(spec.message) : null,
    params: spec.params !== undefined ? spec.params : null,
  };
}

/**
 * @typedef {object} CompiledRules
 * @property {Array<CompiledFieldRules>} rules
 */

/**
 * Compile every `x-form` rule of a form model into reusable closures.
 *
 * Walks the field tree once and runs `compileJsonQuery` per rule
 * document. `options.compileTypeTest` passes through to the query
 * compiler, so rules may use `$valid`/`$assert`/`$as` with a
 * caller-supplied type-test compiler (the validator package's `query`
 * module exports `createTypeTestCompiler()`; forms itself never imports
 * the validator).
 * Without the hook, a schema-using rule surfaces the engine's JQ0008.
 *
 * @param {import('./model.js').FormField} model - Root field from buildFormModel
 * @param {object} [options]
 * @param {(schemaJson: any, docPath: string) => ((value: any) => boolean)}
 *   [options.compileTypeTest] - hook for schema literals inside rules
 * @returns {CompiledRules}
 * @throws {Error} On a malformed rule document (field pointer prepended)
 *   or a rule referencing an external other than `value`/`pointer`
 * @example
 * const compiled = compileFormRules(model);
 * const results = evaluateFormRules(compiled, data);
 * results['/vatId']; // { visible: true, errors: [{ keyword: 'x-form/assert', ... }] }
 */
export function compileFormRules(model, options = {}) {
  const queryOptions = options.compileTypeTest !== undefined
    ? { compileTypeTest: options.compileTypeTest }
    : {};
  /** @type {Array<CompiledFieldRules>} */
  const rules = [];
  walkField(model, [], rules, queryOptions);
  return { rules };
}

function walkField(field, parts, rules, queryOptions) {
  if (field == null) return;

  const raw = field.rules;
  if (raw != null) {
    const pointer = field.pointer;
    const templated = parts.includes(ITEM);
    rules.push({
      pointer,
      parts,
      templated,
      getValue: templated ? null : compileJSONPointer(pointer),
      visible: raw.visible !== undefined
        ? compileRuleQuery(raw.visible, pointer, 'visible', queryOptions) : null,
      enabled: raw.enabled !== undefined
        ? compileRuleQuery(raw.enabled, pointer, 'enabled', queryOptions) : null,
      assert: raw.assert !== undefined
        ? compileRuleQuery(raw.assert, pointer, 'assert', queryOptions) : null,
      computed: raw.computed !== undefined
        ? compileRuleQuery(raw.computed, pointer, 'computed', queryOptions) : null,
      message: compileRuleMessageSpec(raw.message, pointer),
    });
  }

  if (field.children) {
    for (const child of field.children)
      walkField(child, [...parts, child.key], rules, queryOptions);
  }
  if (field.tuple) {
    for (let i = 0; i < field.tuple.length; i++)
      walkField(field.tuple[i], [...parts, String(i)], rules, queryOptions);
  }
  if (field.item)
    walkField(field.item, [...parts, ITEM], rules, queryOptions);
}

/**
 * Evaluate one field's compiled rules against the data root.
 * The externals object is reused across rules: the compiled query copies
 * externals into its frame before evaluating (see the query engine), so
 * mutation between calls is safe and allocation-free.
 */
function evaluateOne(rule, data, value, pointer, ext, results, catalog) {
  ext.value = value === undefined ? null : value;
  ext.pointer = pointer;

  /** @type {RuleResult} */
  const result = {};
  if (rule.visible !== null)
    result.visible = ebvFailOpen(rule.visible, data, ext);
  if (rule.enabled !== null)
    result.enabled = ebvFailOpen(rule.enabled, data, ext);
  if (rule.computed !== null) {
    try {
      result.computed = rule.computed(data, ext);
    }
    catch (e) {
      if (!(e instanceof JsonQueryRuntimeError)) throw e;
      // no derived value to show
    }
  }
  if (rule.assert !== null) {
    let ok;
    try {
      ok = rule.assert.ebv(data, ext);
    }
    catch (e) {
      if (!(e instanceof JsonQueryRuntimeError)) throw e;
      ok = false; // fail closed: an uncomputable assertion is not satisfied
    }
    if (!ok) {
      const spec = rule.message;
      const msgid = spec !== null && spec.msgid !== null ? spec.msgid : DEFAULT_ASSERT_MSGID;
      const params = spec !== null && spec.params !== null
        ? { ...spec.params, pointer }
        : { pointer };
      let message;
      if (spec !== null) {
        if (spec.msgid !== null) {
          // D-M5 chain: active catalog, then built-in English, then the
          // spec's inline template, then the assert default text
          let render = catalog !== undefined ? catalog[spec.msgid] : undefined;
          if (render === undefined) render = formsMessages[spec.msgid];
          if (render !== undefined) message = render(params);
          else if (spec.render !== null) message = spec.render(params);
          else message = renderFormsMessage(catalog, DEFAULT_ASSERT_MSGID, params);
        }
        else {
          message = /** @type {(params: object) => string} */ (spec.render)(params);
        }
      }
      else {
        message = renderFormsMessage(catalog, DEFAULT_ASSERT_MSGID, params);
      }
      result.errors = [{ keyword: 'x-form/assert', params, msgid, message }];
    }
  }
  results[pointer] = result;
}

function ebvFailOpen(query, data, ext) {
  try {
    return query.ebv(data, ext);
  }
  catch (e) {
    if (!(e instanceof JsonQueryRuntimeError)) throw e;
    return true; // fail open: never hide data or lock a control on a broken rule
  }
}

/**
 * Expand a template rule against the actual data: walk the decoded parts,
 * and at each ITEM slot fan out over the array's real length, binding
 * `value`/`pointer` per element (`/lines/-/amount` -> `/lines/2/amount`).
 *
 * This is the compiled-once/dispatch-many shape the JSLT template layer
 * needs (JSLT-PRELUDE.md section 3, `$apply`): ONE compiled closure, one
 * dispatcher deciding per node what it applies to. Keep the mechanism in
 * this function.
 */
function expandItemRule(rule, data, node, partIndex, pointer, ext, results, catalog) {
  const parts = rule.parts;
  for (let i = partIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part === ITEM) {
      if (!Array.isArray(node)) return; // nothing to expand into
      for (let index = 0; index < node.length; index++)
        expandItemRule(rule, data, node[index], i + 1, `${pointer}/${index}`, ext, results, catalog);
      return;
    }
    pointer = `${pointer}/${escapePointerKey(part)}`;
    node = (node != null && typeof node === 'object')
      ? node[/** @type {string} */ (part)]
      : undefined;
  }
  evaluateOne(rule, data, node, pointer, ext, results, catalog);
}

/**
 * Evaluate compiled form rules against the current data root.
 *
 * Returns a map of data pointer -> RuleResult holding only the rules each
 * field declares. Rules on array item templates are evaluated once per
 * element of the actual array, keyed by the expanded pointer.
 *
 * @param {CompiledRules} compiled - From compileFormRules
 * @param {any} data - The form data root (the query input `$`)
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog (see messages.js), default English
 * @returns {Record<string, RuleResult>}
 * @example
 * const results = evaluateFormRules(compiled, { company: 'ACME', vatId: '' });
 * results['/vatId'].errors; // [{ keyword: 'x-form/assert', message: '...' }]
 */
export function evaluateFormRules(compiled, data, catalog = undefined) {
  /** @type {Record<string, RuleResult>} */
  const results = {};
  const ext = { value: null, pointer: '' };
  const rules = compiled.rules;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule.templated) {
      expandItemRule(rule, data, data, 0, '', ext, results, catalog);
    }
    else {
      const value = rule.getValue(data);
      evaluateOne(rule, data, value === JSONPOINTER_NOTHING ? undefined : value, rule.pointer, ext, results, catalog);
    }
  }
  return results;
}

//#region $query synergy

/**
 * Build the RFC 9535 name selector `['...']` for one pointer segment.
 * Single-quoted string literal: `\` and `'` escape with a backslash,
 * control characters as `\uXXXX`.
 */
function pathNameSelector(key) {
  let out = "['";
  for (const ch of key) {
    if (ch === '\\' || ch === "'")
      out += `\\${ch}`;
    else if (/** @type {number} */ (ch.codePointAt(0)) < 0x20)
      out += `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`;
    else
      out += ch;
  }
  return out + "']";
}

/**
 * Copy every `x-form.assert` of a schema into a `$query` assertion, so a
 * rule authored once for per-keystroke feedback is also enforced by the
 * authoritative submit validation (the validator's `$query` keyword).
 * Pure schema-to-schema transform - no validator import; the output only
 * spells the keyword.
 *
 * The asserts land on the ROOT schema (where the query input `$` is the
 * instance root, matching the rule context), each as its OWN `allOf`
 * branch `{ "$query": <wrapped>, "errorMessage": { "$query": <spec> } }`
 * so per-assert identity - and the rule's authored message - survives
 * into submit validation. Each assert is wrapped to rebuild its bindings:
 * `value` binds to the field's location, `pointer` to its pointer string.
 * An assert on an array item template quantifies with `$every` over the
 * actual elements (`pointer` then stays the template pointer - element
 * indexes are a render-time notion). An existing root `$query` is left
 * untouched on the root itself.
 *
 * The carried message spec is the rule's `x-form.message` - inline string
 * as an inline `message`, `$msgid` form passed through - with `params`
 * merged over `{ pointer: <field pointer> }`; a rule with no message gets
 * `{ "$msgid": "x-form/assert", "params": { "pointer": ... } }`. EVERY
 * submit-time `$query` failure therefore carries the owning field's
 * pointer in `params`, which lets UIs map root-level `$query` errors onto
 * fields.
 *
 * The transform follows the same structural spine as buildFormModel
 * (`properties`, `items`, `prefixItems`, `allOf`) but does not resolve
 * `$ref`s - a `$def`'s data location depends on its use site.
 *
 * @param {object|boolean} schema - The root JSON schema
 * @returns {object|boolean} A new root schema (input is not mutated;
 *   untouched subtrees are shared) with the collected `$query` branches,
 *   or the input itself when there is nothing to copy
 * @example
 * const submitSchema = formRulesToQueryAssertions(schema);
 * const validate = new JarenValidator().compile(submitSchema); // caller-side
 */
export function formRulesToQueryAssertions(schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema))
    return schema;

  /** @type {Array<{query: any, pointer: string, message: unknown}>} */
  const assertions = [];
  collectAsserts(schema, '', '$', 0, assertions);
  if (assertions.length === 0)
    return schema;

  const branches = assertions.map(assert => ({
    $query: assert.query,
    errorMessage: { $query: assertMessageSpec(assert.message, assert.pointer) },
  }));
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  return { ...schema, allOf: [...allOf, ...branches] };
}

/**
 * Build the `errorMessage.$query` MessageSpec carried into the submit
 * schema for one assert: the rule's message with `params` merged over
 * `{ pointer }`, or the `x-form/assert` catalog default.
 * @param {unknown} message - The rule's raw `x-form.message`, if any
 * @param {string} pointer - The owning field's data pointer
 * @returns {object} The MessageSpec for the transformed schema
 */
function assertMessageSpec(message, pointer) {
  if (typeof message === 'string')
    return { message, params: { pointer } };
  if (message != null && typeof message === 'object' && !Array.isArray(message)) {
    const spec = /** @type {any} */ (message);
    return { ...spec, params: { pointer, ...(spec.params || {}) } };
  }
  return { $msgid: 'x-form/assert', params: { pointer } };
}

/**
 * Depth-first collection of `x-form.assert` documents with the pointer
 * and root-relative JSONPath of their data location. `itemDepth` counts
 * enclosing `[*]` expansions: inside one, `value` must quantify per
 * element instead of binding the selected sequence.
 */
function collectAsserts(schema, pointer, path, itemDepth, out) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema))
    return;

  const rules = schema['x-form'];
  if (rules != null && typeof rules === 'object' && !Array.isArray(rules)
      && rules.assert !== undefined) {
    const bindPointer = { $const: pointer };
    const query = itemDepth === 0
      ? { $let: { value: path, pointer: bindPointer }, $return: rules.assert }
      : { $every: { value: path },
          $satisfies: { $let: { pointer: bindPointer }, $return: rules.assert } };
    out.push({ query, pointer, message: rules.message });
  }

  if (schema.properties != null && typeof schema.properties === 'object') {
    for (const [key, sub] of Object.entries(schema.properties)) {
      collectAsserts(sub, `${pointer}/${escapePointerKey(key)}`,
        path + pathNameSelector(key), itemDepth, out);
    }
  }
  if (Array.isArray(schema.prefixItems)) {
    for (let i = 0; i < schema.prefixItems.length; i++)
      collectAsserts(schema.prefixItems[i], `${pointer}/${i}`, `${path}[${i}]`, itemDepth, out);
  }
  if (schema.items != null && typeof schema.items === 'object' && !Array.isArray(schema.items))
    collectAsserts(schema.items, `${pointer}/-`, `${path}[*]`, itemDepth + 1, out);
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf)
      collectAsserts(branch, pointer, path, itemDepth, out);
  }
}

//#endregion
