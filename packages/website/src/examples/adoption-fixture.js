//@ts-check
/** Synthetic pre-existing file creation. SQL belongs only to this retained fixture. */
import { open } from '@jarenjs/linq/db';
import { adoptionModel, adoptionRule } from './adoption-model.js';

/** Provision once, before adoption; subsequent consumers never call this on an existing file. */
export async function seedAdoptionFile({ driver, path, definition, rows, originals }) {
  const model = adoptionModel(definition), physical = model.entities.Item.physical;
  const db = await driver.open(path);
  try {
    const column = (name) => `"${physical.columns[name].name}"`;
    const types = { text: 'TEXT', integer: 'INTEGER', number: 'REAL' };
    db.exec(`CREATE TABLE "${physical.table}" (${Object.entries(physical.columns).map(([name, value]) => `${column(name)} ${types[value.codec]}${value.null === 'reject' ? ' NOT NULL' : ''}`).join(',')}, PRIMARY KEY (${physical.keys.map(column).join(',')}));
      CREATE TABLE original_history (id TEXT, revision INTEGER, amount REAL);
      INSERT INTO original_history VALUES ('historic-row',7,19);
      CREATE TABLE original_bytes (body BLOB);
      INSERT INTO original_bytes VALUES (X'0001ff80');
      CREATE TRIGGER preserve_history AFTER UPDATE ON "${physical.table}" BEGIN
        INSERT INTO original_history VALUES (NEW.${column('id')}, NEW.${column('revision')}, NEW.${column('amount')}); END;`);
    const names = Object.keys(physical.columns);
    const insert = db.prepare(`INSERT INTO "${physical.table}" (${names.map(column).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
    db.exec('BEGIN');
    try { for (const row of rows) insert.run(names.map((name) => name === 'amount' ? 0 : row[name])); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  finally { await db.close(); }
  const client = await open(model, { driver, path, jobs: true });
  try {
    await client.transaction(async (tx) => {
      await tx.collections.settings.insert({ id: 'rule', definition: adoptionRule });
      await tx.collections.settings.insert({ id: 'originals', sources: originals });
      await tx.collections.settings.insert({ id: 'history', value: 'preserve original settings' });
      await tx.jobs.enqueue('historic', { original: true }, { id: 'historic-job' });
    });
  }
  finally { await client.close(); }
}
