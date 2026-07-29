//@ts-check
/**
 * The jaren-emit command, driven end-to-end. The bundle case is here for a
 * reason: bundling concatenates independently compiled models into one file,
 * which is exactly where duplicate `$defs` names across schemas turn into
 * duplicate identifiers unless the models share one name space.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = new URL('../../packages/emit/src/cli.js', import.meta.url).pathname;

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
});
