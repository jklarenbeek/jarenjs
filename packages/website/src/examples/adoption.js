//@ts-check
/** Neutral product policy composing the installed storage, search, rules and workflow owners. */
import { open, createDbReceipts, createDbIngestionStore, createDbEffectStore, createDbRunStore } from '@jarenjs/linq/db';
import { compileLexical } from '@jarenjs/core/search';
import { createArrayRangeProvider } from '@jarenjs/core/range';
import { canonicalizeJson, canonicalSha256 } from '@jarenjs/json/canonical';
import { compileRulePlan, selectRuleChanges } from '@jarenjs/json/rules';
import { migrateFormulas } from '@jarenjs/json/formula/migrate';
import { compileContract } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { compileProvider, createProviderExecutor } from '@jarenjs/contract/provider';
import { createIngestion, createExternalEffects, createDomainRun } from '@jarenjs/flow';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { adoptionModel, adoptionItemKey, adoptionFields } from './adoption-model.js';

const contract = compileContract({ $contract: '0.1', operations: { review: { kind: 'command',
  input: { type: 'object', required: ['key', 'plan', 'selection'], properties: { key: { type: 'string' }, plan: { type: 'object' }, selection: { type: 'array', items: { type: 'string' }, maxItems: 128 } }, additionalProperties: false },
  output: { type: 'object', required: ['applied'], properties: { applied: { type: 'integer' } } }, errors: { conflict: { status: 409 }, invalid: { status: 422 }, unauthorized: { status: 403 } },
} } });

/** Open an already provisioned file. Capture is explicitly unavailable for application triggers. */
export async function openAdoption({ driver, path, definition, now = Date.now, authorize = () => true, transport }) {
  const model = adoptionModel(definition);
  const client = await open(model, { driver, path, adopt: true, jobs: { now } });
  const validRow = createTypeTestCompiler()(model.entities.Item.schema, '');
  const executor = createProviderExecutor({ attempts: definition.budgets.providers.attempts, transport });
  const receipts = createDbReceipts(client, { receipts: 'receipts', leases: 'leases' });
  const effects = createDbEffectStore(client, { operations: 'operations', maxLegs: 2 });
  const runs = createDbRunStore(client, { runs: 'runs', events: 'events', maxPage: 8, maxBytes: 16384 });
  const options = { writableFields: ['/amount'], maxRows: 128, maxCells: 128 };
  // This explicit read snapshot is bounded separately from displayed pages.
  // Adopted triggers have no qualified live capture; refresh always reads current rows.
  const rowsFor = (over, limit = 128) => over.entities.Item.asNoTracking().load({ orderBy: '$it.id', take: limit });
  const planFor = async (rule, rows) => compileRulePlan(rule, options).preview({ rows, datasetRevision: await canonicalSha256(rows) });
  const canWrite = async (...args) => definition.policy.writes !== 'report-only' && await authorize(...args) === true;
  const command = createCommand(contract.operations.review, { repository: receipts,
    identity: (input, context) => ({ tenant: definition.id, environment: definition.policy.environment, aggregate: 'items', op: 'review', key: input.key, hashVersion: 'sha256/1', hash: context.hash }),
    authorize: canWrite,
    handler: async (input, ctx) => {
      if (!await canWrite(input, ctx)) return ctx.fail('unauthorized');
      const rows = await rowsFor(ctx.host), saved = await ctx.host.collections.settings.get('rule');
      let changes;
      try { changes = await selectRuleChanges(input.plan, input.selection, await planFor(saved.definition, rows)); }
      catch { return ctx.fail('conflict'); }
      const proposed = changes.map((change) => {
        const row = rows.find((value) => value.id === change.entityId);
        return { ...row, amount: change.proposed, revision: row.revision + 1 };
      });
      if (proposed.some((row) => row.provenance === 'manual' || !validRow(row))) return ctx.fail('invalid');
      for (const row of proposed) await ctx.host.entities.Item.update(adoptionItemKey(definition, row), row);
      return { applied: proposed.length };
    },
  });
  let index = null, source = [], range = null, disposed = false, queryTicket = 0;
  const pending = new Set();
  const refreshSource = async () => {
    if (disposed) throw new Error('disposed');
    const rows = await rowsFor(client, definition.rows + 1);
    if (rows.length > definition.rows || new TextEncoder().encode(JSON.stringify(rows)).byteLength > definition.budgets.search.sourceBytes)
      throw new RangeError('source credits');
    const revision = await canonicalSha256(rows);
    if (disposed) throw new Error('disposed');
    index ??= compileLexical({ version: 1, fields: adoptionFields, prefix: true, fuzzy: 0.15, combineWith: 'AND',
      limits: { maxDocuments: definition.rows, maxResults: definition.rows, maxSourceBytes: definition.budgets.search.sourceBytes, maxIndexBytes: definition.budgets.search.indexBytes } }).create();
    const result = index.rebuild(rows, { sourceRevision: revision });
    if (result.state !== 'complete') throw new Error(result.reason);
    source = rows;
    return result;
  };
  const refresh = () => {
    const result = refreshSource(); pending.add(result);
    result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  };
  const query = async (text) => {
    const ticket = ++queryTicket;
    await refresh();
    if (disposed) throw new Error('disposed');
    if (ticket !== queryTicket) throw new Error('superseded');
    const result = index.search(text, { limit: definition.rows });
    if (result.state !== 'complete') throw new Error(result.reason);
    const wanted = new Set(result.hits.map((hit) => hit.id));
    const found = new Map(source.filter((row) => wanted.has(row.id)).map((row) => [row.id, row]));
    await range?.dispose();
    if (disposed) throw new Error('disposed');
    if (ticket !== queryTicket) throw new Error('superseded');
    range = createArrayRangeProvider(result.hits.map((hit) => found.get(hit.id)), { query: canonicalizeJson([text, result.sourceRevision]), snapshot: result.sourceRevision });
    return { result, provider: range, completeMembership: !result.hasMore };
  };
  const ingestion = createDbIngestionStore(client, { staging: 'staging', checkpoints: 'checkpoints', publications: 'publications', facts: 'facts',
    reconcile: (existing, incoming) => existing?.provenance === 'manual' ? existing : incoming });
  const protocol = definition.id === 'archive-stock' ? 'graphql' : 'rest';
  const provider = compileProvider({ $provider: '0.1', id: definition.id, apiVersion: '1', protocol, method: protocol === 'graphql' ? 'POST' : 'GET', safety: 'safe-read',
    endpoint: `https://${definition.id}.example/items`,
    ...(protocol === 'graphql' ? { graphql: { query: 'query Items($after: String) { items(after: $after) { id } }', variables: {} } } : {}),
    response: protocol === 'graphql' ? { rows: '$.data.items', id: '$.id', cursor: '$.data.next', version: '$.version' } : { rows: '$.items', id: '$.id', cursor: '$.next', version: '$.version' },
    pagination: protocol === 'graphql' ? { cursorVariable: 'after', empty: 'complete' } : { cursorParam: 'after', empty: 'complete' },
    limits: Object.fromEntries(['pages', 'rows', 'bytes'].map((name) => [name, definition.budgets.providers[name]])) });
  const plan = { source: definition.id, version: 'snapshot-1', generation: 'generation-1', partitions: ['all'], input: {}, policyRevision: '1', consistency: 'snapshot' };
  const ingest = createIngestion({ provider, store: ingestion, source: () => ({ version: plan.version, consistency: plan.consistency }),
    maxPages: definition.budgets.providers.pages, maxRows: definition.budgets.providers.rows, maxBytes: definition.budgets.providers.bytes });
  const external = createExternalEffects({ store: effects, executor, authorize: canWrite,
    classify: (response) => ({ state: 'confirmed', evidence: JSON.parse(response.text) }) });
  const workflow = { $workflow: '0.2', revision: '1', initial: 'send', states: {
    send: { work: { task: 'send', version: '1' }, then: 'done' }, done: { final: true },
  } };
  const runner = createDomainRun(workflow, { store: runs, schemaVersion: '1', tasks: { send: { version: '1',
    run: ({ input }, _signal, resources) => external.run(input.operationId, resources) } } });
  return { client, receipts, effects, runs, runner, external, refresh, query,
    capabilities: { live: false, nativeFTS: false, writes: definition.policy.writes !== 'report-only' },
    rows: () => rowsFor(client),
    migrateSaved: () => client.transaction(async (tx) => {
      const original = await tx.collections.settings.get('originals');
      const prior = await tx.collections.settings.get('migrated-originals');
      const result = await migrateFormulas(original.sources, prior?.records);
      if (result.changed) await tx.collections.settings.put({ id: 'migrated-originals', records: result.records }, 'migrated-originals');
      return { ...result, writes: result.changed ? 1 : 0, revisions: result.changed ? 1 : 0 };
    }),
    preview: async (text) => planFor(JSON.parse(text), await rowsFor(client)),
    async saveRule(rule) {
      rule = JSON.parse(canonicalizeJson(rule));
      compileRulePlan(rule, options);
      if (!await canWrite()) return { state: 'refused', reason: 'unauthorized', changes: 0, writes: 0, revisions: 0 };
      return client.transaction(async (tx) => {
        if (!await canWrite()) return { state: 'refused', reason: 'unauthorized', changes: 0, writes: 0, revisions: 0 };
        const prior = await tx.collections.settings.get('rule');
        if (canonicalizeJson(prior.definition) === canonicalizeJson(rule)) return { changes: 0, writes: 0, revisions: 0 };
        await tx.collections.settings.put({ id: 'rule', definition: rule }, 'rule');
        return { changes: 1, writes: 1, revisions: 1 };
      });
    },
    command: { execute: async (request) => {
      const input = JSON.parse(canonicalizeJson(request));
      return command.execute(input, { hash: await canonicalSha256(input) });
    } },
    ingest: () => ingest.run(plan, { executor }),
    async prepare(ids) {
      ids = [...ids];
      if (!await canWrite()) return { state: 'refused', reason: 'unauthorized', changes: 0, writes: 0, revisions: 0 };
      if (ids.length !== 2 || new Set(ids).size !== ids.length) throw new TypeError('Select two distinct committed rows');
      return effects.prepare({ id: 'reviewed-operation', jobId: 'reviewed-job', kind: 'external', actor: definition.id, reason: 'reviewed catalog selection', hashVersion: 'canonical/1',
        legs: ids.map((id) => ({ id, maxAttempts: 1, request: { url: `https://${definition.id}.example/write/${encodeURIComponent(id)}`, method: 'POST', body: canonicalizeJson({ id }), safety: 'single-send' } })) }, async (tx) => {
        if (!await canWrite()) throw new Error('unauthorized');
        const rows = await rowsFor(tx);
        if (ids.some((id) => !rows.some((row) => row.id === id && row.revision > 1 && row.provenance !== 'manual')))
          throw new TypeError('Selection is not committed in the current catalog');
      });
    },
    async close() { disposed = true; await Promise.allSettled([...pending]); await range?.dispose(); index?.dispose(); source = []; await executor.close(); await client.close(); },
  };
}
