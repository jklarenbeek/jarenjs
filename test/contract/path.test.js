//@ts-check
/**
 * @file The path matcher, tested through its package-private module: the
 * template parser's dialect (canonicalization, the reserved forms it
 * names) and `compileRoutes` on the partner's 123-route table — every
 * probe, both registration orders, trailing slash, percent-decoding,
 * malformed escapes, unknown methods, backtracking and the host guard.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parsePathTemplate, compileRoutes, pathShape } from '../../packages/contract/src/path.js';
import { ROUTES, PROBES, opId } from './helpers.js';

/** @param {[string, string][]} routes */
function entriesOf(routes) {
  return routes.map(([method, path]) => ({ method, path: parsePathTemplate(path).path, key: opId(method, path) }));
}

describe('contract path — the template parser', () => {
  it('canonicalizes :name to {name} and keeps statics verbatim', () => {
    const p = parsePathTemplate('/api/variants/:id/inventory-locations/:warehouseitemId');
    assert.strictEqual(p.path, '/api/variants/{id}/inventory-locations/{warehouseitemId}');
    assert.deepStrictEqual(p.variables, ['id', 'warehouseitemId']);
    assert.deepStrictEqual(p.segments.map((s) => s.variable), [false, false, true, false, true]);
    assert.strictEqual(pathShape(p), '/api/variants/{}/inventory-locations/{}');
  });

  it('accepts the canonical form unchanged and the root template', () => {
    assert.strictEqual(parsePathTemplate('/api/products/{id}').path, '/api/products/{id}');
    const root = parsePathTemplate('/');
    assert.strictEqual(root.path, '/');
    assert.deepStrictEqual(root.segments, []);
    assert.strictEqual(pathShape(root), '/');
  });

  it('accepts a well-formed percent-escape in a static segment', () => {
    assert.strictEqual(parsePathTemplate('/caf%C3%A9').path, '/caf%C3%A9');
  });

  const refused = /** @type {[string, RegExp][]} */ ([
    ['api', /start with "\/"/],
    ['/a//b', /empty segment/],
    ['/a/', /trailing "\/"/],
    ['/{id}.json', /whole segment/],
    ['/files/{path+}', /reserved "\+" expansion/],
    ['/x/{?q}', /reserved RFC 6570 operator "\?"/],
    ['/x/{+p}', /reserved RFC 6570 operator "\+"/],
    ['/x/*', /reserved wildcard/],
    ['/x/{a,b}', /list or prefix form/],
    ['/x/{a:3}', /list or prefix form/],
    ['/x/{1a}', /\[A-Za-z_\]\[A-Za-z0-9_\]\*/],
    ['/x/{}', /\[A-Za-z_\]\[A-Za-z0-9_\]\*/],
    ['/x/:id?', /reserved "\?" modifier/],
    ['/x/:', /whole segment with an identifier name/],
    ['/x/y:z', /reserved for a variable segment/],
    ['/x/{id}/{id}', /declared twice/],
    ['/a b', /whitespace or a control character/],
    ['/x/%zz', /malformed percent-escape/],
    ['/x?y=1', /cannot appear in a path template/],
  ]);
  for (const [template, message] of refused) {
    it(`refuses ${JSON.stringify(template)} by name`, () => {
      assert.throws(() => parsePathTemplate(template), (err) => err instanceof TypeError && message.test(err.message));
    });
  }

  it('refuses a non-string template', () => {
    assert.throws(() => parsePathTemplate(/** @type {any} */ (42)), TypeError);
  });
});

describe('contract path — compileRoutes over the 123-route table', () => {
  it('compiles the canonicalized table (123 routes, 47 GET)', () => {
    assert.strictEqual(ROUTES.length, 123);
    assert.strictEqual(ROUTES.filter(([m]) => m === 'GET').length, 47);
    const router = compileRoutes(entriesOf(ROUTES));
    assert.strictEqual(Object.isFrozen(router), true);
  });

  it('resolves all 8 probes to the expected keys and params', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    for (const probe of PROBES) {
      const hit = router.match(probe.method, probe.path);
      if (probe.key === null) {
        assert.strictEqual(hit, null, `${probe.method} ${probe.path} is a miss`);
      }
      else {
        assert.ok(hit !== null, `${probe.method} ${probe.path} must hit`);
        assert.strictEqual(hit.key, probe.key);
        assert.deepStrictEqual({ ...hit.params }, probe.params);
      }
    }
  });

  it('static segment wins when registered before the variable sibling', () => {
    const table = ROUTES.slice();
    const prefill = table.findIndex(([m, p]) => m === 'GET' && p === '/api/production-runs/prefill');
    const byId = table.findIndex(([m, p]) => m === 'GET' && p === '/api/production-runs/:id');
    assert.ok(prefill < byId, 'the fixture registers the static path first');
    const router = compileRoutes(entriesOf(table));
    assert.strictEqual(router.match('GET', '/api/production-runs/prefill')?.key, opId('GET', '/api/production-runs/prefill'));
    assert.deepStrictEqual({ ...router.match('GET', '/api/production-runs/42')?.params }, { id: '42' });
  });

  it('static segment wins when registered after the variable sibling', () => {
    const table = ROUTES.slice().reverse();
    const prefill = table.findIndex(([m, p]) => m === 'GET' && p === '/api/production-runs/prefill');
    const byId = table.findIndex(([m, p]) => m === 'GET' && p === '/api/production-runs/:id');
    assert.ok(prefill > byId, 'the reversed fixture registers the static path last');
    const router = compileRoutes(entriesOf(table));
    assert.strictEqual(router.match('GET', '/api/production-runs/prefill')?.key, opId('GET', '/api/production-runs/prefill'));
    assert.strictEqual(router.match('GET', '/api/production-runs/42')?.key, opId('GET', '/api/production-runs/:id'));
    // and the enrichments case hono's RegExpRouter refuses
    assert.strictEqual(router.match('POST', '/api/enrichments/approve-all')?.key, opId('POST', '/api/enrichments/approve-all'));
    assert.strictEqual(router.match('POST', '/api/enrichments/7/decide')?.key, opId('POST', '/api/enrichments/:id/decide'));
  });

  it('every registration order gives the same 8 answers', () => {
    const forward = compileRoutes(entriesOf(ROUTES));
    const shuffled = ROUTES.slice();
    // a deterministic shuffle: rotate by a prime and interleave halves
    const rotated = shuffled.slice(37).concat(shuffled.slice(0, 37));
    const half = Math.floor(rotated.length / 2);
    const mixed = [];
    for (let i = 0; i < half; i++) mixed.push(rotated[i], rotated[half + i]);
    if (rotated.length % 2 === 1) mixed.push(rotated[rotated.length - 1]);
    const other = compileRoutes(entriesOf(mixed));
    for (const probe of PROBES) {
      assert.deepStrictEqual(other.match(probe.method, probe.path), forward.match(probe.method, probe.path));
    }
  });

  it('is exact on the trailing slash: /a/ is not /a and a variable never binds an empty segment', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    assert.strictEqual(router.match('GET', '/api/catalog/'), null);
    assert.strictEqual(router.match('GET', '/api/products/'), null);
    assert.strictEqual(router.match('GET', '/api/products//1'), null);
    assert.strictEqual(router.match('GET', 'api/catalog'), null, 'a path starts with /');
    assert.strictEqual(router.match('GET', ''), null);
  });

  it('percent-decodes each segment once: a%2Fb is one segment bound as "a/b"', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    const hit = router.match('GET', '/api/products/a%2Fb');
    assert.ok(hit !== null);
    assert.strictEqual(hit.key, opId('GET', '/api/products/:id'));
    assert.strictEqual(hit.params.id, 'a/b');
    assert.strictEqual(router.match('GET', '/api/products/a%2Fb/x'), null, 'the decoded / does not re-split into a deeper shape');
    assert.strictEqual(router.match('GET', '/api/cat%61log')?.key, opId('GET', '/api/catalog'), 'statics compare in decoded space');
    assert.strictEqual(router.match('GET', '/api/products/caf%C3%A9')?.params.id, 'café');
  });

  it('returns null for a malformed escape instead of throwing', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    assert.strictEqual(router.match('GET', '/api/products/%E0%A4%A'), null);
    assert.strictEqual(router.match('GET', '/api/%zz'), null);
    assert.strictEqual(router.match('GET', '/api/products/%'), null);
  });

  it('returns null for an unknown method and does not fold case', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    assert.strictEqual(router.match('BREW', '/api/catalog'), null);
    assert.strictEqual(router.match('get', '/api/catalog'), null);
    assert.strictEqual(router.match(/** @type {any} */ (undefined), '/api/catalog'), null);
    assert.strictEqual(router.match('GET', /** @type {any} */ (null)), null);
  });

  it('a variable-name conflict on one shape is a TypeError (the compiler has already refused it as JC0010)', () => {
    assert.throws(() => compileRoutes([
      { method: 'GET', path: '/a/{x}', key: 1 },
      { method: 'GET', path: '/a/{y}', key: 2 },
    ]), (err) => err instanceof TypeError && /duplicate route shape GET \/a\/\{\}/.test(err.message));
    assert.throws(() => compileRoutes([
      { method: 'GET', path: '/a/{x}', key: 1 },
      { method: 'GET', path: '/a/{x}', key: 2 },
    ]), TypeError);
  });

  it('templates that differ only in a variable name under a shared parent each bind their own name', () => {
    const router = compileRoutes([
      { method: 'GET', path: '/a/{x}/b', key: 'xb' },
      { method: 'GET', path: '/a/{y}/c', key: 'yc' },
    ]);
    assert.deepStrictEqual(router.match('GET', '/a/1/b'), { key: 'xb', params: { x: '1' } });
    assert.deepStrictEqual(router.match('GET', '/a/2/c'), { key: 'yc', params: { y: '2' } });
    assert.strictEqual(router.match('GET', '/a/2'), null);
  });

  it('backtracks out of a static dead end into the variable branch', () => {
    const router = compileRoutes([
      { method: 'GET', path: '/a/{x}/c', key: 'axc' },
      { method: 'GET', path: '/{y}/b/d', key: 'ybd' },
    ]);
    assert.deepStrictEqual(router.match('GET', '/a/b/d'), { key: 'ybd', params: { y: 'a' } });
    assert.deepStrictEqual(router.match('GET', '/a/b/c'), { key: 'axc', params: { x: 'b' } });
    assert.strictEqual(router.match('GET', '/a/b/e'), null);
  });

  it('matches the root template and a root-level variable', () => {
    const router = compileRoutes([
      { method: 'GET', path: '/', key: 'root' },
      { method: 'GET', path: '/{z}', key: 'z' },
    ]);
    assert.deepStrictEqual(router.match('GET', '/'), { key: 'root', params: {} });
    assert.deepStrictEqual(router.match('GET', '/q'), { key: 'z', params: { z: 'q' } });
    assert.strictEqual(router.match('GET', '/q/'), null);
    assert.strictEqual(router.match('GET', '//'), null);
  });

  it('a variable-free hit shares one frozen empty params object', () => {
    const router = compileRoutes(entriesOf(ROUTES));
    const a = router.match('GET', '/api/catalog');
    const b = router.match('GET', '/api/health');
    assert.ok(a !== null && b !== null);
    assert.strictEqual(a.params, b.params);
    assert.strictEqual(Object.isFrozen(a.params), true);
  });

  it('a hostile variable name never pollutes the prototype', () => {
    const router = compileRoutes([{ method: 'GET', path: '/x/{__proto__}', key: 1 }]);
    const hit = router.match('GET', '/x/polluted');
    assert.ok(hit !== null);
    assert.strictEqual(Object.hasOwn(hit.params, '__proto__'), true);
    assert.strictEqual(Object.getPrototypeOf(hit.params), Object.prototype);
    assert.strictEqual(/** @type {any} */ ({}).polluted, undefined);
  });

  it('accepts only canonical templates and well-formed entries', () => {
    assert.throws(() => compileRoutes([{ method: 'GET', path: '/api/:id', key: 1 }]),
      (err) => err instanceof TypeError && /canonical/.test(err.message));
    assert.throws(() => compileRoutes(/** @type {any} */ ({})), TypeError);
    assert.throws(() => compileRoutes([/** @type {any} */ ({ method: 'GET' })]), TypeError);
  });
});

describe('contract path — allowed(path), the 405 list', () => {
  const router = compileRoutes(entriesOf(ROUTES));

  it('lists the methods whose tree reaches a leaf for the path shape, sorted', () => {
    assert.deepStrictEqual(router.allowed('/api/products/1'), ['GET']);
    assert.deepStrictEqual(router.allowed('/api/suppliers/7'), ['GET', 'PATCH']);
    assert.deepStrictEqual(router.allowed('/api/suppliers'), ['GET', 'POST']);
    assert.deepStrictEqual(router.allowed('/api/catalog'), ['GET']);
  });

  it('is empty for an unknown shape, a malformed escape, a non-path and the unmatched root', () => {
    assert.deepStrictEqual(router.allowed('/api/nope/404'), []);
    assert.deepStrictEqual(router.allowed('/api/products/%E0%A4%A'), []);
    assert.deepStrictEqual(router.allowed('api/products/1'), []);
    assert.deepStrictEqual(router.allowed(/** @type {any} */ (5)), []);
    assert.deepStrictEqual(router.allowed('/'), []);
  });

  it('sees the root leaf and a static-over-variable shape under every method that declares it', () => {
    const r = compileRoutes([
      { method: 'GET', path: '/', key: 1 },
      { method: 'POST', path: '/', key: 2 },
      { method: 'GET', path: '/a/{id}', key: 3 },
      { method: 'DELETE', path: '/a/{id}', key: 4 },
      { method: 'PUT', path: '/a/fixed', key: 5 },
    ]);
    assert.deepStrictEqual(r.allowed('/'), ['GET', 'POST']);
    assert.deepStrictEqual(r.allowed('/a/9'), ['DELETE', 'GET']);
    assert.deepStrictEqual(r.allowed('/a/fixed'), ['DELETE', 'GET', 'PUT']);
    assert.strictEqual(Object.isFrozen(r), true);
  });
});
