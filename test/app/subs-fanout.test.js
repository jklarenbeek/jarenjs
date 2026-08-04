//@ts-check
/**
 * @file Subscription fan-out (APP-FORMAT §5.3): one declaration with a
 * `for` query, one running instance per item key in the state-derived
 * set. Written failing-first, like the dynamic suite.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp } from '@jarenjs/app';

const sync = (flush) => flush();

function feedDoc() {
  return {
    state: { on: true, feeds: ['a', 'b'] },
    view: [{ match: '$', body: ['p', {}, 'feeds'] }],
    actions: {
      set: { patch: [{ op: 'replace', path: '/feeds', value: '$payload' }] },
      off: { patch: [{ op: 'replace', path: '/on', value: false }] },
    },
  };
}

/** A handler that logs starts and stops per props value. */
function logger(log) {
  return (props) => {
    log.push(['start', props]);
    return () => log.push(['stop', props]);
  };
}

describe('subscription fan-out (`for`)', () => {
  it('starts one instance per item, in document order; props default to the item', () => {
    const doc = feedDoc();
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    assert.deepStrictEqual(log, [['start', 'a'], ['start', 'b']]);
    app.destroy();
  });

  it('diffs the key set: removed stop, added start, survivors untouched', () => {
    const doc = feedDoc();
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    log.length = 0;
    app.dispatch('set', ['b', 'c']); // a removed, b survives, c added
    assert.deepStrictEqual(log, [['stop', 'a'], ['start', 'c']]);
    app.destroy();
  });

  it('withQuery shapes per-instance props via $item; a props change restarts that instance only', () => {
    const doc = feedDoc();
    doc.state = { on: true, feeds: ['a', 'b'], tick: 0 };
    doc.actions.bump = { patch: [{ op: 'replace', path: '/tick', value: { $add: ['$.tick', 1] } }] };
    const log = [];
    doc.subs = [{
      run: 'feed',
      for: '$.feeds',
      withQuery: { id: '$item', tick: '$.tick' },
      key: '$item',
    }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    assert.deepStrictEqual(log, [
      ['start', { id: 'a', tick: 0 }],
      ['start', { id: 'b', tick: 0 }],
    ]);
    log.length = 0;
    app.dispatch('bump'); // every instance's props changed → each restarts
    assert.deepStrictEqual(log, [
      ['stop', { id: 'a', tick: 0 }], ['start', { id: 'a', tick: 1 }],
      ['stop', { id: 'b', tick: 0 }], ['start', { id: 'b', tick: 1 }],
    ]);
    app.destroy();
  });

  it('duplicate keys collapse to one instance (first occurrence order)', () => {
    const doc = feedDoc();
    doc.state.feeds = ['a', 'b', 'a'];
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    assert.deepStrictEqual(log, [['start', 'a'], ['start', 'b']]);
    app.destroy();
  });

  it('a dead `when` stops every instance; destroy cleans the rest', () => {
    const doc = feedDoc();
    const log = [];
    doc.subs = [{ run: 'feed', when: '$.on', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    log.length = 0;
    app.dispatch('off');
    assert.deepStrictEqual(log, [['stop', 'a'], ['stop', 'b']]);
    app.destroy();
  });

  it('destroy stops live instances', () => {
    const doc = feedDoc();
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    log.length = 0;
    app.destroy();
    assert.deepStrictEqual(log, [['stop', 'a'], ['stop', 'b']]);
  });

  it('the instance bound fires JA2017 and keeps the previous set', () => {
    const doc = feedDoc();
    const errors = [];
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, {
      schedule: sync,
      maxSubInstances: 3,
      onError: (err) => errors.push(err),
      subs: { feed: logger(log) },
    });
    log.length = 0;
    app.dispatch('set', ['a', 'b', 'c', 'd']); // 4 > 3
    const bound = errors.find((e) => e.code === 'JA2017');
    assert.ok(bound, 'JA2017 reported');
    assert.strictEqual(bound.docPath, '/subs/0/for');
    assert.deepStrictEqual(log, [], 'the previous instance set was kept');
    app.dispatch('set', ['c']); // back under the bound: diff applies
    assert.deepStrictEqual(log, [['stop', 'a'], ['stop', 'b'], ['start', 'c']]);
    app.destroy();
  });

  it('a single non-array item fans out over one instance; an empty result over none', () => {
    const doc = feedDoc();
    doc.state.feeds = 'solo';
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, { schedule: sync, subs: { feed: logger(log) } });
    assert.deepStrictEqual(log, [['start', 'solo']]);
    log.length = 0;
    app.dispatch('set', []);
    assert.deepStrictEqual(log, [['stop', 'solo']]);
    app.destroy();
  });

  it('a throwing instance handler stays stopped (JA2013) without harming siblings', () => {
    const doc = feedDoc();
    const errors = [];
    const log = [];
    doc.subs = [{ run: 'feed', for: '$.feeds' }];
    const app = createApp(doc, {
      schedule: sync,
      onError: (err) => errors.push(err),
      subs: {
        feed: (props) => {
          if (props === 'a') throw new Error('no resource');
          log.push(['start', props]);
          return () => log.push(['stop', props]);
        },
      },
    });
    assert.deepStrictEqual(log, [['start', 'b']]);
    assert.strictEqual(errors.filter((e) => e.code === 'JA2013').length, 1);
    app.destroy();
  });

  it('`with` beside `for` is an invalid combination (JA0008)', () => {
    const doc = feedDoc();
    doc.subs = [{ run: 'feed', for: '$.feeds', with: { a: 1 } }];
    assert.throws(() => createApp(doc, { schedule: sync, subs: { feed: () => {} } }),
      (e) => e.code === 'JA0008' && e.docPath === '/subs/0');
  });
});
