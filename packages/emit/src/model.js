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
//      omission.
//   2. **Deterministic output.** Same input, byte-identical model. Members
//      keep schema declaration order, declarations keep discovery order, and
//      nothing iterates a Set or a Map whose order depends on insertion
//      history across merges.
//
// The model is a published format (schemas/jaren-emit-model.schema.json), not
// a private intermediate: a third-party stylesheet targets it, and `emit`'s
// own TypeScript and Markdown emitters have no privileged access.

import { isJsonObject } from '@jarenjs/core/object';
import { parseJSONPointer } from '@jarenjs/json';
import { resolveNormalizeSwitch } from '@jarenjs/validate/normalize';

/** The model format version this module produces and consumes. */
export const EMIT_MODEL_VERSION = '0.1';

/** Keywords that constrain a value without narrowing its TYPE. */
const DROPPED_CONSTRAINTS = [
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'minProperties', 'maxProperties', 'propertyNames', 'dependentRequired',
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
  for (let i = 0; i < DROPPED_CONSTRAINTS.length; i++) {
    const keyword = DROPPED_CONSTRAINTS[i];
    if (node[keyword] !== undefined)
      out.push({ keyword, value: node[keyword] });
  }
  return out;
}

/**
 * Resolve a same-document `$ref` to `{ node, pointer }`, or null when it
 * addresses nothing this compiler can reach. Cross-document refs are not
 * followed: a model compiles the documents it was handed.
 */
function resolveRef(ref, root) {
  if (ref === '#') return { node: root, pointer: '#' };
  if (!ref.startsWith('#/')) return null;
  let node = root;
  let tokens;
  try {
    tokens = parseJSONPointer(ref.slice(1));
  }
  catch (_e) {
    return null;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!isJsonObject(node) && !Array.isArray(node)) return null;
    node = node[tokens[i]];
  }
  return node === undefined ? null : { node, pointer: ref };
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
    const target = resolveRef(node.$ref, ctx.root);
    if (target !== null) differs = normalizationChangesType(target.node, ctx);
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

  const nested = ['items', 'additionalItems', 'additionalProperties'];
  for (let i = 0; i < nested.length && !differs; i++) {
    const sub = node[nested[i]];
    if (Array.isArray(sub)) {
      for (let j = 0; j < sub.length && !differs; j++)
        differs = normalizationChangesType(sub[j], ctx);
    }
    else differs = normalizationChangesType(sub, ctx);
  }
  const lists = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];
  for (let i = 0; i < lists.length && !differs; i++) {
    const sub = node[lists[i]];
    if (!Array.isArray(sub)) continue;
    for (let j = 0; j < sub.length && !differs; j++)
      differs = normalizationChangesType(sub[j], ctx);
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

/** The compile context: one per `compileEmitModel` call. */
function createContext(root, options) {
  return {
    root,
    options,
    /** Normalize options, or null when no variants are being derived. */
    normalize: options.normalize ?? null,
    /** Which variant is being built: 'normalized' | 'accepted' | null. */
    variant: null,
    /** The suffix for accepted-variant declaration names. */
    suffix: options.variantSuffix ?? 'Input',
    /** @type {Map<object, boolean>} node -> normalization changes its type */
    differs: new Map(),
    /** @type {Set<object>} nodes being analyzed, for cycle detection */
    analyzing: new Set(),
    /** @type {object[]} declarations in discovery order */
    declarations: [],
    /** @type {Map<object, string>} schema node -> declaration name */
    named: new Map(),
    /** @type {Set<object>} nodes currently being built, for cycle detection */
    building: new Set(),
    /** @type {string[]} names already taken */
    taken: [],
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

  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, ctx.root);
    if (target === null) return T.unknown();
    // Name a $ref target after its pointer's last token, which is what a
    // reader of the schema calls it.
    const tokens = target.pointer === '#'
      ? ['Root']
      : parseJSONPointer(target.pointer.slice(1));
    return declare(target.node, ctx, tokens[tokens.length - 1] ?? hint);
  }

  return shapeOf(node, ctx, hint);
}

/**
 * Ensure a node has a NAMED declaration and return a ref to it. Used for
 * `$ref` targets and `$defs` members — the things a reader already thinks of
 * as types.
 */
function declare(node, ctx, hint) {
  const existing = ctx.named.get(node);
  if (existing !== undefined) return T.ref(existing);
  // `true` and `false` are whole schemas, so a boolean ROOT still deserves a
  // name — emitting nothing left a consumer importing a type that was never
  // written.
  if (typeof node === 'boolean') {
    const boolName = reserveName(ctx, hint);
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

/** The structural shape of a schema node, ignoring its `$ref`. */
function shapeOf(node, ctx, hint) {
  // const and enum are the most precise things a schema can say.
  if (node.const !== undefined) return T.literal(node.const);
  if (Array.isArray(node.enum))
    return unionOf(node.enum.map((v) => T.literal(v)));

  const parts = [];

  // allOf is intersection.
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const branches = node.allOf.map((b, i) => typeOf(b, ctx, `${hint}Part${i + 1}`));
    const usable = branches.filter((t) => t.kind !== 'unknown');
    if (usable.length === 1) parts.push(usable[0]);
    else if (usable.length > 1) parts.push(T.intersection(usable));
  }

  // anyOf and oneOf are both unions at the type level. oneOf's exclusivity
  // is a validation property with no type-level equivalent, so it widens to
  // the same union rather than being faked.
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key]) && node[key].length > 0) {
      parts.push(unionOf(node[key].map((b, i) => typeOf(b, ctx, `${hint}${toIdentifier(key)}${i + 1}`))));
    }
  }

  const own = ownShape(node, ctx, hint);
  if (own !== null) parts.push(own);

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

  // No `type`: infer from the keywords that are present.
  if (types === null) {
    if (hasObjectKeywords) return objectShape(node, ctx, hint);
    if (hasArrayKeywords) return arrayShape(node, ctx, hint);
    return null;
  }

  const alternatives = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    if (t === 'object') alternatives.push(objectShape(node, ctx, hint));
    else if (t === 'array') alternatives.push(arrayShape(node, ctx, hint));
    else if (PRIMITIVES[t] !== undefined) {
      alternatives.push(T.primitive(PRIMITIVES[t]));
      // The accepted variant also admits whatever the normalizer will convert
      // FROM, which is what makes `port: '9000'` type-check on input and
      // `port: number` type-check afterwards.
      if (ctx.variant === 'accepted' && ctx.normalize !== null
        && resolveNormalizeSwitch(ctx.normalize.coerceTypes, node)) {
        for (const from of COERCIBLE_FROM[t] ?? [])
          alternatives.push(T.primitive(PRIMITIVES[from]));
      }
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
      // A defaulted member is optional for a caller and present afterwards.
      // That asymmetry is the whole reason the two variants exist.
      const declaredRequired = required.indexOf(key) !== -1;
      const member = {
        kind: 'member',
        name: key,
        type: typeOf(sub, ctx, `${hint}${toIdentifier(key)}`),
        required: ctx.variant === 'normalized' && defaulted
          ? true
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

  return T.object(members, index);
}

/** An array or tuple type. */
function arrayShape(node, ctx, hint) {
  const prefix = Array.isArray(node.prefixItems)
    ? node.prefixItems
    : (Array.isArray(node.items) ? node.items : null);

  if (prefix !== null) {
    const items = prefix.map((s, i) => typeOf(s, ctx, `${hint}Item${i + 1}`));
    const restSource = Array.isArray(node.items) ? node.additionalItems : node.items;
    const rest = restSource === undefined || restSource === false
      ? null
      : typeOf(restSource, ctx, `${hint}Rest`);
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
 * @param {object} [options] - Compile options
 * @param {string} [options.name='Root'] - The name for the root declaration
 * @param {string} [options.source] - A source identifier recorded in the model
 * @param {'open'|'closed'} [options.openObjects='open'] - How to treat an
 *   object whose `additionalProperties` is omitted. JSON Schema says such an
 *   object is open, so the default emits an index signature. `'closed'` opts
 *   into the tighter type, which regains excess-property checking at the cost
 *   of rejecting documents the schema accepts.
 * @returns {object} The type model document
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

  /** One pass over the schema, in one variant. */
  const run = (variant, shared, taken) => {
    const ctx = createContext(schema, options);
    ctx.variant = variant;
    ctx.shared = shared;
    if (taken !== null) ctx.taken = taken;

    // `$defs`/`definitions` are declared first and in document order: they are
    // the names a reader of the schema already uses, and declaring them up
    // front keeps the emitted file's order stable and readable.
    if (isJsonObject(schema)) {
      for (const container of ['$defs', 'definitions']) {
        const defs = schema[container];
        if (!isJsonObject(defs)) continue;
        const keys = Object.getOwnPropertyNames(defs);
        for (let i = 0; i < keys.length; i++)
          declare(defs[keys[i]], ctx, keys[i]);
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
