//@ts-check
// The single-walk matcher against the per-path enumeration it replaces:
// every corpus case answers the same value, shares the same input
// subtrees and raises the same error both ways.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileJsltDispatch } from '../../../packages/json/src/jslt/dispatch.js';
import { normalizeJsltStylesheet } from '../../../packages/json/src/jslt/stylesheet.js';
import { deepFreezeCopy } from '../../../packages/json/src/query/normalize.js';
import { EMPTY, Seq } from '../../../packages/json/src/query/runtime.js';
import { CASES, INPUTS, OPTION_SETS, compileTypeTest } from './matcher-corpus.js';

function compile(stylesheet, options, walkPaths) {
  const model = normalizeJsltStylesheet(deepFreezeCopy(stylesheet));
  return compileJsltDispatch(model, { compileTypeTest, ...options }, walkPaths).evaluate;
}

// Every input container by reference, named by its first location.
function inputRefs(value, path, refs) {
  if (typeof value !== 'object' || value === null || refs.has(value))
    return refs;
  refs.set(value, path);
  for (const key of Object.keys(value))
    inputRefs(value[key], `${path}/${key}`, refs);
  return refs;
}

// The output with every container returned by reference from the input
// replaced by that input location.
function describe_(value, refs) {
  if (value === EMPTY)
    return { empty: true };
  if (value instanceof Seq)
    return { seq: value.items.map((item) => describe_(item, refs)) };
  if (typeof value !== 'object' || value === null)
    return value;
  if (refs.has(value))
    return { shared: refs.get(value) };
  if (Array.isArray(value))
    return value.map((item) => describe_(item, refs));
  const out = {};
  for (const key of Object.keys(value))
    Object.defineProperty(out, key, { value: describe_(value[key], refs), enumerable: true });
  return out;
}

function outcome(evaluate, input, externals) {
  const refs = inputRefs(input, '', new Map());
  try {
    const first = evaluate(input, externals);
    const second = evaluate(input, externals);
    return {
      value: describe_(first, refs),
      again: describe_(second, refs),
      reused: typeof first === 'object' && first !== null && first === second,
    };
  }
  catch (error) {
    return { code: error.code, message: error.message, docPath: error.docPath, cause: error.cause?.code };
  }
}

describe('JSLT single-walk matcher', () => {
  for (const testCase of CASES) {
    it(`answers as the per-path enumeration: ${testCase.name}`, () => {
      const optionSets = testCase.options ?? OPTION_SETS;
      let answered = 0;
      for (const options of optionSets) {
        const walked = compile(testCase.stylesheet, options, true);
        const enumerated = compile(testCase.stylesheet, options, false);
        for (let i = 0; i < INPUTS.length; i++) {
          const expected = outcome(enumerated, INPUTS[i], testCase.externals);
          assert.deepStrictEqual(outcome(walked, INPUTS[i], testCase.externals), expected,
            `input ${i} under ${JSON.stringify(options)}`);
          if (expected.code === undefined)
            answered++;
        }
      }
      assert.ok(answered > 0, 'the case answers for at least one input');
    });
  }

  // Each member read is counted; a mode's walkable match paths share one
  // walk, so seven more paths that match nothing read nothing more.
  function countedInput(counter) {
    const make = (shape) => {
      if (typeof shape !== 'object' || shape === null)
        return shape;
      if (Array.isArray(shape))
        return shape.map(make);
      const out = {};
      for (const key of Object.keys(shape)) {
        const value = make(shape[key]);
        Object.defineProperty(out, key, {
          enumerable: true,
          get() {
            counter.reads++;
            return value;
          },
        });
      }
      return out;
    };
    return make({ p: { a: 1, q: { a: 2, r: [{ a: 3 }, { s: 4 }] } }, t: { u: 5 } });
  }

  function readsOf(paths) {
    const stylesheet = paths.map((path) => ({ match: path, body: { $mul: ['$', 2] } }));
    const transform = compileJsltStylesheet(stylesheet);
    const counter = { reads: 0 };
    const input = countedInput(counter);
    counter.reads = 0;
    const output = transform(input);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(output)),
      { p: { a: 2, q: { a: 4, r: [{ a: 6 }, { s: 4 }] } }, t: { u: 5 } });
    return counter.reads;
  }

  it('walks the input once for all of a mode\'s descendant paths', () => {
    const one = readsOf(['$..a']);
    const eight = readsOf(['$..a', '$..b1', '$..b2', '$..b3', '$..b4', '$..b5', '$..b6', '$..b7']);
    assert.strictEqual(one, 24);
    assert.strictEqual(eight, 24);
  });

  it('reads only the named spine for child-segment paths', () => {
    assert.strictEqual(readsOf(['$.p.q.r[*].a', '$.p.a', '$.p.q.a']), 21);
  });
});
