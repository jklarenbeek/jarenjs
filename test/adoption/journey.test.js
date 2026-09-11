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
