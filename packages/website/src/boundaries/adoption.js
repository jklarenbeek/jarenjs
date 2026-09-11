//@ts-check
/** Offline catalog demonstration using a persisted SQLite file and reusable components. */
import { createDomRenderer } from '@jarenjs/view';
import { mountRuleEditor } from '@jarenjs/rules/component';
import { mountProviderCollection } from '@jarenjs/collection/component';
import { createCollectionCoordinator } from '@jarenjs/app';
import { readSchema } from '@jarenjs/db';
import { openAdoption } from '../examples/adoption.js';
import { seedAdoptionFile } from '../examples/adoption-fixture.js';
import { adoptionModel } from '../examples/adoption-model.js';
import { adoptionRows } from '../../../../scripts/lib/adoption.js';
import manifest from '../../../../test/adoption/manifest.json' with { type: 'json' };
import formulas from '../../../../test/adoption/fixtures/formulas.json' with { type: 'json' };

/** Persist session-local SQLite pages; a reload reopens the same data and queue. */
export function mountAdoptionDemo(host, options = {}) {
  const document = host.ownerDocument, render = createDomRenderer(host, { document });
  const definition = { ...manifest.consumers[0], rows: 256 };
  const rows = adoptionRows(definition);
  let app, editor, collection, disposed = false, teardown, now = Date.now();
  render(['section', {}, ['h2', {}, 'Catalog replacement journey'],
    ['p', {}, 'Search, edit a saved formula, review selected changes and ingest an offline provider snapshot. This synthetic catalog keeps its database in this tab’s session storage.'],
    ['label', {}, 'Search catalog ', ['input', { type: 'search', value: 'gren tea', 'aria-label': 'Journey search', 'data-journey-search': '' }]],
    ['button', { class: 'btn', 'data-journey-action': 'search' }, 'Search'],
    ['div', { 'data-journey-collection': '' }],
    ['div', { 'data-journey-editor': '' }],
    ['div', { class: 'btn-row' },
      ['button', { class: 'btn', 'data-journey-action': 'save' }, 'Save formula'],
      ['button', { class: 'btn', 'data-journey-action': 'ingest' }, 'Ingest snapshot'],
      ['button', { class: 'btn', 'data-journey-action': 'send' }, 'Send and simulate interruption'],
      ['button', { class: 'btn', 'data-journey-action': 'recover' }, 'Reconcile and recover'],
      ['button', { class: 'btn', 'data-journey-action': 'restart' }, 'Reopen database']],
    ['p', { role: 'status', 'data-journey-status': '' }, 'Opening catalog…'],
    ['p', {}, 'Live trigger capture and native full-text search are unavailable for this adopted file. Search uses an explicit current snapshot. Original formulas that need manual review remain preserved.'],
  ]);
  const status = host.querySelector('[data-journey-status]');
  const report = (text) => { if (!disposed) status.textContent = text; };
  const search = async (announce = true) => {
    await collection?.dispose();
    const found = await app.query(host.querySelector('[data-journey-search]').value);
    if (disposed) { await found.provider.dispose(); return; }
    collection = mountProviderCollection(host.querySelector('[data-journey-collection]'), createCollectionCoordinator(found.provider, { pageRows: 16, maxRows: 64 }), {
      height: 264, rowSize: 44, columnCount: 4, columnSize: 180, label: 'Journey catalog',
      renderCell: (row, column) => [row.id, row.title, `Amount: ${row.amount.toFixed(2)}`, `Revision: ${row.revision}`][column],
    });
    if (announce) report(`${found.result.total} matches. Original data preserved.`);
    return found.result.total;
  };
  const ready = (async () => {
    let driver = options.driver, path = options.path ?? 'session';
    if (!driver) {
      const [{ default: init }, { wasmDriver, sqlite3Handle }] = await Promise.all([import('@sqlite.org/sqlite-wasm'), import('@jarenjs/db/wasm')]);
      const sqlite = await init();
      if (!sqlite.oo1.JsStorageDb) throw new Error('Session SQLite storage is unavailable');
      driver = wasmDriver(sqlite3Handle(sqlite, { DbClass: sqlite.oo1.JsStorageDb }));
    }
    const check = await driver.open(path);
    let exists;
    try { exists = (await readSchema(check)).tables.some((table) => table.name === 'catalog_items'); }
    finally { await check.close(); }
    if (!exists) await seedAdoptionFile({ driver, path, definition, rows, originals: formulas.formulas });
    const transport = async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/write/')) {
        const storage = options.storage ?? sessionStorage;
        const log = JSON.parse(storage.getItem('adoption-remote') ?? '[]');
        log.push(request.url); storage.setItem('adoption-remote', JSON.stringify(log));
        if (log.length === 2) { await options.interrupt?.(); location.reload(); return Promise.withResolvers().promise; }
        return new Response(JSON.stringify({ correlation: request.url, applied: true }));
      }
      const offset = Number(url.searchParams.get('after') ?? 0), end = offset + 100;
      return new Response(JSON.stringify({ items: rows.slice(offset, end), next: end < rows.length ? String(end) : null, version: 'snapshot-1' }));
    };
    const open = () => openAdoption({ driver, path, definition, now: () => now, transport: options.transport ?? transport });
    app = await open();
    if (disposed) { await app.close(); return; }
    const saved = (await app.client.collections.settings.get('rule')).definition;
    editor = mountRuleEditor(host.querySelector('[data-journey-editor]'), { text: JSON.stringify(saved, null, 2), pageSize: 10,
      schema: adoptionModel(definition).entities.Item.schema, writableFields: ['/amount'],
      preview: (text) => app.preview(text), command: async (request) => {
        const result = await app.command.execute(request); await search(); return result;
      } });
    const total = await search(false);
    const job = await app.client.store.jobs.get('reviewed-job');
    const action = async (event) => {
      const name = event.target.getAttribute?.('data-journey-action');
      if (!name || disposed) return;
      try {
        if (name === 'search') await search();
        if (name === 'save') {
          const rule = JSON.parse(host.querySelector('[data-rule-draft]').value);
          const result = await app.saveRule(rule); report(`Saved formula: ${result.writes} writes.`);
        }
        if (name === 'ingest') { const result = await app.ingest(); report(`Snapshot ${result.state}: ${result.changes} changes.`); }
        if (name === 'send') {
          report('Preparing reviewed operation…');
          const changed = (await app.rows()).filter((row) => row.revision > 1);
          if (changed.length < 2) { report('Commit two reviewed rows before sending.'); return; }
          await app.prepare(changed.slice(0, 2).map((row) => row.id));
          const job = await app.client.store.jobs.claim({ kinds: ['external'], owner: 'browser', leaseMs: 1000 });
          report('Sending reviewed operation…');
          await app.runner.run('original-run', { operationId: 'reviewed-operation' }, { lease: job.lease });
        }
        if (name === 'recover') {
          now += 100000;
          const job = await app.client.store.jobs.claim({ kinds: ['external'], owner: 'recovery', leaseMs: 1000 });
          if (!job) { report('No interrupted run to recover.'); return; }
          let record = await app.effects.get('reviewed-operation');
          record = (await app.effects.recover(record.id, record.revision, job.lease)).record;
          const log = JSON.parse((options.storage ?? sessionStorage).getItem('adoption-remote') ?? '[]');
          for (const leg of record.legs.filter((leg) => leg.state === 'unresolved')) {
            const request = record.plan.legs.find((plan) => plan.id === leg.id).request;
            if (!log.includes(request.url)) throw new Error('No authoritative synthetic read-back');
            record = (await app.effects.reconcile(record.id, leg.id, record.revision, job.lease, { id: `readback-${leg.id}`, action: 'confirm', actor: 'reviewer', reason: 'synthetic provider read-back', evidence: { correlation: request.url } })).record;
          }
          const result = await app.runner.run('original-run', { operationId: record.id }, { lease: job.lease });
          await app.client.store.jobs.complete(job.lease, result.result); report('Recovered run complete. No remote resend.');
        }
        if (name === 'restart') { await app.close(); app = await open(); await search(); report('Database reopened. Original data and later writes preserved.'); }
      }
      catch (error) { report(`Journey refused: ${error.message}`); }
    };
    host.addEventListener('click', action);
    report(job ? job.state === 'done' ? 'Recovered run complete. Original data preserved.' : 'Interrupted send retained. Reconcile before sending again.'
      : `${total} matches. Original data preserved.`);
    return () => host.removeEventListener('click', action);
  })().catch((error) => { report(`Journey unavailable: ${error.message}`); });
  return { ready, dispose() {
    if (teardown) return teardown;
    disposed = true; editor?.dispose(); render.destroy();
    teardown = (async () => { const remove = await ready; remove?.(); await collection?.dispose(); await app?.close(); })(); return teardown;
  } };
}
