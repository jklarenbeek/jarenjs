import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import * as assert from '../assert.node.js';

import {
  parseJSONPointer,
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
    strictEqual(compileRelativeJSONPointer('0#')(doc, ''), '');
    strictEqual(compileRelativeJSONPointer('0/foo/1')(doc, ''), 'baz');
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
