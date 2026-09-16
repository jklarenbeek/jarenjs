//@ts-check
import { it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeDriver } from '@jarenjs/db/node';
import { qualifyBackendApp } from '../consumer/backend-app.js';

it('one public app/contract/Store composition preserves durable local outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jaren-backend-app-'));
  const target = name => ({ driver: nodeDriver(), path: join(directory, `${name}.sqlite`), replication: { replica: name } });
  try { await qualifyBackendApp(target('app'), target('peer')); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
