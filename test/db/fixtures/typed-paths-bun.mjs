// Runs under Bun: the typed scalar path comparison group through the real bun:sqlite driver, which has no user
// functions. Every case must plan as the shared table says and answer as the engine does, indexed and not.
import { bunDriver } from '@jarenjs/db/bun';

import { storeForGroup } from '../oracle/harness.js';
import { typedPathsGroup, checkTypedPaths, openNullPolicy, checkNullPolicy } from '../oracle/typed-paths.js';

const group = typedPathsGroup();
const failures = [];
for (const side of ['indexed', 'unindexed']) {
  const { store, collection } = await storeForGroup(group, bunDriver(), side);
  try {
    failures.push(...await checkTypedPaths(collection, group, 'bare', side));
  }
  finally {
    await store.close();
  }
}
const opened = await openNullPolicy({ kind: 'sqlite', driver: bunDriver() });
try {
  failures.push(...await checkNullPolicy(opened.store));
}
finally {
  await opened.close();
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', cases: group.cases.length * 2, failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
