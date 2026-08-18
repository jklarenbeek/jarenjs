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

import { setValueAtPointer, changedPointers } from './data.js';

import {
  queryDependencies, mergeDependencies, dependencyTouched, ALL_POINTERS,
} from './deps.js';

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
 * @property {string[]} deps - Pointer prefixes this rule reads (deps.js);
 *   the memo re-runs it only when a change touches one of them
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
 * module exports `createTypeTestCompiler()`; forms itself never runs
 * the validator, and imports only its pure `normalize` helpers).
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
  // a root-level `visible` rule is a modeling error, rejected here so
  // it can never fire: hiding the whole form would make the render
  // tree AND the session summary vanish (`buildFormViewModel` → null),
  // silently voiding the dirty/navigation authority. Whole-form
  // visibility belongs to the host at the mount boundary.
  if (model?.rules?.visible !== undefined) {
    throw new TypeError(
      'compileFormRules: a root-level x-form "visible" rule is not allowed - '
      + 'gate the whole form at the mount boundary instead');
  }
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
      deps: fieldDependencies(raw, parts),
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
 * What one field's rules read: every root-anchored path in its four
 * query documents, plus its own location — the `value` external binds
 * from there, and for a templated field the whole array above the item
 * slot, since adding or removing an element changes which pointers the
 * rule even produces.
 * @param {any} raw - The authored `x-form` object
 * @param {Array<string|symbol>} parts - Decoded path segments; ITEM marks a slot
 * @returns {string[]}
 */
function fieldDependencies(raw, parts) {
  let own = '';
  for (const part of parts) {
    if (part === ITEM) break;
    own += `/${escapePointerKey(/** @type {string} */ (part))}`;
  }
  return mergeDependencies([
    [own],
    raw.visible !== undefined ? queryDependencies(raw.visible) : [],
    raw.enabled !== undefined ? queryDependencies(raw.enabled) : [],
    raw.assert !== undefined ? queryDependencies(raw.assert) : [],
    raw.computed !== undefined ? queryDependencies(raw.computed) : [],
  ]);
}

/**
 * Evaluate one field's compiled rules against the data root.
 * The externals object is reused across rules: the compiled query copies
 * externals into its frame before evaluating (see the query engine), so
 * mutation between calls is safe and allocation-free.
 */
function evaluateOne(rule, data, value, pointer, ext, results, catalog, written) {
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
  if (written !== null) written.push(pointer);
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
function expandItemRule(rule, data, node, partIndex, pointer, ext, results, catalog, written) {
  const parts = rule.parts;
  for (let i = partIndex; i < parts.length; i++) {
    const part = parts[i];
    if (part === ITEM) {
      if (!Array.isArray(node)) return; // nothing to expand into
      for (let index = 0; index < node.length; index++) {
        expandItemRule(rule, data, node[index], i + 1, `${pointer}/${index}`,
          ext, results, catalog, written);
      }
      return;
    }
    pointer = `${pointer}/${escapePointerKey(part)}`;
    node = (node != null && typeof node === 'object')
      ? node[/** @type {string} */ (part)]
      : undefined;
  }
  evaluateOne(rule, data, node, pointer, ext, results, catalog, written);
}

/**
 * Evaluate compiled form rules against the current data root.
 *
 * Returns a map of data pointer -> RuleResult holding only the rules each
 * field declares. Rules on array item templates are evaluated once per
 * element of the actual array, keyed by the expanded pointer.
 *
 * Pass a `memo` from {@link createRuleMemo} to re-evaluate only the
 * rules a change can have affected. The memo diffs the previous
 * document against this one — reference-equal subtrees are skipped
 * whole, so an immutable edit costs O(change) — and re-runs a rule only
 * when a changed pointer touches one of its declared dependencies
 * (deps.js). The result is identical to an unmemoized evaluation.
 *
 * The memo OWNS the map it returns and patches it on later calls: a
 * caller must read it before evaluating again, and must not keep it as
 * a snapshot (`buildFormViewModel` reads it synchronously, which is the
 * intended shape). Handing back a fresh map instead would put a write
 * per rule back on the hot path — on a wide form, the rules that did
 * NOT change are the work worth skipping.
 *
 * @param {CompiledRules} compiled - From compileFormRules
 * @param {any} data - The form data root (the query input `$`)
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog] - Optional compiled message catalog (see messages.js), default English
 * @param {RuleMemo} [memo] - Reused across calls; mutated in place
 * @returns {Record<string, RuleResult>}
 * @example
 * const results = evaluateFormRules(compiled, { company: 'ACME', vatId: '' });
 * results['/vatId'].errors; // [{ keyword: 'x-form/assert', message: '...' }]
 */
export function evaluateFormRules(compiled, data, catalog = undefined, memo = undefined) {
  const rules = compiled.rules;
  // a catalog swap (a locale switch) invalidates every rendered message
  const reuse = memo !== undefined && memo.results !== null && memo.catalog === catalog;
  // A declared write is taken at its word; otherwise the documents are
  // diffed. Diffing is the honest default — it needs nothing from the
  // caller — but it must scan the members of every container that
  // changed identity, which a host that just wrote `/lines/2/amount`
  // can simply tell us instead.
  const changed = reuse ? (memo.touched ?? changedPointers(memo.data, data)) : null;
  if (memo !== undefined) memo.touched = null;
  if (reuse && changed.length === 0) return memo.results;

  const ext = { value: null, pointer: '' };
  if (reuse) {
    // Patch the previous map in place. Rebuilding it would put a write
    // per rule back on the hot path, which is most of what there was to
    // save: on a wide form the untouched rules ARE the work.
    const results = memo.results;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!dependenciesAffected(rule.deps, changed)) continue;
      if (!rule.templated) {
        // it writes its own pointer and nothing else, every time — no
        // key set to track and nothing that can go stale
        const value = rule.getValue(data);
        evaluateOne(rule, data, value === JSONPOINTER_NOTHING ? undefined : value,
          rule.pointer, ext, results, catalog, null);
        continue;
      }
      const written = [];
      expandItemRule(rule, data, data, 0, '', ext, results, catalog, written);
      // an item-template rule's key set follows the array's length, so
      // an entry it no longer writes has to go
      const previous = memo.keys[i];
      for (let k = 0; k < previous.length; k++) {
        if (!written.includes(previous[k])) delete results[previous[k]];
      }
      memo.keys[i] = written;
    }
    memo.data = data;
    return results;
  }

  /** @type {Record<string, RuleResult>} */
  const results = {};
  /** @type {string[][]|null} */
  const keys = memo !== undefined ? new Array(rules.length) : null;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    // only a template rule's key set is data-dependent; every other
    // rule writes exactly its own pointer
    const written = keys !== null && rule.templated ? [] : null;
    evaluateRule(rule, data, ext, results, catalog, written);
    if (keys !== null) keys[i] = written ?? [rule.pointer];
  }
  if (memo !== undefined) {
    memo.data = data;
    memo.catalog = catalog;
    memo.results = results;
    memo.keys = keys;
  }
  return results;
}

/** Evaluate one compiled rule into the results map. */
function evaluateRule(rule, data, ext, results, catalog, written) {
  if (rule.templated) {
    expandItemRule(rule, data, data, 0, '', ext, results, catalog, written);
    return;
  }
  const value = rule.getValue(data);
  evaluateOne(rule, data, value === JSONPOINTER_NOTHING ? undefined : value,
    rule.pointer, ext, results, catalog, written);
}

/**
 * The memo {@link evaluateFormRules} carries between keystrokes: the
 * document it last saw, the results it produced, and which result keys
 * each rule wrote (an item-template rule writes one per element, so the
 * count is data-dependent and has to be recorded, not derived).
 * @typedef {object} RuleMemo
 * @property {any} data
 * @property {any} catalog
 * @property {Record<string, RuleResult>|null} results
 * @property {string[][]|null} keys
 * @property {string[]|null} touched - Pointers declared through
 *   {@link RuleMemo.touch}, consumed by the next evaluation
 * @property {(pointer: string) => RuleMemo} touch
 */

/**
 * Create an empty rule memo. One per form session: it is bound to the
 * document lineage it has seen, so sharing it between two forms would
 * diff unrelated documents (correct, but pointlessly expensive).
 *
 * `memo.touch(pointer)` declares a write before the next evaluation.
 * It is an optimization AND a promise: the evaluation then trusts the
 * declaration instead of diffing, so a caller that touches one pointer
 * while changing another gets stale results for the rules it did not
 * name. Say nothing and the diff works it out.
 * @returns {RuleMemo}
 * @example
 * const memo = createRuleMemo();
 * data = setValueAtPointer(data, '/lines/2/amount', 9);
 * const state = evaluateFormRules(compiled, data, catalog, memo.touch('/lines/2/amount'));
 */
export function createRuleMemo() {
  /** @type {RuleMemo} */
  const memo = {
    data: undefined,
    catalog: undefined,
    results: null,
    keys: null,
    touched: null,
    touch(pointer) {
      (memo.touched ??= []).push(pointer);
      return memo;
    },
  };
  return memo;
}

/** Whether any changed pointer touches any of a rule's dependencies. */
function dependenciesAffected(deps, changed) {
  if (deps === ALL_POINTERS) return true;
  for (let i = 0; i < deps.length; i++) {
    for (let k = 0; k < changed.length; k++) {
      if (dependencyTouched(deps[i], changed[k])) return true;
    }
  }
  return false;
}

/**
 * Drop the values of fields their `visible` rules currently hide, for a
 * caller about to submit.
 *
 * The policy this settles: hidden values are KEPT while editing (a
 * field that reappears must not have forgotten what the operator typed)
 * and dropped only here, at the submit boundary, by a caller who asked.
 * Nothing prunes implicitly — `buildFormViewModel` still never touches
 * the data, and this returns a copy.
 *
 * Visibility is evaluated ONCE against the incoming document, so a
 * `visible` rule that reads a value this call removes still sees it.
 * Hidden array ELEMENTS are removed and their siblings renumber, which
 * is right for a document being sent but means the returned pointers no
 * longer match the ones the view model rendered.
 *
 * @param {CompiledRules} compiled - From compileFormRules
 * @param {any} data - The form data root
 * @param {Readonly<Record<string, (params: object, error?: object) => string>>} [catalog]
 * @returns {any} A copy without the hidden values (`data` itself when
 *   nothing is hidden; untouched subtrees are shared)
 * @example
 * const submitted = pruneHiddenValues(compiled, session.data);
 */
export function pruneHiddenValues(compiled, data, catalog = undefined) {
  const results = evaluateFormRules(compiled, data, catalog);
  const hidden = [];
  for (const pointer of Object.keys(results)) {
    if (results[pointer].visible === false && pointer !== '') hidden.push(pointer);
  }
  if (hidden.length === 0) return data;
  // Deepest first, and higher array indexes before lower ones: removing
  // an element renumbers its siblings, so every pointer still to be
  // processed must address a location the removal cannot have moved.
  hidden.sort(comparePointersDescending);
  let out = data;
  for (const pointer of hidden)
    out = setValueAtPointer(out, pointer, undefined);
  return out;
}

/** Order two pointers deepest-first, numeric segments by value. */
function comparePointersDescending(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  const shared = Math.min(left.length, right.length);
  for (let i = 1; i < shared; i++) {
    if (left[i] === right[i]) continue;
    const na = Number(left[i]);
    const nb = Number(right[i]);
    if (Number.isInteger(na) && Number.isInteger(nb)) return nb - na;
    return left[i] < right[i] ? 1 : -1;
  }
  return right.length - left.length;
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
 * Absent fields bind exactly as they do per keystroke: `null`. A path
 * that selects nothing is the empty sequence, which compares unequal to
 * everything and would make `$ne`/`$eq` mean the opposite thing on the
 * two sides of the same authored rule - so the binding is wrapped in a
 * `$default` against `null`. For the same reason an item-template
 * assert quantifies over the ELEMENTS rather than over the selected
 * leaf values: quantifying over the leaves silently skips an element
 * that lacks the member, where the keystroke path evaluates it with
 * `null`.
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
  collectAsserts(schema, '', ['$'], assertions);
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
 * The loop-variable prefix for element quantification. The leading
 * underscore keeps it clear of an author's own `$let` names while
 * staying inside the engine's variable grammar.
 */
const ITEM_VAR = '_item';

/**
 * Append one path selector to the last chunk of a chunk list, returning
 * a new list (chunks are split at `[*]`; see {@link assertQuery}).
 */
function extendChunks(chunks, selector) {
  const next = chunks.slice();
  next[next.length - 1] += selector;
  return next;
}

/**
 * Build the `$query` document for one assert from its data location,
 * expressed as path chunks split at each array expansion: every chunk
 * but the last ends with `[*]`, and the last is the tail after the
 * final one (`''` when the assert sits on the element itself).
 *
 * Zero expansions is a plain binding; each expansion becomes an
 * `$every` over the elements at that level, so the innermost binding
 * reads its member off ONE element. Binding through `$default` means an
 * absent location arrives as `null`, exactly as the keystroke path
 * binds it.
 *
 * A field that also declares `visible` has its assert guarded by it:
 * the assert holds vacuously while the field is hidden. That is what
 * the keystroke path already does — `buildFormViewModel` drops hidden
 * nodes, so their assert errors never render and never count — and an
 * unguarded copy would let a field the operator cannot see or fix block
 * submit forever.
 * @param {string[]} chunks
 * @param {any} assert - The authored rule document
 * @param {string} pointer - The field's data pointer
 * @param {any} [visible] - The field's `visible` rule, when it has one
 * @returns {any} The wrapped query document
 */
function assertQuery(chunks, assert, pointer, visible) {
  const depth = chunks.length - 1;
  const at = (k) => k === 0 ? chunks[0] : `$${ITEM_VAR}${k - 1}${chunks[k]}`;
  const body = visible === undefined
    ? assert
    : { $or: [{ $not: visible }, assert] };
  let query = {
    $let: { value: { $default: [at(depth), { $const: null }] }, pointer: { $const: pointer } },
    $return: body,
  };
  for (let k = depth - 1; k >= 0; k--)
    query = { $every: { [`${ITEM_VAR}${k}`]: at(k) }, $satisfies: query };
  return query;
}

/**
 * Depth-first collection of `x-form.assert` documents with the pointer
 * and the path chunks of their data location.
 */
function collectAsserts(schema, pointer, chunks, out) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema))
    return;

  const rules = schema['x-form'];
  if (rules != null && typeof rules === 'object' && !Array.isArray(rules)
      && rules.assert !== undefined) {
    out.push({
      query: assertQuery(chunks, rules.assert, pointer, rules.visible),
      pointer,
      message: rules.message,
    });
  }

  if (schema.properties != null && typeof schema.properties === 'object') {
    for (const [key, sub] of Object.entries(schema.properties)) {
      collectAsserts(sub, `${pointer}/${escapePointerKey(key)}`,
        extendChunks(chunks, pathNameSelector(key)), out);
    }
  }
  if (Array.isArray(schema.prefixItems)) {
    for (let i = 0; i < schema.prefixItems.length; i++)
      collectAsserts(schema.prefixItems[i], `${pointer}/${i}`, extendChunks(chunks, `[${i}]`), out);
  }
  if (schema.items != null && typeof schema.items === 'object' && !Array.isArray(schema.items))
    collectAsserts(schema.items, `${pointer}/-`, [...extendChunks(chunks, '[*]'), ''], out);
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf)
      collectAsserts(branch, pointer, chunks, out);
  }
}

//#endregion
