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
export { planCollection, compileIndexPath, schemaTypeAt, KEY_COLUMN, DOC_COLUMN } from './ddl.js';
export { planQuery, assertDecidedKind } from './plan.js';
export { emitPlan } from './emit.js';
export { selectPlan, conjoin, assertNoSqlText, PLAN_VERSION } from './algebra.js';
export { typeOfPath, isNumericType } from './types.js';
export { compileSetResidual, compileRowResidual, sequenceResult } from './residual.js';
export { deterministicFragment, registerFragment } from './udf.js';
export { createQueryEngine, createQueryState } from './query.js';
export {
  normalizeProfile, SAFE_PROFILE, translateProfilePredicate,
  applyMandatoryPredicate, applyRowBound,
} from './profile.js';
export { translatePatch } from './patch-sql.js';
export { DbCompileError, DbRuntimeError, DB_CODES } from './errors.js';
