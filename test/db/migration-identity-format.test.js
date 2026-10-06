//@ts-check
/** Exact endpoint grammar, authoring and file-only historical compatibility. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationDocument, MIGRATION_VERSION, shapeHash, migrationChecksum,
  migrateDocuments, streamDocuments } from '@jarenjs/db';
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { checkMigrationStructure } from '../../packages/db/src/document-steps.js';
import schema from '../../packages/db/schemas/jaren-migration.schema.json' with { type: 'json' };
import schema07 from '../../packages/db/schemas/jaren-migration.draft-07.schema.json' with { type: 'json' };
import { compileArtifact, downlevelDraft07, mapRefs, draftNeutralSubsetViolations } from '../json/schema-artifact-helpers.js';

const model = { $model: '0.1', collections: { rows: { key: '/id', schema: {
  type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } },
} } } };
const identity = (from, to = from) => ({ version: 1, from: canonicalizeJson(from), to: canonicalizeJson(to) });
const document = (from = model, to = from) => ({ $migration: '0.2', id: 'exact',
  from: shapeHash(from), to: shapeHash(to), identity: identity(from, to), steps: [] });
const legacy = () => ({ $migration: '0.1', id: 'historical', from: shapeHash(model), to: shapeHash(model), steps: [] });
const grammars = [['2020-12', compileArtifact(schema)], ['draft-07', compileArtifact(schema07)]];

describe('migration identity format discrimination', () => {
  it('advertises current 0.2 while parsing unchanged historical 0.1', () => {
    assert.equal(MIGRATION_VERSION, '0.2');
    assert.doesNotThrow(() => checkMigrationDocument(legacy()));
    assert.doesNotThrow(() => checkMigrationDocument(document()));
    for (const [name, validate] of grammars) {
      assert.equal(validate(legacy()), true, name);
      assert.equal(validate(document()), true, name);
    }
  });

  it('keeps the draft-neutral artifact and mechanically derived twin identical', () => {
    assert.deepEqual(draftNeutralSubsetViolations(schema), []);
    assert.deepEqual(schema07, mapRefs(downlevelDraft07(schema)));
  });

  it('inspects a pending draft internally while the public execution check still refuses it', () => {
    const doc = document();
    doc.steps.push({ kind: 'jslt', collection: 'rows', stylesheet: [], draft: true });
    assert.doesNotThrow(() => checkMigrationStructure(doc));
    assert.throws(() => checkMigrationDocument(doc), { code: 'JD0021' });
    doc.identity.from = '{}';
    assert.throws(() => checkMigrationStructure(doc), { code: 'JD0023', class: 'error', retryable: false });
    assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023' });
  });

  const malformed = [
    ['missing identity', (doc) => { delete doc.identity; }],
    ['null identity', (doc) => { doc.identity = null; }],
    ['array identity', (doc) => { doc.identity = []; }],
    ['unsupported identity version', (doc) => { doc.identity.version = 2; }],
    ['string identity version', (doc) => { doc.identity.version = '1'; }],
    ['missing identity version', (doc) => { delete doc.identity.version; }],
    ['missing source text', (doc) => { delete doc.identity.from; }],
    ['missing target text', (doc) => { delete doc.identity.to; }],
    ['numeric endpoint', (doc) => { doc.identity.from = 1; }],
    ['extra identity member', (doc) => { doc.identity.extra = true; }],
    ['unknown document version', (doc) => { doc.$migration = '0.3'; }],
  ];
  for (const [name, change] of malformed) it(`refuses ${name} in both schemas, the parser and the pen`, () => {
    const doc = document(); change(doc);
    for (const [draft, validate] of grammars) assert.equal(validate(doc), false, draft);
    assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023', class: 'error', retryable: false });
    assert.throws(() => fromPlanned(doc), { code: 'JL0101' });
  });

  it('does not attach exact identity to a historical format by accident', () => {
    for (const value of [identity(model), null, undefined]) {
      const mixed = { ...legacy(), identity: value };
      assert.throws(() => checkMigrationDocument(mixed), { code: 'JD0023' });
      for (const [name, validate] of grammars) assert.equal(validate(mixed), false, name);
    }
  });

  it('refuses legacy authoring with guidance even when both endpoint models are supplied', () => {
    for (const options of [undefined, { from: model }, { from: model, to: model }]) {
      assert.throws(() => fromPlanned(legacy(), options), (error) => error.code === 'JL0102'
        && error.docPath === '/$migration' && /keep applied artifacts unchanged/.test(error.reason)
        && /new 0\.2 migration/.test(error.reason));
    }
  });
});

describe('exact canonical model text', () => {
  const malformedTexts = [
    ['empty', ''], ['whitespace', ` ${canonicalizeJson(model)}`],
    ['noncanonical key order', '{"collections":{},"$model":"0.1"}'],
    ['duplicate members', '{"$model":"0.1","$model":"0.1"}'],
    ['escape spelling', '{"$model":"0.\\u0031"}'],
    ['number spelling', '{"$model":"0.1","n":1.0}'],
    ['wrong model version', '{"$model":"0.2"}'],
    ['missing model marker', '{}'], ['array model', '[]'], ['null model', 'null'],
    ['non-JSON', '{'], ['unpaired surrogate', '{"$model":"0.1","note":"\\ud800"}'],
    ['unremoved rename hint', canonicalizeJson({ $model: '0.1', collections: { rows: { ...model.collections.rows, 'x-rename': 'old' } } })],
  ];
  for (const [name, text] of malformedTexts) for (const side of ['from', 'to'])
    it(`refuses ${name} in identity.${side} before execution`, () => {
      const doc = document(); doc.identity[side] = text;
      assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023' });
      assert.throws(() => fromPlanned(doc), { code: 'JL0101', docPath: `/identity/${side}` });
    });

  for (const side of ['from', 'to']) it(`refuses an inconsistent ${side} compatibility fingerprint`, () => {
    const doc = document(); doc[side] = 'wrong-fingerprint';
    assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023', docPath: `/${side}` });
    assert.throws(() => fromPlanned(doc), { code: 'JL0101', docPath: `/${side}` });
  });

  it('does not read identity accessors or accept inherited endpoint members', () => {
    let reads = 0;
    const doc = document();
    Object.defineProperty(doc, 'identity', { enumerable: true, get() { reads++; return identity(model); } });
    assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023' });
    assert.equal(reads, 0);
    assert.throws(() => fromPlanned(doc), { code: 'JL0101' });
    assert.equal(reads, 0);
    for (const side of ['version', 'from', 'to']) {
      const input = document();
      const value = input.identity[side];
      Object.defineProperty(input.identity, side, { enumerable: true, get() { return value; } });
      assert.throws(() => checkMigrationDocument(input), { code: 'JD0023' });
      assert.throws(() => fromPlanned(input), { code: 'JL0101' });
    }
    const inherited = document();
    inherited.identity = Object.assign(Object.create({ version: 1 }), { from: inherited.identity.from, to: inherited.identity.to });
    assert.throws(() => checkMigrationDocument(inherited), { code: 'JD0023' });
    assert.throws(() => fromPlanned(inherited), { code: 'JL0101' });
    const hidden = document();
    Object.defineProperty(hidden.identity, 'version', { value: 1, enumerable: false });
    assert.throws(() => checkMigrationDocument(hidden), { code: 'JD0023' });
    assert.throws(() => fromPlanned(hidden), { code: 'JL0101' });
  });

  it('refuses self-replacing identity accessors before they can alter the admitted value', () => {
    for (const side of [null, 'version', 'from', 'to']) {
      const doc = document();
      const target = side === null ? doc : doc.identity;
      const member = side ?? 'identity';
      const value = target[member];
      let reads = 0;
      Object.defineProperty(target, member, { enumerable: true, configurable: true, get() {
        reads++;
        Object.defineProperty(target, member, { value, enumerable: true });
        return value;
      } });
      assert.throws(() => checkMigrationDocument(doc), { code: 'JD0023' });
      assert.throws(() => fromPlanned(doc), { code: 'JL0101' });
      assert.equal(reads, 0);
    }
  });
});

describe('migration pen exact endpoints', () => {
  it('separates the fixed model collision and refuses the wrong model on either side', () => {
    const models = ['159koso', 'gnt19f'].map((value) => ({ $model: '0.1', collections: {
      items: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, n: { const: value } } } },
    } }));
    assert.deepEqual(models.map(shapeHash), ['15ta7pe', '15ta7pe']);
    const docs = models.map((value) => defineMigration({ id: 'same', from: value, to: value }).document);
    assert.equal(docs[0].$migration, '0.2');
    assert.equal(docs[0].from, docs[1].from);
    assert.notEqual(docs[0].identity.from, docs[1].identity.from);
    assert.notDeepEqual(docs[0], docs[1]);
    for (const side of ['from', 'to']) {
      assert.throws(() => fromPlanned(docs[0], { [side]: models[1] }), { code: 'JL0102', docPath: `/${side}` });
      assert.doesNotThrow(() => fromPlanned(docs[0], { [side]: models[0] }));
    }
  });

  it('strips only planning hints and preserves own prototype-sensitive model members', () => {
    const hinted = JSON.parse('{"$model":"0.1","__proto__":{"annotation":true},"collections":{"__proto__":{"x-rename":"previous","key":"/id","schema":{"type":"object","x-rename":"schema-annotation","properties":{"__proto__":{"const":1}}}}},"entities":{"Person":{"x-rename":"Member","schema":{"type":"object"}}}}');
    const stripped = structuredClone(hinted);
    delete stripped.collections.__proto__['x-rename']; delete stripped.entities.Person['x-rename'];
    const doc = defineMigration({ id: 'hints', from: hinted, to: stripped }).document;
    assert.deepEqual(doc.identity, identity(stripped));
    assert.equal(doc.from, shapeHash(hinted));
    assert.equal(doc.from, doc.to);
    const parsed = JSON.parse(doc.identity.from);
    assert.equal(Object.hasOwn(parsed, '__proto__'), true);
    assert.equal(Object.hasOwn(parsed.collections, '__proto__'), true);
    assert.equal(parsed.collections.__proto__.schema['x-rename'], 'schema-annotation');
    assert.equal(parsed.collections.__proto__.schema.properties.__proto__.const, 1);
    assert.doesNotThrow(() => checkMigrationDocument(doc));
    assert.deepEqual(fromPlanned(doc, { from: stripped, to: hinted }).document, doc);
    assert.equal(hinted.collections.__proto__['x-rename'], 'previous');
  });

  it('copies and freezes exact identity independently while preserving append-only pen behavior', () => {
    const planned = document();
    const pen = fromPlanned(planned, { from: model, to: model });
    assert.deepEqual(pen.document, planned);
    assert.equal(Object.isFrozen(pen.document.identity), true);
    assert.equal(pen.toJSON(), pen.document);
    const appended = pen.sql('SELECT 1').document;
    assert.deepEqual(pen.document.steps, []);
    assert.deepEqual(appended.steps, [{ kind: 'sql', sql: 'SELECT 1' }]);
    planned.identity.from = 'changed';
    assert.equal(pen.document.identity.from, canonicalizeJson(model));
    assert.equal(appended.identity, pen.document.identity);
  });

  it('keeps historical checksum outputs byte-compatible', () => {
    const docs = ['p6oqx0', 'e6rrp7'].map((suffix) => ({ $migration: '0.1', id: 'same', from: '1nubokf', to: '1nubokf',
      steps: [{ kind: 'sql', sql: `CREATE TABLE IF NOT EXISTS collision_example_${suffix} (id INTEGER)` }],
    }));
    assert.deepEqual(docs.map(migrationChecksum), ['fiebr3', 'fiebr3']);
  });
});

describe('file-only structural compatibility', () => {
  for (const version of ['0.1', '0.2']) it(`materializes and streams ${version} document steps`, async () => {
    const doc = version === '0.1' ? legacy() : document();
    doc.steps.push({ kind: 'jslt', collection: 'rows', stylesheet: [{ match: '$.n', body: { $add: ['$', 1] } }] });
    const input = { rows: [{ id: 'a', n: 1 }] };
    const expected = { rows: [{ id: 'a', n: 2 }] };
    const result = await migrateDocuments(input, [doc]);
    assert.deepEqual(result.documents, expected);
    const written = [];
    const streamed = await streamDocuments(input, [doc], { write: (collection, value) => written.push([collection, value]) });
    assert.deepEqual(written, [['rows', expected.rows[0]]]);
    assert.deepEqual(streamed.counts, result.report.counts);
    assert.deepEqual(input, { rows: [{ id: 'a', n: 1 }] });
  });
});
