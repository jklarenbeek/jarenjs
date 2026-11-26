//@ts-check
/**
 * @file The app authoring gate's findings beyond the meta-schema: an
 * element written as an object is refused `JS0004` (both renderers draw
 * it as nothing); text holding another template language's expression is
 * warned `JS0005` (it may be real text); any other object where a vnode
 * renders is warned `JS0006`, and an element written as an object in an
 * element's props position `JS0007` (both render as something the author
 * may mean); and an unknown operator is
 * reported as the compiler's `JQ0002` at its own place, with the nearest
 * known operator, in place of the branch errors it causes in the grammar.
 * Every wrong-answer row has right-answer rows beside it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateFile, STUDIO_CODES } from '@jarenjs/studio';
import { renderToString } from '@jarenjs/view';
import { compileJsonQuery } from '@jarenjs/json';
import { createJsltRegistry } from '@jarenjs/json/jslt';

const app = (body, state = {}, extra = {}) => ({ name: 'app.json', kind: 'app', text: JSON.stringify({ state, view: [{ match: '$', body }], ...extra }) });
const codes = (verdict) => verdict.errors.map((e) => `${e.code} ${e.docPath}`);
const warned = (verdict) => verdict.warnings.map((w) => `${w.code} ${w.docPath}`);

describe('JS0004: an element written as an object is refused', () => {
  const li = { tag: 'li', props: {}, children: ['x'] };

  it('renders as nothing in the view, which is why it is refused', () => {
    assert.equal(renderToString(['ul', {}, li]), '<ul></ul>');
  });

  for (const [name, child] of /** @type {const} */ ([
    ['tag + props + children', li],
    ['type + children', { type: 'li', children: ['x'] }],
    ['tag + attrs', { tag: 'li', attrs: { class: 'a' } }],
  ])) {
    it(`a literal child (${name}) at its own place, naming the array form`, () => {
      const verdict = validateFile(app(['ul', {}, child]));
      assert.equal(verdict.valid, false);
      assert.deepEqual(codes(verdict), ['JS0004 /view/0/body/2']);
      assert.match(verdict.errors[0].message, /a vnode is an array: \['li', \{attrs\}, …children\]/);
    });
  }

  it('in a branch the first frame does not take: a $for over an empty list, an $if not taken', () => {
    const verdict = validateFile(app(['div', {},
      ['ul', {}, { $for: { i: '$.items[*]' }, $return: { tag: 'li', children: ['$i'] } }],
      { $if: ['$.on', { type: 'b', children: ['on'] }, 'off'] }], { items: [], on: false }));
    assert.deepEqual(codes(verdict), ['JS0004 /view/0/body/2/2/$return', 'JS0004 /view/0/body/3/$if/1']);
  });

  it('in the first frame: a rule body object at the root, or one a query computed', () => {
    const root = validateFile(app(li));
    assert.deepEqual(codes(root), ['JS0004 /view']);
    assert.match(root.errors[0].message, /at its root/);
    const computed = validateFile(app(['ul', {}, '$.node'], { node: li }));
    assert.deepEqual(codes(computed), ['JS0004 /view']);
    assert.match(computed.errors[0].message, /at \/2/);
  });

  it('a right answer is not refused: data objects outside vnode child positions', () => {
    const data = { type: 'Feature', children: [1, 2] };
    for (const [name, body, state] of /** @type {Array<[string, any, any]>} */ ([
      ['in state, shown through a path to text', ['p', {}, '$.doc.type'], { doc: data }],
      ['as element props', ['input', { type: 'text', children: 'x' }], {}],
      ['as a widget\'s props', ['jaren-widget', { name: 'chart', props: { config: data } }], {}],
      ['as a $let argument', ['p', {}, { $let: { n: data }, $return: '$n.type' }], {}],
      ['as an operator operand', ['p', {}, { $string: { $count: [data] } }], {}],
      ['an object without the element shape', ['div', {}, { a: 1 }], {}],
      ['the array form itself', ['ul', {}, ['li', {}, 'x']], {}],
    ])) {
      const verdict = validateFile(app(body, state));
      assert.deepEqual(codes(verdict), [], name);
      assert.equal(verdict.valid, true, name);
    }
  });
});

describe('JS0005: text holding another template language is warned, never refused', () => {
  for (const text of ['Total: ${count(items)}', '{{ items }}', '{% for i in items %}', 'for .items : .', '[for (.items) .name]', 'if (.on) "yes"', 'size([1, 2])']) {
    it(JSON.stringify(text), () => {
      const verdict = validateFile(app(['p', {}, text]));
      assert.equal(verdict.valid, true);
      assert.deepEqual(warned(verdict), ['JS0005 /view/0/body/2']);
    });
  }

  it('plain text, a state string shown through a path, and attribute values are not warned', () => {
    for (const [body, state] of /** @type {Array<[any, any]>} */ ([
      [['p', {}, 'Use {x} here, or f(x), for a while; if so.'], {}],
      [['p', {}, '$.s'], { s: '{{ x }} and ${y}' }],
      [['a', { title: '{{ x }}' }, 'link'], {}],
    ])) assert.deepEqual(validateFile(app(body, state)).warnings, [], JSON.stringify(body));
  });

  it('every verdict carries warnings, empty for every other kind', () => {
    assert.deepEqual(validateFile({ name: 'q', kind: 'query', text: '"{{ x }}"' }).warnings, []);
    assert.deepEqual(validateFile({ name: 's', kind: 'state', text: '1' }).warnings, []);
  });
});

describe('JS0006: any other object where a vnode renders is warned, never refused', () => {
  it('renders as nothing, as an element written as an object does', () => {
    assert.equal(renderToString(['div', {}, { class: 'x' }]), '<div></div>');
  });

  it('a literal child at its own place, a computed one in the first frame, and one at the root', () => {
    const literal = validateFile(app(['div', {}, { class: 'x' }]));
    assert.deepEqual([literal.valid, codes(literal), warned(literal)], [true, [], ['JS0006 /view/0/body/2']]);
    assert.match(literal.warnings[0].message, /^an object with 'class' is not a vnode and renders as nothing/);
    const computed = validateFile(app(['div', {}, '$.user'], { user: { name: 'Ada' } }));
    assert.deepEqual([computed.valid, warned(computed)], [true, ['JS0006 /view']]);
    assert.match(computed.warnings[0].message, /^the first frame renders, at \/2, an object with 'name'/);
    const root = validateFile(app({ a: 1 }));
    assert.deepEqual([root.valid, warned(root)], [true, ['JS0006 /view']]);
    assert.match(root.warnings[0].message, /at its root/);
  });

  it('a literal placed in the stylesheet is warned once, at its place, not again in the frame', () => {
    assert.deepEqual(warned(validateFile(app(['div', {}, { a: 1 }, ['p', {}, { b: 2 }]]))), ['JS0006 /view/0/body/2', 'JS0006 /view/0/body/3/2']);
  });

  it('right answers carry no warning: data objects outside vnode child positions', () => {
    const data = { type: 'Feature', children: [1, 2] };
    for (const [name, body, state] of /** @type {Array<[string, any, any]>} */ ([
      ['in state, shown through a path to text', ['p', {}, '$.doc.type'], { doc: data }],
      ['as element props', ['input', { type: 'text', children: 'x' }], {}],
      ['as a widget\'s props', ['jaren-widget', { name: 'chart', props: { config: data } }], {}],
      ['as a $let argument', ['p', {}, { $let: { n: data }, $return: '$n.type' }], {}],
      ['as an operator operand', ['p', {}, { $string: { $count: [data] } }], {}],
      ['the array form itself', ['ul', {}, ['li', {}, 'x']], {}],
      ['props an operator computes', ['p', { $if: ['$.on', { class: 'a' }, { class: 'b' }] }, 'x'], { on: true }],
    ])) {
      const verdict = validateFile(app(body, state));
      assert.deepEqual([verdict.valid, codes(verdict), warned(verdict)], [true, [], []], name);
    }
  });
});

describe('JS0007: an element written as an object in the props position is warned, never refused', () => {
  it('is read as the element\'s attributes, so it renders, just not as the child it was meant to be', () => {
    assert.equal(renderToString(['ul', { tag: 'li', children: ['x'] }]), '<ul tag="li" children="x"></ul>');
  });

  it('a literal one at its place, and one a query computed', () => {
    const literal = validateFile(app(['ul', { tag: 'li', children: ['x'] }]));
    assert.deepEqual([literal.valid, codes(literal), warned(literal)], [true, [], ['JS0007 /view/0/body/1']]);
    assert.match(literal.warnings[0].message, /in the props position is read as this element's attributes; a child element is an array after the props: \['li', \{attrs\}, …children\]/);
    const computed = validateFile(app(['ul', '$.item', 'x'], { item: { tag: 'li', props: {} } }));
    assert.deepEqual([computed.valid, warned(computed)], [true, ['JS0007 /view']]);
    assert.match(computed.warnings[0].message, /^the first frame renders, at \/1, an element written as an object/);
  });

  it('type alone is an HTML attribute there, not the shape: no warning', () => {
    for (const props of [{ type: 'li', children: ['x'] }, { type: 'submit', attrs: 'x' }, { tag: 'li' }]) {
      assert.deepEqual(warned(validateFile(app(['button', props, 'go']))), [], JSON.stringify(props));
    }
  });
});

describe('the app render audit renders with the host\'s operators', () => {
  const twice = app(['p', {}, { $string: { $call: ['twice', 21] } }]);
  const host = createJsltRegistry().use({ name: 'host', entries: { twice: { kind: 'fn', fn: (/** @type {number} */ x) => x * 2 } } });

  it('a function the host registers renders, so the file is valid under that registry', () => {
    assert.deepEqual(validateFile(twice, { operators: host }), { valid: true, kind: 'app', total: 0, errors: [], warnings: [] });
  });

  it('without it the first frame does not render, and the file is refused as before', () => {
    const verdict = validateFile(twice);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors[0].message, /^the view failed to render its first frame: .*'\$call' names no registered func/);
    assert.equal(validateFile(twice, { operators: createJsltRegistry() }).valid, false);
  });
});

describe('JQ0002 wins over the branch errors an unknown operator causes', () => {
  const action = (search) => app(['p', {}, 'x'], { q: 'A' }, { actions: { search } });

  it('$lower-case names $lower, at the operator\'s own place', () => {
    const verdict = validateFile(action({ state: { q: { '$lower-case': '$.q' } } }));
    assert.deepEqual(verdict.errors, [{ code: 'JQ0002', message: "unknown operator '$lower-case' (did you mean '$lower'?)", docPath: '/actions/search/state/q' }]);
    assert.equal(verdict.total, 1);
  });

  it('a wholly foreign $frobnicate is unknown with no suggestion', () => {
    const verdict = validateFile(action({ '$frobnicate': '$.q' }));
    assert.deepEqual(verdict.errors, [{ code: 'JQ0002', message: "unknown operator '$frobnicate'", docPath: '/actions/search' }]);
  });

  it('a correct action is unchanged', () => {
    assert.deepEqual(validateFile(action({ state: { q: { $lower: '$.q' } } })),
      { valid: true, kind: 'app', total: 0, errors: [], warnings: [] });
  });

  it('in an awaiting continuation, a subscription, the view (both stylesheet forms), an fsm guard and a dag query', () => {
    const op = { '$lower-case': '$.q' };
    const rows = [
      [app(['p', {}, 'x'], {}, { actions: { go: { $await: { run: 'fetch', then: { r: op } } } } }), '/actions/go/$await/then/r'],
      [app(['p', {}, 'x'], {}, { subs: [{ run: 'tick', when: op }] }), '/subs/0/when'],
      [app(['p', {}, op]), '/view/0/body/2'],
      [{ name: 'a', kind: 'app', text: JSON.stringify({ view: { $jslt: '0.1', rules: [{ match: '$', body: ['p', {}, op] }] } }) }, '/view/rules/0/body/2'],
      [{ name: 'f', kind: 'fsm', text: JSON.stringify({ initial: 'a', states: ['a', 'b'], transitions: [{ from: 'a', to: 'b', event: 'GO', guard: op }] }) }, '/transitions/0/guard'],
      [{ name: 'd', kind: 'dag', text: JSON.stringify({ $dag: '0.1', nodes: { input: { kind: 'input' }, q: { kind: 'query', query: op }, output: { kind: 'output' } },
        edges: [{ from: 'input', to: 'q' }, { from: 'q', to: 'output' }] }) }, '/nodes/q/query'],
    ];
    for (const [file, at] of rows) {
      const verdict = validateFile(/** @type {any} */ (file));
      assert.deepEqual(codes(verdict), [`JQ0002 ${at}`], String(at));
      assert.match(verdict.errors[0].message, /did you mean '\$lower'/);
    }
  });

  it('schema errors the operator does not explain stay', () => {
    const verdict = validateFile(app(['p', {}, 'x'], {}, { actions: { search: { '$lower-case': '$.q' } }, subs: 5 }));
    assert.equal(verdict.errors[0].code, 'JQ0002');
    assert.ok(verdict.errors.some((e) => e.code === null && e.docPath === '/subs'), JSON.stringify(verdict.errors));
  });

  it('the compiler names the nearest operator wherever it compiles one', () => {
    assert.throws(() => compileJsonQuery({ '$upper-case': '$.q' }), { code: 'JQ0002', message: /did you mean '\$upper'\?/ });
    assert.throws(() => compileJsonQuery({ '$frob': 1 }), { code: 'JQ0002', message: /did you mean '\$for'\?/ });
    assert.throws(() => compileJsonQuery({ '$frobnicate': 1 }), (/** @type {any} */ e) => e.code === 'JQ0002' && !/did you mean/.test(e.message));
  });
});

describe('the studio codes', () => {
  it('registers the authoring gate\'s codes', () => {
    for (const code of ['JS0004', 'JS0005', 'JS0006', 'JS0007']) assert.ok(Object.hasOwn(STUDIO_CODES, code), code);
  });
});

describe('the gate keeps its own answers where nothing is unknown or many warnings come first', () => {
  it('a malformed $await stays the grammar\'s error, never an unknown $await operator', () => {
    for (const $await of ['fetch', [1]]) {
      const verdict = validateFile(app(['p', {}, 'x'], {}, { actions: { go: { $await } } }));
      assert.equal(verdict.valid, false);
      assert.ok(verdict.errors.every((e) => e.code !== 'JQ0002'), JSON.stringify(verdict.errors[0]));
    }
  });

  it('twenty-five warned texts do not hide a refusal behind them', () => {
    const texts = Array.from({ length: 25 }, (_, i) => `{{ x${i} }}`);
    const verdict = validateFile(app(['div', {}, ...texts, ['ul', {}, { $for: { i: '$.items[*]' }, $return: { tag: 'li', children: ['$i'] } }]], { items: [] }));
    assert.equal(verdict.valid, false);
    assert.deepEqual(codes(verdict), ['JS0004 /view/0/body/27/2/$return']);
    assert.equal(verdict.warnings.length, 20);
  });

  it('a bare prefix is not an operator meant: $format names $format-number, $letter nothing', () => {
    assert.throws(() => compileJsonQuery({ $letter: 1 }), (/** @type {any} */ e) => e.code === 'JQ0002' && !/did you mean/.test(e.message));
    assert.throws(() => compileJsonQuery({ $format: 1 }), { code: 'JQ0002', message: /did you mean '\$format-number'\?/ });
    assert.throws(() => compileJsonQuery({ $counting: 1 }), (/** @type {any} */ e) => e.code === 'JQ0002' && !/did you mean/.test(e.message));
  });
});
