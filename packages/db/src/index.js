//@ts-check
/**
 * @file @jarenjs/db — document storage through two seams: a driver (how
 * a connection is made: `@jarenjs/db/node`, `/bun`, `/wasm` with an
 * injected handle, or `/postgres` with an injected client) and a
 * dialect (how SQL is spelled). Two engines satisfy both — SQLite and
 * PostgreSQL 16+ — and what differs between them is a declared
 * capability rather than a discovered surprise.
 *
 * This root subpath never touches a runtime builtin and imports no
 * third-party client — a browser bundler resolves it clean; the
 * bindings live behind their own subpaths and load their builtin
 * lazily inside `open()`.
 */

export { openStore, normalizeModel, MODEL_VERSION } from './store.js';
export { createDialect, DIALECT_CAPABILITIES } from './dialect.js';
export { rtreeDdl } from './dialects/rtree-ddl.js';
export { sqliteDialect } from './dialects/sqlite.js';
export { PRAGMA_NAMES } from './pragmas.js';
export { CHECKPOINT_MODES, MAINTENANCE_OPERATIONS } from './maintenance.js';
export {
  SQLITE_FLOOR, chain, toPromise, isThenable, compareVersions,
  openConnection, finishConnection, sqliteProbe, baseCapabilities,
  wrapStatement, lazyOpen,
} from './driver.js';
export {
  planCollection, compileIndexPath, schemaTypeAt, columnKindFor, KEY_COLUMN, DOC_COLUMN,
  normalizeDeclaredSql, comparableDeclaredSql,
} from './ddl.js';
export {
  planQuery, assertDecidedKind, entityShape, entityPathRef,
  planEntityPredicate, planEntityQuery, collectEntityRoots, entityRoot,
  PLANNER_REASONS, reasonId,
} from './plan.js';
export { emitPlan, createEntityPredicateEmitters, emitEntityPlan } from './emit.js';
export { mergeEntityRow, parseGraphRow } from './graph.js';
export {
  selectPlan, conjoin, assertNoSqlText, effectiveOrder, planOrder, ordersByColumn,
  PLAN_VERSION,
} from './algebra.js';
export { typeOfPath, isNumericType } from './types.js';
export {
  compileSetResidual, compileRowResidual, compilePackedResidual, sequenceResult,
} from './residual.js';
export { createCursor, PAGE_LIMIT_DEFAULT } from './cursor.js';
export { deterministicFragment, registerFragment } from './udf.js';
export {
  normalizeExpression, canonicalExpression, expressionMembers, expressionFunctions,
  expressionSql, expressionStem, registeredName, registerExpressionFunctions,
  EXPRESSION_KINDS, EXPRESSION_DEPTH,
} from './expression.js';
export {
  DERIVE_KINDS, DERIVE_MAPPING, PHYSICAL_KINDS, BBOX_COMPONENTS, BBOX_INDEX_ORDER,
  PRECISION_MIN, PRECISION_MAX, DIMS_MIN, DIMS_MAX,
  deriveGeohash, deriveBboxEdge, deriveVector, derivedValue, derivedMappingFor, memberAt,
  storedMemberForm, registerDeriveFunctions, probeVector, columnScore,
} from './derive.js';
export { KNN_MARGIN, IDENTITY_CHUNK, cutCandidates, identityBatches } from './knn.js';
export {
  createQueryEngine, createQueryState, createEntityQueryEngine,
  createLoadEngine, INCLUDE_DEPTH_DEFAULT, INCLUDE_ROWS_DEFAULT, INCLUDE_BYTES_DEFAULT,
} from './query.js';
export {
  normalizeProfile, SAFE_PROFILE, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound,
} from './profile.js';
export { translatePatch } from './patch-sql.js';
export { normalizeEntities, explainMapping, compileEntityModel, relationTables } from './model.js';
export { planEntity, planJoinTable } from './ddl.js';
export { entityCore } from './entity.js';
export { entityEmitModel } from './emit-model.js';
export {
  parseChangeset, translateOperations, keyToken, createCaptureEngine,
  CHANGES_TABLE, CHANGES_STATE_TABLE, DEFAULT_RETENTION,
} from './capture.js';
export {
  createTracker, deepFreeze, BATCH_PARAM_BUDGET, BATCH_ROW_BOUND,
} from './tracker.js';
export {
  planMigration, planModelMigration, migrate, migrationStatus, shapeHash, isPerDocumentAssertion,
  migrationChecksum, createModelShape, schemaShapeOf, compareShapeToModel,
  MIGRATION_VERSION, HISTORY_TABLE, ASSERTION_BOUNDS_DEFAULT,
} from './migrate.js';
export { introspectModel, readSchema, INTROSPECT_CODES } from './introspect.js';
export { migrateDocuments, streamDocuments } from './documents.js';
export {
  compileDocumentStep, checkMigrationDocument, stepFailure, classifyAssertion,
  DOCUMENT_STEP_KINDS, PHYSICAL_STEP_KINDS,
} from './document-steps.js';
export {
  DbCompileError, DbRuntimeError, DB_CODES, classifyDriverError, wrapDriverError, isDriverError,
} from './errors.js';
export { classifyLiveQuery, createLiveRegistry, diffRows, LIVE_DEFAULTS } from './live.js';
export { createSortedWindow, compareCodepoint } from './window.js';
export {
  createJobEngine, JOBS_TABLE, JOB_CHECKPOINTS_TABLE, JOB_DEFAULTS,
  describeValue, serializeResult,
} from './jobs.js';
export { createDagJobRunner, RUN_IDENTITY_NODE } from './dag-job.js';
export { REPLICATION_VERSION, REPLICATION_DEFAULTS, normalizeFrontier,
  normalizeReplication, normalizeReplicationSnapshot, encodeReplication, replicationIdentity } from './replication-format.js';

export { planInvariants } from './ddl.js';
export { planPhysicalMigration } from './migrate.js';
export { sql, planRelational, relational } from './dialects/sqlite-relational.js';
export { defineTable, planTable } from './dialects/sqlite-schema.js';
export { planTableMigration, applyTableMigration, withForeignKeysSuspended, planSchemaChange, applySchemaChange } from './table-migration.js';
