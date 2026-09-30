// The typing gaps a strict consumer met: every spelling below is one a
// consumer wrote, and each compiles WITHOUT a cast. Each block failed
// `tsc` at 59ff8857 (0.92.0).
import * as s from '@jarenjs/linq/schema';
import type { AnyBuilder, KeywordValue } from '@jarenjs/linq/schema';
import * as m from '@jarenjs/linq/model';
import { open, createDbLedger, createDbReceipts, createDbEffectStore, createDbRunStore, createDbIngestionStore } from '@jarenjs/linq/db';
import type { DbLedger } from '@jarenjs/linq/db';
import { defineContract, read, command, error, http, typedHandlers, typedTools } from '@jarenjs/linq/contract';
import type { HandlerContext, OperationInfo, ErrorContext } from '@jarenjs/linq/contract';
import { defineDag, input, output, task, edge, typedTasks } from '@jarenjs/linq/flow';
import { typedStore } from '@jarenjs/db/typed';
import type { Store, Driver } from '@jarenjs/db';
import { planMigration, planModelMigration, sqliteDialect } from '@jarenjs/db';
import type { Ledger } from '@jarenjs/contract/ledger';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { getSchemaDraftByVersion } from '@jarenjs/refs';
import { JarenValidator } from '@jarenjs/validate';
import { renderFormsMessage } from '@jarenjs/forms';
import { fixtureModel } from '../linq/model-corpus.js';

declare const driver: Driver;

// ——— the handler context names its operation, and can arm a header ———
const Labels = defineContract({ id: 'labels', version: '1' }, {
  'label.get': read({
    input: s.object({ id: s.string() }),
    output: s.object({ id: s.string() }),
    errors: { 'not-found': error({ status: 404 }) },
    http: http({ method: 'GET', path: '/labels/{id}' }),
  }),
  'label.purge': command({ output: s.boolean(), http: http({ method: 'POST', path: '/labels/purge' }) }),
});
export const handlers = typedHandlers(Labels, {
  'label.get': (inp, ctx) => {
    const op: OperationInfo = ctx.op;
    // `id` stays `string`: a table whose handlers demanded a literal id
    // would no longer be a `Handler` serveHttp accepts (strict function types)
    const id: string = ctx.op.id;
    const declares = (code: string): boolean => Object.hasOwn(ctx.op.errors, code);
    const status: number = ctx.op.errors['not-found'].status;
    const method: string = ctx.op.http.method;
    ctx.header('x-served-by', 'labels');
    void [op, id, declares, status, method];
    return { id: inp.id };
  },
  'label.purge': () => true,
});
export const onError = (err: unknown, ctx: ErrorContext): void => {
  const opId: string | undefined = ctx?.op.id;
  void [err, opId];
};
export function channelHeaderIsNull(ctx: HandlerContext<null, 'port'>): null { return ctx.header; }

// ——— every tool's execute exists ———
export async function tools(list: readonly unknown[]): Promise<void> {
  for (const tool of typedTools(list, Labels)) {
    const outcome = await tool.execute({ id: 'l1' }, { signal: AbortSignal.timeout(1000), attempt: 'a1' });
    void outcome;
  }
}

// ——— builders inside keyword() ———
const kept: KeywordValue = [s.string(), { nested: s.integer() }];
export const withKeyword = s.any().keyword('anyOf', [s.string().min(1), s.integer()]).keyword('x-kept', kept);

// ——— one exported AnyBuilder ———
export const builders: AnyBuilder[] = [s.string(), m.string(), s.object({ a: s.number() })];

// ——— a TypedStore is a Store ———
export async function typedStoreIsAStore(store: Store): Promise<void> {
  const typed = typedStore<Record<string, never>>(store);
  const plain: Store = typed;
  await typed.checkpoint();
  await typed.transaction(async () => 1, { mode: 'immediate' });
  await typed.jobs?.sweep({ settledBefore: Date.now() });
  void plain;
}

// ——— the ledger and the durable adapters over concrete open() clients ———
const jsonModel = { $model: '0.1', collections: { ledger: { schema: { type: 'object' }, key: '/id' } } } as const;
const penModel = m.defineModel({ collections: { ledger: m.collection(m.object({ id: m.string() }).open(), { key: '/id' }) } });
export async function concreteClients(): Promise<void> {
  const fromJson = await open(jsonModel, { driver });
  const fromPen = await open(penModel, { driver });
  const entities = await open(fixtureModel, { driver });
  void fromJson.collections.ledger;
  const ledgers: DbLedger[] = [createDbLedger(fromJson), createDbLedger(fromPen), createDbLedger(entities)];
  await fromJson.transaction(async (tx) => { ledgers.push(createDbLedger(tx)); });
  for (const client of [fromJson, fromPen, entities]) {
    void createDbReceipts(client, { receipts: 'ledger' });
    void createDbEffectStore(client, { operations: 'ledger' });
    void createDbRunStore(client, { runs: 'ledger', events: 'ledger' });
    void createDbIngestionStore(client, { staging: 'ledger', checkpoints: 'ledger', publications: 'ledger' });
  }
}

// ——— the memory ledger's sweep is part of the Ledger type ———
export function sweeps(ledger: Ledger): unknown { return ledger.sweep?.(); }
export const memory: Ledger = createMemoryLedger();

// ——— migration planning is typed ———
export function plans(): void {
  const planned = planMigration({ $model: '0.1', collections: {} }, { $model: '0.1', collections: {} }, { dialect: sqliteDialect });
  const steps: readonly unknown[] = planned.migration.steps;
  const destructive: boolean = planModelMigration({ $model: '0.1' }, { $model: '0.1' }, { dialect: sqliteDialect }).report.destructive;
  void [steps, destructive];
}

// ——— a meta-schema bundle registers without a cast ———
const meta = getSchemaDraftByVersion(2020);
export const validator = new JarenValidator().addMetaSchema([...meta.schema], meta.draft);

// ——— D4c: a checkpointed task declares its handler version ———
export const dag = defineDag({
  nodes: { rows: input(), summary: task('llm', { prompt: 'x' }, { version: '2026-09-05' }).checkpoint(), out: output() },
  edges: [edge('rows', 'summary'), edge('summary', 'out')],
});
export const registry = typedTasks(dag, { llm: { run: async () => 'ok', version: '2026-09-05' } });
// @ts-expect-error — an unversioned task cannot be checkpointed: a replay needs the handler's identity
void task('llm', { prompt: 'x' }).checkpoint();

// ——— D4b: the forms message renderer is exported ———
export const rendered: string = renderFormsMessage(undefined, 'form/required', {});
