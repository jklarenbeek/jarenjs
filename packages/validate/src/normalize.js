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

import { parseJSONPointer } from '@jarenjs/json';
import { isJsonNumberString } from '@jarenjs/core/number';
import { isStringWhiteSpace } from '@jarenjs/core/string';
import { CC_LBRACE, CC_LBRACKET, isWhitespaceCode } from '@jarenjs/core/scan';
import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  detectSchemaDraft,
  admitsPropertyDependencies,
  readPrefixItems,
} from './schema-keywords.js';
import { createSchemaPatternTester } from './string.js';

// The validator's reading of a `pattern` string, for a consumer that checks
// one without compiling a schema (a form field, per keystroke).
export { createSchemaPatternTester };

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
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [useDefaults=false] - Materialize `default` for absent object properties, recursively
 * @property {boolean|'all'} [removeAdditional=false] - Strip unknown properties: `true` only where `additionalProperties: false`, `'all'` wherever an object shape is declared
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceTypes=false] - Convert a value to the node's declared scalar `type` when it is convertible
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [trimStrings=false] - Trim leading/trailing whitespace from strings, before coercion
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceJsonText=false] - Decode a string holding the JSON text of an object or array where the node's `type` wants that container and admits no string, then normalize the decoded value
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
 * Collect the `$anchor` declarations of one schema document: a map from
 * anchor name to the schema node that declares it. Exported because
 * `@jarenjs/emit` resolves the same references when it derives types, and two
 * walks with different scope rules would make a generated type disagree with
 * this normalizer — the one defect class that package must not have.
 *
 * The scope is the same-document scope the rest of this module uses: a
 * subtree that declares its own `$id` is an embedded resource with its own
 * anchor scope, so it is not descended. First declaration wins, which keeps
 * the map deterministic for a document that (invalidly) repeats a name.
 * @param {object|boolean} root - The root schema of the document
 * @param {{ propertyDependencies?: boolean }} [options] - `propertyDependencies: true` also walks the
 *   subschemas of the `propertyDependencies` keyword (off, it is an unknown keyword and not walked)
 * @returns {Map<string, object>} anchor name -> schema node
 */
export function collectSameDocumentAnchors(root, options = {}) {
  /** @type {Map<string, object>} */
  const anchors = new Map();
  if (!isJsonObject(root)) return anchors;
  const seen = new Set();
  /** @param {any} node @param {boolean} isRoot @param {number|null} inheritedDraft */
  const walk = (node, isRoot, inheritedDraft) => {
    if (!isJsonContainer(node) || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], false, inheritedDraft);
      return;
    }
    // The draft a document declares is inherited by everything below it.
    const draft = typeof node.$schema === 'string' ? detectSchemaDraft(node) : inheritedDraft;
    if (!isRoot && typeof node.$id === 'string') return;
    if (typeof node.$anchor === 'string' && !anchors.has(node.$anchor))
      anchors.set(node.$anchor, node);
    // Only schema positions declare anchors. Annotation values such as
    // defaults and examples are instance data, even when they contain $anchor.
    for (const key of Object.keys(node)) {
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) walk(node[key], false, draft);
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isJsonObject(node[key])) {
        for (const child of Object.values(node[key])) walk(child, false, draft);
      }
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && admitsPropertyDependencies(options.propertyDependencies, draft)
        && isJsonObject(node[key])) {
        for (const inner of Object.values(node[key])) {
          if (!isJsonObject(inner)) continue;
          for (const child of Object.values(inner)) walk(child, false, draft);
        }
      }
    }
  };
  walk(root, true, null);
  return anchors;
}

/**
 * Resolve a same-document `$ref` — `#` (or a blank reference, which names the
 * document as `#` does), `#/` followed by a JSON Pointer, or
 * `#name` for a plain `$anchor` — to the schema it addresses. URI fragment
 * escapes are decoded once, before JSON Pointer token escapes. Refs into other
 * documents are not followed: a normalizer compiles one schema, and reaching
 * a registered sibling would mean owning the whole resolution scope that
 * `compile` owns. Exported for `@jarenjs/emit`, which must resolve references
 * with exactly these rules when it derives the accepted/normalized variants.
 * @param {string} ref - The reference
 * @param {object|boolean} root - The root schema being compiled
 * @param {Map<string, object>} [anchors] - The document's anchor map, from
 *   {@link collectSameDocumentAnchors}; omit to skip anchor resolution
 * @returns {object|boolean|undefined} The addressed schema, or undefined
 */
export function resolveSameDocumentRef(ref, root, anchors) {
  return followSameDocumentRef(ref, root, anchors, undefined);
}

/**
 * {@link resolveSameDocumentRef}, collecting into `trail` every container a
 * JSON Pointer passes on the way to its target, the root first.
 * @param {string} ref
 * @param {object|boolean} root
 * @param {Map<string, object>|undefined} anchors
 * @param {unknown[]|undefined} trail
 * @returns {object|boolean|undefined}
 */
function followSameDocumentRef(ref, root, anchors, trail) {
  if (ref === '#' || isStringWhiteSpace(ref)) return root;
  if (!ref.startsWith('#')) return undefined;
  let node = root;
  let tokens;
  try {
    const fragment = decodeURIComponent(ref.slice(1));
    if (!fragment.startsWith('/'))
      return anchors === undefined ? undefined : anchors.get(fragment);
    tokens = parseJSONPointer(fragment);
  }
  catch (_e) {
    return undefined;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!isJsonContainer(node)) return undefined;
    trail?.push(node);
    node = node[tokens[i]];
  }
  return node;
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
      const step = compileNode(sub, ctx);
      propertySteps.set(key, step);
      if (step !== null) hasStep = true;
      // Keep the property's step with its default. Matching pattern steps
      // are composed below so absent and supplied members normalize alike.
      if (isJsonObject(sub) && sub.default !== undefined
        && resolveNormalizeSwitch(options.useDefaults, sub))
        defaults.push(key, sub.default, step);
    }
  }

  // Same for patterns: a pattern that matches makes a member known, whether
  // or not its subschema normalizes anything.
  const patternSteps = [];
  if (patternProperties !== null) {
    const sources = Object.getOwnPropertyNames(patternProperties);
    for (let i = 0; i < sources.length; i++) {
      const matches = createSchemaPatternTester(sources[i]);
      const step = compileNode(patternProperties[sources[i]], ctx);
      patternSteps.push(matches, step);
      if (step !== null) hasStep = true;
    }
  }

  const additionalStep = additional === undefined || typeof additional === 'boolean'
    ? null
    : compileNode(additional, ctx);

  // `true` strips only where the schema says the members are forbidden;
  // 'all' additionally strips members a declared shape simply does not
  // mention. Neither strips an object whose shape is undeclared - there,
  // every member is legitimately "additional".
  const declaresShape = properties !== null || patternProperties !== null;
  const strip = ctx.allowStrip && options.removeAdditional !== false
    && (additional === false || (options.removeAdditional === 'all' && declaresShape));

  const defaultCount = defaults.length;
  const patternCount = patternSteps.length;
  for (let i = 0; i < defaultCount; i += 3) {
    const steps = defaults[i + 2] === null ? [] : [defaults[i + 2]];
    for (let p = 0; p < patternCount; p += 2) {
      if (patternSteps[p + 1] !== null && patternSteps[p](defaults[i]))
        steps.push(patternSteps[p + 1]);
    }
    defaults[i + 2] = composeSteps(steps);
  }
  if (!hasStep && additionalStep === null && !strip && defaultCount === 0)
    return null;

  return function normalizeObject(value) {
    if (!isJsonObject(value)) return value;
    let out = value;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const current = value[key];
      let next = current;
      // JSON Schema applies EVERY applicable subschema to a member, so a
      // member covered by `properties` and by one or more `patternProperties`
      // is normalized by all of them in turn. `additionalProperties` applies
      // only when nothing else did.
      // undefined = not declared; null = declared with nothing to do.
      const named = propertySteps.get(key);
      let covered = named !== undefined;
      if (named != null) next = named(next);
      for (let p = 0; p < patternCount; p += 2) {
        if (!patternSteps[p](key)) continue;
        covered = true;
        const patternStep = patternSteps[p + 1];
        if (patternStep !== null) next = patternStep(next);
      }
      if (!covered) {
        if (strip) {
          if (out === value) out = { ...value };
          delete out[key];
          continue;
        }
        if (additionalStep !== null) next = additionalStep(next);
      }
      if (next !== current) {
        if (out === value) out = { ...value };
        setObjectMember(out, key, next);
      }
    }
    for (let i = 0; i < defaultCount; i += 3) {
      const key = defaults[i];
      if (hasOwn(value, key)) continue;
      if (out === value) out = { ...value };
      // Each instance gets its own copy: a container default shared across
      // normalized documents would let a mutation of one leak into all. The
      // copy runs through the property and every matching pattern, in the
      // same order as a supplied value.
      const step = defaults[i + 2];
      const materialized = cloneJson(defaults[i + 1]);
      setObjectMember(out, key, step === null ? materialized : step(materialized));
    }
    return out;
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

  let prefixSteps = null;
  if (Array.isArray(prefixSource)) {
    prefixSteps = new Array(prefixSource.length);
    let used = false;
    for (let i = 0; i < prefixSource.length; i++) {
      prefixSteps[i] = compileNode(prefixSource[i], ctx);
      if (prefixSteps[i] !== null) used = true;
    }
    if (!used) prefixSteps = null;
  }

  const restStep = restSource === undefined || typeof restSource === 'boolean'
    ? null
    : compileNode(restSource, ctx);

  if (prefixSteps === null && restStep === null) return null;
  // A prefix with no work still occupies its declared positions: the tail
  // schema applies only after it, even when its step table was elided.
  const prefixLength = Array.isArray(prefixSource) ? prefixSource.length : 0;

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
 * decoding it would change a valid value. Nothing decodes beside a `$ref`
 * whose siblings the validator ignores (see `compileNode`): there the
 * reference alone decides.
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
  if (ctx.jsonTextOff || !resolveNormalizeSwitch(ctx.options.coerceJsonText, node)) return null;
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
 * declared as a number.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildScalarStep(node, ctx) {
  const options = ctx.options;
  const trim = resolveNormalizeSwitch(options.trimStrings, node);
  // A union `type` gives no single conversion target, so coercion is skipped
  // rather than guessed.
  const coerceTo = resolveNormalizeSwitch(options.coerceTypes, node) && typeof node.type === 'string'
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
  // subschemas below it inherit it, as the validator reads them.
  if (typeof node.$schema === 'string') {
    const declaredDraft = detectSchemaDraft(node);
    if (declaredDraft !== ctx.declaredDraft) ctx = { ...ctx, declaredDraft };
  }

  // One node reached under two drafts (inline and as a reference target)
  // normalizes per draft.
  const memoKey = `${ctx.allowStrip}${ctx.declaredDraft}${ctx.jsonTextOff ? 'j' : ''}`;
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
  // validator ignores the keywords beside a `$ref` by default. Decoding JSON
  // text there could turn a string the reference accepts into a container it
  // refuses, so no JSON text decodes in the siblings' subtree; the reference
  // target, compiled with the incoming context, still decodes by its own type.
  const siblingCtx = ctx.options.coerceJsonText && !ctx.jsonTextOff && typeof node.$ref === 'string'
    && !(ctx.declaredDraft !== null && ctx.declaredDraft >= 2019)
    ? { ...ctx, jsonTextOff: true }
    : ctx;

  // Decoding comes first: every other step of this node, the reference and
  // the `allOf` branches included, reads the decoded container.
  const jsonTextStep = buildJsonTextStep(node, siblingCtx);
  if (jsonTextStep !== null) steps.push(jsonTextStep);

  if (typeof node.$ref === 'string') {
    const trail = [];
    const target = followSameDocumentRef(node.$ref, ctx.root, ctx.anchors, trail);
    // A ref this module cannot follow is left alone rather than guessed at;
    // validation still resolves it through the full ref machinery.
    if (target !== undefined && target !== node) {
      // The target is read in the draft its place in the document declares:
      // the nearest `$schema` on the way to it (the root's, for an anchor).
      let declaredDraft = null;
      for (const passed of trail.length === 0 ? [ctx.root] : trail) {
        if (isJsonObject(passed) && typeof passed.$schema === 'string') declaredDraft = detectSchemaDraft(passed);
      }
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
  if (Array.isArray(node.allOf)) {
    const branchCtx = siblingCtx.allowStrip ? { ...siblingCtx, allowStrip: false } : siblingCtx;
    for (let i = 0; i < node.allOf.length; i++) {
      const step = compileNode(node.allOf[i], branchCtx);
      if (step !== null) steps.push(step);
    }
  }

  const objectStep = buildObjectStep(node, siblingCtx);
  if (objectStep !== null) steps.push(objectStep);

  const arrayStep = buildArrayStep(node, siblingCtx);
  if (arrayStep !== null) steps.push(arrayStep);

  const scalarStep = buildScalarStep(node, ctx);
  if (scalarStep !== null) steps.push(scalarStep);

  built = composeSteps(steps);
  memo.set(node, built);
  // Callers that resolved this node while it was being built hold `deferred`;
  // everyone else gets the direct function.
  return built === null ? null : deferred;
}

/** The members of `NormalizeOptions`; any other is refused. */
const NORMALIZE_OPTIONS = Object.freeze(['useDefaults', 'removeAdditional', 'coerceTypes', 'trimStrings', 'coerceJsonText']);

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
 * `additionalProperties`, `items`/`prefixItems`/`additionalItems`, same-document
 * `$ref` (`#`, `#/pointer` and plain `#anchor` forms), and `allOf` (composed,
 * with stripping disabled inside it). With `coerceJsonText`, a string holding
 * an object's or array's JSON text is decoded wherever such a node's `type`
 * wants that container and admits no string, at any depth, before the node's
 * other steps run on the decoded value. `allOf` branches run once, in
 * declaration order, each on the previous step's output, so a default
 * supplied by a later branch is not coerced by an earlier one until the next
 * application; keep `type` and `default` on one property schema, or list the
 * defaulting branch first, when one application must be enough. A materialized root default passes
 * through the same normalization steps as an explicitly supplied value.
 * A property default runs through that property's schema and every matching
 * `patternProperties` schema, in the same order as a supplied member.
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
  admitNormalizeOptions(options);
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
    root: schema,
    anchors: collectSameDocumentAnchors(schema),
    /** @type {number|null} The draft the schema being compiled declares, or null when none does */
    declaredDraft: null,
    /** @type {Map<string, Map<object, Function|null>>} The compiled steps per stripping mode, draft and decoding */
    memos: new Map(),
    allowStrip: true,
    /** True below the inert siblings of a `$ref`, where no JSON text decodes */
    jsonTextOff: false,
  };

  const step = compileNode(schema, ctx);

  // A root `default` answers the "the whole document was absent" case, which
  // no member walk can reach.
  const rootDefault = isJsonObject(schema) && schema.default !== undefined
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
