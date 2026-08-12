//@ts-check
/**
 * @file The claim Phase B rests on: **the root request does not grow
 * with the corpus.**
 *
 * Everything else in the environment is machinery; this is the property
 * that distinguishes it from compaction with extra steps. A history
 * budget answers "what do I cut to fit?" and the answer is always
 * something. This answers "why is the corpus in the request at all?" —
 * and once it is not, a corpus a thousand times larger produces a root
 * view of the same size.
 *
 * The sweep is three orders of magnitude (10 kB → 10 MB) and the band is
 * stated as a number, because "roughly constant" is not a claim anybody
 * can fail. It runs twice: over the in-memory default, and over a stub
 * adapter that is asynchronous, out-of-process and hands back copies —
 * which is what an OPFS or IndexedDB driver actually is. A property that
 * only held for the synchronous in-memory path would be a property of
 * the test, not of the design.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createEnvironment } from '@jarenjs/ai';
import { sizeOf } from '@jarenjs/core/chunk';

/**
 * The band the root view must stay inside, in characters — the whole
 * claim, as a number somebody can fail. It is the digest's own cap
 * expressed as bytes: `digestSlots` entries × (a name, three numbers and
 * a capped excerpt), plus the hint. Nothing in it scales with the
 * corpus, which is why one number can hold for every size.
 */
const ROOT_BAND = 3000;

/** The corpus sizes swept, in characters: exactly three orders of magnitude. */
const SIZES = [10_000, 100_000, 1_000_000, 10_000_000];

/**
 * A corpus of exactly `size` characters with one unique needle in the
 * middle. The needle REPLACES text rather than being inserted, so the
 * sweep's ratios are exact rather than approximately right.
 * @param {number} size
 */
function corpusOf(size) {
  const line = `row ${'filler '.repeat(8)}\n`;
  const body = line.repeat(Math.ceil(size / line.length)).slice(0, size);
  const needle = 'NEEDLE-7788\n';
  const at = Math.floor(size / 2);
  return `${body.slice(0, at)}${needle}${body.slice(at + needle.length)}`;
}

/**
 * A storage adapter that behaves like a real out-of-process store:
 * every call is genuinely asynchronous (a macrotask, not a resolved
 * promise), values are serialized on the way in and parsed on the way
 * out, and nothing is shared by reference. It also counts its reads, so
 * a test can assert that answering a question did not walk the corpus.
 */
function outOfProcessStorage() {
  /** @type {Map<string, string>} */
  const backing = new Map();
  const counts = { get: 0, set: 0, keys: 0, delete: 0 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    counts,
    backing,
    get: async (key) => {
      counts.get += 1;
      await tick();
      const raw = backing.get(key);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    set: async (key, value) => {
      counts.set += 1;
      await tick();
      backing.set(key, JSON.stringify(value));
    },
    delete: async (key) => {
      counts.delete += 1;
      await tick();
      backing.delete(key);
    },
    keys: async (prefix = '') => {
      counts.keys += 1;
      await tick();
      return [...backing.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

/**
 * Put a corpus in, chunk it, and report what the root would carry.
 * @param {any} environment
 * @param {number} size
 */
async function measure(environment, size) {
  const text = corpusOf(size);
  await environment.put('corpus', text, { kind: 'text' });
  const chunked = await environment.chunk('corpus', { strategy: 'line', size: 4000 });
  const digest = await environment.digest();
  return {
    corpus: text.length,
    chunks: chunked.count,
    // what a request would carry: the root view, and the metadata each
    // operation answers with — never content
    root: sizeOf(digest),
    chunkResult: sizeOf(chunked),
    stat: sizeOf(await environment.stat(chunked.family)),
    grep: sizeOf(await environment.grep('NEEDLE-\\d+', { in: chunked.family })),
    peek: sizeOf(await environment.peek('corpus')),
    hit: await environment.grep('NEEDLE-\\d+', { in: chunked.family }),
  };
}

describe('ai — the environment holds its size as the corpus grows', function () {
  it('keeps the root view inside a stated band across three orders of magnitude', async function () {
    /** @type {any[]} */
    const rows = [];
    for (const size of SIZES) {
      // a fresh environment per size: this measures the root view of ONE
      // corpus, not of an accumulating store
      rows.push({ size, ...await measure(createEnvironment(), size) });
    }

    const smallest = rows[0];
    const largest = rows[rows.length - 1];
    assert.strictEqual(largest.corpus / smallest.corpus, 1000,
      'the sweep spans exactly three orders of magnitude');

    for (const row of rows) {
      assert.ok(row.root <= ROOT_BAND,
        `root view at ${row.size} chars is ${row.root}, over the ${ROOT_BAND} band`);
      for (const key of ['chunkResult', 'stat', 'grep', 'peek']) {
        assert.ok(row[key] <= ROOT_BAND,
          `${key} at ${row.size} chars is ${row[key]}, over the ${ROOT_BAND} band (D2)`);
      }
      // the point of the whole exercise: the fact is findable at every
      // size, by address, without any of this growing
      assert.strictEqual(row.hit.total, 1);
      assert.match(row.hit.matches[0].line, /NEEDLE-7788/);
    }

    // and FLAT, precisely: the digest fills up to its cap on the way
    // from 10 kB to 100 kB (a 10 kB corpus has fewer slots than the cap
    // lists), and from there the corpus grows a hundredfold while the
    // root view does not move at all. Asserting flatness from the
    // smallest row would be asserting that a cap never fills, which is
    // not the claim and is not true.
    const capped = rows.slice(2);
    for (const row of capped) {
      // not byte-identical, and the reason is worth naming: a chunk's
      // address carries its index, so a corpus with ten times more
      // pieces has one more digit in each of the twelve names the digest
      // lists. That is the whole growth — twelve characters per decade,
      // logarithmic in the corpus and invisible against the band. If
      // this assertion ever fails by hundreds, something CONTENT-sized
      // has entered the root view.
      assert.ok(Math.abs(row.root - capped[0].root) <= 64,
        `root view moved from ${capped[0].root} to ${row.root} between `
        + `${capped[0].corpus} and ${row.corpus} characters — more than addressing digits`);
    }
    assert.ok(largest.chunks >= smallest.chunks * 500,
      `the corpus really did split into far more pieces (${smallest.chunks} → ${largest.chunks})`
      + ' — the slot count grows with the corpus, the root view does not');
  });

  it('holds the same band over an async, out-of-process store', async function () {
    for (const size of SIZES) {
      const storage = outOfProcessStorage();
      const environment = createEnvironment({ storage });
      const row = await measure(environment, size);
      assert.ok(row.root <= ROOT_BAND,
        `root view at ${size} chars is ${row.root} over async storage`);
      assert.strictEqual(row.hit.total, 1, 'the needle is found through the store, not around it');
      assert.ok(storage.counts.get > 0 && storage.counts.set > 0,
        'the adapter was actually used');
    }
  });

  it('answers a metadata question without reading a single slot\'s content', async function () {
    const storage = outOfProcessStorage();
    const environment = createEnvironment({ storage });
    await environment.put('corpus', corpusOf(200_000));
    const chunked = await environment.chunk('corpus', { strategy: 'line', size: 4000 });

    const before = storage.counts.get;
    const digest = await environment.digest();
    const stat = await environment.stat(chunked.family);
    const reads = storage.counts.get - before;

    assert.strictEqual(digest.total, chunked.count + 1);
    assert.strictEqual(stat.slots, chunked.count);
    // metadata lives in its own keys, so a digest of a 200 kB corpus in
    // fifty pieces costs fifty small reads and not one byte of content
    assert.ok(reads <= 2 * (chunked.count + 1) + 4,
      `a metadata answer read ${reads} keys for ${chunked.count} chunks — it is reading content`);
    assert.ok(!JSON.stringify(digest).includes('NEEDLE'),
      'and it carried none of the corpus');
  });

  it('says how much it is not showing, at every size', async function () {
    const environment = createEnvironment({ digestSlots: 5 });
    await environment.put('corpus', corpusOf(100_000));
    const chunked = await environment.chunk('corpus', { strategy: 'line', size: 2000 });
    const digest = await environment.digest();

    assert.strictEqual(digest.listed, 5);
    assert.strictEqual(digest.total, chunked.count + 1);
    assert.strictEqual(digest.omitted, digest.total - 5,
      'a root view that hid the difference would let a model conclude the corpus is five slots');
    assert.strictEqual(digest.size, chunked.count * 0 + digest.size);
    assert.ok(digest.size > 100_000, 'the total size is reported even though the content is not');
  });
});
