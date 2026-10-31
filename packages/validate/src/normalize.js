//#region schema-driven normalization
// Normalization is a SEPARATE pass from validation, compiled from the same
// schema. `@jarenjs/validate`'s compiled validators are pure predicates and
// stay that way: they never apply a `default`, never coerce, never trim and
// never strip. This module is where a consumer that needs Zod-style
// normalized *output* gets it, without the validator growing a side effect.
//
// Two properties are load-bearing:
//
//   1. The input is never mutated. Ajv's `useDefaults`/`coerceTypes` write
//      into the document they were handed; this compiles to a copy-on-write
//      walk instead, so `normalize(input)` returns a new value and `input`
//      is exactly as it was. A caller can hand the same document to two
//      normalizers, or keep it as an audit record, without defensive copying.
//   2. Untouched subtrees keep their identity. A node whose whole subtree is
//      unchanged is returned by reference, and a document that needs no
//      change at all returns the input reference itself (`normalize(x) === x`).
//      That makes a no-op cheap and lets downstream memoization by identity
//      keep working.
//
// House style: the same two-stage shape as the validator. `compileNormalizer`
// walks the schema once and specializes one closure per node; the returned
// function just runs closures. No `eval`, no `new Function`, no dependencies
// outside `@jarenjs/*`.

import {
  cloneJson,
  isJsonContainer,
  isJsonObject,
  isPlainOptions,
  refuseUnknownMembers,
  setObjectMember,
} from '@jarenjs/core/object';

import { isJsonNumberString } from '@jarenjs/core/number';
import { CC_LBRACE, CC_LBRACKET, isWhitespaceCode } from '@jarenjs/core/scan';
import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  VALIDATION_KEYWORDS,
  detectSchemaDraft,
  dialectVocabulary,
  holdDialects,
  readPrefixItems,
  readsPrefixItems,
  readsSince,
} from './schema-keywords.js';
import { createSchemaPatternTester } from './string.js';
import { DEFAULT_ORIGIN, encodeJsonPointerPath } from './origin.js';
import { admitsDynamicReference } from './dynamic-ref.js';
import { heldDialects } from './validator-state.js';
import { unimplementedVocabulary } from './errors.js';
import { JarenValidator } from './index.js';
import { indexSchemaResources, readsRefAlone, resolveSchemaReference, schemaPlace } from './references.js';

// The validator's reading of a `pattern` string, for a consumer that checks
// one without compiling a schema (a form field, per keystroke); of the
// draft a `$schema` declares, for a consumer that reads a `$ref`'s siblings
// as this module does ({@link readsRefAlone}); and of where `prefixItems`
// is a keyword, which a draft before 2020-12 reads as an unknown one.
export { createSchemaPatternTester, detectSchemaDraft, readsPrefixItems };

// The reading of a document's references, which the normalizer resolves
// through: `@jarenjs/validate/references` serves the same functions without
// the validator, for a reader that needs nothing else.
export {
  collectSameDocumentAnchors,
  indexSchemaResources,
  readsRefAlone,
  referenceText,
  resolveSameDocumentRef,
  resolveSchemaReference,
  schemaPlace,
} from './references.js';

/** @typedef {import('./references.js').SchemaPlace} SchemaPlace */
/** @typedef {import('./references.js').SchemaResources} SchemaResources */

const hasOwn = Object.hasOwn;

/**
 * A compiled normalizer. `In` is what the caller accepts, `Out` what the
 * normalized value is; they differ whenever defaults are materialized, which
 * is exactly the distinction a contract wrapper needs to expose.
 * @template [In=unknown]
 * @template [Out=In]
 * @typedef {(data: In) => Out} Normalizer
 */

/**
 * Options for {@link compileNormalizer}. Every normalization is off by
 * default: each one changes the meaning of the caller's data, so each is a
 * decision the caller makes rather than inherits. With no options the
 * compiled normalizer is the identity.
 * Four of the five also accept a **predicate** `(schemaNode) => boolean`
 * instead of a boolean, evaluated once per node at compile time. That is how
 * a consumer turns a whole-schema switch into a per-field decision — "trim
 * these string fields, leave those alone" — without the option becoming a
 * blunt instrument and without any runtime cost.
 * @typedef {object} NormalizeOptions
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [useDefaults=false] - Materialize `default` for absent object properties, recursively,
 *   where the validator accepts the filled object at its place ({@link unfilledDefaults})
 * @property {boolean|'all'} [removeAdditional=false] - Strip unknown properties: `true` only where `additionalProperties: false`, `'all'` wherever an object shape is declared
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceTypes=false] - Convert a value to the node's declared scalar `type` when it is convertible
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [trimStrings=false] - Trim leading/trailing whitespace from strings, before coercion
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceJsonText=false] - Decode a string holding the JSON text of an object or array where the node's `type` wants that container and admits no string, then normalize the decoded value
 * @property {object} [dialects] - A `JarenValidator` whose held meta-schemas name the
 *   dialects the schema's `$schema` URIs may name ({@link heldDialects}), each place read with the
 *   vocabularies its dialect declares ({@link withoutUnreadVocabularies}). Without it a `$schema`
 *   is read by its name alone: a custom dialect reads as draft-07
 */

/**
 * Convert `value` to `type` when the conversion is unambiguous, otherwise
 * return it unchanged so validation reports the type error.
 *
 * The table is deliberately conservative - it exists to decode transport
 * encodings (query strings, form fields, environment variables, CSV cells)
 * where everything arrives as a string, not to paper over wrong data. Ajv
 * additionally maps `null`/`0`/`1`/`''` across types; those conversions lose
 * the difference between "absent", "empty" and "false", so they are not
 * reproduced here.
 * @param {any} value - The value to convert
 * @param {string} type - The declared JSON Schema scalar type
 * @returns {any} The converted value, or `value` when no conversion applies
 */
function coerceToType(value, type) {
  switch (type) {
    case 'number':
    case 'integer': {
      if (typeof value === 'number') return value;
      if (typeof value !== 'string' || !isJsonNumberString(value)) return value;
      const num = Number(value);
      if (!Number.isFinite(num)) return value;
      if (type === 'integer' && !Number.isSafeInteger(num)) return value;
      return num;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'boolean') return String(value);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return value;
    case 'null':
      return value === 'null' ? null : value;
    default:
      return value;
  }
}

/**
 * A document as the validator holding its dialects reads it: each place
 * reads the vocabularies of the dialect governing it — the nearest
 * `$schema` at or above it in its own document — so where that dialect's
 * meta-schema leaves the validation vocabulary out of its `$vocabulary`,
 * the place's validation keywords ({@link VALIDATION_KEYWORDS}) assert
 * nothing and a reader reads none of them. The document itself where no
 * place drops one, as always without `dialects` (a `$schema` is then read
 * by its name alone); else a copy without them, sharing every value that is
 * no schema object. Exported for `@jarenjs/emit` and the strict profile,
 * which read a document as this normalizer does.
 * @param {object|boolean} document
 * @param {{ dialects?: object }} [options] - `dialects`: a `JarenValidator` whose held meta-schemas name the dialects
 * @param {string} [who] - The function the option was given to, for its refusal
 * @returns {object|boolean}
 * @throws {TypeError} When `dialects` is given and is no `JarenValidator`
 * @throws {SchemaCompileError} `JK0016` where a dialect's meta-schema requires a vocabulary this package does not implement, as the validator refuses it
 */
export function withoutUnreadVocabularies(document, options = {}, who = 'withoutUnreadVocabularies') {
  const held = heldDialects(options.dialects, who);
  if (held === undefined || !isJsonObject(document)) return document;
  /** @type {Map<string, boolean>} Whether each dialect keeps the validation vocabulary on */
  const dialects = new Map();
  /** @param {string} uri @param {string} at - Where the `$schema` naming it sits */
  const validationOf = (uri, at) => {
    let validation = dialects.get(uri);
    if (validation === undefined) {
      const { validation: on, unimplemented } = dialectVocabulary(uri, (key) => held.get(key), detectSchemaDraft({ $schema: uri }, held));
      if (unimplemented !== undefined) throw unimplementedVocabulary(uri, unimplemented, encodeJsonPointerPath(at, '$schema'));
      dialects.set(uri, validation = on);
    }
    return validation;
  };
  /** @type {Map<unknown, unknown>[]} The node each object reads as, under the validation vocabulary off and on */
  const read = [new Map(), new Map()];
  /**
   * @param {unknown} value @param {boolean} validation - Whether the place's dialect keeps the vocabulary on
   * @param {string} at @returns {unknown}
   */
  const readSchemas = (value, validation, at) => {
    if (Array.isArray(value)) {
      let out = value;
      for (let i = 0; i < value.length; i++) {
        const item = readSchemas(value[i], validation, `${at}/${i}`);
        if (item !== value[i]) (out === value ? (out = value.slice()) : out)[i] = item;
      }
      return out;
    }
    if (!isJsonObject(value)) return value;
    if (typeof value.$schema === 'string') validation = validationOf(value.$schema, at);
    const memo = read[validation ? 1 : 0];
    if (memo.has(value)) return memo.get(value);
    memo.set(value, value);
    /** @type {Record<string, unknown>|undefined} */
    let out;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const member = value[key];
      let next = member;
      if (!validation && VALIDATION_KEYWORDS.includes(key)) next = undefined;
      else if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) next = readSchemas(member, validation, encodeJsonPointerPath(at, key));
      else if ((TRAVERSE_SCHEMA_MAPS.includes(key) || TRAVERSE_SCHEMA_MAP_MAPS.includes(key)) && isJsonObject(member)) {
        const deep = TRAVERSE_SCHEMA_MAP_MAPS.includes(key);
        for (const name of Object.keys(member)) {
          const inner = deep && isJsonObject(member[name])
            ? readMap(member[name], validation, encodeJsonPointerPath(at, key, name))
            : readSchemas(member[name], validation, encodeJsonPointerPath(at, key, name));
          if (inner === member[name]) continue;
          if (next === member) next = { ...member };
          setObjectMember(/** @type {Record<string, unknown>} */ (next), name, inner);
        }
      }
      if (next === member) {
        if (out !== undefined) setObjectMember(out, key, member);
        continue;
      }
      if (out === undefined) {
        out = {};
        for (let k = 0; k < i; k++) setObjectMember(out, keys[k], value[keys[k]]);
      }
      if (next !== undefined) setObjectMember(out, key, next);
    }
    const result = out ?? value;
    memo.set(value, result);
    return result;
  };
  /** @param {Record<string, unknown>} map @param {boolean} validation @param {string} at */
  const readMap = (map, validation, at) => {
    let out = map;
    for (const name of Object.keys(map)) {
      const inner = readSchemas(map[name], validation, encodeJsonPointerPath(at, name));
      if (inner === map[name]) continue;
      if (out === map) out = { ...map };
      setObjectMember(out, name, inner);
    }
    return out;
  };
  return /** @type {object} */ (readSchemas(document, true, '#'));
}

/**
 * Resolve a per-node normalization switch at COMPILE time. Exported because
 * `@jarenjs/emit` has to answer the same question when it derives the accepted
 * and normalized type variants: two implementations of this rule would drift,
 * and a type that disagrees with the normalizer is worse than no type. `true` turns the
 * behavior on everywhere, `false` nowhere, and a predicate decides per schema
 * node — which is how a consumer expresses "trim these 34 string fields, not
 * the other 185" without the option becoming a whole-schema blunt instrument.
 * Because it runs during compilation, a predicate costs nothing at runtime.
 * @param {boolean|((node: Record<string, unknown>) => boolean)|undefined} option
 * @param {object} node - The schema node the switch applies to
 * @returns {boolean}
 */
export function resolveNormalizeSwitch(option, node) {
  if (option === true) return true;
  if (typeof option === 'function') return option(node) === true;
  return false;
}

/**
 * Compose a list of node steps into one function, skipping the empty case.
 * @param {Function[]} steps - The steps to run in order
 * @returns {Function|null} The composed step, or null when there is none
 */
function composeSteps(steps) {
  if (steps.length === 0) return null;
  if (steps.length === 1) return steps[0];
  return function runSteps(value) {
    let out = value;
    for (let i = 0; i < steps.length; i++)
      out = steps[i](out);
    return out;
  };
}

//#region where a default is filled

// A default fills an absent member, and every schema object that may apply
// at the object's place then reads that member: the object holding the
// default and the ones beside it (a `$ref` target, the other `allOf`
// branches), which apply wherever it does, and the ones under a branch
// (`anyOf`, `oneOf`, `not`, `if`/`then`/`else`, `dependentSchemas`,
// `dependencies`, a dynamic reference's targets), which apply as the
// instance decides. A place's schemas are read from the ones its parent's
// schemas apply to it (every object's `properties`, matching
// `patternProperties`, `additionalProperties`, the items keywords), so two
// branches that each describe a member are one place for that member's
// value.
//
// The validator decides each default against the schemas it meets there,
// so a filled default never turns a value it accepts into one it refuses:
// - never filled where an object that applies for certain refuses the
//   member: its value (the member's own schema, another object's schema
//   for it, a matching `patternProperties`, an `additionalProperties` it is
//   not declared beside or an `unevaluatedProperties` it is not evaluated
//   under — `false` among them) or its name (`propertyNames`);
// - filled per instance where the member can change what the validator
//   answers in another way — an object under a branch refusing it, or one
//   counting the members (`maxProperties`), comparing the whole object
//   (`enum`, `const`), or reading the member's presence (`dependentRequired`,
//   `dependentSchemas`, `dependencies` naming it, and under a branch
//   `required`, `minProperties`): there, only where each schema applied at
//   the place answers the filled object as it answered the object without
//   it;
// - filled always otherwise.

/**
 * @typedef {object} DefaultPlace The schema objects that may apply at one place of an instance
 * @property {string} id - Its memo key: the same entries make the same place
 * @property {object[]} entries - The schemas applied there: the root, or the ones the objects of
 *   the place above apply to it
 * @property {boolean[]} refuses - For each entry, whether an object it refuses can still be
 *   accepted where it applies only as the instance decides (under a branch, where a refusal
 *   can be what the instance needs), so that a fill may not turn its refusal into an acceptance
 * @property {object[]} objects - Every schema object that may apply there, through the in-place
 *   applicators of its entries (one whose `$ref` is read alone stands for its target)
 * @property {Set<object>} sure - The objects that apply wherever the place is reached: from an
 *   entry that does, through `$ref` and `allOf`
 * @property {object[]} nodes - The objects that read its members or items ({@link PLACE_KEYWORDS});
 *   the others apply nothing below it
 * @property {Map<string, DefaultPlace>} children - The places below it, by site
 */

/**
 * The draft a schema object is read under ({@link SchemaPlace}).
 * @param {object} node @param {object} ctx
 * @returns {number|null}
 */
function draftOf(node, ctx) {
  return schemaPlace(ctx.resources, node).draft;
}

/**
 * The pattern testers of a schema object's `patternProperties`, read as the
 * validator reads a pattern.
 * @param {any} node @param {object} ctx
 * @returns {[string, (key: string) => boolean][]}
 */
function patternsOf(node, ctx) {
  let testers = ctx.patterns.get(node);
  if (testers === undefined) {
    testers = isJsonObject(node.patternProperties)
      ? Object.getOwnPropertyNames(node.patternProperties).map((source) => [source, createSchemaPatternTester(source)])
      : [];
    ctx.patterns.set(node, testers);
  }
  return testers;
}

/**
 * Whether a member is declared beside an object's `additionalProperties`:
 * its `properties` name it or one of its `patternProperties` matches it.
 * @param {any} node @param {string} key @param {object} ctx
 * @returns {boolean}
 */
function declaresMember(node, key, ctx) {
  return (isJsonObject(node.properties) && hasOwn(node.properties, key))
    || patternsOf(node, ctx).some(([, matches]) => matches(key));
}

/**
 * The schema an object's `$ref` names in the document, resolved once.
 * @param {any} node @param {object} ctx
 * @returns {unknown}
 */
function refTarget(node, ctx) {
  if (ctx.targets.has(node)) return ctx.targets.get(node);
  const target = resolveSchemaReference(node.$ref, schemaPlace(ctx.resources, node).refBase, ctx.resources);
  ctx.targets.set(node, target);
  return target;
}

/**
 * The targets of an object's dynamic references (`$dynamicRef` from draft
 * 2020-12 on, `$recursiveRef` in 2019-09): the one each resolves to as a
 * `$ref`, and every object of the document declaring the anchor the dynamic
 * scope can resolve it to instead.
 * @param {any} node @param {number|null} draft @param {object} ctx
 * @returns {unknown[]}
 */
function dynamicTargets(node, draft, ctx) {
  const targets = [];
  for (const [keyword, anchor] of [['$dynamicRef', '$dynamicAnchor'], ['$recursiveRef', '$recursiveAnchor']]) {
    const ref = node[keyword];
    if (typeof ref !== 'string' || !admitsDynamicReference(/** @type {'$dynamicRef'|'$recursiveRef'} */ (keyword), draft)) continue;
    const target = resolveSchemaReference(ref, schemaPlace(ctx.resources, node).refBase, ctx.resources);
    if (target !== undefined) targets.push(target);
    const name = keyword === '$recursiveRef' ? true : ref.slice(ref.indexOf('#') + 1);
    const key = `${anchor}:${name}`;
    let declaring = ctx.anchors.get(key);
    if (declaring === undefined) {
      declaring = [...ctx.resources.places.keys()].filter((candidate) => candidate[anchor] === name);
      ctx.anchors.set(key, declaring);
    }
    targets.push(...declaring);
  }
  return targets;
}

/**
 * The subschemas that apply at the same place as a schema object, as the
 * validator reads them: wherever the object applies (`subschemas`: its
 * `$ref` target, its `allOf` branches), and as the instance decides
 * (`branches`); `alone` where it reads only the object's `$ref`.
 * @param {any} node @param {object} ctx
 * @returns {{ alone: boolean, subschemas: unknown[], branches: unknown[] }}
 */
function inPlaceSubschemas(node, ctx) {
  const draft = draftOf(node, ctx);
  const subschemas = [];
  const branches = [];
  if (typeof node.$ref === 'string') subschemas.push(refTarget(node, ctx));
  if (readsRefAlone(node, draft, ctx.resources.held)) return { alone: true, subschemas, branches };
  if (Array.isArray(node.allOf)) subschemas.push(...node.allOf);
  branches.push(...dynamicTargets(node, draft, ctx));
  for (const keyword of ['anyOf', 'oneOf'])
    if (Array.isArray(node[keyword])) branches.push(...node[keyword]);
  if (node.not !== undefined) branches.push(node.not);
  if (node.if !== undefined) branches.push(node.if, node.then, node.else);
  if (isJsonObject(node.dependentSchemas) && readsSince('dependentSchemas', draft))
    branches.push(...Object.values(node.dependentSchemas));
  if (isJsonObject(node.dependencies))
    branches.push(...Object.values(node.dependencies).filter((value) => !Array.isArray(value)));
  return { alone: false, subschemas, branches };
}

/**
 * Whether a schema object evaluates a member on every way it passes, as
 * `unevaluatedProperties` reads the annotations below it: its own
 * `properties`, `patternProperties`, `additionalProperties` and (below the
 * object asking) `unevaluatedProperties`; a `$ref` target or an `allOf`
 * branch that does; every `anyOf`/`oneOf` branch and dynamic target; `if`
 * or `then`, and `else`. A `false` schema never passes, so it never leaves
 * the member unevaluated.
 * @param {unknown} node @param {string} key @param {object} ctx
 * @param {Set<object>} trail - The objects being asked, a cycle answering no
 * @param {boolean} [asking] - Whether `node` is the object whose `unevaluatedProperties` asks
 * @returns {boolean}
 */
function evaluatesMember(node, key, ctx, trail, asking = false) {
  if (node === false) return true;
  if (!isJsonObject(node) || trail.has(node)) return false;
  trail.add(node);
  const evaluates = (/** @type {unknown} */ schema) => evaluatesMember(schema, key, ctx, trail);
  const draft = draftOf(node, ctx);
  const target = typeof node.$ref === 'string' ? refTarget(node, ctx) : undefined;
  let answer;
  if (readsRefAlone(node, draft, ctx.resources.held)) answer = evaluates(target);
  else {
    const dynamic = dynamicTargets(node, draft, ctx);
    answer = declaresMember(node, key, ctx) || node.additionalProperties !== undefined
      || (!asking && node.unevaluatedProperties !== undefined && readsSince('unevaluatedProperties', draft))
      || evaluates(target)
      || (dynamic.length > 0 && dynamic.every(evaluates))
      || (Array.isArray(node.allOf) && node.allOf.some(evaluates))
      || (Array.isArray(node.anyOf) && node.anyOf.length > 0 && node.anyOf.every(evaluates))
      || (Array.isArray(node.oneOf) && node.oneOf.length > 0 && node.oneOf.every(evaluates))
      || (node.if !== undefined && (evaluates(node.if) || evaluates(node.then)) && evaluates(node.else));
  }
  trail.delete(node);
  return answer;
}

/**
 * A schema object's number in this compile, for a key naming it.
 * @param {object} node @param {object} ctx
 * @returns {number}
 */
function nodeId(node, ctx) {
  let id = ctx.nodeIds.get(node);
  if (id === undefined) ctx.nodeIds.set(node, id = ctx.nodeIds.size);
  return id;
}

/** The keywords through which a schema object refuses a member or applies a subschema below its place. */
const PLACE_KEYWORDS = ['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
  'items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems'];

/**
 * The key naming a set of schema objects, the same for the same set.
 * @param {object[]} nodes @param {object} ctx
 * @returns {string}
 */
function nodesKey(nodes, ctx) {
  if (nodes.length === 1) return `|${nodeId(nodes[0], ctx)}`;
  return `|${[...new Set(nodes.map((node) => nodeId(node, ctx)))].sort((a, b) => a - b).join(',')}`;
}

/**
 * The place the given schemas apply at, with every object that may apply
 * beside them. The same entries make the same place.
 * @param {unknown[]} sure - The entries applied wherever the place is reached
 * @param {unknown[]} maybe - The entries applied as the instance decides
 * @param {object} ctx
 * @returns {DefaultPlace}
 */
function defaultPlace(sure, maybe, ctx) {
  const certain = sure.filter(isJsonObject);
  const possible = maybe.filter(isJsonObject);
  const id = `${nodesKey(certain, ctx)}?${nodesKey(possible, ctx)}`;
  let place = ctx.defaultPlaces.get(id);
  if (place !== undefined) return place;
  /** @type {Set<object>} */
  const always = new Set();
  const queue = certain.slice();
  while (queue.length > 0) {
    const node = queue.pop();
    if (!isJsonObject(node) || always.has(node)) continue;
    always.add(node);
    queue.push(...inPlaceSubschemas(node, ctx).subschemas);
  }
  const objects = [];
  const nodes = [];
  const seen = new Set();
  queue.push(...certain, ...possible);
  while (queue.length > 0) {
    const node = queue.pop();
    if (!isJsonObject(node) || seen.has(node)) continue;
    seen.add(node);
    const { alone, subschemas, branches } = inPlaceSubschemas(node, ctx);
    if (!alone) {
      objects.push(node);
      if (PLACE_KEYWORDS.some((keyword) => node[keyword] !== undefined)) nodes.push(node);
    }
    queue.push(...subschemas, ...branches);
  }
  const entries = [...new Set([...certain, ...possible])];
  place = { id, entries, refuses: entries.map((entry) => !certain.includes(entry)), objects, sure: always, nodes, children: new Map() };
  ctx.defaultPlaces.set(id, place);
  return place;
}

/**
 * The place below `place` that a site of it reaches, from the subschemas
 * each of its objects applies there.
 * @param {DefaultPlace} place @param {string} site - The site's key
 * @param {(node: any, push: (schema: unknown, certain: boolean) => void) => void} collect - Pushes
 *   an object's subschemas for the site, each with whether it applies to every value of the site
 * @param {object} ctx
 * @returns {DefaultPlace}
 */
function placeBelow(place, site, collect, ctx) {
  let child = place.children.get(site);
  if (child === undefined) {
    const sure = [];
    const maybe = [];
    for (const node of place.nodes) {
      const always = place.sure.has(node);
      const push = (/** @type {unknown} */ schema, /** @type {boolean} */ certain) => {
        if (isJsonObject(schema)) (always && certain ? sure : maybe).push(schema);
      };
      collect(node, push);
      // applied to what nothing else evaluates, and to the items it matches
      if (node.unevaluatedProperties !== undefined && site.startsWith('p') && readsSince('unevaluatedProperties', draftOf(node, ctx)))
        push(node.unevaluatedProperties, false);
      if (node.unevaluatedItems !== undefined && site.startsWith('i') && readsSince('unevaluatedItems', draftOf(node, ctx)))
        push(node.unevaluatedItems, false);
      if (site.startsWith('i')) push(node.contains, false);
    }
    place.children.set(site, child = defaultPlace(sure, maybe, ctx));
  }
  return child;
}

/**
 * The place of a member's value, for a member named `key`.
 * @param {DefaultPlace} place @param {string} key @param {object} ctx
 * @returns {DefaultPlace}
 */
function memberPlace(place, key, ctx) {
  return placeBelow(place, `p:${key}`, (node, push) => {
    if (isJsonObject(node.properties) && hasOwn(node.properties, key)) push(node.properties[key], true);
    for (const [source, matches] of patternsOf(node, ctx)) if (matches(key)) push(node.patternProperties[source], true);
    if (!declaresMember(node, key, ctx)) push(node.additionalProperties, true);
  }, ctx);
}

/**
 * The place of the values of the members a `patternProperties` entry or an
 * `additionalProperties` of `holder` applies to: every subschema another
 * object may apply to such a member, each applying to some of them.
 * @param {DefaultPlace} place @param {any} holder @param {string|undefined} source - The pattern, undefined for `additionalProperties`
 * @param {object} ctx
 * @returns {DefaultPlace}
 */
function membersPlace(place, holder, source, ctx) {
  const matches = source === undefined
    ? (/** @type {string} */ key) => !declaresMember(holder, key, ctx)
    : createSchemaPatternTester(source);
  return placeBelow(place, `p${source === undefined ? '+' : '~'}${nodeId(holder, ctx)}:${source ?? ''}`, (node, push) => {
    if (isJsonObject(node.properties))
      for (const key of Object.getOwnPropertyNames(node.properties)) if (matches(key)) push(node.properties[key], false);
    // the holder's own `additionalProperties` applies to no member one of
    // its patterns matches, and its patterns to no member it reads as additional
    if (source === undefined || node !== holder) push(node.additionalProperties, node === holder);
    if (source !== undefined || node !== holder)
      for (const [pattern] of patternsOf(node, ctx)) push(node.patternProperties[pattern], node === holder && pattern === source);
  }, ctx);
}

/**
 * The tuple spelling an object's items are read in, as {@link buildArrayStep} reads it.
 * @param {any} node @param {object} ctx
 * @returns {{ prefix: unknown[], rest: unknown }}
 */
function itemsOf(node, ctx) {
  const itemsIsTuple = Array.isArray(node.items);
  const prefix = itemsIsTuple ? node.items : readPrefixItems({ declaredDraft: draftOf(node, ctx) }, node);
  return { prefix: Array.isArray(prefix) ? prefix : [], rest: itemsIsTuple ? node.additionalItems : node.items };
}

/**
 * The place of an item's value: the item at `index`, or with `rest`, every
 * item from `index` on.
 * @param {DefaultPlace} place @param {number} index @param {boolean} rest @param {object} ctx
 * @returns {DefaultPlace}
 */
function itemPlace(place, index, rest, ctx) {
  return placeBelow(place, `i${rest ? '+' : ''}${index}`, (node, push) => {
    const items = itemsOf(node, ctx);
    for (let i = index; i < items.prefix.length && (rest || i === index); i++) push(items.prefix[i], !rest);
    if (rest || index >= items.prefix.length) push(items.rest, index >= items.prefix.length);
  }, ctx);
}

/**
 * The context a subschema at a place below the one being compiled compiles
 * in: that place, reached through `site`; the same context where no
 * default is filled.
 * @param {any} ctx
 * @param {(place: DefaultPlace, ...rest: any[]) => DefaultPlace} site - {@link memberPlace}, {@link membersPlace} or {@link itemPlace}
 * @param {...any} args - The site's arguments, before the context
 * @returns {any}
 */
function below(ctx, site, ...args) {
  return ctx.defaultPlace === undefined ? ctx : { ...ctx, defaultPlace: site(ctx.defaultPlace, ...args, ctx) };
}

/**
 * Whether a document holds a `default` anywhere (a subschema a pointer
 * reaches outside the schema positions included): without one, no default
 * is filled and no place is read.
 * @param {unknown} document
 * @returns {boolean}
 */
function holdsDefault(document) {
  const seen = new Set();
  const queue = [document];
  while (queue.length > 0) {
    const value = queue.pop();
    if (!isJsonContainer(value) || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) queue.push(value[i]);
      continue;
    }
    if (hasOwn(value, 'default')) return true;
    for (const key in value) if (hasOwn(value, key)) queue.push(value[key]);
  }
  return false;
}

/**
 * @typedef {object} DefaultFill How one default fills its member at one place ({@link settleFill})
 * @property {object} holder - The object whose `properties` declares the member
 * @property {string} key - The member's name
 * @property {unknown} value - The default as written
 * @property {Function|null} step - The member's normalizer, which the filled copy runs through
 * @property {DefaultPlace} place - The place of the object it fills
 * @property {'never'|'check'|'always'|'deciding'|undefined} fill - How it fills, once settled:
 *   never, where the validator would answer the filled object `check`ed, or always
 * @property {unknown} [filled] - Its copy as the place ends up holding it ({@link filledValue})
 */

/**
 * The fill of a default of `holder` at the place being compiled, settled
 * once the whole document has compiled ({@link settleFills}); null where
 * no place is read, which fills it always.
 * @param {object} holder - The object whose `properties` declares the member
 * @param {string} key @param {unknown} value @param {object} ctx
 * @returns {DefaultFill|null}
 */
function defaultFill(holder, key, value, ctx) {
  if (ctx.defaultPlace === undefined) return null;
  /** @type {DefaultFill} */
  const fill = { holder, key, value, step: null, place: ctx.defaultPlace, fill: undefined };
  ctx.fills.list.push(fill);
  return fill;
}

/** The keywords of an object that only annotate: an object of only these accepts every value. */
const ANNOTATING = new Set(['default', 'title', 'description', 'examples', '$comment', 'deprecated', 'readOnly',
  'writeOnly', '$id', 'id', '$anchor', '$dynamicAnchor', '$schema', '$defs', 'definitions', '$vocabulary']);

/**
 * The schemas a member named `key` meets at a place, each with whether the
 * object holding it applies for certain and whether it reads the member's
 * name rather than its value: every object's `properties` of it, a matching
 * `patternProperties`, the `additionalProperties` of one that does not
 * declare it, the `unevaluatedProperties` (from 2019-09 on) of one that does
 * not certainly evaluate it, and `propertyNames`.
 * @param {DefaultPlace} place @param {string} key @param {object} ctx
 * @returns {[unknown, boolean, boolean][]}
 */
function memberSchemas(place, key, ctx) {
  /** @type {[unknown, boolean, boolean][]} */
  const met = [];
  for (const node of place.objects) {
    const certain = place.sure.has(node);
    if (isJsonObject(node.properties) && hasOwn(node.properties, key)) met.push([node.properties[key], certain, false]);
    for (const [source, matches] of patternsOf(node, ctx)) if (matches(key)) met.push([node.patternProperties[source], certain, false]);
    if (node.additionalProperties !== undefined && !declaresMember(node, key, ctx)) met.push([node.additionalProperties, certain, false]);
    if (node.unevaluatedProperties !== undefined && readsSince('unevaluatedProperties', draftOf(node, ctx))
      && !evaluatesMember(node, key, ctx, new Set(), true))
      met.push([node.unevaluatedProperties, certain, false]);
    if (node.propertyNames !== undefined) met.push([node.propertyNames, certain, true]);
  }
  return met;
}

/**
 * Whether an object at a place reads a member named `key` other than through
 * the schemas it meets, so that filling it can change what the validator
 * answers on some instance: one that counts the members (`maxProperties`),
 * compares the whole object (`enum`, `const`) or brings a requirement into
 * force when it is present (`dependentRequired`, `dependentSchemas`,
 * `dependencies` naming it); under a branch also one that requires it, a
 * number of members or it beside another member (`required`,
 * `minProperties`, a `dependentRequired` or `dependencies` list naming it),
 * since a refusal there can turn into an acceptance.
 * @param {DefaultPlace} place @param {string} key @param {object} ctx
 * @returns {boolean}
 */
function readsPresence(place, key, ctx) {
  const lists = (/** @type {unknown} */ map) => isJsonObject(map)
    && Object.values(map).some((list) => Array.isArray(list) && list.includes(key));
  for (const node of place.objects) {
    const draft = draftOf(node, ctx);
    if (node.maxProperties !== undefined || node.enum !== undefined || node.const !== undefined) return true;
    if (isJsonObject(node.dependentRequired) && readsSince('dependentRequired', draft) && hasOwn(node.dependentRequired, key)) return true;
    if (isJsonObject(node.dependentSchemas) && readsSince('dependentSchemas', draft) && hasOwn(node.dependentSchemas, key)) return true;
    if (isJsonObject(node.dependencies) && hasOwn(node.dependencies, key)) return true;
    if (place.sure.has(node)) continue;
    if ((Array.isArray(node.required) && node.required.includes(key)) || node.minProperties !== undefined
      || (readsSince('dependentRequired', draft) && lists(node.dependentRequired)) || lists(node.dependencies)) return true;
  }
  return false;
}

/**
 * Whether a schema can refuse a value only by the validator's answer: no
 * boolean, and some keyword that is no annotation.
 * @param {unknown} schema
 * @returns {boolean}
 */
function asserts(schema) {
  return isJsonObject(schema) && Object.keys(schema).some((keyword) => !ANNOTATING.has(keyword));
}

/** The members through which a schema reaches outside itself: copied, it would read another place. */
const REACHING = new Set(['$ref', '$dynamicRef', '$recursiveRef', '$id', 'id', '$anchor', '$dynamicAnchor',
  '$recursiveAnchor', '$data', '$query', '$schema']);

/**
 * Whether a schema reaches nothing outside itself: no member of it, at any
 * depth, references, identifies, reads the instance elsewhere or switches
 * the dialect ({@link REACHING}), so a copy of it answers as it does.
 * @param {unknown} schema
 * @returns {boolean}
 */
function standsAlone(schema) {
  const queue = [schema];
  while (queue.length > 0) {
    const value = queue.pop();
    if (!isJsonContainer(value)) continue;
    if (Array.isArray(value)) queue.push(...value);
    else for (const key of Object.keys(value)) {
      if (REACHING.has(key)) return false;
      queue.push(value[key]);
    }
  }
  return true;
}

/**
 * How the validator answers each check of a compile's defaults, by the
 * schema checked, made once, on the first check. Each schema is applied to a
 * member path of its own in one schema per group — nested
 * {@link CHECK_FANOUT} members wide, so a check reads a few members, not
 * every one: one that reaches nothing outside itself ({@link standsAlone})
 * is copied in, under the `$schema` governing its place, so the validator
 * compiles only what is checked; any other is a `$ref` to its place in the
 * document, which the validator then holds, read through the dialects it
 * was read with ({@link holdDialects}). A group that does not compile (a
 * reference to a document the normalizer does not hold) answers none of its
 * checks, where they answer as before.
 * @param {object} ctx
 * @returns {Map<object, (value: unknown) => boolean>}
 */
function checksOf(ctx) {
  const fills = ctx.fills;
  if (fills.checks !== undefined) return fills.checks;
  /** @type {Map<object, (value: unknown) => boolean>} */
  const checks = fills.checks = new Map();
  /** @type {Map<string, [object, unknown][]>} Each group's schemas, with what its schema applies for each */
  const groups = new Map();
  for (const schema of fills.targets) {
    const place = ctx.resources.places.get(schema);
    if (place?.pointer === undefined) continue;
    const alone = standsAlone(schema);
    const group = alone ? `${place.dialect ?? ''}` : '#';
    if (!groups.has(group)) groups.set(group, []);
    /** @type {[object, unknown][]} */ (groups.get(group)).push([schema, alone ? cloneJson(schema) : { $ref: `${place.base}${place.pointer}` }]);
  }
  const validator = new JarenValidator();
  holdDialects(validator, ctx.resources.named, ctx.resources.held);
  let n = 0;
  for (const [group, members] of groups) {
    let depth = 1;
    while (CHECK_FANOUT ** depth < members.length) depth++;
    /** @param {number} target @returns {string[]} The member path of a schema of the group */
    const path = (target) => {
      const names = [];
      for (let d = 0; d < depth; d++, target = Math.floor(target / CHECK_FANOUT)) names.unshift(String(target % CHECK_FANOUT));
      return names;
    };
    const root = /** @type {any} */ ({ $id: `${CHECKS_BASE}${n++}.json` });
    if (group === '#') validator.addSchema(ctx.document, DEFAULT_ORIGIN);
    else if (group !== '') root.$schema = group;
    for (let target = 0; target < members.length; target++) {
      const names = path(target);
      let node = root;
      for (let d = 0; d < names.length - 1; d++) node = ((node.properties ??= {})[names[d]] ??= {});
      (node.properties ??= {})[names[names.length - 1]] = members[target][1];
    }
    try {
      const compiled = validator.compile(root);
      for (let target = 0; target < members.length; target++) {
        const names = path(target).reverse();
        checks.set(members[target][0], (value) => {
          let data = value;
          for (const name of names) data = { [name]: data };
          return compiled(data) === true;
        });
      }
    }
    catch {
      // the group does not compile on its own: none of its checks answers
    }
  }
  return checks;
}

/** How many members wide each level of a checker's schema is. */
const CHECK_FANOUT = 16;

/** The base of the URIs the checks' schemas take, which no document of the normalizer names. */
const CHECKS_BASE = 'https://normalize.jarenjs.invalid/checks-';

/**
 * What the validator answers for a value under a schema of the document:
 * a boolean schema itself, an object that only annotates accepts, and one
 * the checker cannot answer accepts (as before the check).
 * @param {unknown} schema @param {unknown} value @param {object} ctx
 * @returns {boolean}
 */
function answers(schema, value, ctx) {
  if (typeof schema === 'boolean') return schema;
  if (!asserts(schema)) return true;
  const check = checksOf(ctx).get(/** @type {object} */ (schema));
  if (check === undefined) return true;
  try { return check(value); }
  catch { return true; }
}

/**
 * Settle every default a compile met: the schemas each meets at its place
 * are the checker's targets, then each is settled ({@link settleFill}).
 * The defaults a place leaves out (never, or checked per instance) are
 * recorded by the object declaring them.
 * @param {object} ctx
 */
function settleFills(ctx) {
  const { list, targets } = ctx.fills;
  ctx.fills.guarding = true;
  for (const fill of list) {
    let branches = false;
    for (const [schema, certain] of memberSchemas(fill.place, fill.key, ctx)) {
      if (asserts(schema)) targets.add(/** @type {object} */ (schema));
      if (!certain) branches = true;
    }
    if (branches || readsPresence(fill.place, fill.key, ctx)) for (const entry of fill.place.entries) targets.add(entry);
  }
  for (const fill of list) settleFill(fill, ctx);
  ctx.fills.guarding = ctx.fills.reentered;
}

/**
 * The objects whose steps run at an entry's place, in the order its
 * normalizer runs them ({@link compileNode}): a `$ref` target's first,
 * then each `allOf` branch's, then the object's own (none where its `$ref`
 * is read alone).
 * @param {unknown} node @param {object} ctx @param {object[]} [out] @param {Set<object>} [trail]
 * @returns {object[]}
 */
function stepOrder(node, ctx, out = [], trail = new Set()) {
  if (!isJsonObject(node) || trail.has(node)) return out;
  trail.add(node);
  if (typeof node.$ref === 'string') stepOrder(refTarget(node, ctx), ctx, out, trail);
  if (!readsRefAlone(node, draftOf(node, ctx), ctx.resources.held)) {
    if (Array.isArray(node.allOf)) for (const branch of node.allOf) stepOrder(branch, ctx, out, trail);
    out.push(node);
  }
  trail.delete(node);
  return out;
}

/**
 * A default's copy as its place ends up holding it: run through its own
 * member's normalizers, then through what each step after the one filling
 * it does to that member, in the entry holding the object that declares it
 * (a later `allOf` branch, the object holding a `$ref` to it).
 * @param {DefaultFill} fill @param {object} ctx
 * @returns {unknown}
 */
function filledValue(fill, ctx) {
  return copyThrough(ctx, fill.holder, fill.key, (copy) => {
    let value = fill.step === null ? copy : fill.step(copy);
    for (const entry of fill.place.entries) {
      const order = stepOrder(entry, ctx);
      const at = order.indexOf(fill.holder);
      if (at === -1) continue;
      for (const node of order.slice(at + 1)) {
        const step = ctx.fills.members.get(`${fill.place.id}#${nodeId(node, ctx)}`)?.(fill.key);
        if (step != null) value = step(value);
      }
      break;
    }
    return value;
  }, cloneJson(fill.value));
}

/**
 * Run `step` over a copy of the default of the member `key` that `holder`
 * declares while that default is copying: a default holding the object
 * that declares it reaches its own member again inside the copy (through
 * the copy's own normalizers or a later step's), and fills nothing more
 * there, so it is filled once rather than without end.
 * @param {object} ctx @param {object} holder @param {string} key
 * @param {Function} step @param {unknown} value
 * @returns {unknown}
 */
function copyThrough(ctx, holder, key, step, value) {
  const copying = ctx.fills.copying;
  let keys = copying.get(holder);
  if (keys === undefined) copying.set(holder, keys = new Set());
  if (keys.has(key)) return step(value);
  keys.add(key);
  try {
    return step(value);
  }
  finally {
    keys.delete(key);
  }
}

/**
 * The normalizer of a document some of whose defaults reach their own
 * member inside their copy: each call records the copies its defaults
 * fill, so a later step (another `allOf` branch, the object holding a
 * `$ref` to the one declaring it) that runs one through normalizers fills
 * nothing more of that default either. The record lasts the call.
 * @param {object} fills - The compile's fills
 * @param {Function} step
 * @returns {Function}
 */
function recordingCopies(fills, step) {
  return function normalizeRecordingCopies(value) {
    const outer = fills.copies;
    fills.copies = new Map();
    try {
      return step(value);
    }
    finally {
      fills.copies = outer;
    }
  };
}

/**
 * Settle how one default fills ({@link DefaultFill}): never where a schema
 * applying for certain refuses its copy as the place ends up holding it
 * ({@link filledValue}) or its name; checked per instance where a schema
 * under a branch does, or where the place reads the member otherwise
 * ({@link readsPresence}); always else. While it settles, normalizing its
 * own copy fills nothing more of it.
 * @param {DefaultFill} fill @param {object} ctx
 * @returns {'never'|'check'|'always'|'deciding'}
 */
function settleFill(fill, ctx) {
  if (fill.fill !== undefined) return fill.fill;
  fill.fill = 'deciding';
  let value;
  try {
    value = fill.filled = filledValue(fill, ctx);
  }
  catch (error) {
    // a copy nested past what the host's stack copies or normalizes is
    // filled as written, and runs out of stack again when a call fills it,
    // as it did before it was checked
    if (!(error instanceof RangeError)) throw error;
    return fill.fill = 'always';
  }
  /** @type {'never'|'check'|'always'} */
  let how = 'always';
  for (const [schema, certain, name] of memberSchemas(fill.place, fill.key, ctx)) {
    if (answers(schema, name ? fill.key : value, ctx)) continue;
    if (certain) {
      how = 'never';
      break;
    }
    how = 'check';
  }
  if (how === 'always' && readsPresence(fill.place, fill.key, ctx)) how = 'check';
  fill.fill = how;
  if (how !== 'always') {
    let keys = ctx.unfilled.get(fill.holder);
    if (keys === undefined) ctx.unfilled.set(fill.holder, keys = new Set());
    keys.add(fill.key);
  }
  return fill.fill;
}

/**
 * Fill the defaults a place checks per instance into `object`: each where
 * every schema applied at the place answers the filled object (the member
 * as the steps after this one leave it, {@link filledValue}) as it answered
 * the object without it — all at once where they do together, else one by
 * one, in their order. A schema applied there for certain may come to
 * accept the object; one under a branch may not change its answer either
 * way. Where the checker cannot answer, each is filled as before.
 * @param {Record<string, unknown>} object
 * @param {[DefaultFill, unknown][]} checked - Each default and its filled copy
 * @param {object} ctx
 * @returns {Record<string, unknown>}
 */
function fillChecked(object, checked, ctx) {
  const place = checked[0][0].place;
  /**
   * @param {[DefaultFill, unknown][]} fills @param {(fill: DefaultFill, filled: unknown) => unknown} member - The value each member takes
   * @param {Record<string, unknown>} [from] - The object to copy, `object` by default
   */
  const withMembers = (fills, member, from = object) => {
    const next = { ...from };
    for (const [fill, filled] of fills) setObjectMember(next, fill.key, member(fill, filled));
    return next;
  };
  const before = placeAnswers(place, object, ctx);
  if (before === undefined) return withMembers(checked, (_, filled) => filled);
  /** @param {boolean[]} from @param {boolean[]|undefined} after */
  const changes = (from, after) => after === undefined
    || after.some((answer, e) => answer !== from[e] && (from[e] || place.refuses[e]));
  if (!changes(before, placeAnswers(place, withMembers(checked, (fill) => fill.filled), ctx)))
    return withMembers(checked, (_, filled) => filled);
  let out = object;
  let answered = before;
  for (const pair of checked) {
    const after = placeAnswers(place, withMembers([pair], (fill) => fill.filled, out), ctx);
    if (after === undefined || changes(answered, after)) continue;
    out = withMembers([pair], (_, filled) => filled, out);
    answered = after;
  }
  return out;
}

/**
 * What each schema applied at a place answers for an object, in the order
 * of its entries; undefined where the checker cannot answer.
 * @param {DefaultPlace} place @param {unknown} object @param {object} ctx
 * @returns {boolean[]|undefined}
 */
function placeAnswers(place, object, ctx) {
  const checks = checksOf(ctx);
  const out = [];
  for (const entry of place.entries) {
    const check = checks.get(entry);
    if (check === undefined) return undefined;
    try { out.push(check(object)); }
    catch { return undefined; }
  }
  return out;
}

//#endregion

/**
 * Build the object step: strip unknown members, normalize known ones, then
 * materialize defaults. That order is what makes the result stable - a
 * default is never stripped, and a stripped member never gets normalized.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildObjectStep(node, ctx) {
  const options = ctx.options;
  const properties = isJsonObject(node.properties) ? node.properties : null;
  const patternProperties = isJsonObject(node.patternProperties) ? node.patternProperties : null;
  const additional = node.additionalProperties;

  // Every declared name is recorded, including one whose subschema needs no
  // work: "declared but unchanged" and "not declared at all" are the same
  // lookup result otherwise, and stripping would delete a known member.
  // A null value means declared, nothing to do.
  const propertySteps = new Map();
  const defaults = [];
  let hasStep = false;
  if (properties !== null) {
    const keys = Object.getOwnPropertyNames(properties);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const sub = properties[key];
      const step = compileNode(sub, below(ctx, memberPlace, key));
      propertySteps.set(key, step);
      if (step !== null) hasStep = true;
      // Keep the property's step with its default. Matching pattern steps
      // are composed below so absent and supplied members normalize alike.
      if (isJsonObject(sub) && sub.default !== undefined && !readsRefAlone(sub, ctx.declaredDraft, ctx.resources.held)
        && resolveNormalizeSwitch(options.useDefaults, sub))
        defaults.push(key, sub.default, step, defaultFill(node, key, sub.default, ctx));
    }
  }

  // Same for patterns: a pattern that matches makes a member known, whether
  // or not its subschema normalizes anything.
  const patternSteps = [];
  if (patternProperties !== null) {
    const sources = Object.getOwnPropertyNames(patternProperties);
    for (let i = 0; i < sources.length; i++) {
      const matches = createSchemaPatternTester(sources[i]);
      const step = compileNode(patternProperties[sources[i]], below(ctx, membersPlace, node, sources[i]));
      patternSteps.push(matches, step);
      if (step !== null) hasStep = true;
    }
  }

  const additionalStep = additional === undefined || typeof additional === 'boolean'
    ? null
    : compileNode(additional, below(ctx, membersPlace, node, undefined));

  // `true` strips only where the schema says the members are forbidden;
  // 'all' additionally strips members a declared shape simply does not
  // mention. Neither strips an object whose shape is undeclared - there,
  // every member is legitimately "additional".
  const declaresShape = properties !== null || patternProperties !== null;
  const strip = ctx.allowStrip && options.removeAdditional !== false
    && (additional === false || (options.removeAdditional === 'all' && declaresShape));

  const defaultCount = defaults.length;
  const patternCount = patternSteps.length;
  for (let i = 0; i < defaultCount; i += 4) {
    const steps = defaults[i + 2] === null ? [] : [defaults[i + 2]];
    for (let p = 0; p < patternCount; p += 2) {
      if (patternSteps[p + 1] !== null && patternSteps[p](defaults[i]))
        steps.push(patternSteps[p + 1]);
    }
    defaults[i + 2] = composeSteps(steps);
    if (defaults[i + 3] !== null) defaults[i + 3].step = defaults[i + 2];
  }
  if (!hasStep && additionalStep === null && !strip && defaultCount === 0)
    return null;
  // what this step does to a member a default of another object here filled before it
  if (ctx.defaultPlace !== undefined) {
    ctx.fills.members.set(`${ctx.defaultPlace.id}#${nodeId(node, ctx)}`, (/** @type {string} */ key) => {
      const named = propertySteps.get(key);
      const steps = named == null ? [] : [named];
      let covered = named !== undefined;
      for (let p = 0; p < patternCount; p += 2) {
        if (!patternSteps[p](key)) continue;
        covered = true;
        if (patternSteps[p + 1] !== null) steps.push(patternSteps[p + 1]);
      }
      if (!covered && additionalStep !== null) steps.push(additionalStep);
      return composeSteps(steps);
    });
  }

  const fills = ctx.fills;
  return function normalizeObject(value) {
    if (!isJsonObject(value)) return value;
    let out = value;
    const copies = fills.copies;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const current = value[key];
      let next = current;
      // a default's copy a later step runs through normalizers fills nothing more of that default
      const copy = copies === null || current === null || typeof current !== 'object' ? undefined : copies.get(current);
      // JSON Schema applies EVERY applicable subschema to a member, so a
      // member covered by `properties` and by one or more `patternProperties`
      // is normalized by all of them in turn. `additionalProperties` applies
      // only when nothing else did.
      // undefined = not declared; null = declared with nothing to do.
      const named = propertySteps.get(key);
      let covered = named !== undefined;
      if (named != null) next = copy === undefined ? named(next) : copyThrough(ctx, copy[0], copy[1], named, next);
      for (let p = 0; p < patternCount; p += 2) {
        if (!patternSteps[p](key)) continue;
        covered = true;
        const patternStep = patternSteps[p + 1];
        if (patternStep !== null) next = copy === undefined ? patternStep(next) : copyThrough(ctx, copy[0], copy[1], patternStep, next);
      }
      if (!covered) {
        if (strip) {
          if (out === value) out = { ...value };
          delete out[key];
          continue;
        }
        if (additionalStep !== null) next = copy === undefined ? additionalStep(next) : copyThrough(ctx, copy[0], copy[1], additionalStep, next);
      }
      if (next !== current) {
        if (out === value) out = { ...value };
        setObjectMember(out, key, next);
      }
    }
    /** @type {[DefaultFill, unknown][]|undefined} The defaults filled where the validator answers alike */
    let checked;
    for (let i = 0; i < defaultCount; i += 4) {
      const key = defaults[i];
      if (hasOwn(value, key)) continue;
      // inside its own copy a default fills nothing more ({@link copyThrough})
      if (fills.guarding && fills.copying.get(node)?.has(key) === true) {
        fills.reentered = true;
        continue;
      }
      const fill = defaults[i + 3];
      const how = fill === null ? 'always' : settleFill(fill, ctx);
      if (how === 'never' || how === 'deciding') continue;
      // Each instance gets its own copy: a container default shared across
      // normalized documents would let a mutation of one leak into all. The
      // copy runs through the property and every matching pattern, in the
      // same order as a supplied value.
      const step = defaults[i + 2];
      const materialized = cloneJson(defaults[i + 1]);
      const filled = step === null ? materialized : fills.guarding ? copyThrough(ctx, node, key, step, materialized) : step(materialized);
      if (fills.copies !== null && filled !== null && typeof filled === 'object') fills.copies.set(filled, [node, key]);
      if (how === 'check') {
        (checked ??= []).push([/** @type {DefaultFill} */ (fill), filled]);
        continue;
      }
      if (out === value) out = { ...value };
      setObjectMember(out, key, filled);
    }
    return checked === undefined ? out : fillChecked(out, checked, ctx);
  };
}

/**
 * Build the array step. Both tuple spellings are handled: draft 2020-12's
 * `prefixItems` + `items` (read only where the declared draft has
 * `prefixItems`), and draft-07's array-valued `items` + `additionalItems`.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildArrayStep(node, ctx) {
  const itemsIsTuple = Array.isArray(node.items);
  const prefixSource = itemsIsTuple ? node.items : readPrefixItems(ctx, node);
  const restSource = itemsIsTuple ? node.additionalItems : node.items;
  // A prefix with no work still occupies its declared positions: the tail
  // schema applies only after it, even when its step table was elided.
  const prefixLength = Array.isArray(prefixSource) ? prefixSource.length : 0;

  let prefixSteps = null;
  if (Array.isArray(prefixSource)) {
    prefixSteps = new Array(prefixSource.length);
    let used = false;
    for (let i = 0; i < prefixSource.length; i++) {
      prefixSteps[i] = compileNode(prefixSource[i], below(ctx, itemPlace, i, false));
      if (prefixSteps[i] !== null) used = true;
    }
    if (!used) prefixSteps = null;
  }

  const restStep = restSource === undefined || typeof restSource === 'boolean'
    ? null
    : compileNode(restSource, below(ctx, itemPlace, prefixLength, true));

  if (prefixSteps === null && restStep === null) return null;

  return function normalizeArray(value) {
    if (!Array.isArray(value)) return value;
    let out = value;
    for (let i = 0; i < value.length; i++) {
      const step = i < prefixLength ? (prefixSteps === null ? null : prefixSteps[i]) : restStep;
      if (step === null) continue;
      const current = value[i];
      const next = step(current);
      if (next !== current) {
        if (out === value) out = value.slice();
        out[i] = next;
      }
    }
    return out;
  };
}

/**
 * Whether `value` opens with the char code `open` once JSON whitespace
 * (space, tab, line feed, carriage return) is skipped.
 * @param {string} value
 * @param {number} open - The char code `{` or `[`
 * @returns {boolean}
 */
function opensWith(value, open) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!isWhitespaceCode(c)) return c === open;
  }
  return false;
}

/**
 * Build the JSON-text step: a string holding the JSON text of an object or
 * an array is replaced by the value it encodes, so the node's other steps
 * normalize the decoded container. A model's tool call delivers nested
 * structure this way, one quoted string where the schema wants an object.
 *
 * The step exists only where the string cannot be what was meant: the node's
 * own `type` names `object` or `array` and not `string`. A node without a
 * `type`, or one that admits a string, accepts the string as sent, and
 * decoding it would change a valid value. A node read as its `$ref` alone
 * (see {@link readsRefAlone}) builds no step of its own: its target decodes.
 *
 * Text that is not JSON, or encodes a scalar or the other container kind, is
 * returned unchanged so validation reports the string. The text is decoded
 * only when its first non-whitespace character opens a wanted container, so a
 * successful parse is that container and nothing else is attempted. Where
 * `trimStrings` applies, the trimmed text is read, as coercion reads it, so
 * padding the trim removes cannot leave text a second pass would decode.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildJsonTextStep(node, ctx) {
  if (!resolveNormalizeSwitch(ctx.options.coerceJsonText, node)) return null;
  const trim = resolveNormalizeSwitch(ctx.options.trimStrings, node);
  const types = typeof node.type === 'string' ? [node.type] : node.type;
  if (!Array.isArray(types) || types.includes('string')) return null;
  const wantsObject = types.includes('object');
  const wantsArray = types.includes('array');
  if (!wantsObject && !wantsArray) return null;

  return function normalizeJsonText(value) {
    if (typeof value !== 'string') return value;
    const source = trim ? value.trim() : value;
    if (!(wantsObject && opensWith(source, CC_LBRACE)) && !(wantsArray && opensWith(source, CC_LBRACKET))) return value;
    try {
      return JSON.parse(source);
    }
    catch (_e) {
      return value;
    }
  };
}

/**
 * Build the scalar step: trim, then coerce. Trimming runs first so that a
 * padded transport value (`' 42 '` for a numeric field) reaches coercion in
 * the shape the grammar accepts.
 *
 * Trimming applies to every string the walk reaches, not only to nodes typed
 * `string`, because the value that needs trimming is frequently the one
 * declared as a number; it is a switch, not a keyword, so it applies at a
 * node read as its `$ref` alone too, where the sibling `type` coerces nothing.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @param {boolean} refAlone - Whether the node is read as its `$ref` alone
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildScalarStep(node, ctx, refAlone) {
  const options = ctx.options;
  const trim = resolveNormalizeSwitch(options.trimStrings, node);
  // A union `type` gives no single conversion target, so coercion is skipped
  // rather than guessed.
  const coerceTo = !refAlone && resolveNormalizeSwitch(options.coerceTypes, node) && typeof node.type === 'string'
    ? node.type
    : null;
  if (!trim && coerceTo === null) return null;

  if (coerceTo === null) {
    return function normalizeTrim(value) {
      return typeof value === 'string' ? value.trim() : value;
    };
  }
  if (!trim) {
    return function normalizeCoerce(value) {
      return coerceToType(value, coerceTo);
    };
  }
  return function normalizeTrimCoerce(value) {
    return coerceToType(typeof value === 'string' ? value.trim() : value, coerceTo);
  };
}

/**
 * Compile one schema node into a normalizer step, or null when the node
 * cannot change anything. Recursive schemas are handled by publishing a
 * deferring placeholder into the memo before the node is built, so a `$ref`
 * back to an ancestor resolves to a function that is complete by the time it
 * is called.
 * @param {object|boolean} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null
 */
function compileNode(node, ctx) {
  if (!isJsonObject(node)) return null;
  // A schema that declares `$schema` is read per that draft, and the
  // subschemas below it inherit it, as the validator reads them. The
  // normalizer holds no meta-schemas: a dialect it does not know by name is
  // read as draft-07, where the validator reads one it holds by its
  // meta-schema.
  if (typeof node.$schema === 'string') {
    const declaredDraft = detectSchemaDraft(node, ctx.resources.held);
    if (declaredDraft !== ctx.declaredDraft) ctx = { ...ctx, declaredDraft };
  }

  // One node reached under two drafts (inline and as a reference target)
  // normalizes per draft, and at two places per place (the defaults it
  // fills: {@link defaultPlace}).
  const memoKey = `${ctx.allowStrip}${ctx.declaredDraft}${ctx.defaultPlace?.id ?? ''}`;
  let memo = ctx.memos.get(memoKey);
  if (memo === undefined) ctx.memos.set(memoKey, memo = new Map());
  const cached = memo.get(node);
  if (cached !== undefined) return cached;

  let built = null;
  const deferred = function normalizeDeferred(value) {
    return built === null ? value : built(value);
  };
  memo.set(node, deferred);

  const steps = [];

  // Before draft 2019-09, and in a document declaring no draft, the
  // validator reads a `$ref` alone: the keywords beside it apply nothing.
  // Such a node normalizes as its target and nothing else, so a sibling the
  // validator never reads cannot coerce, decode, strip or default a value
  // the reference accepts into one it refuses.
  const refAlone = readsRefAlone(node, ctx.declaredDraft, ctx.resources.held);

  // Decoding comes first: every other step of this node, the reference and
  // the `allOf` branches included, reads the decoded container.
  const jsonTextStep = refAlone ? null : buildJsonTextStep(node, ctx);
  if (jsonTextStep !== null) steps.push(jsonTextStep);

  if (typeof node.$ref === 'string') {
    // Resolved against the base of the resource holding the node, and read
    // in the draft its place in the document declares, as the validator
    // reads it.
    const target = refTarget(node, ctx);
    // A ref this module cannot follow is left alone rather than guessed at;
    // validation still resolves it through the full ref machinery.
    if (target !== undefined && target !== node) {
      const declaredDraft = isJsonObject(target) ? schemaPlace(ctx.resources, target).draft : ctx.declaredDraft;
      const step = compileNode(target, declaredDraft === ctx.declaredDraft ? ctx : { ...ctx, declaredDraft });
      if (step !== null) steps.push(step);
    }
  }

  // `allOf` branches all apply, so they compose, once and in declaration
  // order (the order is part of the contract: see the README). Stripping is
  // disabled for the whole subtree underneath: a branch declares only its own share of
  // the object, so what looks "additional" to it may be exactly what a
  // sibling branch declares. Composition-shaped schemas therefore keep their
  // members; only defaults, coercion and trimming flow through.
  if (!refAlone) {
    if (Array.isArray(node.allOf)) {
      const branchCtx = ctx.allowStrip ? { ...ctx, allowStrip: false } : ctx;
      for (let i = 0; i < node.allOf.length; i++) {
        const step = compileNode(node.allOf[i], branchCtx);
        if (step !== null) steps.push(step);
      }
    }

    const objectStep = buildObjectStep(node, ctx);
    if (objectStep !== null) steps.push(objectStep);

    const arrayStep = buildArrayStep(node, ctx);
    if (arrayStep !== null) steps.push(arrayStep);
  }

  const scalarStep = buildScalarStep(node, ctx, refAlone);
  if (scalarStep !== null) steps.push(scalarStep);

  built = composeSteps(steps);
  memo.set(node, built);
  // Callers that resolved this node while it was being built hold `deferred`;
  // everyone else gets the direct function.
  return built === null ? null : deferred;
}

/**
 * The compile context of a normalizer of `schema`: the options resolved,
 * the document's resources and, where defaults are filled, the place of its
 * root ({@link defaultPlace}).
 * @param {object|boolean} schema
 * @param {NormalizeOptions} options
 * @returns {any}
 */
function normalizerContext(schema, options) {
  admitNormalizeOptions(options);
  // the document as read under its dialects: without the validation
  // keywords where the dialect governing a place leaves them out
  schema = withoutUnreadVocabularies(schema, { dialects: options.dialects });
  const resolved = {
    useDefaults: options.useDefaults,
    removeAdditional: options.removeAdditional === 'all'
      ? 'all'
      : options.removeAdditional === true,
    coerceTypes: options.coerceTypes,
    trimStrings: options.trimStrings,
    coerceJsonText: options.coerceJsonText,
  };
  const ctx = {
    options: resolved,
    /** The document compiled: the schema as read under its dialects ({@link withoutUnreadVocabularies}) */
    document: schema,
    /** The document's resources: the base each reference resolves against, the draft each node is read under */
    resources: indexSchemaResources(schema, { dialects: options.dialects }),
    /** @type {number|null} The draft the schema being compiled declares, or null when none does */
    declaredDraft: null,
    /** @type {Map<string, Map<object, Function|null>>} The compiled steps per stripping mode, draft and place */
    memos: new Map(),
    allowStrip: true,
    /** @type {DefaultPlace|undefined} The place being compiled, where defaults are filled */
    defaultPlace: undefined,
    /** @type {Map<string, DefaultPlace>} Every place met, by its id */
    defaultPlaces: new Map(),
    /** The defaults met, their checks' targets and the validator answering them ({@link settleFills}) */
    fills: {
      list: /** @type {DefaultFill[]} */ ([]),
      targets: /** @type {Set<object>} */ (new Set()),
      /** @type {Map<object, (value: unknown) => boolean>|undefined} How the validator answers each check ({@link checksOf}) */
      checks: undefined,
      /** @type {Map<string, (key: string) => Function|null>} What each object's step at a place does to a member, by place and object */
      members: new Map(),
      /** @type {Map<object, Set<string>>} The defaults whose copy runs through normalizers right now, by the object declaring them ({@link copyThrough}) */
      copying: new Map(),
      /** @type {boolean} Whether a default reached its own member inside its copy */
      reentered: false,
      /** @type {boolean} Whether a fill marks its copy and checks the marks ({@link copyThrough}): while the fills settle, and after only where a default reached its own member */
      guarding: false,
      /** @type {Map<object, [object, string]>|null} During a call of {@link recordingCopies}: each copy a default filled, with that default */
      copies: null,
    },
    /** @type {Map<object, unknown>} Each `$ref`'s target */
    targets: new Map(),
    /** @type {Map<object, number>} Each schema object a place names, numbered */
    nodeIds: new Map(),
    /** @type {Map<object, [string, (key: string) => boolean][]>} Each object's pattern testers */
    patterns: new Map(),
    /** @type {Map<string, object[]>} The objects declaring each dynamic anchor */
    anchors: new Map(),
    /** @type {Map<object, Set<string>>} The members whose default a place refuses, by the object declaring them */
    unfilled: new Map(),
  };
  if ((resolved.useDefaults === true || typeof resolved.useDefaults === 'function') && holdsDefault(schema))
    ctx.defaultPlace = defaultPlace([schema], [], ctx);
  return ctx;
}

/**
 * The defaults `compileNormalizer(schema, options)` leaves unfilled at some
 * place of the document, or for some instances: one a schema applying there
 * for certain refuses (its copy as the place holds it, an
 * `additionalProperties` or `unevaluatedProperties` it meets — `false`
 * among them —, `propertyNames`), and one filled per instance (a branch, a
 * member count, a presence or the whole object read there). Exported for
 * `@jarenjs/emit`, whose normalized types claim a defaulted member present
 * only where the normalizer fills it. The objects named are those of the
 * document as read under its dialects ({@link withoutUnreadVocabularies}),
 * which is the document itself unless `dialects` drops a validation keyword.
 * @param {object|boolean} schema - The schema a normalizer is compiled from
 * @param {NormalizeOptions} [options] - Its options (`useDefaults` and `dialects` decide)
 * @returns {Map<object, Set<string>>} The member names, by the schema object whose `properties` declares them
 * @throws {TypeError|SchemaCompileError} As {@link compileNormalizer} does
 */
export function unfilledDefaults(schema, options = {}) {
  const ctx = normalizerContext(schema, options);
  compileNode(ctx.document, ctx);
  settleFills(ctx);
  return ctx.unfilled;
}

/** The members of `NormalizeOptions`; any other is refused. */
const NORMALIZE_OPTIONS = Object.freeze(['useDefaults', 'removeAdditional', 'coerceTypes', 'trimStrings', 'coerceJsonText', 'dialects']);

/**
 * Refuse a malformed options object before anything compiles: every
 * switch is opt-in, so a misspelt or mistyped one would leave the
 * normalization off without a word. A host programming error, so a
 * `TypeError` naming the nearest member.
 * @param {unknown} options
 */
function admitNormalizeOptions(options) {
  if (!isPlainOptions(options)) throw new TypeError('compileNormalizer: options must be a plain object');
  refuseUnknownMembers(options, NORMALIZE_OPTIONS,
    (key, hint) => new TypeError(`compileNormalizer: unknown option '${key}'${hint}`));
  for (const name of ['useDefaults', 'coerceTypes', 'trimStrings', 'coerceJsonText']) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'boolean' && typeof value !== 'function')
      throw new TypeError(`compileNormalizer: '${name}' must be true, false or a function of the schema node`);
  }
  const strip = options.removeAdditional;
  if (strip !== undefined && typeof strip !== 'boolean' && strip !== 'all')
    throw new TypeError("compileNormalizer: 'removeAdditional' must be true, false or 'all'");
  heldDialects(options.dialects, 'compileNormalizer');
}

/**
 * Compile a JSON Schema into a normalizer: a function that returns a
 * normalized copy of its input, leaving the input untouched.
 *
 * Validation is unaffected and unchanged - normalize first, then hand the
 * result to a compiled validator:
 *
 * ```javascript
 * const normalize = compileNormalizer(schema, { useDefaults: true, trimStrings: true });
 * const validate = new JarenValidator({ collectErrors: true }).compile(schema);
 * const shaped = normalize(input);
 * const result = validate(shaped);
 * ```
 *
 * **What is normalized.** `properties`, `patternProperties`,
 * `additionalProperties`, `items`/`prefixItems`/`additionalItems`, `$ref`
 * within the document (resolved against the base of the resource holding it,
 * as the validator resolves it: {@link resolveSchemaReference}), and `allOf`
 * (composed, with stripping disabled inside it). Before draft 2019-09, and where no draft
 * is declared, a node holding a `$ref` normalizes as its target alone, as the
 * validator reads it: nothing beside the `$ref`, its `default` included. With `coerceJsonText`, a string holding
 * an object's or array's JSON text is decoded wherever such a node's `type`
 * wants that container and admits no string, at any depth, before the node's
 * other steps run on the decoded value. `allOf` branches run once, in
 * declaration order, each on the previous step's output, so a default
 * supplied by a later branch is not coerced by an earlier one; keep `type`
 * and `default` on one property schema, or list the defaulting branch first.
 * A materialized root default passes through the same normalization steps
 * as an explicitly supplied value. A property default runs through that
 * property's schema and every matching `patternProperties` schema, in the
 * same order as a supplied member, and the steps after it then shape it.
 * The validator decides each default against the schemas it meets at its
 * place: never filled where one applying there for certain refuses it (by
 * its value as the place ends up holding it, or its name), filled per
 * instance where a branch, a member count, a presence or the whole object
 * could change an answer — only where every schema applied at the place
 * answers the filled object as it answered the object without it — and
 * always else ({@link unfilledDefaults}). A document the validator cannot
 * compile alone (a `$ref` to another document) fills its defaults as
 * written.
 *
 * **Which dialect.** A `$schema` is read by its name: a URI naming a known
 * draft reads as that draft, and any other — a custom dialect — as draft-07.
 * A validator reads a custom dialect through the meta-schema it holds (one
 * extending 2020-12 reads as 2020-12); pass that validator as `dialects` to
 * read each `$schema` as its compile does.
 *
 * **What is not, and why.** `anyOf`, `oneOf`, `if`/`then`/`else` and `not`
 * are not descended: which branch applies is only known after validating,
 * and normalizing under a branch can change which branch validates. Nothing
 * arbitrary runs either - there is no transform hook, because an arbitrary
 * transform is application code, not schema semantics, and belongs on the
 * caller's side of the boundary.
 * @template [In=unknown]
 * @template [Out=In]
 * @param {object|boolean} schema - The schema to compile
 * @param {NormalizeOptions} [options] - Which normalizations to apply
 * @returns {Normalizer<In, Out>} The compiled normalizer
 * @throws {TypeError} When `options` is not a plain object, names a member
 *   outside `NormalizeOptions`, or gives one a value of the wrong type - a
 *   misspelt switch would otherwise compile a normalizer that does nothing
 *   (`dialects` that is no `JarenValidator` included)
 * @throws {SchemaCompileError} `JK0016` where a dialect `dialects` holds requires a
 *   vocabulary this package does not implement, as the validator refuses it
 * @example
 * const normalize = compileNormalizer({
 *   type: 'object',
 *   properties: {
 *     name: { type: 'string' },
 *     port: { type: 'integer', default: 8080 },
 *   },
 *   additionalProperties: false,
 * }, { useDefaults: true, removeAdditional: true, coerceTypes: true, trimStrings: true });
 *
 * const input = { name: '  jaren  ', port: '9000', stray: 1 };
 * normalize(input);  // { name: 'jaren', port: 9000 }
 * input;             // { name: '  jaren  ', port: '9000', stray: 1 } - untouched
 */
export function compileNormalizer(schema, options = {}) {
  const ctx = normalizerContext(schema, options);
  const resolved = ctx.options;
  schema = ctx.document;
  const compiled = compileNode(schema, ctx);
  settleFills(ctx);
  const step = compiled !== null && ctx.fills.reentered ? recordingCopies(ctx.fills, compiled) : compiled;

  // A root `default` answers the "the whole document was absent" case, which
  // no member walk can reach.
  const rootDefault = isJsonObject(schema) && schema.default !== undefined && !readsRefAlone(schema, null, ctx.resources.held)
    && resolveNormalizeSwitch(resolved.useDefaults, schema)
    ? schema.default
    : undefined;

  if (step === null && rootDefault === undefined)
    return function normalizeIdentity(data) { return data; };

  if (rootDefault === undefined) {
    return function normalize(data) { return step(data); };
  }
  return function normalizeWithRootDefault(data) {
    if (data === undefined) {
      const value = cloneJson(rootDefault);
      return step === null ? value : step(value);
    }
    return step === null ? data : step(data);
  };
}

//#endregion
