//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { task } from '@jarenjs/linq/flow';
import * as s from '@jarenjs/linq/schema';

it('task options reject misspelled version identity and malformed option objects', () => {
  for (const options of [{ versoin: '1' }, '1', [], null])
    assert.throws(() => task('work', undefined, options), /** @param {any} e */ e => e.code === 'JL0101');
  assert.deepEqual(task('work', undefined, { version: '1' })[Symbol.for('@jarenjs/linq/flow-node')],
    { kind: 'task', run: 'work', version: '1' });
});

it('normalizer keywords use the same branch refusal as dedicated schema methods', () => {
  for (const keyword of ['default', 'x-coerce', 'x-trim']) {
    const value = keyword === 'default' ? 'x' : true;
    assert.throws(() => s.any().keyword('anyOf', [s.string().keyword(keyword, value)]).schema,
      /** @param {any} e */ e => e.code === 'JL0102');
  }
  assert.deepEqual(s.any().keyword('allOf', [s.string().keyword('default', 'x')]).schema,
    { allOf: [{ type: 'string', default: 'x' }] });
});
