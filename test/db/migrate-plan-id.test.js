//@ts-check
/**
 * @file The name a plan gives its migration is a non-empty string. Any other
 * value made a document no runner accepts (`migration '5' is not a valid 0.1 or
 * 0.2 migration document`, at apply), and `jaren-db plan --id ''` wrote that
 * document to the file it was asked for.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planModelMigration, sqliteDialect } from '@jarenjs/db';
import { removeTempDirectory } from './helpers.js';

const FROM = { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } } } } } } };
const TO = JSON.parse(JSON.stringify(FROM));
TO.entities.T.schema.properties.note = { type: 'string' };

describe('planModelMigration id', () => {
  it('refuses a name that is no non-empty string, JD0013, before any plan', () => {
    for (const id of [5, '', {}, true, ['m']]) {
      assert.throws(() => planModelMigration(FROM, TO, { dialect: sqliteDialect, id: /** @type {any} */ (id) }),
        { code: 'JD0013', message: new RegExp(`^JD0013: planModelMigration\\(\\) option 'id' is a non-empty string, the migration's name in the history, got ${JSON.stringify(id).replace(/[[\]{}()*+?.\\^$|]/g, '\\$&')}$`) });
    }
  });

  it('a name given is the migration\'s; none (or null) is a name derived from its target', () => {
    assert.strictEqual(planModelMigration(FROM, TO, { dialect: sqliteDialect, id: 'add-note' }).migration.id, 'add-note');
    for (const options of [{ dialect: sqliteDialect }, { dialect: sqliteDialect, id: undefined }, { dialect: sqliteDialect, id: /** @type {any} */ (null) }])
      assert.match(planModelMigration(FROM, TO, options).migration.id, /^to-[0-9a-z]{1,8}$/);
  });

  it('jaren-db plan --id "" writes nothing and exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-plan-id-'));
    try {
      writeFileSync(join(dir, 'from.json'), JSON.stringify(FROM));
      writeFileSync(join(dir, 'to.json'), JSON.stringify(TO));
      const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', resolve('packages/db/src/cli.js'),
        'plan', '--from', 'from.json', '--to', 'to.json', '--id', '', '--out', 'm.json'], { encoding: 'utf8', cwd: dir });
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /^jaren-db: JD0013: planModelMigration\(\) option 'id' is a non-empty string/);
      assert.deepStrictEqual(readdirSync(dir).sort(), ['from.json', 'to.json']);
    }
    finally { removeTempDirectory(dir); }
  });
});
