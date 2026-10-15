//@ts-check
/** Report whether the loop drains after leaving the named resource open; run by resources.test.js on each host. */
import { createServer } from 'node:net';
import { loopDrains } from '../../benchmark/adoption-resources-entry.js';

const held = process.argv[2];
if (held === 'unreferenced-timer') setTimeout(() => {}, 50).unref();
if (held === 'interval') setInterval(() => {}, 1000);
if (held === 'server') createServer().listen(0);
loopDrains().then((drained) => {
  const listed = process.getActiveResourcesInfo();
  process.stdout.write(JSON.stringify({ listed, drained }) + '\n');
  if (!drained) process.exit(0);
});
