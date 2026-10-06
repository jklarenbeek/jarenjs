//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createStatementOwner, useStatementOnce } from '../../packages/db/src/driver.js';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';

/** A statement whose lifetime and receiver are observable. */
function statement(id, events, result = id) {
  let finalized = false;
  return {
    id,
    get() {
      assert.equal(this.id, id);
      assert.equal(finalized, false, 'a finalized statement was reused');
      events.push(['get', id]);
      return result;
    },
    finalize() {
      assert.equal(finalized, false, 'a statement was finalized twice');
      finalized = true;
      events.push(['finalize', id]);
    },
  };
}

it('a retained owner prepares eagerly, preserves synchronous returns and retires once', () => {
  const events = [];
  const metadata = { readOnly: true };
  let count = 0;
  const connection = { prepare(sql, options) {
    assert.equal(sql, 'SELECT 1');
    assert.equal(options, metadata);
    events.push(['prepare', ++count]);
    return statement(count, events);
  } };
  const owner = createStatementOwner(connection, 'SELECT 1', metadata);
  assert.deepEqual(events, [['prepare', 1]]);
  assert.equal(owner.use((s) => s.get()), 1);
  assert.equal(owner.use((s) => s.get()), 1);
  owner.retire();
  owner.retire();
  assert.deepEqual(events, [['prepare', 1], ['get', 1], ['get', 1], ['finalize', 1]]);
  assert.equal(owner.use((s) => s.get()), 2, 'a late use prepares a transient statement');
  assert.equal(owner.use((s) => s.get()), 3, 'late uses do not become another retained cache');
  assert.deepEqual(events.slice(-6), [['prepare', 2], ['get', 2], ['finalize', 2],
    ['prepare', 3], ['get', 3], ['finalize', 3]]);
});

it('retirement before an unused pending preparation resolves releases it exactly once', async () => {
  const prepared = Promise.withResolvers();
  const events = [];
  const owner = createStatementOwner({ prepare: () => prepared.promise }, 'SELECT 1');
  owner.retire();
  owner.retire();
  assert.deepEqual(events, []);
  prepared.resolve(statement(1, events));
  await prepared.promise;
  assert.deepEqual(events, [['finalize', 1]]);
});

it('retirement of a resolved async preparation releases capacity before the next prepare', async () => {
  const events = [];
  let active = 0;
  const connection = { async prepare(sql) {
    events.push(['prepare', sql]);
    assert.equal(active, 0, 'the previous statement still occupies the only slot');
    active++;
    return { get: () => sql, finalize: () => { active--; events.push(['finalize', sql]); } };
  } };
  const first = createStatementOwner(connection, 'first');
  assert.equal(await first.use((s) => s.get()), 'first');
  const reused = first.use((s) => s.get());
  assert.ok(reused instanceof Promise, 'a resolved async preparation keeps asynchronous return timing');
  assert.equal(await reused, 'first');
  first.retire();
  const second = createStatementOwner(connection, 'second');
  assert.equal(await second.use((s) => s.get()), 'second');
  second.retire();
  assert.deepEqual(events, [['prepare', 'first'], ['finalize', 'first'],
    ['prepare', 'second'], ['finalize', 'second']]);
  assert.equal(active, 0);
});

it('a worker with one statement slot accepts the next owner immediately after retirement', async () => {
  const connection = await nodeWorkerDriver({ maxStatements: 1 }).open(':memory:');
  try {
    for (let value = 1; value <= 4; value++) {
      const owner = createStatementOwner(connection, `SELECT ${value} AS n`);
      assert.equal((await owner.use((s) => s.get([]))).n, value);
      owner.retire();
    }
  }
  finally { await connection.close(); }
});

it('overlapping borrows share pending preparation and retire only after both operations settle', async () => {
  const prepared = Promise.withResolvers();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const events = [];
  let count = 0;
  const owner = createStatementOwner({ prepare: () => { count++; return prepared.promise; } }, 'SELECT 1');
  const read = (s, pending) => { s.get(); return pending.promise; };
  const a = owner.use((s) => read(s, first));
  const b = owner.use((s) => read(s, second));
  owner.retire();
  prepared.resolve(statement(1, events));
  await prepared.promise;
  assert.equal(count, 1);
  assert.deepEqual(events, [['get', 1], ['get', 1]]);
  first.resolve('first answer');
  assert.equal(await a, 'first answer');
  assert.deepEqual(events, [['get', 1], ['get', 1]]);
  const error = new Error('second operation failed');
  second.reject(error);
  await assert.rejects(b, (actual) => actual === error);
  assert.deepEqual(events, [['get', 1], ['get', 1], ['finalize', 1]]);
});

it('late uses while an earlier preparation is pending own separate transient handles', async () => {
  const prepared = Promise.withResolvers();
  const events = [];
  let count = 0;
  const owner = createStatementOwner({ prepare: () => ++count === 1
    ? prepared.promise : statement(count, events) }, 'SELECT 1');
  const pending = owner.use((s) => s.get());
  owner.retire();
  assert.equal(owner.use((s) => s.get()), 2);
  assert.deepEqual(events, [['get', 2], ['finalize', 2]]);
  prepared.resolve(statement(1, events));
  assert.equal(await pending, 1);
  assert.deepEqual(events, [['get', 2], ['finalize', 2], ['get', 1], ['finalize', 1]]);
});

it('retirement inside a synchronous call waits for its return or throw', () => {
  for (const throws of [false, true]) {
    const events = [];
    const owner = createStatementOwner({ prepare: () => statement(1, events) }, 'SELECT 1');
    const error = new Error('operation failed');
    const call = () => owner.use((s) => {
      owner.retire();
      assert.deepEqual(events, []);
      s.get();
      if (throws) throw error;
      return 'answer';
    });
    if (throws) assert.throws(call, (actual) => actual === error);
    else assert.equal(call(), 'answer');
    assert.deepEqual(events, [['get', 1], ['finalize', 1]]);
  }
});

it('synchronous preparation refusal precedes insertion and does not create an owner', () => {
  const error = new Error('prepare failed');
  let retained = false;
  assert.throws(() => {
    createStatementOwner({ prepare() { throw error; } }, 'SELECT 1');
    retained = true;
  }, (actual) => actual === error);
  assert.equal(retained, false);
});

it('a rejected preparation is forgotten, failed retry stays synchronous, and the next call can succeed', async () => {
  const refused = Promise.withResolvers();
  const error = new Error('prepare failed');
  const events = [];
  let count = 0, failures = 0;
  const owner = createStatementOwner({ prepare() {
    count++;
    if (count === 1) return refused.promise;
    if (count === 2) throw error;
    return statement(count, events);
  } }, 'SELECT 1', undefined, () => { failures++; });
  const first = owner.use((s) => s.get());
  refused.reject(error);
  await assert.rejects(first, (actual) => actual === error);
  assert.equal(failures, 1);
  assert.throws(() => owner.use((s) => s.get()), (actual) => actual === error);
  assert.equal(owner.use((s) => s.get()), 3);
  owner.retire();
  assert.deepEqual(events, [['get', 3], ['finalize', 3]]);
});

it('an unused rejected preparation can retire without leaking an unhandled rejection', async () => {
  const prepared = Promise.withResolvers();
  let failures = 0;
  const owner = createStatementOwner({ prepare: () => prepared.promise }, 'SELECT 1', undefined,
    () => { failures++; });
  owner.retire();
  prepared.reject(new Error('late preparation refusal'));
  await new Promise((resolve) => setImmediate(resolve));
  owner.retire();
  assert.equal(failures, 1);
});

it('retirement and transient use preserve answers and errors when finalize is absent, throws or rejects', async () => {
  for (const cleanup of ['absent', 'throw', 'reject']) {
    for (const asynchronous of [false, true]) {
      for (const fails of [false, true]) {
        const error = new Error('operation refused');
        let finalized = 0;
        const connection = { prepare: () => ({ ...(cleanup === 'absent' ? {} : {
          finalize() {
            finalized++;
            if (cleanup === 'throw') throw new Error('finalize threw');
            return Promise.reject(new Error('finalize rejected'));
          },
        }) }) };
        const owner = createStatementOwner(connection, 'SELECT 1');
        owner.retire();
        const use = () => {
          if (asynchronous) return fails ? Promise.reject(error) : Promise.resolve(42);
          if (fails) throw error;
          return 42;
        };
        if (asynchronous && fails) await assert.rejects(owner.use(use), (actual) => actual === error);
        else if (fails) assert.throws(() => owner.use(use), (actual) => actual === error);
        else {
          const answer = owner.use(use);
          if (!asynchronous) assert.equal(answer, 42);
          assert.equal(await answer, 42);
        }
        assert.equal(finalized, cleanup === 'absent' ? 0 : 2);
      }
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
});

it('one-use statements keep their preparation arguments and asynchronous cleanup contract', async () => {
  const prepared = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const events = [];
  const connection = { prepare(...args) { events.push(args); return prepared.promise; } };
  const pending = useStatementOnce(connection, 'SELECT 1', (s) => { s.get(); return finished.promise; });
  assert.deepEqual(events, [['SELECT 1']]);
  prepared.resolve(statement(1, events));
  await prepared.promise;
  assert.deepEqual(events, [['SELECT 1'], ['get', 1]]);
  finished.resolve('finished');
  assert.equal(await pending, 'finished');
  assert.deepEqual(events, [['SELECT 1'], ['get', 1], ['finalize', 1]]);
});
