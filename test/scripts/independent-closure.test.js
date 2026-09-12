import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkIndependentClosure } from '../../scripts/lib/independent-closure.js';

it('refuses private/dev/optional/peer, aliases, lock and indirect runtime/type imports without installing anything', t => {
  const root = mkdtempSync(join(tmpdir(), 'jaren-independent-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [];
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); if (!files.includes(path)) files.push(path); };
  const scan = () => checkIndependentClosure(root, { files });
  put('package.json', JSON.stringify({ private: true, workspaces: ['./site'] }));
  put('site/package.json', JSON.stringify({ private: true }));
  put('entry.js', "import './indirect.js'; // Historical tangleai migration note\n");
  put('indirect.js', 'export const value = 1;');
  assert.deepEqual(scan(), []);
  for (const section of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) {
    put('site/package.json', JSON.stringify({ private: true, [section]: { '@tangleai/models': '0.20.1' } }));
    assert.match(scan().join('\n'), new RegExp('site/package.json: '+section));
  }
  put('site/package.json', JSON.stringify({ devDependencies: { alias: 'npm:@tangleai/context@0.20.1' } }));
  assert.match(scan().join('\n'), /devDependencies.alias/);
  put('site/package.json', JSON.stringify({ scripts: { check: 'node ../tangleai/scripts/check.ts' } }));
  assert.match(scan().join('\n'), /scripts.check/);
  put('site/package.json', '{}');
  for (const source of ["import { x } from '@tangleai/models';", "export * from '@tangleai/context';", "const x=import('@tangleai/agents');", "const x=require('@tangleai/jaren');", "/** @type {import('@tangleai/models').Client} */ let client;"]) {
    put('indirect.js', source); assert.match(scan().join('\n'), /indirect.js.*imports/);
  }
  put('indirect.js', 'export const value=1;');
  put('typed.ts', "export type Client=import('@tangleai/models').Client;");
  assert.match(scan().join('\n'), /typed.ts.*imports/);
  put('typed.ts', 'export type Client=object;');
  put('package-lock.json', JSON.stringify({ packages: { 'node_modules/@jarenjs/studio': { dependencies: { '@jarenjs/ai': '0.83.3' } } } }));
  assert.match(scan().join('\n'), /package-lock.json/);
  put('package-lock.json', JSON.stringify({ packages: {} }));
  assert.deepEqual(scan(), []);
});
