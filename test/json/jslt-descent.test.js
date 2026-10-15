//@ts-check
/**
 * @file `maxDescentDepth` moves the descent bound a stylesheet's
 * descendant segments compile under, in its rules' match paths and in
 * the paths inside its rule bodies, as `compileJSONPath` takes it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileJsltStylesheet, transformJson, JsltRuntimeError } from '@jarenjs/json/jslt';

/** `n` levels of `{ a }` around `{ x: 1 }`: n + 1 nested objects. @param {number} n */
const nest = (n) => {
  /** @type {any} */
  let v = { x: 1 };
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
};

const MATCH = [{ match: '$..x', body: 'X' }];
const BODY = [{ match: '$', body: { $count: '$..x' } }];

/**
 * @param {() => unknown} run
 * @param {string} where - the rule failure the refusal wraps
 * @param {number} limit
 */
function assertDescentRefused(run, where, limit) {
  assert.throws(run, (/** @type {any} */ error) => {
    assert.ok(error instanceof JsltRuntimeError);
    assert.equal(error.code, 'JT2004');
    assert.equal(error.cause?.code, 'JQ2009');
    assert.match(error.message, new RegExp(`^JT2004: rule /0 failed ${where}: JQ2009: a descendant segment reaches a value nested deeper than ${limit} levels`));
    return true;
  });
}

describe('a stylesheet moves its descent bound with maxDescentDepth', () => {
  it('a match path answers within the bound and is refused past it', () => {
    const transform = compileJsltStylesheet(MATCH, { maxDescentDepth: 3 });
    assert.deepEqual(transform(nest(2)), { a: { a: { x: 'X' } } });
    assertDescentRefused(() => transform(nest(3)), 'matching its path', 3);
  });

  it('a path inside a rule body answers within the bound and is refused past it', () => {
    const transform = compileJsltStylesheet(BODY, { maxDescentDepth: 3 });
    assert.equal(transform(nest(2)), 1);
    assertDescentRefused(() => transform(nest(3)), 'at location \\$', 3);
  });

  it('an $apply selector is bounded too', () => {
    const transform = compileJsltStylesheet([
      { match: '$', body: { $apply: '$..x' } },
      { match: '$..x', body: 'X' },
    ], { maxDescentDepth: 3 });
    assert.equal(transform(nest(2)), 'X');
    assert.throws(() => transform(nest(3)), (/** @type {any} */ error) =>
      /deeper than 3 levels/.test(error.message));
  });

  it('the default bound stays 1000 levels', () => {
    const transform = compileJsltStylesheet(BODY);
    assert.equal(transform(nest(999)), 1);
    assertDescentRefused(() => transform(nest(1000)), 'at location \\$', 1000);
  });

  it('refuses a value that is not a positive integer, as compileJSONPath does', () => {
    for (const value of [0, -1, 1.5, '5', Number.NaN, Infinity, true]) {
      // a stylesheet with a match path, and one whose only path is in a body
      for (const stylesheet of [MATCH, [{ body: { $count: '$..x' } }]]) {
        assert.throws(() => compileJsltStylesheet(stylesheet, { maxDescentDepth: /** @type {any} */ (value) }),
          { name: 'TypeError', message: 'options.maxDescentDepth must be a positive integer' }, String(value));
      }
    }
    assert.deepEqual(compileJsltStylesheet(MATCH, { maxDescentDepth: undefined })({ x: 1 }), { x: 'X' });
    assert.deepEqual(compileJsltStylesheet(MATCH, { maxDescentDepth: null })({ x: 1 }), { x: 'X' });
  });

  it('transformJson compiles each bound once, never sharing one bound between two calls', () => {
    const stylesheet = [{ match: '$', body: { $count: '$..x' } }];
    assert.equal(transformJson(stylesheet, nest(3), undefined, { maxDescentDepth: 10 }), 1);
    assertDescentRefused(() => transformJson(stylesheet, nest(3), undefined, { maxDescentDepth: 3 }),
      'at location \\$', 3);
    assert.equal(transformJson(stylesheet, nest(3), undefined, { maxDescentDepth: 10 }), 1);
  });

  it('a raised bound lets a deeper document answer (child with a large stack)', () => {
    const script = `
      import { compileJsltStylesheet } from '@jarenjs/json/jslt';
      let v = { x: 1 };
      for (let i = 0; i < 1500; i++) v = { a: v };
      const body = compileJsltStylesheet([{ match: '$', body: { $count: '$..x' } }], { maxDescentDepth: 2000 });
      const match = compileJsltStylesheet([{ match: '$..x', body: 'X' }], { maxDescentDepth: 2000, maxDepth: 3000 });
      let w = match(v);
      for (let i = 0; i < 1500; i++) w = w.a;
      process.stdout.write(JSON.stringify([body(v), w]));
    `;
    const child = spawnSync(process.execPath, ['--stack-size=4000', '--input-type=module', '-e', script],
      { encoding: 'utf8', cwd: new URL('../..', import.meta.url) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '[1,{"x":"X"}]');
  });
});

describe('a JTLT template takes the same bound', () => {
  it('renderText keys its cache on maxDescentDepth', async () => {
    const { renderText } = await import('@jarenjs/json/jtlt');
    const template = [{ match: '$', body: [{ $string: { $count: '$..x' } }] }];
    assert.equal(renderText(template, nest(3), undefined, { maxDescentDepth: 10 }), '1');
    assert.throws(() => renderText(template, nest(3), undefined, { maxDescentDepth: 3 }),
      (/** @type {any} */ error) => /deeper than 3 levels/.test(error.message));
  });

  it('renderText keys its cache on a registry, as transformJson does', async () => {
    const { renderText } = await import('@jarenjs/json/jtlt');
    const { createJsltRegistry, mathPack } = await import('@jarenjs/json/jslt');
    const { extensions } = createJsltRegistry().use(mathPack).toOptions();
    const template = [{ match: '$', body: [{ $string: { $sign: [-4] } }] }];
    assert.equal(renderText(template, 1, undefined, { extensions }), '-1');
    assert.throws(() => renderText(template, 1, undefined),
      (/** @type {any} */ error) => error.code === 'TL0005' && /unknown operator '\$sign'/.test(error.message));
    const stylesheet = [{ match: '$', body: { $sign: [-4] } }];
    assert.equal(transformJson(stylesheet, 1, undefined, { extensions }), -1);
    assert.throws(() => transformJson(stylesheet, 1, undefined), { code: 'JT0007' });
    // registered $call functions key the cache the same way
    const called = [{ match: '$', body: [{ $string: { $call: ['twice', 2] } }] }];
    const functions = { twice: (/** @type {number} */ x) => x * 2 };
    assert.equal(renderText(called, 1, undefined, { functions }), '4');
    assert.throws(() => renderText(called, 1, undefined), { code: 'TL0005' });
  });
});

describe('a stylesheet names a cycle its descendant segments reach', () => {
  /** `{ x: 1, self: <itself> }` under `a` */
  const cyclic = () => {
    /** @type {any} */
    const c = { x: 1 };
    c.self = c;
    return { a: c };
  };

  for (const [name, stylesheet, where] of /** @type {const} */ ([
    ['a match path', MATCH, 'matching its path'],
    ['a path inside a rule body', BODY, 'at location \\$'],
  ])) {
    it(`${name} refuses it as a cycle at the member that closes it`, () => {
      assert.throws(() => compileJsltStylesheet(stylesheet)(cyclic()), (/** @type {any} */ error) => {
        assert.ok(error instanceof JsltRuntimeError);
        assert.equal(error.code, 'JT2004');
        assert.equal(error.cause?.code, 'JQ2016');
        assert.deepEqual(error.cause?.params, { member: '/a/self' });
        assert.match(error.message, new RegExp(`^JT2004: rule /0 failed ${where}: JQ2016: a descendant segment reaches a circular reference closed by data member /a/self`));
        return true;
      });
    });
  }
});
