//@ts-check
/**
 * @file One answer to "was this script run as a program?" for every script.
 *
 * `isMainModule` resolves both `process.argv[1]` and the module's own file to
 * their real paths, so a script run directly, by a relative path or through a
 * symbolic link runs its command-line half, a module another one imports does
 * not, and node given no script file (`node -e`) runs nobody's. The drift
 * half keeps the unresolved spellings from coming back: they compare a
 * symbolic link unequal and turn a gate run through one into a silent exit 0,
 * so no other file under `scripts/` reads `process.argv[1]` itself.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { globSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../../scripts/lib/main-module.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HELPER = new URL('../../scripts/lib/main-module.js', import.meta.url).href;
const MARKER = 'ran as the program';

/** Run node with `args` from `cwd`. @param {string[]} args @param {string} [cwd] */
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });

describe('isMainModule decides on real paths', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'jaren-main-module-'));
    // the helper by its absolute file URL: a temporary directory has no package to resolve it from
    writeFileSync(join(dir, 'program.mjs'), `import { isMainModule } from ${JSON.stringify(HELPER)};\n`
      + `if (isMainModule(import.meta.url)) process.stdout.write(${JSON.stringify(MARKER)});\n`);
    writeFileSync(join(dir, 'importer.mjs'), 'import \'./program.mjs\';\nprocess.stdout.write(\'imported\');\n');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the program it is, by an absolute and by a relative path', () => {
    for (const result of [node([join(dir, 'program.mjs')]), node(['./program.mjs'], dir)]) {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, MARKER);
    }
  });

  it('runs the program it is through a symbolic link, which node resolves before loading it', (t) => {
    const link = join(dir, 'link.mjs');
    try { symlinkSync(join(dir, 'program.mjs'), link); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') throw error;
      t.skip('this host does not let an unprivileged user create a symbolic link');
      return;
    }
    const result = node([link]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, MARKER);
  });

  it('does not run a module another module imports', () => {
    const result = node([join(dir, 'importer.mjs')]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, 'imported');
  });

  it('is false when node runs no script file, even for a module that exists', () => {
    const result = node(['--input-type=module', '-e', `import { isMainModule } from ${JSON.stringify(HELPER)};\n`
      + 'process.stdout.write(JSON.stringify({ argv1: process.argv[1] ?? null, '
      + `own: isMainModule(import.meta.url), helper: isMainModule(${JSON.stringify(HELPER)}) }));`]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { argv1: null, own: false, helper: false });
  });

  it('answers false instead of throwing for what it cannot resolve', () => {
    for (const url of ['not a url', 'data:text/javascript,', 'https://example.com/program.js',
      new URL('does-not-exist.mjs', import.meta.url).href, /** @type {any} */ (undefined)])
      assert.strictEqual(isMainModule(url), false, String(url));
  });
});

describe('the scripts decide it one way', () => {
  it('leaves process.argv[1] to scripts/lib/main-module.js alone', () => {
    const reads = /process\.argv\s*(?:\[\s*1\s*\]|\.at\(\s*1\s*\))/;
    const offenders = globSync('scripts/**/*.{js,mjs,cjs}', { cwd: ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => file !== 'scripts/lib/main-module.js')
      .flatMap((file) => readFileSync(join(ROOT, file), 'utf8').split('\n')
        .flatMap((line, index) => (reads.test(line) ? [`${file}:${index + 1}`] : [])))
      .sort();
    assert.deepStrictEqual(offenders, [], 'these read process.argv[1] themselves; decide it with '
      + `isMainModule(import.meta.url) from scripts/lib/main-module.js instead:\n  ${offenders.join('\n  ')}`);
  });
});
