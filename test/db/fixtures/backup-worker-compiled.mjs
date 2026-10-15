// The entry of a `bun build --compile` executable: a store on the real Bun
// binding, written, then backed up three times — once to completion with a
// timer ticking beside the copy, once aborted by a timer the first progress
// event arms, once stopped by a deadline a timer passes on the store's clock.
// Every timer that runs between two progress events ran while the copy did.
// One JSON line on stdout, which the spawning test reads.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { existsSync, readdirSync } from 'node:fs';

const ROWS = 3000;
const MODEL = {
  $model: '0.1',
  collections: {
    notes: { schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } }, key: '/id' },
  },
};
const leftovers = () => readdirSync('.').filter((name) => name.includes('.jaren-tmp-')).sort();
const failure = (promise) => promise.then(() => null, (error) => error);

let clock = 0;
const store = await openStore(MODEL, { driver: bunDriver(), path: 'source.db', runtime: { now: () => clock } });
await store.transaction(async (tx) => {
  const notes = tx.collection('notes');
  for (let i = 0; i < ROWS; i++) await notes.put({ id: `n${i}`, body: 'x'.repeat(4000) });
});
const report = { runtime: typeof Bun === 'undefined' ? 'node' : 'bun', compiled: import.meta.url.startsWith('file:///$bunfs/') };

{
  // a copy to completion; a timer ticks every millisecond meanwhile, and a
  // tick that saw some events but not the last one ran during the copy
  let events = 0;
  const seen = [];
  const ticker = setInterval(() => { seen.push(events); }, 1);
  const done = await store.backupTo('complete.db', { rate: 1, onProgress: () => { events++; } });
  clearInterval(ticker);
  const ticksDuringCopy = seen.filter((count) => count > 0 && count < events).length;
  const copy = await openStore(MODEL, { driver: bunDriver(), path: 'complete.db', readOnly: true });
  const ids = [];
  for await (const id of copy.collection('notes').query({ $for: { it: '$[*]' }, $return: '$it.id' })) ids.push(id);
  await copy.close();
  const expected = Array.from({ length: ROWS }, (_, i) => `n${i}`).sort();
  report.complete = { pages: done.pages, events, ticksDuringCopy, rows: ids.length,
    everyRow: JSON.stringify(ids.sort()) === JSON.stringify(expected) };
}
{
  // a timer armed by the first progress event aborts the copy; the ticks
  // from the abort to the settlement measure the copy the abort spared
  const controller = new AbortController();
  let events = 0, eventsWhenFired = null, ticks = 0, ticksWhenFired = null;
  const ticker = setInterval(() => { ticks++; }, 1);
  const error = await failure(store.backupTo('aborted.db', {
    rate: 1, signal: controller.signal,
    onProgress: () => {
      if (++events !== 1) return;
      setTimeout(() => {
        [eventsWhenFired, ticksWhenFired] = [events, ticks];
        controller.abort(new Error('timer'));
      }, 0);
    },
  }));
  clearInterval(ticker);
  report.aborted = { code: error?.code ?? null, events, eventsWhenFired, published: existsSync('aborted.db'),
    ticksAfterAbort: ticksWhenFired === null ? null : ticks - ticksWhenFired };
}
{
  // a timer armed by the first progress event passes the deadline
  let events = 0, eventsWhenFired = null;
  const error = await failure(store.backupTo('deadline.db', {
    rate: 1, deadline: 1,
    onProgress: () => {
      if (++events === 1) setTimeout(() => { eventsWhenFired = events; clock = 2; }, 0);
    },
  }));
  report.deadline = { code: error?.code ?? null, events, eventsWhenFired, published: existsSync('deadline.db') };
}
await store.close();
report.leftovers = leftovers();
process.stdout.write(`${JSON.stringify(report)}\n`);
