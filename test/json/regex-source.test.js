//@ts-check
/**
 * @file The JSON standards' regular expressions are pattern sources:
 * RFC 9535 `match()`/`search()` and the JSON Query regex operators read
 * the I-Regexp `/a/` as the five characters it holds, never as a
 * `/source/flags` literal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryJSONPath, compileJsonQuery } from '@jarenjs/json';

describe('a slash-delimited regular expression is a pattern source', () => {
  it('JSONPath match() and search()', () => {
    assert.deepEqual(queryJSONPath('$[?match(@, "/a/")]', ['a', '/a/', 'x/a/y']), ['/a/']);
    assert.deepEqual(queryJSONPath('$[?search(@, "/a/")]', ['a', '/a/', 'x/a/y']), ['/a/', 'x/a/y']);
    assert.deepEqual(queryJSONPath('$[?search(@, "/a/i")]', ['A', '/a/i']), ['/a/i']);
  });

  it('JSON Query $match, $search and $replace', () => {
    assert.deepEqual(compileJsonQuery({ $match: ['$', '/a/'] }).items('a'), [false]);
    assert.deepEqual(compileJsonQuery({ $match: ['$', '/a/'] }).items('/a/'), [true]);
    assert.deepEqual(compileJsonQuery({ $search: ['$', '/a/i'] }).items('A'), [false]);
    assert.deepEqual(compileJsonQuery({ $replace: ['$', '/a/', '-'] }).items('a/a/'), ['a-']);
  });
});
