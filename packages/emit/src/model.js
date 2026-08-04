//#region the type model
// Stage one of `@jarenjs/emit`: a JSON Schema graph in, a TYPE MODEL out.
//
// A schema graph is not shaped like a declaration file, and no template can
// fix that. `$ref`s point sideways and in cycles, subschemas nest anonymously,
// composition keywords mean intersection or union depending on which one they
// are, and half the vocabulary (`pattern`, `multipleOf`, `format`) has no
// type-level meaning at all. This module does that flattening once, into a
// plain JSON document that a stylesheet can walk top to bottom.
//
// Two rules govern every decision here:
//
//   1. **Widen honestly, never pretend.** A constraint with no type-level
//      equivalent does not disappear — it is recorded on the member as a
//      dropped constraint so the emitter can carry it into a doc comment. A
//      reader of the generated file learns that `pattern` exists and is not
//      enforced by the type; silently emitting `string` would be a lie of
//      omission. The same rule has a directional half: the generated type may
//      be WIDER than the schema (and says where), but never narrower — a type
//      that rejects a document the validator accepts is the one defect class
//      this package must not have.
//   2. **Deterministic output.** Same input, byte-identical model. Members
//      keep schema declaration order, declarations keep discovery order, and
//      nothing iterates a Set or a Map whose order depends on insertion
//      history across merges.
//
// The model is a published format (schemas/jaren-emit-model.schema.json), not
// a private intermediate: a third-party stylesheet targets it, and `emit`'s
// own TypeScript and Markdown emitters have no privileged access.

import { isJsonObject } from '@jarenjs/core/object';
import {
  NUMERIC_CONSTRAINTS, STRING_CONSTRAINTS,
  ARRAY_CONSTRAINTS, OBJECT_CONSTRAINTS,
} from '@jarenjs/core/schema';
import { parseJSONPointer } from '@jarenjs/json';
import {
  collectSameDocumentAnchors,
  resolveNormalizeSwitch,
  resolveSameDocumentRef,
} from '@jarenjs/validate/normalize';

/** The model format version this module produces and consumes. */
export const EMIT_MODEL_VERSION = '0.1';

/** @typedef {import('@jarenjs/validate/normalize').NormalizeOptions} NormalizeOptions */

/**
 * A constraint the source schema states that the emitted type cannot carry.
 * @typedef {object} EmitConstraint
 * @property {string} keyword - The schema keyword
 * @property {any} [value] - The keyword's value in the source schema
 */

/**
 * A type reference in the model. `kind` is always present and is what an
 * emitter dispatches on; the other members depend on it (EMIT-FORMAT.md §5).
 * @typedef {object} EmitTypeRef
 * @property {'unknown'|'never'|'primitive'|'literal'|'ref'|'array'|'tuple'|'optional'|'record'|'union'|'intersection'|'object'} kind
 * @property {'string'|'number'|'boolean'|'null'} [primitive] - For `primitive`
 * @property {any} [value] - The JSON value of a `literal`, or the value type of a `record`
 * @property {string} [ref] - For `ref`: the referenced declaration name
 * @property {EmitTypeRef|EmitTypeRef[]} [items] - `array` item type, or `tuple` positional items
 * @property {EmitTypeRef} [rest] - For `tuple`: the rest type, when the tuple is open
 * @property {EmitTypeRef} [item] - For `optional`: the wrapped tuple element
 * @property {EmitTypeRef[]} [options] - For `union` (at least two)
 * @property {EmitTypeRef[]} [parts] - For `intersection` (at least two)
 * @property {EmitMember[]} [members] - For `object`
 * @property {EmitTypeRef} [index] - For `object`: the index-signature value type
 */

/**
 * A declared member of an object type.
 * @typedef {object} EmitMember
 * @property {'member'} kind
 * @property {string} name - The property name, verbatim
 * @property {EmitTypeRef} type
 * @property {boolean} required
 * @property {any} [default] - The schema default, when it declares one
 * @property {EmitConstraint[]} constraints
 * @property {string[]} doc
 */

/**
 * A named declaration.
 * @typedef {object} EmitDeclaration
 * @property {'declaration'} kind
 * @property {string} name - Unique, identifier-safe
 * @property {EmitTypeRef} type
 * @property {EmitConstraint[]} constraints
 * @property {string[]} doc
 * @property {'accepted'|'normalized'} [variant] - Which side of normalization this declaration describes
 * @property {string} [variantOf] - For an accepted variant, its normalized counterpart
 */

/**
 * The type model document — the published contract every emitter reads.
 * @typedef {object} EmitModel
 * @property {string} $emit - The model format version
 * @property {string|null} source - Where the model came from
 * @property {string|null} root - The declaration name of the schema's root
 * @property {true} [variants] - Present when accepted/normalized pairs were derived
 * @property {EmitDeclaration[]} declarations
 */

/**
 * Options for {@link compileEmitModel}.
 * @typedef {object} EmitModelOptions
 * @property {string} [name='Root'] - The name for the root declaration
 * @property {string} [source] - A source identifier recorded in the model
 * @property {'open'|'closed'} [openObjects='open'] - How to treat an object
 *   whose `additionalProperties` is omitted. JSON Schema says such an object
 *   is open, so the default emits an index signature; `'closed'` opts into the
 *   tighter type, which regains excess-property checking at the cost of
 *   rejecting documents the schema accepts.
 * @property {NormalizeOptions|null} [normalize] - When set, derive
 *   accepted/normalized variant pairs with exactly these `compileNormalizer`
 *   options
 * @property {string} [variantSuffix='Input'] - The suffix for accepted-variant
 *   declaration names
 * @property {string[]} [reserved] - Declaration names already taken outside
 *   this model. Bundling concatenates models into one file, so each model
 *   must be able to avoid the names its predecessors used.
 */

/** Keywords that constrain a value without narrowing its TYPE — the
 * shared constraint groups plus the emit-specific extras. */
const DROPPED_CONSTRAINTS = [
  ...STRING_CONSTRAINTS,
  ...NUMERIC_CONSTRAINTS,
  ...ARRAY_CONSTRAINTS, 'contains', 'minContains', 'maxContains',
  ...OBJECT_CONSTRAINTS, 'propertyNames', 'dependentRequired',
  'dependentSchemas', 'dependencies', 'not',
  '$query', 'data', '$data',
];

/**
 * What a normalizer will ACCEPT for each declared scalar type, beyond the
 * type itself. This mirrors `coerceToType` in `@jarenjs/validate/normalize`:
 * if that table grows a conversion, this one has to grow the same row, or the
 * accepted variant would claim an input the normalizer cannot actually take.
 * The switch resolution itself is imported rather than reimplemented, which is
 * the half most likely to drift.
 */
const COERCIBLE_FROM = {
  string: ['number', 'boolean'],
  number: ['string'],
  integer: ['string'],
  boolean: ['string'],
  null: ['string'],
};

/** JSON Schema type names that map to a TypeScript primitive. */
const PRIMITIVES = {
  string: 'string',
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
  null: 'null',
};

/** A type reference the emitters understand. Constructors, so the shapes
 * stay in one place and the model schema has one thing to describe. */
const T = {
  unknown: () => ({ kind: 'unknown' }),
  never: () => ({ kind: 'never' }),
  primitive: (name) => ({ kind: 'primitive', primitive: name }),
  literal: (value) => ({ kind: 'literal', value }),
  ref: (name) => ({ kind: 'ref', ref: name }),
  array: (items) => ({ kind: 'array', items }),
  record: (value) => ({ kind: 'record', value }),
  optional: (item) => ({ kind: 'optional', item }),
  tuple: (items, rest) => (rest == null
    ? { kind: 'tuple', items }
    : { kind: 'tuple', items, rest }),
  union: (options) => ({ kind: 'union', options }),
  intersection: (parts) => ({ kind: 'intersection', parts }),
  object: (members, indexValue) => (indexValue == null
    ? { kind: 'object', members }
    : { kind: 'object', members, index: indexValue }),
};

/**
 * Turn an arbitrary name into a TypeScript-safe PascalCase identifier.
 * Deterministic: the same input always yields the same identifier.
 * @param {string} raw
 * @returns {string}
 */
function toIdentifier(raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_$]+/g, ' ').trim();
  if (cleaned === '') return 'Anonymous';
  const parts = cleaned.split(/\s+/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out += p.charAt(0).toUpperCase() + p.slice(1);
  }
  if (/^[0-9]/.test(out)) out = '_' + out;
  return out;
}

/**
 * The documentation lines for a node: its description, then a summary of the
 * constraints the type cannot carry. Flattening these here is stage-one work
 * — an emitter should print lines, not decide what belongs in a comment — and
 * it is what lets a template emit one comment block without a conditional.
 * @param {object} node - The schema node
 * @param {object[]} constraints - Its dropped constraints
 * @returns {string[]} Lines, empty when there is nothing to say
 */
function docLinesFor(node, constraints) {
  const lines = [];
  if (typeof node.description === 'string' && node.description !== '')
    lines.push(node.description);
  if (constraints.length > 0) {
    const stated = constraints
      .map((c) => `${c.keyword}=${JSON.stringify(c.value)}`)
      .join(', ');
    lines.push(`Schema constraints this type cannot express: ${stated}`);
  }
  return lines;
}

/** Collect the constraints this schema states that a type cannot carry. */
function droppedConstraints(node) {
  const out = [];
  // `integer` emits as `number`: integer-ness has no TypeScript equivalent,
  // so it is a dropped constraint like any other.
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.indexOf('integer') !== -1)
    out.push({ keyword: 'type', value: 'integer' });
  for (let i = 0; i < DROPPED_CONSTRAINTS.length; i++) {
    const keyword = DROPPED_CONSTRAINTS[i];
    if (node[keyword] !== undefined)
      out.push({ keyword, value: node[keyword] });
  }
  // A conditional constrains only when `if` is present — a lone `then` or
  // `else` asserts nothing, and recording it would claim a constraint that
  // does not exist.
  if (node.if !== undefined) {
    for (const keyword of ['if', 'then', 'else']) {
      if (node[keyword] !== undefined)
        out.push({ keyword, value: node[keyword] });
    }
  }
  // `unevaluated*: true` asserts nothing either.
  for (const keyword of ['unevaluatedProperties', 'unevaluatedItems']) {
    if (node[keyword] !== undefined && node[keyword] !== true)
      out.push({ keyword, value: node[keyword] });
  }
  // The index signature carries the VALUE types of patternProperties, but no
  // emitted type restricts which keys a pattern admits.
  if (isJsonObject(node.patternProperties)) {
    const patterns = Object.getOwnPropertyNames(node.patternProperties);
    if (patterns.length > 0)
      out.push({ keyword: 'patternProperties', value: patterns });
  }
  return out;
}

/**
 * Resolve a same-document `$ref` to `{ node, name }`, or null when it
 * addresses nothing this compiler can reach. The resolution itself is
 * imported from `@jarenjs/validate/normalize` so a reference resolves here
 * with exactly the rules the runtime normalizer uses — including plain
 * `#anchor` refs and the embedded-`$id` scope boundary. `name` is what a
 * reader of the schema calls the target: the pointer's last token, the
 * anchor name, or `Root`.
 */
function resolveRef(ref, ctx) {
  const node = resolveSameDocumentRef(ref, ctx.root, ctx.anchors);
  if (node === undefined) return null;
  let name = null;
  if (ref === '#') name = 'Root';
  else if (ref.startsWith('#/')) {
    const tokens = parseJSONPointer(ref.slice(1));
    name = tokens.length > 0 ? tokens[tokens.length - 1] : 'Root';
  }
  else name = ref.slice(1);
  return { node, name };
}

/** Deduplicate structurally identical type refs, preserving first-seen order. */
function dedupeTypes(types) {
  const out = [];
  const seen = [];
  for (let i = 0; i < types.length; i++) {
    const key = JSON.stringify(types[i]);
    if (seen.indexOf(key) !== -1) continue;
    seen.push(key);
    out.push(types[i]);
  }
  return out;
}

/** Flatten nested unions so `A | (B | C)` prints as `A | B | C`. */
function flattenUnion(types) {
  const out = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t.kind === 'union') out.push(...t.options);
    else out.push(t);
  }
  return out;
}

/** Build a union type ref, collapsing the degenerate cases. */
function unionOf(types) {
  const flat = dedupeTypes(flattenUnion(types.filter((t) => t.kind !== 'never')));
  if (flat.length === 0) return T.never();
  if (flat.length === 1) return flat[0];
  if (flat.some((t) => t.kind === 'unknown')) return T.unknown();
  return T.union(flat);
}

/**
 * Whether normalization changes the TYPE of this subtree.
 *
 * Only two of the four normalizations do. `useDefaults` makes a defaulted
 * member optional on input and present on output; `coerceTypes` widens what a
 * scalar accepts. `trimStrings` is string-to-string, and `removeAdditional`
 * removes members the type never declared — neither changes a declared type,
 * so neither justifies a second declaration.
 *
 * The walk descends exactly what `compileNormalizer` descends — `$ref`,
 * `allOf`, the object keywords, and the tuple spelling the normalizer would
 * read — and deliberately NOT `anyOf`/`oneOf`, because the normalizer does
 * not descend union branches. A default that exists only under a union branch
 * is never materialized at runtime, so it must not earn a twin here: this
 * analysis answering differently from the runtime is precisely the defect the
 * variants exist to rule out.
 *
 * Computed bottom-up and memoized, because a type differs if anything it
 * contains differs. A node reached while it is still being analyzed is a
 * cycle, and a cycle alone introduces no difference, so it answers `false`.
 * @param {any} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {boolean}
 */
function normalizationChangesType(node, ctx) {
  const options = ctx.normalize;
  if (options === null || !isJsonObject(node)) return false;

  const memo = ctx.differs;
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  if (ctx.analyzing.has(node)) return false;
  ctx.analyzing.add(node);

  let differs = false;

  if (typeof node.$ref === 'string') {
    const target = resolveSameDocumentRef(node.$ref, ctx.root, ctx.anchors);
    if (target !== undefined && target !== node)
      differs = normalizationChangesType(target, ctx);
  }

  if (!differs && typeof node.type === 'string'
    && COERCIBLE_FROM[node.type] !== undefined
    && resolveNormalizeSwitch(options.coerceTypes, node)) {
    differs = true;
  }

  const properties = isJsonObject(node.properties) ? node.properties : null;
  if (!differs && properties !== null) {
    const keys = Object.getOwnPropertyNames(properties);
    for (let i = 0; i < keys.length && !differs; i++) {
      const sub = properties[keys[i]];
      if (isJsonObject(sub) && sub.default !== undefined
        && resolveNormalizeSwitch(options.useDefaults, sub)) {
        differs = true;
        break;
      }
      differs = normalizationChangesType(sub, ctx);
    }
  }

  // The array walk mirrors buildArrayStep: the tuple spelling decides which
  // keywords the normalizer reads, so it decides which ones this reads.
  if (!differs) {
    const itemsIsTuple = Array.isArray(node.items);
    const prefixSource = itemsIsTuple ? node.items : node.prefixItems;
    const restSource = itemsIsTuple ? node.additionalItems : node.items;
    if (Array.isArray(prefixSource)) {
      for (let i = 0; i < prefixSource.length && !differs; i++)
        differs = normalizationChangesType(prefixSource[i], ctx);
    }
    if (!differs && !Array.isArray(restSource))
      differs = normalizationChangesType(restSource, ctx);
  }

  if (!differs)
    differs = normalizationChangesType(node.additionalProperties, ctx);

  if (!differs && Array.isArray(node.allOf)) {
    for (let i = 0; i < node.allOf.length && !differs; i++)
      differs = normalizationChangesType(node.allOf[i], ctx);
  }

  if (!differs && isJsonObject(node.patternProperties)) {
    const keys = Object.getOwnPropertyNames(node.patternProperties);
    for (let i = 0; i < keys.length && !differs; i++)
      differs = normalizationChangesType(node.patternProperties[keys[i]], ctx);
  }

  ctx.analyzing.delete(node);
  memo.set(node, differs);
  return differs;
}

/** The compile context: one per pass of `compileEmitModel`. */
function createContext(root, options, shared) {
  return {
    root,
    options,
    /** Normalize options, or null when no variants are being derived. */
    normalize: options.normalize ?? null,
    /** Which variant is being built: 'normalized' | 'accepted' | null. */
    variant: null,
    /** The suffix for accepted-variant declaration names. */
    suffix: options.variantSuffix ?? 'Input',
    /** @type {Map<string, object>} the document's $anchor declarations */
    anchors: shared.anchors,
    /** @type {Map<object, boolean>} node -> normalization changes its type */
    differs: shared.differs,
    /** @type {Set<object>} nodes being analyzed, for cycle detection */
    analyzing: shared.analyzing,
    /** @type {object[]} declarations in discovery order */
    declarations: [],
    /** @type {Map<object|boolean, string>} schema node -> declaration name */
    named: new Map(),
    /** @type {Set<object>} nodes currently being built, for cycle detection */
    building: new Set(),
    /** @type {string[]} names already taken */
    taken: [],
    /** The plain universe's name state, shared across passes (see below). */
    plainNamed: shared.plainNamed,
    plainBuilding: shared.plainBuilding,
    /** @type {object|null} this pass's plain universe, created on demand */
    plain: null,
    /** @type {object|undefined} set on a PLAIN context: the pass it belongs to */
    plainOf: undefined,
  };
}

/**
 * The PLAIN universe: compilation with normalization inert.
 *
 * `anyOf`/`oneOf` branches compile here when variants are being derived,
 * because `compileNormalizer` does not descend union branches — a default
 * under one is never materialized and a coercion never applies there. A
 * branch that referenced the normalized declaration would require output the
 * runtime never produces, and one that referenced the accepted twin would
 * promise coercions that never run; both disagree with the runtime, so the
 * branch gets the schema's as-declared reading instead. A node whose type
 * normalization does not change reads identically in every universe and
 * shares the main declaration; one that differs gains a `Plain`-suffixed
 * declaration, shared by both passes since it is variant-less by
 * construction.
 * @param {object} ctx - The pass context this universe belongs to
 * @returns {object} The plain compile context
 */
function createPlainContext(ctx) {
  return {
    root: ctx.root,
    options: ctx.options,
    normalize: null,
    variant: null,
    suffix: ctx.suffix,
    anchors: ctx.anchors,
    differs: ctx.differs,
    analyzing: ctx.analyzing,
    // Same array: plain declarations are emitted in discovery order among
    // the pass's own, and one name space covers both.
    declarations: ctx.declarations,
    named: ctx.plainNamed,
    building: ctx.plainBuilding,
    taken: ctx.taken,
    plainNamed: ctx.plainNamed,
    plainBuilding: ctx.plainBuilding,
    plain: null,
    plainOf: ctx,
  };
}

/** Reserve a unique declaration name. */
function reserveName(ctx, preferred) {
  const base = toIdentifier(preferred);
  let name = base;
  let n = 2;
  while (ctx.taken.indexOf(name) !== -1) {
    name = `${base}${n}`;
    n++;
  }
  ctx.taken.push(name);
  return name;
}

/**
 * Compile a schema node into a type ref, declaring it by name when it is a
 * named or cyclic node.
 * @param {any} node - The schema node
 * @param {object} ctx - The compile context
 * @param {string} hint - A name to use if this node has to be hoisted
 * @returns {object} A type ref
 */
function typeOf(node, ctx, hint) {
  if (node === true || node === undefined) return T.unknown();
  if (node === false) return T.never();
  if (!isJsonObject(node)) return T.unknown();

  // Already declared: refer to it by name.
  const existing = ctx.named.get(node);
  if (existing !== undefined) return T.ref(existing);

  // A node reached while it is still being built is a cycle. Hoisting it to
  // a declaration is what breaks the recursion: the reference is by name,
  // and the declaration is completed by the frame already building it.
  if (ctx.building.has(node)) {
    const name = reserveName(ctx, hint);
    ctx.named.set(node, name);
    return T.ref(name);
  }

  return shapeOf(node, ctx, hint);
}

/**
 * Ensure a node has a NAMED declaration and return a ref to it. Used for
 * `$ref` targets and `$defs` members — the things a reader already thinks of
 * as types.
 * @param {any} node - The schema node
 * @param {object} ctx - The compile context
 * @param {string} hint - The preferred declaration name
 * @param {boolean} [forceOwn] - Emit a declaration under this hint even when
 *   an equal boolean schema already has one — the `$defs` loop uses this so
 *   every name a reader can import exists
 * @returns {object} A `ref` type ref
 */
function declare(node, ctx, hint, forceOwn = false) {
  // In the plain universe, a node whose type normalization does not change
  // reads identically everywhere, so it shares the main declaration rather
  // than gaining a twin.
  if (ctx.plainOf !== undefined) {
    if (!isJsonObject(node) || !normalizationChangesType(node, ctx.plainOf))
      return declare(node, ctx.plainOf, hint, forceOwn);
    hint = `${hint}Plain`;
  }

  const existing = ctx.named.get(node);
  if (existing !== undefined && !forceOwn) return T.ref(existing);

  // `true` and `false` are whole schemas, so a boolean ROOT or def still
  // deserves a name — emitting nothing left a consumer importing a type that
  // was never written. Booleans memoize by VALUE (every `true` schema is the
  // same schema), which is also what stops a second reference or a second
  // pass from emitting a duplicate declaration.
  if (typeof node === 'boolean') {
    // Normalization cannot change a boolean schema, so the accepted pass
    // reuses pass one's declaration instead of emitting a twin.
    if (ctx.variant === 'accepted') {
      const shared = ctx.shared.get(node);
      if (shared !== undefined) return T.ref(shared);
    }
    const boolName = reserveName(ctx, hint);
    if (existing === undefined) ctx.named.set(node, boolName);
    ctx.declarations.push({
      kind: 'declaration', name: boolName,
      type: node === true ? T.unknown() : T.never(),
      constraints: [], doc: [],
    });
    return T.ref(boolName);
  }
  if (!isJsonObject(node)) return typeOf(node, ctx, hint);

  // In the accepted pass, only a node whose type actually changes earns its
  // own declaration; everything else refers to the single shared one, so a
  // schema with one defaulted field does not double every type in the file.
  if (ctx.variant === 'accepted' && !normalizationChangesType(node, ctx)) {
    const shared = ctx.shared.get(node);
    if (shared !== undefined) return T.ref(shared);
  }

  const name = reserveName(ctx,
    ctx.variant === 'accepted' ? `${hint}${ctx.suffix}` : hint);
  ctx.named.set(node, name);
  ctx.building.add(node);
  const constraints = droppedConstraints(node);
  const doc = docLinesFor(node, constraints);
  if (ctx.variant === 'accepted') {
    doc.push(`Accepted input for ${ctx.shared.get(node) ?? hint}: the shape before `
      + 'normalization, where defaulted members may be absent and coercible '
      + 'values may still be in their transport form.');
  }
  if (ctx.plainOf !== undefined) {
    doc.push('The declared shape of this schema where normalization does not '
      + 'reach: inside anyOf/oneOf branches the normalizer neither '
      + 'materializes defaults nor coerces.');
  }
  const declaration = {
    kind: 'declaration',
    name,
    type: shapeOf(node, ctx, hint),
    constraints,
    doc,
  };
  if (ctx.variant !== null) declaration.variant = ctx.variant;
  if (ctx.variant === 'accepted') {
    const of = ctx.shared.get(node);
    if (of !== undefined) declaration.variantOf = of;
  }
  ctx.building.delete(node);
  ctx.declarations.push(declaration);
  return T.ref(name);
}

/**
 * Which coercion SOURCE primitives can reach at least one of `values`, for a
 * literal (`const`/`enum`) node. Mirrors `coerceToType`: a source is admitted
 * only when some value of it actually converts to a member of the literal
 * set, so an integer enum widens by `string` (`"2"` normalizes to `2`) while
 * a string enum of words does not widen by `number` at all.
 *
 * Gated exactly as `buildScalarStep` gates coercion: the accepted variant,
 * a single string-valued `type`, and the same resolved switch.
 * @param {object} node - The schema node carrying the literal
 * @param {any[]} values - The literal values
 * @param {object} ctx - The compile context
 * @returns {string[]} JSON Schema type names to widen by
 */
function coercionSources(node, values, ctx) {
  if (ctx.variant !== 'accepted' || ctx.normalize === null) return [];
  if (typeof node.type !== 'string') return [];
  if (!resolveNormalizeSwitch(ctx.normalize.coerceTypes, node)) return [];
  const from = COERCIBLE_FROM[node.type];
  if (from === undefined) return [];
  const out = [];
  for (const source of from) {
    if (values.some((v) => coercionCanProduce(source, node.type, v)))
      out.push(source);
  }
  return out;
}

/** Whether `coerceToType` can turn SOME value of `source` type into `value`. */
function coercionCanProduce(source, type, value) {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'string': {
      if (typeof value !== 'string') return false;
      if (source === 'boolean') return value === 'true' || value === 'false';
      const num = Number(value);
      return Number.isFinite(num) && String(num) === value;
    }
    default:
      return false;
  }
}

/** The structural shape of a schema node. */
function shapeOf(node, ctx, hint) {
  const parts = [];

  // `$ref` composes with its siblings: since 2019-09 the other keywords
  // apply ALONGSIDE the reference, so the target is one intersection part
  // rather than a substitute for the node — ignoring the siblings emitted a
  // type wider than the schema in one place and narrower in another. A bare
  // `$ref` with nothing else collapses to a plain alias below, and an
  // unresolvable one contributes nothing, leaving the node honestly wider.
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, ctx);
    // A ref that resolves to the node itself asserts nothing — and spelled
    // out it would be a circular alias, which is not a type.
    if (target !== null && target.node !== node)
      parts.push(declare(target.node, ctx, target.name ?? hint));
  }

  // const and enum are the most precise things a schema can say. On the
  // accepted side the literal set still admits what the normalizer coerces
  // INTO a member — `"2"` for an integer enum — so it widens by the source
  // primitives that can actually reach one.
  if (node.const !== undefined || Array.isArray(node.enum)) {
    const values = node.const !== undefined ? [node.const] : node.enum;
    const literals = values.map((v) => T.literal(v));
    for (const source of coercionSources(node, values, ctx))
      literals.push(T.primitive(PRIMITIVES[source]));
    parts.push(unionOf(literals));
  }
  else {
    // allOf is intersection.
    if (Array.isArray(node.allOf) && node.allOf.length > 0) {
      const branches = node.allOf.map((b, i) => typeOf(b, ctx, `${hint}Part${i + 1}`));
      const usable = branches.filter((t) => t.kind !== 'unknown');
      if (usable.length === 1) parts.push(usable[0]);
      else if (usable.length > 1) parts.push(T.intersection(usable));
    }

    // anyOf and oneOf are both unions at the type level. oneOf's exclusivity
    // is a validation property with no type-level equivalent, so it widens to
    // the same union rather than being faked. When variants are being
    // derived, branches compile in the PLAIN universe: the runtime
    // normalizer does not descend them (see createPlainContext).
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(node[key]) && node[key].length > 0) {
        const branchCtx = ctx.normalize === null
          ? ctx
          : (ctx.plain ??= createPlainContext(ctx));
        parts.push(unionOf(node[key].map((b, i) =>
          typeOf(b, branchCtx, `${hint}${toIdentifier(key)}${i + 1}`))));
      }
    }

    const own = ownShape(node, ctx, hint);
    if (own !== null) parts.push(own);
  }

  if (parts.length === 0) return T.unknown();
  if (parts.length === 1) return parts[0];
  return T.intersection(parts);
}

/** The shape from this node's own type/properties/items keywords. */
function ownShape(node, ctx, hint) {
  const declared = node.type;
  const types = Array.isArray(declared)
    ? declared
    : (typeof declared === 'string' ? [declared] : null);

  const hasObjectKeywords = node.properties !== undefined
    || node.patternProperties !== undefined
    || node.additionalProperties !== undefined;
  const hasArrayKeywords = node.items !== undefined || node.prefixItems !== undefined;

  // No `type`: the applicator keywords describe the container cases, but
  // they do not IMPLY them — `properties` applies only when the value
  // happens to be an object, and the validator accepts a primitive without
  // reading it. Inferring `object` here emitted a type NARROWER than the
  // schema, so the described shape is one union arm and every other JSON
  // kind honestly fills in the rest.
  if (types === null) {
    if (!hasObjectKeywords && !hasArrayKeywords) return null;
    const arms = [];
    if (hasObjectKeywords) arms.push(objectShape(node, ctx, hint));
    if (hasArrayKeywords) arms.push(arrayShape(node, ctx, hint));
    if (!hasObjectKeywords) arms.push(T.record(T.unknown()));
    if (!hasArrayKeywords) arms.push(T.array(T.unknown()));
    arms.push(T.primitive('string'), T.primitive('number'),
      T.primitive('boolean'), T.primitive('null'));
    return unionOf(arms);
  }

  // The accepted variant also admits whatever the normalizer will convert
  // FROM, which is what makes `port: '9000'` type-check on input and
  // `port: number` type-check afterwards. The gate mirrors `buildScalarStep`
  // exactly: coercion runs only for a single string-valued `type`, so a
  // union type widens nothing.
  const coerceFrom = ctx.variant === 'accepted' && ctx.normalize !== null
    && typeof declared === 'string'
    && resolveNormalizeSwitch(ctx.normalize.coerceTypes, node)
    ? COERCIBLE_FROM[declared] ?? []
    : [];

  const alternatives = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === 'object') alternatives.push(objectShape(node, ctx, hint));
    else if (t === 'array') alternatives.push(arrayShape(node, ctx, hint));
    else if (PRIMITIVES[t] !== undefined) {
      alternatives.push(T.primitive(PRIMITIVES[t]));
      for (const from of coerceFrom)
        alternatives.push(T.primitive(PRIMITIVES[from]));
    }
    else alternatives.push(T.unknown());
  }
  return unionOf(alternatives);
}

/** An object type: declared members plus an optional index signature. */
function objectShape(node, ctx, hint) {
  const properties = isJsonObject(node.properties) ? node.properties : null;
  const required = Array.isArray(node.required) ? node.required : [];
  const members = [];

  if (properties !== null) {
    const keys = Object.getOwnPropertyNames(properties);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const sub = properties[key];
      const subNode = isJsonObject(sub) ? sub : {};
      const constraints = droppedConstraints(subNode);
      const defaulted = subNode.default !== undefined && ctx.normalize !== null
        && resolveNormalizeSwitch(ctx.normalize.useDefaults, subNode);
      // A defaulted member is optional for a caller — even when `required`
      // lists it, because the normalizer materializes it before validation
      // runs — and present afterwards. That asymmetry is the whole reason
      // the two variants exist.
      const declaredRequired = required.indexOf(key) !== -1;
      const member = {
        kind: 'member',
        name: key,
        type: typeOf(sub, ctx, `${hint}${toIdentifier(key)}`),
        required: defaulted
          ? ctx.variant !== 'accepted'
          : declaredRequired,
        constraints,
        doc: docLinesFor(subNode, constraints),
      };
      if (subNode.default !== undefined) member.default = subNode.default;
      members.push(member);
    }
  }

  // An index signature comes from additionalProperties or patternProperties.
  // `additionalProperties: false` is the closed case and adds nothing; `true`
  // or a schema opens the object up.
  let index = null;
  const additional = node.additionalProperties;
  if (additional !== undefined && additional !== false)
    index = typeOf(additional, ctx, `${hint}Additional`);
  else if (additional === undefined && ctx.options.openObjects !== 'closed') {
    // JSON Schema objects are OPEN unless they say otherwise. Emitting a
    // closed interface makes the type NARROWER than the schema, so it rejects
    // a document the validator accepts — the one direction this generator
    // promises never to take. `openObjects: 'closed'` opts into the tighter,
    // unsound type for a consumer who prefers excess-property checking.
    index = T.unknown();
  }
  else if (isJsonObject(node.patternProperties)) {
    const patterns = Object.getOwnPropertyNames(node.patternProperties);
    if (patterns.length > 0) {
      index = unionOf(patterns.map((p, i) =>
        typeOf(node.patternProperties[p], ctx, `${hint}Pattern${i + 1}`)));
    }
  }

  // TypeScript requires an index signature to cover every declared member,
  // so widen it to include their types rather than emitting something that
  // will not compile.
  if (index !== null && members.length > 0)
    index = unionOf([index, ...members.map((m) => m.type)]);

  // A closed object with NO members is `Record<string, never>`: an empty
  // interface is TypeScript's weak-type escape hatch — a primitive satisfies
  // it — so it would certify data the validator rejects.
  if (members.length === 0 && index === null) return T.record(T.never());

  return T.object(members, index);
}

/** An array or tuple type. */
function arrayShape(node, ctx, hint) {
  const itemsIsTuple = Array.isArray(node.items);
  const prefixSource = itemsIsTuple
    ? node.items
    : (Array.isArray(node.prefixItems) ? node.prefixItems : null);

  if (prefixSource !== null) {
    // JSON Schema tuples are not fixed-length: `prefixItems` constrains the
    // positions that exist, `minItems` says how many must exist, and an
    // omitted rest schema leaves the array OPEN. Emitting every position
    // required and the tuple closed rejected arrays the validator accepts.
    const restSource = itemsIsTuple ? node.additionalItems : node.items;
    const rest = restSource === false
      ? null
      : restSource === undefined || restSource === true
        ? T.unknown()
        : typeOf(restSource, ctx, `${hint}Rest`);
    const requiredCount = Math.min(
      typeof node.minItems === 'number' ? node.minItems : 0,
      prefixSource.length);
    const items = prefixSource.map((s, i) => {
      const itemType = typeOf(s, ctx, `${hint}Item${i + 1}`);
      return i < requiredCount ? itemType : T.optional(itemType);
    });
    // The degenerate tuple collapses (EMIT-FORMAT §5): no positional items
    // with a rest type is just an array — and `[, ...T[]]` is not TypeScript.
    if (items.length === 0) return rest === null ? T.tuple(items) : T.array(rest);
    return T.tuple(items, rest);
  }

  if (node.items === undefined) return T.array(T.unknown());
  return T.array(typeOf(node.items, ctx, `${hint}Item`));
}

/**
 * Compile one or more JSON Schemas into a type model.
 *
 * The model is a plain JSON document. It is the contract every emitter reads,
 * and it is published as a schema so a third-party emitter can target it too.
 * @param {object|boolean} schema - The root schema
 * @param {EmitModelOptions} [options] - Compile options
 * @returns {EmitModel} The type model document
 * @example
 * const model = compileEmitModel({
 *   $defs: { Id: { type: 'string' } },
 *   type: 'object',
 *   properties: { id: { $ref: '#/$defs/Id' } },
 *   required: ['id'],
 * }, { name: 'User' });
 */
export function compileEmitModel(schema, options = {}) {
  const name = options.name ?? 'Root';
  const normalize = options.normalize ?? null;

  // State shared across the two passes: the anchor map, the normalization
  // analysis memos, and the PLAIN universe's names — plain declarations are
  // variant-less by construction, so one set serves both sides.
  const shared = {
    anchors: collectSameDocumentAnchors(schema),
    differs: new Map(),
    analyzing: new Set(),
    plainNamed: new Map(),
    plainBuilding: new Set(),
  };

  /** One pass over the schema, in one variant. */
  const run = (variant, sharedNames, taken) => {
    const ctx = createContext(schema, options, shared);
    ctx.variant = variant;
    ctx.shared = sharedNames;
    ctx.taken = taken
      ?? (Array.isArray(options.reserved) ? options.reserved.slice() : []);

    // `$defs`/`definitions` are declared first and in document order: they are
    // the names a reader of the schema already uses, and declaring them up
    // front keeps the emitted file's order stable and readable.
    if (isJsonObject(schema)) {
      for (const container of ['$defs', 'definitions']) {
        const defs = schema[container];
        if (!isJsonObject(defs)) continue;
        const keys = Object.getOwnPropertyNames(defs);
        for (let i = 0; i < keys.length; i++) {
          // forceOwn for a boolean def: two `true` defs are the same schema
          // VALUE, but each name a reader can import must exist.
          declare(defs[keys[i]], ctx, keys[i],
            typeof defs[keys[i]] === 'boolean');
        }
      }
    }
    declare(schema, ctx, name);
    return ctx;
  };

  // Pass one is the schema's own shape, which is also the NORMALIZED shape
  // when normalization is configured: normalizing is what produces it.
  const base = run(normalize === null ? null : 'normalized', new Map(), null);
  const declarations = base.declarations;

  // Pass two derives the ACCEPTED shape — what a caller may hand in before
  // normalization. It reuses pass one's names for everything normalization
  // does not change, so only the types that genuinely differ gain a twin.
  if (normalize !== null) {
    const accepted = run('accepted', base.named, base.taken);
    declarations.push(...accepted.declarations);
  }

  const model = {
    $emit: EMIT_MODEL_VERSION,
    source: options.source ?? null,
    root: base.named.get(schema) ?? name,
    declarations,
  };
  if (normalize !== null) model.variants = true;
  return model;
}

//#endregion
