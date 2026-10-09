// Runs under Bun: the adopted-table hop worlds through the real bun:sqlite driver. Every query must answer as the
// engine does over the documents the store holds, natively where it plans native, and the null-policy world must
// plan every correlation in the engine.
import { bunDriver } from '@jarenjs/db/bun';

import {
  leafWorld, leafQueries, nullPolicyWorld, nullPolicyQueries, openAdopted, checkAdoptedHops,
  HIDING_PROFILE, hidesFirst,
} from '../oracle/adopted-hops.js';

const runs = [
  [leafWorld, ['A', 'B'], leafQueries(), {}],
  [leafWorld, ['A', 'B'], leafQueries(), { profile: HIDING_PROFILE, visible: hidesFirst }],
  [nullPolicyWorld, ['C', 'D'], nullPolicyQueries(), {}],
];
const failures = [];
let queries = 0;
for (const [world, entities, list, options] of runs) {
  const { store, close } = await openAdopted({ kind: 'sqlite', driver: bunDriver() }, world);
  try {
    const checked = await checkAdoptedHops(store, entities, list, options);
    queries += list.length;
    failures.push(...checked.problems);
    if (world === nullPolicyWorld) {
      failures.push(...[...checked.planned].filter(([, plan]) => plan.reason !== 'entity.hopShape')
        .map(([name]) => `${name}: not entity.hopShape`));
    }
  }
  finally {
    await close();
  }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', queries, failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
