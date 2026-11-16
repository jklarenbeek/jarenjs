//@ts-check
/**
 * @file The rules SQLite triggers are read back as, lowered on PostgreSQL:
 * over the same seeded streams, the PostgreSQL programs refuse exactly the
 * writes the original SQLite triggers refuse and leave the same rows. And
 * PostgreSQL's own trigger programs are not read back: each stays an
 * `unmapped-object` row, as before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { introspectModel } from '@jarenjs/db';
import { sqliteTriggers } from '@jarenjs/db/trigger-rules';
import { postgresEngine } from './invariant-oracle.js';
import { TRIGGER_FIXTURES, writeStream, differential } from './trigger-rules-oracle.js';

const url = process.env.JAREN_PG_URL;
describe('SQLite triggers read back as rules, lowered on PostgreSQL', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  for (const fixture of TRIGGER_FIXTURES) {
    it(`refuses exactly the writes the original SQLite triggers refuse (${fixture.name})`, async () => {
      for (const seed of [1, 2, 3]) {
        const result = await differential(fixture, postgresEngine(), writeStream(fixture, seed, 300));
        assert.equal(result.divergence, null, JSON.stringify(result.divergence));
        assert.equal(result.writes, 300);
      }
    });
  }

  it('reads no PostgreSQL trigger program back as a rule', async () => {
    const fixture = await postgresEngine().fixture({ postgres: 'CREATE TABLE notes(id integer PRIMARY KEY, body text NOT NULL); '
      + "CREATE FUNCTION notes_kept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notes are kept'; END $$; "
      + 'CREATE TRIGGER notes_kept BEFORE DELETE ON notes FOR EACH ROW EXECUTE FUNCTION notes_kept()' });
    try {
      const { model, report } = await introspectModel(await fixture.connection());
      const row = report.find((entry) => entry.object === 'notes_kept' && entry.code === 'unmapped-object');
      assert.ok(row !== undefined);
      assert.equal(row.reason, undefined);
      assert.equal(row.detail, 'an application-owned trigger program must be explicitly preserved; inspection grants no drop permission');
      assert.equal(report.some((entry) => entry.code === 'trigger-rule'), false);
      assert.equal(model.entities.notes.physical, undefined);
      // the SQLite reader passed on PostgreSQL reads nothing back, and says so
      const read = await introspectModel(await fixture.connection(), { triggers: sqliteTriggers });
      assert.equal(JSON.stringify(read.model), JSON.stringify(model));
      assert.equal(read.report.find((entry) => entry.object === 'notes_kept')?.reason,
        'the reader reads SQLite trigger programs, and this engine\'s are not read back');
    }
    finally { await fixture.dispose(); }
  });
});
