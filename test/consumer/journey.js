//@ts-check
/** The same public application journey runs from source, tarballs and standalone executables. */
import assert from 'node:assert/strict';
import { createCollectionCoordinator, createRunObservation } from '@jarenjs/app';
import { createRuleEditor } from '@jarenjs/rules';
import { createRunPageHandler } from '@jarenjs/contract/app';
import { createHash } from 'node:crypto';

/** Inspect complete data, original bytes, trigger history and the schema independently of the app. */
export async function inspectAdoption(driver, path) {
  const db = await driver.open(path);
  try {
    const all = (sql) => JSON.parse(JSON.stringify(db.prepare(sql).all([])));
    const table = all("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('catalog_items','archive_items')")[0].name;
    const columns = all(`PRAGMA table_info("${table}")`).map((column) => column.name).filter((name) => !['amount', 'revision', 'stock_amount', 'stock_revision'].includes(name));
    const originalData = createHash('sha256');
    for (const row of db.prepare(`SELECT ${columns.map((name) => `"${name}"`).join(',')} FROM "${table}" ORDER BY ${columns.map((name) => `"${name}"`).join(',')}`).iterate([])) originalData.update(JSON.stringify(row));
    const revision = table === 'archive_items' ? 'stock_revision' : 'revision';
    return { originalData: originalData.digest('hex'), count: all(`SELECT COUNT(*) AS n FROM "${table}"`)[0].n,
      revisions: all(`SELECT "${revision}" AS revision,COUNT(*) AS n FROM "${table}" GROUP BY "${revision}" ORDER BY "${revision}"`),
      schema: all('SELECT type,name,sql FROM sqlite_schema ORDER BY name'),
      history: all('SELECT * FROM original_history ORDER BY rowid'), bytes: all('SELECT hex(body) AS body FROM original_bytes') };
  }
  finally { await db.close(); }
}

/** Frozen two-profile inputs, with a real process-exit seam immediately after remote success. */
export async function runAdoptionJourney({ openAdoption, seedAdoptionFile, adoptionRule, driver, path, definition, rows, originals, phase = 'all', remote = () => {}, crash }) {
  const started = performance.now(), metrics = { consumer: definition.id, rows: rows.length, phase, pages: 0, sends: 0, secondWrites: 0, secondRevisions: 0, changes: 0 };
  const fresh = phase === 'all' || phase === 'crash';
  if (fresh) await seedAdoptionFile({ driver, path, definition, rows, originals });
  const before = await inspectAdoption(driver, path);
  const work = { ddl: 0, writes: 0 };
  const measuredDriver = { ...driver, async open(...args) {
    const db = await driver.open(...args);
    return { ...db, exec(sql) { if (/\b(CREATE|ALTER|DROP)\b/i.test(sql)) work.ddl++; return db.exec(sql); },
      prepare(sql) {
        const statement = db.prepare(sql);
        return { ...statement, run(params) { const result = statement.run(params); work.writes += result.changes ?? 0; return result; } };
      } };
  } };
  let now = phase === 'recover' ? 100000 : 100;
  let allowed = true;
  const wire = [], snapshot = rows.slice(0, definition.budgets.providers.rows);
  const pageSize = Math.ceil(snapshot.length / definition.budgets.providers.pages);
  const transport = async (request) => {
    wire.push({ method: request.method, url: request.url, body: request.body ?? null });
    if (new URL(request.url).pathname.startsWith('/write/')) {
      metrics.sends++; await remote(request);
      if (metrics.sends === 2 && crash) await crash();
      return new Response(JSON.stringify({ correlation: request.url, applied: true }));
    }
    metrics.pages++;
    const offset = Number(definition.id === 'archive-stock' ? JSON.parse(request.body).variables.after ?? 0 : new URL(request.url).searchParams.get('after') ?? 0);
    const next = offset + pageSize < snapshot.length ? String(offset + pageSize) : null;
    return new Response(JSON.stringify(definition.id === 'archive-stock'
      ? { data: { items: snapshot.slice(offset, offset + pageSize), next }, version: 'snapshot-1' }
      : { items: snapshot.slice(offset, offset + pageSize), next, version: 'snapshot-1' }));
  };
  let app = await openAdoption({ driver: measuredDriver, path, definition, now: () => now, authorize: () => allowed, transport });
  try {
    assert.deepEqual((await inspectAdoption(driver, path)).schema, before.schema);
    assert.equal(app.capabilities.live, false); assert.equal(app.capabilities.nativeFTS, false);
    assert.deepEqual((await app.client.collections.settings.get('originals')).sources, originals);
    assert.equal((await app.client.store.jobs.get('historic-job')).payload.original, true);
    if (fresh) {
      const migrated = await app.migrateSaved();
      assert.equal(migrated.records.filter((record) => record.native).length, 2);
      const secondMigration = await app.migrateSaved();
      assert.deepEqual([secondMigration.changed, secondMigration.writes, secondMigration.revisions], [0, 0, 0]);
      const queryStart = performance.now();
      const search = await app.query('gren tea');
      metrics.searchMs = performance.now() - queryStart;
      metrics.searchHash = createHash('sha256').update(JSON.stringify(search.result.hits.map(({ id, score }) => ({ id, score: Number(score.toPrecision(12)) })))).digest('hex');
      assert.equal(search.result.total, Math.ceil(rows.length / 4));
      assert.equal(search.result.hits.length, Math.ceil(rows.length / 4));
      assert.equal(search.completeMembership, true);
      const expectedHits = new Set(rows.filter((row) => row.title === 'Green tea').map((row) => row.id));
      assert.ok(search.result.hits.every((hit) => expectedHits.has(hit.id)));
      const coordinator = createCollectionCoordinator(search.provider, { pageRows: 16, maxRows: 32, maxBytes: definition.budgets.grid.loadedBytes });
      // Independent requests prove cross-page identity; the coordinator is also
      // mounted by the browser consumer of this same host.
      const request = (start) => ({ query: search.provider.query, snapshot: search.provider.snapshot, generation: 1, requestId: String(start),
        range: { start, end: start + 16 }, credits: { pages: 1, rows: 16, bytes: definition.budgets.grid.loadedBytes, work: 256 } });
      const first = await search.provider.request(request(0)), next = await search.provider.request(request(16));
      assert.equal(first.state, 'ready'); assert.equal(next.state, 'ready');
      assert.notEqual(first.keys[0], next.keys[0]);
      assert.ok(first.used.rows + next.used.rows <= 32);
      await coordinator.requestRange({ start: 0, end: 16 });
      assert.equal(coordinator.keyAt(0), first.keys[0]);
      await coordinator.requestRange({ start: 16, end: 32 });
      assert.equal(coordinator.keyAt(16), next.keys[0]);
      assert.ok(coordinator.stats().rows <= 32);
      await coordinator.dispose();
      const saved = structuredClone(adoptionRule); saved.revision = '2'; saved.targets[0].formula.revision = '2';
      saved.targets[0].formula.expression = { $add: [saved.targets[0].formula.expression, 1] };
      const stored = await app.saveRule(saved);
      assert.equal((await app.saveRule(saved)).writes, 0);
      const activeRule = definition.policy.writes === 'report-only' ? adoptionRule : saved;
      assert.equal(stored.writes, definition.policy.writes === 'report-only' ? 0 : 1);
      const initial = await app.rows(), plan = await app.preview(JSON.stringify(activeRule));
      assert.deepEqual(await app.rows(), initial);
      if (definition.policy.writes !== 'report-only') {
        const protectedChange = plan.changes.find((change) => initial.find((row) => row.id === change.entityId).provenance === 'manual');
        assert.equal((await app.command.execute({ key: 'protected', plan, selection: [protectedChange.id] })).state, 'uncommitted');
        const tampered = structuredClone(plan); tampered.changes[0].proposed++;
        assert.equal((await app.command.execute({ key: 'tampered', plan: tampered, selection: [tampered.changes[0].id] })).state, 'uncommitted');
        assert.deepEqual(await app.rows(), initial);
      }
      const eligible = plan.changes.filter((change) => initial.find((row) => row.id === change.entityId).provenance !== 'manual');
      const editor = createRuleEditor({ text: JSON.stringify(activeRule), preview: app.preview, command: app.command.execute });
      editor.edit(JSON.stringify(activeRule), 4, 8); await editor.preview();
      const selection = [eligible[0], eligible[20]];
      for (const change of selection) editor.select(change.id);
      const result = await editor.commit();
      if (definition.policy.writes === 'report-only') {
        assert.equal(result.reason, 'unauthorized'); assert.deepEqual(await app.rows(), initial);
        assert.equal((await app.prepare(selection.map((change) => change.entityId))).reason, 'unauthorized');
      }
      else {
        assert.equal(result.state, 'committed'); assert.equal(result.receipt.outcome.value.applied, 2);
        assert.equal((await editor.commit()).state, 'replay');
        const request = { key: JSON.stringify([plan.id, selection.map((change) => change.id).sort()]), plan, selection: selection.map((change) => change.id).sort() };
        await app.client.collections.settings.put({ id: 'request', value: request }, 'request');
        assert.equal((await app.command.execute({ ...request, key: 'stale' })).state, 'uncommitted');
        allowed = false; assert.equal((await app.command.execute(request)).reason, 'unauthorized'); allowed = true;
        assert.equal((await inspectAdoption(driver, path)).history.length, 3);
      }
      editor.dispose();
      const ingest = await app.ingest(); assert.equal(ingest.state, 'published'); assert.equal(ingest.changes, snapshot.length);
      const wireBefore = wire.length;
      assert.deepEqual(Object.fromEntries(Object.entries(await app.ingest()).filter(([key]) => ['changes', 'writes', 'revisions'].includes(key))), { changes: 0, writes: 0, revisions: 0 });
      assert.equal(wire.length, wireBefore);
      assert.equal(metrics.pages, Math.ceil(snapshot.length / pageSize));
      metrics.changes = ingest.changes;
      if (definition.policy.writes !== 'report-only') {
        const ids = selection.map((change) => change.entityId);
        await app.prepare(ids); assert.equal((await app.prepare(ids)).writes, 0);
        const job = await app.client.store.jobs.claim({ kinds: ['external'], owner: 'initial', leaseMs: 1000 });
        assert.equal((await app.runner.run('original-run', { operationId: 'reviewed-operation' }, { lease: job.lease })).result.state, 'complete');
        await app.client.store.jobs.complete(job.lease, { state: 'complete' });
      }
      await app.close(); now += 100000;
      app = await openAdoption({ driver: measuredDriver, path, definition, now: () => now, authorize: () => allowed, transport });
    }
    if (phase === 'recover') {
      const job = await app.client.store.jobs.claim({ kinds: ['external'], owner: 'recovery', leaseMs: 1000 });
      const record = await app.effects.get('reviewed-operation');
      assert.deepEqual(record.legs.map((leg) => leg.state), ['confirmed', 'sending']);
      const recovered = await app.effects.recover(record.id, record.revision, job.lease);
      assert.equal((await app.effects.recover(record.id, recovered.record.revision, job.lease)).writes, 0);
      assert.equal((await app.external.run(record.id, { lease: job.lease })).state, 'unresolved');
      assert.equal(metrics.sends, 0);
      const decision = { id: 'readback-2', action: 'confirm', actor: 'operator', reason: 'synthetic remote journal confirms application', evidence: { correlation: record.plan.legs[1].request.url } };
      await app.effects.reconcile(record.id, record.legs[1].id, recovered.record.revision, job.lease, decision);
      const repeat = await app.effects.reconcile(record.id, record.legs[1].id, recovered.record.revision, job.lease, decision);
      assert.deepEqual([repeat.changes, repeat.writes, repeat.revisions], [0, 0, 0]);
      const result = await app.runner.run('original-run', { operationId: record.id }, { lease: job.lease });
      assert.equal(result.result.state, 'complete'); await app.client.store.jobs.complete(job.lease, result.result);
      assert.equal(metrics.sends, 0);
    }
    const wireBefore = wire.length, writesBefore = work.writes;
    assert.equal((await app.ingest()).writes, 0); assert.equal(wire.length, wireBefore);
    assert.equal((await app.migrateSaved()).writes, 0);
    if (definition.policy.writes !== 'report-only') {
      const request = (await app.client.collections.settings.get('request')).value;
      const replay = await app.command.execute(request); assert.equal(replay.state, 'replay');
      assert.deepEqual([replay.writes, replay.revisions], [0, 0]);
      const committed = await app.rows();
      for (const change of request.plan.changes.filter((change) => request.selection.includes(change.id))) {
        const row = committed.find((row) => row.id === change.entityId);
        assert.equal(row.amount, change.proposed, 'the exact reviewed amount survives reopen and receipt replay');
        assert.equal(row.revision, 2);
      }
      const readPage = createRunPageHandler({ page: app.runs.page, authorize: () => true, maxPage: 8 });
      const done = Promise.withResolvers();
      const observe = createRunObservation({ readPage, pageSize: 8, maxBytes: 16384,
        wake: (signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) });
      const detach = observe({ id: 1, runId: 'original-run', cursor: 0, update: 'progress', error: 'error' }, (name, value) => done.resolve({ name, value }));
      assert.equal((await done.promise).name, 'progress'); detach(); observe.dispose();
      assert.equal((await app.runs.get('original-run')).status, 'done');
    }
    assert.deepEqual((await app.client.collections.settings.get('originals')).sources, originals);
    assert.equal((await app.client.collections.settings.get('history')).value, 'preserve original settings');
    const after = await inspectAdoption(driver, path);
    assert.deepEqual(after.schema, before.schema); assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.originalData, before.originalData);
    assert.equal(work.ddl, 0); assert.equal(work.writes - writesBefore, 0);
    metrics.startupDDL = work.ddl; metrics.secondWrites = work.writes - writesBefore;
    assert.equal(after.history.length, definition.policy.writes === 'report-only' ? 1 : 3);
    assert.deepEqual(after.history[0], { id: 'historic-row', revision: 7, amount: 19 });
    assert.equal(after.count, before.count);
    assert.deepEqual(after.revisions, definition.policy.writes === 'report-only' ? [{ revision: 1, n: before.count }]
      : [{ revision: 1, n: before.count - 2 }, { revision: 2, n: 2 }]);
    metrics.history = after.history.length; metrics.wire = wire;
    metrics.elapsedMs = performance.now() - started;
    const teardown = performance.now(); await app.close(); await app.close();
    metrics.teardownMs = performance.now() - teardown;
    return metrics;
  }
  finally { await app.close(); }
}
