//@ts-check
/**
 * @file Keyed/dynamic subscriptions (APP-FORMAT §5.3). Written
 * FAILING-FIRST against the shipped behaviour, where a subscription's
 * `with` was stored verbatim and never compiled, so props could not be
 * derived from state and a live subscription never restarted when its
 * inputs changed. The characterisation block pins the static behaviour
 * that must survive unchanged; the dynamic blocks specify the new
 * `withQuery`/`key` contract.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, AppCompileError } from '@jarenjs/app';

const sync = (flush) => flush();

function baseDoc() {
  return {
    state: { on: true, user: 'ada', n: 0 },
    view: [{ match: '$', body: ['p', {}, '$.user'] }],
    actions: {
      rename: { patch: [{ op: 'replace', path: '/user', value: '$payload' }] },
      bump: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] },
      off: { patch: [{ op: 'replace', path: '/on', value: false }] },
    },
  };
}

describe('static `with` — the preserved behaviour (characterisation)', () => {
  it('is passed verbatim (never evaluated) and never restarts on state change', () => {
    const doc = baseDoc();
    const calls = [];
    doc.subs = [{ run: 's', with: '$.user' }];
    const app = createApp(doc, {
      schedule: sync,
      subs: { s: (props) => { calls.push(props); } },
    });
    // the string arrives as data, not as a query result
    assert.deepStrictEqual(calls, ['$.user']);
    app.dispatch('rename', 'lin');
    app.dispatch('bump');
    assert.strictEqual(calls.length, 1, 'a static subscription starts exactly once');
    app.destroy();
  });
});

describe('withQuery — state-derived props with restart on key change', () => {
  it('resolves props against the state and restarts exactly once per change', () => {
    const doc = baseDoc();
    const calls = [];
    const cleaned = [];
    doc.subs = [{ run: 's', withQuery: { name: '$.user' } }];
    const app = createApp(doc, {
      schedule: sync,
      subs: {
        s: (props) => {
          calls.push(props);
          return () => cleaned.push(props);
        },
      },
    });
    assert.deepStrictEqual(calls, [{ name: 'ada' }]);
    app.dispatch('rename', 'lin');
    // stop-then-start, in that order, exactly once
    assert.deepStrictEqual(cleaned, [{ name: 'ada' }]);
    assert.deepStrictEqual(calls, [{ name: 'ada' }, { name: 'lin' }]);
    app.destroy();
  });

  it('an unchanged key performs zero handler calls across repeated transactions', () => {
    const doc = baseDoc();
    let starts = 0;
    doc.subs = [{ run: 's', withQuery: { name: '$.user' } }];
    const app = createApp(doc, {
      schedule: sync,
      subs: { s: () => { starts++; } },
    });
    assert.strictEqual(starts, 1);
    for (let i = 0; i < 10; i++) app.dispatch('bump'); // unrelated state
    assert.strictEqual(starts, 1, 'no key change, no restart');
    app.destroy();
  });

  it('an explicit `key` narrows restarts to the keyed fact', () => {
    const doc = baseDoc();
    const calls = [];
    doc.subs = [{
      run: 's',
      withQuery: { name: '$.user', count: '$.n' },
      key: '$.user',
    }];
    const app = createApp(doc, {
      schedule: sync,
      subs: { s: (props) => { calls.push(props); } },
    });
    app.dispatch('bump'); // props change, key does not
    assert.strictEqual(calls.length, 1, 'the key, not the props, decides');
    app.dispatch('rename', 'lin');
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1], { name: 'lin', count: 1 });
    app.destroy();
  });

  it('a throwing cleanup does not prevent the restart (JA2012 reported)', () => {
    const doc = baseDoc();
    const errors = [];
    const calls = [];
    doc.subs = [{ run: 's', withQuery: { name: '$.user' } }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        s: (props) => {
          calls.push(props);
          return () => { throw new Error('teardown boom'); };
        },
      },
    });
    app.dispatch('rename', 'lin');
    assert.deepStrictEqual(calls, [{ name: 'ada' }, { name: 'lin' }],
      'the restart happened despite the throwing cleanup');
    assert.strictEqual(errors.some((e) => e.code === 'JA2012'), true);
    app.destroy();
  });

  it('a throwing handler leaves the slot stopped (JA2013), retried on the next key change', () => {
    const doc = baseDoc();
    const errors = [];
    const calls = [];
    let attempts = 0;
    doc.subs = [{ run: 's', withQuery: { name: '$.user' } }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        s: (props) => {
          attempts++;
          if (attempts === 2) throw new Error('no resource');
          calls.push(props);
        },
      },
    });
    app.dispatch('rename', 'lin'); // restart attempt throws
    assert.strictEqual(errors.filter((e) => e.code === 'JA2013').length, 1);
    app.dispatch('rename', 'moa'); // next key change retries
    assert.deepStrictEqual(calls, [{ name: 'ada' }, { name: 'moa' }]);
    app.destroy();
  });

  it('a withQuery that throws at runtime fails closed with JA2016', () => {
    const doc = baseDoc();
    const errors = [];
    const calls = [];
    // $idiv by zero throws at evaluation time
    doc.subs = [{ run: 's', withQuery: { $idiv: ['$.n', '$.n'] }, when: '$.on' }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: { s: (props) => { calls.push(props); } },
    });
    assert.deepStrictEqual(calls, [], 'the subscription never started');
    const failure = errors.find((e) => e.code === 'JA2016');
    assert.ok(failure, 'JA2016 reported');
    assert.strictEqual(failure.docPath, '/subs/0/withQuery');
    app.destroy();
  });

  it('cyclic props are rejected with JA2016, never a hang', () => {
    const doc = baseDoc();
    // a host-provided initial state may carry a cycle; `stableStringify`
    // has no cycle guard, so key derivation must fail CLOSED
    const cyclic = { on: true };
    cyclic.self = cyclic;
    doc.state = cyclic;
    const errors = [];
    const calls = [];
    doc.subs = [{ run: 's', withQuery: '$' }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: { s: (props) => { calls.push(props); } },
    });
    assert.deepStrictEqual(calls, [], 'the subscription never started');
    const failure = errors.find((e) => e.code === 'JA2016');
    assert.ok(failure, 'JA2016 reported for the cyclic key derivation');
    assert.strictEqual(failure.docPath, '/subs/0/withQuery');
    app.destroy();
  });

  it('compile failures are JA0008 with the member docPath', () => {
    const doc = baseDoc();
    doc.subs = [{ run: 's', withQuery: { $frobnicate: 1 } }];
    assert.throws(() => createApp(doc, { schedule: sync, subs: { s: () => {} } }),
      (e) => e instanceof AppCompileError && e.code === 'JA0008'
        && e.docPath === '/subs/0/withQuery');
  });

  it('a free variable in withQuery is a compile error (closed world)', () => {
    const doc = baseDoc();
    doc.subs = [{ run: 's', withQuery: '$missing' }];
    assert.throws(() => createApp(doc, { schedule: sync, subs: { s: () => {} } }),
      (e) => e instanceof AppCompileError && e.code === 'JA0008');
  });

  it('`with` beside `withQuery` is an invalid combination (JA0008)', () => {
    const doc = baseDoc();
    doc.subs = [{ run: 's', with: { a: 1 }, withQuery: '$.user' }];
    assert.throws(() => createApp(doc, { schedule: sync, subs: { s: () => {} } }),
      (e) => e instanceof AppCompileError && e.code === 'JA0008'
        && e.docPath === '/subs/0');
  });

  it('`key` without `withQuery` or `for` is an invalid combination (JA0008)', () => {
    const doc = baseDoc();
    doc.subs = [{ run: 's', with: { a: 1 }, key: '$.user' }];
    assert.throws(() => createApp(doc, { schedule: sync, subs: { s: () => {} } }),
      (e) => e instanceof AppCompileError && e.code === 'JA0008');
  });

  it('`when` still gates liveness of a dynamic subscription', () => {
    const doc = baseDoc();
    const calls = [];
    const cleaned = [];
    doc.subs = [{ run: 's', when: '$.on', withQuery: { name: '$.user' } }];
    const app = createApp(doc, {
      schedule: sync,
      subs: {
        s: (props) => { calls.push(props); return () => cleaned.push(1); },
      },
    });
    app.dispatch('off');
    assert.strictEqual(cleaned.length, 1);
    app.dispatch('rename', 'lin'); // dead: key changes must not start it
    assert.strictEqual(calls.length, 1);
    app.destroy();
  });
});
