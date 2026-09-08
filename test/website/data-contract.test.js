//@ts-check
/**
 * @file The data studio's operation contract compiles and declares what
 * the worker actually serves: the eleven operations of the db-owner
 * protocol, each with the declared `db` failure carrying the store's
 * code and message, `data.live` a SUBSCRIBE operation whose snapshot is
 * LIVE's `{ rows }` result document (the emissions travel the stream
 * binding as push frames), and `data.lives` the registration-count
 * surface, and `data.oracle` the throwaway-store read that holds a
 * second executor to the spatial corpus from any tab.
 *
 * The Node pairing gate compares the actual owner and client tables in
 * both directions, so a missing or undeclared handler fails here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';
import { createDataHandlers } from '../../packages/website/src/db-handlers.js';

const doc = JSON.parse(readFileSync(
  new URL('../../packages/website/src/contracts/data.contract.json', import.meta.url), 'utf8'));

describe('the data studio contract document', () => {
  it('pairs the document with both actual handler tables in both directions', () => {
    // Constructing the tables does not acquire storage or call the host.
    const { handlers, clientHandlers } = createDataHandlers(/** @type {any} */ ({}));
    const ids = [...compileContract(doc).ids].sort();
    assert.deepStrictEqual(Object.keys(handlers).sort(), ids);
    assert.deepStrictEqual(Object.keys(clientHandlers).sort(), ids);
  });

  it('compiles, with the operations it declares and the db failure on every one', () => {
    const contract = compileContract(doc);
    assert.strictEqual(contract.id, 'jaren-data-studio');
    assert.deepStrictEqual(contract.ids, [
      'data.init', 'data.open', 'data.insert', 'data.delete',
      'data.rows', 'data.execute', 'data.explain', 'data.oracle', 'data.live', 'data.lives',
      'data.migrate',
    ]);
    for (const id of contract.ids) {
      const op = contract.operations[id];
      assert.ok(Object.hasOwn(op.errors, 'db'), `${id} declares the db failure`);
      assert.notStrictEqual(op.errors.db.validate, null, `${id}'s db failure types its details`);
      assert.strictEqual(op.http.opaque, false, `${id} is a JSON operation the port binding can carry`);
    }
    // reads read, commands command, the live query subscribes
    assert.deepStrictEqual(contract.ids.filter((id) => contract.operations[id].kind === 'read'),
      ['data.rows', 'data.execute', 'data.explain', 'data.oracle', 'data.lives']);
    assert.strictEqual(contract.operations['data.live'].kind, 'subscribe');
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
    // the live snapshot is LIVE-FORMAT's result document, and the
    // subscription's stream policy is the compiler's default set
    const live = contract.operations['data.live'];
    assert.strictEqual(live.output.validate({ rows: [] }).valid, true);
    assert.strictEqual(live.output.validate({ liveId: 'L1' }).valid, false);
    assert.deepStrictEqual(live.policy.stream, { resume: 'snapshot', heartbeatMs: 15000, maxPatchBytes: null });
    const lives = contract.operations['data.lives'];
    assert.strictEqual(lives.output.validate({ count: 2 }).valid, true);
    assert.strictEqual(lives.output.validate({ count: -1 }).valid, false);
    // the oracle's answer carries the empty sequence as a FLAG: null is
    // an answer the engine can record, so it cannot double as "no answer"
    const oracle = contract.operations['data.oracle'];
    assert.strictEqual(oracle.output.validate({ answer: null, empty: true }).valid, true);
    assert.strictEqual(oracle.output.validate({ answer: [1, 2], empty: false }).valid, true);
    assert.strictEqual(oracle.output.validate({ answer: null }).valid, false, 'the flag is required');
    // the plan rides beside the answer only when asked for, as the same
    // record data.explain gives — the two-stage spatial plan, legible
    assert.strictEqual(oracle.input.validate({
      model: {}, collection: 'rows', documents: [{}], query: true, explain: true,
    }).valid, true);
    assert.strictEqual(oracle.output.validate({
      answer: [], empty: false,
      explain: { sql: 'SELECT', params: [], indexes: [], prefilters: [], residual: null, scanNarrative: 'SCAN' },
    }).valid, true);
    assert.strictEqual(oracle.output.validate({ answer: [], empty: false, explain: 'SELECT' }).valid, false,
      'the plan is a record, not prose');
    assert.strictEqual(oracle.input.validate({
      model: {}, collection: 'rows', documents: [{}], query: { $for: { d: '$[*]' }, $return: '$d' },
    }).valid, true);
    assert.strictEqual(oracle.input.validate({ model: {}, collection: 'rows', query: true }).valid, false,
      'the documents to seed are required — an unseeded oracle answers nothing about anything');
    const migrate = contract.operations['data.migrate'];
    assert.strictEqual(migrate.output.validate({ planned: ['CREATE INDEX …'], losses: [], applied: ['add-title-index'] }).valid, true);
    assert.strictEqual(migrate.output.validate({ planned: [], losses: [], applied: [], note: 'memory stores recreate instead of migrating' }).valid, true);
    assert.strictEqual(migrate.output.validate({ planned: [], losses: [], applied: [null] }).valid, false,
      'the applied ids are strings — a list of nulls under this declaration was a real report');
  });
});
