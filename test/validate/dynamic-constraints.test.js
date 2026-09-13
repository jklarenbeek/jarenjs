import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

const dynamic = (keyword, spelling) => ({ properties: { value: spelling === 'data'
  ? { data: { [keyword]: '/limit' } }
  : { [keyword]: { $data: '/limit' } } } });

describe('dynamic constraint agreement', () => {
  it('compares independently allocated JSON objects and arrays structurally', () => {
    for (const spelling of ['data', '$data']) {
      for (const keyword of ['const', 'enum']) {
        const validate = new JarenValidator().compile(dynamic(keyword, spelling));
        for (const value of [{ a: [1, { b: true }] }, [1, { a: 'x' }], null, 0, false, 'x']) {
          const equal = JSON.parse(JSON.stringify(value));
          const limit = keyword === 'enum' ? [equal] : equal;
          assert.equal(validate({ value, limit }), true, `${spelling} ${keyword}`);
          const different = keyword === 'enum' ? [{ different: true }] : { different: true };
          assert.equal(validate({ value, limit: different }), false);
        }
      }
    }
  });

  it('uses the same configured string length as static constraints', () => {
    for (const useGrapheme of [true, false]) {
      const compiler = new JarenValidator({ useGrapheme });
      for (const spelling of ['data', '$data']) {
        for (const keyword of ['minLength', 'maxLength']) {
          const validate = compiler.compile(dynamic(keyword, spelling));
          for (const value of ['👨‍👩‍👧‍👦', 'e\u0301', 'ab']) {
            for (const limit of [1, 2, 11]) {
              assert.equal(validate({ value, limit }), compiler.compile({ [keyword]: limit })(value),
                `${spelling} ${keyword} ${useGrapheme} ${value} ${limit}`);
            }
          }
        }
      }
    }
  });
});
