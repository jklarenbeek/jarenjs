//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileLexical } from '@jarenjs/core/search';
import { hashContent } from '@jarenjs/core/string';

const definition = { version: 1, fields: ['title'] };
describe('validated lexical snapshots', () => {
  it('restores exact scores, tie identities and incremental state; replay is a no-op', () => {
    const compiled = compileLexical(definition), index = compiled.create();
    index.rebuild([{ id: 'b', title: 'tea' }, { id: 'gone', title: 'coffee' }, { id: 'a', title: 'tea' }]);
    index.update({ remove: ['gone'] }, { sourceRevision: 'r2' });
    const snapshot = index.snapshot(), restored = compiled.create();
    assert.equal(restored.restore(snapshot, { sourceRevision: 'r2' }).state, 'complete');
    assert.deepEqual(restored.search('tea').hits, index.search('tea').hits);
    const before = restored.stats();
    assert.equal(restored.restore(snapshot, { sourceRevision: 'r2' }).changes, 0);
    assert.deepEqual(restored.stats(), before);
    for (const item of [index, restored]) item.update({ put: [{ id: 'c', title: 'tea' }] });
    assert.deepEqual(restored.search('tea').hits, index.search('tea').hits);
  });
  it('corrupt, partial, incompatible and stale snapshots never replace published content', () => {
    const index = compileLexical(definition).create(); index.rebuild([{ id: 'a', title: 'tea' }], { sourceRevision: 'r1' });
    const snapshot = index.snapshot(), before = index.stats();
    assert.equal(index.restore(snapshot.slice(0, -3), { sourceRevision: 'r1' }).reason, 'corrupt-snapshot');
    assert.equal(index.restore(snapshot, { sourceRevision: 'old' }).reason, 'source-stale');
    const other = compileLexical({ ...definition, prefix: false }).create();
    assert.equal(other.restore(snapshot, { sourceRevision: 'r1' }).reason, 'config-mismatch');
    for (const patch of [{ complete: false }, { format: 'other' }, { documents: [['a', ['tea'], -1]] },
      { documents: [['a', ['tea'], 0], ['a', ['tea'], 0]] }, { generation: -1 }, { documents: [['a', [1], 0]] }]) {
      const data = { ...JSON.parse(JSON.parse(snapshot).payload), ...patch }, payload = JSON.stringify(data);
      assert.equal(index.restore(JSON.stringify({ checksum: hashContent(payload), payload }), { sourceRevision: 'r1' }).state, 'rebuild-required');
      assert.deepEqual(index.stats(), before);
    }
    const tiny = compileLexical({ ...definition, limits: { maxTemporaryBytes: 1 } }).create();
    assert.equal(tiny.restore(snapshot, { sourceRevision: 'r1' }).reason, 'snapshot-bytes');
    assert.equal(index.restore(null, { sourceRevision: 'r1' }).reason, 'corrupt-snapshot');
    index.dispose(); assert.throws(() => index.snapshot(), /disposed/);
    assert.equal(index.restore(snapshot, { sourceRevision: 'r1' }).reason, 'disposed');
  });
});
