//@ts-check
/**
 * @file A definition named after a global the printers write out (`Array<T>`,
 * `Record<string, T>`) is declared under the next free name: declared as
 * `Array`, it shadowed the global in the emitted file and every `Array<T>`
 * in it failed to compile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileEmitModel, emitTypeScript } from '@jarenjs/emit';

const schema = {
  type: 'object',
  properties: {
    a: { $ref: '#/$defs/array' },
    r: { $ref: '#/$defs/record' },
    list: { type: 'array', items: { type: 'string' } },
  },
  $defs: {
    array: { type: 'object', properties: { x: { type: 'number' } } },
    record: { type: 'object', properties: { y: { type: 'number' } } },
  },
};

describe('emit declaration names', () => {
  it('declares array and record definitions under free names', () => {
    const model = compileEmitModel(schema, { name: 'Thing' });
    assert.deepStrictEqual(model.declarations.map((d) => d.name), ['Array2', 'Record2', 'Thing']);
  });

  it('prints the generic globals untouched beside them', () => {
    const text = emitTypeScript(schema, { name: 'Thing' });
    assert.ok(text.includes('export interface Array2 {'));
    assert.ok(text.includes('a?: Array2;'));
    assert.ok(text.includes('list?: Array<string>;'));
    assert.ok(!/export interface Array \{/.test(text));
  });

  it('moves a root named Array aside as well', () => {
    const model = compileEmitModel({ type: 'object' }, { name: 'Array' });
    assert.strictEqual(model.root, 'Array2');
  });
});

describe('emit root names from file names', () => {
  it('declares the root of record.json and array.json as Record2 and Array2 and keeps the file name', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cli = fileURLToPath(new URL('../../packages/emit/src/cli.js', import.meta.url));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-names-'));
    try {
      fs.mkdirSync(path.join(dir, 's'));
      fs.writeFileSync(path.join(dir, 's', 'record.json'), '{"type":"object"}');
      fs.writeFileSync(path.join(dir, 's', 'array.json'), '{"type":"object"}');
      const result = spawnSync(process.execPath, [cli, '--schema', path.join(dir, 's'), '--out', path.join(dir, 'o')], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(fs.readFileSync(path.join(dir, 'o', 'Record.d.ts'), 'utf8').includes('export interface Record2 {'));
      assert.ok(fs.readFileSync(path.join(dir, 'o', 'Array.d.ts'), 'utf8').includes('export interface Array2 {'));
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
