//@ts-check
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { compileJsonQuery, createQueryAccumulator } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { hashContent } from '@jarenjs/core/string';
import { compileDocumentStep, classifyAssertion, isPerDocumentAssertion, migrateDocuments, streamDocuments,
  createDagJobRunner, openStore, sqliteDialect, RUN_IDENTITY_NODE } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';

const migration = (query, expect = 'ebv') => ({ $migration: '0.1', id: 'm', from: 'a', to: 'b',
  steps: [{ kind: 'query', collection: 'x', assert: query, expect }] });
const operation = (query, bounds) => compileDocumentStep(migration(query).steps[0], 0,
  { migrationId: 'm', compileQuery: compileJsonQuery, compileJslt: compileJsltStylesheet, assertionBounds: bounds });
const verdict = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

it('ordered aggregate items preserve floating-point, Unicode, type and sequence semantics across partitions', () => {
  for (const values of [[1e16, 1, -1e16, 1], [-0], [1, 'a'], ['\u{10000}', '\uE000'],
    [NaN, 1], [1, NaN], [null], [], [[1], [1]], [{ x: 1 }, { x: 1 }]]) {
    for (const name of ['$count', '$sum', '$avg', '$min', '$max']) {
      const query = { [name]: '$[*].n' }, docs = values.map((n) => ({ n }));
      const compiled = compileJsonQuery(query), op = operation(query);
      for (const size of [1, 2, 3, 99]) {
        let state = op.fold.start();
        const actual = verdict(() => {
          for (let at = 0; at < docs.length; at += size) state = op.fold.combine(state, docs.slice(at, at + size));
          op.fold.finish(state);
        });
        assert.equal(actual, verdict(() => op.assert(docs)), `${name}, ${size}`);
        if (verdict(() => compiled(docs)) === null) assert.deepEqual(op.fold.value(state), compiled(docs));
      }
    }
  }
  assert.equal(compileJsonQuery({ $sum: '$[*]' })([1e16, 1, -1e16, 1]), 1);
  assert.equal(compileJsonQuery({ $avg: '$[*]' })([1e16, 1, -1e16, 1]), 0.25);
  assert.equal(compileJsonQuery({ $max: '$[*]' })(['\u{10000}', '\uE000']), '\u{10000}');
  assert.deepEqual(compileJsonQuery('$[*]').items([[1], [2]]), [[1], [2]]);
  assert.deepEqual(compileJsonQuery('$[0]').items([[1], [2]]), [[1]]);
  assert.deepEqual(compileJsonQuery('$[*]').items([]), []);
  assert.throws(() => compileJsonQuery('$[*]', { limits: { resultItems: 1 } }).items([1, 2]), { code: 'JQ2009' });
  assert.throws(() => createQueryAccumulator('$bad'), /unsupported query accumulator/);
});

it('global operands and positions never masquerade as partition-independent folds', () => {
  assert.equal(isPerDocumentAssertion({ $for: { row: '$[*]' }, $return: '$row.n' }), true);
  assert.equal(isPerDocumentAssertion({ $for: { row: '$[*]' }, $return: '$[0].n' }), false);
  for (const query of [{ $sum: '$[0].n' }, { $count: { $distinct: '$[*].n' } },
    { $sum: 1 }, { $min: '$[*][?@.n > $[0].n]' }]) {
    assert.equal(classifyAssertion(query).strategy, 'materialize', JSON.stringify(query));
  }
});

it('per-row EBV is checked over the complete sequence, including empty sources', async () => {
  const query = { $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 0] }, $return: '$it' };
  for (const docs of [[], [{ n: 0 }, { n: 1 }], [{ n: 1 }, { n: 2 }]]) {
    const expected = verdict(() => operation(query).assert(docs));
    for (const batchSize of [1, 2, 9]) {
      for (const run of [() => migrateDocuments({ x: docs }, [migration(query)], { batchSize }),
        () => streamDocuments({ x: docs }, [migration(query)], { batchSize, write: () => {} })]) {
        if (expected === null) await run();
        else await assert.rejects(run, { code: expected });
      }
    }
  }
});

it('distinct retains only unique items and refuses before its cardinality or byte bound', async () => {
  const query = { $distinct: '$[*].n' }, bounds = { maxRows: 100, maxBytes: 100, maxDistinct: 2 };
  const op = operation(query, bounds), state = op.fold.start();
  for (const n of [1, 1, 2, 1]) op.fold.combine(state, [{ n }]);
  assert.deepEqual(op.fold.value(state), [1, 2]);
  assert.throws(() => op.fold.combine(state, [{ n: 3 }]), { code: 'JD2007' });
  const small = operation(query, { ...bounds, maxBytes: 1 });
  assert.throws(() => small.fold.combine(small.fold.start(), [{ n: 'oversized' }]), { code: 'JD2076' });
  const success = await streamDocuments({ x: [{ n: 1 }, { n: 1 }] }, [migration(query)],
    { batchSize: 1, assertionBounds: bounds, write: () => {} });
  assert.equal(success.counts.x.asserted, 2);
});

it('materializing reports count all asserted documents and invalid batch sizes refuse', async () => {
  const q = { $let: { count: { $count: '$[*]' } }, $return: { $gt: ['$count', 0] } };
  const out = await migrateDocuments({ x: [{ n: 1 }, { n: 2 }] }, [migration(q)]);
  assert.equal(out.report.counts.x.asserted, 2);
  for (const batchSize of [0, -1, NaN, Infinity, 1.5])
    await assert.rejects(() => migrateDocuments({ x: [] }, [], { batchSize }), /batchSize/);
});

it('DAG identity inspection refuses missing or incompatible identity without reading or rewriting node values', async () => {
  const doc = { name: 'test' }, input = { n: 1 }, versions = { task: '1' };
  const hash = (v) => hashContent(canonicalizeJson(v));
  const current = { revision: hash(doc), inputHash: hash(input), taskVersions: versions, taskVersionsHash: hash(versions) };
  for (const [value, hasValues, allowed] of [[undefined, true, false], [null, true, false],
    [{ revision: 'old', inputHash: 'old' }, false, false],
    [{ revision: current.revision, inputHash: current.inputHash }, false, true], [current, true, true]]) {
    let handlers, writes = 0, runs = 0;
    createDagJobRunner({ jobs: { createWorker: (options) => { handlers = options.handlers; return {}; } } }, {
      compileDag: () => ({ taskVersions: versions, run: async () => { runs++; } }), documents: { work: doc },
    });
    const context = { job: { id: 'r', lease: { token: 't' } }, checkpoints: {
      inspect: async () => ({ value, hasValues }),
      save: async () => { writes++; },
      load: async () => { throw new Error('node values read before identity acceptance'); },
    } };
    if (allowed) await handlers.work({ input }, context);
    else await assert.rejects(() => handlers.work({ input }, context), { code: 'JD2069' });
    assert.equal(runs, allowed ? 1 : 0);
    assert.equal(writes, allowed && value?.taskVersionsHash === undefined ? 1 : 0);
  }
});

it('explicit job reset atomically prunes one inactive run, advances its fence and refuses stale or live resets', async () => {
  const model = { $model: '0.1', collections: { x: { schema: { type: 'object' }, identity: 'uuid' } } };
  const store = await openStore(model, { driver: nodeDriver(), jobs: true });
  try {
    await store.jobs.enqueue('work', {}, { id: 'r' });
    const job = await store.jobs.claim({ kinds: ['work'], owner: 'a' });
    await store.jobs.checkpointsFor(job).save('r', 'n', { old: true });
    await assert.rejects(() => store.jobs.reset('r', { expectedGeneration: job.leaseGeneration }), { code: 'JD2068' });
    await store.jobs.cancel('r', { lease: job.lease });
    const result = await store.jobs.reset('r', { expectedGeneration: job.leaseGeneration });
    assert.deepEqual(result, { reset: true, discarded: 1, generation: job.leaseGeneration + 1 });
    assert.equal(await store.jobs.checkpointsFor(job).load('r'), null);
    await assert.rejects(() => store.jobs.reset('r', { expectedGeneration: job.leaseGeneration }), { code: 'JD2066' });
    assert.throws(() => store.jobs.checkpointsFor(job).save('r', 'stale', {}));
    const next = await store.jobs.claim({ kinds: ['work'], owner: 'b' });
    assert.equal(next.attempts, 1);
    await store.jobs.complete(next.lease, {});
    await assert.rejects(() => store.jobs.reset('r', { expectedGeneration: next.leaseGeneration }), { code: 'JD2065' });
  }
  finally { await store.close(); }
});

it('identity inspection does not parse node values, and a failed reset rolls back queue and checkpoints together', async () => {
  const db = new DatabaseSync(':memory:');
  const driver = { name: 'node-sqlite', dialect: sqliteDialect, open: () => adaptNodeDatabase(db) };
  const model = { $model: '0.1', collections: { x: { schema: { type: 'object' }, identity: 'uuid' } } };
  const store = await openStore(model, { driver, jobs: true });
  try {
    await store.jobs.enqueue('work', {}, { id: 'r' });
    const job = await store.jobs.claim({ kinds: ['work'], owner: 'a' });
    const checkpoints = store.jobs.checkpointsFor(job);
    await checkpoints.save('r', RUN_IDENTITY_NODE, { revision: 'old' });
    await checkpoints.save('r', 'n', { old: true });
    db.prepare('UPDATE "_jaren_job_checkpoints" SET value=? WHERE node_id=?').run('malformed node JSON', 'n');
    assert.deepEqual(await checkpoints.inspect('r', RUN_IDENTITY_NODE), { value: { revision: 'old' }, hasValues: true });
    await store.transaction(async (tx) => {
      assert.deepEqual(await tx.jobs.checkpointsFor(job).inspect('r', RUN_IDENTITY_NODE),
        { value: { revision: 'old' }, hasValues: true });
    });
    await store.jobs.cancel('r', { lease: job.lease });
    const before = await store.jobs.get('r');
    db.exec(`CREATE TRIGGER fail_reset BEFORE DELETE ON "_jaren_job_checkpoints"
      BEGIN SELECT RAISE(ABORT, 'reset-delete-fault'); END`);
    await assert.rejects(() => store.jobs.reset('r', { expectedGeneration: job.leaseGeneration }), /reset-delete-fault/);
    assert.deepEqual(await store.jobs.get('r'), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "_jaren_job_checkpoints" WHERE run_id=?').get('r').n, 2);
    db.exec('DROP TRIGGER fail_reset');
    assert.deepEqual(await store.jobs.reset('r', { expectedGeneration: job.leaseGeneration }),
      { reset: true, discarded: 2, generation: job.leaseGeneration + 1 });
  }
  finally { await store.close(); }
});

it('stream assertion plans are reported before input is pulled and cancellation stops admission', async () => {
  const events = [], controller = new AbortController();
  async function* source() { events.push('read'); yield { n: 1 }; controller.abort(); yield { n: 2 }; }
  await assert.rejects(() => streamDocuments({ x: source() }, [migration({ $sum: '$[*].n' })],
    { signal: controller.signal, batchSize: 100, write: () => { throw new Error('no batch may publish'); },
      onAssertionPlan: (plan) => { events.push(plan.strategy); assert.equal(plan.bounds, null); } }), { code: 'JD2080' });
  assert.deepEqual(events, ['fold', 'read']);
});

it('cancellation during a streamed write stops the next row and never reports success on the last row', async () => {
  for (const documents of [[{ n: 1 }], [{ n: 1 }, { n: 2 }]]) {
    const controller = new AbortController(), written = [];
    await assert.rejects(() => streamDocuments({ x: documents }, [], { signal: controller.signal,
      write: (name, document) => { written.push(document); controller.abort(); } }), { code: 'JD2080' });
    assert.deepEqual(written, [{ n: 1 }]);
  }
});
