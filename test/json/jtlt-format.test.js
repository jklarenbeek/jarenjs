//@ts-check
/** Grammar derivation, structural/runtime boundaries and the contract's production template. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { compileJtltStylesheet, validateJtltTemplate } from '@jarenjs/json/jtlt';
import latest from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };
import old from '@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json' with { type: 'json' };
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
      template([{ $raw: '$', other: 1 }]), template([{ $json: '$', $raw: '$' }])];
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
