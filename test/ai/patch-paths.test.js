//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { refinementPatchSchema } from '@jarenjs/ai';

it('discriminates every operation and path before applying a patch', () => {
  const check = new JarenValidator({ collectErrors: true, skipErrors: false })
    .compile(refinementPatchSchema());
  const records = [
    ['memories', { text: 'fact', evidence: 'source' }],
    ['skills', { name: 'recipe', when: 'needed', instructions: 'steps' }],
    ['goal/progress', { note: 'done', evidence: 'result' }],
  ];
  for (const [path, value] of records) {
    for (const op of ['add', 'replace']) {
      const target = `/${path}/${op === 'add' ? '-' : '0'}`;
      const valid = path !== 'goal/progress' || op === 'add';
      assert.equal(check([{ op, path: target, value }]).valid, valid);
      for (const [other, wrong] of records) {
        if (other === path) continue;
        const result = check([{ op, path: target, value: wrong }]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => e.instancePath.startsWith('/0')));
      }
      assert.equal(check([{ op, path: target }]).valid, false);
    }
    assert.equal(check([{ op: 'remove', path: `/${path}/0` }]).valid, path !== 'goal/progress');
    assert.equal(check([{ op: 'remove', path: `/${path}/0`, value }]).valid, false);
  }
  for (const path of ['/memories/01', '/memories/~1', '/skills/-/text', '/skills/~0'])
    assert.equal(check([{ op: 'add', path, value: records[0][1] }]).valid, false);
  assert.equal(check([]).valid, true);
  assert.throws(() => refinementPatchSchema({ maxOps: -1 }), /maxOps/);
});

it('an injected authoring validator cannot weaken the full patch schema', async () => {
  const { createLedger, createRefiner } = await import('@jarenjs/ai');
  const ledger = createLedger();
  let applied = false;
  const refiner = createRefiner({ ledger, validator: () => true,
    applyPatch: (document) => { applied = true; return document; } });
  const outcome = await refiner.commit([{ op: 'add', path: '/memories/-', value: { note: 'wrong', evidence: 'x' } }]);
  assert.ok(outcome.error);
  assert.equal(applied, false);
});
