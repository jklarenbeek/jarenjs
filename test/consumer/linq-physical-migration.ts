import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import type { MigrationDocument, MigrationStep } from '@jarenjs/linq/migration';
import { migrate, migrationStatus, planPhysicalMigration, planTableMigration, readSchema } from '@jarenjs/db';
import type { BorrowedMigrationTarget, Driver, MigrationResult, MigrationStatusReport, PhysicalMigrationDocument, PhysicalMigrationTarget } from '@jarenjs/db';
import { model as v1 } from '../db/fixtures/models/v1.js';
import { model as v2 } from '../db/fixtures/models/v2.js';

declare const connection: unknown;
declare const driver: Driver;
declare const planned: MigrationDocument;

const borrowed: BorrowedMigrationTarget = { connection };
const ownedResult: Promise<MigrationResult> = migrate({ driver }, [], { baseline: v1 });
const borrowedResult: MigrationResult | Promise<MigrationResult> = migrate(borrowed, [], {
  baseline: v1, shadow: false, physicalTarget: { objects: [], tables: ['User'] },
});
const ownedStatus: Promise<MigrationStatusReport> = migrationStatus({ driver }, [], { model: v1 });
const borrowedStatus: MigrationStatusReport | Promise<MigrationStatusReport> = migrationStatus(borrowed, [], {
  model: v1, shadowDriver: driver, physicalTarget: { objects: [] },
});
// @ts-expect-error — borrowed work does not promise an asynchronous boundary
const promisedBorrowed: Promise<MigrationResult> = migrate(borrowed, [], { baseline: v1, shadow: false });
// @ts-expect-error — ownership is distinct even for a nonliteral target
void migrate({ driver, connection }, [], { baseline: v1 });
const mixedTarget = { connection, path: ':memory:' };
// @ts-expect-error — a borrowed target cannot silently own a path
void migrationStatus(mixedTarget, []);
// @ts-expect-error — borrowed settings belong to their owner
void migrate({ connection, busyTimeout: 100 }, [], { baseline: v1 });
void [ownedResult, borrowedResult, ownedStatus, borrowedStatus, promisedBorrowed];

function resultFields(result: MigrationResult) {
  if ('dryRun' in result) {
    const rows: number | null = result.counts.User;
    // @ts-expect-error — an absent relation has no current row count
    const knownRows: number = result.counts.User;
    if (rows !== null) { const known: number = rows; void known; }
    void knownRows;
    return result.statements;
  }
  if ('upToDate' in result) {
    const noApplied: [] = result.applied;
    // @ts-expect-error — checked repeat has no newly applied shape field
    void result.shape;
    return noApplied;
  }
  const shape: string = result.shape;
  return shape;
}
void resultFields;

async function reviewedTarget() {
  const target: PhysicalMigrationTarget = { objects: (await readSchema(connection)).objects, tables: ['User'] };
  void migrate({ connection }, [], { baseline: v1, physicalTarget: target,
    shadowDriver: driver, shadowFixture: (shadow) => { const handle: unknown = shadow; return handle; } });
  const tablePlan = planTableMigration(connection, { name: 'User', columns: [{ name: 'id', type: 'TEXT' }] }, { id: 'upgrade' });
  const planning = planPhysicalMigration(connection, v1, v2, {
    id: 'upgrade', steps: [{ kind: 'table', plan: tablePlan }], dispositions: {}, physicalTarget: target,
    assertions: [{ sql: 'SELECT 1 AS n', expected: [{ n: 1 }] }],
  });
  const boundary: PhysicalMigrationDocument | Promise<PhysicalMigrationDocument> = planning;
  const document = await planning;
  const migration: MigrationDocument = document;
  const pen = fromPlanned(document).transform('User', [], { model: v1 });
  const checksum: string = document.steps[0].plan.checksum;
  const completePlan: typeof tablePlan = document.steps[0].plan;
  const composed = fromPlanned(await planPhysicalMigration(connection, v1, v2, {
    id: 'compose', steps: [{ kind: 'table', plan: tablePlan }, ...historical.document.steps], dispositions: {},
  })).document;
  const incomplete = await planPhysicalMigration(connection, v1, v2, {
    id: 'incomplete', steps: [{ kind: 'table', plan: { statements: [], finish: [] } }], dispositions: {},
  });
  // @ts-expect-error — returning a supplied step does not invent the missing table-plan guards
  void fromPlanned(incomplete);
  void [boundary, migration, pen, checksum, completePlan, composed];
}
void reviewedTarget;

const historical = defineMigration({ id: 'history', from: v1, to: v2 })
  .transform('User', (row) => ({ id: row.id, name: row.name.upper(), age: row.age }), { model: v1 })
  .assert('User', (row) => row.name.isEmpty(), { model: v1 })
  .assert('User', (row) => row.handle.isEmpty(), { model: v2, expect: 'empty' })
  .transform('User', [{ match: '$', body: '$' }], { model: v1 });
// @ts-expect-error — the historical v1 input has no v2 handle
void defineMigration({ id: 'x', from: v1, to: v2 }).assert('User', (row) => row.handle.isEmpty(), { model: v1 });
// @ts-expect-error — a historical v1 result still requires its name
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (row) => ({ id: row.id }), { model: v1 });
// @ts-expect-error — a table must belong to the explicit current model
void historical.assert('Unknown', () => true, { model: v1 });
const plan = planTableMigration(connection, { name: 'User', columns: [{ name: 'id', type: 'TEXT' }] }, { id: 'upgrade' });
const step: MigrationStep = { kind: 'table', plan };
const completed = fromPlanned(planned).step(step).document;
const targetObjects = completed.physical?.target?.objects;
// @ts-expect-error — flattening the plan discards required source/identity guards
void historical.step({ kind: 'table', plan: { statements: [], finish: [] } });
void [historical, completed, targetObjects];
