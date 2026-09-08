import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJtltStylesheet,
  renderText,
  JtltCompileError,
  JtltRuntimeError,
} from './grammar-harness.js';

function makeStubHook() {
  return (schema) => {
    if (schema === false)
      return () => false;
    if (schema === true || typeof schema !== 'object' || schema === null)
      return () => true;
    return (value) => {
      if (schema.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return false;
        const required = schema.required ?? [];
        for (let i = 0; i < required.length; i++) {
          if (!Object.hasOwn(value, required[i]))
            return false;
        }
      }
      if (schema.type === 'number' && typeof value !== 'number')
        return false;
      return true;
    };
  };
}

function compileFails(doc, code, docPath = undefined, options = undefined) {
  assert.throws(() => compileJtltStylesheet(doc, options), (error) => {
    assert.strictEqual(error instanceof JtltCompileError, true,
      `expected JtltCompileError, got ${error.name}: ${error.message}`);
    assert.strictEqual(error.code, code);
    if (docPath !== undefined)
      assert.strictEqual(error.docPath, docPath);
    return true;
  });
}

function renderFails(render, data, code, docPath = undefined) {
  assert.throws(() => render(data), (error) => {
    assert.strictEqual(error instanceof JtltRuntimeError, true,
      `expected JtltRuntimeError, got ${error.name}: ${error.message}`);
    assert.strictEqual(error.code, code);
    if (docPath !== undefined)
      assert.strictEqual(error.docPath, docPath);
    return true;
  });
}

describe('jtlt template shape', () => {
  it('rejects a non-document template', () => {
    compileFails('not a template', 'TL0001', '');
    compileFails(42, 'TL0001', '');
    compileFails(null, 'TL0001', '');
  });

  it('rejects unknown envelope members', () => {
    compileFails({ $jtlt: '0.1', rules: [], extra: 1 }, 'TL0001', '/extra');
  });

  it('requires the version member', () => {
    compileFails({ rules: [] }, 'TL0001', '/$jtlt');
    compileFails({ $jtlt: '0.2', rules: [] }, 'TL0006', '/$jtlt');
  });

  it('rejects unknown output methods with the supported list', () => {
    assert.throws(() => compileJtltStylesheet({ $jtlt: '0.1', output: 'toml', rules: [] }),
      (error) => {
        assert.strictEqual(error.code, 'TL0001');
        assert.strictEqual(error.docPath, '/output');
        assert.match(error.message, /supported: "text", "xml"/);
        return true;
      });
    compileFails({ $jtlt: '0.1', output: 'json', rules: [] }, 'TL0001', '/output');
  });

  it('requires a rules array in the envelope', () => {
    compileFails({ $jtlt: '0.1' }, 'TL0001', '/rules');
    compileFails({ $jtlt: '0.1', rules: {} }, 'TL0001', '/rules');
  });

  it('validates rule shape', () => {
    compileFails([null], 'TL0002', '/0');
    compileFails([{ body: [], nope: 1 }], 'TL0002', '/0/nope');
    compileFails([{ match: '$' }], 'TL0002', '/0/body');
    compileFails([{ body: 'text' }], 'TL0002', '/0/body');
    compileFails([{ body: [], mode: 1 }], 'TL0002', '/0/mode');
    compileFails([{ body: [], priority: '5' }], 'TL0002', '/0/priority');
    compileFails([{ body: [], match: 42 }], 'TL0002', '/0/match');
  });

  it('reserves the built-in priority band', () => {
    compileFails([{ body: [], priority: -1e308 }], 'TL0003', '/0/priority');
    const render = compileJtltStylesheet([{ body: ['*'], priority: -1e306 }]);
    assert.strictEqual(render({}), '*');
  });

  it('rejects non-segment values with the segment docPath', () => {
    compileFails([{ body: ['a', null] }], 'TL0004', '/0/body/1');
    compileFails([{ body: [42] }], 'TL0004', '/0/body/0');
    compileFails([{ body: [true] }], 'TL0004', '/0/body/0');
    compileFails([{ body: [['a', { plain: 1 }]] }], 'TL0004', '/0/body/0/1');
    compileFails({ $jtlt: '0.1', rules: [{ body: [null] }] }, 'TL0004', '/rules/0/body/0');
  });

  it('wraps query compile errors with a remapped docPath', () => {
    compileFails([{ body: ['$9foo'] }], 'TL0005', '/0/body/0');
    compileFails([{ body: [{ $nope: 1 }] }], 'TL0005', '/0/body/0');
    compileFails([{ match: '$[', body: [] }], 'TL0005', '/0/match');
    assert.throws(() => compileJtltStylesheet([{ body: ['$9foo'] }]), (error) => {
      assert.strictEqual(error.cause.name, 'JsltCompileError');
      return true;
    });
  });

  it('requires the type-test hook for schema matches, via the JSLT layer', () => {
    compileFails([{ match: { schema: { type: 'object' } }, body: [] }],
      'TL0005', '/0/match/schema');
  });
});

describe('jtlt text rendering', () => {
  it('renders atoms through the built-in rules', () => {
    const render = compileJtltStylesheet([]);
    assert.strictEqual(render({ a: 1, b: 'x' }), '1x');
    assert.strictEqual(render([true, null, 2.5]), 'true2.5');
    assert.strictEqual(render('solo'), 'solo');
    assert.strictEqual(render({}), '');
  });

  it('interpolates queries between literals', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['Hello ', '$.name', '!'] },
    ]);
    assert.strictEqual(render({ name: 'world' }), 'Hello world!');
  });

  it('drops one dollar from the $$ escape', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['$$price: ', '$.price'] },
    ]);
    assert.strictEqual(render({ price: 9.95 }), '$price: 9.95');
  });

  it('serializes atoms as text: null empty, booleans spelled', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['[', '$.a', '|', '$.b', '|', '$.c', ']'] },
    ]);
    assert.strictEqual(render({ a: null, b: false, c: 0 }), '[|false|0]');
  });

  it('space-joins sequence-valued interpolations, empty is empty', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['[', '$.items[*]', ']', '[', '$.missing', ']'] },
    ]);
    assert.strictEqual(render({ items: [1, 2, 3] }), '[1 2 3][]');
  });

  it('accepts operator phrases as expression segments', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: [{ $upper: '$.name' }, ' (', { $count: '$.items[*]' }, ')'] },
    ]);
    assert.strictEqual(render({ name: 'ada', items: [1, 2] }), 'ADA (2)');
  });

  it('splices $apply output, bare or inside a nested list', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['<', { $apply: '$.items[*]' }, [' / ', [{ $apply: '$.items[*]' }]], '>'] },
      { match: '$.items[*]', body: ['(', '$', ')'] },
    ]);
    assert.strictEqual(render({ items: [1, 2] }), '<(1)(2) / (1)(2)>');
  });

  it('falls back to the built-in rule for unmatched $apply targets', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['[', { $apply: '$.title' }, ']'] },
    ]);
    assert.strictEqual(render({ title: 'T' }), '[T]');
    assert.strictEqual(render({ title: { deep: 'D' } }), '[D]');
  });

  it('lets a matchless rule replace the built-in default', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: [{ $apply: '$[*]' }] },
      { body: ['*'] },
    ]);
    assert.strictEqual(render({ a: 1, b: { c: 2 } }), '**');
  });

  it('resolves conflicts by priority, then by later rule', () => {
    const byPriority = compileJtltStylesheet([
      { match: '$.x', priority: 5, body: ['a'] },
      { match: '$.x', body: ['b'] },
    ]);
    assert.strictEqual(byPriority({ x: 1 }), 'a');
    const byOrder = compileJtltStylesheet([
      { match: '$.x', body: ['a'] },
      { match: '$.x', body: ['b'] },
    ]);
    assert.strictEqual(byOrder({ x: 1 }), 'b');
  });

  it('supports schema matches through the type-test hook', () => {
    const render = compileJtltStylesheet([
      { match: { schema: { type: 'object', required: ['name'] } }, body: ['<', '$.name', '>'] },
    ], { compileTypeTest: makeStubHook() });
    assert.strictEqual(render({ people: [{ name: 'a' }, { name: 'b' }, { other: 1 }] }), '<a><b>1');
  });

  it('binds user externals and exposes them', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['$greeting', ', ', '$.name'] },
    ]);
    assert.deepStrictEqual(render.externals, ['greeting']);
    assert.strictEqual(render({ name: 'Bob' }, { greeting: 'Hi' }), 'Hi, Bob');
  });

  it('exposes the reserved path external', () => {
    const render = compileJtltStylesheet([
      { match: '$..x', body: ['at ', '$path', ';'] },
    ]);
    assert.strictEqual(render({ a: { x: 1 } }), "at $['a']['x'];");
  });

  it('dispatches modes independently, sticky by default', () => {
    const render = compileJtltStylesheet({
      $jtlt: '0.1',
      rules: [
        {
          match: '$',
          body: ['# TOC\n', { $apply: ['$.sections[*]', 'toc'] }, '\n', { $apply: '$.sections[*]' }],
        },
        { mode: 'toc', match: '$.sections[*]', body: ['- ', '$.heading', '\n'] },
        { match: '$.sections[*]', body: ['## ', '$.heading', '\n', '$.text', '\n'] },
      ],
    });
    assert.strictEqual(
      render({ sections: [{ heading: 'Intro', text: 'Start.' }, { heading: 'Use', text: 'Go.' }] }),
      '# TOC\n- Intro\n- Use\n\n## Intro\nStart.\n## Use\nGo.\n');
  });

  it('covers $apply modes that only the built-in rule serves', () => {
    const render = compileJtltStylesheet([
      { match: '$', body: ['[', { $apply: ['$.x', 'other'] }, ']'] },
    ]);
    assert.strictEqual(render({ x: { a: 1, b: 2 } }), '[12]');
  });
});

describe('jtlt xml rendering', () => {
  it('escapes interpolated data, passes literals raw', () => {
    const render = compileJtltStylesheet({
      $jtlt: '0.1',
      output: 'xml',
      rules: [
        { match: '$', body: ['<p title="', '$.title', '">', '$.text', '</p>'] },
      ],
    });
    assert.strictEqual(render.output, 'xml');
    assert.strictEqual(
      render({ title: 'a"b\'c', text: '1 < 2 & 3 > 2' }),
      '<p title="a&quot;b&#39;c">1 &lt; 2 &amp; 3 &gt; 2</p>');
  });

  it('escapes the built-in atom emission too', () => {
    const render = compileJtltStylesheet({ $jtlt: '0.1', output: 'xml', rules: [] });
    assert.strictEqual(render({ a: '<' }), '&lt;');
  });

  it('lets $raw opt out of escaping', () => {
    const render = compileJtltStylesheet({
      $jtlt: '0.1',
      output: 'xml',
      rules: [{ match: '$', body: [{ $raw: '$.markup' }, '|', '$.markup'] }],
    });
    assert.strictEqual(render({ markup: '<b>x</b>' }), '<b>x</b>|&lt;b&gt;x&lt;/b&gt;');
  });

  it('embeds JSON with $json, method-escaped', () => {
    const xml = compileJtltStylesheet({
      $jtlt: '0.1',
      output: 'xml',
      rules: [{ match: '$', body: [{ $json: '$' }] }],
    });
    assert.strictEqual(xml({ a: '<' }), '{&quot;a&quot;:&quot;&lt;&quot;}');
    const text = compileJtltStylesheet([{ match: '$', body: [{ $json: '$' }] }]);
    assert.strictEqual(text({ a: '<' }), '{"a":"<"}');
  });
});

describe('jtlt runtime errors', () => {
  it('rejects interpolating a container, pointing at the segment', () => {
    const render = compileJtltStylesheet([{ match: '$', body: ['$'] }]);
    renderFails(render, { a: 1 }, 'TL2001', '/0/body/0');
    renderFails(render, [1], 'TL2001', '/0/body/0');
    assert.strictEqual(render('atom'), 'atom');
  });

  it('wraps the JSLT depth guard for recursive dispatch', () => {
    // a matchless rule matches location-less values too, so `$apply: '$'`
    // (which dispatches the current node without a location) recurses
    const render = compileJtltStylesheet(
      [{ body: [{ $apply: '$' }] }],
      { maxDepth: 8 });
    assert.throws(() => render({}), (error) => {
      assert.strictEqual(error instanceof JtltRuntimeError, true);
      assert.strictEqual(error.code, 'TL2003');
      assert.strictEqual(error.cause.code, 'JT2001');
      return true;
    });
  });
});

describe('jtlt metadata and one-call API', () => {
  it('exposes frozen doc and the compiled JSLT stylesheet', () => {
    const doc = [{ match: '$', body: ['x'] }];
    const render = compileJtltStylesheet(doc);
    assert.strictEqual(render.output, 'text');
    assert.strictEqual(Object.isFrozen(render.doc), true);
    assert.notStrictEqual(render.doc, doc);
    assert.strictEqual(render.stylesheet.$jslt, '0.1');
    // one user rule plus the built-in catch-all of the default mode
    assert.strictEqual(render.stylesheet.rules.length, 2);
    assert.strictEqual(Object.isFrozen(render.stylesheet), true);
  });

  it('renderText renders in one call and caches by identity', () => {
    const doc = [{ match: '$', body: ['Hello ', '$.name'] }];
    assert.strictEqual(renderText(doc, { name: 'a' }), 'Hello a');
    assert.strictEqual(renderText(doc, { name: 'b' }), 'Hello b');
    assert.strictEqual(renderText(doc, { name: 'c' }, undefined, { maxDepth: 16 }), 'Hello c');
    assert.throws(() => renderText('nope', {}), JtltCompileError);
  });
});
