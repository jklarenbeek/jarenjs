import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// scripts/check-postgres.js runs every test/db file that names its endpoint
// and refuses a skipped case; a Bun sub-run skips on a host without Bun, so
// it lives in a file of its own that the qualification does not select.
describe('the PostgreSQL qualification selection', () => {
  it('holds no case that skips on a host without Bun', () => {
    const dir = new URL('../db/', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith('.test.js'))
      .filter((name) => {
        const text = readFileSync(new URL(name, dir), 'utf8');
        const selected = name.startsWith('postgres-') || name.startsWith('migration-identity-') || text.includes('JAREN_PG_URL');
        return selected && /no bun binary|bun is not on PATH/.test(text);
      });
    assert.deepEqual(offenders, []);
  });
});
