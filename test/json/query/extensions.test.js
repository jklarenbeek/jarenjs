import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery,
  JsonQueryCompileError,
} from '@jarenjs/json/query';

// The extension mechanism is package-internal (used by the JSLT layer);
// these tests reach into the engine internals the way the entries
// themselves must: the CARD_* lattice from normalize.js and the tagged
// sequence runtime from runtime.js.
import { CARD_MANY } from '../../../packages/json/src/query/normalize.js';
import { EMPTY, seqOf, appendItem } from '../../../packages/json/src/query/runtime.js';

// A dummy uniform-contract extension: `{"$twice": [expr]}` evaluates its
// one operand and returns the operand's items twice, in order.
const twiceEntry = {
  params: { kinds: ['expr'], min: 1 },
  result: () => CARD_MANY,
  compile(gets) {
    const get = gets[0];
    return (f) => {
      const v = get(f);
      if (v === EMPTY)
        return EMPTY;
      const acc = [];
      appendItem(acc, v);
      appendItem(acc, v);
      return seqOf(acc);
    };
  },
};

// A custom-`normalize` extension proving the polymorphic $apply value
// shape generically: a non-array value is the selector expression, an
// array is `[selector]` or `[selector, tag]` where `tag` is a literal
// JSON string captured verbatim (a raw node, never evaluated) and
// appended to the selector's items.
const tagEntry = {
  result: () => CARD_MANY,
  normalize(arg, docPath, opPath, scope, ctx, helpers) {
    if (!Array.isArray(arg))
      return { args: [helpers.normalizeExpr(arg, opPath, scope, ctx)] };
    if (arg.length < 1 || arg.length > 2)
      helpers.fail('JQ0003', "'$tag' takes [selector, tag?]", opPath);
    const selector = helpers.normalizeExpr(arg[0], opPath + '/0', scope, ctx);
    if (arg.length === 1)
      return { args: [selector] };
    if (typeof arg[1] !== 'string')
      helpers.fail('JQ0003', "the '$tag' tag must be a literal string", opPath + '/1');
    return { args: [selector, helpers.makeRaw(arg[1], opPath + '/1')], card: CARD_MANY };
  },
  compile(gets, args) {
    const get = gets[0];
    const tag = args.length === 2 ? args[1].value : null;
    return (f) => {
      const acc = [];
      appendItem(acc, get(f));
      if (tag !== null)
        acc.push(tag);
      return seqOf(acc);
    };
  },
};

const EXTENSIONS = { '$twice': twiceEntry, '$tag': tagEntry };

function compileWith(doc) {
  return compileJsonQuery(doc, { extensions: EXTENSIONS });
}

function failsWith(fn, code, docPath) {
  assert.throws(fn, (e) => {
    assert.strictEqual(e instanceof JsonQueryCompileError, true,
      `expected JsonQueryCompileError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code);
    if (docPath !== undefined)
      assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

describe('Query extensions (options.extensions)', () => {
  describe('uniform-contract entry ($twice)', () => {
    it('compiles and runs through the registry mechanism', () => {
      const q = compileWith({ '$twice': ['$.items[*]'] });
      assert.deepStrictEqual(q({ items: [1, 2] }), [1, 2, 1, 2]);
      assert.strictEqual(q({ items: [] }), undefined); // empty operand stays empty
    });

    it('enforces the params descriptor arity (JQ0003)', () => {
      failsWith(() => compileWith({ '$twice': [] }), 'JQ0003', '/$twice');
      failsWith(() => compileWith({ '$twice': [1, 2] }), 'JQ0003', '/$twice');
      failsWith(() => compileWith({ '$twice': 1 }), 'JQ0003', '/$twice');
    });

    it('works inside FLWOR and $where', () => {
      const q = compileWith({
        '$for': { 'x': '$.items[*]' },
        '$where': { '$gt': [{ '$sum': { '$seq': [{ '$twice': ['$x.v'] }] } }, 5] },
        '$return': '$x.name',
      });
      const data = { items: [{ name: 'a', v: 2 }, { name: 'b', v: 3 }, { name: 'c', v: 1 }] };
      // 2*v > 5 keeps only v=3
      assert.deepStrictEqual(q(data), 'b');
    });

    it('collectReadSlots sees through extension op args ($orderby snapshot)', () => {
      // $b is read only inside the extension operator of $return; the
      // $orderby barrier must still snapshot $b's slot per tuple, or the
      // post-sort frame would replay the last tuple's binding.
      const q = compileWith({
        '$for': { 'b': '$.items[*]' },
        '$orderby': '$b.k',
        '$return': { '$twice': ['$b.v'] },
      });
      const data = { items: [{ k: 2, v: 'b' }, { k: 1, v: 'a' }] };
      assert.deepStrictEqual(q(data), ['a', 'a', 'b', 'b']);
    });
  });

  describe('custom-normalize entry ($tag, the $apply shape)', () => {
    it('accepts a bare (non-array) value as the selector', () => {
      const q = compileWith({ '$tag': '$.items[*]' });
      assert.deepStrictEqual(q({ items: [1, 2] }), [1, 2]);
    });

    it('accepts the [selector] argument-list form', () => {
      const q = compileWith({ '$tag': ['$.items[*]'] });
      assert.deepStrictEqual(q({ items: [1, 2] }), [1, 2]);
    });

    it('accepts [selector, rawString] and keeps the raw argument inert', () => {
      // the tag is a raw node: were it compiled as an expression, the
      // path string '$.b' would evaluate to 99 instead of itself
      const q = compileWith({ '$tag': ['$.items[*]', '$.b'] });
      assert.deepStrictEqual(q({ items: [1, 2], b: 99 }), [1, 2, '$.b']);
    });

    it('rejects wrong shapes through helpers.fail (JQ0003)', () => {
      failsWith(() => compileWith({ '$tag': [] }), 'JQ0003', '/$tag');
      failsWith(() => compileWith({ '$tag': ['$.a', '$.b', '$.c'] }), 'JQ0003', '/$tag');
      failsWith(() => compileWith({ '$tag': ['$.a', 42] }), 'JQ0003', '/$tag/1');
    });

    it('composes under the constructor rules like any operator', () => {
      const q = compileWith({ 'out': [{ '$tag': ['$.items[*]', 'end'] }] });
      assert.deepStrictEqual(q({ items: [1, 2] }), { out: [1, 2, 'end'] });
    });
  });

  describe('closed vocabulary without extensions', () => {
    it('the same documents fail JQ0002', () => {
      failsWith(() => compileJsonQuery({ '$twice': ['$.items[*]'] }), 'JQ0002');
      failsWith(() => compileJsonQuery({ '$tag': '$.items[*]' }), 'JQ0002');
    });

    it('the "did you mean" suggestion can name an extension', () => {
      assert.throws(() => compileWith({ '$twicee': ['$.a'] }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.match(e.message, /did you mean '\$twice'\?/);
        return true;
      });
      // without extensions the suggestion falls back to the core vocabulary
      assert.throws(() => compileJsonQuery({ '$twicee': ['$.a'] }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.doesNotMatch(e.message, /\$twice'/);
        return true;
      });
    });

    it('extension keys count as vocabulary in multi-key phrase errors', () => {
      // a known-keys combination is JQ0003, not JQ0002
      failsWith(() => compileWith({ '$twice': ['$.a'], '$tag': '$.b' }), 'JQ0003');
    });
  });

  describe('host programming errors (TypeError, not JQ0xxx)', () => {
    it('rejects names not starting with $', () => {
      assert.throws(() => compileJsonQuery(1, { extensions: { twice: twiceEntry } }), TypeError);
    });

    it('rejects collisions with the core vocabulary', () => {
      for (const name of ['$eq', '$for', '$satisfies', '$const', '$key', '$in', '$at', '$query', '$expr']) {
        assert.throws(() => compileJsonQuery(1, { extensions: { [name]: twiceEntry } }),
          TypeError, `expected collision TypeError for '${name}'`);
      }
    });

    it('rejects non-object extensions values', () => {
      assert.throws(() => compileJsonQuery(1, { extensions: [] }), TypeError);
      assert.throws(() => compileJsonQuery(1, { extensions: 'nope' }), TypeError);
    });
  });

  describe('isolation', () => {
    it('extensions do not leak between compiles', () => {
      const doc = { '$twice': ['$.items[*]'] };
      const a = compileWith(doc);
      failsWith(() => compileJsonQuery(doc), 'JQ0002'); // B: same doc, no extensions
      // A's compiled function still works after B's failed compile
      assert.deepStrictEqual(a({ items: [1] }), [1, 1]);
    });
  });
});
