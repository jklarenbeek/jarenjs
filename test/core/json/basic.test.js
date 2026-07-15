import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidJSONCheap,
  isValidJSON,
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
  isValidJSONPath,
} from '@jarenjs/core/text/json';

describe('isValidJSONCheap', () => {
  it('should return true for strings too short to be JSON', () => {
    assert.isTrue(isValidJSONCheap(''));
    assert.isTrue(isValidJSONCheap('a'));
  });

  it('should return false for valid JSON starting characters', () => {
    assert.isFalse(isValidJSONCheap('"string"')); // strings are valid JSON, might be valid
    assert.isFalse(isValidJSONCheap('123')); // numbers are valid JSON, might be valid
  });

  it('should return false for JSON-like strings', () => {
    assert.isFalse(isValidJSONCheap('{}'));
    assert.isFalse(isValidJSONCheap('[]'));
    assert.isFalse(isValidJSONCheap('{"a":1}'));
  });

  it('should check matching brackets', () => {
    assert.isTrue(isValidJSONCheap('{]')); // mismatched brackets
    assert.isTrue(isValidJSONCheap('[}')); // mismatched brackets
  });

  it('should handle trailing whitespace', () => {
    assert.isFalse(isValidJSONCheap('{}  '));
    assert.isFalse(isValidJSONCheap('[]\n\t'));
  });
});

describe('isValidJSON', () => {
  it('should return true for valid JSON strings', () => {
    assert.isTrue(isValidJSON('{}'));
    assert.isTrue(isValidJSON('[]'));
    assert.isTrue(isValidJSON('"hello"'));
    assert.isTrue(isValidJSON('123'));
    assert.isTrue(isValidJSON('true'));
    assert.isTrue(isValidJSON('false'));
    assert.isTrue(isValidJSON('null'));
    assert.isTrue(isValidJSON('{"a":1,"b":2}'));
    assert.isTrue(isValidJSON('[1,2,3]'));
  });

  it('should return false for invalid JSON strings', () => {
    assert.isFalse(isValidJSON('{'));
    assert.isFalse(isValidJSON('}'));
    assert.isFalse(isValidJSON('['));
    assert.isFalse(isValidJSON(']'));
    assert.isFalse(isValidJSON('undefined')); // undefined is not valid JSON
    assert.isFalse(isValidJSON('{"a":}'));
    assert.isFalse(isValidJSON('{a:1}')); // unquoted keys not allowed
  });

  it('should return false for empty string', () => {
    assert.isFalse(isValidJSON(''));
  });
});

describe('isValidJSONPointer', () => {
  it('should return true for valid JSON pointers', () => {
    assert.isTrue(isValidJSONPointer('')); // empty pointer (root)
    assert.isTrue(isValidJSONPointer('/foo'));
    assert.isTrue(isValidJSONPointer('/foo/bar'));
    assert.isTrue(isValidJSONPointer('/foo/bar/0'));
    assert.isTrue(isValidJSONPointer('/foo~0bar')); // ~0 is escaped ~
    assert.isTrue(isValidJSONPointer('/foo~1bar')); // ~1 is escaped /
  });

  it('should return false for invalid JSON pointers', () => {
    assert.isFalse(isValidJSONPointer('foo')); // must start with /
    assert.isFalse(isValidJSONPointer('foo/bar'));
  });
});

describe('isValidJSONPointerUriFragment', () => {
  it('should return true for valid URI fragment pointers', () => {
    assert.isTrue(isValidJSONPointerUriFragment('#'));
    assert.isTrue(isValidJSONPointerUriFragment('#/foo'));
    assert.isTrue(isValidJSONPointerUriFragment('#/foo/bar'));
    assert.isTrue(isValidJSONPointerUriFragment('#/foo%20bar')); // percent-encoded
  });

  it('should return false for invalid URI fragment pointers', () => {
    assert.isFalse(isValidJSONPointerUriFragment('/foo')); // missing #
    assert.isFalse(isValidJSONPointerUriFragment('foo'));
  });
});

describe('isValidRelativeJSONPointer', () => {
  it('should return true for valid relative JSON pointers', () => {
    assert.isTrue(isValidRelativeJSONPointer('0'));
    assert.isTrue(isValidRelativeJSONPointer('1'));
    assert.isTrue(isValidRelativeJSONPointer('0/foo'));
    assert.isTrue(isValidRelativeJSONPointer('2/foo/bar'));
    assert.isTrue(isValidRelativeJSONPointer('0#')); // get key
  });

  it('should return false for invalid relative JSON pointers', () => {
    assert.isFalse(isValidRelativeJSONPointer('01')); // leading zero not allowed
    assert.isFalse(isValidRelativeJSONPointer('/foo')); // must start with digit
    assert.isFalse(isValidRelativeJSONPointer('abc'));
  });
});

describe('isValidJSONPath', () => {
  it('should return true for root selector', () => {
    assert.isTrue(isValidJSONPath('$'));
  });

  it('should return true for dot notation', () => {
    assert.isTrue(isValidJSONPath('$.store'));
    assert.isTrue(isValidJSONPath('$.store.book'));
    assert.isTrue(isValidJSONPath('$.foo.bar.baz'));
  });

  it('should return true for bracket notation', () => {
    assert.isTrue(isValidJSONPath('$[0]'));
    assert.isTrue(isValidJSONPath('$[0][1]'));
    assert.isTrue(isValidJSONPath('$.store[0]'));
  });

  it('should return true for recursive descent', () => {
    assert.isTrue(isValidJSONPath('$..name'));
    assert.isTrue(isValidJSONPath('$..'));
  });

  it('should return true for wildcards', () => {
    assert.isTrue(isValidJSONPath('$[*]'));
    assert.isTrue(isValidJSONPath('$.*'));
  });

  it('should return true for filter expressions', () => {
    assert.isTrue(isValidJSONPath('$[?(@.price < 10)]'));
    assert.isTrue(isValidJSONPath('$[?(@.name == "test")]'));
  });

  it('should return true for slices', () => {
    assert.isTrue(isValidJSONPath('$[0:5]'));
    assert.isTrue(isValidJSONPath('$[0:5:2]'));
    assert.isTrue(isValidJSONPath('$[::]'));
  });

  it('should return true for union', () => {
    assert.isTrue(isValidJSONPath('$[0,1,2]'));
    assert.isTrue(isValidJSONPath('$["a","b"]'));
  });

  it('should return true for quoted names', () => {
    assert.isTrue(isValidJSONPath("$['store']"));
    assert.isTrue(isValidJSONPath('$["store"]'));
  });

  it('should return true for current node selector', () => {
    assert.isTrue(isValidJSONPath('@'));
    assert.isTrue(isValidJSONPath('@.name'));
  });

  it('should return false for invalid JSONPath', () => {
    assert.isFalse(isValidJSONPath('store')); // missing $
    assert.isFalse(isValidJSONPath('')); // empty
    assert.isFalse(isValidJSONPath('$[')); // unclosed bracket
    assert.isFalse(isValidJSONPath('$]')); // unopened bracket
  });
});
