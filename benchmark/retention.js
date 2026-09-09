//@ts-check
import { writeFileSync } from 'node:fs';
import { retentionFixture, measureRetention } from './lib/retention.js';
const fixture = await retentionFixture();
const rows = [];
for (const maxItems of [48, 24, 8, 4])
  for (const policy of ['none', 'oldest', 'unreferenced', 'checkpoint'])
    rows.push(await measureRetention(fixture, maxItems, policy));
const result = { version: 1, instrument: 'ledger-retention', seed: 73, rounds: 48,
  bars: { referencedResolution: 1, resumedCorrectness: 1, retrievalRecall10: 1 },
  decision: { archive: 'unreferenced', goal: 'lossless-dictionary',
    rationale: 'Refuse an impossible budget; preserve admitted references and exact progress evidence.' },
  quota: { universalBytes: null, note: 'Quota depends on host, origin usage and browser mode; failures must be observed.' }, rows };
writeFileSync(new URL('./retention-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(rows.map((r) => `${r.maxItems}\t${r.policy}\t${r.footprint.bytes}\t${r.referencedResolution}\t${r.goalChars}`).join('\n') + '\n');
