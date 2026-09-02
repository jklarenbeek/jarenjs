//@ts-check
/**
 * @file `graph.page(options)` through the client: no page exceeds its
 * `limit` or its `maxBytes` over rows of widely varying size; an item
 * larger than `maxBytes` is the coded `JD2074` that does not advance
 * the continuation and cannot loop; a page over the primary key is a
 * snapshot no concurrent update can move a row across, while a page
 * over a mutable ordering is LIVE, says so, and — proven, not assumed —
 * lets a row whose key changes move across the cursor; the continuation
 * is unsigned and structural; `after()` on the graph resumes from it;
 * and one `item_too_large` implementation exists for every page.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { open } from '@jarenjs/linq/db';
import * as m from '@jarenjs/linq/model';
import { PAGE_LIMIT_DEFAULT } from '@jarenjs/db';

const Post = m.object({
  pid: m.integer().key(),
  title: m.string(),
  stars: m.integer(),
  body: m.string(),
});
const model = m.defineModel({ entities: { Post } });

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

/** Bodies of widely varying size: 8 B to 4 KiB, stars tying in runs. */
async function seeded(count = 12, sizes = [8, 4096, 64, 512, 2048, 16]) {
  const { nodeDriver } = await import('@jarenjs/db/node');
  const client = await open(model, { driver: nodeDriver(), validator: null });
  const sync = client.store.sync;
  sync.transaction(() => {
    for (let pid = 1; pid <= count; pid++) {
      sync.entity('Post').create({ pid, title: `post ${pid}`, stars: Math.floor((pid - 1) / 3),
        body: 'b'.repeat(sizes[(pid - 1) % sizes.length]) });
    }
  });
  for (let pid = 1; pid <= count; pid++) sync.entity('Post').discard(pid);
  return client;
}

const bytesOf = (doc) => Buffer.byteLength(JSON.stringify(doc), 'utf8');

/** Every page, in order, until the graph says there is no more. */
async function drain(graph, options) {
  const pages = [];
  let after_ = undefined;
  for (;;) {
    const page = await graph.page({ ...options, after: after_ });
    pages.push(page);
    if (!page.hasMore) return pages;
    after_ = page.continuation;
  }
}

describe('no page exceeds limit or maxBytes', () => {
  it('over rows of widely varying size, every page is within both bounds and the union is the whole set', async () => {
    const client = await seeded();
    const graph = client.entities.Post.graph().orderBy((p) => p.stars).thenBy((p) => p.title);
    const pages = await drain(graph, { limit: 4, maxBytes: 6000 });
    const seen = [];
    for (const page of pages) {
      assert.ok(page.items.length <= 4, 'limit');
      const bytes = page.items.reduce((sum, item) => sum + bytesOf(item), 0);
      assert.ok(bytes <= 6000, `maxBytes: ${bytes}`);
      seen.push(...page.items.map((p) => p.pid));
    }
    assert.deepStrictEqual([...seen].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.strictEqual(new Set(seen).size, 12);
    assert.ok(pages.length > 3, 'the byte bound ended pages before the limit did');
    // the default limit exists and is the constant
    const defaulted = await client.entities.Post.graph().orderBy((p) => p.pid).page();
    assert.strictEqual(defaulted.items.length, 12);
    assert.strictEqual(PAGE_LIMIT_DEFAULT, 100);
    await client.close();
  });

  it('hasMore is true exactly when rows remain, and pages of limit n are n, n, … rest', async () => {
    const client = await seeded(7);
    const pages = await drain(client.entities.Post.graph().orderBy((p) => p.pid), { limit: 3 });
    assert.deepStrictEqual(pages.map((page) => [page.items.map((p) => p.pid), page.hasMore]),
      [[[1, 2, 3], true], [[4, 5, 6], true], [[7], false]]);
    assert.deepStrictEqual(pages[2].continuation?.key, 7, 'the last page still names where it ended');
    const empty = await client.entities.Post.graph().where((p) => p.stars.gt(100)).page({ limit: 3 });
    assert.deepStrictEqual(empty, { items: [], continuation: null, hasMore: false, snapshot: true });
    await client.close();
  });
});

describe('item_too_large', () => {
  it('one item larger than maxBytes is JD2074, does not advance the continuation, and does not loop', async () => {
    const client = await seeded(4, [8, 8, 4096, 8]);
    const graph = client.entities.Post.graph().orderBy((p) => p.pid);
    const first = await graph.page({ limit: 10, maxBytes: 600 });
    assert.deepStrictEqual(first.items.map((p) => p.pid), [1, 2], 'the page ended before the item that did not fit');
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(first.continuation?.key, 2);
    const tooLarge = codeIs('JD2074', /the next item is \d+ serialised bytes, more than the page's maxBytes bound of 600/);
    await assert.rejects(() => graph.page({ limit: 10, maxBytes: 600, after: first.continuation }), tooLarge);
    // the same continuation, the same refusal: nothing advanced
    await assert.rejects(() => graph.page({ limit: 10, maxBytes: 600, after: first.continuation }), (error) => {
      assert.strictEqual(error.errors[0].maxBytes, 600);
      assert.strictEqual(error.errors[0].at.key, 3, 'the refusal names the item that did not fit');
      return tooLarge(error);
    });
    // raising the bound delivers it
    const raised = await graph.page({ limit: 10, maxBytes: 6000, after: first.continuation });
    assert.deepStrictEqual(raised.items.map((p) => p.pid), [3, 4]);
    await client.close();
  });
});

describe('snapshot versus live pagination', () => {
  it('concurrent updates cannot move rows across a declared snapshot cursor (an ordering over the key)', async () => {
    const client = await seeded(6);
    const graph = client.entities.Post.graph().orderBy((p) => p.pid);
    const first = await graph.page({ limit: 3, consistency: 'snapshot' });
    assert.strictEqual(first.snapshot, true);
    assert.deepStrictEqual(first.items.map((p) => p.pid), [1, 2, 3]);
    // every row changes between the pages, delivered and undelivered alike
    for (let pid = 1; pid <= 6; pid++) await client.entities.Post.update(pid, { stars: 100 - pid });
    const second = await graph.page({ limit: 3, consistency: 'snapshot', after: first.continuation });
    assert.deepStrictEqual(second.items.map((p) => p.pid), [4, 5, 6], 'exactly the rest, once');
    assert.strictEqual(second.hasMore, false);
    await client.close();
  });

  it("a page over a mutable ordering is live and says so: a row whose key changes CAN move across the cursor", async () => {
    const client = await seeded(6);
    const graph = client.entities.Post.graph().orderBy((p) => p.stars).thenBy((p) => p.pid);
    const first = await graph.page({ limit: 3 });
    assert.strictEqual(first.snapshot, false, 'stars is a column a write may change');
    assert.deepStrictEqual(first.items.map((p) => p.pid), [1, 2, 3]);
    // a delivered row's key moves forward: it will be seen again; an
    // undelivered row's key moves backward: it will never be seen
    await client.entities.Post.update(1, { stars: 50 });
    await client.entities.Post.update(6, { stars: -1 });
    const rest = [];
    let after_ = first.continuation;
    for (;;) {
      const page = await graph.page({ limit: 3, after: after_ });
      rest.push(...page.items.map((p) => p.pid));
      if (!page.hasMore) break;
      after_ = page.continuation;
    }
    assert.deepStrictEqual(rest, [4, 5, 1], 'pid 1 visited twice, pid 6 never — the weaker contract, demonstrated');
    // and asking for a snapshot over it is refused rather than mislabelled
    await assert.rejects(() => graph.page({ limit: 3, consistency: 'snapshot' }),
      codeIs('JD0036', /orders by \(stars, pid\), which a write may change, so it is LIVE pagination/));
    await client.close();
  });
});

describe('the continuation is unsigned, structural, and belongs to its ordering', () => {
  it('carries exactly { order, keys, key }, survives JSON, resumes through after(), and refuses another ordering', async () => {
    const client = await seeded(6);
    const graph = client.entities.Post.graph().orderBy((p) => p.stars).thenByDescending((p) => p.title);
    const first = await graph.page({ limit: 2 });
    const continuation = first.continuation;
    assert.ok(continuation !== null);
    assert.deepStrictEqual(Object.keys(continuation), ['order', 'keys', 'key']);
    assert.ok(Object.isFrozen(continuation) && Object.isFrozen(continuation.order) && Object.isFrozen(continuation.keys));
    assert.deepStrictEqual(continuation, {
      order: [
        { column: 'stars', desc: false, nullsFirst: true },
        { column: 'title', desc: true, nullsFirst: false },
        { column: 'pid', desc: false, nullsFirst: true },
      ],
      keys: [0, 'post 2'],
      key: 2,
    });
    for (const forbidden of ['signature', 'sig', 'tenant', 'expires', 'exp', 'iat', 'hmac']) {
      assert.strictEqual(forbidden in continuation, false, `no ${forbidden}: signing is the host's`);
    }
    // the wire form is the host's; the plain JSON round trip resumes
    const revived = JSON.parse(JSON.stringify(continuation));
    const second = await graph.page({ limit: 2, after: revived });
    assert.deepStrictEqual(second.items.map((p) => p.pid), [1, 6], 'stars 0 by title desc: 3, 2, 1; then stars 1: 6, 5, 4');
    // after() on the graph is the same resumption, loaded whole
    const viaAfter = await graph.after(revived).toArray();
    assert.deepStrictEqual(viaAfter.map((p) => p.pid), [1, 6, 5, 4]);
    assert.deepStrictEqual(graph.after(revived).toSpec().after, revived);
    // a different ordering refuses it by code
    await assert.rejects(() => client.entities.Post.graph().orderBy((p) => p.pid).page({ limit: 2, after: revived }), codeIs('JD0035'));
    assert.throws(() => client.entities.Post.graph().orderBy((p) => p.stars).after(revived).explain(), codeIs('JD0035'));
    await client.close();
  });

  it('a page registers no snapshots unless asked; take or skip beside a page is refused', async () => {
    const client = await seeded(4);
    const graph = client.entities.Post.graph().orderBy((p) => p.pid);
    await graph.page({ limit: 2 });
    assert.strictEqual(client.store.stats().tracker?.tracked, 0);
    await graph.page({ limit: 2, tracking: true });
    assert.strictEqual(client.store.stats().tracker?.tracked, 2);
    await assert.rejects(() => graph.take(2).page({ limit: 2 }), codeIs('JD0032', /page\(\) windows by its limit/));
    await assert.rejects(() => graph.page({ limit: 0 }), codeIs('JD0032', /limit must be a positive integer/));
    await client.close();
  });
});

describe('the drift gates', () => {
  it('one item_too_large implementation (JD2074) and one page drain exist, and every page uses them', () => {
    const files = fs.readdirSync('packages/db/src').filter((name) => name.endsWith('.js'));
    const sites = files.filter((file) => fs.readFileSync(`packages/db/src/${file}`, 'utf8').includes("'JD2074'"));
    assert.deepStrictEqual(sites, ['cursor.js'], 'the refusal is raised in the drain alone');
    const drains = files.filter((file) => /export function drainPage\(/.test(fs.readFileSync(`packages/db/src/${file}`, 'utf8')));
    assert.deepStrictEqual(drains, ['cursor.js']);
    const query = fs.readFileSync('packages/db/src/query.js', 'utf8');
    assert.match(query, /page\(spec, options = undefined, register = undefined\) \{[\s\S]*?return drainPage\(cursor, \{/,
      'the graph page is a drain of its cursor');
  });
});
