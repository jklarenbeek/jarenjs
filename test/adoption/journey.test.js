//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDriver } from '@jarenjs/db/node';
import { runAdoptionJourney } from '../consumer/journey.js';
import { openAdoption } from '../../packages/website/src/examples/adoption.js';
import { seedAdoptionFile } from '../../packages/website/src/examples/adoption-fixture.js';
import { adoptionRule } from '../../packages/website/src/examples/adoption-model.js';
import { adoptionRows } from '../../scripts/lib/adoption.js';
import { readAdoption } from './evidence.js';

for (const frozen of readAdoption('manifest.json').consumers) it(`combined ${frozen.id}: public policy, data, receipts, provider snapshot and runs survive restart`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-journey-'));
  const definition = { ...frozen, rows: 256 };
  try { await runAdoptionJourney({ openAdoption, seedAdoptionFile, adoptionRule, driver: nodeDriver(), path: join(directory, 'app.sqlite'),
    definition, rows: adoptionRows(definition), originals: readAdoption('fixtures/formulas.json').formulas }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

it('disposal drains an admitted snapshot and fences late index publication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-journey-dispose-'));
  const definition = { ...readAdoption('manifest.json').consumers[0], rows: 256 };
  const options = { driver: nodeDriver(), path: join(directory, 'app.sqlite'), definition };
  try {
    await seedAdoptionFile({ ...options, rows: adoptionRows(definition), originals: readAdoption('fixtures/formulas.json').formulas });
    const app = await openAdoption({ ...options, transport: async () => new Response('{}') });
    const first = app.query('tea'); const stale = assert.rejects(first, /superseded/);
    await app.query('coffee'); await stale;
    assert.equal((await app.refresh()).changes, 0);
    const pending = app.query('tea'); const rejected = assert.rejects(pending, /disposed/);
    await app.close(); await rejected; await app.close();
    await assert.rejects(app.query('tea'), /disposed/);
  }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

it('failed application setup releases the adopted connection and permits an unchanged second open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-journey-setup-'));
  const definition = { ...readAdoption('manifest.json').consumers[0], rows: 256 };
  const driver = nodeDriver(), path = join(directory, 'app.sqlite');
  const handles = new Set(); let opens = 0, closes = 0;
  const tracked = { ...driver, async open(...args) {
    const handle = await driver.open(...args); handles.add(handle); opens++;
    return { ...handle, async close() { closes++; handles.delete(handle); await handle.close(); } };
  } };
  try {
    await seedAdoptionFile({ driver, path, definition, rows: adoptionRows(definition), originals: readAdoption('fixtures/formulas.json').formulas });
    const invalid = structuredClone(definition); invalid.budgets.providers.pages = 0;
    for (const [profile, transport, code] of [[definition, false, 'JC1012'], [invalid, async () => new Response('{}'), 'JC0021']]) {
      await assert.rejects(openAdoption({ driver: tracked, path, definition: profile, transport }), { code });
      assert.equal(handles.size, 0, 'setup refusal must release the opened database');
      assert.equal(closes, opens);
    }
    const app = await openAdoption({ driver: tracked, path, definition, transport: async () => new Response('{}') });
    assert.equal((await app.rows()).length, 128);
    await app.close(); await app.close();
    assert.equal(handles.size, 0); assert.equal(closes, opens);
  }
  finally { for (const handle of handles) await handle.close(); rmSync(directory, { recursive: true, force: true }); }
});
