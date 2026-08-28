//#region the linq-roots relations groups
// Regenerates test/db/oracle/relations/14-linq-roots.json and
// 15-linq-hops.json from chains.
//
// Committed for the reason every generated fixture is: the differential
// oracle runs from a file on disk, and test/db/relations.test.js fails if
// either file drifts from what the chains emit — a hand-typed chain
// document is exactly the drift this prevents.
import * as fs from 'fs';
import * as path from 'path';

import { renderLinqRootsGroup, renderLinqHopsGroup } from './lib/linq-roots-cases.js';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const [file, render] of [
  ['14-linq-roots.json', renderLinqRootsGroup],
  ['15-linq-hops.json', renderLinqHopsGroup],
]) {
  const target = path.join(ROOT, 'test', 'db', 'oracle', 'relations', file);
  fs.writeFileSync(target, render());
  console.log(`wrote ${path.relative(ROOT, target)}`);
}

//#endregion
