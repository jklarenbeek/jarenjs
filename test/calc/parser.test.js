import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExpression, toExpression, astEqual, CalcParseError,
  num, binary, unary, call, variable, constant,
} from '@jarenjs/calc';

describe('#calc parser', function () {
  it('parses precedence correctly', () => {
    assert.ok(astEqual(parseExpression('1+2*3'),
      binary('+', num(1), binary('*', num(2), num(3)))));
  });

  it('power is right-associative and binds tighter than unary minus', () => {
    assert.ok(astEqual(parseExpression('2^3^2'),
      binary('^', num(2), binary('^', num(3), num(2)))));
    assert.ok(astEqual(parseExpression('-2^2'),
      unary('-', binary('^', num(2), num(2)))));
  });

  it('recognizes constants vs variables vs calls', () => {
    assert.ok(astEqual(parseExpression('pi'), constant('pi')));
    assert.ok(astEqual(parseExpression('x'), variable('x')));
    assert.ok(astEqual(parseExpression('sin(x)'), call('sin', [variable('x')])));
    assert.ok(astEqual(parseExpression('log(2, 8)'), call('log', [num(2), num(8)])));
  });

  it('parses number bases and scientific notation', () => {
    assert.equal(parseExpression('0xff').value, 255);
    assert.equal(parseExpression('0b1010').value, 10);
    assert.equal(parseExpression('0o17').value, 15);
    assert.equal(parseExpression('1.5e3').value, 1500);
  });

  it('parse errors carry 1-based line/column', () => {
    try {
      parseExpression('1 + * 2');
      assert.fail('should have thrown');
    }
    catch (err) {
      assert.ok(err instanceof CalcParseError);
      assert.equal(err.line, 1);
      assert.equal(err.column, 5);
    }
  });

  it('rejects unbalanced parens and trailing tokens', () => {
    assert.throws(() => parseExpression('(1+2'), CalcParseError);
    assert.throws(() => parseExpression('1 2'), CalcParseError);
    assert.throws(() => parseExpression(''), CalcParseError);
  });
});

describe('#calc toExpression round-trip fixed point', function () {
  const corpus = [
    '1 + 2 * 3', '-2 ^ 2', '2 ^ 3 ^ 2', 'a - b - c', 'a - (b - c)',
    '(a + b) * c', 'sin(x) + cos(y)', '3!', '50%', '2 ^ (-3)', 'pi * e',
    '-3!', '~5 & 3', '1 << 4', 'log(2, 8)', '(1 + 2)!', '1 | 2 | 4',
    'a & b | c', 'x * y + z / w', 'sqrt(x ^ 2 + y ^ 2)', 'nan', 'inf',
  ];
  for (const src of corpus) {
    it(`round-trips ${JSON.stringify(src)}`, () => {
      const ast = parseExpression(src);
      const printed = toExpression(ast);
      const reparsed = parseExpression(printed);
      assert.ok(astEqual(ast, reparsed),
        `not a fixed point: ${src} -> ${printed}`);
    });
  }

  it('is idempotent on the printed form', () => {
    for (const src of corpus) {
      const once = toExpression(parseExpression(src));
      const twice = toExpression(parseExpression(once));
      assert.equal(twice, once);
    }
  });
});
