//@ts-check
/** Inert metadata: inspecting a schema must not load its runtime owners. */
import { REPLICATION_TABLES } from './replication-tables.js';
/** Current model document version. */
export const MODEL_VERSION = '0.1';
/** Migration receipt table. */
export const HISTORY_TABLE = '_jaren_migrations';
/** Change ledger table. */
export const CHANGES_TABLE = '_jaren_changes';
/** Change ledger retention state. */
export const CHANGES_STATE_TABLE = '_jaren_changes_state';
/** Durable job queue. */
export const JOBS_TABLE = '_jaren_jobs';
/** Durable job checkpoints. */
export const JOB_CHECKPOINTS_TABLE = '_jaren_job_checkpoints';
/** Tables excluded from model adoption and schema drift comparisons. */
export const ENGINE_TABLES = new Set([HISTORY_TABLE, CHANGES_TABLE, CHANGES_STATE_TABLE,
  JOBS_TABLE, JOB_CHECKPOINTS_TABLE, ...Object.values(REPLICATION_TABLES)]);
