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
