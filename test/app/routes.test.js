import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHashRouteSubscription, createHistoryRouteSubscription } from '@jarenjs/app/routes';

function windowAt(href) {
  let current = new URL(href), at = 0;
  const history = [current.href], listeners = new Map();
  const fire = type => { for (const callback of [...(listeners.get(type) ?? [])]) callback({ type }); };
  const window = {
    get location() { return current; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    history: { state: { host: 'kept' },
      pushState(_state, _title, url) { current = new URL(url); history.splice(++at); history.push(current.href); },
      replaceState(_state, _title, url) { current = new URL(url); history[at] = current.href; },
    },
  };
  return { window, history, listeners, fire,
    move(delta) { at += delta; current = new URL(history[at]); fire('popstate'); fire('hashchange'); },
    hash(hash) { current.hash = hash; fire('hashchange'); },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

describe('owned route subscriptions', () => {
  it('bounds the actual URL without charging an internal parsing origin', () => {
    const host = windowAt('https://x/#/a'), seen = [];
    const routes = createHashRouteSubscription({ window: host.window, maxLength: 16 });
    routes({ action: 'route' }, (_action, record) => seen.push(record.path));
    routes.navigate('/b'); assert.deepEqual(seen, ['/a', '/b']); routes.dispose();
  });
  for (const [mode, factory] of [['hash', createHashRouteSubscription], ['history', createHistoryRouteSubscription]]) {
    it(`${mode}: delivers initial/navigation/back/forward once and restarts without duplicate listeners`, () => {
      const host = windowAt(mode === 'hash' ? 'https://app.test/#/start' : 'https://app.test/start');
      const routes = factory({ window: host.window }), seen = [];
      let stop = routes({ action: 'route' }, (action, route) => { assert.equal(action, 'route'); seen.push(route.path); });
      routes.navigate('/next'); routes.refresh();
      routes.replace('/final'); assert.equal(host.history.length, 2);
      host.move(-1); host.move(1);
      assert.deepEqual(seen, ['/start', '/next', '/final', '/start', '/final']);
      stop(); stop(); assert.equal(host.count(), 0);
      assert.throws(() => routes.navigate('/inactive'), { code: 'JA2026' });
      stop = routes({ action: 'route' }, (_action, record) => seen.push(record.path));
      assert.equal(seen.at(-1), '/final');
      routes.dispose(); routes.dispose(); stop();
      assert.equal(host.count(), 0);
      assert.throws(() => routes({ action: 'route' }, () => {}), { code: 'JA2026' });
    });
  }

  it('preserves encoded paths, repeated query order, malformed percent policy, fragments and prototype keys as immutable JSON', () => {
    const host = windowAt('https://app.test/#/base/a%2Fb?q=one&q=two+words&bad=%E0%A4%A&__proto__=yes#section%20one');
    const routes = createHashRouteSubscription({ window: host.window, basePath: '/base' });
    let record; const stop = routes({ action: 'route' }, (_action, value) => { record = value; });
    assert.equal(record.path, '/a%2Fb'); assert.equal(record.fragment, 'section%20one');
    assert.deepEqual(record.query.q, ['one', 'two words']);
    assert.deepEqual(record.query.bad, ['\uFFFD%A']); assert.deepEqual(record.query.__proto__, ['yes']);
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.query) && Object.isFrozen(record.query.q));
    assert.equal(JSON.parse(JSON.stringify(record)).query.__proto__[0], 'yes');
    stop();
  });

  it('refuses cross-origin, base and input bounds before modifying history', () => {
    const host = windowAt('https://app.test/base/start'), routes = createHistoryRouteSubscription({ window: host.window,
      basePath: '/base', maxLength: 128, maxQueryEntries: 2 });
    routes({ action: 'route' }, () => {});
    for (const target of ['https://other.test/base/next', 'javascript:alert(1)', '/baseball/item', '/outside'])
      assert.throws(() => routes.navigate(target), { code: 'JA2024' });
    for (const target of ['/base/?a=1&a=2&a=3', '/base/' + 'x'.repeat(129)])
      assert.throws(() => routes.navigate(target), { code: 'JA2025' });
    assert.equal(host.history.length, 1); assert.equal(host.window.location.pathname, '/base/start');
    routes.dispose();
    const hash = createHashRouteSubscription({ window: host.window }); hash({ action: 'route' }, () => {});
    assert.throws(() => hash.navigate('//other.test/'), { code: 'JA2024' });
    assert.throws(() => hash.navigate('https://app.test/another#x'), { code: 'JA2024' });
    hash.dispose();
  });

  it('external history writes need refresh and native event errors have an explicit sink', () => {
    const host = windowAt('https://app.test/base/'), seen = [], errors = [];
    const routes = createHistoryRouteSubscription({ window: host.window, basePath: '/base', onError: error => errors.push(error.code) });
    routes({ action: 'route' }, (_action, record) => seen.push(record.path));
    host.window.history.pushState(null, '', 'https://app.test/base/external');
    assert.deepEqual(seen, ['/']); routes.refresh(); routes.refresh();
    assert.deepEqual(seen, ['/', '/external']);
    host.window.history.pushState(null, '', 'https://app.test/outside'); host.fire('popstate');
    assert.deepEqual(errors, ['JA2024']); routes.dispose();
  });

  it('queues reentrant round trips without losing a return to the current path and bounds redirect loops', () => {
    const host = windowAt('https://app.test/a'), routes = createHistoryRouteSubscription({ window: host.window }), seen = [];
    routes({ action: 'route' }, (_action, record) => {
      seen.push(record.path);
      if (seen.length === 1) { routes.navigate('/b'); routes.navigate('/a'); }
    });
    assert.deepEqual(seen, ['/a', '/b', '/a']); routes.dispose();
    const bounded = createHistoryRouteSubscription({ window: host.window, maxTurns: 3 });
    let count = 0;
    assert.throws(() => bounded({ action: 'route' }, () => bounded.navigate(`/loop-${++count}`)), { code: 'JA2025' });
    assert.equal(count, 3); assert.equal(host.count(), 0, 'failed initial dispatch releases listeners');
    bounded.dispose();
  });

  it('validates host/subscription configuration and tears down failed initial delivery', () => {
    const host = windowAt('https://app.test/');
    for (const options of [null, { window: {} }, { window: host.window, basePath: 'relative' },
      { window: host.window, maxLength: 0 }, { window: host.window, onError: 1 }])
      assert.throws(() => createHashRouteSubscription(options), { code: 'JA2023' });
    const routes = createHistoryRouteSubscription({ window: host.window });
    assert.throws(() => routes({}, () => {}), { code: 'JA2023' });
    assert.throws(() => routes({ action: 'route' }, () => { throw new Error('consumer'); }), /consumer/);
    assert.equal(host.count(), 0);
    const stop = routes({ action: 'route' }, () => {});
    assert.throws(() => routes({ action: 'route' }, () => {}), { code: 'JA2026' });
    assert.throws(() => routes.navigate(1), { code: 'JA2023' });
    assert.throws(() => routes.navigate('/x', { replace: 'yes' }), { code: 'JA2023' });
    stop(); routes.dispose();
  });
});
