//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunObservation } from '@jarenjs/app';
const page = (cursor, more = false) => ({ state: 'page', events: [{ runId: 'run', revision: cursor }], cursor,
  revision: 3, more, status: 'running', summary: { progress: cursor } });
const props = { runId: 'run', id: 7, update: 'progress', error: 'failed' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

it('pages sequentially, detaches on navigation and resumes from cursor without storing events', async () => {
  const cursors = [], dispatched = [];
  const pending = Promise.withResolvers();
  const observation = createRunObservation({ pageSize: 1, readPage: async (input) => {
    cursors.push(input.after);
    return input.after === 0 ? page(1, true) : input.after === 1 ? page(2) : pending.promise;
  }, wake: (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
  const stop = observation(props, (name, value) => dispatched.push({ name, value }));
  while (dispatched.length < 2) await tick();
  assert.deepEqual(cursors, [0, 1]);
  assert.equal(dispatched[1].value.cursor, 2);
  assert.equal(dispatched[1].value.events, undefined);
  stop(); stop();
  const detach = observation({ ...props, id: 8, cursor: 2 }, (name, value) => dispatched.push({ name, value }));
  await tick(); detach();
  pending.resolve(page(3)); await tick();
  assert.equal(dispatched.length, 2, 'late response cannot update departed view');
  observation.dispose(); observation.dispose();
  observation(props, () => assert.fail('disposed observer dispatched'))();
});

it('malformed/oversized pages and secret-bearing exceptions publish only a bounded public error', async () => {
  for (const bad of [() => { throw new Error('secret token'); }, () => ({ ...page(1), events: [1, 2, 3] }), () => ({ ...page(1), summary: 'x'.repeat(500) }), () => ({ ...page(1), cursor: 0, more: true }), () => ({ ...page(1), events: [{ runId: 'foreign', revision: 1 }] })]) {
    const done = Promise.withResolvers();
    const observation = createRunObservation({ readPage: bad, wake: () => {}, pageSize: 2, maxBytes: 400 });
    const stop = observation(props, (name, value) => done.resolve({ name, value }));
    const result = await done.promise;
    assert.equal(result.name, 'failed');
    assert.deepEqual(result.value.error, { code: 'run-observation-failed' });
    assert.ok(!JSON.stringify(result).includes('secret'));
    stop(); observation.dispose();
  }
});

it('lost history produces an explicit summary reset and active disposal detaches', async () => {
  const done = Promise.withResolvers();
  const observation = createRunObservation({ readPage: () => ({ ...page(3), state: 'reset-required', events: [] }),
    wake: (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
  observation(props, (_name, value) => done.resolve(value));
  assert.equal((await done.promise).reset, true);
  observation.dispose();
  assert.throws(() => createRunObservation({}), /capabilities/);
  assert.throws(() => createRunObservation({ readPage: () => {}, wake: () => {}, pageSize: Infinity }), /limits/);
  assert.throws(() => observation({ ...props, cursor: -1 }, () => {}), /cursor/);
});
