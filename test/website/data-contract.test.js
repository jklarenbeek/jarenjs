//@ts-check
/**
 * @file The data studio's operation contract compiles and declares what
 * the worker actually serves: the eleven operations of the db-owner
 * protocol, each with the declared `db` failure carrying the store's
 * code and message, `data.live` answering `{ liveId, mode, rows }` (the
 * push path stays website-specific until the stream binding), and no
 * `subscribe` kind anywhere. The worker itself is browser-only (wasm,
 * BroadcastChannel), so this is the Node-side half: the document is
 * valid, compiled, and shaped for the port binding the page opens it
 * over.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';

const doc = JSON.parse(readFileSync(
  new URL('../../packages/website/src/contracts/data.contract.json', import.meta.url), 'utf8'));

describe('the data studio contract document', () => {
  it('compiles, with the operations the worker serves and the db failure declared on every one', () => {
    const contract = compileContract(doc);
    assert.strictEqual(contract.id, 'jaren-data-studio');
    assert.deepStrictEqual(contract.ids, [
      'data.init', 'data.open', 'data.insert', 'data.put', 'data.delete',
      'data.rows', 'data.execute', 'data.explain', 'data.live', 'data.live.close', 'data.migrate',
    ]);
    for (const id of contract.ids) {
      const op = contract.operations[id];
      assert.notStrictEqual(op.kind, 'subscribe', `${id}: no subscribe until the stream binding`);
      assert.ok(Object.hasOwn(op.errors, 'db'), `${id} declares the db failure`);
      assert.notStrictEqual(op.errors.db.validate, null, `${id}'s db failure types its details`);
      assert.strictEqual(op.http.opaque, false, `${id} is a JSON operation the port binding can carry`);
    }
    // reads read, commands command
    assert.deepStrictEqual(contract.ids.filter((id) => contract.operations[id].kind === 'read'),
      ['data.rows', 'data.execute', 'data.explain']);
    // the db details shape is the wire error the worker maps: { code: string|null, message }
    const db = contract.operations['data.insert'].errors.db;
    assert.strictEqual(db.validate({ code: 'JD2061', message: 'held' }).valid, true);
    assert.strictEqual(db.validate({ code: null, message: 'uncoded' }).valid, true);
    assert.strictEqual(db.validate({ message: 'no code member' }).valid, false);
    assert.strictEqual(db.validate({ code: 'x' }).valid, false);
  });

  it('types the boot and live shapes the page consumes', () => {
    const contract = compileContract(doc);
    const init = contract.operations['data.init'];
    assert.strictEqual(init.input, null, 'init takes no input (invoke with null)');
    assert.strictEqual(init.output.validate({ topology: 'owner', vfs: 'opfs-sahpool', version: '3.53.0' }).valid, true);
    assert.strictEqual(init.output.validate({
      topology: 'client', vfs: 'opfs-sahpool', version: '3.53.0',
      refusal: { code: 'JD2061', message: 'held elsewhere' },
    }).valid, true);
    assert.strictEqual(init.output.validate({ topology: 'nope', vfs: 'x', version: 'y' }).valid, false);
    const live = contract.operations['data.live'];
    assert.strictEqual(live.output.validate({ liveId: 'L1', mode: { strategy: 'incremental' }, rows: [] }).valid, true);
    assert.strictEqual(live.output.validate({ liveId: 'L1' }).valid, false);
    const migrate = contract.operations['data.migrate'];
    assert.strictEqual(migrate.output.validate({ planned: ['CREATE INDEX …'], losses: [], applied: ['add-title-index'] }).valid, true);
    assert.strictEqual(migrate.output.validate({ planned: [], losses: [], applied: [], note: 'memory stores recreate instead of migrating' }).valid, true);
  });
});
