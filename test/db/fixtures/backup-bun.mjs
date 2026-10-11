// Under Bun, a file backup through the Bun driver: progress events,
// cancellation from inside onProgress, from a microtask and from a timer, a deadline on an
// injected clock, cleanup after a throw and after a close mid-copy, a
// point-in-time copy, page identity with the source, two identical runs,
// a memory store and a stale log at the target — one JSON line the
// spawning test reads.
import { openStore } from '@jarenjs/db';
import { bunDriver } from '@jarenjs/db/bun';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
const MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } } },
      key: '/id',
    },
  },
};
const file = (name) => join(directory, name);
const siblings = (target) => readdirSync(dirname(target))
  .filter((name) => name.startsWith(`${basename(target)}.jaren-tmp-`));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const failure = (promise) => promise.then(() => null, (error) => error);
const codeOf = (error) => error?.code ?? null;
/** Every committed document id of a backup file, read through a fresh store. */
async function idsOf(path) {
  const copy = await openStore(MODEL, { driver: bunDriver(), path, readOnly: true });
  const ids = [];
  for await (const id of copy.collection('notes').query({ $for: { it: '$[*]' }, $return: '$it.id' })) ids.push(id);
  await copy.close();
  return ids;
}

let clock = 0;
const source = file('source.db');
const store = await openStore(MODEL, { driver: bunDriver(), path: source, runtime: { now: () => clock } });
await store.transaction(async (tx) => {
  const notes = tx.collection('notes');
  for (let i = 0; i < 3000; i++) await notes.put({ id: `n${i}`, body: 'x'.repeat(4000) });
});
const report = {};

{
  const events = [];
  const full = await store.backupTo(file('full.db'), { rate: 100, onProgress: (event) => events.push(event) });
  report.full = { pages: full.pages, events: events.length, zero: events.filter((event) => event.remainingPages === 0).length };
}
{
  const target = file('abort.db');
  const controller = new AbortController();
  let events = 0;
  const error = await failure(store.backupTo(target, {
    rate: 100, signal: controller.signal,
    onProgress: () => { if (++events === 3) controller.abort(new Error('stop')); },
  }));
  report.abort = { code: codeOf(error), events, siblings: siblings(target) };
}
{
  // an abort raised by a microtask queued during the copy: Bun runs every
  // step before backup() returns, so the microtask runs after the last page
  // and before the copy settles through file I/O, and the abort lands before
  // publication
  const target = file('microtask.db');
  const controller = new AbortController();
  let events = 0;
  const error = await failure(store.backupTo(target, {
    rate: 100, signal: controller.signal,
    onProgress: () => { if (++events === 1) queueMicrotask(() => controller.abort(new Error('microtask'))); },
  }));
  report.microtask = { code: codeOf(error), events, published: existsSync(target), siblings: siblings(target) };
}
{
  // an abort raised by a timer queued during the copy: whether the timer
  // runs before the copy's file I/O settles is the event loop's to order
  // (under load it does not always), so the backup either stops at the abort
  // and publishes nothing or publishes the whole copy; no temporary file
  // remains either way
  const target = file('timer.db');
  const controller = new AbortController();
  let events = 0;
  const error = await failure(store.backupTo(target, {
    rate: 100, signal: controller.signal,
    onProgress: () => { if (++events === 1) setTimeout(() => controller.abort(new Error('timer')), 0); },
  }));
  report.timer = { code: codeOf(error), events, published: existsSync(target), siblings: siblings(target) };
}
{
  let calls = 0;
  const error = await failure(store.backupTo(file('deadline.db'), {
    rate: 100, deadline: 5, onProgress: () => { calls++; clock++; },
  }));
  report.deadline = { code: codeOf(error), calls };
}
{
  const target = file('thrown.db');
  const error = await failure(store.backupTo(target, { rate: 100, onProgress: () => { throw new Error('refused'); } }));
  report.thrown = { code: codeOf(error), cause: error?.cause?.message ?? null, siblings: siblings(target) };
}
{
  // a write issued from inside the copy waits for it: the copy is the
  // store as it stood when the copy began
  const target = file('point.db');
  let writing;
  await store.backupTo(target, {
    rate: 100, onProgress: () => { writing ??= store.collection('notes').insert({ id: 'during', body: 'd' }); },
  });
  await writing;
  report.pointInTime = {
    copyHasDuring: (await idsOf(target)).includes('during'),
    storeHasDuring: (await store.collection('notes').get('during')) != null,
  };
}
{
  await store.transaction(async (tx) => {
    const notes = tx.collection('notes');
    for (let i = 0; i < 3000; i += 3) await notes.delete(`n${i}`);
  });
  await store.checkpoint({ mode: 'truncate' });
  const target = file('identity.db');
  await store.backupTo(target, { checkpoint: false });
  const original = readFileSync(source);
  const copy = readFileSync(target);
  const encoded = original.readUInt16BE(16);
  const pageSize = encoded === 1 ? 65536 : encoded;
  const offsets = [];
  let differingPages = 0;
  // a page past either file's end counts as differing
  for (let start = 0; start < Math.max(original.length, copy.length); start += pageSize) {
    const a = original.subarray(start, start + pageSize);
    const b = copy.subarray(start, start + pageSize);
    if (a.length === b.length && a.equals(b)) continue;
    differingPages++;
    for (let i = 0; i < pageSize; i++) if (a[i] !== b[i]) offsets.push(start + i);
  }
  // the first 64 differing offsets suffice: only eight are allowed, so a
  // longer list always shows one that is not; the freelist page count is
  // the header's bytes 36-39
  report.identity = {
    differingPages, offsets: offsets.slice(0, 64), freelist: [original.readUInt32BE(36), copy.readUInt32BE(36)],
  };
}
{
  const first = file('two-a.db');
  const second = file('two-b.db');
  await store.backupTo(first);
  await store.backupTo(second);
  report.twoRun = sha256(first) === sha256(second);
}
{
  const target = file('stale.db');
  const writer = spawnSync(process.execPath, [fileURLToPath(new URL('./crashed-writer.mjs', import.meta.url)), target, 'wal'],
    { encoding: 'utf8' });
  if (writer.stdout !== 'crash:crashed-wal\n') throw new Error(`the writer did not crash as planned: ${writer.stderr}`);
  const before = [sha256(target), sha256(`${target}-wal`)];
  const error = await failure(store.backupTo(target));
  report.stale = { code: codeOf(error), targetUnchanged: sha256(target) === before[0] && sha256(`${target}-wal`) === before[1] };
}
{
  const target = file('closed.db');
  let events = 0;
  let closing;
  const error = await failure(store.backupTo(target, {
    rate: 100, onProgress: () => { if (++events === 2) closing = store.close(); },
  }));
  await closing;
  const cleanup = error?.cleanupError;
  report.closed = {
    code: codeOf(error),
    cleanupError: cleanup === undefined ? null : String(cleanup?.code ?? cleanup?.message ?? cleanup),
    siblings: siblings(target),
  };
}
await store.close();
{
  const memory = await openStore(MODEL, { driver: bunDriver() });
  for (let i = 0; i < 20; i++) await memory.collection('notes').insert({ id: `m${i}`, body: 'x'.repeat(400) });
  let events = 0;
  const resolved = await memory.backupTo(file('memory.db'), { rate: 1, onProgress: () => { events++; } })
    .then(() => true, () => false);
  await memory.close();
  report.memory = { events, resolved };
}
{
  // twenty backups leave no descriptor open on the source, and its close
  // is the file's last: the log is checkpointed and removed. (While another
  // connection in the process holds locks on a file, SQLite parks a closed
  // connection's descriptor for the next open to reuse: one, after the
  // first copy, until the last close.)
  const fds = '/proc/self/fd';
  if (existsSync(fds)) {
    const path = file('descriptors.db');
    const held = () => readdirSync(fds).filter((fd) => {
      try {
        const link = readlinkSync(`${fds}/${fd}`);
        return link === path || link.startsWith(`${path}-`);
      }
      catch { return false; }
    }).length;
    const owner = await openStore(MODEL, { driver: bunDriver(), path });
    for (let i = 0; i < 20; i++) await owner.collection('notes').insert({ id: `d${i}`, body: 'x'.repeat(4000) });
    await owner.backupTo(file('descriptors-0.db'), { rate: 10 });
    const first = held();
    for (let i = 1; i < 20; i++) await owner.backupTo(file(`descriptors-${i}.db`), { rate: 10 });
    const after = held();
    await owner.close();
    report.descriptors = {
      grew: after - first, afterClose: held(),
      sideFiles: readdirSync(directory).filter((name) => name.startsWith('descriptors.db-')),
    };
  }
  else report.descriptors = null;
}
{
  // a clock that never advances (fake timers): the backup still settles
  const owner = await openStore(MODEL, { driver: bunDriver(), path: file('stopped.db') });
  await owner.collection('notes').insert({ id: 's', body: 'x'.repeat(4000) });
  const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, setImmediate: globalThis.setImmediate };
  const never = () => ({ ref() { return this; }, unref() { return this; } });
  let watchdog;
  Object.assign(globalThis, { setTimeout: never, setInterval: never, setImmediate: never });
  const outcome = await Promise.race([
    owner.backupTo(file('stopped-copy.db')).then(() => 'settled', (error) => codeOf(error)),
    new Promise((resolve) => { watchdog = timers.setTimeout(() => resolve('never settled'), 5000); }),
  ]);
  Object.assign(globalThis, timers);
  clearTimeout(watchdog);
  report.stoppedTimers = outcome;
  // a backup that never settled still holds the store gate
  if (outcome === 'settled') await owner.close();
}
process.stdout.write(`${JSON.stringify(report)}\n`);
