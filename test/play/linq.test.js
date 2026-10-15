//@ts-check
/**
 * @file The linq engine: the Chain pane holds a fluent `@jarenjs/linq`
 * chain as TEXT, read without eval or `new Function` and replayed against
 * the real chain surface, so the document it shows is the one the same
 * chain written in JavaScript emits — byte for byte — and the answer is
 * that document run over the Data pane.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { runExample, ENGINES, EXAMPLES } from '@jarenjs/play';
import { from, Sequence } from '@jarenjs/linq';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { CHAIN_METHODS, EXPRESSION_METHODS } from '../../components/play/src/chain.js';

const compileTypeTest = createTypeTestCompiler();

const PEOPLE = [
  { id: 1, name: 'Cleo', age: 34, team: 'core', managerId: null },
  { id: 2, name: 'Ada', age: 19, team: 'core', managerId: 1 },
  { id: 3, name: 'Bo', age: 41, team: 'web', managerId: 1 },
];
const data = { data: JSON.stringify(PEOPLE) };

/** @param {any} r @param {string} id */
const panel = (r, id) => r.panels.find((p) => p.id === id);
/** Run a chain over PEOPLE; the answer and the document, parsed back. */
const run = (chain, d = data) => {
  const r = /** @type {any} */ (runExample('linq', { chain }, d));
  assert.equal(r.ok, true, r.error?.message);
  return { answer: JSON.parse(panel(r, 'out').text), document: JSON.parse(panel(r, 'document').text), r };
};
/** The error of a chain that must fail. */
const refused = (chain, d = data) => {
  const r = /** @type {any} */ (runExample('linq', { chain }, d));
  assert.equal(r.ok, false, `expected a refusal for ${chain}`);
  assert.deepEqual(r.panels, []);
  return r.error;
};

describe('@jarenjs/play — the linq engine reads a chain and shows its document beside its answer', () => {
  it('declares a Chain source pane and a Data pane', () => {
    const e = ENGINES.linq;
    assert.ok(e, 'a linq descriptor is registered');
    assert.deepEqual(e.sourcePanes.map((p) => p.key), ['chain']);
    assert.deepEqual(e.dataPanes.map((p) => p.key), ['data']);
  });

  it('emits exactly the document the same chain written in JavaScript emits, and answers it', () => {
    const { answer, document, r } = run(`from(data)
      .where((u) => u.age.gt(21))
      .orderBy((u) => u.name)
      .select((u) => ({ id: u.id, name: u.name }))`);
    const js = from(PEOPLE).where((u) => u.age.gt(21)).orderBy((u) => u.name).select((u) => ({ id: u.id, name: u.name }));
    assert.deepEqual(document, js.toDocument());
    assert.deepEqual(document, {
      $for: { it: ['$[*]'] }, $where: { $gt: ['$it.age', 21] },
      $orderby: { $key: '$it.name' }, $return: { id: '$it.id', name: '$it.name' },
    });
    assert.deepEqual(answer, [{ id: 3, name: 'Bo' }, { id: 1, name: 'Cleo' }]);
    // the answer and the document are both calm screens; the counts ride deep
    assert.deepEqual(r.panels.map((p) => [p.id, p.depth ?? 'simple']), [['out', 'simple'], ['document', 'simple'], ['how', 'deep']]);
    assert.equal(r.panels[2].items[0].value, '2');
  });

  it('agrees with JavaScript across the chain surface: groups, parameters, joins, folds, windows and schemas', () => {
    const cases = [
      [`from(data).groupBy((u) => u.team).select((g) => ({ team: g.key, people: g.items.count() }))`,
        from(PEOPLE).groupBy((u) => u.team).select((g) => ({ team: g.key, people: g.items.count() }))],
      [`from(data).params({ min: 30 }).where((u, p) => u.age.ge(p.min)).select((u) => u.name)`,
        from(PEOPLE).params({ min: 30 }).where((u, p) => u.age.ge(p.min)).select((u) => u.name)],
      [`from(data).join(from(data), (m) => m.id, (r) => r.managerId, (m, r) => ({ manager: m.name, report: r.name }))`,
        from(PEOPLE).join(from(PEOPLE), (m) => m.id, (r) => r.managerId, (m, r) => ({ manager: m.name, report: r.name }))],
      [`from(data).select((u) => u.age).aggregate(0, (total, age) => total.add(age))`,
        from(PEOPLE).select((u) => u.age).aggregate(0, (total, age) => total.add(age))],
      [`from(data).orderByDescending((u) => u.age).skip(1).take(1).select((u) => [u.name, u.team])`,
        from(PEOPLE).orderByDescending((u) => u.age).skip(1).take(1).select((u) => [u.name, u.team])],
      [`from(data).select((u) => u.team).distinct().reverse()`,
        from(PEOPLE).select((u) => u.team).distinct().reverse()],
      [`from(data).where((u) => u.name.startsWith('C').or(u.age.lt(20).and(u.team.eq('core'))))`,
        from(PEOPLE).where((u) => u.name.startsWith('C').or(u.age.lt(20).and(u.team.eq('core'))))],
      [`from(data).ofType({ type: 'object', properties: { managerId: { type: 'integer' } } }).select((u) => u.name)`,
        from(PEOPLE, { compileTypeTest }).ofType({ type: 'object', properties: { managerId: { type: 'integer' } } }).select((u) => u.name)],
      [`from(data).where((u) => u.age.gt(99)).defaultIfEmpty({ name: 'nobody' })`,
        from(PEOPLE).where((u) => u.age.gt(99)).defaultIfEmpty({ name: 'nobody' })],
      [`from(data).select((u) => ({ n: u.name.upper(), next: u.age.add(1), label: u.get('odd key') }))`,
        from(PEOPLE).select((u) => ({ n: u.name.upper(), next: u.age.add(1), label: u.get('odd key') }))],
    ];
    for (const [chain, js] of cases) {
      const { answer, document } = run(/** @type {string} */ (chain));
      const seq = /** @type {any} */ (js);
      assert.deepEqual(document, seq.toDocument(), chain);
      assert.deepEqual(answer, seq.toArray(), chain);
    }
  });

  it('reads comments, either quote, negative numbers, trailing commas and a closing semicolon', () => {
    const { answer, document } = run(`// the people past a threshold
      from(data) /* every row */
        .where((u) => u.age.gt(-1).and(u.name.ne("x"),))
        .select((u) => ({ 'who': u.name, }));`);
    assert.deepEqual(document, from(PEOPLE).where((u) => u.age.gt(-1).and(u.name.ne('x'))).select((u) => ({ who: u.name })).toDocument());
    assert.deepEqual(answer, [{ who: 'Cleo' }, { who: 'Ada' }, { who: 'Bo' }]);
  });

  it('keeps a member named __proto__ or constructor an own member of a constructed object', () => {
    const { answer, document } = run(`from(data).take(1).select((u) => ({ __proto__: u.name, constructor: u.id }))`);
    assert.deepEqual(Object.keys(document.$return).sort(), ['__proto__', 'constructor']);
    assert.deepEqual(JSON.stringify(answer), '[{"__proto__":"Cleo","constructor":1}]');
  });

  it('the dataset switcher runs one chain over several shapes', () => {
    const multi = EXAMPLES.filter((e) => e.engine === 'linq' && e.datasets.length >= 2);
    assert.ok(multi.length >= 1, 'a linq example carries a dataset switcher');
  });
});

describe('@jarenjs/play — the linq engine refuses what JavaScript would capture wrongly, and says where', () => {
  it('refuses a JavaScript operator at its position and names the method that spells it', () => {
    for (const [chain, op, spelling] of [
      ['from(data).where((u) => u.age > 21)', '>', '.gt('],
      ['from(data).where((u) => u.age.gt(1) && u.age.lt(9))', '&&', '.and('],
      ['from(data).where((u) => !u.archived)', '!', '.not('],
      ['from(data).select((u) => u.age + 1)', '+', '.add('],
      ['from(data).where((u) => u.name === "Ada")', '===', '.eq('],
    ]) {
      const e = refused(chain);
      assert.equal(e.code, 'PLAY_CHAIN', chain);
      assert.equal(e.pane, 'chain', chain);
      assert.equal(e.position, chain.lastIndexOf(op), chain);
      assert.ok(e.message.includes(spelling), `${chain}: ${e.message}`);
    }
  });

  it('locates what it cannot read: an unclosed string or comment, an unknown escape, a template literal, a stray character', () => {
    for (const [chain, at, pattern] of [
      ["from(data).select((u) => 'abc)", 25, /never closed/],
      ['from(data) /* every row', 11, /never closed/],
      ["from(data).select((u) => u.name.eq('a\\q'))", 37, /unknown escape/],
      ['from(data).select((u) => `x${u.name}`)', 25, /\.concat\(\)/],
      ['from(data).select((u) => u.name) #', 33, /unexpected character/],
    ]) {
      const e = refused(/** @type {string} */ (chain));
      assert.equal(e.position, at, chain);
      assert.match(e.message, /** @type {RegExp} */ (pattern), chain);
    }
    assert.deepEqual(run("from(data).take(1).select((u) => '\\u0041\\n')").answer, ['A\n']);
  });

  it('refuses a block body, which JavaScript reads as a statement and not an object', () => {
    const chain = 'from(data).select((u) => { id: u.id })';
    const e = refused(chain);
    assert.equal(e.position, chain.indexOf('{'));
    assert.match(e.message, /\(\{ … \}\)/);
  });

  it('starts from from(data), and refuses a terminal or a method the chain surface has not got', () => {
    assert.equal(refused('where((u) => u.age.gt(1))').position, 0);
    assert.match(refused('from(rows)').message, /from\(data\)/);
    for (const name of ['toArray', 'count', 'first', 'toDocument']) {
      const chain = `from(data).${name}()`;
      const e = refused(chain);
      assert.equal(e.position, chain.indexOf(name));
      assert.match(e.message, /terminal/, name);
    }
    for (const name of ['constructor', 'mapAsync', 'zip', 'nope']) {
      const chain = `from(data).${name}()`;
      const e = refused(chain);
      assert.equal(e.position, chain.indexOf(name));
      assert.match(e.message, /not a chain operator/, name);
    }
  });

  it('reads only a callback\'s own parameters, and no member off a literal', () => {
    const outside = 'from(data).where((u) => x.age.gt(1))';
    assert.equal(refused(outside).position, outside.indexOf('x.'));
    const literal = "from(data).select((u) => 'abc'.length)";
    assert.equal(refused(literal).position, literal.indexOf('.length'));
    const bare = 'from(data).take(n)';
    assert.equal(refused(bare).position, bare.indexOf('n)'));
    const index = 'from(data).select((u) => u.tags[0])';
    assert.match(refused(index).message, /\.at\(/);
  });

  it('refuses a method read without its call, and reads a member of that name with get()', () => {
    const chain = 'from(data).select((u) => u.count)';
    const e = refused(chain);
    assert.equal(e.position, chain.indexOf('count'));
    assert.match(e.message, /get\('count'\)/);
    assert.match(refused('from(data).select((u) => u.toJSON)').message, /get\('toJSON'\)/);
    assert.deepEqual(run("from(data).take(1).select((u) => u.get('count'))").answer, []);
  });

  it('never reaches a host constructor: a member named constructor is data, and calling it is refused', () => {
    const chain = "from(data).select((u) => u.constructor.constructor('return 1'))";
    const e = refused(chain);
    assert.equal(e.position, chain.lastIndexOf('constructor'));
    assert.match(e.message, /not a method/);
    assert.deepEqual(run('from(data).take(1).select((u) => u.constructor)').document.$return, '$it.constructor');
  });

  it('a chain refusal from the linq package itself keeps its code and points at the call', () => {
    const chain = 'from(data).take(1, 2)';
    const e = refused(chain);
    assert.equal(e.code, 'JL0005');
    assert.equal(e.pane, 'chain');
    assert.equal(e.position, chain.indexOf('take'));
    const notIterable = refused('from(data)', { data: '{"a":1}' });
    assert.equal(notIterable.code, 'JL0001');
    assert.equal(notIterable.position, 0);
  });

  it('a runtime error of the generated document is located in that document, with no pane (as XQuery)', () => {
    const e = refused('from(data).select((u) => u.name.add(1))');
    assert.equal(e.code, 'JQ2001');
    assert.equal(e.pane, undefined);
    assert.equal(typeof e.path, 'string');
  });

  it('the broken-on-purpose example refuses its operator, and the spelling it names runs', () => {
    const ex = EXAMPLES.find((e) => e.id === 'linq-operator');
    const e = refused(ex.source.chain, ex.datasets[0].data);
    assert.equal(e.position, ex.source.chain.lastIndexOf('>'));
    const fixed = run(ex.source.chain.replace('u.age > 21', 'u.age.gt(21)'), ex.datasets[0].data);
    assert.deepEqual(fixed.answer.map((u) => u.name), ['Cleo', 'Bo', 'Dee']);
  });

  it('a data pane that is not JSON locates the data pane', () => {
    assert.equal(refused('from(data)', { data: '{broken' }).pane, 'data');
  });
});

describe('@jarenjs/play — the chain reader\'s closed vocabulary', () => {
  it('every chain operator it offers returns a Sequence', () => {
    for (const name of CHAIN_METHODS) assert.equal(typeof (/** @type {any} */ (Sequence.prototype))[name], 'function', name);
    const rows = from(PEOPLE, { compileTypeTest });
    const sample = {
      where: () => rows.where((u) => u.age.gt(1)), select: () => rows.select((u) => u.id),
      selectMany: () => rows.selectMany((u) => [u.id]), orderBy: () => rows.orderBy((u) => u.id),
      orderByDescending: () => rows.orderByDescending((u) => u.id), thenBy: () => rows.orderBy((u) => u.id).thenBy((u) => u.age),
      thenByDescending: () => rows.orderBy((u) => u.id).thenByDescending((u) => u.age), groupBy: () => rows.groupBy((u) => u.team),
      join: () => rows.join(rows, (a) => a.id, (b) => b.managerId, (a, b) => ({ a: a.id, b: b.id })),
      groupJoin: () => rows.groupJoin(rows, (a) => a.id, (b) => b.managerId, (a, g) => ({ a: a.id, n: g.count() })),
      aggregate: () => rows.select((u) => u.age).aggregate(0, (t, a) => t.add(a)), skip: () => rows.skip(1), take: () => rows.take(1),
      distinct: () => rows.distinct(), reverse: () => rows.reverse(), concat: () => rows.concat(rows),
      defaultIfEmpty: () => rows.defaultIfEmpty(null), ofType: () => rows.ofType({ type: 'object' }), cast: () => rows.cast({ type: 'object' }),
      params: () => rows.params({ min: 1 }),
    };
    assert.deepEqual([...CHAIN_METHODS].sort(), Object.keys(sample).sort());
    for (const name of CHAIN_METHODS) assert.ok(sample[name]() instanceof Sequence, name);
  });

  it('every expression method it offers is a method of the recording proxy', () => {
    from(PEOPLE).where((u) => {
      for (const name of EXPRESSION_METHODS) assert.equal(typeof u[name], 'function', name);
      return u.age.gt(1);
    }).toDocument();
  });
});
