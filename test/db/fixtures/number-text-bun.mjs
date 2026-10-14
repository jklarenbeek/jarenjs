// Runs under Bun: a number and a boolean member retyped to text by a planned
// rebuild through the real bun:sqlite driver, read back through the store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, sqliteDialect } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { NUMBERS, retypeToText } from '../oracle/number-text.js';

const failures = [];
for (const [from, values] of [['number', NUMBERS], ['boolean', [true, false]]]) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-number-text-'));
  const path = join(dir, 'store.db');
  try {
    const { texts } = await retypeToText({ dialect: sqliteDialect, open: (model) => openStore(model, { driver: bunDriver(), path }),
      target: { driver: bunDriver(), path } }, from, values);
    for (const [at, value] of values.entries()) {
      if (texts[at] !== String(value)) failures.push(`${from} ${String(value)} read back as ${JSON.stringify(texts[at])}`);
    }
  }
  catch (error) { failures.push(String(error?.message ?? error)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
