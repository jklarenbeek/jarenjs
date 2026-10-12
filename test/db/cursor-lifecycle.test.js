//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createCursor, createSyncCursor } from '../../packages/db/src/cursor.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
describe('cursor lifecycle across asynchronous source boundaries', () => {
  it('an abort during open releases the eventual iterator and awaits its acknowledgement', async () => {
    const opening = deferred();
    const entered = deferred();
    const closing = deferred();
    const closed = deferred();
    const controller = new AbortController();
    let releases = 0;
    let pulls = 0;
    const cursor = createCursor({ streaming: 'row', signal: controller.signal,
      open: () => { entered.resolve(); return opening.promise; }, items: (row) => [row] });
    const pulling = cursor.next();
    const failure = assert.rejects(pulling, { code: 'JD2072' });
    await entered.promise;
    controller.abort();
    const returning = cursor.return();
    let returned = false;
    returning.then(() => { returned = true; });
    opening.resolve({ next: () => { pulls++; return { done: false, value: 1 }; },
      return: () => { releases++; closed.resolve(); return closing.promise; } });
    await closed.promise;
    assert.equal(returned, false);
    closing.resolve({ done: true });
    await returning;
    await failure;
    assert.equal(releases, 1);
    assert.equal(pulls, 0);
  });
  it('return during a pending row never delivers the late row', async () => {
    const row = deferred();
    const entered = deferred();
    let releases = 0;
    const cursor = createCursor({ streaming: 'row', open: () => ({
      next: () => { entered.resolve(); return row.promise; },
      return: () => { releases++; return { done: true }; },
    }), items: (value) => [value] });
    const pending = cursor.next();
    await entered.promise;
    await cursor.return();
    row.resolve({ done: false, value: 9 });
    assert.equal((await pending).done, true);
    assert.equal(releases, 1);
  });
  it('concurrent pulls open one source and deliver each row once', async () => {
    let opens = 0;
    let value = 0;
    const cursor = createCursor({ streaming: 'row', open: async () => {
      opens++;
      return { next: async () => ({ done: false, value: ++value }), return: () => ({ done: true }) };
    }, items: (row) => [row] });
    const rows = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);
    assert.deepEqual(rows.map((row) => row.value), [1, 2, 3]);
    assert.equal(opens, 1);
    await cursor.return();
  });
  it('a synchronous cursor can discard many rows without recursive stack growth', () => {
    let row = 0;
    const cursor = createSyncCursor({ streaming: 'row',
      open: () => ({ next: () => ({ done: ++row > 100000, value: row }) }), items: () => [] });
    assert.equal(cursor.next().done, true);
    assert.equal(row, 100001);
  });
  it('an abort raised inside the deadline clock is JD2072 on the pull, never a quiet end', async () => {
    const build = (make) => {
      const controller = new AbortController();
      const spec = { streaming: 'row', signal: controller.signal, deadline: 1_000, items: (row) => [row],
        now: () => { controller.abort(); return 0; } };
      return make(spec);
    };
    const asynchronous = build((spec) => createCursor({ ...spec,
      open: () => (async function* () { yield 1; yield 2; })() }));
    await assert.rejects(asynchronous.next(), { code: 'JD2072' });
    const synchronous = build((spec) => createSyncCursor({ ...spec, open: () => [1, 2][Symbol.iterator]() }));
    assert.throws(() => synchronous.next(), { code: 'JD2072' });
    // a clock that does not abort keeps the rows flowing, and one past the
    // deadline is still the deadline's refusal
    const flowing = createSyncCursor({ streaming: 'row', deadline: 1_000, now: () => 0,
      open: () => [1, 2][Symbol.iterator](), items: (row) => [row] });
    assert.deepEqual([flowing.next().value, flowing.next().value, flowing.next().done], [1, 2, true]);
    const late = createSyncCursor({ streaming: 'row', deadline: 1_000, now: () => 2_000,
      open: () => [1][Symbol.iterator](), items: (row) => [row] });
    assert.throws(() => late.next(), { code: 'JD2075' });
  });
});

describe('cursor protocol disposal', () => {
  it('both iterator protocols release without pulling, and async disposal waits for cleanup', async () => {
    const sync = createSyncCursor({ streaming: 'row', open: () => { throw new Error('must stay lazy'); } });
    assert.equal(sync[Symbol.iterator](), sync);
    sync[Symbol.dispose]();
    assert.equal(sync.next().done, true);
    const acknowledgement = deferred();
    let released = false;
    const async = createCursor({ streaming: 'row', items: (row) => [row], open: () => ({
      next: () => ({ done: false, value: 1 }),
      return: () => { released = true; return acknowledgement.promise; },
    }) });
    assert.equal(async[Symbol.asyncIterator](), async);
    await async.next();
    const disposing = async[Symbol.asyncDispose]();
    assert.equal(released, true);
    acknowledgement.resolve({ done: true });
    await disposing;
    assert.equal((await async.next()).done, true);
  });
});
