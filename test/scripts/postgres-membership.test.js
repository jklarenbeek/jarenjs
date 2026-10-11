//@ts-check
/**
 * @file The PostgreSQL membership producer (`benchmark/postgres-membership.js`):
 * what can be said of it without a server. Its argument and endpoint checks run
 * before it connects, so they are exercised here as a program; the sources it
 * pins and the promise that it never changes the server's JIT settings are read
 * from its text. The measurements themselves need a PostgreSQL endpoint and run
 * where the producer does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCER = 'benchmark/postgres-membership.js';
const SOURCE = readFileSync(join(ROOT, PRODUCER), 'utf8');

/** Run the producer with an endpoint that no run may reach. @param {string[]} args @param {string} [endpoint] */
const run = (args, endpoint = 'postgres://nobody@127.0.0.1:1/none') => spawnSync(process.execPath, [join(ROOT, PRODUCER), ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 30000, env: { ...process.env, JAREN_PG_URL: endpoint } });

describe('the membership producer refuses before it connects', () => {
  it('an unknown argument', () => {
    for (const args of [['--writ'], ['--write', '--sizes'], ['50']]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /AssertionError.*unknown argument/);
    }
  });

  it('a smoke run that would write', () => {
    for (const args of [['--smoke', '--write'], ['--write', '--smoke']]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /a smoke run writes nothing/);
    }
  });

  it('a missing endpoint', () => {
    const result = run(['--smoke'], '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /needs a PostgreSQL endpoint: set JAREN_PG_URL/);
  });
});

describe('the membership producer\'s source', () => {
  it('pins itself and the four sources whose behaviour it measures', () => {
    const listed = /const sourceFiles = \[([^\]]*)\]/.exec(SOURCE)?.[1] ?? '';
    assert.deepEqual([...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]), [PRODUCER,
      'packages/db/src/plan.js', 'packages/db/src/emit.js', 'packages/db/src/query.js', 'packages/db/src/dialects/postgres.js']);
  });

  it('never sets a JIT setting: the thresholds it measures at are the server\'s own', () => {
    const forcing = [/\bSET\s+(?:LOCAL\s+|SESSION\s+)?jit/i, /\bset_config\s*\(\s*['"`]jit/i,
      /\bALTER\s+(?:SYSTEM|DATABASE|ROLE|USER)\b[^;\n]*\bjit/i, /-c\s+jit/i];
    // the matchers find what they are looking for
    for (const sample of ['SET jit_above_cost = 0', 'SET LOCAL jit = off', "SELECT set_config('jit_above_cost', '0', false)",
      'ALTER SYSTEM SET jit_above_cost = 0', "options: '-c jit_above_cost=0'"])
      assert.ok(forcing.some((pattern) => pattern.test(sample)), sample);
    for (const pattern of forcing) assert.doesNotMatch(SOURCE, pattern);
    // it reads the settings it measures under
    assert.match(SOURCE, /current_setting\('jit_above_cost'\)/);
  });

  it('keeps every statement short of 400 terms that nothing regroups, and under a statement timeout', () => {
    assert.match(SOURCE, /const MAX_TERMS = 400;/);
    assert.match(SOURCE, /terms <= MAX_TERMS/);
    assert.match(SOURCE, /SET statement_timeout = \$\{STATEMENT_TIMEOUT_MS\}/);
    assert.match(SOURCE, /postgresDriver\(pool, \{ schema, statementTimeoutMs: STATEMENT_TIMEOUT_MS \}\)/);
    assert.match(SOURCE, /DROP SCHEMA IF EXISTS "\$\{schema\}" CASCADE/);
  });
});
