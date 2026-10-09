// Runs under Bun: the join worlds (comparison families, null readings, the members an edge reads, member names that shadow
// the row identity) through the real bun:sqlite driver. Every query must plan as its world says and answer as the engine does.
// The groups to run are named on the command line: family, matrix, nulls, flavor, identity, order (all of them by default).
import { bunDriver } from '@jarenjs/db/bun';

import * as worlds from '../oracle/join-worlds.js';

const GROUPS = { family: worlds.FAMILY_WORLDS, matrix: worlds.FAMILY_MATRIX_WORLDS, nulls: worlds.NULL_WORLDS, flavor: worlds.FLAVOR_WORLDS, identity: worlds.IDENTITY_WORLDS, order: worlds.ORDER_WORLDS };
const named = process.argv.slice(2);
const failures = [];
let queries = 0;
for (const [group, list] of Object.entries(GROUPS)) {
  if (named.length > 0 && !named.includes(group)) continue;
  for (const world of list) {
    const store = await worlds.openSqliteWorld(bunDriver(), world);
    try {
      failures.push(...await worlds.checkWorld(store, world, 'sqlite'));
      queries += world.queries.length;
    }
    finally {
      await store.close();
    }
  }
}
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', queries, failures })}\n`);
process.exit(failures.length === 0 ? 0 : 1);
