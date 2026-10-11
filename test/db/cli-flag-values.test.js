//@ts-check
/**
 * @file A flag that takes a value and is not given one is refused by name, on
 * every command: it is never stored as an absent option (a leaked TypeError,
 * or a silent default such as the snapshot written beside the model), and a
 * flag placed where its value belongs is never taken for the value (`--out
 * --id x` would name a file `--id`). `documents` answers exit 2, the older
 * commands the exit 1 their contract uses for a bad command line; the history
 * commands' own check answers 2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempDirectory } from './helpers.js';

const CLI = resolve('packages/db/src/cli.js');
const MODEL = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };

describe('jaren-db: a value flag without a value', () => {
  /** @type {[string[], number, string][]} */
  const cases = [
    [['status', '--model', 'model.json', '--store'], 1, '--store'],
    [['check', '--model', 'model.json', '--store', ':memory:', '--migrations'], 1, '--migrations'],
    [['shape', '--model'], 1, '--model'],
    [['plan', '--from', 'model.json', '--to'], 1, '--to'],
    [['snapshot', '--model', 'model.json', '--snapshot'], 1, '--snapshot'],
    [['snapshot', '--model', 'model.json', '--types', '--snapshot', 'snap.json'], 1, '--types'],
    [['plan', '--model', 'model.json', '--out', '--id', 'x'], 1, '--out'],
    [['apply', '--store', ':memory:', '--baseline', '--migrations', 'mig'], 1, '--baseline'],
    [['documents', '--migrations', 'mig', '--in', 'in.json', '--check', '--max-rows'], 2, '--max-rows'],
    [['documents', '--migrations', 'mig', '--in', 'in.json', '--check', '--collection'], 2, '--collection'],
    [['documents', '--migrations', 'mig', '--in', 'in.json', '--out', '--check'], 2, '--out'],
  ];
  for (const [args, status, flag] of cases) {
    it(`${args.join(' ')} exits ${status} naming ${flag}, and writes nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'jaren-db-flag-values-'));
      try {
        writeFileSync(join(dir, 'model.json'), JSON.stringify(MODEL));
        writeFileSync(join(dir, 'in.json'), '[]');
        const result = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args],
          { encoding: 'utf8', cwd: dir, input: '' });
        assert.equal(result.stderr, `jaren-db: ${flag} needs a value\n`);
        assert.equal(result.status, status);
        assert.equal(result.stdout, '');
        assert.deepEqual(readdirSync(dir).sort(), ['in.json', 'model.json'], 'no snapshot, no file named for a flag');
      }
      finally { removeTempDirectory(dir); }
    });
  }
});
