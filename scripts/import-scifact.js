#!/usr/bin/env node
//@ts-check
/** Explicit optional download; never invoked by normal tests or site generation. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, parseJsonl, loadDataset } from '../benchmark/lib/relevance.js';

/** Import only the known archive entries, without extracting arbitrary ZIP paths.
 * @param {string} directory @param {any} [config] */
export async function importScifact(directory, config = {}) {
  const recipe = JSON.parse(readFileSync(new URL('../benchmark/fixtures/scifact-source.json', import.meta.url), 'utf8'));
  mkdirSync(directory, { recursive: true });
  const archive = config.archive ? readFileSync(config.archive) : Buffer.from(await (async () => {
    const response = await fetch(recipe.url);
    if (!response.ok) throw new Error(`SciFact download HTTP ${response.status}`);
    return response.arrayBuffer();
  })());
  if (sha256(archive) !== recipe.sha256) throw new Error('SciFact archive checksum mismatch');
  const zip = join(directory, 'scifact.zip');
  writeFileSync(zip, archive);
  const read = (name) => execFileSync('unzip', ['-p', zip, `scifact/${name}`], { maxBuffer: 20 * 1024 * 1024 }).toString('utf8');
  const qrels = read('qrels/test.tsv').trim().split(/\r?\n/).slice(1).map((line) => {
    const [queryId, corpusId, score] = line.split('\t');
    return { queryId, corpusId, relevance: Number(score) };
  });
  const ids = new Set(qrels.map((q) => q.queryId));
  const corpus = parseJsonl(read('corpus.jsonl'), 'corpus');
  const queries = parseJsonl(read('queries.jsonl'), 'queries').filter((q) => ids.has(q._id));
  const files = {};
  for (const [name, rows] of Object.entries({ corpus, queries, qrels })) {
    const data = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const path = `${name}.jsonl`;
    writeFileSync(join(directory, path), data);
    files[name] = { path, sha256: sha256(data) };
  }
  const manifest = { schemaVersion: 1, id: 'beir-scifact-test', datasetClass: 'real-language',
    source: recipe.url, license: recipe.license, licenseSource: recipe.licenseSource,
    version: recipe.version, archiveSha256: recipe.sha256, split: 'test', files };
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const loaded = loadDataset(path);
  return { path, manifest, hash: loaded.hash, documents: loaded.documents.length, questions: loaded.questions.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('Usage: node scripts/import-scifact.js DIRECTORY');
  console.log(JSON.stringify(await importScifact(resolve(directory)), null, 2));
}
