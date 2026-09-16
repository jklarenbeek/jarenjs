//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDialect } from '@jarenjs/db/postgres';
import { replicationSchema } from '../../packages/db/src/dialects/replication.js';

const dialect = postgresDialect(), schema = replicationSchema(dialect);

// Independent catalog evidence: declarations under test do not build the oracle.
function fixture() {
  const objects = [];
  const add = (owner, type, name, metadata, sql = null) => objects.push({ schema: 'tenant', owner, type, name, metadata, sql });
  for (const [table, keys, columns] of [
    ['_jaren_replica', ['id'], ['id:bigint', 'value:text']],
    ['_jaren_replica_rows', ['name', 'key'], ['name:text', 'key:text', 'value:text', 'frontier:text']],
    ['_jaren_replica_receipts', ['id'], ['id:text', 'payload:text']],
    ['_jaren_replica_outbox', ['seq'], ['seq:bigint', 'payload:text']],
    ['_jaren_replica_conflicts', ['id'], ['id:text', 'evidence:text']],
    ['_jaren_replica_claims', ['id'], ['id:text', 'payload:text']],
  ]) {
    add(table, 'table', table, { kind: 'r', persistence: 'p' });
    add(table, 'constraint', `${table}_pkey`, { kind: 'p', columns: keys, deferrable: false, validated: true });
    add(table, 'index', `${table}_pkey`, { primary: true, ready: true, valid: true });
    for (const column of columns) {
      const [name, type] = column.split(':');
      add(table, 'column', name, { type, typeKind: 'b', nullable: false,
        collation: type === 'text' ? 'C' : null, collationSchema: 'pg_catalog', collationDeterministic: true });
    }
  }
  add('Node', 'table', 'Node', { kind: 'r', persistence: 'p' });
  add('Node', 'constraint', 'node_parent', { kind: 'f', deferrable: true, validated: true },
    'FOREIGN KEY (parent) REFERENCES "Node"(id) DEFERRABLE');
  const rules = [], incoming = [], executed = [];
  const connection = { dialect, exec: async (sql) => { executed.push(sql); }, async prepare(sql) {
    if (sql === 'SELECT current_schema() AS name') return { get: async () => ({ name: 'tenant' }) };
    if (sql === dialect.introspect.catalog()) return { all: async () => objects };
    if (sql.includes('pg_catalog.pg_rewrite')) return { all: async () => rules };
    assert.ok(sql.includes('k.confrelid'));
    return { all: async () => incoming };
  } };
  return { objects, rules, incoming, executed, connection, add };
}

it('native replication verifies catalog evidence without provisioning or repairing tables', async () => {
  const f = fixture();
  f.rules.push({ name: 'unrelated' });
  f.incoming.push({ owner: 'Node', schema: 'tenant', namespace: 'tenant', target: 'Node' });
  await dialect.replication.verify(f.connection, schema, ['Node']);
  assert.deepEqual(f.executed, []);
  await dialect.replication.initialize(f.connection);
  assert.equal(f.executed.length, 1);
  assert.match(f.executed[0], /pg_advisory_xact_lock\(1246907983,/);
});

it('native replication refuses schema, collation and undeclared-effect evidence', async () => {
  for (const [type, name, mutation, code] of [
    ['column', 'seq', { type: 'integer' }, 'JD0002'],
    ['column', 'value', { collationSchema: 'tenant' }, 'JD0002'],
    ['table', 'Node', { rls: true }, 'JD0051'],
    ['table', 'Node', { persistence: 'u' }, 'JD0051'],
    ['table', 'Node', { inherits: [{ name: 'outside' }] }, 'JD0051'],
    ['constraint', 'node_parent', { deferrable: false }, 'JD0051'],
  ]) {
    const f = fixture();
    Object.assign(f.objects.find((row) => row.type === type && row.name === name).metadata, mutation);
    await assert.rejects(dialect.replication.verify(f.connection, schema, ['Node']), { code });
    assert.deepEqual(f.executed, []);
  }
  for (const type of ['trigger', 'policy']) {
    const f = fixture(); f.add('Node', type, 'outside', {});
    await assert.rejects(dialect.replication.verify(f.connection, schema, ['Node']), { code: 'JD0051' });
  }
});

it('native replication rejects rewrite rules and inbound relationships from other owners', async () => {
  const rules = fixture(); rules.rules.push({ name: 'Node' });
  await assert.rejects(dialect.replication.verify(rules.connection, schema, ['Node']), { code: 'JD0051' });
  for (const [owner, namespace] of [['Unmanaged', 'tenant'], ['Node', 'other']]) {
    const f = fixture(); f.incoming.push({ owner, schema: namespace, namespace: 'tenant', target: 'Node' });
    await assert.rejects(dialect.replication.verify(f.connection, schema, ['Node']), { code: 'JD0051' });
  }
});
