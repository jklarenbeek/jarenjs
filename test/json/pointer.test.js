import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert';
import * as assert from '../assert.node.js';

import {
  parseJSONPointer,
  parseJSONPointerPath,
  formatJSONPointer,
  parseRelativeJSONPointer,
  compileJSONPointer,
  compileRelativeJSONPointer,
  compileDataRef,
  JSONPointerSyntaxError,
  JSONPOINTER_NOTHING,
  JSONPATH_NOTHING,
} from '@jarenjs/json';

const NOTHING = JSONPOINTER_NOTHING;

// The example document from RFC 6901, section 5
const rfc6901 = {
  'foo': ['bar', 'baz'],
  '': 0,
  'a/b': 1,
  'c%d': 2,
  'e^f': 3,
  'g|h': 4,
  'i\\j': 5,
  'k"l': 6,
  ' ': 7,
  'm~n': 8,
};

function get(pointer, data) {
  return compileJSONPointer(pointer)(data);
}

describe('sentinel', () => {
  it('shares one NOTHING sentinel with the JSONPath engine', () => {
    strictEqual(JSONPOINTER_NOTHING, JSONPATH_NOTHING);
  });
});

describe('parseJSONPointer', () => {
  it('should parse the empty pointer to no segments', () => {
    assert.deepEqual(parseJSONPointer(''), []);
  });

  it('should parse and decode segments', () => {
    assert.deepEqual(parseJSONPointer('/foo'), ['foo']);
    assert.deepEqual(parseJSONPointer('/foo/0'), ['foo', '0']);
    assert.deepEqual(parseJSONPointer('/'), ['']);
    assert.deepEqual(parseJSONPointer('/a~1b'), ['a/b']);
    assert.deepEqual(parseJSONPointer('/m~0n'), ['m~n']);
  });

  it('should decode mixed and adjacent escapes', () => {
    assert.deepEqual(parseJSONPointer('/~0~1'), ['~/']);
    assert.deepEqual(parseJSONPointer('/~1~0'), ['/~']);
    assert.deepEqual(parseJSONPointer('/a~0~0b~1~1c'), ['a~~b//c']);
    assert.deepEqual(parseJSONPointer('/~01'), ['~1']); // decodes to '~1', not '/'
  });

  it('should throw JSONPointerSyntaxError with a position', () => {
    assert.throws(() => parseJSONPointer('foo'), (e) => {
      return e instanceof JSONPointerSyntaxError && e.position === 0 && e.source === 'foo';
    });
    assert.throws(() => parseJSONPointer('/a/~'), (e) => {
      return e instanceof JSONPointerSyntaxError && e.position === 3;
    });
    assert.throws(() => parseJSONPointer('/a~2b'), (e) => {
      return e instanceof JSONPointerSyntaxError && e.position === 2;
    });
    assert.throws(() => parseJSONPointer(null), JSONPointerSyntaxError);
  });
});

describe('parseRelativeJSONPointer', () => {
  it('should parse the level count, hash and segments', () => {
    assert.deepEqual(parseRelativeJSONPointer('0'), { levels: 0, hash: false, segments: [] });
    assert.deepEqual(parseRelativeJSONPointer('1/0'), { levels: 1, hash: false, segments: ['0'] });
    assert.deepEqual(parseRelativeJSONPointer('2/highly/nested/objects'),
      { levels: 2, hash: false, segments: ['highly', 'nested', 'objects'] });
    assert.deepEqual(parseRelativeJSONPointer('0#'), { levels: 0, hash: true, segments: [] });
    assert.deepEqual(parseRelativeJSONPointer('12/a~1b'), { levels: 12, hash: false, segments: ['a/b'] });
  });

  it('should reject leading zeros, bare # infixes and other garbage', () => {
    assert.throws(() => parseRelativeJSONPointer(''), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('01/a'), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('-1/a'), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('0#/a'), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('0abc'), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('/a'), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('1/~2'), JSONPointerSyntaxError);
  });
});

describe('compileJSONPointer', () => {
  it('should resolve every pointer of the RFC 6901 section 5 example', () => {
    strictEqual(get('', rfc6901), rfc6901);
    deepStrictEqual(get('/foo', rfc6901), ['bar', 'baz']);
    strictEqual(get('/foo/0', rfc6901), 'bar');
    strictEqual(get('/', rfc6901), 0);
    strictEqual(get('/a~1b', rfc6901), 1);
    strictEqual(get('/c%d', rfc6901), 2);
    strictEqual(get('/e^f', rfc6901), 3);
    strictEqual(get('/g|h', rfc6901), 4);
    strictEqual(get('/i\\j', rfc6901), 5);
    strictEqual(get('/k"l', rfc6901), 6);
    strictEqual(get('/ ', rfc6901), 7);
    strictEqual(get('/m~0n', rfc6901), 8);
  });

  it('should resolve pointers of every specialized arity, and beyond', () => {
    // The compiler unrolls 0-4 segments and falls back to a loop from 5 on.
    // Each arity is a separate getter, so each needs its own case — a hit and
    // a miss — or a broken branch hides behind its neighbours.
    const deep = { a: { b: { c: { d: { e: { f: 'six' } } } } }, arr: [[[['nested']]]] };
    strictEqual(get('/a', deep), deep.a);
    strictEqual(get('/a/b', deep), deep.a.b);
    strictEqual(get('/a/b/c', deep), deep.a.b.c);
    strictEqual(get('/a/b/c/d', deep), deep.a.b.c.d);
    strictEqual(get('/a/b/c/d/e', deep), deep.a.b.c.d.e);
    strictEqual(get('/a/b/c/d/e/f', deep), 'six');
    strictEqual(get('/arr/0/0/0/0', deep), 'nested');

    strictEqual(get('/a/x', deep), NOTHING);
    strictEqual(get('/a/b/x', deep), NOTHING);
    strictEqual(get('/a/b/c/x', deep), NOTHING);
    strictEqual(get('/a/b/c/d/x', deep), NOTHING);
    strictEqual(get('/a/b/c/d/e/x', deep), NOTHING);
    strictEqual(get('/a/b/c/d/e/f/g', deep), NOTHING); // a scalar has no children
    strictEqual(get('/x/b/c/d/e/f', deep), NOTHING); // miss on the first hop
  });

  it('should return NOTHING for missing members and bad indexes', () => {
    strictEqual(get('/nosuch', rfc6901), NOTHING);
    strictEqual(get('/foo/2', rfc6901), NOTHING);
    strictEqual(get('/foo/-', rfc6901), NOTHING); // '-' is never a valid read index
    strictEqual(get('/foo/-1', rfc6901), NOTHING);
    strictEqual(get('/foo/01', rfc6901), NOTHING); // leading zeros do not address elements
    strictEqual(get('/foo/1e0', rfc6901), NOTHING);
    strictEqual(get('/foo/0/0', rfc6901), NOTHING); // scalars have no children
    strictEqual(get('/', { a: 1 }), NOTHING);
    strictEqual(get('/a', null), NOTHING);
    strictEqual(get('/a', 'string'), NOTHING);
  });

  it("should address both {'2': x} members and array element 2 with one segment", () => {
    const getter = compileJSONPointer('/2');
    strictEqual(getter({ 2: 'member' }), 'member');
    strictEqual(getter(['a', 'b', 'element']), 'element');
    strictEqual(getter('scalar'), NOTHING);
  });

  it('should specialize by segment count (0/1/2/N)', () => {
    const doc = { a: { b: { c: { d: 42 } } } };
    strictEqual(compileJSONPointer('')(doc), doc);
    strictEqual(compileJSONPointer('/a')(doc), doc.a);
    strictEqual(compileJSONPointer('/a/b')(doc), doc.a.b);
    strictEqual(compileJSONPointer('/a/b/c/d')(doc), 42);
    strictEqual(compileJSONPointer('/a/x')(doc), NOTHING);
    strictEqual(compileJSONPointer('/a/b/c/x')(doc), NOTHING);
    strictEqual(compileJSONPointer('/x/b/c/d')(doc), NOTHING);
  });

  it('should not address inherited properties', () => {
    strictEqual(compileJSONPointer('/toString')({}), NOTHING);
    strictEqual(compileJSONPointer('/length')([1, 2]), NOTHING);
  });
});

describe('compileRelativeJSONPointer', () => {
  // the example document from draft-luff-relative-json-pointer, section 5.1
  const doc = {
    foo: ['bar', 'baz'],
    highly: { nested: { objects: true } },
  };

  it('should resolve the draft vectors starting at /foo/1', () => {
    const at = '/foo/1';
    strictEqual(compileRelativeJSONPointer('0')(doc, at), 'baz');
    strictEqual(compileRelativeJSONPointer('1/0')(doc, at), 'bar');
    strictEqual(compileRelativeJSONPointer('2/highly/nested/objects')(doc, at), true);
    // the draft resolves '0#' at an array element to the number 1; this
    // implementation keeps the historical string form relied on by $data
    strictEqual(compileRelativeJSONPointer('0#')(doc, at), '1');
    strictEqual(compileRelativeJSONPointer('1#')(doc, at), 'foo');
  });

  it('should resolve the draft vectors starting at /highly/nested', () => {
    const at = '/highly/nested';
    deepStrictEqual(compileRelativeJSONPointer('0')(doc, at), { objects: true });
    strictEqual(compileRelativeJSONPointer('0/objects')(doc, at), true);
    strictEqual(compileRelativeJSONPointer('1/nested/objects')(doc, at), true);
    strictEqual(compileRelativeJSONPointer('2/foo/0')(doc, at), 'bar');
    strictEqual(compileRelativeJSONPointer('0#')(doc, at), 'nested');
    strictEqual(compileRelativeJSONPointer('1#')(doc, at), 'highly');
  });

  it('should resolve at the root', () => {
    strictEqual(compileRelativeJSONPointer('0')(doc, ''), doc);
    strictEqual(compileRelativeJSONPointer('0/foo/1')(doc, ''), 'baz');
  });

  it('should give the root no name, keeping it distinct from the member named ""', () => {
    // The draft says evaluating '#' at the root fails. Returning '' would
    // also collide with a real member name, which a document can have.
    strictEqual(compileRelativeJSONPointer('0#')(doc, ''), NOTHING);
    strictEqual(compileRelativeJSONPointer('0#')({ '': 1 }, '/'), '');
  });

  describe("hashIndex: 'number'", () => {
    const nums = { a: ['x', 'y', 'z'], o: { 1: 'member' }, deep: { list: [{ q: 1 }] } };
    const num = (p) => compileRelativeJSONPointer(p, { hashIndex: 'number' });

    it('should yield the draft number for an array position', () => {
      strictEqual(num('0#')(nums, '/a/1'), 1);
      strictEqual(num('0#')(nums, '/a/0'), 0);
      strictEqual(num('0#')(nums, '/a/2'), 2);
      strictEqual(num('1#')(nums, '/deep/list/0/q'), 0);
    });

    it('should keep an object member a string even when it looks like an index', () => {
      // `{"1": …}` is a member named "1", not element 1: only the container
      // decides, which is why this mode has to look at the parent at all.
      strictEqual(num('0#')(nums, '/o/1'), '1');
      strictEqual(num('0#')(nums, '/a'), 'a');
      strictEqual(num('1#')(nums, '/a/1'), 'a');
    });

    it('should fall back to the string when the parent cannot be reached', () => {
      // Nothing proves the position is an index, so do not invent a number.
      strictEqual(num('0#')(nums, '/nosuch/3'), '3');
      strictEqual(num('0#')({}, '/a/1'), '1');
    });

    it('should agree with the default mode everywhere except array positions', () => {
      strictEqual(num('0#')(nums, ''), NOTHING);
      strictEqual(num('0#')({ '': 1 }, '/'), '');
      strictEqual(num('2#')(nums, '/a/1'), NOTHING);
    });

    it('should leave the default and the explicit string mode unchanged', () => {
      for (const opts of [undefined, {}, { hashIndex: 'string' }]) {
        strictEqual(compileRelativeJSONPointer('0#', opts)(nums, '/a/1'), '1');
        strictEqual(compileRelativeJSONPointer('0#', opts)(nums, '/o/1'), '1');
      }
    });

    it('should reject an unknown mode at compile time', () => {
      // Falling back silently would hand a caller who meant 'number' exactly
      // the behavior they were opting out of.
      for (const bad of ['numeric', 'Number', 1, null, true]) {
        throws(() => compileRelativeJSONPointer('0#', { hashIndex: bad }), TypeError);
        throws(() => compileDataRef('0#', { hashIndex: bad }), TypeError);
        // even on the ref forms that never read it
        throws(() => compileDataRef('/absolute', { hashIndex: bad }), TypeError);
        throws(() => compileDataRef('', { hashIndex: bad }), TypeError);
      }
    });

    it('should be forwarded by compileDataRef', () => {
      strictEqual(compileDataRef('0#', { hashIndex: 'number' })(nums, '/a/1'), 1);
      strictEqual(compileDataRef('0#')(nums, '/a/1'), '1');
    });
  });

  it('should return NOTHING when levels exceed the depth', () => {
    strictEqual(compileRelativeJSONPointer('1')(doc, ''), NOTHING);
    strictEqual(compileRelativeJSONPointer('3/foo')(doc, '/highly/nested'), NOTHING);
    strictEqual(compileRelativeJSONPointer('2#')(doc, '/foo'), NOTHING);
  });

  it('should decode escaped segments of the location path', () => {
    const escaped = { 'a/b': { 'm~n': 5 } };
    strictEqual(compileRelativeJSONPointer('0')(escaped, '/a~1b/m~0n'), 5);
    strictEqual(compileRelativeJSONPointer('0#')(escaped, '/a~1b/m~0n'), 'm~n');
    strictEqual(compileRelativeJSONPointer('1#')(escaped, '/a~1b/m~0n'), 'a/b');
    strictEqual(compileRelativeJSONPointer('1/m~0n')(escaped, '/a~1b/x'), 5);
  });

  it('should return NOTHING when the location does not exist in the data', () => {
    strictEqual(compileRelativeJSONPointer('0')(doc, '/nosuch/path'), NOTHING);
    strictEqual(compileRelativeJSONPointer('1/0')({}, '/foo/1'), NOTHING);
  });
});

describe('compileDataRef', () => {
  const doc = { limits: { min: 2 }, value: 5 };

  it('should dispatch on the ref shape at compile time', () => {
    // '' -> the data root
    strictEqual(compileDataRef('')(doc, '/value'), doc);
    // leading '/' -> absolute JSON Pointer (dataPath is irrelevant)
    strictEqual(compileDataRef('/limits/min')(doc, '/value'), 2);
    // leading digit -> relative JSON Pointer from dataPath
    strictEqual(compileDataRef('1/limits/min')(doc, '/value'), 2);
    strictEqual(compileDataRef('0#')(doc, '/value'), 'value');
  });

  it('should reject anything else at compile time', () => {
    assert.throws(() => compileDataRef('abc'), JSONPointerSyntaxError);
    assert.throws(() => compileDataRef('-1/a'), JSONPointerSyntaxError);
    assert.throws(() => compileDataRef('#'), JSONPointerSyntaxError);
    assert.throws(() => compileDataRef(null), JSONPointerSyntaxError);
    assert.throws(() => compileDataRef(0), JSONPointerSyntaxError);
  });
});

describe('member values that are undefined', () => {
  it('distinguishes an undefined member from an absent one', () => {
    // a member whose value is undefined exists; hasOwn semantics
    const getter = compileJSONPointer('/a');
    strictEqual(getter({ a: undefined }), undefined);
    strictEqual(getter({}), NOTHING);
  });
});

describe('parseJSONPointerPath', () => {
  it('narrows canonical array indexes to numbers', () => {
    deepStrictEqual(parseJSONPointerPath(''), []);
    deepStrictEqual(parseJSONPointerPath('/0'), [0]);
    deepStrictEqual(parseJSONPointerPath('/items/0/id'), ['items', 0, 'id']);
    deepStrictEqual(parseJSONPointerPath('/4294967294'), [4294967294]);
  });

  it('leaves non-canonical index-like tokens as strings', () => {
    // The same rule the pointer compiler uses to pre-parse indexes: no
    // leading zeros, digits only, within the array-index range.
    deepStrictEqual(parseJSONPointerPath('/items/01'), ['items', '01']);
    deepStrictEqual(parseJSONPointerPath('/1e0'), ['1e0']);
    deepStrictEqual(parseJSONPointerPath('/1abc'), ['1abc']);
    deepStrictEqual(parseJSONPointerPath('/-'), ['-']);
    deepStrictEqual(parseJSONPointerPath('/4294967295'), ['4294967295']);
  });

  it('decodes escapes and preserves empty tokens', () => {
    deepStrictEqual(parseJSONPointerPath('/a~1b'), ['a/b']);
    deepStrictEqual(parseJSONPointerPath('/a~0b'), ['a~b']);
    deepStrictEqual(parseJSONPointerPath('//x'), ['', 'x']);
  });

  it('round-trips through formatJSONPointer', () => {
    for (const ptr of ['', '/0', '/items/0/id', '/items/01', '/a~1b', '/a~0b', '//x', '/-']) {
      strictEqual(formatJSONPointer(parseJSONPointerPath(ptr)), ptr);
    }
  });

  it('rejects the same pointers parseJSONPointer rejects', () => {
    throws(() => parseJSONPointerPath('bad'), JSONPointerSyntaxError);
    throws(() => parseJSONPointerPath(null), JSONPointerSyntaxError);
  });

  it('does not change what parseJSONPointer returns', () => {
    deepStrictEqual(parseJSONPointer('/items/0'), ['items', '0']);
  });
});
