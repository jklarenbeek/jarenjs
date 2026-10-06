//@ts-check
import assert from 'node:assert/strict';
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import { qualifyMigrationIdentity } from './migration-identity.js';

export async function qualifyLinqMigrationIdentity() {
  const model = (value) => ({ $model: '0.1', collections: { items: { key: '/id', schema: {
    type: 'object', properties: { id: { type: 'string' }, n: { const: value } },
  } } } });
  const left = model('159koso');
  const right = model('gnt19f');
  const document = defineMigration({ id: 'same', from: left, to: left }).document;
  assert.equal(document.$migration, '0.2');
  assert.equal(document.from, '15ta7pe');
  assert.notEqual(document.identity.from, defineMigration({ id: 'same', from: right, to: right }).document.identity.from);
  assert.throws(() => fromPlanned(document, { from: right }), { code: 'JL0102' });
  const { identity: _identity, ...legacy } = document;
  legacy.$migration = '0.1';
  assert.throws(() => fromPlanned(legacy), { code: 'JL0102' });
  return qualifyMigrationIdentity((from, to, id) => fromPlanned(
    defineMigration({ id, from, to }).document, { from, to }).document);
}
