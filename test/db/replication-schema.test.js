//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { normalizeReplication, normalizeReplicationSnapshot, encodeReplication } from '@jarenjs/db';
import { defineReplication } from '@jarenjs/linq/db';
import { downlevelDraft07, mapRefs, draftNeutralSubsetViolations } from '../json/schema-artifact-helpers.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../../packages/db/schemas/${name}.schema.json`, import.meta.url), 'utf8'));
const envelope = { $replication: '0.1', replica: 'host/~😀', seq: 1, model: 'model-revision', frontier: {},
  operations: [{ table: 'notes', key: 'hostile/~😀', before: null, after: { id: 'hostile/~😀' } }] };
const snapshot = { $replicationSnapshot: '0.1', model: envelope.model, frontier: { [envelope.replica]: 1 },
  rows: [{ table: 'notes', key: 'hostile/~😀', value: { id: 'hostile/~😀' }, frontier: { [envelope.replica]: 1 } }], receipts: [envelope] };

for (const name of ['jaren-replication', 'jaren-replication-snapshot']) it(`${name}: current and draft-07 artifacts agree on the corpus`, () => {
  const current = load(name); const legacy = load(`${name}.draft-07`);
  assert.deepEqual(draftNeutralSubsetViolations(current), []);
  assert.deepEqual(legacy, mapRefs(downlevelDraft07(current)));
  const valid = name.endsWith('snapshot') ? snapshot : envelope;
  const invalid = [{}, { ...valid, unknown: true }, { ...valid, frontier: { bad: -1 } }, { ...valid, model: '' },
    { ...valid, [name.endsWith('snapshot') ? '$replicationSnapshot' : '$replication']: '9.9' }];
  for (const [schema, suffix] of [[current, ''], [legacy, '.draft-07']]) {
    const compiler = new JarenValidator();
    if (name.endsWith('snapshot')) compiler.addSchema(load(`jaren-replication${suffix}`));
    const check = compiler.compile(schema);
    assert.equal(check(valid), true);
    for (const document of invalid) assert.equal(check(document), false, JSON.stringify(document));
  }
  const normalize = name.endsWith('snapshot') ? normalizeReplicationSnapshot : normalizeReplication;
  assert.deepEqual(normalize(valid), valid);
  for (const document of invalid) assert.throws(() => normalize(document), { code: 'JD0060' });
});

it('the DB pen emits the same canonical bytes and snapshots its header and operations', () => {
  const { operations, $replication: _version, ...header } = envelope;
  const builder = defineReplication(header);
  const operation = structuredClone(operations[0]);
  assert.equal(builder.change(operation.table, operation.key, operation.before, operation.after), builder);
  operation.after.id = 'mutated';
  assert.equal(encodeReplication(builder.toDocument()), encodeReplication(envelope));
  assert.equal(JSON.stringify(builder), JSON.stringify(builder.toDocument()));
});
