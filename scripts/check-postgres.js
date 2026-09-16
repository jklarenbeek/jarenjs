//@ts-check
/** Required live-server gate: an absent endpoint or skipped case is a failure. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.JAREN_PG_URL;
if (!url) {
  console.error('PostgreSQL qualification requires JAREN_PG_URL; no live coverage was run.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const row = (await client.query(`SELECT current_setting('server_version') AS version,
    current_setting('server_version_num') AS version_num, current_setting('fsync') AS fsync,
    current_setting('full_page_writes') AS full_page_writes,
    current_setting('synchronous_commit') AS synchronous_commit`)).rows[0];
  const major = Math.floor(Number(row.version_num) / 10000);
  if (![16, 17, 18].includes(major)
    || (process.env.JAREN_PG_MAJOR && major !== Number(process.env.JAREN_PG_MAJOR)))
    throw new Error('the PostgreSQL server is outside the selected qualification matrix');
  if (process.env.JAREN_PG_DURABLE === '1'
    && [row.fsync, row.full_page_writes, row.synchronous_commit].some((value) => value !== 'on'))
    throw new Error('durable qualification requires fsync, full_page_writes and synchronous_commit on');
  const extensions = (await client.query(`SELECT e.extname, e.extversion, n.nspname AS schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname`)).rows;
  console.log(JSON.stringify({ postgres: row, extensions, node: process.version }));
}
finally { await client.end(); }
const files = readdirSync(new URL('../test/db/', import.meta.url))
  .filter((name) => name.startsWith('postgres-') && name.endsWith('.test.js')).sort()
  .map((name) => `test/db/${name}`);
const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--test',
  '--test-isolation=none', '--test-timeout=120000', '--test-reporter=tap', ...files],
{ cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  // A test timeout cannot terminate a leaked client that keeps the child alive
  // after its cases finish. Bound the complete native gate as well.
  timeout: 300000 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0 || /# skipped [1-9]/.test(result.stdout)) process.exit(1);
