//@ts-check
/**
 * @file `@jarenjs/validate/output`: the standard output formats of JSON
 * Schema. Pass one of the formats this module exports as the validator's
 * `outputFormat` option; a validator compiled with one records one output
 * unit for every subschema it applies (where it was reached, the subschema,
 * the instance it applied to, its answer and the errors its own keywords
 * raised), and the format projects that tree into one of two published
 * shapes:
 *
 * - {@link flagOutput}, {@link basicOutput}, {@link detailedOutput} and
 *   {@link verboseOutput}: JSON Schema 2020-12 Core section 12, one unit per
 *   keyword (`keywordLocation`, `absoluteKeywordLocation`,
 *   `instanceLocation`, `error`/`annotation`, nested `errors`/`annotations`);
 * - {@link listOutput} and {@link hierarchicalOutput}: the output
 *   specification that followed it, one unit per subschema
 *   (`evaluationPath`, `schemaLocation`, `instanceLocation`, `errors` and
 *   `annotations` keyed by keyword, nested `details`).
 *
 * Annotations are reported only where they survive: on a unit that passed
 * and whose every enclosing unit passed. A failed unit may carry the
 * annotations it would have produced as `droppedAnnotations` (`list` and
 * `hierarchical` only).
 *
 * A validator that is not given a format never imports this module.
 */

import { isArrayClass, isObjectClass } from '@jarenjs/core';
import { encodeJSONPointerSegment, decodeJSONPointerSegment } from '@jarenjs/json/pointer';
import { convertInternalErrors, renderErrorMessage } from './messages.js';
import { ASSERTION_SINCE, readsSince, TRAVERSE_SCHEMA_OBJECTS, TRAVERSE_SCHEMA_MAPS, TRAVERSE_SCHEMA_MAP_MAPS, admitsPropertyDependencies } from './schema-keywords.js';
import { admitsDynamicReference } from './dynamic-ref.js';
import { REF_SIBLING_KEYWORDS } from './tools.js';
import { createJsonPointer } from './traverse.js';

/**
 * A unit of the JSON Schema 2020-12 output formats (`basic`, `detailed`,
 * `verbose`): one keyword applied to one instance location.
 * @typedef {object} KeywordOutputUnit
 * @property {boolean} valid - Whether the keyword (or subschema) passed
 * @property {string} keywordLocation - JSON Pointer of the keyword along the evaluation, through `$ref` hops
 * @property {string} [absoluteKeywordLocation] - Absolute URI of the keyword; present once the evaluation passed a reference
 * @property {string} instanceLocation - JSON Pointer of the instance
 * @property {string} [error] - The failure's message
 * @property {unknown} [annotation] - The annotation the keyword produced
 * @property {KeywordOutputUnit[]} [errors] - Nested results of a failed node (`detailed`, `verbose`)
 * @property {KeywordOutputUnit[]} [annotations] - Nested results of a passing node (`detailed`, `verbose`)
 */

/**
 * The `basic` output: the units that carry an error (a failed validation)
 * or an annotation (a passing one), and the branch units of a failure
 * ("A subschema had errors."), flat.
 * @typedef {{ valid: boolean, errors?: KeywordOutputUnit[], annotations?: KeywordOutputUnit[] }} BasicOutput
 */

/**
 * A unit of the `list` and `hierarchical` output formats: one subschema
 * applied to one instance location.
 * @typedef {object} EvaluationOutputUnit
 * @property {boolean} valid - Whether the subschema passed
 * @property {string} evaluationPath - JSON Pointer of the subschema along the evaluation, through `$ref` hops
 * @property {string} schemaLocation - Absolute URI of the subschema, with a JSON Pointer fragment
 * @property {string} instanceLocation - JSON Pointer of the instance
 * @property {Record<string, string>} [errors] - Messages keyed by the failed keyword (`''` for a `false` schema)
 * @property {Record<string, unknown>} [annotations] - Annotations keyed by keyword, on a unit that passed inside units that all passed
 * @property {Record<string, unknown>} [droppedAnnotations] - Annotations a failed unit's keywords produced and dropped
 * @property {EvaluationOutputUnit[]} [details] - The units this one applied (`hierarchical`)
 */

/**
 * The `list` output: the units that carry errors or annotations, flat.
 * @typedef {{ valid: boolean, details: EvaluationOutputUnit[] }} ListOutput
 */

/**
 * What a validator compiled with an output format records: one subschema
 * applied to one instance location, its errors and the subschemas it
 * applied.
 * @typedef {object} UnitRecord
 * @property {string} segment - The evaluation path segment from the applying record ('' for the root)
 * @property {{ path: string, schema: any, declaredDraft: number|null, dynamicReferenceDraft: number|null, options: { draftVersion: number, propertyDependencies?: boolean|null } }} object - The subschema's compiled object
 * @property {string} instanceLocation
 * @property {unknown} data
 * @property {boolean} valid
 * @property {any[]} errors - Internal error records raised by the subschema's own keywords
 * @property {UnitRecord[]} children
 */

/** The keywords that reach a schema by reference: a hop to another location. */
const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

/**
 * Applicators whose subschemas are probes: a failed subschema under them does
 * not fail the keyword by itself, and the keyword reports its own failure.
 */
const SPECULATIVE_KEYWORDS = new Set(['anyOf', 'oneOf', 'not', 'if', 'contains']);

/** The applicator a wrapper error names, beside the ones whose subschemas it summarizes. */
const WRAPPER_CHILDREN = Object.freeze({
  items: ['items', 'prefixItems', 'additionalItems'],
});

/** Keywords that identify or hold schemas and are not evaluated against the instance. */
const NOT_EVALUATED = new Set([
  '$schema', '$id', '$anchor', '$dynamicAnchor', '$recursiveAnchor', '$defs',
  'definitions', '$comment', '$vocabulary', 'errorMessage',
]);

/** Keywords whose annotation is their own value. */
const VALUE_ANNOTATIONS = new Set([
  'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly',
  'examples', 'format',
]);

/** The draft that introduced a keyword whose annotation is its own value, where it is not draft 6: an older draft reads it as an unknown keyword. */
const ANNOTATION_SINCE = Object.freeze({
  readOnly: 7, writeOnly: 7, contentEncoding: 7, contentMediaType: 7, deprecated: 2019, contentSchema: 2019,
});

/** Keywords whose annotation is their own value, for a string instance only. */
const STRING_ANNOTATIONS = new Set(['contentEncoding', 'contentMediaType', 'contentSchema']);

/** Applicators whose annotation is the set of member names they applied to. */
const MEMBER_ANNOTATIONS = new Set([
  'properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
]);

/** Applicators whose annotation follows from the items they applied to. */
const ITEM_ANNOTATIONS = new Set(['additionalItems', 'unevaluatedItems', 'contains', 'prefixItems', 'items']);

/** Every keyword that can produce an annotation. */
const ANNOTATING = new Set([...VALUE_ANNOTATIONS, ...STRING_ANNOTATIONS, ...MEMBER_ANNOTATIONS, ...ITEM_ANNOTATIONS]);

/** The keywords that can fail an instance or reach another schema. */
const ASSERTING = new Set([...REF_SIBLING_KEYWORDS, ...REFERENCE_KEYWORDS]);

/**
 * Whether the validator evaluates `keyword` in a unit's subschema: a keyword
 * of the draft the subschema is read in, by the gates the validator compiles
 * with. An unknown keyword, and one of a later draft, is not evaluated.
 * @param {OutputUnit} unit
 * @param {string} keyword
 * @returns {boolean}
 */
function evaluates(unit, keyword) {
  if (Object.hasOwn(ASSERTION_SINCE, keyword)) return readsSince(keyword, unit.declaredDraft);
  if (keyword === 'propertyDependencies') return admitsPropertyDependencies(unit.propertyDependencies, unit.declaredDraft);
  if (keyword === '$recursiveRef' || keyword === '$dynamicRef') return admitsDynamicReference(keyword, unit.dynamicReferenceDraft);
  if (ASSERTING.has(keyword)) return true;
  return ANNOTATING.has(keyword) && !(/** @type {Record<string, number>} */ (ANNOTATION_SINCE)[keyword] > unit.draft);
}

/**
 * The record of one subschema applied to one instance location.
 */
class OutputUnit {
  /**
   * @param {OutputUnit|null} parent - The unit that applied this one, or null for the root
   * @param {string} segment - The evaluation path segment from the parent (`/properties/a`, `/$ref`), '' for the root
   * @param {string} schemaLocation - The absolute URI of the subschema, with a JSON Pointer fragment
   * @param {any} schema - The subschema
   * @param {UnitRecord['object']} object - The subschema's compiled object
   * @param {string} instanceLocation - The JSON Pointer of the instance
   * @param {unknown} data - The instance
   */
  constructor(parent, segment, schemaLocation, schema, object, instanceLocation, data) {
    const slash = segment.indexOf('/', 1);
    const enclosing = /** @type {{ evaluationPath: string, hop: boolean }|null} */ (parent);
    /** @type {string} The keyword of the parent that applied this unit ('' for the root) */
    this.keyword = segment === '' ? '' : segment.slice(1, slash === -1 ? undefined : slash);
    /** @type {string} */
    this.evaluationPath = enclosing === null ? '' : enclosing.evaluationPath + segment;
    /** @type {boolean} Whether evaluation passed a reference to reach this unit */
    this.hop = enclosing !== null && (enclosing.hop || REFERENCE_KEYWORDS.has(this.keyword));
    /** @type {string} */
    this.schemaLocation = schemaLocation;
    this.schema = schema;
    /** @type {number} The draft the subschema is read in */
    this.draft = object.declaredDraft ?? object.options.draftVersion;
    /** @type {number|null} The draft its document declares, or null when none does */
    this.declaredDraft = object.declaredDraft;
    /** @type {number|null} The draft its dynamic references are read in */
    this.dynamicReferenceDraft = object.dynamicReferenceDraft;
    /** @type {boolean|null|undefined} The `propertyDependencies` option it was compiled under */
    this.propertyDependencies = object.options.propertyDependencies;
    /** @type {string} */
    this.instanceLocation = instanceLocation;
    this.data = data;
    /** @type {boolean} */
    this.valid = true;
    /** @type {any[]} Internal error records raised by this unit's own keywords */
    this.errors = [];
    /** @type {OutputUnit[]} */
    this.children = [];
  }
}

/**
 * A schema location as an absolute URI with a JSON Pointer fragment.
 * @param {string} path
 * @returns {string}
 */
function withFragment(path) {
  return path.includes('#') ? path : path + '#';
}

/**
 * The JSON Pointer location of every subschema of the registered resources,
 * for a reference that names its target by a plain-name fragment
 * (`#node`): an output unit's schema location is a JSON Pointer.
 * @param {Map<string, unknown>} schemas - Schema ids to schemas; a resource is registered under an id ending in `#`
 * @returns {{ pointers: WeakMap<object, string>, nodes: Map<string, object> }} Each subschema's location, and the subschema written at each location
 */
function schemaPointers(schemas) {
  /** @type {WeakMap<object, string>} */
  const pointers = new WeakMap();
  /** @type {Map<string, object>} */
  const nodes = new Map();
  const name = (/** @type {string} */ token) => encodeURIComponent(encodeJSONPointerSegment(token));
  const visit = (/** @type {any} */ node, /** @type {string} */ location, /** @type {boolean} */ isRoot) => {
    if (!isObjectClass(node) || pointers.has(node)) return;
    // An embedded resource is registered, and located, under its own id; a
    // plain-name `$id` (`#node`, drafts 6 and 7) names a subschema of the
    // enclosing resource and is located there.
    if (!isRoot && typeof node.$id === 'string' && !node.$id.startsWith('#')) return;
    pointers.set(node, location);
    if (!nodes.has(location)) nodes.set(location, node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) {
        if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${location}/${key}/${i}`, false));
        else visit(value, `${location}/${key}`, false);
      }
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isObjectClass(value)) {
        for (const member of Object.keys(value)) visit(value[member], `${location}/${key}/${name(member)}`, false);
      }
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && isObjectClass(value)) {
        for (const outer of Object.keys(value)) {
          const inner = value[outer];
          if (isObjectClass(inner))
            for (const member of Object.keys(inner)) visit(inner[member], `${location}/${key}/${name(outer)}/${name(member)}`, false);
        }
      }
    }
  };
  for (const [id, schema] of schemas) if (id.endsWith('#')) visit(schema, id, true);
  return { pointers, nodes };
}

/** @type {WeakMap<Map<string, unknown>, { pointers: WeakMap<object, string>, nodes: Map<string, object> }>} The locations of each compilation's schemas, built on first need */
const POINTERS = new WeakMap();

/**
 * The locations of a compilation's schemas, walked once.
 * @param {Map<string, unknown>} schemas
 * @returns {{ pointers: WeakMap<object, string>, nodes: Map<string, object> }}
 */
function walked(schemas) {
  let found = POINTERS.get(schemas);
  if (found === undefined) {
    found = schemaPointers(schemas);
    POINTERS.set(schemas, found);
  }
  return found;
}

/**
 * The schema location of a recorded subschema, as an absolute URI with a
 * JSON Pointer fragment. An object built for a dynamic anchor has a unique
 * name rather than its location, and a plain-name fragment (`#node`) names
 * the schema rather than its location: both are looked up by the schema.
 * @param {UnitRecord['object']} object
 * @param {Map<string, unknown>} schemas
 * @returns {string}
 */
function locationOf(object, schemas) {
  const path = object.path;
  const hash = path.indexOf('#');
  if (hash === -1 || hash === path.length - 1
    || (path.charCodeAt(hash + 1) === 0x2f && !path.includes('/$def-anchor/')))
    return withFragment(path);
  const { pointers } = walked(schemas);
  const named = schemas.get(path);
  return (isObjectClass(named) ? pointers.get(named) : undefined)
    ?? pointers.get(object.schema) ?? path;
}

/**
 * The output units of a recorded validation.
 * @param {UnitRecord} record
 * @param {OutputUnit|null} parent
 * @param {Map<string, unknown>} schemas
 * @returns {OutputUnit}
 */
function unitOf(record, parent, schemas) {
  const object = record.object;
  let location = locationOf(object, schemas);
  let segment = record.segment;
  let enclosing = parent;
  let top = null;
  // A schema that is only a `$ref` is resolved to its final target when
  // the schemas are registered, so the object at its location holds the
  // target's schema: restore each hop of the chain as its own unit.
  const { nodes } = walked(schemas);
  for (let hops = 0; hops < 64; hops++) {
    const written = /** @type {any} */ (nodes.get(location));
    if (written === undefined || written === object.schema || typeof written.$ref !== 'string') break;
    const target = withFragment(createJsonPointer(written.$ref, location.slice(0, location.indexOf('#')), undefined, '$ref').id);
    if (target === location) break;
    const hop = new OutputUnit(enclosing, segment, location, written, object, record.instanceLocation, record.data);
    hop.valid = record.valid;
    if (enclosing !== parent) enclosing.children.push(hop);
    top ??= hop;
    enclosing = hop;
    segment = '/$ref';
    location = target;
  }
  const unit = new OutputUnit(enclosing, segment, location, object.schema, object, record.instanceLocation, record.data);
  unit.valid = record.valid;
  unit.errors = record.errors;
  unit.children = record.children.map((child) => unitOf(child, unit, schemas));
  if (enclosing !== parent) enclosing.children.push(unit);
  return top ?? unit;
}

/**
 * The last reference token of a JSON Pointer.
 * @param {string} pointer
 * @returns {string}
 */
function lastToken(pointer) {
  return decodeJSONPointerSegment(pointer.slice(pointer.lastIndexOf('/') + 1));
}

/**
 * @typedef {object} KeywordResult
 * @property {string} keyword - The keyword ('' for the failure of a `false` schema)
 * @property {boolean} valid
 * @property {import('./messages.js').ValidationError[]} errors - Every error the keyword raised
 * @property {import('./messages.js').ValidationError[]} reported - The errors the keyword reports itself (a wrapper explained by a failed subschema reports none)
 * @property {OutputUnit[]} children - The units the keyword applied
 * @property {unknown} annotation - The annotation, `undefined` for none
 * @property {boolean} placed - Whether the keyword was placed in the schema's order
 */

/**
 * The annotation one keyword of a unit produces.
 * @param {OutputUnit} unit
 * @param {string} keyword
 * @param {OutputUnit[]} children - The units the keyword applied
 * @returns {unknown} `undefined` for none
 */
function annotationOf(unit, keyword, children) {
  const schema = unit.schema;
  if (/** @type {Record<string, number>} */ (ANNOTATION_SINCE)[keyword] > unit.draft) return undefined;
  if (VALUE_ANNOTATIONS.has(keyword)) return schema[keyword];
  if (STRING_ANNOTATIONS.has(keyword)) return typeof unit.data === 'string' ? schema[keyword] : undefined;
  if (MEMBER_ANNOTATIONS.has(keyword)) {
    if (children.length === 0 || !isObjectClass(unit.data)) return undefined;
    /** @type {Set<string>} */
    const names = new Set();
    for (const child of children) names.add(lastToken(child.instanceLocation));
    return [...names];
  }
  if (!isArrayClass(unit.data)) return undefined;
  const length = /** @type {unknown[]} */ (unit.data).length;
  if (keyword === 'contains') {
    // `contains: true` matches every item without a subschema to record.
    if (schema.contains === true) return Array.from({ length }, (_, i) => i);
    const indexes = [];
    for (const child of children) if (child.valid) indexes.push(Number(lastToken(child.instanceLocation)));
    return indexes;
  }
  if (keyword === 'unevaluatedItems') return children.length === 0 ? undefined : true;
  // The item keywords apply by position, so what they applied to follows
  // from the array's length (a boolean subschema applies without a unit).
  const tuple = unit.draft < 2020 ? schema.items : schema.prefixItems;
  const prefix = Array.isArray(tuple) ? tuple.length : 0;
  if (keyword === 'prefixItems' || (keyword === 'items' && Array.isArray(schema.items))) {
    const applied = Math.min(length, prefix);
    return applied === 0 ? undefined : applied === length ? true : applied - 1;
  }
  // `items` beside a tuple, and `additionalItems`, apply past it
  if (keyword === 'items' || (keyword === 'additionalItems' && Array.isArray(schema.items)))
    return length > prefix ? true : undefined;
  return undefined;
}

/**
 * The keyword results of a unit, in the order its schema declares them.
 * @param {OutputUnit} unit
 * @param {boolean} verbose - Also list every evaluated keyword that raised nothing and applied nothing
 * @returns {KeywordResult[]}
 */
function keywordResults(unit, verbose) {
  const errors = unit.errors.length === 0 ? [] : convertInternalErrors(unit.errors);
  /** @type {Map<string, KeywordResult>} */
  const byKeyword = new Map();
  const resultOf = (/** @type {string} */ keyword) => {
    let result = byKeyword.get(keyword);
    if (result === undefined) {
      result = { keyword, valid: true, errors: [], reported: [], children: [], annotation: undefined, placed: false };
      byKeyword.set(keyword, result);
    }
    return result;
  };
  for (const error of errors) resultOf(error.keyword === 'false schema' ? '' : error.keyword).errors.push(error);
  for (const child of unit.children) resultOf(child.keyword).children.push(child);

  const schema = unit.schema;
  // Before draft 2019-09 a `$ref` makes its siblings inert: only it is evaluated.
  const keys = !isObjectClass(schema) ? [] : unit.draft < 2019 && typeof schema.$ref === 'string' ? ['$ref'] : Object.keys(schema);
  /** @type {KeywordResult[]} */
  const ordered = [];
  for (const key of keys) {
    if (NOT_EVALUATED.has(key)) continue;
    const result = byKeyword.get(key);
    if (result !== undefined) {
      result.placed = true;
      ordered.push(result);
      continue;
    }
    // `then`/`else` that did not apply (no subschema ran) were not evaluated,
    // nor was a keyword the subschema's draft does not have.
    if ((verbose && key !== 'then' && key !== 'else' && evaluates(unit, key))
      || (ANNOTATING.has(key) && annotationOf(unit, key, []) !== undefined)) {
      const quiet = resultOf(key);
      quiet.placed = true;
      ordered.push(quiet);
    }
  }
  // A failure that no declared keyword names (a `false` schema) comes last.
  for (const result of byKeyword.values()) if (!result.placed) ordered.push(result);

  /** @type {Set<string>} The keywords that applied a failed subschema */
  const failed = new Set();
  for (const child of unit.children) if (!child.valid) failed.add(child.keyword);
  for (const result of ordered) {
    const failedChild = failed.has(result.keyword);
    const explained = result.errors.length !== 0 && !SPECULATIVE_KEYWORDS.has(result.keyword)
      && (WRAPPER_CHILDREN[result.keyword] ?? [result.keyword]).some((keyword) => failed.has(keyword));
    result.reported = explained ? [] : result.errors;
    result.valid = result.reported.length === 0
      && (SPECULATIVE_KEYWORDS.has(result.keyword) || !failedChild);
    result.annotation = ANNOTATING.has(result.keyword) ? annotationOf(unit, result.keyword, result.children) : undefined;
  }
  return ordered;
}

/**
 * The messages of a keyword's errors as one string.
 * @param {import('./messages.js').ValidationError[]} errors
 * @returns {string}
 */
function joinMessages(errors) {
  const messages = [];
  for (const error of errors)
    if (error.message !== '' && !messages.includes(error.message)) messages.push(error.message);
  return messages.join('; ');
}

/**
 * Whether a child belongs to a pruned form: it decides its parent's answer.
 * A passing subschema under a failing one changes nothing, nor does a
 * failing probe under a keyword that passed; a failing probe explains its
 * keyword's failure only where every probe had to fail (`anyOf`, `oneOf`
 * with no match, `contains`), never under `not` or `if`.
 * @param {OutputUnit} parent
 * @param {OutputUnit} child
 * @param {Map<string, KeywordResult>} results - The parent's keyword results by keyword
 * @returns {boolean}
 */
function decides(parent, child, results) {
  if (child.valid !== parent.valid) return false;
  if (child.valid || !SPECULATIVE_KEYWORDS.has(child.keyword)) return true;
  return child.keyword !== 'not' && child.keyword !== 'if' && results.get(child.keyword)?.valid === false;
}

//#region list and hierarchical

/**
 * One unit of the `list`/`hierarchical` shape.
 * @param {OutputUnit} unit
 * @param {KeywordResult[]} results
 * @param {boolean} surviving - Whether this unit and every enclosing unit passed
 * @returns {Record<string, unknown>}
 */
function subschemaUnit(unit, results, surviving) {
  /** @type {Record<string, unknown>} */
  const out = {
    valid: unit.valid,
    evaluationPath: unit.evaluationPath,
    schemaLocation: unit.schemaLocation,
    instanceLocation: unit.instanceLocation,
  };
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, unknown>} */
  const annotations = {};
  let hasErrors = false;
  let hasAnnotations = false;
  for (const result of results) {
    if (result.reported.length !== 0) {
      errors[result.keyword] = joinMessages(result.reported);
      hasErrors = true;
    }
    if (result.annotation !== undefined && (surviving || !unit.valid)) {
      annotations[result.keyword] = result.annotation;
      hasAnnotations = true;
    }
  }
  if (hasErrors) out.errors = errors;
  if (hasAnnotations) out[unit.valid ? 'annotations' : 'droppedAnnotations'] = annotations;
  return out;
}

/**
 * The `hierarchical` output: every unit, nested by evaluation.
 * @param {OutputUnit} unit
 * @param {boolean} [surviving]
 * @returns {Record<string, unknown>}
 */
function projectHierarchical(unit, surviving = unit.valid) {
  const out = subschemaUnit(unit, keywordResults(unit, false), surviving);
  if (unit.children.length !== 0)
    out.details = unit.children.map((child) => projectHierarchical(child, surviving && child.valid));
  return out;
}

/**
 * The `list` output: the units that carry errors or annotations, flat, from
 * the subschemas that decide the answer.
 * @param {OutputUnit} root
 * @returns {{ valid: boolean, details: Record<string, unknown>[] }}
 */
function projectList(root) {
  /** @type {Record<string, unknown>[]} */
  const details = [];
  const visit = (/** @type {OutputUnit} */ unit, /** @type {boolean} */ surviving) => {
    const results = keywordResults(unit, false);
    const out = subschemaUnit(unit, results, surviving);
    if (out.errors !== undefined || out.annotations !== undefined) details.push(out);
    const byKeyword = new Map(results.map((result) => [result.keyword, result]));
    for (const child of unit.children)
      if (decides(unit, child, byKeyword)) visit(child, surviving && child.valid);
  };
  visit(root, root.valid);
  return { valid: root.valid, details };
}

//#endregion

//#region basic, detailed and verbose

/**
 * @typedef {object} KeywordNode
 * @property {boolean} valid
 * @property {string} keywordLocation
 * @property {string} [absoluteKeywordLocation]
 * @property {string} instanceLocation
 * @property {string} [error]
 * @property {unknown} [annotation]
 * @property {KeywordNode[]} kids
 */

/**
 * The keyword tree of a unit (2020-12 shape): the unit's node, holding one
 * node per keyword, which holds the units the keyword applied.
 * @param {OutputUnit} unit
 * @param {boolean} surviving
 * @param {boolean} verbose
 * @returns {KeywordNode}
 */
function keywordTree(unit, surviving, verbose) {
  /** @type {KeywordNode} */
  const node = {
    valid: unit.valid,
    keywordLocation: unit.evaluationPath,
    absoluteKeywordLocation: unit.hop ? unit.schemaLocation : undefined,
    instanceLocation: unit.instanceLocation,
    kids: [],
  };
  for (const result of keywordResults(unit, verbose)) {
    if (result.keyword === '') {
      node.error = joinMessages(result.reported);
      continue;
    }
    const keywordLocation = unit.evaluationPath + '/' + encodeJSONPointerSegment(result.keyword);
    const absoluteKeywordLocation = unit.hop ? unit.schemaLocation + '/' + encodeJSONPointerSegment(result.keyword) : undefined;
    const annotation = surviving ? result.annotation : undefined;
    if (result.children.length === 0 && result.reported.length !== 0) {
      // Each error is its own unit at the instance it names; errors at the
      // members of the instance (an `additionalProperties: false`) sit
      // under the keyword's own unit at the instance.
      const leaves = result.reported.map((error) => ({ valid: false, keywordLocation, absoluteKeywordLocation, instanceLocation: error.instancePath, error: error.message, kids: [] }));
      if (leaves.every((leaf) => leaf.instanceLocation === unit.instanceLocation)) node.kids.push(...leaves);
      else node.kids.push({ valid: false, keywordLocation, absoluteKeywordLocation, instanceLocation: unit.instanceLocation, kids: leaves });
      continue;
    }
    node.kids.push({
      valid: result.valid,
      keywordLocation,
      absoluteKeywordLocation,
      instanceLocation: unit.instanceLocation,
      error: result.reported.length !== 0 ? joinMessages(result.reported) : undefined,
      annotation,
      // A `true` subschema has no keywords: its node would hold nothing.
      kids: result.children.filter((child) => child.schema !== true)
        .map((child) => keywordTree(child, surviving && child.valid, verbose)),
    });
  }
  return node;
}

/**
 * One node as 2020-12 output, its nested results under `errors` when it
 * failed and `annotations` when it passed.
 * @param {KeywordNode} node
 * @param {KeywordNode[]} kids
 * @returns {Record<string, unknown>}
 */
function keywordUnit(node, kids) {
  /** @type {Record<string, unknown>} */
  const out = { valid: node.valid, keywordLocation: node.keywordLocation };
  if (node.absoluteKeywordLocation !== undefined) out.absoluteKeywordLocation = node.absoluteKeywordLocation;
  out.instanceLocation = node.instanceLocation;
  if (node.error !== undefined) out.error = node.error;
  if (node.annotation !== undefined) out.annotation = node.annotation;
  if (kids.length !== 0) out[node.valid ? 'annotations' : 'errors'] = kids.map((kid) => keywordUnit(kid, kid.kids));
  return out;
}

/**
 * Whether a node carries its own error or annotation.
 * @param {KeywordNode} node
 * @returns {boolean}
 */
function carries(node) {
  return node.error !== undefined || node.annotation !== undefined;
}

/**
 * The condensed tree: only what decides the answer, a node with nothing of
 * its own and no children removed, one with a single child replaced by it.
 * @param {KeywordNode} node
 * @returns {KeywordNode|null}
 */
function condense(node) {
  const kids = [];
  for (const kid of node.kids) {
    if (kid.valid !== node.valid) continue;
    const kept = condense(kid);
    if (kept !== null) kids.push(kept);
  }
  if (!carries(node)) {
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
  }
  return { ...node, kids };
}

/**
 * The `verbose` output: every keyword of every applied subschema.
 * @param {OutputUnit} root
 * @returns {Record<string, unknown>}
 */
function projectVerbose(root) {
  const tree = keywordTree(root, root.valid, true);
  return keywordUnit(tree, tree.kids);
}

/**
 * The `detailed` output: the condensed hierarchy.
 * @param {OutputUnit} root
 * @returns {Record<string, unknown>}
 */
function projectDetailed(root) {
  const tree = keywordTree(root, root.valid, false);
  const kept = condense(tree);
  return kept === null ? keywordUnit(tree, []) : keywordUnit(kept, kept.kids);
}

/**
 * The `basic` output: the units of the condensed hierarchy, flat. A unit
 * that carries an error or an annotation is listed with it; a failed unit
 * that carries neither holds two or more failed units (the condensed
 * hierarchy keeps no other), and is listed as a branch unit with the
 * `subschema` message, "A subschema had errors.".
 * @param {OutputUnit} root
 * @param {{ options?: { messages?: boolean } }} validation - The compilation's `ValidationRoot`
 * @returns {Record<string, unknown>}
 */
function projectBasic(root, validation) {
  const branch = validation.options?.messages === false ? '' : renderErrorMessage({ keyword: 'subschema' });
  const units = [];
  const visit = (/** @type {KeywordNode} */ node) => {
    if (carries(node)) units.push(keywordUnit(node, []));
    else if (!node.valid) units.push(keywordUnit({ ...node, error: branch }, []));
    for (const kid of node.kids) visit(kid);
  };
  const kept = condense(keywordTree(root, root.valid, false));
  if (kept !== null) visit(kept);
  /** @type {Record<string, unknown>} */
  const out = { valid: root.valid };
  if (units.length !== 0) out[root.valid ? 'annotations' : 'errors'] = units;
  return out;
}

//#endregion

/**
 * What a compilation hands every subschema it applies: `enter` records it,
 * under the evaluation path segment the applicator that reached it marked
 * as `pending` (`/properties/a`, `/$ref`); `error` takes each error raised;
 * `run` validates and answers the recorded tree.
 * @typedef {object} UnitRecorder
 * @property {readonly (string|number|undefined)[]|null} pending - The step an applicator marked: its keyword, then the index or name inside its value
 * @property {(object: UnitRecord['object'], validate: Function, data: unknown, dataPath: any, dataRoot: any, dataKey?: any) => any} enter
 * @property {(error: any) => void} error
 * @property {(validate: () => unknown) => { root: UnitRecord, schemas: Map<string, unknown> }} run
 */

/**
 * An evaluation path segment from a marked step.
 * @param {readonly (string|number|undefined)[]} step
 * @returns {string}
 */
function segmentOf(step) {
  let segment = '';
  for (const token of step) if (token != null) segment += '/' + encodeJSONPointerSegment(String(token));
  return segment;
}

/**
 * The recorder of one compilation.
 * @param {Map<string, unknown>} schemas - The compilation's schema ids to schemas
 * @returns {UnitRecorder}
 */
function createRecorder(schemas) {
  /** @type {UnitRecord[]} */
  const open = [];
  /** @type {UnitRecord|null} */
  let root = null;
  /** @type {UnitRecorder} */
  const recorder = {
    pending: null,
    enter(object, validate, data, dataPath, dataRoot, dataKey) {
      const segment = recorder.pending;
      recorder.pending = null;
      // A member that is absent is not an instance a subschema applies to.
      if (open.length !== 0 && data === undefined)
        return validate(data, dataPath, dataRoot, dataKey);
      /** @type {UnitRecord} */
      const record = { segment: segment === null ? '' : segmentOf(segment), object, instanceLocation: typeof dataPath === 'string' ? dataPath : '', data, valid: true, errors: [], children: [] };
      if (open.length === 0) root = record;
      else open[open.length - 1].children.push(record);
      open.push(record);
      try {
        const valid = validate(data, dataPath, dataRoot, dataKey);
        record.valid = valid !== false;
        return valid;
      }
      finally {
        open.pop();
      }
    },
    error(error) {
      if (open.length !== 0) open[open.length - 1].errors.push(error);
    },
    run(validate) {
      open.length = 0;
      root = null;
      recorder.pending = null;
      validate();
      return { root: /** @type {UnitRecord} */ (root), schemas };
    },
  };
  return recorder;
}

/**
 * An output format: what the `outputFormat` option takes.
 * @template R
 * @typedef {object} OutputFormat
 * @property {string} name - The format's name in its specification
 * @property {(schemas: Map<string, unknown>) => UnitRecorder} [recorder] - Makes a compilation's recorder; absent (`flag`), the compilation stops at the first failure and records nothing
 * @property {(root: any) => (data: unknown) => R} validator - The compiled validator of a compilation (its `ValidationRoot`)
 */

/**
 * @template R
 * @param {string} name
 * @param {(root: OutputUnit, validation: any) => R} projection - Projects the recorded units; `validation` is the compilation's `ValidationRoot`
 * @returns {Readonly<OutputFormat<R>>}
 */
function recordingFormat(name, projection) {
  return Object.freeze({
    name,
    recorder: createRecorder,
    validator: (/** @type {any} */ root) => {
      /** @type {UnitRecorder} */
      const recorder = root.recorder;
      return (/** @type {unknown} */ data) => {
        const recorded = recorder.run(() => root.validate(data));
        return projection(unitOf(recorded.root, null, recorded.schemas), root);
      };
    },
  });
}

/**
 * `flag` (both specifications): `{ valid }`, from the boolean validator,
 * which stops at the first failure.
 * @type {Readonly<OutputFormat<{ valid: boolean }>>}
 */
export const flagOutput = Object.freeze({
  name: 'flag',
  validator: (/** @type {any} */ root) => {
    const validate = root.createValidateFn();
    return (/** @type {unknown} */ data) => ({ valid: validate(data) });
  },
});

/**
 * `basic` (JSON Schema 2020-12): the units that carry an error or an
 * annotation, and the branch units of a failure, flat.
 * @type {Readonly<OutputFormat<BasicOutput>>}
 */
export const basicOutput = recordingFormat('basic', projectBasic);

/**
 * `detailed` (JSON Schema 2020-12): the units nested by the schema,
 * condensed to what decides the answer.
 * @type {Readonly<OutputFormat<KeywordOutputUnit>>}
 */
export const detailedOutput = recordingFormat('detailed', projectDetailed);

/**
 * `verbose` (JSON Schema 2020-12): every keyword of every applied
 * subschema, nested.
 * @type {Readonly<OutputFormat<KeywordOutputUnit>>}
 */
export const verboseOutput = recordingFormat('verbose', projectVerbose);

/**
 * `list`: the units that carry errors or annotations, flat under
 * `details`.
 * @type {Readonly<OutputFormat<ListOutput>>}
 */
export const listOutput = recordingFormat('list', projectList);

/**
 * `hierarchical`: every applied subschema, nested under `details`.
 * @type {Readonly<OutputFormat<EvaluationOutputUnit>>}
 */
export const hierarchicalOutput = recordingFormat('hierarchical', (root) => projectHierarchical(root));
