import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsltStylesheet,
  transformJson,
  JsltRuntimeError,
} from '@jarenjs/json/jslt';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

function makeStubHook(calls = []) {
  const hook = (schema, docPath) => {
    calls.push({ schema, docPath });
    if (schema === false)
      return () => false;
    if (schema === true || typeof schema !== 'object' || schema === null)
      return () => true;
    return (value) => {
      if (schema.type === 'number' && typeof value !== 'number')
        return false;
      if (schema.type === 'string' && typeof value !== 'string')
        return false;
      if (schema.type === 'array' && !Array.isArray(value))
        return false;
      if (schema.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return false;
        const required = schema.required ?? [];
        for (let i = 0; i < required.length; i++) {
          if (!Object.hasOwn(value, required[i]))
            return false;
        }
      }
      if (Object.hasOwn(schema, 'const') && value !== schema.const)
        return false;
      return true;
    };
  };
  hook.calls = calls;
  return hook;
}

function compileWithStub(doc, options = {}) {
  return compileJsltStylesheet(doc, {
    ...options,
    compileTypeTest: options.compileTypeTest ?? makeStubHook(),
  });
}

function runtimeFails(transform, data, code, check = null) {
  assert.throws(() => transform(data), (error) => {
    assert.strictEqual(error instanceof JsltRuntimeError, true,
      `expected JsltRuntimeError, got ${error.name}: ${error.message}`);
    assert.strictEqual(error.code, code);
    if (check !== null)
      check(error);
    return true;
  });
}

describe('Jaren JSLT dispatch', () => {
  it('retains the location of bare current and root apply selectors', () => {
    for (const selector of ['$', '$root']) {
      const transform = compileJsltStylesheet({ $jslt: '0.1', rules: [
        { match: '$', body: { $apply: [selector, 'located'] } },
        { match: '$', mode: 'located', body: { value: '$.a', path: '$path' } },
      ] });
      assert.deepStrictEqual(transform({ a: 1 }), { value: 1, path: '$' });
    }
    const transform = compileJsltStylesheet({ $jslt: '0.1', rules: [
      { match: '$.child', body: {
        current: { $apply: ['$', 'current'] }, root: { $apply: ['$root', 'root'] },
      } },
      { match: '$.child', mode: 'current', body: { value: '$.n', path: '$path' } },
      { match: '$', mode: 'root', body: { value: '$.name', path: '$path' } },
    ] });
    assert.deepStrictEqual(transform({ name: 'parent', child: { n: 2 } }), {
      name: 'parent', child: {
        current: { value: 2, path: "$['child']" }, root: { value: 'parent', path: '$' },
      },
    });
  });

  describe('matching and sharing', () => {
    it('returns the input by reference for an empty stylesheet', () => {
      const data = { store: { books: [{ price: 10 }] } };
      const transform = compileJsltStylesheet([]);
      assert.strictEqual(transform(data), data);
    });

    it('performs a surgical path override and shares untouched subtrees', () => {
      const data = {
        catalog: {
          book: [
            { title: 'A', price: 10 },
            { title: 'B', price: 20 },
          ],
        },
        meta: { publisher: { name: 'N' } },
      };
      const before = JSON.stringify(data);
      const transform = compileJsltStylesheet([
        { match: '$..price', body: { $mul: ['$', 1.21] } },
      ]);
      const output = transform(data);

      assert.deepStrictEqual(output, {
        catalog: {
          book: [
            { title: 'A', price: 12.1 },
            { title: 'B', price: 24.2 },
          ],
        },
        meta: { publisher: { name: 'N' } },
      });
      assert.notStrictEqual(output, data);
      assert.notStrictEqual(output.catalog, data.catalog);
      assert.notStrictEqual(output.catalog.book, data.catalog.book);
      assert.strictEqual(output.meta, data.meta);
      assert.strictEqual(output.meta.publisher, data.meta.publisher);
      assert.strictEqual(JSON.stringify(data), before);
    });

    it('scans escaped normalized names when building the shared spine', () => {
      const oddName = "odd['\\name";
      const data = {
        [oddName]: { price: 10, keep: { value: 1 } },
        untouched: { value: 2 },
      };
      const output = compileJsltStylesheet([
        { match: '$..price', body: { $mul: ['$', 2] } },
      ])(data);
      assert.strictEqual(output[oddName].price, 20);
      assert.strictEqual(output[oddName].keep, data[oddName].keep);
      assert.strictEqual(output.untouched, data.untouched);
    });

    it('rebuilds match maps per transformation call', () => {
      const data = { item: { value: 1 } };
      const transform = compileJsltStylesheet([
        { match: '$..price', body: { $mul: ['$', 2] } },
      ]);
      assert.strictEqual(transform(data), data);
      data.item.price = 3;
      const output = transform(data);
      assert.strictEqual(output.item.price, 6);
      assert.strictEqual(data.item.price, 3);
    });

    it('matches schema predicates wherever values occur', () => {
      const transform = compileWithStub([
        {
          match: { schema: { type: 'number' } },
          body: { $mul: ['$', 2] },
        },
      ]);
      assert.deepStrictEqual(transform({ a: 2, nested: [3, 'x'] }), {
        a: 4,
        nested: [6, 'x'],
      });
    });

    it('compiles a frozen schema match exactly once', () => {
      const calls = [];
      const schema = { type: 'number' };
      const hook = makeStubHook(calls);
      const transform = compileJsltStylesheet([
        { match: { schema }, body: '$' },
      ], { compileTypeTest: hook });
      assert.strictEqual(calls.length, 1);
      assert.notStrictEqual(calls[0].schema, schema);
      assert.strictEqual(Object.isFrozen(calls[0].schema), true);
      schema.type = 'string';
      transform({ a: 1, b: 2 });
      transform({ a: 3 });
      assert.strictEqual(calls.length, 1);
    });

    it('requires both conditions of a path+schema match', () => {
      const transform = compileWithStub([
        {
          match: { path: '$', schema: { type: 'number' } },
          body: 'both',
        },
        {
          match: { schema: { type: 'string' } },
          body: 'schema',
        },
        { body: 'fallback' },
      ]);
      assert.strictEqual(transform(3), 'both');
      assert.strictEqual(transform('x'), 'schema');
      assert.strictEqual(transform(false), 'fallback');
    });

    it('fires an unconditional rule on reach', () => {
      assert.deepStrictEqual(
        compileJsltStylesheet([{ body: { wrapped: '$' } }])({ a: 1 }),
        { wrapped: { a: 1 } });
    });
  });

  describe('conflict resolution', () => {
    it('lets explicit priority beat defaults', () => {
      const transform = compileJsltStylesheet([
        { match: '$', priority: 5, body: 'high' },
        { match: '$', body: 'later-default' },
      ]);
      assert.strictEqual(transform(null), 'high');
    });

    it('uses both > single > unconditional default priorities', () => {
      const transform = compileWithStub([
        { body: 'unconditional' },
        { match: { schema: true }, body: 'single' },
        { match: { path: '$', schema: true }, body: 'both' },
      ]);
      assert.strictEqual(transform({}), 'both');
    });

    it('lets the later rule win equal priorities', () => {
      const transform = compileJsltStylesheet([
        { match: '$', body: 'first' },
        { match: '$', body: 'second' },
      ]);
      assert.strictEqual(transform(1), 'second');
    });
  });

  describe('built-in dispositions and constructors', () => {
    it('shares complete unmatched regions under share', () => {
      const data = { left: { value: 1 }, right: [{ value: 2 }] };
      assert.strictEqual(compileJsltStylesheet([])(data), data);
    });

    it('returns fresh containers at every unmatched level under fresh', () => {
      const data = { left: { value: 1 }, right: [{ value: 2 }] };
      const output = compileJsltStylesheet({
        $jslt: '0.1',
        unmatched: 'fresh',
        rules: [],
      })(data);
      assert.deepStrictEqual(output, data);
      assert.notStrictEqual(output, data);
      assert.notStrictEqual(output.left, data.left);
      assert.notStrictEqual(output.right, data.right);
      assert.notStrictEqual(output.right[0], data.right[0]);
    });

    it('throws JT2003 under error and allows an explicit fallback', () => {
      runtimeFails(compileJsltStylesheet({
        $jslt: '0.1',
        unmatched: 'error',
        rules: [],
      }), { a: 1 }, 'JT2003');
      const covered = compileJsltStylesheet({
        $jslt: '0.1',
        unmatched: 'error',
        rules: [{ body: { ok: true } }],
      });
      assert.deepStrictEqual(covered({ a: 1 }), { ok: true });
    });

    it('omits object members and array elements whose child dispatch is empty', () => {
      const transform = compileJsltStylesheet([
        { match: '$..drop', body: '$.missing' },
      ]);
      assert.deepStrictEqual(transform({
        keep: 1,
        drop: 2,
        list: [{ keep: 3, drop: 4 }],
      }), {
        keep: 1,
        list: [{ keep: 3 }],
      });
    });

    it('raises JT2002 when an object child returns multiple items', () => {
      const transform = compileJsltStylesheet([
        { match: '$.value', body: { $seq: [1, 2] } },
      ]);
      runtimeFails(transform, { value: 0 }, 'JT2002', (error) => {
        assert.match(error.message, /member 'value'/);
        assert.match(error.message, /\$\['value'\]/);
      });
    });

    it('splices a child sequence into an array', () => {
      const transform = compileJsltStylesheet([
        { match: '$.items[1]', body: { $seq: ['a', 'b'] } },
      ]);
      assert.deepStrictEqual(transform({ items: [1, 2, 3] }), {
        items: [1, 'a', 'b', 3],
      });
    });

    it('preserves an own __proto__ member during a rebuilt object spine', () => {
      const data = JSON.parse('{"__proto__":{"price":10},"keep":1}');
      const output = compileJsltStylesheet([
        { match: '$..price', body: { $mul: ['$', 2] } },
      ])(data);
      assert.deepStrictEqual(output, JSON.parse(
        '{"__proto__":{"price":20},"keep":1}'));
      assert.strictEqual(Object.hasOwn(output, '__proto__'), true);
      assert.strictEqual(Object.getPrototypeOf(output), Object.prototype);
    });
  });

  describe('$apply', () => {
    it('supports the bare and [selector] forms', () => {
      const bare = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: '$.items[*]' }],
        },
        {
          match: '$.items[*]',
          body: { $mul: ['$', 2] },
        },
      ]);
      const listed = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: ['$.items[*]'] }],
        },
        {
          match: '$.items[*]',
          body: { $mul: ['$', 2] },
        },
      ]);
      assert.deepStrictEqual(bare({ items: [1, 2] }), [2, 4]);
      assert.deepStrictEqual(listed({ items: [1, 2] }), [2, 4]);
    });

    it('supports explicit empty mode and inherited named mode dispatch', () => {
      const emptyMode = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: ['$.items[*]', ''] }],
        },
        {
          match: '$.items[*]',
          body: { $mul: ['$', 2] },
        },
      ]);
      assert.deepStrictEqual(emptyMode({ items: [2, 3] }), [4, 6]);

      const inherited = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: ['$.groups[*]', 'walk'] }],
        },
        {
          mode: 'walk',
          match: '$.groups[*]',
          body: {
            name: '$.name',
            values: [{ $apply: '$.items[*]' }],
          },
        },
        {
          mode: 'walk',
          match: '$.groups[*].items[*]',
          body: { $mul: ['$', 10] },
        },
      ]);
      assert.deepStrictEqual(inherited({
        groups: [{ name: 'g', items: [1, 2] }],
      }), [{
        name: 'g',
        values: [10, 20],
      }]);
    });

    it('returns an empty sequence for an empty selector', () => {
      const transform = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: '$.missing[*]' }],
        },
      ]);
      assert.deepStrictEqual(transform({}), []);
    });

    it('uses the array-constructor children idiom', () => {
      const transform = compileWithStub([
        {
          match: { schema: { type: 'object', required: ['isbn'] } },
          body: {
            title: '$.title',
            children: [{ $apply: '$.chapters[*]' }],
          },
        },
        {
          match: { schema: { type: 'object', required: ['heading'] } },
          body: { name: '$.heading' },
        },
      ]);
      assert.deepStrictEqual(transform({
        isbn: 'x',
        title: 'Book',
        chapters: [{ heading: 'One' }, { heading: 'Two' }],
      }), {
        title: 'Book',
        children: [{ name: 'One' }, { name: 'Two' }],
      });
    });

    it('wraps the bare-member multi-item trap as JT2004/JQ2001', () => {
      const transform = compileWithStub([
        {
          match: { schema: { type: 'object', required: ['isbn'] } },
          body: {
            children: { $apply: '$.chapters[*]' },
          },
        },
        {
          match: { schema: { type: 'object', required: ['heading'] } },
          body: { name: '$.heading' },
        },
      ]);
      runtimeFails(transform, {
        isbn: 'x',
        chapters: [{ heading: 'One' }, { heading: 'Two' }],
      }, 'JT2004', (error) => {
        assert.strictEqual(error.cause instanceof JsonQueryRuntimeError, true);
        assert.strictEqual(error.cause.code, 'JQ2001');
      });
    });

    it('carries locations for $root-rooted path selectors', () => {
      const transform = compileJsltStylesheet([
        {
          match: '$',
          body: [{ $apply: ['$root.items[*]', 'paths'] }],
        },
        {
          mode: 'paths',
          match: '$.items[*]',
          body: '$path',
        },
      ]);
      assert.deepStrictEqual(transform({ items: ['a', 'b'] }), [
        "$['items'][0]",
        "$['items'][1]",
      ]);
    });

    it('keeps FLWOR-selected items location-less', () => {
      const transform = compileWithStub([
        {
          match: '$',
          body: [{
            $apply: [{
              $for: { x: '$.items[*]' },
              $return: '$x',
            }, 'target'],
          }],
        },
        {
          mode: 'target',
          match: '$.items[*]',
          priority: 10,
          body: 'path',
        },
        {
          mode: 'target',
          match: { schema: { type: 'number' } },
          body: { $mul: ['$', 10] },
        },
      ]);
      assert.deepStrictEqual(transform({ items: [1, 2] }), [10, 20]);
    });
  });

  describe('modes and recursion', () => {
    it('honors a per-mode unmatched override', () => {
      const strict = compileJsltStylesheet({
        $jslt: '0.1',
        modes: { strict: { unmatched: 'error' } },
        rules: [{
          match: '$',
          body: { $apply: ['$.item', 'strict'] },
        }],
      });
      runtimeFails(strict, { item: 1 }, 'JT2003');

      const covered = compileJsltStylesheet({
        $jslt: '0.1',
        modes: { strict: { unmatched: 'error' } },
        rules: [
          {
            match: '$',
            body: { $apply: ['$.item', 'strict'] },
          },
          {
            mode: 'strict',
            body: { seen: '$' },
          },
        ],
      });
      assert.deepStrictEqual(covered({ item: 1 }), { seen: 1 });
    });

    it('raises JT2001 for the default self-application guard', () => {
      runtimeFails(compileJsltStylesheet([
        { body: { $apply: ['$'] } },
      ]), {}, 'JT2001');
    });

    it('honors a custom maxDepth', () => {
      runtimeFails(compileJsltStylesheet([
        { body: { $apply: ['$'] } },
      ], { maxDepth: 3 }), {}, 'JT2001', (error) => {
        assert.match(error.message, /depth 4 exceeded maxDepth 3/);
      });
    });
  });

  describe('externals and runtime errors', () => {
    it('collects user parameters in first-appearance order and freezes the list', () => {
      const transform = compileJsltStylesheet([
        { match: '$.a', body: { $seq: ['$beta', '$alpha', '$root', '$path'] } },
        { match: '$.b', body: { $seq: ['$alpha', '$gamma'] } },
      ]);
      assert.deepStrictEqual(transform.externals, ['beta', 'alpha', 'gamma']);
      assert.strictEqual(Object.isFrozen(transform.externals), true);
    });

    it('binds user parameters once and reserves root/path', () => {
      const transform = compileJsltStylesheet([
        {
          match: '$..price',
          body: {
            amount: { $mul: ['$', '$rate'] },
            currency: '$root.currency',
            at: '$path',
          },
        },
      ]);
      const output = transform({
        currency: 'EUR',
        items: [{ price: 10 }],
      }, {
        rate: 1.21,
        root: { currency: 'BAD' },
        path: 'BAD',
      });
      assert.deepStrictEqual(output, {
        currency: 'EUR',
        items: [{
          price: {
            amount: 12.1,
            currency: 'EUR',
            at: "$['items'][0]['price']",
          },
        }],
      });
    });

    it('wraps an unbound user parameter read as JT2004/JQ2006', () => {
      const transform = compileJsltStylesheet([
        { match: '$', body: '$missing' },
      ]);
      runtimeFails(transform, 1, 'JT2004', (error) => {
        assert.strictEqual(error.cause.code, 'JQ2006');
        assert.strictEqual(error.docPath, '/0/body');
      });
    });

    it('binds path to null on location-less dispatch', () => {
      const transform = compileWithStub([
        {
          match: '$',
          body: {
            $apply: [{
              $for: { x: '$.items[*]' },
              $return: '$x',
            }, 'target'],
          },
        },
        {
          mode: 'target',
          match: { schema: { type: 'number' } },
          body: '$path',
        },
      ]);
      assert.strictEqual(transform({ items: [1] }), null);
    });

    it('wraps query runtime failures once through nested $apply', () => {
      const transform = compileJsltStylesheet([
        {
          match: '$',
          body: { $apply: '$.item' },
        },
        {
          match: '$.item',
          body: { $idiv: ['$.a', '$.b'] },
        },
      ]);
      runtimeFails(transform, { item: { a: 1, b: 0 } }, 'JT2004', (error) => {
        assert.strictEqual(error.cause instanceof JsonQueryRuntimeError, true);
        assert.strictEqual(error.cause.code, 'JQ2002');
        assert.strictEqual(error.cause.cause, undefined);
      });
    });
  });

  it('uses the sign bit for the 32nd ranked path-rule ordinal', () => {
    const rules = new Array(32);
    for (let i = 0; i < rules.length; i++) {
      rules[i] = {
        match: i === 0 ? '$.target' : `$.missing${i}`,
        body: i,
      };
    }
    assert.deepStrictEqual(
      compileJsltStylesheet(rules)({ target: 100 }),
      { target: 0 });
  });

  it('uses the Set mask fallback with at least 33 path rules', () => {
    const rules = new Array(33);
    const data = {};
    for (let i = 0; i < rules.length; i++) {
      rules[i] = { match: `$.v${i}`, body: i };
      data[`v${i}`] = 100 + i;
    }
    const output = compileJsltStylesheet(rules)(data);
    for (let i = 0; i < rules.length; i++)
      assert.strictEqual(output[`v${i}`], i);
  });

  it('caches one-shot stylesheets by object identity', () => {
    let reads = 0;
    const rule = {};
    Object.defineProperty(rule, 'body', {
      enumerable: true,
      get() {
        reads++;
        return '$';
      },
    });
    const stylesheet = [rule];
    assert.strictEqual(transformJson(stylesheet, 1), 1);
    const afterFirst = reads;
    assert.strictEqual(transformJson(stylesheet, 2), 2);
    assert.strictEqual(reads, afterFirst);
  });

  it('caches one-shot compilation with a counting type-test hook', () => {
    let compileCount = 0;
    const compileTypeTest = () => {
      compileCount++;
      return () => true;
    };
    const stylesheet = [{
      match: { schema: true },
      body: '$',
    }];
    assert.strictEqual(
      transformJson(stylesheet, 1, undefined, { compileTypeTest }), 1);
    assert.strictEqual(
      transformJson(stylesheet, 2, undefined, { compileTypeTest }), 2);
    assert.strictEqual(compileCount, 1);
  });
});
