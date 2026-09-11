//@ts-check
/** Neutral application policy: saved rules, inventory revisions and receipt transactions. */
import { compileContract } from '@jarenjs/contract';
import { createCommand } from '@jarenjs/contract/command';
import { open, createDbReceipts } from '@jarenjs/linq/db';
import { canonicalizeJson, canonicalSha256 } from '@jarenjs/json/canonical';
import { compileRulePlan, selectRuleChanges } from '@jarenjs/json/rules';
import { compileJSONPointerSetter } from '@jarenjs/json/write';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

export const ruleRowSchema = { type: 'object', required: ['id', 'price', 'quantity', 'amount', 'revision'], properties: {
  id: { type: 'string' }, price: { type: 'number' }, quantity: { type: 'number' }, amount: { type: 'number' }, revision: { type: 'integer' },
}, additionalProperties: false };
export const savedRule = { $rules: '1', id: 'amounts', revision: '1', targets: [{ id: 'amount', field: '/amount', formula: {
  $formula: '1', id: 'amount', revision: '1', expression: { $mul: ['$.price', '$.quantity'] },
} }] };
const contract = compileContract({ $contract: '0.1', operations: { 'rules.apply': {
  kind: 'command', input: { type: 'object', required: ['key', 'plan', 'selection'], properties: {
    key: { type: 'string' }, plan: { type: 'object' }, selection: { type: 'array', items: { type: 'string' }, maxItems: 256 },
  }, additionalProperties: false }, output: { type: 'object', required: ['applied'], properties: { applied: { type: 'integer' } }, additionalProperties: false },
  errors: { conflict: { status: 409 }, unauthorized: { status: 403 }, invalid: { status: 422 } },
} } });

/** The host uses public APIs only; driver selection belongs to Node/Bun/browser composition. */
export async function openRuleExample({ driver, count = 64, authorize = () => true }) {
  const model = { $model: '0.1', collections: Object.fromEntries(['items', 'settings', 'receipts', 'leases'].map((name) => [name, { key: '/id', schema: name === 'items' ? ruleRowSchema : { type: 'object' }, indexes: [] }])) };
  const client = await open(model, { driver });
  const typeTest = createTypeTestCompiler(), validRow = typeTest(ruleRowSchema, '');
  const options = { writableFields: ['/amount'], compileTypeTest: typeTest, maxRows: 256, maxCells: 4096 };
  try {
    await client.transaction(async (tx) => {
      await tx.collections.settings.put({ id: 'saved-rule', definition: savedRule }, 'saved-rule');
      for (let i = 0; i < count; i++) await tx.collections.items.put({ id: `item-${i}`, price: i + 1, quantity: 2, amount: 0, revision: 0 }, `item-${i}`);
    });
    const planFor = async (definition, rows) => compileRulePlan(definition, options).preview({ rows, datasetRevision: await canonicalSha256(rows) });
    const command = createCommand(contract.operations['rules.apply'], {
      repository: createDbReceipts(client, { receipts: 'receipts', leases: 'leases' }),
      identity: (_value, context) => ({ tenant: 'example', environment: 'local', aggregate: 'inventory', op: 'rules.apply', key: context.ruleKeyHash, hashVersion: 'sha256/1', hash: context.ruleRequestHash }),
      authorize,
      handler: async (value, ctx) => {
        if (await authorize(value, ctx) !== true) return ctx.fail('unauthorized');
        const rows = await ctx.host.collections.items.toArray();
        const current = await ctx.host.collections.settings.get('saved-rule');
        let changes;
        try { changes = await selectRuleChanges(value.plan, value.selection, await planFor(current.definition, rows)); }
        catch { return ctx.fail('conflict'); }
        const next = new Map(rows.map((row) => [row.id, row]));
        const affected = new Set();
        for (const change of changes) {
          const row = compileJSONPointerSetter(change.field)(next.get(change.entityId), change.proposed);
          next.set(change.entityId, row); affected.add(change.entityId);
        }
        for (const id of affected) {
          const row = { ...next.get(id), revision: next.get(id).revision + 1 };
          if (!validRow(row)) return ctx.fail('invalid');
          next.set(id, row);
        }
        // All current authority, revision, before-value and output checks precede effects.
        for (const id of affected) await ctx.host.collections.items.put(next.get(id), id);
        return { applied: affected.size };
      },
    });
    return { client, command: {
      async execute(value, context = {}) {
        const input = JSON.parse(canonicalizeJson(value));
        return command.execute(input, { ...context, ruleKeyHash: await canonicalSha256(input.key), ruleRequestHash: await canonicalSha256(input) });
      },
    },
      preview: async (text) => planFor(JSON.parse(text), await client.collections.items.toArray()),
      rows: () => client.collections.items.toArray(),
      close: () => client.close(),
    };
  }
  catch (error) { await client.close(); throw error; }
}
