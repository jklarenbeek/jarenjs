import { JarenValidator } from '@jarenjs/validate';
import * as formats from '@jarenjs/formats';

/**
 * Compile one validator for a schema artifact. Format assertion is forced
 * on so the 'json-path' format asserts identically under both drafts (from
 * draft 2020-12 on, format is annotation-only by default).
 * @param {object} schema - a committed schema artifact (either draft)
 * @returns {Function} compiled validate(data) function
 */
export function compileArtifact(schema) {
  const compiler = new JarenValidator({ formatAssertion: true });
  compiler.addFormats(formats.jsonFormats);
  return compiler.compile(schema);
}

/**
 * Mechanically downlevel a schema authored in the repository's
 * draft-neutral subset from draft 2020-12 to draft-07.
 * @param {object} schema - canonical draft 2020-12 artifact
 * @returns {object} mechanically derived draft-07 twin
 */
export function downlevelDraft07(schema) {
  function walk(node) {
    if (Array.isArray(node))
      return node.map(walk);
    if (node === null || typeof node !== 'object')
      return node;
    const out = {};
    for (const key of Object.keys(node)) {
      if (key === 'prefixItems') {
        // 2020-12 `prefixItems` + object-form `items` (the rest) is
        // exactly draft-07 array-form `items` + `additionalItems`
        out.items = walk(node.prefixItems);
        if (Object.hasOwn(node, 'items'))
          out.additionalItems = walk(node.items);
        continue;
      }
      if (key === 'items' && Object.hasOwn(node, 'prefixItems'))
        continue; // folded into additionalItems above
      const target = key === '$defs' ? 'definitions' : key;
      const value = node[key];
      out[target] = key === '$ref' && typeof value === 'string'
        ? value.replace('#/$defs/', '#/definitions/')
        : walk(value);
    }
    return out;
  }

  const twin = walk(schema);
  twin.$schema = 'http://json-schema.org/draft-07/schema#';
  twin.$id = schema.$id + '/draft-07';
  return twin;
}

/**
 * Rewrite every same-suite `$ref` (`https://jarenjs.dev/schemas/jaren-*`)
 * to point at its draft-07 twin, so a downleveled artifact references
 * downleveled grammars. The companion to {@link downlevelDraft07} for
 * artifacts that compose other jaren schemas by `$ref` (app, fsm, dag).
 * Hoisted from two token-identical test-local copies when the third
 * consumer appeared — exactly the threshold the flow copy's comment
 * named.
 * @param {any} node
 * @returns {any}
 */
export function mapRefs(node) {
  if (Array.isArray(node)) return node.map(mapRefs);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [
    k,
    k === '$ref' && typeof v === 'string'
      && v.startsWith('https://jarenjs.dev/schemas/jaren-') && !v.endsWith('/draft-07')
      ? `${v}/draft-07`
      : mapRefs(v),
  ]));
}

/**
 * Return every violation of the repository's draft-neutral schema subset.
 * An empty result means the artifact can use the mechanical draft-07
 * transform above without changing its validation semantics.
 * @param {any} schema - schema value to inspect
 * @returns {string[]} human-readable violations with JSON-Pointer-like paths
 */
export function draftNeutralSubsetViolations(schema) {
  // `prefixItems` is allowed: with object-form `items` as the rest
  // schema it downlevels mechanically to draft-07 array-form
  // `items` + `additionalItems` with identical semantics.
  const forbiddenKeys = [
    'unevaluatedProperties', 'unevaluatedItems',
    '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor',
    'definitions',
  ];
  const violations = [];

  function walk(node, pointer) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        walk(node[i], `${pointer}/${i}`);
      return;
    }
    if (node === null || typeof node !== 'object')
      return;

    const keys = Object.keys(node);
    for (const key of forbiddenKeys) {
      if (keys.includes(key))
        violations.push(`forbidden keyword '${key}' at ${pointer}`);
    }
    if (keys.includes('$ref') && keys.length !== 1)
      violations.push(`'$ref' with siblings at ${pointer}`);
    if (keys.includes('items') && Array.isArray(node.items))
      violations.push(`array-form 'items' at ${pointer}`);

    for (const key of keys)
      walk(node[key], `${pointer}/${key}`);
  }

  walk(schema, '');
  return violations;
}

/**
 * Mechanically derive the LLM-profile twin of a canonical schema
 * artifact: the lowest-common-denominator relaxation for provider
 * structured-output subsets that do not enforce `patternProperties`,
 * `propertyNames` or asserted `format`s — and that support `anyOf` but
 * not `oneOf` (every `oneOf` becomes `anyOf`; the canonical grammar
 * discriminates its branches by the removed name constraints, so
 * exactly-one would fail on its own relaxation). Each removed
 * constraint is restated in the node's `description` (the model still
 * reads it), and the canonical schema remains the local-validation
 * authority. The transform is a pure RELAXATION: every canonical-valid
 * document is profile-valid; the reverse is deliberately not
 * guaranteed.
 * @param {object} schema - canonical draft 2020-12 artifact
 * @returns {object} mechanically derived LLM-profile twin
 */
export function deriveLlmProfile(schema) {
  function note(key, value) {
    if (key === 'format')
      return `(LLM profile: the '${value}' format assertion is relaxed here; the canonical schema enforces it)`;
    return '(LLM profile: a member-name constraint is relaxed here; the canonical schema enforces it)';
  }

  function walk(node) {
    if (Array.isArray(node))
      return node.map(walk);
    if (node === null || typeof node !== 'object')
      return node;
    const out = {};
    const notes = [];
    for (const key of Object.keys(node)) {
      if (key === 'patternProperties' || key === 'propertyNames' || key === 'format') {
        notes.push(note(key, node[key]));
        continue;
      }
      if (key === 'oneOf') {
        // exactly-one becomes at-least-one: the canonical grammar
        // discriminates its oneOf branches by the very name
        // constraints removed above, and strict provider subsets
        // (OpenAI's included) support anyOf but not oneOf
        if (Object.hasOwn(node, 'anyOf'))
          throw new TypeError('LLM-profile derivation: a node carries both oneOf and anyOf');
        out.anyOf = walk(node.oneOf);
        continue;
      }
      out[key] = walk(node[key]);
    }
    if (notes.length > 0) {
      out.description = out.description === undefined
        ? notes.join(' ')
        : `${out.description} ${notes.join(' ')}`;
    }
    return out;
  }

  const twin = walk(schema);
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
 * @param {{ open: Record<string, string> }} options - `$defs` names to
 *   leave open, mapped to the description the open node carries. An
 *   open node has NO type constraint: any JSON value decodes there.
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

  const twin = deriveLlmProfile({
    ...root,
    $defs: Object.fromEntries(Object.keys(defs)
      .filter((name) => reached.has(name))
      .map((name) => [name, Object.hasOwn(open, name)
        ? { description: open[name] }
        : defs[name]])),
  });
  twin.$id = schema.$id + '/authoring';
  twin.title = schema.title + ' (authoring profile)';
  twin.description = 'Authoring profile of the canonical grammar: the document SHAPE only, '
    + `with ${Object.keys(open).join(', ')} left open. Constrains decoding on small models, `
    + 'where the full grammar does not decode at all. It is deliberately WEAKER than the '
    + 'canonical schema - a document valid here may be nonsense - so the engine compiler is '
    + 'the gate that makes it safe, and generated documents must be compiled before use.';
  return twin;
}

/**
 * Where the JSLT grammar is cut for authoring, and what the open node
 * says instead. One member, because there is one seam: `queryDocument`
 * is the `$ref` that pulls the entire expression language into the
 * document grammar, and it is the same seam `programSchema({ queryRef })`
 * already leaves open. The description is what a decoder reads in place
 * of ~16 kB of phrase shapes; the vocabulary itself belongs in the
 * prompt (`operatorCrib` in `@jarenjs/ai/stylesheet`).
 */
export const JSLT_AUTHORING_OPEN = {
  queryDocument: 'A jaren-query expression: a JSONPath string starting with "$", a literal, '
    + 'or a one-member operator object such as {"$sum": "$.prices[*]"} or '
    + '{"$sub": ["$a", "$b"]}. Any JSON value decodes here; the engine compiler is the '
    + 'authority for whether it is a legal expression.',
};

/**
 * Every operator name a grammar closes over, in one sorted list: the
 * `propertyNames.enum` of each operator phrase. This is the vocabulary
 * {@link deriveAuthoringProfile} takes OUT of the response format, so
 * that a caller can put it in a prompt instead — names cost a decoder
 * nothing and a model cannot invent `$nearest` if it has read the list.
 * @param {object} schema - a grammar artifact (query or JSLT)
 * @returns {string[]} sorted, de-duplicated operator names
 */
export function deriveOperatorNames(schema) {
  const names = new Set();
  function walk(node) {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node === null || typeof node !== 'object') return;
    const enumerated = node.propertyNames?.enum;
    if (Array.isArray(enumerated)) {
      for (const name of enumerated) {
        if (typeof name === 'string' && name.startsWith('$')) names.add(name);
      }
    }
    for (const key of Object.keys(node)) walk(node[key]);
  }
  walk(schema);
  return [...names].sort();
}

/**
 * Derive the complete query-expression grammar used by JSLT rule bodies.
 * The copied query definitions are extended only by the body-local
 * `$apply` phrase; the published query artifacts remain unchanged. Throws
 * loudly when the pinned query-schema contract is reshaped, so a future
 * query-schema refactor breaks the artifact test instead of drifting.
 * @param {object} querySchema - canonical Jaren query schema artifact
 * @returns {object} deep-copied, `$apply`-aware definition map
 */
export function deriveJsltDefs(querySchema) {
  const defs = querySchema?.$defs;
  if (defs === null || typeof defs !== 'object' || Array.isArray(defs))
    throw new TypeError('query schema contract changed: missing object $defs');
  if (defs.expression === null || typeof defs.expression !== 'object'
    || Array.isArray(defs.expression)) {
    throw new TypeError(
      'query schema contract changed: missing $defs.expression');
  }
  const alternatives = defs.objectExpression?.oneOf;
  if (!Array.isArray(alternatives)) {
    throw new TypeError(
      'query schema contract changed: $defs.objectExpression.oneOf is not an array');
  }
  if (Object.hasOwn(defs, 'applyPhrase')) {
    throw new TypeError(
      'query schema contract changed: $defs.applyPhrase already exists');
  }

  const derived = structuredClone(defs);
  derived.applyPhrase = {
    description: "JSLT body-only $apply phrase. A non-array value is any expression except an array constructor. An array value is the argument list [selector] or [selector, mode]. The draft-neutral subset has no positional-array keyword, so the compiler remains authoritative that a two-item list's second item is a literal string (JT0007 wrapping JQ0003).",
    type: 'object',
    properties: {
      $apply: {
        oneOf: [
          {
            description: 'Bare selector form: any non-array expression.',
            oneOf: [
              { $ref: '#/$defs/scalarLiteral' },
              { $ref: '#/$defs/stringExpression' },
              { $ref: '#/$defs/objectExpression' },
            ],
          },
          {
            description: 'Argument-list form: [selector] or [selector, mode]. Items are expressions uniformly for draft neutrality; the compiler enforces the literal-string mode position.',
            type: 'array',
            items: { $ref: '#/$defs/expression' },
            minItems: 1,
            maxItems: 2,
          },
        ],
      },
    },
    required: ['$apply'],
    additionalProperties: false,
  };
  derived.objectExpression.oneOf.push({
    $ref: '#/$defs/applyPhrase',
  });
  return derived;
}

/**
 * The shoelace sum of one linear ring, as a query expression over a
 * variable `$r` bound to the ring. Positive is counter-clockwise, which
 * is the winding RFC 7946 requires of an exterior ring.
 * @returns {object} a Jaren JSON Query expression
 */
function shoelaceOfRing() {
  return {
    $fold: { s: 0 },
    $for: { i: { $range: [0, { $sub: [{ $count: '$r[*]' }, 2] }] } },
    $let: { p: { $get: ['$r', '$i'] }, q: { $get: ['$r', { $add: ['$i', 1] }] } },
    $return: {
      $add: ['$s', {
        $sub: [
          { $mul: [{ $get: ['$p', 0] }, { $get: ['$q', 1] }] },
          { $mul: [{ $get: ['$q', 0] }, { $get: ['$p', 1] }] },
        ],
      }],
    },
  };
}

/**
 * The two ring invariants, as a query expression over a variable
 * `$rings` bound to a polygon's ring array: every ring is closed, the
 * exterior ring winds counter-clockwise, and every hole winds clockwise.
 *
 * Rings are addressed by index rather than iterated, because the D4
 * rule unpacks an array item into its members — `$for`/`$every` over a
 * ring would bind positions, not the ring.
 *
 * @returns {object} a Jaren JSON Query expression
 */
function ringInvariants() {
  const ringAt = (index) => ({ $get: ['$rings', index] });
  return {
    $and: [
      {
        $every: { i: { $range: [0, { $sub: [{ $count: '$rings[*]' }, 1] }] } },
        $satisfies: {
          $let: { r: ringAt('$i') },
          $return: { $eq: [{ $get: ['$r', 0] }, { $get: ['$r', -1] }] },
        },
      },
      { $gt: [{ $let: { r: ringAt(0) }, $return: shoelaceOfRing() }, 0] },
      {
        $every: { h: { $range: [1, { $sub: [{ $count: '$rings[*]' }, 1] }] } },
        $satisfies: { $lt: [{ $let: { r: ringAt('$h') }, $return: shoelaceOfRing() }, 0] },
      },
    ],
  };
}

/**
 * Derive the Jaren-flavoured GeoJSON artifact from the portable one, by
 * attaching the `$query` assertions that plain JSON Schema provably
 * cannot express: linear-ring closure and the right-hand rule.
 *
 * The transform is a pure RESTRICTION and touches only the `polygon` and
 * `multiPolygon` definitions — every other definition is copied
 * verbatim, so the two artifacts cannot drift structurally.
 *
 * @param {object} schema - the portable geojson.schema.json
 * @returns {object} the derived artifact
 */
export function deriveGeoJsonInvariants(schema) {
  const defs = schema?.$defs;
  if (defs === null || typeof defs !== 'object' || Array.isArray(defs))
    throw new TypeError('geojson schema contract changed: missing object $defs');
  for (const name of ['polygon', 'multiPolygon']) {
    if (defs[name] === undefined)
      throw new TypeError(`geojson schema contract changed: missing $defs.${name}`);
    if (Object.hasOwn(defs[name], '$query'))
      throw new TypeError(`geojson schema contract changed: $defs.${name}.$query already exists`);
  }

  const out = structuredClone(schema);
  out.$id = 'https://jarenjs.dev/schemas/geojson-jaren';
  out.title = 'GeoJSON (RFC 7946), fully validated';
  out.description = 'GeoJSON with the two invariants plain JSON Schema cannot '
    + 'express, added through the Jaren $query keyword: every linear ring is '
    + 'closed (its first position equals its last), and rings follow the '
    + 'right-hand rule of RFC 7946 section 3.1.6 (the exterior ring winds '
    + 'counter-clockwise, holes wind clockwise). Structurally this is '
    + 'geojson.schema.json unchanged; a validator without $query support sees '
    + 'the same grammar. Winding is decided by the sign of the shoelace sum, '
    + 'and rings are addressed by index because the D4 iteration rule would '
    + 'unpack a ring into its positions.';

  // a polygon's own coordinates ARE the ring array
  out.$defs.polygon.$query = {
    $let: { rings: '$.coordinates' },
    $return: ringInvariants(),
  };
  // a multipolygon's coordinates are a list of those
  out.$defs.multiPolygon.$query = {
    $every: { p: { $range: [0, { $sub: [{ $count: '$.coordinates[*]' }, 1] }] } },
    $satisfies: {
      $let: { rings: { $get: ['$.coordinates', '$p'] } },
      $return: ringInvariants(),
    },
  };
  return out;
}
