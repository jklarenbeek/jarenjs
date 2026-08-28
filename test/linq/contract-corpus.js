//@ts-check
/**
 * @file The contract-pen corpus: CONTRACT-FORMAT.md's three worked
 * examples, written through `@jarenjs/linq/contract`. The doc's own
 * ```json fences are the expectation — read at test time, never copied
 * here — so this file is the pen half of the pair and the format
 * document is the other.
 *
 * The same three builds carry the type half: `scripts/
 * generate-contract-pen-fixture.js` runs `toTypeScript` over each
 * emitted document into `test/consumer/linq-contract-generated.ts`, and
 * `test/consumer/linq-contract.ts` proves `ContractOf<>` equal to what
 * the projection declares.
 *
 * Every object is `.open()` because the format's examples declare no
 * `additionalProperties` — which is also what `toTypeScript` reads, an
 * index signature per interface, so the two halves agree by construction.
 */

import * as s from '@jarenjs/linq/schema';
import { command, defineContract, error, http, read } from '@jarenjs/linq/contract';

// —— §2: the whole document ——

export const Product = s.named('Product', s.object({
  id: s.integer(),
  name: s.string().min(1),
  price: s.number().min(0),
}).open());

export const Catalog = s.named('Catalog', s.object({
  revision: s.integer(),
  products: s.array(Product),
}).open());

export const Conflict = s.named('Conflict', s.object({
  current: Product.optional(),
}).open());

export const Shop = defineContract({ id: 'shop', version: '5', compat: ['4'] }, {
  'catalog.load': read({
    input: s.object({ since: s.datetime().optional() }).open(),
    output: Catalog,
    errors: { stale: error({ status: 409 }) },
    policy: { task: 'switch', cache: 'revision' },
    http: http({ method: 'GET', path: '/api/catalog' }),
    doc: 'The whole catalog snapshot.',
  }),
  'product.save': command({
    input: s.object({
      id: s.integer(),
      revision: s.integer(),
      product: Product,
    }).open(),
    output: Product,
    errors: {
      conflict: error({ status: 409, schema: Conflict }),
      'not-found': error({ status: 404 }),
    },
    policy: { task: 'exhaust', idempotency: 'required', revision: 'input:/revision' },
    http: http({
      method: 'PUT',
      path: '/api/products/{id}/master',
      in: { revision: 'body', product: 'body' },
    }),
  }),
  'image.bytes': read({
    input: s.object({ id: s.integer() }).open(),
    output: true,
    http: http({ method: 'GET', path: '/api/images/{id}', media: 'application/octet-stream' }),
  }),
});

// —— §6: the smallest complete document ——

export const Health = defineContract({}, {
  'health.check': read({
    output: s.object({}).open(),
    http: http({ method: 'GET', path: '/api/health' }),
  }),
});

// —— §6: a whole-body member, a `:name` template, the canonical binding ——

export const Docs = defineContract({ id: 'docs' }, {
  'doc.put': command({
    input: s.object({
      id: s.string(),
      doc: s.array(s.object({}).open()),
      dry: s.boolean().optional(),
    }).open(),
    output: true,
    policy: { idempotency: 'optional' },
    http: http({
      method: 'PUT',
      path: '/docs/:id',
      in: { dry: 'query' },
      body: 'doc',
      status: 204,
    }),
  }),
  'doc.remove': command({
    input: s.object({ id: s.string() }).open(),
    output: true,
  }),
});

/**
 * The corpus: one entry per worked example, in the order the format
 * document spells them (its ```json fences, first to last).
 */
export const CORPUS = [
  { name: 'Shop', section: '§2', build: () => Shop },
  { name: 'Health', section: '§6', build: () => Health },
  { name: 'Docs', section: '§6', build: () => Docs },
];
