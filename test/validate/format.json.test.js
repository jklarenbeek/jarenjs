import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';


import {
  JarenValidator,
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const compiler = new JarenValidator();
compiler.addFormats(formats.jsonFormats);

describe('Schema JSON Formats', function () {

  describe('#formatPointer()', function () {
    it('should validate format: \'json-pointer\'', function () {
      const validate = compiler.compile({
        format: 'json-pointer'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('/foo/bar~0/baz~1/%a'), 'a valid JSON-pointer');
      assert.isFalse(validate('/foo/bar~'), 'not a valid JSON-pointer (~ not escaped)');
      assert.isTrue(validate('/foo//bar'), 'valid JSON-pointer with empty segment');
      assert.isTrue(validate('/foo/bar/'), 'valid JSON-pointer with the last empty segment');
      assert.isTrue(validate(''), 'valid JSON-pointer as stated in RFC 6901 #1');
      assert.isTrue(validate('/foo'), 'valid JSON-pointer as stated in RFC 6901 #2');
      assert.isTrue(validate('/foo/0'), 'valid JSON-pointer as stated in RFC 6901 #3');
      assert.isTrue(validate('/'), 'valid JSON-pointer as stated in RFC 6901 #4');
      assert.isTrue(validate('/a~1b'), 'valid JSON-pointer as stated in RFC 6901 #5');
      assert.isTrue(validate('/c%d'), 'valid JSON-pointer as stated in RFC 6901 #6');
      assert.isTrue(validate('/e^f'), 'valid JSON-pointer as stated in RFC 6901 #7');
      assert.isTrue(validate('/g|h'), 'valid JSON-pointer as stated in RFC 6901 #8');
      assert.isTrue(validate('/i\\j'), 'valid JSON-pointer as stated in RFC 6901 #9');
      assert.isTrue(validate('/k"l'), 'valid JSON-pointer as stated in RFC 6901 #10');
      assert.isTrue(validate('/ '), 'valid JSON-pointer as stated in RFC 6901 #11');
      assert.isTrue(validate('/m~0n'), 'valid JSON-pointer as stated in RFC 6901 #12');
      assert.isTrue(validate('/foo/-'), 'valid JSON-pointer used adding to the last array position');
      assert.isTrue(validate('/foo/-/bar'), 'valid JSON-pointer (- used as object member name)');
      assert.isTrue(validate('/~1~0~0~1~1'), 'valid JSON-pointer (multiple escaped characters)');
      assert.isTrue(validate('/~1.1'), 'valid JSON-pointer (escaped with fraction part) #1');
      assert.isTrue(validate('/~0.1'), 'valid JSON-pointer (escaped with fraction part) #2');
      assert.isFalse(validate('#'), 'not a valid JSON-pointer (URI Fragment Identifier) #1');
      assert.isFalse(validate('#/'), 'not a valid JSON-pointer (URI Fragment Identifier) #2');
      assert.isFalse(validate('#a'), 'not a valid JSON-pointer (URI Fragment Identifier) #3');
      assert.isFalse(validate('/~0~'), 'not a valid JSON-pointer (some escaped, but not all) #1');
      assert.isFalse(validate('/~0/~'), 'not a valid JSON-pointer (some escaped, but not all) #2');
      assert.isFalse(validate('/~2'), 'not a valid JSON-pointer (wrong escape character) #1');
      assert.isFalse(validate('/~-1'), 'not a valid JSON-pointer (wrong escape character) #2');
      assert.isFalse(validate('/~~'), 'not a valid JSON-pointer (multiple characters not escaped)');
      assert.isFalse(validate('a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #1');
      assert.isFalse(validate('0'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #2');
      assert.isFalse(validate('a/a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #3');
    });
    it('should validate format: \'relative-json-pointer\'', function () {
      const validate = compiler.compile({
        format: 'relative-json-pointer'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('1'), 'a valid upwards RJP');
      assert.isTrue(validate('0/foo/bar'), 'a valid downwards RJP');
      assert.isTrue(validate('2/0/baz/1/zip'), 'a valid up and then down RJP, with array index');
      assert.isTrue(validate('0#'), 'a valid RJP taking the member or index name');
      assert.isFalse(validate('/foo/bar'), 'an invalid RJP that is a valid JSON Pointer');
    });
    it('should validate format: \'json-pointer-uri-fragment\'', function () {
      const validate = compiler.compile({
        format: 'json-pointer-uri-fragment'
      });
      assert.isTrue(validate('#/$deps'));
      assert.isFalse(validate('#name'));
    });
  });

  describe('#formatJsonPath()', function () {
    it('should validate format: \'json-path\' per RFC 9535', function () {
      const validate = compiler.compile({
        format: 'json-path'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('$'), 'the root identifier alone');
      assert.isTrue(validate('$.store.book[0].title'), 'shorthand names and an index');
      assert.isTrue(validate("$['store']['book'][-1]"), 'bracketed names and a negative index');
      assert.isTrue(validate('$..author'), 'a descendant segment');
      assert.isTrue(validate('$.store.book[1:3]'), 'an array slice');
      assert.isTrue(validate('$[?@.price < 10]'), 'a filter selector');
      assert.isTrue(validate("$[?match(@.category, 'fic.*')]"), 'a filter with a function extension');
      assert.isTrue(validate('$[?@.a == $.b.c]'), 'a comparison against an absolute query');
      assert.isFalse(validate('store'), 'a query must start with the root identifier');
      assert.isFalse(validate('@.name'), 'the current-node identifier is only valid inside filters');
      assert.isFalse(validate('$.store '), 'trailing whitespace is not allowed');
      assert.isFalse(validate('$[01]'), 'leading zeros are not allowed in an index');
      assert.isFalse(validate('$[?@.a = 1]'), 'a single = is not a comparison operator');
      assert.isFalse(validate('$[?@[*] == 1]'), 'a comparison requires singular queries');
      assert.isFalse(validate('$[?length(@)]'), 'a ValueType function is not a test expression');
      assert.isFalse(validate("$['a]"), 'an unterminated string literal');
    });
  });

});
