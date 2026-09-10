//@ts-check
/** Public project envelopes and Studio normalization, with no copied validator. */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as p from '@jarenjs/linq/project';
import * as s from '@jarenjs/linq/schema';
import { parseProject, validateFile, KINDS } from '@jarenjs/studio';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsonQuery } from '@jarenjs/json';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { STUDIO_TEMPLATES } from '../../packages/website/src/content/appTemplates.js';

const latest = JSON.parse(readFileSync(new URL('../../components/studio/schemas/jaren-project.schema.json', import.meta.url), 'utf8'));
const old = JSON.parse(readFileSync(new URL('../../components/studio/schemas/jaren-project.draft-07.schema.json', import.meta.url), 'utf8'));
const grammars = [latest, old].map((schema) => new JarenValidator().compile(schema));
const DOCUMENTS = {
  app: { view: [] },
  jslt: [{ match: '$', body: { $mul: ['$', 2] } }],
  query: { $add: ['$', 1] },
  state: { count: 1 },
  data: [1, 2],
  schema: { type: 'number' },
  fsm: { $fsm: '0.1', initial: 'a', states: ['a'], transitions: [] },
  dag: { $dag: '0.1', nodes: { n: { kind: 'input' }, out: { kind: 'output' } }, edges: [{ from: 'n', to: 'out' }] },
  model: { $model: '0.1', collections: { rows: { schema: { type: 'object' }, key: '/id', indexes: [] } } },
  contract: { $contract: '0.1', id: 'test', operations: { load: { kind: 'read', output: true, http: { method: 'GET', path: '/data' } } } },
};

describe('project pen', () => {
  it('counts every envelope field, file member, layout member and Studio file kind', () => {
    assert.equal(Object.keys(DOCUMENTS).length, 10);
    assert.deepEqual(Object.keys(DOCUMENTS).sort(), [...KINDS].sort());
    assert.deepEqual([...p.FILE_KINDS].sort(), [...latest.$defs.file.properties.kind.enum].sort());
    assert.deepEqual(old.definitions.file.properties.kind.enum, latest.$defs.file.properties.kind.enum);
    assert.deepEqual(Object.keys(latest.properties), ['project', 'files', 'active', 'layout']);
    assert.deepEqual(Object.keys(latest.$defs.file.properties), ['name', 'kind', 'text', 'imports', 'input', 'model', 'collection']);
    assert.deepEqual(Object.keys(latest.$defs.layout.properties), ['mode', 'ratio', 'autorun']);
  });
  for (const [kind, document] of Object.entries(DOCUMENTS)) {
    it(`${kind}: byte equality, both grammars, per-file engine boundary and round trip`, () => {
      const original = p.defineProject();
      const built = original.file(p.jsonFile('file.json', kind, document)).active('file.json')
        .layout({ mode: 'right', ratio: 0.3, autorun: false });
      const hand = { project: '0.1', files: [{ name: 'file.json', kind, text: JSON.stringify(document) }],
        active: 'file.json', layout: { mode: 'right', ratio: 0.3, autorun: false } };
      assert.equal(JSON.stringify(built), JSON.stringify(hand));
      assert.deepEqual(original.schema, { project: '0.1', files: [] });
      for (const validate of grammars) assert.equal(validate(built.schema), true);
      const parsed = parseProject(built.schema);
      assert.deepEqual(parsed, hand);
      assert.deepEqual(parseProject(JSON.stringify(parsed)), parsed);
      assert.equal(validateFile(parsed.files[0]).valid, true, JSON.stringify(validateFile(parsed.files[0])));
    });
  }
  it('preserves template file text and validates every shipped app seed through Studio', () => {
    assert.ok(STUDIO_TEMPLATES.length >= 3);
    for (const template of STUDIO_TEMPLATES) {
      const text = JSON.stringify(template.doc, null, 2);
      const built = p.defineProject([p.file('app.json', 'app', text)]);
      assert.equal(built.schema.files[0].text, text);
      assert.equal(validateFile(parseProject(built.schema).files[0]).valid, true);
    }
  });
  it('runs emitted query, stylesheet and schema files in their engines', () => {
    const query = p.jsonFile('q', 'query', DOCUMENTS.query);
    const view = p.jsonFile('v', 'jslt', DOCUMENTS.jslt);
    const schema = p.jsonFile('s', 'schema', s.number().min(1).schema);
    assert.equal(compileJsonQuery(JSON.parse(query.text))(2), 3);
    assert.equal(compileJsltStylesheet(JSON.parse(view.text))(2), 4);
    assert.equal(new JarenValidator().compile(JSON.parse(schema.text))(0), false);
  });
  it('uses Studio duplicate refusal, active fallback and layout defaulting unchanged', () => {
    const f = p.file('x', 'data', '{}');
    const duplicate = p.defineProject([f, f]);
    assert.throws(() => parseProject(duplicate.schema), { code: 'JS0002' });
    const built = p.defineProject([f]).active('absent').layout({ ratio: 0.2 });
    assert.deepEqual(parseProject(built.schema).layout, { mode: 'classic', ratio: 0.2, autorun: true });
    assert.equal(parseProject(built.schema).active, 'x');
    assert.equal(parseProject(p.defineProject().schema).active, null);
    assert.deepEqual(p.from(built.schema).schema, built.schema);
  });
  it('snapshots file lists and replaces metadata without freezing caller data', () => {
    const files = [{ name: 'x', kind: 'data', text: '{}' }];
    const layout = { ratio: 0.4 };
    const b = p.defineProject(files, { active: 'x', layout });
    files[0].text = '[]'; layout.ratio = 0.8;
    assert.equal(b.schema.files[0].text, '{}');
    assert.equal(b.schema.layout.ratio, 0.4);
    assert.deepEqual(b.files([]).schema.files, []);
    assert.deepEqual(b.layout({ mode: 'top' }).schema.layout, { mode: 'top' });
    assert.ok(Object.isFrozen(b.schema.files[0]));
    assert.equal(Object.isFrozen(files[0]), false);
  });
  it('refuses unspellable input while leaving file syntax and layout semantics to Studio', () => {
    for (const args of [['', 'data', '{}'], ['x', 'wat', '{}'], ['x', 'data', 1]])
      assert.throws(() => p.file(...args), { code: 'JL0101' });
    assert.throws(() => p.defineProject(null), { code: 'JL0101' });
    assert.throws(() => p.defineProject().active(null), { code: 'JL0101' });
    assert.throws(() => p.defineProject().layout({ unknown: 1 }), { code: 'JL0101' });
    assert.throws(() => p.jsonFile('x', 'data', undefined), { code: 'JL0101' });
    assert.equal(validateFile(p.file('x', 'data', '{')).valid, false);
    assert.throws(() => parseProject(p.defineProject().layout({ ratio: 2 }).schema), { code: 'JS0001' });
  });
  it('preserves immutable imports and explicit input/model routing through builder updates', () => {
    const imports = { state: 'seed' };
    const app = p.jsonFile('app', 'app', { view: [] }, { imports });
    const query = p.file('query', 'query', '"$"', { model: 'store', collection: 'notes', input: 'seed' });
    const built = p.defineProject([app, query, p.jsonFile('seed', 'state', {})]);
    imports.state = 'changed';
    assert.equal(app.imports.state, 'seed');
    assert.ok(Object.isFrozen(app.imports));
    assert.deepEqual(built.files(built.schema.files).schema, built.schema);
    assert.deepEqual(parseProject(built.schema).files, built.schema.files);
    assert.throws(() => p.file('x', 'data', '{}', { unknown: true }), { code: 'JL0101' });
  });
});
