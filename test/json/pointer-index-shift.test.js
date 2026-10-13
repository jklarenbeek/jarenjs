//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  JSONPOINTER_NOTHING,
  JSONPointerSyntaxError,
  compileDataRef,
  compileRelativeJSONPointer,
  isValidRelativeJSONPointer,
  parseRelativeJSONPointer,
} from '@jarenjs/json';

/**
 * Index manipulation (`0+1`, `1-1`) is the one thing
 * draft-bhutton-relative-json-pointer-00 adds to the grammar the JSON Schema
 * 2020-12 specification references (draft-handrews-relative-json-pointer-01).
 * It is opt-in per call through `{ dialect: 'bhutton-00' }`; every default
 * answer stays the handrews-01 one, which `pointer-format.test.js` pins
 * against the official format suite.
 */
const BHUTTON = { dialect: 'bhutton-00' };
const NOTHING = JSONPOINTER_NOTHING;

/** The document of the draft's worked examples (section 5.1). */
const DRAFT_DOC = {
  foo: ['bar', 'baz'],
  highly: { nested: { objects: true } },
};

describe('relative pointer index manipulation: the draft examples', function () {
  /** @type {[string, string, any][]} */
  const fromBaz = [
    ['0', '/foo/1', 'baz'],
    ['1/0', '/foo/1', 'bar'],
    ['0-1', '/foo/1', 'bar'],
    ['2/highly/nested/objects', '/foo/1', true],
    ['0#', '/foo/1', 1],
    ['0-1#', '/foo/1', 0],
    ['1#', '/foo/1', 'foo'],
    ['0/objects', '/highly/nested', true],
    ['1/nested/objects', '/highly/nested', true],
    ['2/foo/0', '/highly/nested', 'bar'],
    ['0#', '/highly/nested', 'nested'],
    ['1#', '/highly/nested', 'highly'],
  ];

  for (const [pointer, at, expected] of fromBaz) {
    it(`${JSON.stringify(pointer)} at ${at} is ${JSON.stringify(expected)}`, function () {
      const resolve = compileRelativeJSONPointer(pointer, { ...BHUTTON, hashIndex: 'number' });
      assert.equal(resolve(DRAFT_DOC, at), expected);
    });
  }
});

describe('relative pointer index manipulation: resolution', function () {
  const doc = { list: [{ x: 1 }, { x: 2 }, { x: 3 }], word: 'w', 'a/b': ['p', 'q', 'r'] };
  const at = (pointer, path, options = BHUTTON) =>
    compileRelativeJSONPointer(pointer, options)(doc, path);

  it('moves forward and backward from an array item', function () {
    assert.deepEqual(at('0+1', '/list/0'), { x: 2 });
    assert.deepEqual(at('0+2', '/list/0'), { x: 3 });
    assert.deepEqual(at('0-1', '/list/2'), { x: 2 });
    assert.equal(at('0+1', '/a~1b/0'), 'q');
  });

  it('applies the shift after ascending, then resolves the remaining pointer', function () {
    assert.equal(at('1+1/x', '/list/0/x'), 2);
    assert.equal(at('1-1/x', '/list/2/x'), 2);
    assert.equal(at('2+0/word', '/list/0/x'), NOTHING);
    assert.equal(at('2+0/word', '/list/0'), NOTHING);
  });

  it('a zero shift still requires an array item', function () {
    assert.equal(at('0+0', '/list/1').x, 2);
    assert.equal(at('0-0', '/list/1').x, 2);
    assert.equal(at('0+0', '/word'), NOTHING);
    assert.equal(at('0-0', '/list/1/x'), NOTHING);
  });

  it('fails when the shifted index leaves the array', function () {
    assert.equal(at('0+1', '/list/2'), NOTHING);
    assert.equal(at('0-1', '/list/0'), NOTHING);
    assert.equal(at('0-4', '/list/2'), NOTHING);
    assert.equal(at('0+1#', '/list/2'), NOTHING);
    assert.equal(at('0-1#', '/list/0'), NOTHING);
    assert.equal(at('0+99999999999', '/list/0'), NOTHING);
  });

  it('fails when the referenced value is not an item of an array', function () {
    assert.equal(at('0+1', '/word'), NOTHING);
    assert.equal(at('0+1', '/list'), NOTHING);
    assert.equal(at('0+1', ''), NOTHING);
    assert.equal(at('1+1', '/word'), NOTHING);
    assert.equal(at('0+1#', ''), NOTHING);
  });

  it('fails when the location itself is not in the array', function () {
    // The shift is measured from the location; a location the array does not
    // hold has no position to measure from, even where the target exists.
    assert.equal(at('0-3', '/list/5'), NOTHING);
    assert.equal(at('0-1', '/list/3'), NOTHING);
    assert.equal(compileRelativeJSONPointer('1+1', BHUTTON)([1, 2], '/0'), NOTHING);
    assert.equal(compileRelativeJSONPointer('0+1', BHUTTON)([1, 2], ''), NOTHING);
    assert.equal(compileRelativeJSONPointer('0+1', BHUTTON)([1, 2], '/0'), 2);
  });

  it('fails when the level count passes the root of an array document', function () {
    // An object root hides this behind the array check; an array root does not.
    const arrayDoc = [10, 20, 30];
    const resolve = (pointer, path, options = BHUTTON) =>
      compileRelativeJSONPointer(pointer, options)(arrayDoc, path);
    assert.equal(resolve('2+1', '/1'), NOTHING);
    assert.equal(resolve('5+0', '/1'), NOTHING);
    assert.equal(resolve('5+0#', '/1', { ...BHUTTON, hashIndex: 'number' }), NOTHING);
    assert.equal(resolve('5+0#', '/1'), NOTHING);
    assert.equal(resolve('1+1', '/1'), NOTHING);
    assert.equal(resolve('0+1', '/1'), 30);
  });

  it('a location that does not start with a slash is not skipped into', function () {
    assert.equal(at('0+1', 'xlist/0'), NOTHING);
    assert.equal(at('0+1#', 'xlist/0'), NOTHING);
    assert.equal(compileRelativeJSONPointer('0+1', BHUTTON)([1, 2], 'x0'), NOTHING);
  });

  it('fails when ascending leaves the document or the location is not an index', function () {
    assert.equal(at('3+1', '/list/0'), NOTHING);
    assert.equal(at('0+1', '/list/01'), NOTHING);
    assert.equal(at('0+1', '/list/x'), NOTHING);
    assert.equal(at('0+1', '/missing/0'), NOTHING);
    assert.equal(at('0+1', 'list/0'), NOTHING);
    assert.equal(compileRelativeJSONPointer('0+1', BHUTTON)(doc, /** @type {any} */ (undefined)), NOTHING);
  });

  it('the # form after a shift is the shifted index, in the hashIndex mode asked for', function () {
    assert.equal(at('0+2#', '/list/0'), '2');
    assert.equal(at('0+2#', '/list/0', { ...BHUTTON, hashIndex: 'string' }), '2');
    assert.equal(at('0+2#', '/list/0', { ...BHUTTON, hashIndex: 'number' }), 2);
    assert.equal(at('1-1#', '/list/2/x', { ...BHUTTON, hashIndex: 'number' }), 1);
  });

  it('without a shift the dialect changes nothing', function () {
    for (const [pointer, path] of [['1/word', '/list/0'], ['0#', '/list/1'], ['2', '/list/0/x'], ['0/x', '/list/1']]) {
      const plain = compileRelativeJSONPointer(pointer)(doc, path);
      assert.deepEqual(at(pointer, path), plain, `${pointer} at ${path}`);
    }
  });
});

describe('relative pointer index manipulation: syntax', function () {
  it('parses the shift when the dialect is on', function () {
    assert.deepEqual(parseRelativeJSONPointer('0+1', BHUTTON),
      { levels: 0, hash: false, segments: [], shift: 1 });
    assert.deepEqual(parseRelativeJSONPointer('1-1/a', BHUTTON),
      { levels: 1, hash: false, segments: ['a'], shift: -1 });
    assert.deepEqual(parseRelativeJSONPointer('12+30/a~1b', BHUTTON),
      { levels: 12, hash: false, segments: ['a/b'], shift: 30 });
    assert.deepEqual(parseRelativeJSONPointer('0-1#', BHUTTON),
      { levels: 0, hash: true, segments: [], shift: -1 });
    assert.equal(Object.is(parseRelativeJSONPointer('0-0', BHUTTON).shift, 0), true);
    // `#` is an ordinary character inside a JSON Pointer token.
    assert.deepEqual(parseRelativeJSONPointer('0+1/a#', BHUTTON),
      { levels: 0, hash: false, segments: ['a#'], shift: 1 });
  });

  it('leaves the record unchanged for a pointer without a shift', function () {
    assert.deepEqual(parseRelativeJSONPointer('1/0', BHUTTON), { levels: 1, hash: false, segments: ['0'] });
    assert.deepEqual(parseRelativeJSONPointer('0#', BHUTTON), { levels: 0, hash: true, segments: [] });
  });

  it('refuses the shift under the default and the explicit handrews-01 dialect', function () {
    for (const options of [undefined, {}, { dialect: 'handrews-01' }, { dialect: undefined }]) {
      for (const p of ['0+1', '1-1', '0-1#', '0+0/a', '+1/foo/bar'])
        assert.throws(() => parseRelativeJSONPointer(p, options), JSONPointerSyntaxError, p);
    }
  });

  const malformed = [
    '+1/foo/bar', '-1/foo/bar', '0+', '0-', '0++1', '0+-1', '0+1+1', '0+1-1', '0+01', '0-00',
    '0+a', '0+1a', '0 +1', '0+ 1', '00+1', '0+1 ', '0#+1', '0+#', '0+1#/a', '0+1a/b',
    '0+1.5', '0+1e1',
  ];

  it('names a leading zero in the shift as such', function () {
    assert.throws(() => parseRelativeJSONPointer('0+01', BHUTTON),
      { name: 'JSONPointerSyntaxError', position: 2, message: /leading zeros/ });
    assert.throws(() => parseRelativeJSONPointer('3-00/a', BHUTTON),
      { name: 'JSONPointerSyntaxError', position: 2, message: /leading zeros/ });
    assert.throws(() => parseRelativeJSONPointer('0+', BHUTTON),
      { name: 'JSONPointerSyntaxError', position: 2, message: /non-negative integer/ });
  });

  it('rejects malformed shifts', function () {
    for (const p of malformed)
      assert.throws(() => parseRelativeJSONPointer(p, BHUTTON), JSONPointerSyntaxError, p);
  });

  it('the parser refuses a shift no number can hold, as it does a level count', function () {
    assert.throws(() => parseRelativeJSONPointer('0+9007199254740992', BHUTTON), JSONPointerSyntaxError);
    assert.throws(() => parseRelativeJSONPointer('0-9007199254740992', BHUTTON), JSONPointerSyntaxError);
    assert.equal(parseRelativeJSONPointer('0-9007199254740991', BHUTTON).shift, -9007199254740991);
  });

  it('the format tester and the parser agree, and the default stays handrews-01', function () {
    const corpus = [
      ...malformed, '0', '1/0', '0#', '2/a/b', '', '/a', '01', '0+1', '1-1', '0-1#', '0+0', '0+1/a', '0-0#',
      '10+10/x~0y', '0+1/~2', '9007199254740991-1', '0+9007199254740991',
    ];
    for (const p of corpus) {
      let parses = true;
      try { parseRelativeJSONPointer(p, BHUTTON); }
      catch { parses = false; }
      assert.equal(isValidRelativeJSONPointer(p, BHUTTON), parses, `bhutton-00: ${JSON.stringify(p)}`);
      let plainParses = true;
      try { parseRelativeJSONPointer(p); }
      catch { plainParses = false; }
      assert.equal(isValidRelativeJSONPointer(p), plainParses, `default: ${JSON.stringify(p)}`);
    }
    assert.equal(isValidRelativeJSONPointer('0+1', BHUTTON), true);
    assert.equal(isValidRelativeJSONPointer('0+1'), false);
    assert.equal(isValidRelativeJSONPointer('0+1', { dialect: 'handrews-01' }), false);
    assert.equal(isValidRelativeJSONPointer('+1/foo/bar', BHUTTON), false);
  });

  it('keeps rejecting what the official suite rejects, in both dialects', function () {
    const groups = JSON.parse(readFileSync(
      new URL('./fixtures/pointer-format/relative-json-pointer.json', import.meta.url), 'utf8'));
    for (const group of groups) {
      for (const t of group.tests) {
        if (typeof t.data !== 'string' || t.valid) continue;
        assert.equal(isValidRelativeJSONPointer(t.data, BHUTTON), false,
          `${group.description} / ${t.description}: ${JSON.stringify(t.data)}`);
      }
    }
  });

  it('rejects an unknown dialect instead of ignoring it', function () {
    for (const dialect of [null, 'BHUTTON-00', ''])
      assert.throws(() => isValidRelativeJSONPointer('0+1', { dialect: /** @type {any} */ (dialect) }), TypeError);
    const bad = { dialect: 'bhutton-01' };
    assert.throws(() => parseRelativeJSONPointer('0+1', bad), TypeError);
    assert.throws(() => isValidRelativeJSONPointer('0+1', bad), TypeError);
    assert.throws(() => compileRelativeJSONPointer('0', bad), TypeError);
    assert.throws(() => compileDataRef('', bad), TypeError);
    assert.throws(() => compileDataRef('/a', bad), TypeError);
  });

  it('compileDataRef forwards the dialect to the relative forms', function () {
    const doc = { a: [10, 20, 30] };
    assert.equal(compileDataRef('0+1', BHUTTON)(doc, '/a/0'), 20);
    assert.equal(compileDataRef('0-1#', { ...BHUTTON, hashIndex: 'number' })(doc, '/a/2'), 1);
    assert.throws(() => compileDataRef('0+1'), JSONPointerSyntaxError);
    assert.equal(compileDataRef('/a/1', BHUTTON)(doc, '/a/0'), 20);
    assert.equal(compileDataRef('', BHUTTON)(doc, '/a/0'), doc);
  });
});
