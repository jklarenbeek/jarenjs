//@ts-check
/**
 * @file The packed-consumer release gate.
 *
 * The monorepo masks dependency-closure defects: a package can import a
 * sibling it never declared, because every sibling is always installed
 * at the workspace root. This gate reproduces what a REAL consumer
 * experiences: for every publishable package it
 *
 *   1. packs the tarball (`npm pack`),
 *   2. installs it in a fresh directory with ONLY its declared
 *      `@jarenjs/*` dependency closure (extracted from the packed
 *      tarballs, nothing hoisted, nothing extra),
 *   3. imports every explicit JavaScript export subpath under plain
 *      Node ESM — for a package declaring OPTIONAL peers, first one
 *      subpath at a time WITHOUT them, so that every subpath that fails
 *      fails only by a peer's name (`ERR_MODULE_NOT_FOUND`), at least
 *      one imports clean and at least one needs them (a peer rule no
 *      subpath exercises is a claim nobody checked), then all of them
 *      with the peers' closures installed from the tarballs,
 *   4. type-checks a strict TypeScript consumer against the packed
 *      declarations (`tsc --noEmit`, strict, no `skipLibCheck`) —
 *      namespace imports of every subpath, plus semantic calls of the
 *      key public APIs for the packages that carry them,
 *   5. repeats the runtime imports under Bun when a `bun` binary is on
 *      PATH (consumers ship Bun single-binaries); `--require-bun`
 *      makes a missing Bun a gate FAILURE (release CI must pass it —
 *      an optional leg cannot prove a release claim),
 *   6. bundles the `@jarenjs/app` consumer with an isolated Vite `lib`
 *      build (the browser-bundler leg of the release gate: Vite must
 *      resolve the packed export maps from the declared closure
 *      alone).
 *
 * An undeclared import fails here with ERR_MODULE_NOT_FOUND even though
 * the workspace test suite passes — exactly the class of defect this
 * gate exists to catch; a declaration missing from a tarball fails the
 * TypeScript leg the same way. The claim under test is "every explicit
 * JavaScript export key" — wildcard export patterns (`./x/*`) and
 * non-JavaScript subpaths (schemas, package.json) are not generally covered.
 * The JSON package also pins both published JTLT grammar artifacts explicitly.
 *
 * Portability: paths derive from `fileURLToPath` (a URL `pathname` is
 * not a Windows filesystem path), npm runs through its own JS
 * entrypoint (`npm_execpath`) under the current Node executable (the
 * Windows `npm` shim is not a portable `execFileSync` target), Bun
 * executes a program FILE — never a multiline `-e` string, which a
 * Windows shell reparses into garbage — with no shell anywhere, and
 * the temporary work directory is removed in `finally`, also on
 * failure.
 *
 * Run: `node scripts/check-packed-consumers.js [--require-bun]`
 * (or `npm run test:packed`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNpm } from './lib/portable.js';
import { importSubpaths } from './lib/exports.js';
import { tarExtractArgs } from './lib/tar-extract-args.js';
import { adoptionRows } from './lib/adoption.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireBun = process.argv.includes('--require-bun');

/**
 * Run the npm CLI portably — the shared `runNpm` (npm's own JS entrypoint
 * under the current Node, with the documented shim fallback for direct
 * invocation), shaped to this script's `(args, cwd)` call sites.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function npm(args, cwd) {
  return runNpm(args, { cwd });
}

/** Publishable workspaces: every non-private workspace package. */
function publishableWorkspaces() {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = rootPkg.workspaces
    .map((w) => w.replace(/^\.\//, ''))
    .filter((w) => !w.startsWith('benchmark'));
  const packages = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    if (pkg.private === true) continue;
    packages.push({ dir, name: pkg.name, pkg });
  }
  return packages;
}

/** The declared peers of a package (`peerDependencies`), each with its
 * own dependency closure — what a consumer of the subpath that needs
 * them installs beside the package. */
function declaredPeers(pkg) {
  return Object.keys(pkg.peerDependencies ?? {});
}

/** The transitive DECLARED `@jarenjs/*` dependency closure of a package. */
function declaredClosure(byName, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  const entry = byName.get(name);
  if (entry === undefined) {
    throw new Error(`${name} is declared as a dependency but is not a publishable workspace`);
  }
  for (const dep of Object.keys(entry.pkg.dependencies ?? {})) {
    if (dep.startsWith('@jarenjs/')) declaredClosure(byName, dep, seen);
  }
  return seen;
}

const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) {
  console.error('the TypeScript compiler is not installed at the workspace root; '
    + 'the packed-declaration leg cannot run (npm ci first)');
  process.exit(1);
}

// no shell: `bun` resolves to the real executable on every platform
// (Windows CreateProcess appends `.exe`); a shell would reparse args
const bunProbe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const bun = bunProbe.status === 0;
if (!bun && requireBun) {
  console.error('--require-bun: no bun binary on PATH — the Bun consumer leg is mandatory in release mode.');
  process.exit(1);
}
if (!bun) console.log('(no bun binary on PATH — the Bun consumer leg is skipped)');

/**
 * Semantic strict-TypeScript snippets per package: beyond resolving
 * declarations, the packed consumer CALLS the key public APIs in value
 * positions, so a declaration that resolves but no longer matches the
 * runtime surface fails here. Each snippet may import only from the
 * package's own declared closure.
 * @type {Record<string, string>}
 */
const SEMANTIC_SNIPPETS = {
  '@jarenjs/core': `
import { isJsonNumberString } from '@jarenjs/core/number';
import { createBoundedCache } from '@jarenjs/core/cache';
const jsonNumber: boolean = isJsonNumberString('1.25e2');
const boundedCache = createBoundedCache<string, number>(2);
boundedCache.set('entry', 1);
const removed: boolean = boundedCache.delete('entry');
void [jsonNumber, removed];
`,
  '@jarenjs/ai': `
import { createChatClient, createToolbox, createAgent, registerModelContext, resolveEndpoint, createLedger, createGuardedRefiner, validateClaimEvidence, ledgerFootprint } from '@jarenjs/ai';
void validateClaimEvidence({}); void ledgerFootprint({});
void createGuardedRefiner({ read: async () => ({}), validateProposal: () => true, apply: (d: any) => d, validateCandidate: () => true, planCommit: (d: any) => d, commit: async (d: any) => d });
void createLedger({ goalLimits: { maxChars: 2048 }, archiveLimits: { maxItems: 8 } }).retentionReport();
const endpoint = resolveEndpoint({ provider: 'ollama', model: 'm' });
void endpoint.url;
const client = createChatClient({ provider: 'ollama', model: 'm', fetch: (globalThis.fetch), maxTokens: 3000, maxTokensField: 'max_completion_tokens' });
// @ts-expect-error only Chat Completions token fields are accepted
createChatClient({ maxTokensField: 'max_output_tokens' });
const toolbox = createToolbox();
toolbox.add({
  name: 'echo', description: 'echo', inputSchema: { type: 'object' },
  execute: (input: any) => input,
});
void toolbox.toFunctionTools();
void toolbox.execute('echo', {});
void registerModelContext(toolbox, undefined);
const agent = createAgent({ client, toolbox, system: 'x', maxToolRounds: 3 });
void agent.send([{ role: 'user', content: 'hi' }]);
`,
  '@jarenjs/view': `
import { createDomRenderer } from '@jarenjs/view';
const render = createDomRenderer(({} as any), {
  onEvent: (binding, event) => void [binding, event],
});
render(['p', {}, 'hi']);
render.destroy();
`,
  '@jarenjs/app': `
import { createApp, createTaskEffect, createFocusEffect } from '@jarenjs/app';
const app = createApp({ state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] }, {
  validateState: (next, context) =>
    context.action === null ? true : { valid: next !== undefined },
  maxTurns: 100,
});
void app.getState();
app.observe((tx) => void [tx.seq, tx.action, tx.status, tx.errorCode])();
app.subscribe((state, changes) => void [state, changes])();
app.stop();
app.destroy();
const task = createTaskEffect((props, signal) => ({ echoed: props, aborted: signal.aborted }));
task.cancel();
task.dispose();
const focus = createFocusEffect({ container: ({} as any) });
focus.flush();
focus.dispose();
`,
  '@jarenjs/json': `
import { validateJtltTemplate } from '@jarenjs/json/jtlt';
const jtltValid: boolean = validateJtltTemplate([]).valid;
void jtltValid;
import { compileJsonQuery } from '@jarenjs/json/query';
const q = compileJsonQuery('$.rows[*]', {
  limits: { sequenceItems: 100, resultItems: 10 },
  functions: { double: (n: number) => n * 2 },
  collations: { flipped: (a: string, b: string) => b.localeCompare(a) },
});
const fns: readonly string[] = q.dependencies.functions;
void fns;
void q.explain().limits?.sequenceItems;
void q.first({ rows: [] });
void q.exists({ rows: [] });
void q.ebv({ rows: [1] });
`,
  '@jarenjs/forms': `
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
const model = buildFormModel({ type: 'object', properties: { name: { type: 'string' } } });
const tree = buildFormViewModel(model, { name: 'Jo' }, {
  session: { initial: { name: 'Jo' }, touched: ['/name'], idPrefix: 'consumer' },
});
if (tree !== null && tree.session !== undefined) {
  const dirtyPaths: string[] = tree.session.dirtyPaths;
  void dirtyPaths;
  void (tree.session.errorCount + tree.session.serverErrorCount);
}
`,
  '@jarenjs/locales': `
import { nl, dateMessagesEn, compileDateLocale, RELATIVE_UNITS } from '@jarenjs/locales';
import { createIntlDateLocale } from '@jarenjs/locales/intl-dates';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import {
  compileDateFormat, compileDateParser, parseRFC3339Parts, timeTicksEvery,
} from '@jarenjs/core/dates';
import { resolveClock } from '@jarenjs/core/series';
const dates = compileDateLocale(nl);
const long: (parts: object) => string = compileDateFormat('EEEE d MMMM yyyy', dates.names);
const parts = parseRFC3339Parts('2026-07-05T00:00:00Z');
if (parts !== null) void long(parts);
const read: (text: string) => object | null = compileDateParser('d MMMM yyyy', dates.names);
const back = read('5 juli 2026');
if (back !== null) void long(back);
const ticks: number[] = timeTicksEvery(0, 86400000 * 30, 'week', 1, { weekStart: 7 });
void ticks.length;
const phrase: string = dates.relative(-3, 'day', { numeric: 'auto' });
void phrase.length;
const named: string | undefined = dates.formatName('date-time');
void named;
void createIntlDateLocale('nl-NL').names.months[0];
const zoned = resolveClock({ zone: 'Europe/Amsterdam', provider: createIntlZoneProvider(), disambiguation: 'later' });
const instant: number = zoned.epochOf(zoned.partsAt(0));
void instant;
void Object.keys(dateMessagesEn).length;
void RELATIVE_UNITS.join(',');
`,
  '@jarenjs/mermaid': `
import { parseMermaid, toMermaid, layoutDiagram, renderMermaid } from '@jarenjs/mermaid';
const source = [
  'gantt', 'dateFormat YYYY-MM-DD', 'excludes weekends', 'tickInterval 1week',
  'section Build', 'Design : done, a1, 2024-01-04, 3d',
  'Ship : milestone, m1, after a1, 0d',
].join('\\n');
const doc = parseMermaid(source);
const ast: any = doc.ast;
const task: any = ast.sections[0].tasks[0];
const span: number = task.end - task.start;
void (span > 0 && task.id === 'a1' && task.line === 6);
const flags: string[] = task.flags;
void flags.join(',');
void (ast.rules.tick.unit as string);
void (ast.domain.start as number);
const scene: any = layoutDiagram(doc);
void (scene.kind === 'gantt' && scene.rows.length === 2);
void toMermaid(doc).length;
void renderMermaid(source, { dateNames: undefined })[0];
`,
  '@jarenjs/linq': `
import { from, fromDocument, LinqBuildError, LinqRuntimeError, LINQ_CODES } from '@jarenjs/linq';
import * as m from '@jarenjs/linq/model';
import * as sc from '@jarenjs/linq/schema';
import { defineContract, read, http } from '@jarenjs/linq/contract';
import { defineDag, defineFsm, edge, effect, input, on, output, query, state } from '@jarenjs/linq/flow';
import { action, append, bind, defineApp, transition } from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import { defineMigration } from '@jarenjs/linq/migration';
import { bar as penBar } from '@jarenjs/linq/charts';
import { catalog as messageCatalog, message as messageRef } from '@jarenjs/linq/messages';
messageCatalog('forms').entry('form/required', 'Required').partial();
messageRef('minimum', { params: { limit: 3 } });
import { program as aiProgram } from '@jarenjs/linq/ai';
aiProgram(['data']).select('data', 'result', v => v.get('n').add(1)).answer('result');
const chartKind: 'bar' = penBar().categories(['A']).series([{ name: 'S', values: [1] }]).schema.type;
void chartKind;
import { defineProject, jsonFile } from '@jarenjs/linq/project';
import { stylesheet as textTemplate, rule as textRule } from '@jarenjs/linq/jtlt';
defineProject([jsonFile('template', 'data', textTemplate([textRule(['hi'])]).schema)]).active('template');
import * as fm from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';
const api = defineContract({ id: 'shop' }, {
  'catalog.load': read({ output: sc.object({ revision: sc.integer() }), http: http({ method: 'GET', path: '/api/catalog' }) }),
});
const contract: any = api.document;
void (contract.$contract === '0.1' && Object.keys(contract.operations)[0] === 'catalog.load');
const model = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string() }) } });
const wider = m.defineModel({ entities: { User: m.object({ id: m.string().key(), name: m.string(), city: m.string().optional() }) } });
const step: any = defineMigration({ id: 'add-city', from: model, to: wider }).toJSON();
void (step.$migration === '0.1' && typeof step.from === 'string' && step.from !== step.to);
const opening = open(model, { driver: nodeDriver() });
void opening.then(async (client) => {
  const names: string[] = await client.entities.User.where((u) => u.name.eq('ada')).select((u) => u.name).toArray();
  void names;
  await client.close();
}).catch(() => undefined);
const machine = defineFsm({
  initial: 'draft',
  states: ['draft', state('published', { final: true })],
  transitions: [on('draft', 'publish').when((sc) => sc.payload.get('ok')).to('published').effects([effect('toast')])],
});
void (machine.$fsm === '0.1' && machine.transitions[0].to === 'published');
const graph = defineDag({
  nodes: { rows: input(), adults: query((v) => v.all()), out: output() },
  edges: [edge('rows', 'adults'), edge('adults', 'out')],
});
void (graph.$dag === '0.1' && graph.edges.length === 2);
const todo = defineApp({
  state: sc.object({ todos: sc.array(sc.string()).default([]) }),
  view: [rule('$', (v: any) => ['ul', { on: { click: bind('todo/add', { payload: v.draft }) } }])],
  actions: { 'todo/add': action((st: any, x: any) => transition({ patch: [append((c: any) => c.todos, x.payload)] })) },
});
void (todo.document.$app === '0.1' && (todo.stateSchema as any).type === 'object');
const invoice = fm.object({ vatId: fm.string().form({ assert: (c: any) => c.value.ne(''), message: 'required' }) });
void ((assertOnSubmit(invoice) as any).allOf.length === 1);
const rows = [{ id: 1, name: 'ada' }, { id: 2, name: 'lin' }];
const seq = from(rows).where((r: any) => r.id.gt(1)).select((r: any) => ({ n: r.name }));
const doc: unknown = seq.toDocument();
void doc;
const out: any[] = seq.toArray();
void out.length;
void from(rows).count();
void fromDocument(rows, '$[*].name').toArray();
const codes: Readonly<Record<string, string>> = LINQ_CODES;
void codes.JL0001;
void (LinqBuildError.name === 'LinqBuildError' && LinqRuntimeError.name === 'LinqRuntimeError');
`,
  '@jarenjs/flow': `
import { compileFsm, createFsmSession, fsmToApp, fsmStateSchema, compileDag, compileStatechart, createStatechartSession, compileWorkflow } from '@jarenjs/flow';
import type { StatechartResult, WorkflowResult } from '@jarenjs/flow';
const fsm = compileFsm({
  initial: 'a',
  states: ['a', { id: 'b', final: true }],
  transitions: [{ from: 'a', event: 'go', guard: '$.payload.ok', to: 'b' }],
});
const states: readonly string[] = fsm.states;
void states;
const result = fsm.step('a', 'go', { payload: { ok: true } });
void (result.changed && result.final);
const errors: { code: string, docPath: string }[] = result.errors;
void errors;
const session = createFsmSession(fsm);
void (session.can('go') && session.send('go').state === session.state && session.done);
const hosted = fsmToApp({ initial: 'a', states: ['a'], transitions: [{ from: 'a', event: 'go', to: 'a' }] });
const hostedEvents: string[] = hosted.events;
void [hostedEvents, hosted.slice.current, hosted.actions['fsm/go']];
void fsmStateSchema({ initial: 'a', states: ['a'], transitions: [] }).properties.current.enum;
const dag = compileDag({
  $dag: '0.1',
  nodes: { i: { kind: 'input' }, o: { kind: 'output' } },
  edges: [{ from: 'i', to: 'o' }],
});
const dagNodes: readonly string[] = dag.nodes;
void [dagNodes, dag.output];
void dag.run(1, { onNode: (rec) => void (rec.id + rec.status + rec.ms) }).then((v) => v);
const chart = compileStatechart({ $fsm: '0.2', initial: 'done', states: [{ id: 'done', final: true }], transitions: [] });
const chartResult: StatechartResult = createStatechartSession(chart).advance(1);
void chartResult.state.active;
const workflow = compileWorkflow({ $workflow: '0.2', revision: '1', initial: 'done', states: { done: { final: true } } });
workflow.run(null, { runId: 'packed' }).then((r: WorkflowResult) => { const s: 'waiting'|'done' = r.status; void s; });
`,
  '@jarenjs/contract': `
import {
  compileContract, ContractCompileError, ContractRuntimeError, ContractHostError, ContractFailure, isContractFailure,
  CONTRACT_CODES, contractMessagesEn, contractCatalogEn,
} from '@jarenjs/contract';
import { serveHttp, HTTP_ERRORS, WELL_KNOWN_PATH } from '@jarenjs/contract/http';
import type { HttpResponse, RequestContext } from '@jarenjs/contract/http';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { toNodeHandler } from '@jarenjs/contract/node';
import { createMemoryLedger, idempotencyLedgerModel, commandLifecycleFsm } from '@jarenjs/contract/ledger';
import { openHttpClient, CLIENT_ERRORS } from '@jarenjs/contract/client';
import type { Outcome, HttpClient } from '@jarenjs/contract/client';
import { openLocalClient, serveLocal, PORT_LOCAL_ERRORS } from '@jarenjs/contract/local';
import type { LocalClient } from '@jarenjs/contract/local';
import { servePort, openPortClient, FRAME_MARKER } from '@jarenjs/contract/port';
import type { PortServer, ChannelLike } from '@jarenjs/contract/port';
import { contractAppBinding, createContractEffect, createContractSubscription } from '@jarenjs/contract/app';
import { runSubscription, isSubscriptionLike, STREAM_ERRORS, STREAM_EVENTS, encodeStreamEvent } from '@jarenjs/contract/stream';
import type { SubscriptionLike, StreamHooks } from '@jarenjs/contract/stream';
import { diffContracts, isCompatible, compatReason } from '@jarenjs/contract/diff';
import { publicProjection, toOpenApi, toTypeScript, toMarkdown, contractTools } from '@jarenjs/contract/project';
import type { OpenApiResult, ToolDefinition } from '@jarenjs/contract/project';
const contract = compileContract({
  $contract: '0.1',
  operations: {
    'thing.get': {
      kind: 'read',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      output: { type: 'object' },
      http: { method: 'GET', path: '/things/{id}' },
    },
    'thing.feed': {
      kind: 'subscribe',
      output: { type: 'object', required: ['rows'], properties: { rows: { type: 'array' } } },
      policy: { stream: { resume: 'replay', heartbeatMs: 2000 } },
    },
  },
});
const ids: readonly string[] = contract.ids;
void ids;
const hit = contract.match('GET', '/things/12');
void (hit === null ? null : [hit.op.id, hit.params.id]);
const op = contract.operations['thing.get'];
void [op.http.method, op.http.path, op.http.in.id, op.policy.task, op.output.validate({})];
void (op.input === null ? null : [op.input.validate({ id: 1 }), op.input.transport?.normalize({ id: '1' })]);
const described = contract.describe();
void described.operations[0].inferred.http;
const codes: Readonly<Record<string, string>> = CONTRACT_CODES;
void codes.JC0001;
void (ContractCompileError.name === 'ContractCompileError' && ContractRuntimeError.name === 'ContractRuntimeError');
void contract.allowed('/things/12');
const failure = ContractFailure('gone', { id: 1 }, { at: 1 }, { retryable: false });
void [failure.code, isContractFailure(failure), ContractHostError.name, contractMessagesEn['contract/not-found'], contractCatalogEn];
const feed: SubscriptionLike = { result: { rows: [] }, subscribe: () => () => {}, close: () => {} };
void [isSubscriptionLike(feed), runSubscription, STREAM_ERRORS.JC2094.retryable, STREAM_EVENTS.length, encodeStreamEvent('end', 1, { reason: 'closed' })];
const hooks: StreamHooks | null = null;
void hooks;
const server = serveHttp(contract, {
  'thing.get': (input: any, ctx: RequestContext) => { ctx.etag('t1'); return input === null ? ctx.fail('gone') : { id: input.id, trace: ctx.trace }; },
  'thing.feed': () => feed,
}, { ledger: createMemoryLedger(), head: true, validateOutput: 'always', onError: (err: unknown) => void err });
const responded: Promise<HttpResponse> = server.dispatch({ method: 'GET', url: '/things/12', headers: {}, body: null });
void [responded, server.capabilities.idempotency, server.capabilities.stream, server.contract.ids, server.describe(), HTTP_ERRORS.JC2001.status, WELL_KNOWN_PATH];
const onFetch: (request: Request) => Promise<Response> = toFetchHandler(server);
void onFetch;
const onNode = toNodeHandler(server);
void onNode;
void [idempotencyLedgerModel.$model, commandLifecycleFsm.$fsm];
const client: HttpClient = openHttpClient(contract, { baseUrl: 'http://x', timeoutMs: 100, fetch: toFetchHandler(server) as any });
const outcome: Promise<Outcome> = client.invoke('thing.get', { id: 12 }, { attempt: 1 });
void [outcome, client.url('thing.get', { id: 1 }), client.negotiate(), client.pending(), client.capabilities.durableKeys, CLIENT_ERRORS.JC2051.retryable];
const local: LocalClient = openLocalClient(contract, { 'thing.get': (input: any) => ({ id: input.id }) }, { validateOutput: 'always' });
void [serveLocal === openLocalClient, local.capabilities.status === false, local.capabilities.cancel, local.invoke('thing.get', { id: 1 }, { attempt: 2 }), local.close];
const channel: ChannelLike = { postMessage: (m: unknown) => void m, addEventListener: () => {}, removeEventListener: () => {} };
const ported: PortServer = servePort(contract, { 'thing.get': (input: any) => ({ id: input.id }), 'thing.feed': () => feed }, { channel });
void [ported.capabilities.cancel === 'message', ported.close, FRAME_MARKER === 'contract/0.1', PORT_LOCAL_ERRORS.JC2072.retryable];
const portClient = openPortClient(contract, { channel, timeoutMs: 50 });
const portOutcome: Promise<Outcome> = portClient.invoke('thing.get', { id: 1 });
void [portOutcome, portClient.capabilities.status === false, portClient.capabilities.stream === true, portClient.close];
const portStream = portClient.subscribe('thing.feed', null, { onSnapshot: (value, info) => void [value, info.seq, info.resumed], onEnd: (e) => void e.reason });
void portStream.stop;
const httpStream = client.subscribe('thing.feed', null, { onPatch: (emission) => void [emission.patch, emission.seq], lastSeq: 4 });
void httpStream.stop;
const binding = contractAppBinding(contract, { namespace: 'api/', statePath: '/api' });
void [binding.slice['thing.get'].status, binding.actions['api/thing.get/start'], binding.subs.length, binding.schema, binding.effect, binding.subscription];
const streamHandler = createContractSubscription(portClient);
void streamHandler;
const effect = createContractEffect(client, { createTaskEffect: (run, opts) => Object.assign((p: any, d: any) => void [run, opts, p, d], { cancel() {}, cancelAll() {}, dispose() {} }) });
void [effect.cancel, effect.dispose];
const projected = publicProjection(contract);
void compileContract(projected);
const changes = diffContracts(projected, projected);
void [changes.breaking.length, changes.additive.length, changes.neutral.length, changes.unknown.length,
  isCompatible(projected, projected), compatReason(projected, projected)];
const openapi: OpenApiResult = toOpenApi(contract, { info: { title: 'Things', version: '1' } });
void [openapi.document, openapi.dropped.length];
void [toTypeScript(contract).length, toMarkdown(contract).length];
const tools: ToolDefinition[] = contractTools(contract, client);
void [tools[0]?.name, tools[0]?.inputSchema];
client.close();
`,
  '@jarenjs/db': `
import { openStore, normalizeModel, sqliteDialect, createDialect, DB_CODES, DbCompileError, DbRuntimeError, SQLITE_FLOOR } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { wasmDriver, indexedDbSnapshotHandle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver, type WorkerMetrics } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver, type PoolMetrics } from '@jarenjs/db/node-pool';
async function hosts() {
  const worker = await nodeWorkerDriver({ windowRows: 3 }).open();
  const metrics: WorkerMetrics = worker.metrics();
  const pool = await nodeWorkerPoolDriver({ readers: 0 }).open();
  const pooled: PoolMetrics = pool.metrics();
  await pool.close();
  await worker.close();
  return [metrics.generation, pooled.queued];
}
void [hosts, indexedDbSnapshotHandle];
const model = { $model: '0.1', collections: { users: { schema: { type: 'object' }, key: '/id', indexes: [] } } };
void normalizeModel(model).size;
const driver = nodeDriver();
void (driver.name === 'node-sqlite' && bunDriver().name === 'bun-sqlite');
void wasmDriver;
const opening: Promise<any> = openStore(model, { driver });
void opening.catch(() => undefined);
void sqliteDialect.quoteIdentifier('users');
void createDialect;
const codes: Readonly<Record<string, string>> = DB_CODES;
void codes.JD0001;
void (DbCompileError.name === 'DbCompileError' && DbRuntimeError.name === 'DbRuntimeError');
void SQLITE_FLOOR.length;
`,
};

// lockfile hygiene is release evidence: an extraneous record means the
// lock describes a workspace that no longer exists, and a release
// reported from a stale lock is not evidence of the tree being shipped
{
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const extraneous = Object.entries(lock.packages ?? {})
    .filter(([, entry]) => entry.extraneous === true)
    .map(([key]) => key);
  if (extraneous.length > 0) {
    console.error(`extraneous package-lock records: ${extraneous.join(', ')} — run npm install and commit the pruned lock.`);
    process.exit(1);
  }
}

const packages = publishableWorkspaces();
const byName = new Map(packages.map((entry) => [entry.name, entry]));
const work = mkdtempSync(join(tmpdir(), 'jaren-packed-'));
let failures = 0;

try {
  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir);

  console.log(`Packing ${packages.length} packages...`);
  /** @type {Map<string, string>} package name → tarball path */
  const tarballs = new Map();
  for (const { dir, name } of packages) {
    const out = npm(['pack', '--silent', '--pack-destination', tarballDir], join(root, dir))
      .trim().split('\n').pop();
    tarballs.set(name, join(tarballDir, /** @type {string} */ (out)));
  }

  for (const { name, pkg, dir } of packages) {
    const consumerDir = join(work, name.replace('/', '__'));
    const modulesDir = join(consumerDir, 'node_modules');
    mkdirSync(modulesDir, { recursive: true });
    writeFileSync(join(consumerDir, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

    // install ONLY the declared closure, from the packed tarballs
    const installed = new Set();
    const install = (dep) => {
      if (installed.has(dep)) return;
      installed.add(dep);
      const dest = join(modulesDir, dep);
      mkdirSync(dest, { recursive: true });
      // Extraction is relative to ONE working directory: the tarball and
      // the destination both live below `work`, so tar runs with
      // `cwd: work` and plain relative forward-slash arguments. No
      // argument carries a Windows drive colon (which GNU tar reads as
      // `host:file`), so no brand detection and no brand-specific flag —
      // the GNU-only force-local spelling is refused by the bsdtar
      // Windows ships, before it extracts anything.
      execFileSync('tar',
        tarExtractArgs(work, /** @type {string} */ (tarballs.get(dep)), dest),
        { cwd: work });
    };
    for (const dep of declaredClosure(byName, name)) install(dep);

    const subpaths = importSubpaths(pkg, join(root, dir));
    const peers = declaredPeers(pkg);
    /** @type {{ subpath: string, peer: string }[]} */
    const needing = [];
    if (peers.length > 0) {
      // the peer rule, made visible: without the peers every failing
      // subpath fails by a declared peer's NAME and nothing else
      let broken = false;
      for (const [i, subpath] of subpaths.entries()) {
        const probeFile = join(consumerDir, `probe-${i}.mjs`);
        writeFileSync(probeFile, `await import(${JSON.stringify(subpath)});\n`);
        const probe = spawnSync(process.execPath, [probeFile], { cwd: consumerDir, encoding: 'utf8' });
        if (probe.status === 0) continue;
        const named = peers.find((peer) => probe.stderr.includes(`'${peer}'`));
        if (!probe.stderr.includes('ERR_MODULE_NOT_FOUND') || named === undefined) {
          failures++;
          console.error(`✗ ${name} (peers): ${subpath} fails without the optional peers for a reason `
            + `other than a missing peer: ${probe.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
          broken = true;
          break;
        }
        needing.push({ subpath, peer: named });
      }
      if (broken) continue;
      if (needing.length === 0) {
        failures++;
        console.error(`✗ ${name} (peers): declares optional peers (${peers.join(', ')}) that no export subpath needs`);
        continue;
      }
      if (needing.length === subpaths.length) {
        failures++;
        console.error(`✗ ${name} (peers): every export subpath needs the optional peers — they are dependencies in disguise`);
        continue;
      }
      // then the peers, with their own closures, like dependencies
      for (const peer of peers) {
        for (const dep of declaredClosure(byName, peer)) install(dep);
      }
    }
    let program = subpaths.map((s) => `await import(${JSON.stringify(s)});`).join('\n') + '\n';
    if (name === '@jarenjs/json') program += `
const { compileJsonQuery, createQueryAccumulator } = await import('@jarenjs/json/query');
const state = createQueryAccumulator('$sum');
for (const item of compileJsonQuery('$[*]').items([1e16, 1, -1e16, 1])) state.add(item);
if (state.value() !== 1) throw new Error('packed ordered accumulator changed addition order');
for (const suffix of ['schema', 'draft-07.schema']) {
  const { default: grammar } = await import('@jarenjs/json/schemas/jaren-jtlt.' + suffix + '.json', { with: { type: 'json' } });
  if (!grammar.$id.includes('jaren-jtlt/0.1')) throw new Error('Packed JTLT grammar is missing its version');
}
`;
    if (name === '@jarenjs/flow') program += `
const { compileStatechart, compileWorkflow } = await import('@jarenjs/flow');
const chart = compileStatechart({ $fsm: '0.2', initial: 'done', states: [{ id: 'done', final: true }], transitions: [] });
if (!chart.start().final) throw new Error('Packed statechart did not complete');
const workflow = compileWorkflow({ $workflow: '0.2', revision: '1', initial: 'done', states: { done: { final: true } } });
if ((await workflow.run(42, { runId: 'packed' })).result !== 42) throw new Error('Packed workflow changed its result');
for (const name of ['statechart', 'statechart-state', 'workflow']) {
  for (const suffix of ['schema', 'draft-07.schema', ...(name === 'statechart-state' ? [] : ['authoring.schema'])]) {
    const { default: grammar } = await import('@jarenjs/flow/schemas/jaren-' + name + '.' + suffix + '.json', { with: { type: 'json' } });
    if (!grammar.$id.includes('/0.2')) throw new Error('Packed flow grammar is missing its version');
  }
}
`;
    if (name === '@jarenjs/db') program += `
const { openStore } = await import('@jarenjs/db');
const { readCollectionBundle } = await import('@jarenjs/db/node');
const bundle = await readCollectionBundle((async function* () {
  yield new TextEncoder().encode('{"users":[{"id":"u"}],"events":[]}');
})(), { maxBytes: 1024, maxRows: 10 });
if (bundle.users[0].id !== 'u' || bundle.events.length !== 0) throw new Error('packed collection bundle mismatch');
const { nodeWorkerDriver } = await import('@jarenjs/db/node-worker');
const { nodeWorkerPoolDriver } = await import('@jarenjs/db/node-pool');
for (const driver of [nodeWorkerDriver(), nodeWorkerPoolDriver({ readers: 0 })]) {
  try {
    const store = await openStore({ $model: '0.1', collections: {
      notes: { key: '/id', schema: { type: 'object' } }
    } }, { driver, replication: { replica: 'packed-worker' } });
    try {
      await store.collection('notes').insert({ id: 'packed', value: 7 });
      if ((await store.collection('notes').get('packed')).value !== 7) throw new Error('packed worker data mismatch');
      const page = await store.replication.page();
      if (page.items.length !== 1 || page.items[0].replica !== 'packed-worker') throw new Error('packed replication mismatch');
      const snapshot = await store.replication.snapshot();
      if (snapshot.receipts.length !== 1) throw new Error('packed snapshot receipt mismatch');
    } finally { await store.close(); }
  } catch (error) {
    if (!(typeof Bun !== 'undefined' && error.code === 'JD0003')) throw error;
  }
}
`;
    // the runtime consumer is a real program FILE: `-e` strings are not
    // portable (a Windows shell reparses multiline programs)
    if (name === '@jarenjs/db' || name === '@jarenjs/linq') {
      const manifest = JSON.parse(readFileSync(join(root, 'test/adoption/manifest.json'), 'utf8'));
      writeFileSync(join(consumerDir, 'adoption.js'), readFileSync(join(root, name === '@jarenjs/linq' ? 'test/consumer/relational.js' : 'test/consumer/adoption.js')));
      writeFileSync(join(consumerDir, 'adoption-relational.json'), readFileSync(join(root, 'test/adoption/fixtures/relational.json')));
      writeFileSync(join(consumerDir, 'adoption-consumers.json'), JSON.stringify(manifest.consumers.map((definition) => ({
        definition, rows: adoptionRows(definition),
        expected: { protectedRows: Math.ceil(definition.rows / definition.policy.protectedEvery) },
      }))));
      program += "await import('./adoption.js');\n";
      if (name === '@jarenjs/linq') {
        writeFileSync(join(consumerDir, 'query-native.js'), readFileSync(join(root, 'test/consumer/query-native.js')));
        writeFileSync(join(consumerDir, 'adoption-sql.json'), readFileSync(join(root, 'test/db/fixtures/adoption-sql.json')));
        program += "await import('./query-native.js');\n";
      }
    }
    if (name === '@jarenjs/core') {
      const manifest = JSON.parse(readFileSync(join(root, 'test/adoption/manifest.json'), 'utf8'));
      writeFileSync(join(consumerDir, 'lexical.js'), readFileSync(join(root, 'test/consumer/lexical.js')));
      writeFileSync(join(consumerDir, 'lexical-fixture.json'), readFileSync(join(root, 'test/adoption/fixtures/search.json')));
      writeFileSync(join(consumerDir, 'lexical-consumers.json'), JSON.stringify(manifest.consumers.map((definition) => ({ definition, rows: adoptionRows(definition) }))));
      program += "await import('./lexical.js');\n";
    }
    if (name === '@jarenjs/collection') {
      writeFileSync(join(consumerDir, 'collection.js'), readFileSync(join(root, 'test/consumer/collection.js')));
      writeFileSync(join(consumerDir, 'collection-grid.json'), readFileSync(join(root, 'test/adoption/fixtures/grid.json')));
      program += "await import('./collection.js');\n";
    }
    const programFile = join(consumerDir, 'consumer.mjs');
    writeFileSync(programFile, program);

    const node = spawnSync(process.execPath, [programFile],
      { cwd: consumerDir, encoding: 'utf8' });
    if (node.status !== 0) {
      failures++;
      console.error(`✗ ${name} (node): ${node.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
      continue;
    }

    // strict TypeScript consumer against the PACKED declarations: every
    // explicit JS subpath must resolve a declaration from the tarball,
    // and the key public APIs are exercised in value positions
    writeFileSync(join(consumerDir, 'consumer.ts'),
      subpaths.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};\nvoid m${i};`).join('\n')
      + '\n' + (SEMANTIC_SNIPPETS[name] ?? ''));
    writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        noEmit: true, strict: true, skipLibCheck: false,
        module: 'nodenext', moduleResolution: 'nodenext',
        target: 'esnext', lib: ['esnext', 'dom'],
      },
      files: ['consumer.ts'],
    }));
    const tsc = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', consumerDir],
      { cwd: consumerDir, encoding: 'utf8' });
    if (tsc.status !== 0) {
      failures++;
      console.error(`✗ ${name} (types): ${tsc.stdout.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
      continue;
    }

    if (bun) {
      const bunRun = spawnSync('bun', [programFile],
        { cwd: consumerDir, encoding: 'utf8' });
      if (bunRun.status !== 0) {
        failures++;
        console.error(`✗ ${name} (bun): ${bunRun.stderr.split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
        continue;
      }
    }

    // the isolated Vite leg (browser-bundler evidence) runs on the app
    // package: Vite must resolve the packed export maps from the
    // declared closure alone and bundle a library build cleanly
    if (name === '@jarenjs/app') {
      writeFileSync(join(consumerDir, 'consumer-vite.js'),
        subpaths.map((s) => `export * from ${JSON.stringify(s)};`).join('\n') + '\n');
      writeFileSync(join(consumerDir, 'vite.config.mjs'), [
        'export default {',
        "  logLevel: 'error',",
        '  build: {',
        "    lib: { entry: 'consumer-vite.js', formats: ['es'], fileName: 'consumer-bundle' },",
        '    minify: false,',
        '  },',
        '};',
        '',
      ].join('\n'));
      const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
      if (!existsSync(viteBin)) {
        failures++;
        console.error(`✗ ${name} (vite): vite is not installed at the workspace root (npm ci first)`);
        continue;
      }
      const vite = spawnSync(process.execPath, [viteBin, 'build'],
        { cwd: consumerDir, encoding: 'utf8' });
      const bundle = join(consumerDir, 'dist', 'consumer-bundle.js');
      if (vite.status !== 0 || !existsSync(bundle)) {
        failures++;
        console.error(`✗ ${name} (vite): ${(vite.stderr + vite.stdout).split('\n').find((l) => l.trim() !== '') ?? 'failed'}`);
        continue;
      }
    }

    const peerNote = peers.length === 0 ? ''
      : ` + ${peers.length} optional peer(s) needed by ${[...new Set(needing.map((n) => n.subpath))].join(', ')}`;
    console.log(`✓ ${name} — ${subpaths.length} subpath(s), closure of ${declaredClosure(byName, name).size} package(s)${peerNote}, node+types${bun ? '+bun' : ''}${name === '@jarenjs/app' ? '+vite' : ''}`);
  }
  // Independent composition consumer; the per-package closure proofs above
  // remain isolated. This application explicitly installs each participating owner.
  const compositionDir = join(work, 'provider-composition');
  mkdirSync(compositionDir, { recursive: true });
  writeFileSync(join(compositionDir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  const compositionPackages = new Set();
  for (const name of ['@jarenjs/contract', '@jarenjs/flow', '@jarenjs/linq', '@jarenjs/db', '@jarenjs/validate', '@jarenjs/formats', '@jarenjs/app', '@jarenjs/rules'])
    for (const dep of declaredClosure(byName, name)) compositionPackages.add(dep);
  for (const dep of compositionPackages) {
    const dest = join(compositionDir, 'node_modules', dep);
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', tarExtractArgs(work, tarballs.get(dep), dest), { cwd: work });
  }
  const manifest = JSON.parse(readFileSync(join(root, 'test/adoption/manifest.json'), 'utf8'));
  writeFileSync(join(compositionDir, 'providers.js'), readFileSync(join(root, 'test/consumer/providers.js')));
  const compositionFile = join(compositionDir, 'consumer.mjs');
  writeFileSync(compositionFile, "import { qualifyDialects, runIngestionConsumer } from './providers.js';\n"
    + `await qualifyDialects(${readFileSync(join(root, 'test/adoption/fixtures/providers.json'), 'utf8')}, ${readFileSync(join(root, 'test/contract/fixtures/provider-descriptors.json'), 'utf8')});\n`
    + manifest.consumers.map((definition) => `await runIngestionConsumer(${JSON.stringify(definition)}, ${JSON.stringify(adoptionRows(definition).slice(0, definition.budgets.providers.rows))});`).join('\n'));
  writeFileSync(join(compositionDir, 'durable.js'), readFileSync(join(root, 'test/consumer/durable.js')));
  const durableManifest = JSON.parse(readFileSync(join(root, 'test/durable/manifest.json'), 'utf8'));
  const durableFile = join(compositionDir, 'durable-consumer.mjs');
  writeFileSync(durableFile, "import { runDurableConsumer, runPhysicalReceiptConsumer } from './durable.js';\nawait runPhysicalReceiptConsumer();\n" + durableManifest.cases.map((count) => `await runDurableConsumer(${count}, ${JSON.stringify(durableManifest.limits)});`).join('\n'));
  writeFileSync(join(compositionDir, 'formulas.js'), readFileSync(join(root, 'test/consumer/formulas.js')));
  writeFileSync(join(compositionDir, 'formula-host.js'), readFileSync(join(root, 'packages/website/src/examples/reviewed-rules.js')));
  const formulaFile = join(compositionDir, 'formula-consumer.mjs');
  writeFileSync(formulaFile, "import { qualifyFormulaSources, runFormulaConsumer, qualifyRuleCommand } from './formulas.js';\nimport { openRuleExample, savedRule } from './formula-host.js';\n"
    + `await qualifyFormulaSources(${readFileSync(join(root, 'test/adoption/fixtures/formulas.json'), 'utf8')}.formulas);\n`
    + manifest.consumers.map((definition) => `runFormulaConsumer(${JSON.stringify(definition)}, ${JSON.stringify(adoptionRows(definition))});`).join('\n')
    + "\nawait qualifyRuleCommand(openRuleExample, savedRule);\n");
  for (const runtime of [process.execPath, ...(bun ? ['bun'] : [])]) {
    const formulaResult = spawnSync(runtime, [formulaFile], { cwd: compositionDir, encoding: 'utf8' });
    if (formulaResult.status !== 0) { failures++; console.error(`Formula composition (${runtime}): ${formulaResult.stderr}`); }
    else console.log(`✓ formula composition — preserved sources, two workloads, reviewed command replay (${runtime})`);
    const result = spawnSync(runtime, [compositionFile], { cwd: compositionDir, encoding: 'utf8' });
    if (result.status !== 0) { failures++; console.error(`Provider composition (${runtime}): ${result.stderr}`); }
    else console.log(`✓ provider composition — three dialects, two consumers, zero-write replay (${runtime})`);
    const durableResult = spawnSync(runtime, [durableFile], { cwd: compositionDir, encoding: 'utf8' });
    if (durableResult.status !== 0) { failures++; console.error(`Durable composition (${runtime}): ${durableResult.stderr}`); }
    else console.log(`✓ durable composition — receipts, reconciliation, runs, bounded observation (${runtime})`);
  }
}
finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} package(s) failed the packed-consumer gate.`);
  process.exit(1);
}
console.log('\nEvery explicit JavaScript export key of every packed package imports and '
  + `type-checks from its declared closure${bun ? ', under Node and Bun' : ' (Bun leg skipped)'}; `
  + 'the @jarenjs/app closure bundles under an isolated Vite build.');
