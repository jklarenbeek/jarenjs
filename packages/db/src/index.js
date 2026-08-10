//@ts-check
/**
 * @file @jarenjs/db — document storage over SQLite through two seams:
 * a driver (how a connection is made: `@jarenjs/db/node`, `/bun`, or
 * `/wasm` with an injected handle) and a dialect (how SQL is spelled).
 * This root subpath never touches a runtime builtin — a browser
 * bundler resolves it clean; the bindings live behind their own
 * subpaths and load their builtin lazily inside `open()`.
 */

export { openStore, normalizeModel, MODEL_VERSION } from './store.js';
export { createDialect } from './dialect.js';
export { sqliteDialect } from './dialects/sqlite.js';
export {
  SQLITE_FLOOR, chain, toPromise, isThenable, compareVersions,
  openConnection, wrapStatement, lazyOpen,
} from './driver.js';
export {
  planCollection, compileIndexPath, schemaTypeAt, KEY_COLUMN, DOC_COLUMN,
  normalizeDeclaredSql, comparableDeclaredSql,
} from './ddl.js';
export {
  planQuery, assertDecidedKind, entityShape, entityPathRef,
  planEntityPredicate, planEntityQuery,
} from './plan.js';
export { emitPlan, createEntityPredicateEmitters, emitEntityPlan } from './emit.js';
export { mergeEntityRow, parseGraphRow } from './graph.js';
export { selectPlan, conjoin, assertNoSqlText, PLAN_VERSION } from './algebra.js';
export { typeOfPath, isNumericType } from './types.js';
export { compileSetResidual, compileRowResidual, sequenceResult } from './residual.js';
export { deterministicFragment, registerFragment } from './udf.js';
export {
  createQueryEngine, createQueryState, createEntityQueryEngine,
  createLoadEngine, INCLUDE_DEPTH_DEFAULT,
} from './query.js';
export {
  normalizeProfile, SAFE_PROFILE, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound,
} from './profile.js';
export { translatePatch } from './patch-sql.js';
export { normalizeEntities, explainMapping } from './model.js';
export { planEntity, planJoinTable } from './ddl.js';
export { entityCore } from './entity.js';
export { entityEmitModel } from './emit-model.js';
export {
  parseChangeset, translateOperations, keyToken, createCaptureEngine,
  CHANGES_TABLE, DEFAULT_RETENTION,
} from './capture.js';
export {
  createTracker, deepFreeze, BATCH_PARAM_BUDGET, BATCH_ROW_BOUND,
} from './tracker.js';
export {
  planMigration, planModelMigration, migrate, migrationStatus, shapeHash,
  migrationChecksum, createModelShape, schemaShapeOf, compareShapeToModel,
  MIGRATION_VERSION, HISTORY_TABLE,
} from './migrate.js';
export { DbCompileError, DbRuntimeError, DB_CODES } from './errors.js';
export { classifyLiveQuery, createLiveRegistry, diffRows, LIVE_DEFAULTS } from './live.js';
export { createSortedWindow, compareCodepoint } from './window.js';
export {
  createJobEngine, JOBS_TABLE, JOB_CHECKPOINTS_TABLE, JOB_DEFAULTS,
  describeValue, serializeResult,
} from './jobs.js';
export { createDagJobRunner } from './dag-job.js';
