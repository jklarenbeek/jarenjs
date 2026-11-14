//@ts-check
import { relaxSchema } from '@jarenjs/validate/strict-profile';

/**
 * Mechanically derive the LLM-profile twin of a canonical schema
 * artifact: the lowest-common-denominator relaxation for provider
 * structured-output subsets that do not enforce `patternProperties`,
 * `propertyNames` or asserted `format`s — and that support `anyOf` but
 * not `oneOf` (every `oneOf` becomes `anyOf`; the canonical grammar
 * discriminates its branches by the removed name constraints, so
 * exactly-one would fail on its own relaxation). The relaxation is
 * `relaxSchema`'s: each removed constraint is restated in the node's
 * `description` (the model still reads it), only schema positions are
 * rewritten, and the canonical schema remains the local-validation
 * authority. The transform is a pure RELAXATION: every canonical-valid
 * document is profile-valid; the reverse is deliberately not
 * guaranteed.
 * @param {object} schema - canonical draft 2020-12 artifact
 * @returns {object} mechanically derived LLM-profile twin
 */
export function deriveLlmProfile(schema) {
  const twin = /** @type {any} */ (relaxSchema(schema, {
    keywords: ['patternProperties', 'propertyNames', 'format'],
    note: (key, value) => (key === 'format'
      ? `(LLM profile: the '${value}' format assertion is relaxed here; the canonical schema enforces it)`
      : '(LLM profile: a member-name constraint is relaxed here; the canonical schema enforces it)'),
  }));
  twin.$id = schema.$id + '/llm-profile';
  twin.title = schema.title + ' (LLM profile)';
  twin.description = 'LLM-profile relaxation of the canonical grammar for provider '
    + 'structured-output subsets that do not enforce patternProperties, propertyNames '
    + 'or asserted formats. Every canonical-valid document validates here; the reverse '
    + 'is NOT guaranteed - always validate generated documents against the canonical '
    + 'schema locally before compiling. '
    + (schema.description ?? '');
  return twin;
}

/**
 * Mechanically derive the AUTHORING profile of a document grammar: the
 * same relaxation {@link deriveLlmProfile} performs, plus a narrowing —
 * one or more `$defs` are declared OPEN and everything reachable only
 * through them is dropped.
 *
 * The reason this exists is measured, not stylistic. An oversized
 * `response_format` degrades constrained decoding on small models to the
 * point of returning nothing; the JSLT grammar is ~19 kB because it
 * inlines the whole query expression language, and the LLM-profile twin
 * is no smaller (relaxation restates what it removes, so it GROWS).
 * Cutting at the body — the one `$ref` that pulls the expression grammar
 * in — turns the response format back into what it is good at (holding
 * the document's *shape*) and leaves meaning to the compiler, which was
 * always the authority for it. This is the same seam
 * `programSchema({ queryRef })` uses: a grammar is constrained when one
 * is injected and gated by the engine either way.
 *
 * The vocabulary the narrowing removes is not lost — it belongs in the
 * PROMPT, where {@link deriveOperatorNames} puts it, and where it costs
 * a decoder nothing.
 *
 * @param {object} schema - canonical draft 2020-12 artifact
 * Every schema node of the result declares a `type` (see
 * {@link declareEveryType}): an open node carries the JSON kinds its
 * source def admits, read through `references` for a def that points
 * into another grammar, and every JSON kind when none can be read.
 *
 * @param {{ open: Record<string, string>, references?: object[] }} options - `open`:
 *   `$defs` names to leave open, mapped to the description the open node
 *   carries; an open node has no constraint beyond its kinds. `references`:
 *   the grammars the schema's `$ref`s name by `$id`.
 * @returns {object} mechanically derived authoring twin
 */
export function deriveAuthoringProfile(schema, options) {
  const open = options?.open;
  if (open === null || typeof open !== 'object')
    throw new TypeError('deriveAuthoringProfile needs an { open } map of $defs names');
  const defs = schema.$defs ?? {};
  for (const name of Object.keys(open)) {
    if (!Object.hasOwn(defs, name))
      throw new TypeError(`deriveAuthoringProfile: no $defs.${name} to open`);
  }

  // Reachability from the root, following local $refs and stopping AT an
  // opened def — a def reachable only through the body disappears with it.
  const reached = new Set();
  const localRef = (value) => (typeof value === 'string' && value.startsWith('#/$defs/')
    ? value.slice('#/$defs/'.length)
    : null);
  function reach(node) {
    if (Array.isArray(node)) { for (const item of node) reach(item); return; }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const name = key === '$ref' ? localRef(node[key]) : null;
      if (name === null) { reach(node[key]); continue; }
      if (reached.has(name)) continue;
      reached.add(name);
      if (!Object.hasOwn(open, name)) reach(defs[name]);
    }
  }
  const root = { ...schema };
  delete root.$defs;
  reach(root);

  // An opened seam keeps the JSON kinds its source admits. In particular, opening
  // the query's object-expression branch must not turn the entire root anyOf into
  // an unconstrained schema. This is inferred from the source, never hand-copied.
  const references = new Map((options.references ?? []).map((reference) => [reference.$id, reference]));
  const kindsOfDef = (/** @type {string} */ name) => schemaKinds(defs[name], defs, references, new Set([name]));

  const twin = deriveLlmProfile({
    ...root,
    $defs: Object.fromEntries(Object.keys(defs)
      .filter((name) => reached.has(name))
      .map((name) => [name, Object.hasOwn(open, name)
        ? { type: typeValue(kindsOfDef(name) ?? JSON_KINDS), description: open[name] }
        : defs[name]])),
  });
  declareEveryType(twin, references);
  twin.$id = schema.$id + '/authoring';
  twin.title = schema.title + ' (authoring profile)';
  twin.description = 'Authoring profile of the canonical grammar: the document SHAPE only, '
    + `with ${Object.keys(open).join(', ')} left open. Constrains decoding on small models, `
    + 'where the full grammar does not decode at all. It is deliberately WEAKER than the '
    + 'canonical schema - a document valid here may be nonsense - so the engine compiler is '
    + 'the gate that makes it safe, and generated documents must be compiled before use.';
  return twin;
}

/** The JSON kinds a `type` keyword can name, `integer` aside (a `number` admits it). */
const JSON_KINDS = Object.freeze(['object', 'array', 'string', 'number', 'boolean', 'null']);

/** Keywords that hold one subschema of the same instance (it inherits the parent's kinds). */
const SAME_INSTANCE_ONE = ['not', 'if', 'then', 'else'];
/** Keywords that hold a list of subschemas of the same instance (`dependentSchemas` is a map of them). */
const SAME_INSTANCE_LIST = ['allOf', 'anyOf', 'oneOf'];
/** Keywords that hold one subschema of a member or an item. */
const MEMBER_ONE = ['items', 'contains', 'additionalProperties', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'];
/** Keywords that hold a map or a list of subschemas of members or items. */
const MEMBER_MAPS = ['properties', 'patternProperties', '$defs'];

/** The JSON kind of a value, as a `type` keyword names it. @param {unknown} value */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Kinds both sets admit, `integer` inside `number`. @param {Set<string>} a @param {Set<string>} b */
function intersectKinds(a, b) {
  const out = new Set();
  for (const kind of a) {
    if (b.has(kind)) out.add(kind);
    else if (kind === 'integer' && b.has('number')) out.add('integer');
    else if (kind === 'number' && b.has('integer')) out.add('integer');
  }
  return out;
}

/**
 * The JSON kinds a schema node admits, read from `type`, `const`, `enum`,
 * a `$ref` (local, or to one of `references` by `$id`) and the
 * `anyOf`/`oneOf`/`allOf` applicators; `null` when the node constrains no
 * kind (or the kind cannot be read, as for a reference cycle).
 * @param {any} node
 * @param {Record<string, any>} defs
 * @param {Map<string, any>} references
 * @param {Set<string>} seen
 * @returns {Set<string> | null}
 */
function schemaKinds(node, defs, references, seen) {
  if (node === false) return new Set();
  if (node === null || typeof node !== 'object') return null;
  /** @type {Set<string> | null} */
  let kinds = null;
  const narrow = (/** @type {Set<string> | null} */ other) => {
    if (other !== null) kinds = kinds === null ? other : intersectKinds(kinds, other);
  };
  if (typeof node.type === 'string') narrow(new Set([node.type]));
  else if (Array.isArray(node.type)) narrow(new Set(node.type));
  if (Object.hasOwn(node, 'const')) narrow(new Set([kindOf(node.const)]));
  if (Array.isArray(node.enum)) narrow(new Set(node.enum.map(kindOf)));
  if (typeof node.$ref === 'string') {
    const local = node.$ref.startsWith('#/$defs/') ? node.$ref.slice('#/$defs/'.length) : null;
    const key = local === null ? node.$ref : '#' + local;
    if (!seen.has(key)) {
      const target = local === null ? references.get(node.$ref) : defs[local];
      const targetDefs = local === null ? (target?.$defs ?? {}) : defs;
      narrow(schemaKinds(target, targetDefs, references, new Set([...seen, key])));
    }
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!Array.isArray(node[keyword]) || node[keyword].length === 0) continue;
    const branches = node[keyword].map((branch) => schemaKinds(branch, defs, references, seen));
    if (branches.every((branch) => branch !== null)) narrow(new Set(branches.flatMap((branch) => [...branch])));
  }
  if (Array.isArray(node.allOf)) for (const branch of node.allOf) narrow(schemaKinds(branch, defs, references, seen));
  return kinds;
}

/** A kind set as a `type` value: one name, or the list in a fixed order. @param {Iterable<string>} kinds */
function typeValue(kinds) {
  const set = new Set(kinds);
  if (set.has('number')) set.delete('integer');
  const order = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
  const list = order.filter((kind) => set.has(kind));
  return list.length === 1 ? list[0] : list;
}

/**
 * Give every schema node of a profile that pins no kind (no `type`,
 * `$ref`, `const` or `enum`) an explicit `type`: a structured-output
 * decoder may refuse a member without one ("Schema type is missing").
 * A node whose only applicator is `allOf: [{ $ref }]` carries the `$ref`
 * itself instead (the same schema in draft 2020-12, which every profile
 * declares), and an `anyOf`/`oneOf` union names its kinds through its
 * branches, each given one, and a branch's schema for a member the
 * enclosing object declares stays a narrowing of that typed member. The
 * added type never narrows what the node admits. A subschema of the
 * same instance (`allOf`/`anyOf`/`oneOf`/`not`/`if`/`then`/`else`)
 * takes the kinds its parent already asserts, and a member of a branch
 * the kinds an enclosing schema declares for that member; a node with
 * `anyOf`/`oneOf` branches takes the union of theirs; anything else
 * admits every JSON kind and says so.
 * @param {any} profile - the derived profile, given its types in place
 * @param {Map<string, any>} references - referenced grammars by `$id`
 */
function declareEveryType(profile, references) {
  const defs = profile.$defs ?? {};
  const kindsOf = (/** @type {any} */ node) => schemaKinds(node, defs, references, new Set());
  const pinned = (/** @type {any} */ node) => node.type !== undefined || typeof node.$ref === 'string'
    || Object.hasOwn(node, 'const') || Array.isArray(node.enum);
  /**
   * @param {any} node
   * @param {{ kinds: Set<string> | null, members: Map<string, Set<string> | null>, narrows?: boolean } | null} inherited
   *   - `narrows`: the node is a branch's schema for a member the enclosing
   *   object already declares (and types); it stays a narrowing, since a
   *   second typed schema for one member is what a strict profile refuses
   */
  function visit(node, inherited) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    // `allOf: [{ $ref }]` is how a draft-07-era grammar puts a description
    // beside a reference; in draft 2020-12 the `$ref` itself takes siblings,
    // so the reference pins the node's kinds where a decoder looks for them
    if (typeof node.$ref !== 'string' && Array.isArray(node.allOf) && node.allOf.length === 1
      && node.allOf[0] !== null && typeof node.allOf[0] === 'object'
      && Object.keys(node.allOf[0]).length === 1 && typeof node.allOf[0].$ref === 'string') {
      node.$ref = node.allOf[0].$ref;
      delete node.allOf;
    }
    // a union names its kinds in its branches, each of which declares one
    // (below); a type beside it would read as an object whose branches add
    // members, which a strict profile cannot carry
    const union = ['anyOf', 'oneOf'].some((keyword) => Array.isArray(node[keyword]) && node[keyword].length > 0
      && node[keyword].every((branch) => branch !== null && typeof branch === 'object' && !Array.isArray(branch)));
    if (!pinned(node) && !union && inherited?.narrows !== true) {
      const own = kindsOf(node);
      const outer = inherited?.kinds ?? null;
      const kinds = own !== null && outer !== null ? intersectKinds(own, outer) : (own ?? outer);
      node.type = typeValue(kinds !== null && kinds.size > 0 ? kinds : JSON_KINDS);
    }
    // what this node asserts about its instance and its members, for its branches
    const members = new Map(inherited?.members ?? []);
    if (node.properties !== null && typeof node.properties === 'object') {
      for (const [name, member] of Object.entries(node.properties)) {
        if (member !== null && typeof member === 'object' && pinned(member)) members.set(name, kindsOf(member));
      }
    }
    const branch = { kinds: kindsOf(node), members };
    for (const keyword of SAME_INSTANCE_ONE) visit(node[keyword], branch);
    for (const keyword of SAME_INSTANCE_LIST) {
      if (Array.isArray(node[keyword])) for (const item of node[keyword]) visit(item, branch);
    }
    if (node.dependentSchemas !== null && typeof node.dependentSchemas === 'object') {
      for (const item of Object.values(node.dependentSchemas)) visit(item, branch);
    }
    for (const keyword of MEMBER_ONE) visit(node[keyword], null);
    if (Array.isArray(node.prefixItems)) for (const item of node.prefixItems) visit(item, null);
    for (const keyword of MEMBER_MAPS) {
      if (node[keyword] === null || typeof node[keyword] !== 'object') continue;
      for (const [name, member] of Object.entries(node[keyword])) {
        const known = keyword === 'properties' ? inherited?.members.get(name) ?? null : null;
        visit(member, known === null ? null : { kinds: known, members: new Map(), narrows: true });
      }
    }
  }
  visit(profile, null);
}

/**
 * Where the JSLT grammar is cut for authoring, and what the open node
 * says instead. One member, because there is one seam: `queryDocument`
 * is the `$ref` that pulls the entire expression language into the
 * document grammar, and it is the same seam `programSchema({ queryRef })`
 * already leaves open. The description is what a decoder reads in place
 * of ~16 kB of phrase shapes; the vocabulary itself belongs in the
 * host’s prompt while local validation remains authoritative.
 */
export const JSLT_AUTHORING_OPEN = {
  queryDocument: 'A jaren-query expression: a JSONPath string starting with "$", a literal, '
    + 'or a one-member operator object such as {"$sum": "$.prices[*]"} or '
    + '{"$sub": ["$a", "$b"]}. Any JSON value decodes here; the engine compiler is the '
    + 'authority for whether it is a legal expression.',
};
