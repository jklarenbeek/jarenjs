//@ts-check
/**
 * Assemble `benchmark/postgres-operations-result.json`, the operational
 * evidence the PostgreSQL documents derive their backup and recovery figures
 * from (`scripts/generate-postgres-facts.js`). Its inputs are the reports of
 * the two checks that measure it:
 *
 * - one `jaren-postgres-backup/1` report per PostgreSQL major of
 *   `docker/postgres/matrix.json`, written by
 *   `scripts/check-postgres-operations.js` when it is given
 *   `JAREN_PG_OPERATION_REPORT=<file>`;
 * - the `jaren-postgres-pitr/1` report of `scripts/check-postgres-recovery.js`
 *   (`JAREN_PG_RECOVERY_REPORT=<file>`).
 *
 * The result pins the SHA-256 of every repository input that determines it,
 * so a changed input makes the evidence stale and the derived documents
 * refuse it, and it keeps the two measurements before it.
 *
 * Usage: node scripts/generate-postgres-operations-evidence.js
 *          --backup <file> --backup <file> --backup <file> --recovery <file> [--out <file>]
 *   --backup <file>    a backup report, once per matrix major, in any order
 *   --recovery <file>  the archived-WAL recovery report
 *   --out <file>       the result to write (default
 *                      benchmark/postgres-operations-result.json); the result
 *                      already there becomes the previous measurement
 *
 * Exit codes: 0 written; 1 the write failed; 2 refused (an argument, a file
 * that cannot be read, a report of the wrong format, backups that are not one
 * per matrix major), with nothing written.
 */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = 'benchmark/postgres-operations-result.json';
const MATRIX = 'docker/postgres/matrix.json';
const BACKUP_FORMAT = 'jaren-postgres-backup/1';
const RECOVERY_FORMAT = 'jaren-postgres-pitr/1';
const RESULT_FORMAT = 'jaren-postgres-operations/1';

/** The repository inputs whose bytes determine the result, in the order it pins them. */
const SOURCES = Object.freeze([
  'scripts/check-postgres-operations.js',
  'scripts/check-postgres-recovery.js',
  'docker/postgres/compose.recovery.yaml',
  'test/consumer/postgres-recovery.js',
  'test/consumer/backend-app.js',
  'scripts/lib/postgres-pool.js',
  'docker/postgres/matrix.json',
  'packages/db/src/migrate.js',
  'packages/db/src/migration-history.js',
  'packages/db/src/migration-target.js',
  'packages/db/src/model.js',
  'packages/db/src/schema-positions.js',
  'packages/db/src/driver.js',
  'packages/db/src/drivers/postgres.js',
  'packages/core/src/model.js',
  'packages/core/src/schema.js',
  'packages/validate/src/schema-keywords.js',
]);

/**
 * A `jaren-postgres-backup/1` report: one logical dump and restore on one
 * server. Only the members read here are typed; the report is kept whole.
 * @typedef {{ format: string, postgres: { version: string }, [member: string]: unknown }} BackupReport
 */

/**
 * A `jaren-postgres-pitr/1` report: a base backup restored to a named point
 * by archived WAL. Kept whole.
 * @typedef {{ format: string, [member: string]: unknown }} RecoveryReport
 */

/**
 * A `jaren-postgres-operations/1` result, the file this script writes.
 * @typedef {object} OperationsEvidence
 * @property {string} format - `jaren-postgres-operations/1`
 * @property {string} measuredAt - when the result was assembled
 * @property {Record<string, string>} sourceHashes - SHA-256 of each pinned input, by repository path
 * @property {BackupReport[]} logicalBackups - one backup report per matrix major, by major
 * @property {RecoveryReport} pitr - the archived-WAL recovery report
 * @property {OperationsEvidence} [previous] - the measurement before, holding at most its own previous
 */

/**
 * @typedef {object} OperationsEvidenceInput
 * @property {readonly BackupReport[]} backups - the backup reports, in any order
 * @property {RecoveryReport} recovery - the recovery report
 * @property {readonly number[]} majors - the PostgreSQL majors the matrix qualifies
 * @property {Record<string, string>} sourceHashes - SHA-256 of each pinned input, by repository path
 * @property {OperationsEvidence} [previous] - the result this one replaces
 * @property {string} measuredAt - when the result is assembled, an ISO 8601 instant
 */

/** An input the evidence cannot be assembled from; the command exits 2 with its message. */
class Refusal extends Error {}

/**
 * Why `value` is not a document of `format`, or undefined when it is one.
 * @param {unknown} value
 * @param {string} format
 * @returns {string | undefined}
 */
function formatMismatch(value, format) {
  const found = /** @type {{ format?: unknown } | null | undefined} */ (value)?.format;
  if (found === format) return undefined;
  return `is ${typeof found === 'string' ? `a ${found} report` : 'not a report (it names no format)'}, expected ${format}`;
}

/**
 * The PostgreSQL major a backup report was taken on, read from the server
 * version it records (`16.15 (Debian …)` is 16).
 * @param {BackupReport} backup
 * @param {string} label - how a refusal names the report
 * @returns {number}
 */
function majorOf(backup, label) {
  const major = /^(\d+)/.exec(String(backup?.postgres?.version))?.[1];
  if (major === undefined) throw new Refusal(`${label} names no PostgreSQL version`);
  return Number(major);
}

/**
 * A result as the measurement beneath a new one: whole, but with its own
 * `previous` cut to that one generation.
 * @param {OperationsEvidence} result
 * @returns {OperationsEvidence}
 */
function asPrevious(result) {
  if (result.previous === undefined) return result;
  const { previous: _older, ...kept } = result.previous;
  return { ...result, previous: kept };
}

/**
 * Assemble the operations evidence from the reports of the two checks: the
 * backup reports ordered by major, the recovery report, the hashes of the
 * pinned inputs, and the result it replaces as `previous` — which keeps its
 * own `previous` and nothing deeper, so a result holds the current
 * measurement and the two before it. Reads and writes nothing.
 *
 * Throws, writing nothing anywhere, for a report of the wrong format, a
 * backup report that names no PostgreSQL version, backups that do not cover
 * each matrix major exactly once (naming every duplicated, missing and
 * unexpected major), and a previous result of another format.
 * @param {OperationsEvidenceInput} input
 * @returns {OperationsEvidence} the `jaren-postgres-operations/1` result
 */
export function buildOperationsEvidence({ backups, recovery, majors, sourceHashes, previous, measuredAt }) {
  /** @param {unknown} value @param {string} format @param {string} label */
  const refuseFormat = (value, format, label) => {
    const mismatch = formatMismatch(value, format);
    if (mismatch !== undefined) throw new Refusal(`${label} ${mismatch}`);
  };
  backups.forEach((backup, index) => refuseFormat(backup, BACKUP_FORMAT, `backup report ${index + 1}`));
  refuseFormat(recovery, RECOVERY_FORMAT, 'the recovery report');
  if (previous !== undefined) refuseFormat(previous, RESULT_FORMAT, 'the previous result');
  if (majors.length === 0) throw new Refusal('the matrix names no PostgreSQL major');

  const measured = backups.map((backup, index) => ({ backup, major: majorOf(backup, `backup report ${index + 1}`) }));
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const { major } of measured) counts.set(major, (counts.get(major) ?? 0) + 1);
  const byNumber = (/** @type {number} */ a, /** @type {number} */ b) => a - b;
  const problems = [
    ['duplicate', [...counts].filter(([, count]) => count > 1).map(([major]) => major)],
    ['missing', majors.filter((major) => !counts.has(major))],
    ['outside the matrix', [...counts.keys()].filter((major) => !majors.includes(major))],
  ].filter(([, found]) => found.length > 0)
    .map(([kind, found]) => `${kind} ${/** @type {number[]} */ (found).toSorted(byNumber).join(', ')}`);
  if (problems.length > 0) {
    throw new Refusal(`the backup reports must cover each matrix major (${majors.join(', ')}) exactly once: `
      + problems.join('; '));
  }

  return {
    format: RESULT_FORMAT,
    measuredAt,
    sourceHashes,
    logicalBackups: measured.toSorted((a, b) => a.major - b.major).map(({ backup }) => backup),
    pitr: recovery,
    ...(previous === undefined ? {} : { previous: asPrevious(previous) }),
  };
}

/**
 * A JSON file, parsed; one that cannot be read or parsed is refused.
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  catch (error) {
    throw new Refusal(`cannot read ${file}: ${/** @type {Error} */ (error).message}`);
  }
}

/**
 * A report file, refused unless it is of `format`.
 * @param {string} file
 * @param {string} format
 * @returns {any}
 */
function readReport(file, format) {
  const report = readJson(file);
  const mismatch = formatMismatch(report, format);
  if (mismatch !== undefined) throw new Refusal(`${file} ${mismatch}`);
  return report;
}

/**
 * The command line: the report files and the output path.
 * @param {string[]} argv
 * @returns {{ backups: string[], recovery: string, out: string }}
 */
function parseArguments(argv) {
  /** @type {string[]} */
  const backups = [];
  /** @type {{ recovery?: string, out?: string }} */
  const single = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--backup' && flag !== '--recovery' && flag !== '--out')
      throw new Refusal(`unexpected argument '${flag}' — use --backup <file>, --recovery <file> and --out <file>`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('-')) throw new Refusal(`${flag} needs a file`);
    if (flag === '--backup') backups.push(value);
    else {
      // a second value would silently replace the first
      const key = flag === '--recovery' ? 'recovery' : 'out';
      if (single[key] !== undefined) throw new Refusal(`${flag} given twice`);
      single[key] = value;
    }
  }
  if (single.recovery === undefined) throw new Refusal('--recovery <file> is required: the archived-WAL recovery report');
  return { backups, recovery: single.recovery, out: single.out === undefined ? join(ROOT, OUT) : resolve(single.out) };
}

/**
 * Everything the result needs, read and refused before anything is written.
 * @param {string[]} argv
 * @returns {{ out: string, result: OperationsEvidence }}
 */
function assemble(argv) {
  const options = parseArguments(argv);
  const backups = options.backups.map((file) => readReport(file, BACKUP_FORMAT));
  const recovery = readReport(options.recovery, RECOVERY_FORMAT);
  const matrix = readJson(join(ROOT, MATRIX));
  const servers = Array.isArray(matrix?.servers) ? matrix.servers : [];
  const majors = [...new Set(servers.map((/** @type {{ major: number }} */ server) => server.major))]
    .toSorted((a, b) => a - b);
  /** @type {OperationsEvidence | undefined} */
  let previous;
  try {
    previous = JSON.parse(readFileSync(options.out, 'utf8'));
  }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw new Refusal(`cannot read ${options.out}: ${/** @type {Error} */ (error).message}`);
  }
  if (previous !== undefined) {
    const mismatch = formatMismatch(previous, RESULT_FORMAT);
    if (mismatch !== undefined) throw new Refusal(`${options.out} ${mismatch}, so it cannot be kept as the previous measurement`);
  }
  /** @type {Record<string, string>} */
  const sourceHashes = {};
  for (const file of SOURCES) {
    let bytes;
    try { bytes = readFileSync(join(ROOT, file)); }
    catch (error) { throw new Refusal(`cannot read the pinned input ${file}: ${/** @type {Error} */ (error).message}`); }
    sourceHashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  const result = buildOperationsEvidence({ backups, recovery, majors, sourceHashes, previous,
    measuredAt: new Date().toISOString() });
  return { out: options.out, result };
}

/**
 * Write `text` to `file` whole or not at all: a temporary file beside it,
 * renamed over it.
 * @param {string} file
 * @param {string} text
 */
function writeWhole(file, text) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  }
  catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * The command.
 * @param {string[]} argv - the command-line arguments
 * @returns {number} the exit code
 */
function main(argv) {
  const oneLine = (/** @type {string} */ message) => message.replace(/\s*\n\s*/g, ' ');
  /** @type {{ out: string, result: OperationsEvidence }} */
  let assembled;
  try {
    assembled = assemble(argv);
  }
  catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`generate-postgres-operations-evidence: ${oneLine(error.message)}`);
    return 2;
  }
  const { out, result } = assembled;
  try {
    writeWhole(out, `${JSON.stringify(result, null, 2)}\n`);
  }
  catch (error) {
    console.error(`generate-postgres-operations-evidence: cannot write ${out}: ${oneLine(/** @type {Error} */ (error).message)}`);
    return 1;
  }
  const kept = result.previous === undefined ? 0 : result.previous.previous === undefined ? 1 : 2;
  const shown = relative(process.cwd(), out);
  console.log(`wrote ${shown.startsWith('..') || isAbsolute(shown) ? out : shown}: ${result.logicalBackups.length} logical backups `
    + `(majors ${result.logicalBackups.map((backup) => majorOf(backup, 'a backup report')).join(', ')}), `
    + `1 archived-WAL recovery, ${Object.keys(result.sourceHashes).length} pinned inputs, `
    + `${kept} previous measurement${kept === 1 ? '' : 's'} kept`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
