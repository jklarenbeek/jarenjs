//@ts-check
/**
 * @file Documents on a filesystem: a JSON array is walked structurally
 * (one element at a time, never the array), JSONL is walked line by
 * line, both agree with `JSON.parse` on the same bytes, and an atomic
 * target replaces its file whole or leaves it byte-identical.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import {
  readJsonDocuments, readJsonlDocuments, readDocuments, openAtomicTarget,
  openNullTarget, openStreamTarget, formatOf, DOCUMENT_FORMATS,
} from '@jarenjs/db/node';

/** A disposable directory for one case. */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-docfiles-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const collect = async (iterable) => {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
};

/** The same bytes, delivered in chunks of the given size. */
const chunked = (text, size) => Readable.from((function* () {
  for (let i = 0; i < text.length; i += size) yield Buffer.from(text.slice(i, i + size));
})());

describe('a JSON array of documents, read structurally', () => {
  const documents = [
    { id: 'u1', name: 'Ada', tags: ['a', 'b'], nested: { deep: { deeper: [1, 2, 3] } } },
    { id: 'u2', name: 'a ] } , " tricky string', n: -12.5e3 },
    { id: 'u3', empty: {}, emptyList: [], nil: null, yes: true },
  ];

  it('answers exactly what JSON.parse answers, at every chunk boundary', async () => {
    const text = JSON.stringify(documents, null, 2);
    for (const size of [1, 2, 3, 7, 64, 100000]) {
      const read = await collect(readJsonDocuments(chunked(text, size)));
      assert.deepStrictEqual(read, documents, `chunk size ${size}`);
    }
  });

  it('reads a compact array, a padded one and an empty one', async () => {
    assert.deepStrictEqual(await collect(readJsonDocuments(chunked(JSON.stringify(documents), 5))),
      documents);
    assert.deepStrictEqual(
      await collect(readJsonDocuments(chunked(`\n\n  ${JSON.stringify(documents)}  \n`, 5))),
      documents);
    assert.deepStrictEqual(await collect(readJsonDocuments(chunked('[]', 1))), []);
    assert.deepStrictEqual(await collect(readJsonDocuments(chunked('  [  ]  ', 1))), []);
  });

  it('reads scalar and string elements, which end at their separator', async () => {
    const scalars = [1, -2.5, true, false, null, 'text', 'with , comma', [1], { a: 1 }];
    const text = JSON.stringify(scalars);
    assert.deepStrictEqual(await collect(readJsonDocuments(chunked(text, 3))), scalars);
    assert.deepStrictEqual(
      await collect(readJsonDocuments(chunked('[ 1 , 2 ,3, "x" ]', 2))), [1, 2, 3, 'x']);
  });

  it('refuses a root that is not an array, and says what it found', async () => {
    await assert.rejects(() => collect(readJsonDocuments(chunked('{"id":1}', 4))),
      (error) => /** @type {any} */ (error).code === 'JD0024'
        && /must hold one top-level ARRAY/.test(/** @type {Error} */ (error).message));
  });

  it('refuses an unclosed array and trailing content', async () => {
    await assert.rejects(() => collect(readJsonDocuments(chunked('[{"a":1}', 3))),
      (error) => /never closed/.test(/** @type {Error} */ (error).message));
    await assert.rejects(() => collect(readJsonDocuments(chunked('[] x', 1))),
      (error) => /trailing content/.test(/** @type {Error} */ (error).message));
    await assert.rejects(() => collect(readJsonDocuments(chunked('   ', 1))),
      (error) => /the source is empty/.test(/** @type {Error} */ (error).message));
  });

  it('names the document a malformed element sits at', async () => {
    await assert.rejects(() => collect(readJsonDocuments(chunked('[{"a":1},{"b":},{"c":3}]', 4))),
      (error) => /document 1 is not JSON/.test(/** @type {Error} */ (error).message));
  });

  it('refuses missing, repeated, leading and trailing array separators across chunks', async () => {
    for (const text of ['[,1]', '[1,]', '[1,,2]', '[{}{}]', '[1 2]', '["a""b"]']) {
      for (const size of [1, 2, 100]) {
        await assert.rejects(() => collect(readJsonDocuments(chunked(text, size))),
          (error) => /** @type {any} */ (error).code === 'JD0024', `${text}, chunk size ${size}`);
      }
    }
  });

  it('holds one document at a time, not the array', async () => {
    // 20k documents of ~130 bytes: reading the array whole would retain
    // every one of them, and the walk retains one
    const many = Array.from({ length: 20000 }, (_, i) => ({
      id: `u${i}`, pad: 'x'.repeat(100),
    }));
    const text = JSON.stringify(many);
    let seen = 0;
    let held = null;
    for await (const document of readJsonDocuments(chunked(text, 65536))) {
      seen++;
      held = document;
    }
    assert.strictEqual(seen, 20000);
    assert.deepStrictEqual(held, many[19999]);
  });
});

describe('JSONL documents', () => {
  it('reads one document per line, at every chunk boundary', async () => {
    const documents = [{ id: 1 }, { id: 2, s: 'a\\nb' }, { id: 3 }];
    const text = `${documents.map((d) => JSON.stringify(d)).join('\n')}\n`;
    for (const size of [1, 3, 17, 100000]) {
      assert.deepStrictEqual(await collect(readJsonlDocuments(chunked(text, size))), documents,
        `chunk size ${size}`);
    }
  });

  it('tolerates a missing final newline and blank lines', async () => {
    assert.deepStrictEqual(
      await collect(readJsonlDocuments(chunked('{"a":1}\n\n{"b":2}', 2))),
      [{ a: 1 }, { b: 2 }]);
    assert.deepStrictEqual(await collect(readJsonlDocuments(chunked('', 1))), []);
  });

  it('names the line a malformed document sits on', async () => {
    await assert.rejects(() => collect(readJsonlDocuments(chunked('{"a":1}\n{oops}\n', 3))),
      (error) => /** @type {any} */ (error).code === 'JD0024'
        && /line 2 is not JSON/.test(/** @type {Error} */ (error).message));
  });
});

describe('the format a path declares', () => {
  it('reads .jsonl and .ndjson as line-delimited, everything else as one array', () => {
    assert.strictEqual(formatOf('/tmp/users.jsonl'), 'jsonl');
    assert.strictEqual(formatOf('/tmp/users.NDJSON'), 'jsonl');
    assert.strictEqual(formatOf('/tmp/users.json'), 'json');
    assert.strictEqual(formatOf('/tmp/users'), 'json');
    assert.deepStrictEqual([...DOCUMENT_FORMATS], ['json', 'jsonl']);
  });

  it('dispatches by the named format and refuses an unknown one', async () => {
    assert.deepStrictEqual(await collect(readDocuments(chunked('[{"a":1}]', 3), 'json')),
      [{ a: 1 }]);
    assert.deepStrictEqual(await collect(readDocuments(chunked('{"a":1}\n', 3), 'jsonl')),
      [{ a: 1 }]);
    assert.throws(() => readDocuments(chunked('', 1), /** @type {any} */ ('yaml')),
      (error) => /** @type {any} */ (error).code === 'JD0024');
  });
});

describe('an atomic target', () => {
  it('removes the temporary when publication fails, and permits a subsequent abort', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const target = path.join(dir, 'existing-directory');
      fs.mkdirSync(target);
      const sink = await openAtomicTarget(target, 'json');
      await sink.write({ id: 'u1' });
      await assert.rejects(() => sink.commit());
      await sink.abort();
      assert.deepStrictEqual(fs.readdirSync(dir), ['existing-directory']);
      assert.deepStrictEqual(fs.readdirSync(target), []);
    }
    finally { cleanup(); }
  });

  it('replaces the file only on commit, and round-trips its own output', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const target = path.join(dir, 'users.json');
      fs.writeFileSync(target, '["original"]\n');
      const original = fs.readFileSync(target);

      const sink = await openAtomicTarget(target, 'json');
      await sink.write({ id: 'u1' });
      await sink.write({ id: 'u2' });
      // still untouched while the temporary fills
      assert.ok(fs.readFileSync(target).equals(original), 'the target is untouched pre-commit');
      assert.ok(fs.existsSync(sink.temporary), 'the temporary exists');

      const done = await sink.commit();
      assert.strictEqual(done.documents, 2);
      assert.ok(done.bytes > 0);
      assert.ok(!fs.existsSync(sink.temporary), 'the temporary is gone after the rename');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')),
        [{ id: 'u1' }, { id: 'u2' }]);
      assert.deepStrictEqual(
        await collect(readJsonDocuments(target)), [{ id: 'u1' }, { id: 'u2' }]);
    }
    finally { cleanup(); }
  });

  it('leaves the original byte-identical on abort, and removes the temporary', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const target = path.join(dir, 'users.jsonl');
      fs.writeFileSync(target, '{"keep":true}\n');
      const original = fs.readFileSync(target);
      const sink = await openAtomicTarget(target, 'jsonl');
      await sink.write({ id: 'u1' });
      await sink.abort();
      assert.ok(fs.readFileSync(target).equals(original), 'the original survived');
      assert.ok(!fs.existsSync(sink.temporary), 'the temporary was removed');
      assert.deepStrictEqual(fs.readdirSync(dir), ['users.jsonl'], 'nothing else was left behind');
    }
    finally { cleanup(); }
  });

  it('writes an empty collection as an empty array, and an empty JSONL as no bytes', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const asJson = path.join(dir, 'empty.json');
      const jsonSink = await openAtomicTarget(asJson, 'json');
      await jsonSink.commit();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(asJson, 'utf8')), []);

      const asJsonl = path.join(dir, 'empty.jsonl');
      const jsonlSink = await openAtomicTarget(asJsonl, 'jsonl');
      await jsonlSink.commit();
      assert.strictEqual(fs.readFileSync(asJsonl, 'utf8'), '');
    }
    finally { cleanup(); }
  });

  it('creates a target that did not exist', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const target = path.join(dir, 'new.jsonl');
      const sink = await openAtomicTarget(target, 'jsonl');
      await sink.write({ id: 'u1' });
      await sink.commit();
      assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"id":"u1"}\n');
    }
    finally { cleanup(); }
  });

  it('a stream target writes through, and aborting it takes nothing back', async () => {
    /** @type {string[]} */
    const chunks = [];
    const stream = { write: (text, callback) => { chunks.push(text); callback(null); return true; } };
    const sink = openStreamTarget(/** @type {any} */ (stream), 'jsonl');
    await sink.write({ id: 'u1' });
    await sink.abort();
    assert.deepStrictEqual(chunks, ['{"id":"u1"}\n'],
      'what was written stays written — a stream is not a temporary');
    assert.strictEqual(sink.temporary, null);
    assert.deepStrictEqual(await sink.commit(), { bytes: 0, documents: 1 });
  });

  it('a null target counts what it was given and writes nothing', async () => {
    const sink = openNullTarget();
    await sink.write({ id: 'u1' });
    await sink.write({ id: 'u2' });
    assert.deepStrictEqual(await sink.commit(), { bytes: 0, documents: 2 });
    assert.strictEqual(sink.temporary, null);
  });
});
