//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Run the real gate with an injected server probe and completed child. No
// database or test child is started; stdout/stderr remain actual OS pipes.
const HARNESS = String.raw`
import cp from 'node:child_process';
import pg from 'pg';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
pg.Client = class {
  async connect() {}
  async end() {}
  async query(sql) {
    return { rows: sql.includes('server_version') ? [{ version: '18.6', version_num: '180006',
      fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on' }] : [] };
  }
};
cp.spawnSync = () => ({
  status: options.status,
  signal: options.signal ?? null,
  error: options.launchError ? new Error('CHILD_LAUNCH_FAILURE') : undefined,
  stdout: 'x'.repeat(1024 * 1024) + '\nFINAL_ASSERTION_DIAGNOSTIC\n# tests 1\n# skipped ' + (options.skipped ?? 0) + '\n',
  stderr: 'y'.repeat(1024 * 1024) + '\nFINAL_STDERR_DIAGNOSTIC\n',
});
syncBuiltinESMExports();
await import('./scripts/check-postgres.js');
`;

/** @param {{ status: number | null, signal?: string, launchError?: boolean, skipped?: number }} options */
function invoke(options) {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '--eval', HARNESS, JSON.stringify(options)],
    { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, JAREN_PG_URL: 'postgres://fixture', JAREN_PG_MAJOR: '18', JAREN_PG_DURABLE: '1' } });
  assert.ifError(result.error);
  assert.ok(result.stdout.endsWith('FINAL_ASSERTION_DIAGNOSTIC\n# tests 1\n# skipped ' + (options.skipped ?? 0) + '\n'), 'stdout retains the final diagnosis and summary');
  assert.ok(result.stderr.includes('FINAL_STDERR_DIAGNOSTIC'), 'stderr retains its final diagnosis');
  return result;
}

describe('PostgreSQL gate preserves complete child diagnostics', () => {
  it('drains both output pipes before reporting a failed test child', () => {
    const result = invoke({ status: 1 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PostgreSQL test process failed.*exit 1.*signal none/);
  });

  it('refuses a skipped live case while retaining the final summary', () => {
    const result = invoke({ status: 0, skipped: 1 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skipped tests/);
  });

  it('reports a terminated child and launch error without losing buffered diagnostics', () => {
    const result = invoke({ status: null, signal: 'SIGTERM', launchError: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHILD_LAUNCH_FAILURE/);
    assert.match(result.stderr, /PostgreSQL test process failed.*exit null.*signal SIGTERM/);
  });

  it('retains a successful unskipped child status and complete output', () => {
    const result = invoke({ status: 0 });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, /PostgreSQL test process failed|skipped tests|CHILD_LAUNCH_FAILURE/);
  });
});
