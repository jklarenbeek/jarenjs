//@ts-check
/**
 * @file `jaren-emit` over a directory holding one unreadable schema: the
 * message names the file, and nothing is written for the schemas that
 * were fine (the output plan is validated before the first write). A
 * directory whose name ends in `.json` is not a schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../packages/emit/src/cli.js', import.meta.url));

/** @param {(dir: string) => void} body */
function inTemp(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-bad-'));
  try { body(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('jaren-emit — a schema that cannot be read', () => {
  it('names the file and writes nothing', () => {
    inTemp((dir) => {
      const schemas = path.join(dir, 'schemas');
      fs.mkdirSync(schemas);
      fs.writeFileSync(path.join(schemas, 'a.json'), '{"type":"object"}');
      fs.writeFileSync(path.join(schemas, 'b.json'), '{"type":');
      const out = path.join(dir, 'out');
      const result = spawnSync(process.execPath, [CLI, '--schema', schemas, '--out', out], { encoding: 'utf8' });
      assert.strictEqual(result.status, 2);
      assert.ok(result.stderr.includes(path.join(schemas, 'b.json') + ': '), result.stderr);
      assert.strictEqual(fs.existsSync(out), false);
      assert.strictEqual(result.stdout, '');
    });
  });

  it('skips a directory named like a schema', () => {
    inTemp((dir) => {
      const schemas = path.join(dir, 'schemas');
      fs.mkdirSync(path.join(schemas, 'nested.json'), { recursive: true });
      fs.writeFileSync(path.join(schemas, 'a.json'), '{"type":"object"}');
      const out = path.join(dir, 'out');
      const result = spawnSync(process.execPath, [CLI, '--schema', schemas, '--out', out], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.deepStrictEqual(fs.readdirSync(out), ['A.d.ts']);
    });
  });
});
