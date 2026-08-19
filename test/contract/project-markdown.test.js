//@ts-check
/**
 * @file `toMarkdown`: the document equals the golden and renders
 * byte-identical twice; it carries the operations table, one section per
 * public operation with parameters/body/responses/errors, and the Types
 * part rendered by emit's Markdown target over the same model as the
 * `.d.ts` — so every type name a section links to is a heading that
 * exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract, ContractHostError } from '@jarenjs/contract';
import { toMarkdown } from '@jarenjs/contract/project';

import { load } from './helpers.js';

const shop = load('./fixtures/shop.contract.json');
const GOLDEN = new URL('./fixtures/shop.md', import.meta.url);

describe('toMarkdown — the golden and determinism', () => {
  it('equals the golden (regenerate with: node packages/contract/src/cli.js docs --contract test/contract/fixtures/shop.contract.json --out test/contract/fixtures/shop.md) and renders byte-identical twice', () => {
    const contract = compileContract(shop);
    const first = toMarkdown(contract);
    assert.strictEqual(first, readFileSync(GOLDEN, 'utf8'));
    assert.strictEqual(toMarkdown(contract), first);
  });
});

describe('toMarkdown — the document', () => {
  const md = toMarkdown(compileContract(shop));

  it('opens with the title, version and compat, and the operations table lists every public operation', () => {
    assert.ok(md.startsWith('# shop\n\nVersion `5`, compatible with `4`.'));
    assert.match(md, /\| Operation \| Method \| Path \| Kind \| Task \| Idempotency \|/);
    assert.match(md, /\| \[`product\.save`\]\(#productsave\) \| `PUT` \| `\/api\/products\/\{id\}\/master` \| command \| `exhaust` \| `required` \|/);
    assert.match(md, /\| \[`image\.bytes`\]\(#imagebytes\) \| `GET` \| `\/api\/images\/\{id\}` \| read \| `switch` \| `none` \|/);
    assert.strictEqual((md.match(/^\| \[`/gm) ?? []).length, 5);
  });

  it('renders each section: doc, the policy line, parameters, body, responses and errors', () => {
    assert.match(md, /## catalog\.load\n\nThe whole catalog snapshot\.\n\n`GET \/api\/catalog` — a read operation; task `switch`, idempotency `none`, cache `revision`\./);
    assert.match(md, /`PUT \/api\/products\/\{id\}\/master` — a command operation; task `exhaust`, idempotency `required`, cache `none`, revision `input:\/revision`, retry up to 2 time\(s\) on `not-found`\./);
    assert.match(md, /\| `id` \| path \| yes \| `integer` \|/);
    assert.match(md, /\| `Idempotency-Key` \| header \| yes \| `string` \(the caller-generated idempotency key\) \|/);
    assert.match(md, /`application\/json` — an object of the \[`ProductSaveInput`\]\(#productsaveinput\) members `revision`, `product`\./);
    assert.match(md, /\| 200 \| Success \| \[`ProductSaveOutput`\]\(#productsaveoutput\) \|/);
    assert.match(md, /\| 409 \| Declared failure `conflict` \| wire error \|/);
    assert.match(md, /\| `conflict` \| 409 \| \[`ProductSaveConflictDetails`\]\(#productsaveconflictdetails\) \|/);
    assert.match(md, /\| `not-found` \| 404 \| — \|/);
    assert.match(md, /a read operation \(opaque: the response bytes are not decoded by the contract\)/);
    assert.match(md, /\| 200 \| Success \| `application\/octet-stream` bytes \|/);
  });

  it('every type a section links to is a heading in the Types part, rendered by emit', () => {
    const linked = new Set([...md.matchAll(/\[`([A-Za-z0-9]+)`\]\(#[a-z0-9]+\)/g)].map((m) => m[1])
      .filter((name) => /^[A-Z]/.test(name)));
    assert.ok(linked.size >= 6, `type links found: ${linked.size}`);
    for (const name of linked) {
      assert.match(md, new RegExp(`^## ${name}$`, 'm'), name);
    }
    assert.match(md, /# Types\n/);
    assert.match(md, /## Product\n\n\| Member \| Type \| Required \|/, 'emit\'s member table');
  });

  it('takes a title option, defaults for an anonymous contract, and refuses a malformed argument', () => {
    assert.ok(toMarkdown(compileContract(shop), { title: 'Shop API' }).startsWith('# Shop API\n'));
    const anonymous = compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, http: { method: 'GET', path: '/a' } } } });
    const md2 = toMarkdown(anonymous);
    assert.ok(md2.startsWith('# jaren-contract\n\nUnversioned.'));
    assert.throws(() => toMarkdown(compileContract(shop), /** @type {any} */ ({ title: 5 })), (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1008');
    assert.throws(() => toMarkdown(/** @type {any} */ (shop)), (/** @type {any} */ e) => e.code === 'JC1008');
  });
});
