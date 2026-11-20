//@ts-check
/** Grammar derivation, structural/runtime boundaries and the contract's production template. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { compileJtltStylesheet, validateJtltTemplate } from '@jarenjs/json/jtlt';
import latest from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };
import old from '@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json' with { type: 'json' };
import jslt from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import { jtltSchemaArtifacts } from '../../scripts/generate-jtlt-schema.js';
import { downlevelDraft07, draftNeutralSubsetViolations } from './schema-artifact-helpers.js';

const validators = [latest, old].map((schema) => new JarenValidator().compile(schema));
const valid = (doc) => validators.map((v) => v(doc));
const template = (body) => [{ match: '$', body }];

describe('JTLT public grammar', () => {
  it('is reproducibly derived from JSLT and stays in the draft-neutral subset', () => {
    assert.deepEqual(jtltSchemaArtifacts(), { latest, draft07: old });
    assert.deepEqual(downlevelDraft07(latest), old);
    assert.deepEqual(draftNeutralSubsetViolations(latest), []);
    assert.deepEqual(Object.keys(latest.$defs.rule.properties), ['match', 'mode', 'priority', 'body']);
    assert.deepEqual(Object.keys(latest.oneOf[1].properties), ['$jtlt', 'output', 'rules']);
  });
  it('states the query-object segment from the query grammar\'s own alternatives, in its order', () => {
    const ref = (name) => ({ $ref: `#/$defs/${name}` });
    assert.deepEqual(latest.$defs.segment.anyOf, [{ type: 'string' }, ref('segmentList'), ref('querySegment'), ref('rawSegment'), ref('jsonSegment')]);
    assert.deepEqual(latest.$defs.querySegment.oneOf, [ref('versionEnvelope'), ref('operatorPhrase')]);
    const alternatives = jslt.$defs.objectExpression.oneOf;
    assert.deepEqual(latest.$defs.operatorPhrase.oneOf, alternatives.filter((branch) => branch.$ref !== ref('mapConstructor').$ref));
    assert.equal(latest.$defs.operatorPhrase.oneOf.length, alternatives.length - 1);
    // the definitions the union names are the query grammar's, copied verbatim
    for (const { $ref } of [...latest.$defs.querySegment.oneOf, ...latest.$defs.operatorPhrase.oneOf].filter((branch) => branch.$ref !== ref('operatorPhrase').$ref))
      assert.deepEqual(latest.$defs[$ref.slice(8)], jslt.$defs[$ref.slice(8)], $ref);
  });
  it('makes a phrase the query grammar gains a segment, with no edit to the segment vocabulary', () => {
    const grown = structuredClone(jslt);
    grown.$defs.shoutPhrase = { type: 'object', properties: { $shout: { $ref: '#/$defs/expression' } }, required: ['$shout'], additionalProperties: false };
    grown.$defs.objectExpression.oneOf.push({ $ref: '#/$defs/shoutPhrase' });
    const { latest: next, draft07 } = jtltSchemaArtifacts(grown);
    assert.deepEqual(next.$defs.operatorPhrase.oneOf.at(-1), { $ref: '#/$defs/shoutPhrase' });
    for (const schema of [next, draft07]) {
      const validate = new JarenValidator().compile(schema);
      assert.equal(validate(template([{ $shout: '$.n' }])), true);
      assert.equal(validate(template([{ $shout: '$.n', other: 1 }])), false);
    }
    assert.deepEqual(validators.map((validate) => validate(template([{ $shout: '$.n' }]))), [false, false]);
  });
  it('fails loudly when the query grammar no longer partitions objects by $-prefixed keys', () => {
    const ref = (name) => ({ $ref: `#/$defs/${name}` });
    /** @param {(defs: any) => void} change */
    const reshaped = (change) => () => {
      const next = structuredClone(jslt);
      change(next.$defs);
      return jtltSchemaArtifacts(next);
    };
    assert.doesNotThrow(reshaped(() => {}));
    for (const name of ['segmentList', 'segment', 'querySegment', 'operatorPhrase', 'rawSegment', 'jsonSegment'])
      assert.throws(reshaped((defs) => { defs[name] = {}; }), new TypeError(`JSLT schema contract changed: $defs.${name} already exists`));
    const cases = [
      [(defs) => { defs.queryDocument = { type: 'object' }; }, '$defs.queryDocument.oneOf is not a list of references to definitions'],
      [(defs) => { defs.objectExpression.oneOf.push({ type: 'object', required: ['$inline'] }); }, '$defs.objectExpression.oneOf is not a list of references to definitions'],
      [(defs) => { defs.expression.oneOf.push(ref('missing')); }, '$defs.expression.oneOf is not a list of references to definitions'],
      [(defs) => { defs.queryDocument.oneOf.push(ref('scalarLiteral')); }, '$defs.queryDocument is not the version envelope or an expression'],
      [(defs) => { defs.queryDocument.oneOf.reverse(); }, '$defs.queryDocument is not the version envelope or an expression'],
      [(defs) => { defs.expression.oneOf.push(ref('mapPhrase')); }, '$defs.expression admits an object that is no $defs.objectExpression'],
      [(defs) => { delete defs.arrayConstructor.type; }, '$defs.expression admits an object that is no $defs.objectExpression'],
      [(defs) => { defs.scalarLiteral.type.push('object'); }, '$defs.expression admits an object that is no $defs.objectExpression'],
      [(defs) => { defs.expression.oneOf.pop(); }, '$defs.expression admits an object that is no $defs.objectExpression'],
      [(defs) => { defs.mapConstructor.patternProperties = {}; }, '$defs.mapConstructor is not the one object expression that refuses every $-prefixed key'],
      [(defs) => { defs.mapConstructor.type = ['object', 'null']; }, '$defs.mapConstructor is not the one object expression that refuses every $-prefixed key'],
      [(defs) => { defs.objectExpression.oneOf.push(ref('mapConstructor')); }, '$defs.mapConstructor is not the one object expression that refuses every $-prefixed key'],
      [(defs) => { defs.objectExpression.oneOf.shift(); }, '$defs.mapConstructor is not the one object expression that refuses every $-prefixed key'],
      [(defs) => { defs.plainPhrase = { type: 'object', properties: { a: {} } }; defs.objectExpression.oneOf.push(ref('plainPhrase')); }, '$defs.plainPhrase admits an object without a $-prefixed key'],
      [(defs) => { defs.constPhrase.required = ['plain']; }, '$defs.constPhrase admits an object without a $-prefixed key'],
      [(defs) => { defs.unaryOperatorPhrase.minProperties = 0; }, '$defs.unaryOperatorPhrase admits an object without a $-prefixed key'],
      [(defs) => { defs.binaryOperatorPhrase.propertyNames.enum.push('plain'); }, '$defs.binaryOperatorPhrase admits an object without a $-prefixed key'],
      [(defs) => { defs.versionEnvelope.type = ['object', 'string']; }, '$defs.versionEnvelope admits an object without a $-prefixed key'],
    ];
    for (const [change, what] of cases) assert.throws(reshaped(change), new TypeError(`query schema contract changed: ${what}`));
  });
  it('pins every intentional segment form, with byte-identical rendering', () => {
    const cases = [
      [[], ''],
      [['literal', '$$x'], 'literal$x'],
      [['$.n'], '2'],
      [[['a', ['b']]], 'ab'],
      [[{ $raw: '$.markup' }], '<b>'],
      [[{ $json: '$.n' }], '2'],
      [[{ $apply: '$.n' }], '2'],
      [[{ $add: ['$.n', 1] }], '3'],
    ];
    for (const [body, output] of cases) {
      const doc = template(body);
      assert.deepEqual(valid(doc), [true, true], JSON.stringify(doc));
      assert.equal(compileJtltStylesheet(doc)({ n: 2, markup: '<b>' }), output);
      assert.deepEqual(validateJtltTemplate(doc), { valid: true, errors: [] });
    }
  });
  it('refuses envelope, rule, reserved-priority and non-segment errors structurally and at compile time', () => {
    const cases = [null, {}, { $jtlt: '0.2', rules: [] }, { $jtlt: '0.1', output: 'json', rules: [] },
      { $jtlt: '0.1', rules: [], modes: {} }, [null], [{ body: [] , priority: -1e307 }],
      [{ body: 'text' }], [{ body: [], mode: 1 }], template([false]), template([{}]),
      template([{ $raw: '$', other: 1 }]), template([{ $json: '$', $raw: '$' }]),
      // an object with no $-prefixed key is no segment, the empty member name included
      template([{ a: 1 }]), template([{ '': 1 }]), template([{ '': 1, a: 2 }]), template([[{ '': { $const: 1 } }]])];
    for (const doc of cases) {
      assert.deepEqual(valid(doc), [false, false], JSON.stringify(doc));
      assert.equal(validateJtltTemplate(doc).valid, false);
      assert.throws(() => compileJtltStylesheet(doc));
    }
  });
  it('records the structural/compiler boundary without claiming runtime validation', () => {
    const cases = [
      template(['$9foo']), [{ match: '$[', body: [] }],
      [{ match: { schema: { type: 'number' } }, body: [] }],
      template([{ $apply: ['$', 3] }]),
    ];
    for (const doc of cases) {
      assert.deepEqual(valid(doc), [true, true]);
      const report = validateJtltTemplate(doc);
      assert.equal(report.valid, false);
      assert.equal(report.errors[0].code, 'TL0005');
      assert.equal(typeof report.errors[0].docPath, 'string');
    }
    const doc = template(['$']);
    assert.deepEqual(valid(doc), [true, true]);
    assert.equal(validateJtltTemplate(doc).valid, true);
    assert.throws(() => compileJtltStylesheet(doc)({}), { code: 'TL2001' });
  });
  it('validates the contract TypeScript template and every published Appendix A template', () => {
    const production = JSON.parse(readFileSync(new URL('../../packages/contract/src/project/typescript.jtlt.json', import.meta.url), 'utf8'));
    assert.deepEqual(valid(production), [true, true]);
    assert.equal(validateJtltTemplate(production).valid, true);
    const markdown = readFileSync(new URL('../../packages/json/docs/JTLT-FORMAT.md', import.meta.url), 'utf8');
    const appendix = markdown.split('## Appendix A.')[1].split('## Appendix B.')[0];
    const fixtures = [...appendix.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((m) => JSON.parse(m[1])).filter((doc) => Array.isArray(doc) || doc.$jtlt);
    assert.equal(fixtures.length, 8);
    for (const doc of fixtures) {
      assert.deepEqual(valid(doc), [true, true]);
      assert.equal(validateJtltTemplate(doc).valid, true);
    }
  });
  it('keeps all existing render, spec and option-variant fixtures on the grammar harness', () => {
    for (const file of ['render', 'spec-examples', 'variants']) {
      const source = readFileSync(new URL(`./jtlt/${file}.test.js`, import.meta.url), 'utf8');
      assert.ok(source.includes("from './grammar-harness.js'"));
      assert.equal(source.includes("from '@jarenjs/json/jtlt'"), false);
    }
  });
});
