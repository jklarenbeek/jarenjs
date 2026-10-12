//@ts-check
/**
 * @file The document files: a byte order mark leads the text of a file an
 * editor saved "with BOM" and is not part of the document (JSON and JSONL
 * alike); a target an atomic write replaces keeps its permissions and, when
 * it is a link, is the file the link names -- rewriting a private file in
 * place must not publish it, nor turn the link into a file of its own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAtomicTarget, readDocuments, readJsonDocuments, readJsonlDocuments } from '@jarenjs/db/node';
import { removeTempDirectory } from './helpers.js';

const POSIX = process.platform !== 'win32';

/** @param {AsyncIterable<any>} source */
const all = async (source) => { const out = []; for await (const item of source) out.push(item); return out; };
/** @param {Uint8Array[]} parts */
async function* chunks(parts) { for (const part of parts) yield part; }

describe('a byte order mark', () => {
  const bom = [0xEF, 0xBB, 0xBF];
  it('is not part of a JSON array file, whole or split across chunks', async () => {
    const text = Buffer.from('[{"id":"a"},{"id":"b"}]');
    assert.deepEqual(await all(readJsonDocuments(chunks([Buffer.concat([Buffer.from(bom), text])]))), [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(await all(readJsonDocuments(chunks([Buffer.from(bom.slice(0, 2)), Buffer.from(bom.slice(2)), text]))), [{ id: 'a' }, { id: 'b' }]);
  });

  it('is not part of a JSONL file, and a file path reads the same', async () => {
    assert.deepEqual(await all(readJsonlDocuments(chunks([Buffer.from([...bom, ...Buffer.from('{"id":"a"}\n{"id":"b"}\n')])]))),
      [{ id: 'a' }, { id: 'b' }]);
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-bom-'));
    try {
      writeFileSync(join(dir, 'with.json'), Buffer.from([...bom, ...Buffer.from('[{"id":"a"}]')]));
      assert.deepEqual(await all(readDocuments(join(dir, 'with.json'), 'json')), [{ id: 'a' }]);
    }
    finally { removeTempDirectory(dir); }
  });

  it('is only the first character: one inside the text stays', async () => {
    assert.deepEqual(await all(readJsonDocuments(chunks([Buffer.from('[{"id":"﻿a"}]')]))), [{ id: '﻿a' }]);
  });
});

describe('an atomic write over an existing file', { skip: !POSIX && 'POSIX permissions and links' }, () => {
  it('keeps the permissions of the file it replaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-replace-'));
    try {
      const file = join(dir, 'documents.json');
      writeFileSync(file, '[]');
      chmodSync(file, 0o600);
      const target = await openAtomicTarget(file, 'json');
      await target.write({ id: 'a' });
      await target.commit();
      assert.equal(readFileSync(file, 'utf8'), '[\n{"id":"a"}\n]\n');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      chmodSync(file, 0o640);
      const again = await openAtomicTarget(file, 'jsonl');
      await again.write({ id: 'b' });
      await again.commit();
      assert.equal(statSync(file).mode & 0o777, 0o640);
    }
    finally { removeTempDirectory(dir); }
  });

  it('replaces the file a link names and leaves the link a link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-replace-'));
    try {
      const real = join(dir, 'real.json');
      const link = join(dir, 'link.json');
      writeFileSync(real, '[]');
      symlinkSync('real.json', link);
      const target = await openAtomicTarget(link, 'json');
      await target.write({ id: 'a' });
      await target.commit();
      assert.ok(lstatSync(link).isSymbolicLink(), 'the link is still a link');
      assert.equal(readlinkSync(link), 'real.json');
      assert.equal(readFileSync(real, 'utf8'), '[\n{"id":"a"}\n]\n');
    }
    finally { removeTempDirectory(dir); }
  });

  it('writes a file that did not exist, and an abort leaves no temporary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-db-replace-'));
    try {
      const file = join(dir, 'new.jsonl');
      const target = await openAtomicTarget(file, 'jsonl');
      await target.write({ id: 'a' });
      await target.commit();
      assert.equal(readFileSync(file, 'utf8'), '{"id":"a"}\n');
      const aborted = await openAtomicTarget(file, 'jsonl');
      await aborted.write({ id: 'b' });
      await aborted.abort();
      assert.equal(readFileSync(file, 'utf8'), '{"id":"a"}\n');
      assert.deepEqual(readdirSync(dir), ['new.jsonl']);
    }
    finally { removeTempDirectory(dir); }
  });
});
