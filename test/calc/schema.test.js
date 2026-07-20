import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JarenValidator } from '@jarenjs/validate';
import { parseExpression } from '@jarenjs/calc';

const astSchema = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../components/calc/schemas/jaren-calc-ast.schema.json', import.meta.url)),
  'utf8',
));

describe('#calc AST schema (through @jarenjs/validate)', function () {
  const compiler = new JarenValidator();
  const validate = compiler.compile(astSchema);

  it('accepts parser output across the corpus', () => {
    const corpus = [
      '1 + 2 * 3', 'sin(x) + cos(y)', '2 ^ 3 ^ 2', '-3!', '50%',
      'log(2, 8)', '~5 & 3', '1 << 4 | 2', 'pi * e', 'sqrt(x ^ 2 + y ^ 2)',
    ];
    for (const src of corpus) {
      const ast = parseExpression(src);
      assert.ok(validate(ast), `AST for ${JSON.stringify(src)} should validate`);
    }
  });

  it('rejects a malformed AST', () => {
    assert.equal(validate({ type: 'num' }), false);            // missing value
    assert.equal(validate({ type: 'binary', op: '@', left: { type: 'num', value: 1 }, right: { type: 'num', value: 2 } }), false); // bad op
    assert.equal(validate({ type: 'bogus' }), false);
  });
});
