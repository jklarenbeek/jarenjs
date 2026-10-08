// Run under Bun by test/db/capture-cascade-hosts.test.js: journal capture of
// the database's foreign-key actions on bun:sqlite — the corpus workload,
// then seeded random workloads checked record by record — printed as JSON
// lines, one per run.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { cascadeModel, seedCascade, cascadeWorkload, canonicalPatch, trialModel, randomWorkload }
  from '../oracle/cascade.js';

/** @param {any} value */
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const corpus = await openStore(cascadeModel(), { driver: bunDriver(), capture: { mode: 'journal' } });
try {
  print({ runtime: `bun ${process.versions.bun}`, capture: corpus.capabilities.capture });
  await seedCascade(corpus);
  const records = [];
  corpus.observe((record) => { records.push(record); });
  await cascadeWorkload(corpus);
  await corpus.entity('Parent').delete('r');
  print({ records: records.map((record) => canonicalPatch(record.patch)) });
}
finally { await corpus.close(); }

for (const seed of [1, 2, 3]) {
  const store = await openStore(trialModel(), { driver: bunDriver(), capture: { mode: 'journal' } });
  try { print({ seed, ...(await randomWorkload(store, seed, 20, { sync: true })) }); }
  finally { await store.close(); }
}
