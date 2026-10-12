//@ts-check
/**
 * @file A flag only some other command reads is refused by name, not taken
 * and ignored: `snapshot --out file` once wrote the default snapshot beside
 * the model (the committed one, advanced without a plan), `shape --store`
 * read no store, and `apply --check` applied. `documents` and the history
 * commands answer exit 2, the older commands the exit 1 their contract uses
 * for a bad command line. Every flag a command reads still works.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };

/** @param {string[]} args @param {(dir: string) => void} [before] */
const run = (args, before = undefined) => {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-flag-sets-'));
  try {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(MODEL));
    writeFileSync(join(dir, 'in.json'), '[]');
    before?.(dir);
    const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
      { encoding: 'utf8', cwd: dir, input: '' });
    return { ...result, files: readdirSync(dir).sort(), read: (/** @type {string} */ name) => readFileSync(join(dir, name), 'utf8') };
  }
  finally { removeTempDirectory(dir); }
};

describe('jaren-db: a flag another command reads', () => {
  /** @type {[string[], number, string][]} */
  const cases = [
    [['snapshot', '--model', 'model.json', '--out', 'copy.json'], 1, 'snapshot does not take \'--out\''],
    [['shape', '--model', 'model.json', '--store', ':memory:'], 1, 'shape does not take \'--store\''],
    [['status', '--model', 'model.json', '--store', ':memory:', '--check'], 1, 'status does not take \'--check\''],
    [['check', '--model', 'model.json', '--store', ':memory:', '--dry-run'], 1, 'check does not take \'--dry-run\''],
    [['plan', '--from', 'model.json', '--to', 'model.json', '--yes'], 1, 'plan does not take \'--yes\''],
    [['plan', '--from', 'model.json', '--to', 'model.json', '--types', 't.d.ts'], 1, 'plan does not take \'--types\''],
    [['apply', '--store', ':memory:', '--baseline', 'model.json', '--migrations', '.', '--check'], 1, 'apply does not take \'--check\''],
    [['apply', '--store', ':memory:', '--baseline', 'model.json', '--migrations', '.', '--out', 'x'], 1, 'apply does not take \'--out\''],
    [['documents', '--migrations', '.', '--in', 'in.json', '--check', '--dry-run'], 2, 'documents does not take \'--dry-run\''],
    [['documents', '--migrations', '.', '--in', 'in.json', '--check', '--store', 'x.db'], 2, 'documents does not take \'--store\''],
    [['history', '--store', ':memory:', '--model', 'model.json'], 2, 'history does not take \'--model\''],
    [['adopt-history', '--store', ':memory:', '--out', 'x'], 2, 'adopt-history does not take \'--out\''],
    [['shape', '--model', 'model.json', '--observed', 'o.json'], 2, '--observed is only used by adopt-history'],
  ];
  for (const [args, status, message] of cases) {
    it(`${args.join(' ')} exits ${status}: ${message}, and writes nothing`, () => {
      const result = run(args);
      assert.equal(result.stderr, `jaren-db: ${message}\n`);
      assert.equal(result.status, status);
      assert.equal(result.stdout, '');
      assert.deepEqual(result.files, ['in.json', 'model.json']);
    });
  }

  it('a flag no command reads is still an unknown option', () => {
    const result = run(['shape', '--model', 'model.json', '--bogus']);
    assert.equal(result.stderr, 'jaren-db: unknown option: --bogus\n');
    assert.equal(result.status, 1);
  });

  it('the flags a command reads still work, and --help is every command\'s', () => {
    const snapshot = run(['snapshot', '--model', 'model.json', '--snapshot', 'snap.json']);
    assert.equal(snapshot.status, 0);
    assert.match(snapshot.stdout, /^wrote snap\.json /);
    const status = run(['status', '--model', 'model.json', '--store', ':memory:', '--baseline', 'model.json']);
    assert.equal(status.status, 0, status.stderr);
    for (const command of ['plan', 'snapshot', 'status', 'check', 'apply', 'shape', 'history', 'adopt-history', 'documents']) {
      const help = run([command, '--help']);
      assert.equal(help.status, 0, command);
      assert.match(help.stdout, /^jaren-db — model-driven SQLite migrations/, command);
    }
  });

  it('snapshot --out no longer writes the default snapshot beside the model', () => {
    const result = run(['snapshot', '--model', 'model.json', '--out', 'model.snapshot.json']);
    assert.equal(result.status, 1);
    assert.ok(!result.files.includes('model.snapshot.json'), 'the default snapshot was not written beside the model');
  });
});
