//@ts-check
/**
 * @file The shapes the validator admits keyword values in are the draft
 * meta-schemas' shapes. Each keyword's subschema in the meta-schemas
 * `@jarenjs/refs` ships (draft-06, draft-07, 2019-09 and 2020-12, every
 * vocabulary) is reduced to the name of its shape, and the runtime table
 * (`KEYWORD_SHAPES`) must name the same shape in every draft that defines
 * the keyword, but where a listed reading differs, most because the narrower
 * shape would refuse a schema that answers right (inside a shape, a number written
 * as a string and a bigint are read as numbers, a `RegExp` as a pattern and
 * `required: true` as presence; see `keyword-values.js`). The table lives in the
 * validator rather than being read from `@jarenjs/refs` at run time: the
 * validator does not depend on the meta-schema bundle, and a browser
 * bundle should not carry it to check a few dozen keywords. Every keyword
 * a meta-schema defines is either in the table or listed below as not
 * admitted, with the reason; a draft that adds a keyword fails here until
 * it is placed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSchemaDraftByVersion } from '@jarenjs/refs';
import { KEYWORD_SHAPES, VALIDATION_KEYWORDS } from '../../packages/validate/src/keyword-values.js';

/** The keywords whose values the validator does not admit, and why. */
const NOT_ADMITTED = {
  $id: 'an identifier: validation reads no value of it; a reference to what it fails to name is JK0009',
  $schema: 'an identifier of the dialect: a value that names none is read as no draft',
  $anchor: 'an identifier', $dynamicAnchor: 'an identifier', $recursiveAnchor: 'an identifier',
  $vocabulary: 'read only in a meta-schema, by the dialect reading',
  $comment: 'an annotation', title: 'an annotation', description: 'an annotation', default: 'an annotation',
  examples: 'an annotation', readOnly: 'an annotation', writeOnly: 'an annotation', deprecated: 'an annotation',
  $defs: 'storage: a reference into a malformed one is JK0009 where it is followed',
  definitions: 'storage, as $defs',
  format: "a value that names no format is ignored, as the specification reads an unknown format (refused JK0015 by the format compiler under unknownFormats: 'error')",
  contentEncoding: 'content keywords: an encoding that names none is an annotation',
  contentMediaType: 'content keywords: a media type that names none is an annotation',
  contentSchema: 'content keywords: applied by no validation',
  const: 'takes any value',
};

/**
 * Where the runtime reading differs from a draft's meta-schema, and why:
 * [keyword, meta-schema shape, runtime shape, drafts, reason]. All but one
 * are wider, each because the narrower shape answered right.
 */
const READINGS = /** @type {[string, string, string, number[], string][]} */ ([
  ['allOf', 'schemaArray+', 'schemaArray', [6, 7, 2019, 2020], 'an empty allOf accepts every value, as an empty conjunction does'],
  ['prefixItems', 'schemaArray+', 'schemaArray', [2020], 'an empty prefixItems constrains no item'],
  ['items', 'schema', 'schema|schemaArray', [2020], 'an items array under 2020-12 applies as the tuple form'],
  ['enum', 'array+', 'array', [6, 7], 'an empty enum admits no value'],
  ['exclusiveMinimum', 'number', 'number|boolean', [6, 7, 2019, 2020], 'the boolean draft-04 form beside minimum'],
  ['exclusiveMaximum', 'number', 'number|boolean', [6, 7, 2019, 2020], 'the boolean draft-04 form beside maximum'],
  ['patternProperties', 'map<schema>', 'map<schema>/regex', [6], 'draft-06 says the names are regular expressions in its prose; one that does not compile crashed'],
]);

/**
 * The keywords each draft's meta-schemas define, each reduced to its shape.
 * @param {6|7|2019|2020} version
 * @returns {Map<string, string>}
 */
function derivedShapes(version) {
  const documents = getSchemaDraftByVersion(version).schema;
  /** @param {string} ref @param {any} document */
  const resolve = (ref, document) => {
    const [uri, pointer] = ref.split('#');
    const holder = uri === '' ? document : documents.find((d) => d.$id.endsWith(uri));
    return pointer.split('/').slice(1).reduce((node, key) => node[key], holder);
  };
  /** @param {any} node @param {any} document @returns {string} */
  const shape = (node, document) => {
    if (node === true || (typeof node === 'object' && Object.keys(node).every((k) => k === 'default' || k === '$comment' || k === 'deprecated')))
      return 'any';
    if (node.$ref === '#' || node.$dynamicRef === '#meta' || node.$recursiveRef === '#') return 'schema';
    if (node.$ref !== undefined) return shape(resolve(node.$ref, document), document);
    if (node.allOf !== undefined) return node.allOf.map((n) => shape(n, document)).filter((s) => s !== 'any').join('&');
    if (node.anyOf !== undefined) return node.anyOf.map((n) => shape(n, document)).join('|');
    if (Array.isArray(node.enum) && node.enum.includes('integer')) return 'typeName';
    switch (node.type) {
      case 'integer': return node.minimum === 0 ? 'count' : 'integer';
      case 'number': return node.exclusiveMinimum === 0 ? 'positive' : 'number';
      case 'boolean': return 'boolean';
      case 'string': return node.format === 'regex' ? 'regex' : 'string';
      case 'object': {
        if (node.additionalProperties === undefined) return 'object';
        const member = shape(node.additionalProperties, document);
        return node.propertyNames?.format === 'regex' ? `map<${member}>/regex` : `map<${member}>`;
      }
      case 'array': {
        const items = node.items === undefined || node.items === true || (typeof node.items === 'object' && Object.keys(node.items).length === 0) ? 'any' : shape(node.items, document);
        const plus = node.minItems === 1 ? '+' : '';
        if (items === 'schema') return `schemaArray${plus}`;
        if (items === 'string') return 'stringArray';
        if (items === 'typeName') return `typeName[]${plus}`;
        return `array${plus}`;
      }
    }
    throw new Error(`no shape for ${JSON.stringify(node)}`);
  };
  const shapes = new Map();
  for (const document of documents) {
    for (const [keyword, node] of Object.entries(document.properties ?? {})) shapes.set(keyword, shape(node, document));
  }
  return shapes;
}

/** The meta-schema shape names, as the runtime table spells them. */
const SPELLED = /** @type {Record<string, string>} */ ({
  'typeName|typeName[]+': 'type',
  'schema|schemaArray+': 'schema|schemaArray',
  'map<schema|stringArray>': 'map<schema|stringArray>',
  'string': 'string',
});

describe('the admitted keyword shapes are the meta-schemas\' shapes', () => {
  for (const version of /** @type {const} */ ([6, 7, 2019, 2020])) {
    it(`draft ${version}: every keyword its meta-schemas define is admitted in their shape, or listed`, () => {
      const derived = derivedShapes(version);
      for (const [keyword, metaShape] of derived) {
        if (Object.hasOwn(NOT_ADMITTED, keyword)) continue;
        const runtime = /** @type {Record<string, string>} */ (KEYWORD_SHAPES)[keyword];
        assert.ok(runtime !== undefined, `draft ${version} defines '${keyword}' (${metaShape}), which is neither admitted nor listed`);
        const spelled = SPELLED[metaShape] ?? metaShape;
        const reading = READINGS.find(([k, , , drafts]) => k === keyword && drafts.includes(version));
        const [meta, admitted] = reading === undefined ? [spelled, spelled] : [reading[1], reading[2]];
        assert.deepEqual([spelled, runtime], [meta, admitted],
          `draft ${version} '${keyword}': the meta-schema says ${metaShape}, the validator admits ${runtime}`);
      }
    });
  }

  it('admits no keyword that no meta-schema defines', () => {
    const defined = new Set([6, 7, 2019, 2020].flatMap((v) => [...derivedShapes(/** @type {any} */ (v)).keys()]));
    assert.deepEqual(Object.keys(KEYWORD_SHAPES).filter((k) => !defined.has(k)), []);
  });

  it('turns off exactly the validation vocabulary\'s keywords (but const, which takes any value)', () => {
    const validation = getSchemaDraftByVersion(2020).schema.find((d) => d.$id.endsWith('meta/validation'));
    assert.deepEqual([...VALIDATION_KEYWORDS].sort(), Object.keys(validation.properties).filter((k) => k !== 'const').sort());
  });
});
