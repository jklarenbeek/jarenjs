import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  canonicalizeJson,
  canonicalSha256,
  cloneJson,
  compileJSONPath,
  compileJSONPathSetter,
  compileJsonQuery,
  queryJSONPath,
  JsonCanonicalizeError,
  JsonQueryRuntimeError,
  queryMessagesEn,
  renderQueryMessage,
} from '@jarenjs/json';

/** `n` arrays nested around `0` */
const nestedArrays = (n) => { let v = 0; for (let i = 0; i < n; i++) v = [v]; return v; };
/** `n` objects nested around `0` under `a` */
const nestedObjects = (n) => { let v = 0; for (let i = 0; i < n; i++) v = { a: v }; return v; };

describe('the canonical serializer\'s depth bound', () => {
  it('serializes a value nested 1000 levels deep and refuses one level more', () => {
    assert.equal(canonicalizeJson(nestedArrays(1000)), '['.repeat(1000) + '0' + ']'.repeat(1000));
    assert.equal(canonicalizeJson(nestedObjects(1000)), '{"a":'.repeat(1000) + '0' + '}'.repeat(1000));
    for (const deep of [nestedArrays(1001), nestedObjects(1001), nestedArrays(100000)]) {
      assert.throws(() => canonicalizeJson(deep), (e) => e instanceof JsonCanonicalizeError
        && e.message.startsWith('a value nested deeper than 1000 levels cannot be canonicalized at /'));
    }
  });

  it('locates the refusal at the first container past the bound', () => {
    try { canonicalizeJson(nestedObjects(1001)); assert.fail('canonicalized'); }
    catch (e) { assert.equal(e.dataPath, '/a'.repeat(1000)); }
  });

  it('bounds the copy and the content identity built on it', async () => {
    assert.throws(() => cloneJson(nestedArrays(100000)), JsonCanonicalizeError);
    await assert.rejects(canonicalSha256(nestedArrays(100000)), JsonCanonicalizeError);
    assert.deepEqual(cloneJson(nestedArrays(3)), [[[0]]]);
  });
});

describe('the JSONPath descendant segment\'s depth bound', () => {
  const refusal = (e) => e instanceof JsonQueryRuntimeError && e.code === 'JQ2009'
    && e.message === 'JQ2009: a descendant segment reaches a value nested deeper than 1000 levels at \'\'';
  const all = compileJSONPath('$..*');

  it('descends a value nested 1000 levels deep in every mode', () => {
    for (const make of [nestedArrays, nestedObjects]) {
      const value = make(1000);
      assert.equal(all(value).length, 1000);
      assert.equal(all.paths(value).length, 1000);
      assert.equal(all.nodes(value).length, 1000);
      assert.equal([...all.iterate(value)].length, 1000);
      assert.equal(queryJSONPath('$..*', value).length, 1000);
    }
  });

  it('refuses one level more in every mode', () => {
    for (const deep of [nestedArrays(1001), nestedObjects(1001), nestedArrays(100000)]) {
      assert.throws(() => all(deep), refusal);
      assert.throws(() => all.paths(deep), refusal);
      assert.throws(() => all.nodes(deep), refusal);
      assert.throws(() => [...all.iterate(deep)], refusal);
      assert.throws(() => queryJSONPath('$..*', deep), refusal);
    }
  });

  it('answers first and exists without walking past the first node', () => {
    const deep = nestedArrays(100000);
    assert.equal(all.first(deep), deep[0]);
    assert.equal(all.exists(deep), true);
    assert.equal(all.first(nestedArrays(0)), undefined);
  });

  it('counts the walks a filter starts inside a descent with the descent', () => {
    assert.equal(compileJSONPath('$..[?@..*]')(nestedArrays(999)).length, 998);
    assert.throws(() => compileJSONPath('$..[?@..*]')(nestedArrays(100000)), refusal);
    assert.throws(() => compileJSONPath('$..[?$..*]')(nestedArrays(600)), refusal);
    assert.equal(compileJSONPath('$..[?$..*]')(nestedArrays(400)).length, 400);
  });

  it('refuses a query-selected write before anything is written', () => {
    const deep = nestedObjects(1001);
    assert.throws(() => compileJSONPathSetter('$..a')(deep, 1, { mutate: true }), refusal);
    assert.equal(canonicalizeJson(deep.a), canonicalizeJson(nestedObjects(1000)));
  });

  it('is restored after a refusal', () => {
    for (let call = 0; call < 3; call++) {
      assert.throws(() => all(nestedArrays(5000)), refusal);
      assert.equal(all(nestedArrays(1000)).length, 1000);
      assert.equal(all.paths(nestedArrays(1000)).length, 1000);
    }
  });
});

describe('a descendant segment over a cycle', () => {
  /** `{ x: 1, self: <itself> }` */
  const cyclic = () => { const c = { x: 1 }; c.self = c; return c; };
  /**
   * The refusal naming a cycle closed at `member` of the data, raised at `docPath` of the query.
   * @param {string} member
   * @param {string} [docPath]
   */
  const cycleAt = (member, docPath = '') => (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError);
    assert.equal(e.code, 'JQ2016');
    assert.equal(e.docPath, docPath);
    assert.equal(e.messageId, 'query/descent-cycle');
    assert.deepEqual(e.params, { member });
    assert.equal(e.message, `JQ2016: a descendant segment reaches a circular reference closed by data member ${member} at ${docPath === '' ? '\'\'' : docPath}`);
    return true;
  };
  const deepRefusal = (e) => e instanceof JsonQueryRuntimeError && e.code === 'JQ2009'
    && e.message === 'JQ2009: a descendant segment reaches a value nested deeper than 1000 levels at \'\'';
  /** Every JSONPath mode that walks the whole descent, over `data`. */
  const everyMode = (path, data) => {
    const compiled = compileJSONPath(path);
    return [() => compiled(data), () => compiled.paths(data), () => compiled.nodes(data),
      () => [...compiled.iterate(data)], () => queryJSONPath(path, data),
      () => compileJSONPathSetter(path)(data, 2)];
  };

  it('names a cycle at the root as one, at the member that closes it, in every mode', () => {
    for (const run of everyMode('$..x', cyclic()))
      assert.throws(run, cycleAt('/self'));
  });

  it('names a deeper cycle at its document location, wherever the descent starts', () => {
    for (const path of ['$..x', '$.a..x', '$.a.b..x', '$..b..x'])
      for (const run of everyMode(path, { a: { b: cyclic() } }))
        assert.throws(run, cycleAt('/a/b/self'), path);
    // the cyclic value is the second the segment descends from
    for (const run of everyMode('$.*..x', { p: { x: 0 }, q: { b: cyclic() } }))
      assert.throws(run, cycleAt('/q/b/self'));
    const items = [0, 1];
    items.push({ list: items });
    for (const run of everyMode('$[\'a/b\'][2]..x', { 'a/b': items }))
      assert.throws(run, cycleAt('/a~1b/2/list/2'));
  });

  it('names the cycle a filter\'s own descent reaches', () => {
    assert.throws(() => compileJSONPath('$..[?@..x]')(cyclic()), cycleAt('/self'));
    assert.throws(() => compileJSONPath('$.a[?$..x]')({ a: [1], b: cyclic() }), cycleAt('/b/self'));
  });

  it('names it under every bound', () => {
    assert.throws(() => compileJSONPath('$..x', { maxDescentDepth: 5 })(cyclic()), cycleAt('/self'));
    assert.throws(() => compileJsonQuery({ $count: '$..x' }, { limits: { descentDepth: 5 } })({ a: [cyclic()] }),
      cycleAt('/a/0/self', '/$count'));
  });

  it('names it in a query, at the input member, or in an external value the input does not hold', () => {
    const c = cyclic();
    assert.throws(() => compileJsonQuery({ $count: '$..x' })(c), cycleAt('/self', '/$count'));
    assert.throws(() => compileJsonQuery({ $count: '$.k..x' })({ k: c }), cycleAt('/k/self', '/$count'));
    assert.throws(() => compileJsonQuery({ $count: '$c..x' }, { externals: ['c'] })({}, { c }), cycleAt('/self', '/$count'));
    assert.throws(() => compileJsonQuery({ $count: '$c..x' }, { externals: ['c'] })({ k: c }, { c }), cycleAt('/k/self', '/$count'));
    // a cyclic input that does not hold the external is searched once
    assert.throws(() => compileJsonQuery({ $count: '$c..x' }, { externals: ['c'] })(cyclic(), { c }), cycleAt('/self', '/$count'));
  });

  it('passes every other error a walk over a cycle raises unchanged', () => {
    const thrown = new JsonQueryRuntimeError('JQ2001', 'not a number', '');
    const pathFunctions = { fail: { params: ['value'], returns: 'logical', evaluate: () => { throw thrown; } } };
    const compiled = compileJSONPath('$..[?fail(@)]', { pathFunctions });
    const c = cyclic();
    for (const run of [() => compiled(c), () => compiled.paths(c), () => [...compiled.iterate(c)]])
      assert.throws(run, (e) => e === thrown);
  });

  it('keeps answering where the walk stops before the cycle', () => {
    const all = compileJSONPath('$..x');
    assert.equal(all.first(cyclic()), 1);
    assert.equal(all.exists(cyclic()), true);
    assert.deepEqual(compileJSONPath('$.self.x')(cyclic()), [1]);
  });

  it('keeps JQ2009 for a deep value without a cycle, beside one or not', () => {
    for (const run of everyMode('$..x', nestedObjects(1100)))
      assert.throws(run, deepRefusal);
    for (const run of everyMode('$.a..x', { a: nestedObjects(1100), b: cyclic() }))
      assert.throws(run, deepRefusal);
  });

  it('reads a value reachable twice as no cycle: it answers, or is deep', () => {
    const shared = { x: 1 };
    assert.deepEqual(compileJSONPath('$..x')({ p: shared, q: [shared, shared] }), [1, 1, 1]);
    assert.deepEqual(compileJSONPath('$..x').paths({ p: shared, q: [shared] }), ['$[\'p\'][\'x\']', '$[\'q\'][0][\'x\']']);
    // each level holds the next twice: 2^1100 paths, one walk down the first
    let dag = { x: 1 };
    for (let i = 0; i < 1100; i++) dag = { l: dag, r: dag };
    for (const run of everyMode('$..x', dag))
      assert.throws(run, deepRefusal);
  });
});

describe('the descendant bound options', () => {
  it('move the bound both ways in JSONPath and JSON Query', () => {
    const shallow = compileJSONPath('$..*', { maxDescentDepth: 10 });
    assert.equal(shallow(nestedArrays(10)).length, 10);
    assert.throws(() => shallow(nestedArrays(11)), (e) => e.code === 'JQ2009'
      && e.message === 'JQ2009: a descendant segment reaches a value nested deeper than 10 levels at \'\'');
    assert.throws(() => [...shallow.iterate(nestedArrays(11))], (e) => e.code === 'JQ2009');
    assert.throws(() => shallow.paths(nestedArrays(11)), (e) => e.code === 'JQ2009');
    const query = compileJsonQuery('$..*', { limits: { descentDepth: 10 } });
    assert.equal(query(nestedArrays(10)).length, 10);
    assert.throws(() => query(nestedArrays(11)), (e) => e.code === 'JQ2009');
  });

  it('name the path of the query that refused, as every other limit does', () => {
    const at = (doc) => {
      try { compileJsonQuery(doc, { limits: { descentDepth: 5 } })([nestedArrays(10)]); }
      catch (e) { assert.ok(e instanceof JsonQueryRuntimeError); return [e.code, e.docPath, e.message]; }
      return 'answered';
    };
    assert.deepEqual(at({ $add: [1, { $count: '$..*' }] }), ['JQ2009', '/$add/1/$count',
      'JQ2009: a descendant segment reaches a value nested deeper than 5 levels at /$add/1/$count']);
    assert.deepEqual(at({ $exists: '$[0]..*' }), ['JQ2009', '/$exists',
      'JQ2009: a descendant segment reaches a value nested deeper than 5 levels at /$exists']);
    assert.deepEqual(at({ $count: '$[?count(@..*) > 0]' }), ['JQ2009', '/$count',
      'JQ2009: a descendant segment reaches a value nested deeper than 5 levels at /$count']);
    // a JSONPath compiled after a query names no query location
    assert.throws(() => compileJSONPath('$..*', { maxDescentDepth: 5 })(nestedArrays(10)), { code: 'JQ2009', docPath: '' });
    assert.deepEqual(at('$..*'), ['JQ2009', '',
      'JQ2009: a descendant segment reaches a value nested deeper than 5 levels at \'\'']);
  });

  it('carry a catalog message id and its limit, so the refusal renders in any catalog', () => {
    const refused = (run) => {
      try { run(); }
      catch (e) { assert.ok(e instanceof JsonQueryRuntimeError); return e; }
      return assert.fail('answered');
    };
    for (const e of [
      refused(() => compileJSONPath('$..*', { maxDescentDepth: 5 })(nestedArrays(10))),
      refused(() => compileJsonQuery({ $count: '$..*' }, { limits: { descentDepth: 5 } })(nestedArrays(10))),
    ]) {
      assert.equal(e.messageId, 'query/descent-limit');
      assert.deepEqual(e.params, { limit: 5 });
      assert.equal(e.reason, 'a descendant segment reaches a value nested deeper than 5 levels');
      assert.equal(renderQueryMessage(e, queryMessagesEn), e.reason);
      assert.equal(renderQueryMessage(e, { 'query/descent-limit': 'deeper than {limit}' }), 'deeper than 5');
    }
    assert.equal(queryMessagesEn['query/descent-limit'], 'a descendant segment reaches a value nested deeper than {limit} levels');
    const c = { x: 1 };
    c.self = c;
    const cycle = refused(() => compileJSONPath('$..x')(c));
    assert.equal(cycle.reason, 'a descendant segment reaches a circular reference closed by data member /self');
    assert.equal(renderQueryMessage(cycle, queryMessagesEn), cycle.reason);
    assert.equal(renderQueryMessage(cycle, { 'query/descent-cycle': 'cycle at {member}' }), 'cycle at /self');
    // a member name holding a replacement pattern is written as it is
    const odd = { x: 1 };
    odd['$&'] = odd;
    const named = refused(() => compileJSONPath('$..x')(odd));
    assert.equal(named.reason, 'a descendant segment reaches a circular reference closed by data member /$&');
    assert.equal(renderQueryMessage(named, queryMessagesEn), named.reason);
    assert.equal(queryMessagesEn['query/descent-cycle'], 'a descendant segment reaches a circular reference closed by data member {member}');
  });

  it('keep a one-off query cached apart per bound', () => {
    assert.equal(queryJSONPath('$..*', nestedArrays(20), { maxDescentDepth: 30 }).length, 20);
    assert.throws(() => queryJSONPath('$..*', nestedArrays(20), { maxDescentDepth: 10 }), (e) => e.code === 'JQ2009');
    assert.equal(queryJSONPath('$..*', nestedArrays(20)).length, 20);
  });

  it('are refused unless a positive integer, as every limit is', () => {
    for (const bad of [0, -1, 1.5, '5', NaN, Infinity]) {
      assert.throws(() => compileJSONPath('$..*', { maxDescentDepth: bad }),
        { name: 'TypeError', message: 'options.maxDescentDepth must be a positive integer' });
      assert.throws(() => compileJsonQuery('$..*', { limits: { descentDepth: bad } }),
        { name: 'TypeError', message: 'options.limits.descentDepth must be a positive integer' });
      assert.throws(() => compileJsonQuery('$..*', { limits: { steps: bad } }),
        { name: 'TypeError', message: 'options.limits.steps must be a positive integer' });
    }
    // a whole number past the safe range bounds nothing a host reaches, as for every limit
    for (const big of [2 ** 53, 1e300]) {
      assert.equal(compileJSONPath('$..*', { maxDescentDepth: big })(nestedArrays(3)).length, 3);
      assert.equal(compileJsonQuery('$..*', { limits: { descentDepth: big, steps: big } })(nestedArrays(3)).length, 3);
    }
  });

  // Past the default the host's stack decides again, so this half runs in a
  // child process with a known, large stack.
  it('restore the answer past the default on a large enough stack', () => {
    const script = `
      import { compileJSONPath, compileJsonQuery, compileJSONPathSetter } from '@jarenjs/json';
      let deep = 0; for (let i = 0; i < 3000; i++) deep = [deep];
      const out = [];
      const attempt = (f) => { try { out.push(f()); } catch (e) { out.push(e.code); } };
      const raised = compileJSONPath('$..*', { maxDescentDepth: 5000 });
      attempt(() => raised(deep).length);
      attempt(() => raised.paths(deep).length);
      attempt(() => [...raised.iterate(deep)].length);
      attempt(() => compileJSONPath('$..*')(deep).length);
      attempt(() => compileJsonQuery('$..*', { limits: { descentDepth: 5000 } })(deep).length);
      attempt(() => compileJsonQuery('$..*')(deep).length);
      attempt(() => compileJSONPathSetter('$..*', { maxDescentDepth: 5000 })(deep, 1).length);
      console.log(JSON.stringify(out));`;
    const run = spawnSync(process.execPath, ['--stack-size=4000', '--input-type=module', '-e', script],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [3000, 3000, 3000, 'JQ2009', 3000, 'JQ2009', 1]);
  });
});
