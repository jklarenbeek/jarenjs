import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileRouteTable, createHashRouteSubscription, createHistoryRouteSubscription, matchRoute,
} from '@jarenjs/app/routes';

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

describe('route tables: an address named by its template', () => {
  const table = compileRouteTable({ item: '/items/{id}', newItem: '/items/new', print: '/labels/:label/print' });
  const at = (/** @type {string} */ path) => matchRoute(table, { path });

  it('matches through the suite\'s one template parser: a static segment wins, a variable binds one decoded segment', () => {
    assert.deepEqual(at('/items/42'), { name: 'item', params: { id: '42' } });
    assert.deepEqual(at('/items/new'), { name: 'newItem', params: {} }, 'the static route wins');
    assert.deepEqual(at('/items/a%2Fb'), { name: 'item', params: { id: 'a/b' } }, 'an escaped separator stays inside');
    assert.deepEqual(at('/labels/L%C3%A9/print'), { name: 'print', params: { label: 'Lé' } });
    assert.equal(at('/items/'), null, 'a trailing slash is another shape');
    assert.equal(at('/items/%E0%A4%A'), null, 'a malformed escape matches nothing');
    assert.equal(at('/elsewhere'), null);
    assert.ok(Object.isFrozen(at('/items/42')) && Object.isFrozen(at('/items/42')?.params));
    assert.deepEqual(table.names, ['item', 'newItem', 'print']);
  });

  it('refuses a malformed table or two templates of one shape (JA2027), and a non-table (JA2023)', () => {
    for (const [templates, pattern] of /** @type {[any, RegExp][]} */ ([
      [null, /an object of route name/], [['/a'], /an object of route name/], [{ a: 7 }, /not a path template/],
      [{ a: '/labels/{id}.pdf' }, /whole segment/], [{ a: '/items/' }, /trailing/],
      [{ a: '/items/{id}', b: '/items/{key}' }, /share one shape/],
    ])) assert.throws(() => compileRouteTable(templates), (/** @type {any} */ error) => error.code === 'JA2027' && pattern.test(error.message), JSON.stringify(templates));
    assert.throws(() => matchRoute(/** @type {any} */ ({ names: [] }), { path: '/a' }), { code: 'JA2023' });
    assert.throws(() => matchRoute(table, /** @type {any} */ ({})), { code: 'JA2023' });
  });

  it('a subscription given templates names each record; a malformed table is JA2027 before any listener', () => {
    const host = windowAt('https://app.test/#/base/items/42'), seen = [];
    const routes = createHashRouteSubscription({ window: host.window, basePath: '/base',
      templates: { item: '/items/{id}', list: '/items' } });
    const stop = routes({ action: 'route' }, (_action, record) => seen.push([record.path, record.name, record.params]));
    routes.navigate('/base/items'); routes.navigate('/base/nowhere');
    assert.deepEqual(seen, [['/items/42', 'item', { id: '42' }], ['/items', 'list', {}], ['/nowhere', null, {}]]);
    stop(); routes.dispose();
    // a compiled table is taken as it is
    const named = createHistoryRouteSubscription({ window: windowAt('https://app.test/items/7').window, templates: table });
    let record; named({ action: 'route' }, (_action, value) => { record = value; });
    assert.deepEqual([record.name, record.params], ['item', { id: '7' }]); named.dispose();
    const fresh = windowAt('https://app.test/');
    assert.throws(() => createHistoryRouteSubscription({ window: fresh.window, templates: { a: '/x/{id}', b: '/x/{y}' } }), { code: 'JA2027' });
    assert.equal(fresh.count(), 0);
    // without templates a record carries no name
    const plain = createHistoryRouteSubscription({ window: fresh.window });
    plain({ action: 'route' }, (_action, value) => { record = value; });
    assert.deepEqual(Object.keys(record), ['mode', 'path', 'query', 'fragment', 'raw']); plain.dispose();
  });

  it('a first address outside the base is reported (JA2024) and the subscription stays live for the next one', () => {
    for (const [mode, factory, start, next] of /** @type {const} */ ([
      ['hash', createHashRouteSubscription, 'https://app.test/#/outside', '#/app/items'],
      ['history', createHistoryRouteSubscription, 'https://app.test/outside', '/app/items'],
    ])) {
      const host = windowAt(start), seen = [], errors = [];
      const routes = factory({ window: host.window, basePath: '/app', onError: (error) => errors.push(error.code) });
      const stop = routes({ action: 'route' }, (_action, record) => seen.push(record.path));
      assert.deepEqual([errors, seen], [['JA2024'], []], `${mode}: reported, nothing delivered`);
      assert.ok(host.count() > 0, `${mode}: the listeners stay`);
      if (mode === 'hash') host.hash(next);
      else { host.window.history.pushState(null, '', `https://app.test${next}`); host.fire('popstate'); }
      assert.deepEqual(seen, ['/items'], `${mode}: the next in-base address is delivered`);
      routes.navigate(mode === 'hash' ? '/app/more' : '/app/more');
      assert.deepEqual(seen, ['/items', '/more'], `${mode}: navigation works`);
      stop(); routes.dispose();
      assert.equal(host.count(), 0);
    }
  });
  it('a sink that throws on the first-address report leaves no subscription behind', () => {
    for (const [mode, factory, start] of /** @type {const} */ ([
      ['hash', createHashRouteSubscription, 'https://app.test/#/outside'],
      ['history', createHistoryRouteSubscription, 'https://app.test/outside'],
    ])) {
      const host = windowAt(start), seen = [];
      const routes = factory({ window: host.window, basePath: '/app', onError: (error) => { throw error; } });
      assert.throws(() => routes({ action: 'route' }, (_action, record) => seen.push(record.path)), { code: 'JA2024' });
      assert.equal(host.count(), 0, `${mode}: no listener is left behind`);
      assert.throws(() => routes({ action: 'route' }, () => {}), { code: 'JA2024' }, `${mode}: the owner was released, so the next subscribe reports again`);
      host.window.history.pushState(null, '', 'https://app.test/#/app/later'); host.fire('popstate'); host.fire('hashchange');
      assert.deepEqual(seen, [], `${mode}: the failed subscription receives nothing`);
      routes.dispose();
    }
  });

  it('a first address past the length bound is reported (JA2025), and navigation away from it works', () => {
    for (const [mode, factory, start] of /** @type {const} */ ([
      ['hash', createHashRouteSubscription, `https://app.test/#/${'x'.repeat(100)}`],
      ['history', createHistoryRouteSubscription, `https://app.test/${'x'.repeat(100)}`],
    ])) {
      const host = windowAt(start), seen = [], errors = [];
      const routes = factory({ window: host.window, maxLength: 64, onError: (error) => errors.push(error.code) });
      routes({ action: 'route' }, (_action, record) => seen.push(record.path));
      assert.deepEqual([errors, seen], [['JA2025'], []], `${mode}: reported, nothing delivered`);
      routes.navigate('/home');
      routes.replace('/again');
      assert.deepEqual(seen, ['/home', '/again'], `${mode}: navigation and replace work`);
      assert.throws(() => routes.navigate(`/${'y'.repeat(100)}`), { code: 'JA2025' }, `${mode}: the target is still bounded`);
      routes.dispose();
    }
  });

  it('a sink that redirects on an unreadable first address lands the app there', () => {
    const host = windowAt(`https://app.test/#/${'x'.repeat(200)}`), seen = [];
    /** @type {any} */
    let routes;
    routes = createHashRouteSubscription({ window: host.window, maxLength: 128, onError: () => routes.navigate('/home') });
    const stop = routes({ action: 'route' }, (_action, record) => seen.push(record.path));
    assert.deepEqual(seen, ['/home']);
    assert.ok(host.count() > 0, 'the subscription is live');
    stop(); routes.dispose();
    assert.equal(host.count(), 0);
  });

  it('a host whose location cannot be read at all is refused (JA2023), as a direct call, with nothing left behind', () => {
    const host = windowAt('https://app.test/#/a'), errors = [];
    const window = { ...host.window, location: {} };
    const routes = createHashRouteSubscription({ window, onError: (error) => errors.push(error.code) });
    assert.throws(() => routes({ action: 'route' }, () => {}), { code: 'JA2023' });
    assert.deepEqual(errors, [], 'the sink is for addresses, not for a malformed host');
    assert.equal(host.count(), 0);
  });
});
