//#region the linq-roots relations group
// Regenerates test/db/oracle/relations/14-linq-roots.json from chains.
//
// Committed for the reason every generated fixture is: the differential
// oracle runs from a file on disk, and test/db/relations.test.js fails if
// this file drifts from what the chains emit — a hand-typed chain document
// is exactly the drift this prevents.
import * as fs from 'fs';
import * as path from 'path';

import { renderLinqRootsGroup } from './lib/linq-roots-cases.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = path.join(ROOT, 'test', 'db', 'oracle', 'relations', '14-linq-roots.json');
fs.writeFileSync(target, renderLinqRootsGroup());
console.log(`wrote ${path.relative(ROOT, target)}`);

//#endregion
