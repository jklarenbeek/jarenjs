// Public installed DB declarations: exact output, legacy input, and ownership.
import { adoptMigrationHistory, migrationHistory, planModelMigration, sqliteDialect as identityDialect, MIGRATION_VERSION } from '@jarenjs/db';
import type { AdoptMigrationHistoryResult, MigrationHistoryObservation, ExactMigrationDocument,
  LegacyMigrationDocument, Driver } from '@jarenjs/db';

declare const identityDriver: Driver;
declare const identityConnection: unknown;
declare const identityModel: unknown;
declare const historyObservation: MigrationHistoryObservation;
declare const legacyIdentityDocument: LegacyMigrationDocument;
const identityOwned: Promise<MigrationHistoryObservation> = migrationHistory({ driver: identityDriver });
const identityBorrowed: MigrationHistoryObservation | Promise<MigrationHistoryObservation> = migrationHistory({ connection: identityConnection }, {
  signal: new AbortController().signal, deadline: 42, runtime: { now: () => 1 },
});
const identityAdopted: Promise<AdoptMigrationHistoryResult> = adoptMigrationHistory({ driver: identityDriver }, [legacyIdentityDocument], {
  observed: historyObservation, model: identityModel,
});
const identityBorrowedAdopted: AdoptMigrationHistoryResult | Promise<AdoptMigrationHistoryResult> = adoptMigrationHistory({ connection: identityConnection }, [legacyIdentityDocument], {
  observed: historyObservation, model: identityModel, shadowDriver: identityDriver,
  physicalTarget: { objects: [] }, compileSchema: () => () => true, batchSize: 8,
});
// @ts-expect-error — borrowed read work can remain synchronous
const identityAlwaysAsync: Promise<MigrationHistoryObservation> = migrationHistory({ connection: identityConnection });
// @ts-expect-error — observation cannot create or validate physical models
void migrationHistory({ driver: identityDriver }, { model: identityModel });
// @ts-expect-error — adoption needs an explicit observation
void adoptMigrationHistory({ driver: identityDriver }, [], { model: identityModel });
// @ts-expect-error — adoption needs the attested current model
void adoptMigrationHistory({ driver: identityDriver }, [], { observed: historyObservation });
// @ts-expect-error — a mixed owned/borrowed target is not an ownership contract
void migrationHistory({ driver: identityDriver, connection: identityConnection });
// @ts-expect-error — no legacy bypass or dry-run authorizes history
void adoptMigrationHistory({ driver: identityDriver }, [], { observed: historyObservation, model: identityModel, allowLegacy: true });
const identityPlan: ExactMigrationDocument = planModelMigration(identityModel, identityModel, { dialect: identityDialect }).migration;
const exactMigrationVersion: '0.2' = MIGRATION_VERSION;
const exactPlanVersion: '0.2' = identityPlan.$migration;
const exactIdentityVersion: 1 = identityPlan.identity.version;
const historicalVersion: '0.1' = legacyIdentityDocument.$migration;
function inspectObserved(value: MigrationHistoryObservation) {
  const first = value.history.rows[0];
  const timestamp: string | null = first.applied_at;
  const steps: string | null = first.steps;
  // @ts-expect-error — SQL numeric text must not silently become a Number
  const count: number = first.steps;
  if (value.dialect === 'sqlite') {
    const order: 'rowid' = value.order;
    const rowid: string | null = value.history.rows[0].rowid;
    // @ts-expect-error — PostgreSQL's ordering member is absent
    void value.history.rows[0].rid;
    void [order, rowid];
  }
  else {
    const order: 'rid' = value.order;
    const rid: string | null = value.history.rows[0].rid;
    void [order, rid];
  }
  const payload: string | null = value.identity.rows[0]?.value;
  return [timestamp, steps, count, payload];
}
function adoptionCounts(result: AdoptMigrationHistoryResult) {
  const adopted: number = result.adopted;
  const unchanged: number = result.unchanged;
  // @ts-expect-error — adoption attests receipts without applying steps
  void result.applied;
  return adopted + unchanged;
}
void [identityOwned, identityBorrowed, identityAdopted, identityBorrowedAdopted, identityAlwaysAsync,
  exactMigrationVersion, exactPlanVersion, exactIdentityVersion, historicalVersion, inspectObserved, adoptionCounts];
