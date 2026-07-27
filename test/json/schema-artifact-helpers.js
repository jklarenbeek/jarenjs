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
