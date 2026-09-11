//@ts-check
/** Coverage claims must include real compiler inputs, not dormant fixtures. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { penCensus, penCoverage } from '../../scripts/generate-pen-census.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

it('publishes the complete subpath and executable keyword census', () => {
  const census = penCensus(ROOT);
  assert.equal(census.subpaths.length, 15);
  assert.equal(census.owned.length, 69);
  assert.deepEqual(census.routes, census.owned);
  penCoverage.docs(ROOT);
  const facts = penCoverage.facts(new Map());
  assert.equal(facts['coverage.pens'](),
    '15 public pen/client subpaths beside the chain; 69/69 owned schema keywords have dedicated emission routes.');
  for (const pen of census.subpaths)
    assert.ok(facts['coverage.subpaths']().includes(`\`${pen.replace('@jarenjs/linq', '.')}\``));
});

it('the actual TypeScript configuration includes every pen fixture and every public subpath', () => {
  const listed = execFileSync(process.execPath,
    ['node_modules/typescript/bin/tsc', '--listFilesOnly', '-p', 'test/consumer/tsconfig.json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/).map((file) => resolve(file));
  const fixtures = readdirSync(join(ROOT, 'test/consumer')).filter((file) => /^linq-.*\.ts$/.test(file));
  const imports = new Set();
  for (const file of fixtures) {
    const absolute = join(ROOT, 'test/consumer', file);
    assert.ok(listed.includes(absolute), `TypeScript must actually read ${file}`);
    for (const match of readFileSync(absolute, 'utf8').matchAll(/from ['"](@jarenjs\/linq\/[^'"]+)['"]/g))
      imports.add(match[1]);
  }
  for (const pen of penCensus(ROOT).subpaths)
    assert.ok(imports.has(pen), `${pen} needs an included consumer fixture`);
});
