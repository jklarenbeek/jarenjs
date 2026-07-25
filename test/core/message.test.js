//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatTemplateParam,
  formatMessageValue,
  compileMessageTemplate,
  compileMessageCatalog,
} from '@jarenjs/core/message';

describe('formatTemplateParam', function () {
  it('stringifies primitives and JSON-encodes containers', function () {
    assert.equal(formatTemplateParam('x'), 'x');
    assert.equal(formatTemplateParam(3), '3');
    assert.equal(formatTemplateParam(true), 'true');
    assert.equal(formatTemplateParam(null), 'null');
    assert.equal(formatTemplateParam(undefined), 'undefined');
    assert.equal(formatTemplateParam([1, 'a']), '["1","a"]'.replace(/"1"/, '1'));
    assert.equal(formatTemplateParam({ a: 1 }), '{"a":1}');
  });
});

describe('formatMessageValue', function () {
  it('keeps a string quoted so empty and padded values stay visible', function () {
    assert.equal(formatMessageValue('x'), '"x"');
    assert.equal(formatMessageValue(''), '""');
    assert.equal(formatMessageValue(' '), '" "');
  });

  it('JSON-encodes everything else', function () {
    assert.equal(formatMessageValue(3), '3');
    assert.equal(formatMessageValue(null), 'null');
    assert.equal(formatMessageValue([1, 2]), '[1,2]');
    assert.equal(formatMessageValue({ a: 1 }), '{"a":1}');
  });
});

describe('compileMessageTemplate', function () {
  it('substitutes named params', function () {
    assert.equal(compileMessageTemplate('must be {limit}')({ limit: 3 }), 'must be 3');
    assert.equal(compileMessageTemplate('{a} and {b}')({ a: 1, b: 2 }), '1 and 2');
  });

  it('leaves an unknown name as a literal placeholder', function () {
    assert.equal(compileMessageTemplate('a {nope} b')({}), 'a {nope} b');
    assert.equal(compileMessageTemplate('a {nope} b')(null), 'a {nope} b');
  });

  it('renders a present member even when its value is undefined or null', function () {
    assert.equal(compileMessageTemplate('{x}')({ x: undefined }), 'undefined');
    assert.equal(compileMessageTemplate('{x}')({ x: null }), 'null');
  });

  it('escapes a literal brace with {{', function () {
    assert.equal(compileMessageTemplate('{{limit}')({ limit: 3 }), '{limit}');
  });

  it('keeps an unterminated placeholder verbatim', function () {
    assert.equal(compileMessageTemplate('a {b')({ b: 1 }), 'a {b');
  });

  it('short-circuits a template with no placeholders', function () {
    const render = compileMessageTemplate('plain text');
    assert.equal(render({}), 'plain text');
    assert.equal(render(null), 'plain text');
  });
});

describe('compileMessageCatalog', function () {
  it('compiles template strings and passes closures through', function () {
    const closure = (p) => `closure ${p.n}`;
    const catalog = compileMessageCatalog({ a: 'tpl {n}', b: closure });
    assert.equal(catalog.a({ n: 1 }), 'tpl 1');
    assert.equal(catalog.b, closure);
    assert.equal(catalog.b({ n: 2 }), 'closure 2');
  });

  it('freezes the result', function () {
    const catalog = compileMessageCatalog({ a: 'x' });
    assert.equal(Object.isFrozen(catalog), true);
  });
});
