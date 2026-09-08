//@ts-check
/**
 * The jaren-emit command, driven end-to-end. The bundle case is here for a
 * reason: bundling concatenates independently compiled models into one file,
 * which is exactly where duplicate `$defs` names across schemas turn into
 * duplicate identifiers unless the models share one name space.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// A URL pathname (`/C:/repo/...`) is not a native Windows filesystem path:
// handed to execFileSync it resolves against the drive of the cwd and comes
// out as `C:\C:\repo\...`. `fileURLToPath` owns the drive-letter rules.
const CLI = fileURLToPath(new URL('../../packages/emit/src/cli.js', import.meta.url));

/** Run the CLI against a temp workspace holding the given schema files. */
function runEmit(schemas, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-'));
  try {
    const schemaDir = path.join(dir, 'schemas');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(schemaDir);
    for (const [file, schema] of Object.entries(schemas))
      fs.writeFileSync(path.join(schemaDir, file), JSON.stringify(schema));
    execFileSync(process.execPath,
      [CLI, '--schema', schemaDir, '--out', outDir, ...args],
      { encoding: 'utf8' });
    const out = {};
    for (const file of fs.readdirSync(outDir).sort())
      out[file] = fs.readFileSync(path.join(outDir, file), 'utf8');
    return out;
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const userSchema = {
  $defs: { Id: { type: 'string' } },
  type: 'object',
  properties: { id: { $ref: '#/$defs/Id' } },
  required: ['id'],
};
const orderSchema = {
  $defs: { Id: { type: 'integer' } },
  type: 'object',
  properties: { id: { $ref: '#/$defs/Id' } },
  required: ['id'],
};

describe('jaren-emit — bundle mode', () => {
  it('never bundles two declarations onto one identifier', () => {
    const out = runEmit(
      { 'order.json': orderSchema, 'user.json': userSchema },
      ['--bundle', 'types.d.ts']);
    const bundle = out['types.d.ts'];
    const declared = [...bundle.matchAll(/^export (?:type|interface) (\w+)/gm)]
      .map((m) => m[1]);
    assert.strictEqual(new Set(declared).size, declared.length,
      `duplicate identifiers in bundle: ${declared}`);
    // Both Ids exist, deterministically renamed in sorted-file order, and
    // each root references its own.
    assert.match(bundle, /export type Id = number;/);
    assert.match(bundle, /export type Id2 = string;/);
    assert.match(bundle, /\bid: Id;/);
    assert.match(bundle, /\bid: Id2;/);
  });

  it('writes one file per schema outside bundle mode, names intact', () => {
    const out = runEmit(
      { 'order.json': orderSchema, 'user.json': userSchema }, []);
    assert.deepStrictEqual(Object.keys(out), ['Order.d.ts', 'User.d.ts']);
    // Separate files are separate name spaces: both keep the name Id.
    assert.match(out['Order.d.ts'], /export type Id = number;/);
    assert.match(out['User.d.ts'], /export type Id = string;/);
  });

  it('refuses colliding output names before writing, including on a repeated run or --check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-'));
    try {
      const schemaDir = path.join(dir, 'schemas');
      const outDir = path.join(dir, 'out');
      fs.mkdirSync(schemaDir);
      fs.mkdirSync(outDir);
      for (const [file, schema] of Object.entries({
        'a.json': { type: 'boolean' },
        'user-account.json': { type: 'string' },
        'user_account.json': { type: 'number' },
      })) fs.writeFileSync(path.join(schemaDir, file), JSON.stringify(schema));
      fs.writeFileSync(path.join(outDir, 'UserAccount.d.ts'), 'existing declaration\n');
      for (const args of [[], [], ['--check']]) {
        const result = spawnSync(process.execPath,
          [CLI, '--schema', schemaDir, '--out', outDir, ...args], { encoding: 'utf8' });
        assert.strictEqual(result.status, 2, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.match(result.stderr, /output collision:.*user-account\.json.*user_account\.json.*UserAccount\.d\.ts/);
        assert.deepStrictEqual(fs.readdirSync(outDir), ['UserAccount.d.ts']);
        assert.strictEqual(fs.readFileSync(path.join(outDir, 'UserAccount.d.ts'), 'utf8'), 'existing declaration\n');
      }
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compares output names without case on Windows', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-'));
    try {
      const schemaDir = path.join(dir, 'schemas');
      const outDir = path.join(dir, 'out');
      fs.mkdirSync(schemaDir);
      // Distinct input filenames can normalize to outputs differing only by case.
      fs.writeFileSync(path.join(schemaDir, 'user-account.json'), '{"type":"string"}');
      fs.writeFileSync(path.join(schemaDir, 'useraccount.json'), '{"type":"number"}');
      const result = spawnSync(process.execPath,
        [CLI, '--schema', schemaDir, '--out', outDir], { encoding: 'utf8' });
      assert.strictEqual(result.status, 2, result.stderr);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, /output collision:.*user-account\.json.*useraccount\.json/);
      assert.strictEqual(fs.existsSync(outDir), false);
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
