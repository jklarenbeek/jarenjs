//@ts-check
/** Standalone synthetic retention probe; run with Node --expose-gc or Bun. */
import { compileEntityModel } from '@jarenjs/db/model';
import { entityCore } from '@jarenjs/db/entity';
import { model } from './mutation-model.mjs';
const runtime = process.versions.bun ? await import('@jarenjs/db/bun') : await import('@jarenjs/db/node');
const db = await (process.versions.bun ? runtime.bunDriver() : runtime.nodeDriver()).open(':memory:');
db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);INSERT INTO entries VALUES(1,'seed')");
const { entities, mapping } = compileEntityModel(model);
let prepares = 0;
const connection = Object.create(db);
Object.defineProperty(connection, 'prepare', { value: (text, options) => { prepares++; return db.prepare(text, options); } });
const core = entityCore(connection, entities.get('Entry'), mapping.entities.Entry, null);
const sample = async () => {
  for (let i = 0; i < 3; i++) {
    if (process.versions.bun) globalThis.Bun.gc(true); else globalThis.gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return process.memoryUsage();
};
core.mutate({ op: 'update', key: 1, set: { payload: 'warm' }, returning: ['id'] });
const before = await sample();
prepares = 0;
const start = performance.now();
for (let i = 0; i < 128; i++) {
  const payload = `${i}:` + 'x'.repeat(65_536 - String(i).length - 1);
  core.mutate({ op: 'update', key: 1, set: { payload }, returning: ['id'] });
}
const varyingMs = performance.now() - start;
const after = await sample();
const varyingPrepares = prepares;
const identical = { op: 'update', key: 1, set: { payload: 'same' }, returning: ['id'] };
core.mutate(identical);
const hotStart = performance.now();
for (let i = 0; i < 1000; i++) core.mutate(identical);
process.stdout.write(JSON.stringify({ host: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
  fixture: { entities: 1, varyingWrites: 128, payloadBytes: 65_536, identicalWrites: 1000 }, varyingPrepares,
  heapBefore: before.heapUsed, heapAfter: after.heapUsed, retainedHeapDelta: after.heapUsed - before.heapUsed,
  rssBefore: before.rss, rssAfter: after.rss, varyingMs, identicalMs: performance.now() - hotStart,
  result: db.prepare('SELECT payload FROM entries').get([]).payload }) + '\n');
db.close();
