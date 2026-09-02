// @jarenjs/linq/contract — the type half of the contract pen's agreement.
//
// For every worked example the pen's `ContractOf<>` is proven EQUAL (not
// merely assignable) to what `@jarenjs/contract`'s TypeScript projection
// declares for the document the pen emitted, and the fixed outcome
// shapes (§10.1, rendered by §12.3) are pinned member for member. The
// contracts are the corpus's own exports (allowJs), so the runtime gate
// and this file read the same objects. The runtime twins live in
// test/linq/contract-pen.test.js.
import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { contractTools } from '@jarenjs/contract/project';
import type {
  ByteContext, ByteResponse, ContractOf, Failure, HandlerContext, InvokableOf, InvokeContext, Meta,
  OpaqueOf, Outcome, SnapshotInfo, SubscribableOf, TypedClient, TypedHttpClient, TypedTool, WireError,
} from '@jarenjs/linq/contract';
import { typedClient, typedHttpClient, typedHandlers, typedTools } from '@jarenjs/linq/contract';
import { openHttpClient } from '@jarenjs/contract/client';
import { command, defineContract, error, http, read, subscribe } from '@jarenjs/linq/contract';
import * as s from '@jarenjs/linq/schema';
import type { DateTime } from '@jarenjs/linq';
import type * as G from './linq-contract-generated.js';
import { Docs, Health, Shop } from '../linq/contract-corpus.js';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ——— §2 shop: every operation's input, output and error codes ———
type ShopOps = ContractOf<typeof Shop>;

// A date-formatted string is the `DateTime` brand on both sides — the
// suite's one reading of `format: "date-time"`, which @jarenjs/db's
// generated entity types, the schema pen and §12.3's projection all
// share — so this input is strictly equal like every other.
const catalogLoadInput: Equals<ShopOps['catalog.load']['input'], G.Shop.CatalogLoadInput> = true;
const catalogLoadSince: Equals<ShopOps['catalog.load']['input']['since'], DateTime | undefined> = true;
const catalogLoadOutput: Equals<ShopOps['catalog.load']['output'], G.Shop.CatalogLoadOutput> = true;
const catalogLoadErrors: Equals<ShopOps['catalog.load']['errors'], 'stale'> = true;
const catalogLoadKind: Equals<ShopOps['catalog.load']['kind'], 'read'> = true;

const productSaveInput: Equals<ShopOps['product.save']['input'], G.Shop.ProductSaveInput> = true;
const productSaveOutput: Equals<ShopOps['product.save']['output'], G.Shop.ProductSaveOutput> = true;
const productSaveErrors: Equals<ShopOps['product.save']['errors'], 'conflict' | 'not-found'> = true;
const productSaveKind: Equals<ShopOps['product.save']['kind'], 'command'> = true;

const imageBytesInput: Equals<ShopOps['image.bytes']['input'], G.Shop.ImageBytesInput> = true;
const imageBytesOutput: Equals<ShopOps['image.bytes']['output'], G.Shop.ImageBytesOutput> = true;

// the projection's `Operations` is the invokable set: the opaque
// operation is out of it, and in `UrlOperations` only
const shopInvokable: Equals<keyof InvokableOf<typeof Shop>, keyof G.Shop.Operations> = true;
const shopUrl: Equals<keyof ShopOps, keyof G.Shop.UrlOperations> = true;
// the projection's `ByteOperations` is the opaque set, exactly `OpaqueOf<>`
const shopOpaque: Equals<keyof OpaqueOf<typeof Shop>, keyof G.Shop.ByteOperations> = true;
const shopOpaqueInput: Equals<OpaqueOf<typeof Shop>['image.bytes']['input'], G.Shop.ByteOperations['image.bytes']> = true;
const imageIsOpaque: Equals<ShopOps['image.bytes']['opaque'], true> = true;
const productIsNotOpaque: Equals<ShopOps['product.save']['opaque'], false> = true;

// ——— §6 health: an input-less operation reads `null` ———
type HealthOps = ContractOf<typeof Health>;
const healthInput: Equals<HealthOps['health.check']['input'], null> = true;
const healthOutput: Equals<HealthOps['health.check']['output'], G.Health.HealthCheckOutput> = true;
const healthErrors: Equals<HealthOps['health.check']['errors'], never> = true;

// ——— §6 docs: a boolean output widens exactly as the projection does ———
type DocsOps = ContractOf<typeof Docs>;
const docPutInput: Equals<DocsOps['doc.put']['input'], G.Docs.DocPutInput> = true;
const docPutOutput: Equals<DocsOps['doc.put']['output'], G.Docs.DocPutOutput> = true;
const docRemoveInput: Equals<DocsOps['doc.remove']['input'], G.Docs.DocRemoveInput> = true;
const docRemoveOutput: Equals<DocsOps['doc.remove']['output'], G.Docs.DocRemoveOutput> = true;

// ——— the fixed shapes of §10.1, as §12.3 renders them ———
const metaShape: Equals<Meta, G.Shop.Meta> = true;
const wireErrorShape: Equals<WireError, G.Shop.WireError> = true;
const outcomeShape: Equals<Outcome<G.Shop.Product>, G.Shop.Outcome<G.Shop.Product>> = true;
const invokeCtxShape: Equals<InvokeContext, G.Shop.InvokeContext> = true;
const failureShape: Equals<Failure, G.Shop.Failure> = true;
const handlerCtxShape: Equals<HandlerContext, G.Shop.HandlerContext> = true;
const byteCtxShape: Equals<ByteContext, G.Shop.ByteContext> = true;
const byteResponseShape: Equals<ByteResponse, G.Shop.ByteResponse> = true;

void [
  shopOpaque, shopOpaqueInput, byteCtxShape, byteResponseShape,
  catalogLoadInput, catalogLoadSince, catalogLoadOutput, catalogLoadErrors, catalogLoadKind,
  productSaveInput, productSaveOutput, productSaveErrors, productSaveKind,
  imageBytesInput, imageBytesOutput, shopInvokable, shopUrl, imageIsOpaque,
  productIsNotOpaque, healthInput, healthOutput, healthErrors, docPutInput,
  docPutOutput, docRemoveInput, docRemoveOutput, metaShape, wireErrorShape,
  outcomeShape, invokeCtxShape, failureShape, handlerCtxShape,
];

// ——— typedClient: the outcome's value is the declared output ———
const compiled = compileContract(Shop.document);
const handlers = typedHandlers(Shop, {
  'catalog.load': () => ({ revision: 1, products: [] }),
  'product.save': (input) => input.product,
});
const api = typedClient(openLocalClient(compiled, handlers), Shop);

async function roundTrip(): Promise<void> {
  const outcome = await api.invoke('product.save', {
    id: 1, revision: 4, product: { id: 1, name: 'a', price: 1 },
  });
  if (outcome.ok) {
    const name: string = outcome.value.name;
    const price: number = outcome.value.price;
    void [name, price];
  }
  else {
    const code: string = outcome.error.code;
    const status: number | null = outcome.error.status;
    void [code, status];
  }
  // an opaque operation is not invokable; it is a URL builder
  const href: string = api.url('image.bytes', { id: 3 });
  void href;
}
void roundTrip;

// a misspelled operation id
// @ts-expect-error — 'product.saev' is not an operation of this contract
void api.invoke('product.saev', { id: 1, revision: 4, product: { id: 1, name: 'a', price: 1 } });
// a wrong input member
// @ts-expect-error — 'rev' is not a member of ProductSaveInput ('revision' is)
void api.invoke('product.save', { id: 1, rev: 4, product: { id: 1, name: 'a', price: 1 } });
// an opaque operation carries bytes, so it is not invokable
// @ts-expect-error — 'image.bytes' is opaque: reach it through url()
void api.invoke('image.bytes', { id: 3 });

// ——— typedHttpClient: bytes over the opaque operations only ———
const httpApi: TypedHttpClient<typeof Shop> = typedHttpClient(openHttpClient(compiled, { baseUrl: 'http://x' }), Shop);
async function byteTrip(): Promise<void> {
  const bytes = await httpApi.bytes('image.bytes', { id: 3 }, { body: null, headers: { accept: 'image/png' } });
  if (bytes.ok) {
    const status: number = bytes.value.status;
    const media: string | null = bytes.value.media;
    const body: ReadableStream<Uint8Array> | null = bytes.value.body;
    const etag: string | null = bytes.meta.etag;
    void [status, media, body, etag];
  }
  // the typed HTTP client is still the typed client: invoke and url are there
  const saved = await httpApi.invoke('product.save', { id: 1, revision: 4, product: { id: 1, name: 'a', price: 1 } });
  void [saved.ok, httpApi.url('image.bytes', { id: 3 })];
}
void byteTrip;
// @ts-expect-error — 'product.save' is a JSON operation: bytes carries opaque operations only
void httpApi.bytes('product.save', { id: 1, revision: 4, product: { id: 1, name: 'a', price: 1 } });
// @ts-expect-error — a wrong input member on the opaque operation
void httpApi.bytes('image.bytes', { identifier: 3 });
// @ts-expect-error — the body must be text, bytes, a stream, an async iterable or null
void httpApi.bytes('image.bytes', { id: 3 }, { body: 42 });
// a local client is a TypedClient and needs no byte method: the narrower wrapper still types it
const localTyped: TypedClient<typeof Shop> = api;
void localTyped;
// @ts-expect-error — a TypedClient has no bytes: only the HTTP wrapper declares it
void api.bytes('image.bytes', { id: 3 });

// a handler table missing an operation
// @ts-expect-error — 'product.save' has no handler
const shortHandlers = typedHandlers(Shop, { 'catalog.load': () => ({ revision: 1, products: [] }) });
void shortHandlers;

// ——— typedTools: a tool's name and its execute argument ———
//
// `contractTools` must take the TYPED client as well as the binding it
// wrapped. Its `ToolClient` is structural and `typedClient` narrows
// `invoke`'s operation type to a literal union — the pen's whole purpose —
// so the property form of that typedef rejected the very client this pen
// hands its user, and the spelling CONTRACT-PEN.md §5 shows did not
// compile. Both spellings are pinned here because only one of them was.
const toolsFromBinding = typedTools(contractTools(compiled, openLocalClient(compiled, handlers)), Shop);
const toolsFromTypedClient = typedTools(contractTools(compiled, api), Shop);
const toolNamesAgree: Equals<typeof toolsFromBinding, typeof toolsFromTypedClient> = true;
void [toolsFromBinding, toolsFromTypedClient, toolNamesAgree];

declare const rawTools: readonly unknown[];
const tools: TypedTool<typeof Shop>[] = typedTools(rawTools, Shop);
for (const tool of tools) {
  if (tool.name === 'product_save') {
    void tool.execute({ id: 1, revision: 2, product: { id: 1, name: 'a', price: 1 } });
  }
}
// @ts-expect-error — the opaque operation is not a tool, so its name is not one
const notATool: 'image_bytes' = tools[0]!.name;
void notATool;

// ——— a subscribe operation types the client's subscribe ———
const Board = s.named('Board', s.object({ seq: s.integer(), rows: s.array(s.string()) }).open());
const live = defineContract({ id: 'live' }, {
  'board.watch': subscribe({
    input: s.object({ id: s.string() }).open(),
    output: Board,
    policy: { task: 'switch', stream: { resume: 'replay', heartbeatMs: 2000 } },
    http: http({ method: 'GET', path: '/board/{id}' }),
  }),
  'board.set': command({
    input: s.object({ id: s.string(), rows: s.array(s.string()) }).open(),
    output: Board,
    errors: { conflict: error({ status: 409 }) },
  }),
});
type LiveOps = ContractOf<typeof live>;
const watchIsSubscribe: Equals<keyof SubscribableOf<typeof live>, 'board.watch'> = true;
const watchNotOpaque: Equals<LiveOps['board.watch']['opaque'], false> = true;
void [watchIsSubscribe, watchNotOpaque];

const liveApi = typedClient(openLocalClient(compileContract(live.document), {
  'board.watch': () => ({ result: { seq: 1, rows: [] }, subscribe: () => () => {}, close: () => {} }),
  'board.set': (input) => ({ seq: 1, rows: input.rows }),
}), live);
void liveApi.subscribe('board.watch', { id: 'a' }, {
  onSnapshot: (value, info: SnapshotInfo) => {
    const seq: number = value.seq;
    const reset: boolean = info.reset;
    const floor: number | null = info.earliestAvailable;
    const top: number | null = info.highWatermark;
    void [seq, reset, floor, top, info.seq, info.resumed];
  },
  onPatch: ({ seq }) => void seq,
});
// @ts-expect-error — 'board.set' is a command, not a subscribe operation
void liveApi.subscribe('board.set', { id: 'a', rows: [] }, {});
