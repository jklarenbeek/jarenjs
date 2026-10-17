//@ts-check
/**
 * @file The app pen's awaiting action (APP-PEN §2.2, APP-FORMAT §3.3):
 * `awaiting()` writes one `{ "$await": … }` action whose members are each
 * captured in the scope the runtime binds there — `$result` in `then`,
 * `$error` in `catch`, neither in `start` or `with` — and the document it
 * writes runs under `createApp`: the start commits, a superseded await is
 * dropped, the continuation lands, and a failure continues through catch.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { awaiting, defineApp, replace, transition, when } from '@jarenjs/linq/app';
import * as s from '@jarenjs/linq/schema';
import { createApp } from '@jarenjs/app';

/** @param {string} code @param {RegExp} [pattern] */
const coded = (code, pattern = /./) => (/** @type {any} */ error) => error.code === code && pattern.test(error.message);

const detail = awaiting({
  start: () => transition({ patch: [replace((/** @type {any} */ st) => st.status, 'loading')] }),
  run: 'fetchJson',
  with: (/** @type {any} */ st, /** @type {any} */ x) => ({ url: st.base.concat(x.payload) }),
  slot: 'detail',
  then: (/** @type {any} */ st, /** @type {any} */ x) => transition({ patch: [
    replace((/** @type {any} */ c) => c.status, 'done'),
    replace((/** @type {any} */ c) => c.detail, x.result)] }),
  catch: (/** @type {any} */ st, /** @type {any} */ x) => when(x.error.code.eq('JA2028'), transition({ patch: [
    replace((/** @type {any} */ c) => c.status, 'error'),
    replace((/** @type {any} */ c) => c.error, x.error)] })),
});

describe('awaiting() writes the $await form', () => {
  it('captures each member over its own scope, in the order APP-FORMAT §3.3 lists them', () => {
    assert.deepEqual(detail.document, { $await: {
      start: { patch: [{ op: 'replace', path: '/status', value: 'loading' }] },
      run: 'fetchJson',
      with: { url: { $concat: ['$.base', '$payload'] } },
      slot: 'detail',
      then: { patch: [
        { op: 'replace', path: '/status', value: 'done' },
        { op: 'replace', path: '/detail', value: '$result' }] },
      catch: { $if: [{ $eq: ['$error.code', 'JA2028'] }, { patch: [
        { op: 'replace', path: '/status', value: 'error' },
        { op: 'replace', path: '/error', value: '$error' }] }] },
    } });
    assert.ok(Object.isFrozen(detail));
  });

  it('writes run alone, and takes a with written by hand', () => {
    assert.deepEqual(awaiting({ run: 'tick' }).document, { $await: { run: 'tick' } });
    assert.deepEqual(awaiting({ run: 'tick', with: { ms: 10 } }).document, { $await: { run: 'tick', with: { ms: 10 } } });
  });

  it('refuses what the runtime would refuse when the app compiles, naming the member', () => {
    const cases = /** @type {Array<[() => unknown, string, RegExp]>} */ ([
      [() => awaiting(/** @type {any} */ (7)), 'JL0101', /^JL0101: awaiting\(\) takes \{ run, start\?, with\?, slot\?, then\?, catch\? \}, got 7$/],
      [() => awaiting(/** @type {any} */ ({ run: 'f', nope: 1 })), 'JL0101', /does not take 'nope' — it takes start, run, with, slot, then, catch at \/nope$/],
      [() => awaiting({ run: '' }), 'JL0101', /awaiting\(\) run is the registered effect's name as a non-empty string, got a string at \/run$/],
      [() => awaiting(/** @type {any} */ ({ run: 'f', slot: 3 })), 'JL0101', /awaiting\(\) slot is the await's identity as a non-empty string, got 3 at \/slot$/],
      [() => awaiting(/** @type {any} */ ({ run: 'f', start: {} })), 'JL0101', /awaiting\(\) start is a callback .* at \/start$/],
      [() => awaiting({ run: 'f', then: (/** @type {any} */ st, /** @type {any} */ x) => transition({ state: x.error }) }),
        'JL0104', /awaiting\(\) then rule cannot bind 'error' .* a failure reaches catch, as \$error$/],
      [() => awaiting({ run: 'f', catch: (/** @type {any} */ st, /** @type {any} */ x) => transition({ state: x.result }) }),
        'JL0104', /awaiting\(\) catch rule cannot bind 'result' .* a result reaches then, as \$result$/],
      [() => awaiting({ run: 'f', with: (/** @type {any} */ st, /** @type {any} */ x) => x.result }),
        'JL0104', /awaiting\(\) with rule cannot bind 'result' .* binds \$event, \$payload in with and nothing else$/],
      [() => awaiting({ run: 'f', with: () => when(true, transition({})) }), 'JL0005', /the capture in progress is not an action's/],
      [() => awaiting({ run: 'f' }, /** @type {any} */ ({ nope: 1 })), 'JL0101', /awaiting\(\) does not take 'nope' — it takes payload, event/],
      [() => awaiting({ run: 'f' }, /** @type {any} */ ({ event: ['target'] })), 'JL0102', /cannot request 'target'/],
    ]);
    for (const [run, code, pattern] of cases) assert.throws(run, coded(code, pattern), pattern.source);
  });
});

describe('the document awaiting() writes runs under createApp', () => {
  const app = () => {
    const State = s.object({
      base: s.string().default('/api/items/'),
      status: s.string().default('idle'),
      detail: s.any().default(null),
      error: s.any().default(null),
    });
    const { document } = defineApp({ state: State, view: [], actions: { open: detail } });
    /** @type {Array<{ props: any, signal: AbortSignal, resolve: (value: any) => void, reject: (reason: any) => void }>} */
    const calls = [];
    const running = createApp(document, {
      schedule: (/** @type {() => void} */ flush) => flush(),
      effects: { fetchJson: (/** @type {any} */ props, /** @type {any} */ _dispatch, /** @type {any} */ { signal }) =>
        new Promise((resolve, reject) => { calls.push({ props, signal, resolve, reject }); }) },
    });
    return { running, calls };
  };

  it('commits the start, drops the superseded await and lands the newest result', async () => {
    const { running, calls } = app();
    running.dispatch('open', 'a');
    running.dispatch('open', 'b');
    assert.equal(running.getState().status, 'loading');
    assert.deepEqual(calls.map((call) => call.props), [{ url: '/api/items/a' }, { url: '/api/items/b' }]);
    assert.equal(calls[0].signal.aborted, true);
    calls[1].resolve({ id: 'b' });
    calls[0].resolve({ id: 'a' });
    const state = await running.settled({ awaits: true });
    assert.deepEqual([state.status, state.detail, state.error], ['done', { id: 'b' }, null]);
  });

  it('continues a failure through catch with the coded $error', async () => {
    const { running, calls } = app();
    running.dispatch('open', 'x');
    calls[0].reject(new Error('offline'));
    const state = await running.settled({ awaits: true });
    assert.deepEqual([state.status, state.error], ['error', { code: 'JA2028', message: 'offline' }]);
  });
});
