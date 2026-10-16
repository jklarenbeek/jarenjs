//@ts-check
/**
 * @file `jaren-emit --config`: the per-node normalization route the
 * `--defaults`/`--coerce` flags cannot express. A string option names the
 * schema annotation that switches it on, exactly as the predicate a host
 * hands `compileNormalizer` does, and every malformed config is refused
 * with exit code 2 before anything is written.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../packages/emit/src/cli.js', import.meta.url));

const schema = {
  type: 'object',
  properties: {
    port: { type: 'integer', 'x-coerce': true },
    retries: { type: 'integer' },
    name: { type: 'string', 'x-trim': true },
    mode: { type: 'string', default: 'fast', 'x-default': true },
    level: { type: 'string', default: 'info' },
  },
  required: ['name', 'mode', 'level'],
};

/**
 * Run the CLI over one schema with `config` (a value, written as JSON, or a
 * raw string) and extra arguments; resolves the files written.
 * @param {unknown} config - `undefined` passes no `--config`
 * @param {string[]} [args]
 * @param {unknown} [document] - the schema to generate from
 */
function run(config, args = [], document = schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-config-'));
  try {
    const out = path.join(dir, 'out');
    fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(document));
    const cli = [CLI, '--schema', path.join(dir, 'schema.json'), '--out', out];
    if (config !== undefined) {
      fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
      cli.push('--config', path.join(dir, 'config.json'));
    }
    const result = spawnSync(process.execPath, [...cli, ...args], { encoding: 'utf8' });
    const written = fs.existsSync(out) ? fs.readdirSync(out) : null;
    const text = written?.includes('Schema.d.ts') ? fs.readFileSync(path.join(out, 'Schema.d.ts'), 'utf8') : null;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, written, text, config: path.join(dir, 'config.json') };
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The member lines of the `interface name { ... }` declaration, trimmed. */
function members(/** @type {string} */ text, /** @type {string} */ name) {
  const body = text.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`));
  assert.ok(body, `no declaration ${name} in\n${text}`);
  return body[1].split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('/') && !l.startsWith('*'));
}

describe('jaren-emit --config — the per-node route', () => {
  it('widens and defaults only the nodes carrying the named annotation', () => {
    const result = run({ coerceTypes: 'x-coerce', useDefaults: 'x-default' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.text);
    assert.deepStrictEqual(members(result.text, 'Schema'), [
      'port?: number;', 'retries?: number;', 'name: string;', 'mode: string;', 'level: string;',
      '[key: string]: unknown;']);
    assert.deepStrictEqual(members(result.text, 'SchemaInput'), [
      'port?: number | string;', 'retries?: number;', 'name: string;', 'mode?: string;', 'level: string;',
      '[key: string]: unknown;']);
  });

  it('true everywhere is byte for byte what the two flags write', () => {
    const viaConfig = run({ useDefaults: true, coerceTypes: true });
    const viaFlags = run(undefined, ['--defaults', '--coerce']);
    assert.strictEqual(viaConfig.status, 0, viaConfig.stderr);
    assert.ok(viaConfig.text?.includes('SchemaInput'));
    assert.strictEqual(viaConfig.text, viaFlags.text);
  });

  it('a flag still stands beside a config that sets the other option', () => {
    const result = run({ coerceTypes: 'x-coerce' }, ['--defaults']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.text);
    assert.deepStrictEqual(members(result.text, 'SchemaInput'), [
      'port?: number | string;', 'retries?: number;', 'name: string;', 'mode?: string;', 'level?: string;',
      '[key: string]: unknown;']);
  });

  it('trimStrings and removeAdditional change no declaration, so the output stays single', () => {
    const configured = run({ trimStrings: 'x-trim', removeAdditional: 'all', useDefaults: false });
    const plain = run(undefined);
    assert.strictEqual(configured.status, 0, configured.stderr);
    assert.ok(!configured.text?.includes('SchemaInput'));
    assert.strictEqual(configured.text, plain.text);
  });

  it('an annotation no node carries leaves the output single, and says so on stderr', () => {
    const configured = run({ coerceTypes: 'x-unused' });
    assert.strictEqual(configured.status, 0, configured.stderr);
    assert.strictEqual(configured.text, run(undefined).text);
    assert.match(configured.stderr, /^warning: config .*config\.json routes by 'x-unused', which no schema node carries as true\n$/);
  });

  it('says nothing when every route is carried as true somewhere', () => {
    const result = run({ coerceTypes: 'x-coerce', trimStrings: 'x-trim', useDefaults: 'x-default' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
  });

  it('finds a carried route under an array of subschemas', () => {
    const result = run({ coerceTypes: 'x-coerce' }, [], { allOf: [{ type: 'object', properties: { p: { type: 'integer', 'x-coerce': true } } }] });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, '');
  });

  it('warns once per route, for each route nothing carries', () => {
    const result = run({ coerceTypes: 'x-a', useDefaults: 'x-b', trimStrings: 'x-a' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(result.stderr.trim().split('\n').map((l) => l.replace(/ .*config\.json/, '')),
      ["warning: routes by 'x-b', which no schema node carries as true",
        "warning: routes by 'x-a', which no schema node carries as true"]);
  });

  it('reads only the value true on the annotation, never a truthy one', () => {
    const document = {
      type: 'object',
      properties: {
        a: { type: 'integer', 'x-coerce': false },
        b: { type: 'integer', 'x-coerce': 'yes' },
        c: { type: 'integer', 'x-coerce': 1 },
        d: { type: 'integer', 'x-coerce': true },
      },
    };
    const result = run({ coerceTypes: 'x-coerce' }, [], document);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.text);
    assert.deepStrictEqual(members(result.text, 'SchemaInput'), [
      'a?: number;', 'b?: number;', 'c?: number;', 'd?: number | string;', '[key: string]: unknown;']);
    const unmet = run({ coerceTypes: 'x-coerce' }, [], { type: 'object', properties: { b: document.properties.b, c: document.properties.c } });
    assert.match(unmet.stderr, /routes by 'x-coerce', which no schema node carries as true/);
  });

  it('works under --check: current output passes, a different route reads as drift', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
      const args = (/** @type {string} */ config) => {
        fs.writeFileSync(path.join(dir, 'config.json'), config);
        return [CLI, '--schema', path.join(dir, 'schema.json'), '--out', path.join(dir, 'out'), '--config', path.join(dir, 'config.json')];
      };
      assert.strictEqual(spawnSync(process.execPath, args('{"coerceTypes":"x-coerce"}'), { encoding: 'utf8' }).status, 0);
      assert.strictEqual(spawnSync(process.execPath, [...args('{"coerceTypes":"x-coerce"}'), '--check'], { encoding: 'utf8' }).status, 0);
      const drift = spawnSync(process.execPath, [...args('{"coerceTypes":true}'), '--check'], { encoding: 'utf8' });
      assert.strictEqual(drift.status, 1);
      assert.match(drift.stderr, /out of date: .*Schema\.d\.ts/);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('coerceJsonText widens by string exactly the object and array nodes it decodes, everywhere or by annotation', () => {
    const document = {
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, 'x-json': true },
        list: { type: 'array', items: { type: 'number' } },
        either: { type: ['object', 'string'] },
      },
    };
    const everywhere = run({ coerceJsonText: true }, [], document);
    assert.strictEqual(everywhere.status, 0, everywhere.stderr);
    assert.match(everywhere.text ?? '', /^export type SchemaInput = \{ filter\?: \{ tags\?: Array<string> \| string; \[key: string\]: unknown; \} \| string; list\?: Array<number> \| string; either\?: \{ \[key: string\]: unknown; \} \| string; \[key: string\]: unknown; \} \| string;$/m);
    const routed = run({ coerceJsonText: 'x-json' }, [], document);
    assert.strictEqual(routed.status, 0, routed.stderr);
    assert.strictEqual(routed.stderr, '');
    assert.deepStrictEqual(members(routed.text ?? '', 'SchemaInput'), [
      'filter?: { tags?: Array<string>; [key: string]: unknown; } | string;',
      'list?: Array<number>;',
      'either?: { [key: string]: unknown; } | string;',
      '[key: string]: unknown;',
    ]);
    // off, the output is the single declaration it always was
    const off = run({ coerceJsonText: false }, [], document);
    assert.strictEqual(off.status, 0, off.stderr);
    assert.doesNotMatch(off.text ?? '', /SchemaInput/);
  });

  it('is described in the help text', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /--config <file>/);
    assert.match(result.stdout, /"coerceTypes": "x-coerce"/);
  });
});

describe('jaren-emit --config — refusals', () => {
  /** @type {[string, unknown, RegExp][]} */
  const bad = [
    ['not JSON', '{"coerceTypes":', /^config .*config\.json: /],
    ['an array', '[]', /config .*config\.json: must be a JSON object of normalization options/],
    ['a scalar', '"x-coerce"', /must be a JSON object of normalization options/],
    ['null', 'null', /must be a JSON object of normalization options/],
    ['a misspelt option', { coerceType: true }, /unknown option 'coerceType' — did you mean 'coerceTypes'\?/],
    ['a far unknown option', { zzzzzzzzzz: true }, /unknown option 'zzzzzzzzzz'; the options are useDefaults, removeAdditional, coerceTypes, trimStrings, coerceJsonText\n/],
    ['a number switch', { coerceTypes: 1 }, /'coerceTypes' must be true, false or the name of a schema annotation/],
    ['an empty annotation', { useDefaults: '' }, /'useDefaults' must be true, false or the name of a schema annotation/],
    ['a null switch', { trimStrings: null }, /'trimStrings' must be true, false or the name of a schema annotation/],
    ['an object switch', { coerceTypes: { 'x-coerce': true } }, /'coerceTypes' must be true, false or the name of a schema annotation/],
    ['a string removeAdditional', { removeAdditional: 'x-strip' }, /'removeAdditional' must be true, false or 'all'/],
  ];
  for (const [label, config, message] of bad) {
    it(`refuses ${label} with exit 2 and writes nothing`, () => {
      const result = run(config);
      assert.strictEqual(result.status, 2, result.stderr);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stderr, /\n\s+at |node:fs|file:\/\//);
      assert.strictEqual(result.stdout, '');
      assert.strictEqual(result.written, null);
    });
  }

  for (const option of ['useDefaults', 'coerceTypes', 'trimStrings', 'coerceJsonText']) {
    for (const text of ['true', 'false']) {
      it(`refuses the string "${text}" for ${option}, naming the key and the expected type`, () => {
        const result = run({ [option]: text });
        assert.strictEqual(result.status, 2, result.stderr);
        assert.match(result.stderr, new RegExp(`config .*config\\.json: '${option}' is the string "${text}" but must be a boolean, true or false, or the name of a schema annotation: write ${text} without quotes`));
        assert.strictEqual(result.stdout, '');
        assert.strictEqual(result.written, null);
      });
    }
  }

  it('refuses a config file that does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
      const result = spawnSync(process.execPath, [CLI, '--schema', path.join(dir, 'schema.json'),
        '--out', path.join(dir, 'out'), '--config', path.join(dir, 'missing.json')], { encoding: 'utf8' });
      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /config .*missing\.json: ENOENT/);
      assert.strictEqual(fs.existsSync(path.join(dir, 'out')), false);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses --config without a value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-emit-config-'));
    try {
      const result = spawnSync(process.execPath, [CLI, '--schema', 'x.json', '--out', path.join(dir, 'out'), '--config'], { encoding: 'utf8' });
      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /--config requires a value/);
      assert.strictEqual(fs.existsSync(path.join(dir, 'out')), false);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  for (const [flag, option] of [['--defaults', 'useDefaults'], ['--coerce', 'coerceTypes']]) {
    for (const value of [true, false, 'x-' + option]) {
      it(`refuses ${flag} beside a config that sets ${option} to ${JSON.stringify(value)}`, () => {
        const result = run({ [option]: value }, [flag]);
        assert.strictEqual(result.status, 2, result.stderr);
        assert.match(result.stderr, new RegExp(`${flag} and the '${option}' of .*config\\.json both set it: give it in one place`));
        assert.strictEqual(result.written, null);
      });
    }
  }
});
