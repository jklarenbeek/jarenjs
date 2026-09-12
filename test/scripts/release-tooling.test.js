//@ts-check
/**
 * @file The close-out tooling, checked where it decides rather than where
 * it acts: the bump's npm-pin refusal, the deploy guard's reading of a
 * dirty artifact, and the live verifier's comparison — each a pure
 * function beside the command that runs it, so the refusals are proven
 * without bumping a version or publishing a site.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { npmMismatch, pinnedNpm, resolveNpmCommand, bump } from '../../scripts/release-bump.js';
import { npmCliPath } from '../../scripts/lib/portable.js';
import { checkBenchmarkDrift } from '../../scripts/check-benchmark-drift.js';
import { verifyLiveSite } from '../../scripts/verify-live-site.js';
import { checkDocuments, fencesOf } from '../../scripts/check-documents.js';
import { checkSiteDesign, BANNED_HUES } from '../../scripts/check-site-design.js';

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

describe('release:bump refuses an npm that is not the pinned one', function () {
  it('reads the pin from the root manifest', function () {
    assert.strictEqual(pinnedNpm(), JSON.parse(read('package.json')).packageManager.slice(4));
  });

  it('passes the pinned version and refuses every other', function () {
    const pin = pinnedNpm();
    assert.strictEqual(npmMismatch(`${pin}\n`, pin), null);
    const refusal = npmMismatch('10.0.0\n', pin);
    assert.ok(refusal !== null, 'a different npm is refused');
    // the lockfile shape is the reason, and the fix is one command
    assert.match(refusal, new RegExp(`npm i -g npm@${pin.replace(/\./g, '\\.')}`));
    assert.match(refusal, /lockfile/);
  });
});

describe('release:bump runs the npm that launched it, through the current Node', function () {
  const env = (execpath) => (execpath === undefined ? {} : { npm_execpath: execpath });

  it('resolves the executing CLI to an argument vector — POSIX and Windows paths with spaces intact', function () {
    const posix = resolveNpmCommand(env('/home/a user/.nvm/versions/node/v24.19.0/lib/node_modules/npm/bin/npm-cli.js'), '/home/a user/.nvm/versions/node/v24.19.0/bin/node');
    assert.deepStrictEqual(posix, { file: '/home/a user/.nvm/versions/node/v24.19.0/bin/node',
      prefix: ['/home/a user/.nvm/versions/node/v24.19.0/lib/node_modules/npm/bin/npm-cli.js'] });
    const windows = resolveNpmCommand(env('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'), 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepStrictEqual(windows, { file: 'C:\\Program Files\\nodejs\\node.exe',
      prefix: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'] });
    assert.strictEqual(npmCliPath(env('/x/npm-cli.js')), '/x/npm-cli.js');
  });

  it('refuses a missing or foreign executing CLI, naming the invocation that supplies one', function () {
    for (const [label, e] of [['unset', env(undefined)], ['pnpm', env('/x/pnpm/bin/pnpm.cjs')], ['a shim', env('/usr/bin/npm')]]) {
      const command = resolveNpmCommand(e, '/usr/bin/node');
      assert.ok('refusal' in command, `${label}: refused`);
      assert.match(command.refusal, /npm run release:bump/);
      assert.strictEqual(npmCliPath(e), null);
    }
  });

  it('never spells npm by name, a shell, or a command string', function () {
    const source = read('scripts/release-bump.js');
    assert.ok(!/execSync\(/.test(source), 'no shell command string');
    assert.ok(!/shell:\s*true/.test(source), 'no shell');
    assert.ok(!/execFileSync\('npm/.test(source) && !/'npm\.cmd'/.test(source), 'no bare npm');
    assert.match(source, /npmCliPath/, 'the executing CLI comes from the one portable helper');
  });

  it('runs the whole sequence through an injected executor: version → install → lock test → build, nothing before both refusals pass', function () {
    const calls = [];
    const pin = pinnedNpm();
    const exec = (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      if (args[1] === '--version') return `${pin}\n`;
      return '';
    };
    const logs = [];
    const code = bump({ release: 'minor', env: env('/opt/npm with space/npm-cli.js'), execPath: '/opt/node dir/node', exec, log: (l) => logs.push(l), error: (l) => logs.push(l) });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(calls.map((c) => [c.file, ...c.args]), [
      ['/opt/node dir/node', '/opt/npm with space/npm-cli.js', '--version'],
      ['/opt/node dir/node', './scripts/version-packages.js', 'minor'],
      ['/opt/node dir/node', '/opt/npm with space/npm-cli.js', 'install'],
      ['/opt/node dir/node', '/opt/npm with space/npm-cli.js', 'run', 'test:lock'],
      ['/opt/node dir/node', '/opt/npm with space/npm-cli.js', 'run', 'build'],
    ]);
    assert.ok(calls.every((c) => c.cwd.length > 0), 'every step runs from the repository root');
    // a mismatched npm: refused before the first write
    const mismatched = [];
    const code2 = bump({ release: 'patch', env: env('/x/npm-cli.js'), execPath: '/x/node',
      exec: (file, args) => { mismatched.push(args); return '10.0.0\n'; }, log: () => {}, error: () => {} });
    assert.strictEqual(code2, 2);
    assert.deepStrictEqual(mismatched, [['/x/npm-cli.js', '--version']], 'only the version probe ran');
    // a missing CLI: refused before anything runs at all
    const nothing = [];
    assert.strictEqual(bump({ release: 'patch', env: env(undefined), execPath: '/x/node', exec: () => { nothing.push(1); return ''; }, log: () => {}, error: () => {} }), 2);
    assert.deepStrictEqual(nothing, []);
    // an unknown release word
    assert.strictEqual(bump({ release: 'huge', env: env('/x/npm-cli.js'), execPath: '/x/node', exec: () => { nothing.push(1); return ''; }, log: () => {}, error: () => {} }), 2);
    assert.deepStrictEqual(nothing, []);
  });
});

describe('the deploy guard reads the tracked measurements of a checkout', function () {
  /** A disposable git repository carrying one tracked benchmark artifact at HEAD. */
  function repository() {
    const root = mkdtempSync(join(tmpdir(), 'jaren-drift-'));
    // the host's global and system git configuration must not reach the
    // fixture: a `commit.gpgsign` would fail the commit, a `core.excludesFile`
    // could hide the very artifact a test plants
    const config = join(root, 'empty-gitconfig');
    writeFileSync(config, '');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'test');
    const dir = join(root, 'packages', 'website', 'public', 'benchmarks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'alpha.json'), '{"rows":1}\n');
    writeFileSync(join(dir, 'beta.json'), '{"rows":2}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'measurements');
    return { root, dir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('is clean when the tracked artifacts equal HEAD', function () {
    const repo = repository();
    try {
      assert.deepStrictEqual(checkBenchmarkDrift({ root: repo.root }), { code: 0, changed: [] });
    }
    finally {
      repo.cleanup();
    }
  });

  it('names a modified, a deleted and an untracked artifact — registration is as unreviewed as drift until its commit', function () {
    const repo = repository();
    try {
      writeFileSync(join(repo.dir, 'alpha.json'), '{"rows":9}\n');
      unlinkSync(join(repo.dir, 'beta.json'));
      writeFileSync(join(repo.dir, 'gamma.json'), '{"rows":3}\n');
      const report = checkBenchmarkDrift({ root: repo.root });
      assert.strictEqual(report.code, 1);
      assert.deepStrictEqual([...report.changed].sort(), [
        'packages/website/public/benchmarks/alpha.json',
        'packages/website/public/benchmarks/beta.json',
        'packages/website/public/benchmarks/gamma.json',
      ]);
    }
    finally {
      repo.cleanup();
    }
  });

  it('names an ignored artifact and a path with a space — an ignore rule hides nothing from the deploy', function () {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, '.gitignore'), 'packages/website/public/benchmarks/local-*.json\n');
      writeFileSync(join(repo.dir, 'local-run.json'), '{"rows":5}\n');
      writeFileSync(join(repo.dir, 'two words.json'), '{"rows":6}\n');
      const report = checkBenchmarkDrift({ root: repo.root });
      assert.strictEqual(report.code, 1);
      assert.ok(report.changed.includes('packages/website/public/benchmarks/local-run.json'), `the ignored file is named: ${report.changed.join(', ')}`);
      assert.ok(report.changed.includes('packages/website/public/benchmarks/two words.json'), 'the spaced path is one unquoted path');
    }
    finally {
      repo.cleanup();
    }
  });

  it('reports a directory that is not a git checkout rather than passing it', function () {
    const report = checkBenchmarkDrift({ root: '/' });
    assert.strictEqual(report.code, 2);
  });

  it('runs on the deploy path before the build, and not inside npm test', function () {
    const website = JSON.parse(read('packages/website/package.json'));
    const predeploy = String(website.scripts.predeploy);
    assert.ok(predeploy.indexOf('check-benchmark-drift.js') < predeploy.indexOf('npm run build'),
      'predeploy refuses dirty measurements before it builds');
    // this suite asserts checkout-state behavior on disposable repositories only, so a
    // registered or remeasured suite can pass `npm test` before its commit
    assert.ok(!/checkBenchmarkDrift\(\)/.test(read('test/scripts/release-tooling.test.js')),
      'no test reads this checkout\'s own measurement state');
  });
});

describe('the live verifier compares the publish to this checkout', function () {
  /** A one-shot static server answering `build.json` with `body`. */
  async function serving(body) {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
  }

  const want = { version: '9.9.9', commit: 'a'.repeat(40) };

  it('verifies a live site carrying exactly this build', async function () {
    const site = await serving({ ...want, built: '2026-08-22T00:00:00+02:00' });
    const report = await verifyLiveSite({ url: site.url, want, timeoutMs: 5000 });
    site.close();
    assert.strictEqual(report.code, 0);
    assert.strictEqual(report.attempts, 1);
  });

  it('refuses a live site still serving the previous revision', async function () {
    const site = await serving({ version: want.version, commit: 'b'.repeat(40), built: 'x' });
    // the branch push is not the publish: a stale commit is the failure
    // this exists to catch, and it must not be retried into a pass
    const report = await verifyLiveSite({
      url: site.url, want, timeoutMs: 1, log: () => {}, wait: async () => {},
    });
    site.close();
    assert.strictEqual(report.code, 1);
    assert.match(report.problems[0], /commit: live bbbbbbb/);
  });

  it('refuses a site it cannot reach at all', async function () {
    const report = await verifyLiveSite({
      url: 'http://127.0.0.1:1/', want, timeoutMs: 1, log: () => {}, wait: async () => {},
    });
    assert.strictEqual(report.code, 1);
    assert.match(report.problems[0], /unreachable/);
  });
});

describe('the document gate', function () {
  it('parses every checkable fence in the committed markdown surface', function () {
    const report = checkDocuments();
    assert.deepStrictEqual(report.failures, []);
    assert.ok(report.mermaid >= 40, `expected the repo's mermaid fences, found ${report.mermaid}`);
    assert.ok(report.json >= 100, `expected the repo's json fences, found ${report.json}`);
  });

  it('walks every tracked or newly authored markdown document outside the fixtures', function () {
    // a gate that reports a file count and silently skips a document is
    // worse than no gate: the count is what a reader concludes coverage
    // from. `test/**` is the one deliberate exclusion — a fixture's job
    // is sometimes to be malformed.
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
      { cwd: fileURLToPath(root), encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).filter(file => existsSync(join(fileURLToPath(root), file)))
      .filter((file) => !file.startsWith('test/'));
    assert.strictEqual(checkDocuments().files, tracked.length,
      'the gate walks exactly the publishable markdown outside test fixtures');
  });

  it('reads an indented fence and its language, and reports the opener line', function () {
    const source = 'a\n\n  ```json\n  {}\n  ```\n\ntext\n\n```mermaid\nflowchart TD\n```\n';
    assert.deepStrictEqual(fencesOf(source).map((f) => [f.lang, f.line]),
      [['json', 3], ['mermaid', 9]]);
  });

  it('leaves a jsonc fence alone — notation never claimed to be a value', function () {
    assert.deepStrictEqual(fencesOf('```jsonc\n{ "$in": expr }\n```\n').map((f) => f.lang),
      ['jsonc']);
  });
});

describe('the design sweep', function () {
  it('finds no banned hue in the site source', function () {
    const report = checkSiteDesign();
    assert.deepStrictEqual(report.hits, []);
    assert.ok(report.files > 0, 'and it actually scanned something');
  });

  it('keeps the hue list in exactly one place', function () {
    // the list used to live in a grep command inside DESIGN.md; prose that
    // carries a value is prose that drifts from the value
    assert.ok(BANNED_HUES.length >= 13);
    for (const doc of ['docs/DESIGN.md', 'docs/workflow/CONVENTIONS.md']) {
      const text = read(doc);
      for (const hue of BANNED_HUES) {
        assert.ok(!text.includes(hue), `${doc} still carries the hue ${hue}; the script owns it`);
      }
    }
  });
});

describe('the packed-consumer extraction is implementation-neutral', function () {
  it('produces colon-free relative arguments from POSIX and Windows-shaped trees', async function () {
    const { tarExtractArgs, workRelative } = await import('../../scripts/lib/tar-extract-args.js');
    assert.deepStrictEqual(
      tarExtractArgs('/tmp/jaren-packed-x',
        '/tmp/jaren-packed-x/tarballs/jarenjs-core-1.0.0.tgz',
        '/tmp/jaren-packed-x/consumer/node_modules/@jarenjs/core'),
      ['-xzf', 'tarballs/jarenjs-core-1.0.0.tgz',
        '--strip-components=1', '-C', 'consumer/node_modules/@jarenjs/core']);
    const windowsArgs = tarExtractArgs('C:\\Users\\ci\\AppData\\Local\\Temp\\jaren-packed-x',
      'C:\\Users\\ci\\AppData\\Local\\Temp\\jaren-packed-x\\tarballs\\jarenjs-core-1.0.0.tgz',
      'C:\\Users\\ci\\AppData\\Local\\Temp\\jaren-packed-x\\consumer\\node_modules\\@jarenjs\\core');
    assert.deepStrictEqual(windowsArgs,
      ['-xzf', 'tarballs/jarenjs-core-1.0.0.tgz',
        '--strip-components=1', '-C', 'consumer/node_modules/@jarenjs/core']);
    assert.ok(windowsArgs.every((arg) => !arg.includes(':') && !arg.includes('\\')),
      'no argument carries a drive colon or a backslash for either tar brand to mangle');
    // a path outside the work tree is a defect in the caller, refused
    assert.throws(() => workRelative('/tmp/work', '/etc/passwd'), /not under/);
    assert.throws(() => workRelative('C:\\work', 'C:\\work\\..\\other'), /below/);
  });

  it('the gate carries no implementation-specific tar flag', function () {
    const script = read('scripts/check-packed-consumers.js');
    assert.ok(!script.includes('--force-local'),
      'bsdtar (the tar Windows ships) refuses --force-local by name');
    assert.match(script, /tarExtractArgs\(work,/,
      'extraction goes through the pure helper with the one working directory');
  });

  it('the produced arguments drive a real tar extraction', async function () {
    const { tarExtractArgs } = await import('../../scripts/lib/tar-extract-args.js');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync: readBack,
      existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const work = mkdtempSync(join(tmpdir(), 'jaren-tar-args-'));
    try {
      const packageDir = join(work, 'package');
      mkdirSync(join(packageDir, 'src'), { recursive: true });
      writeFileSync(join(packageDir, 'src', 'index.js'), 'export const ok = 1;\n');
      const tarball = join(work, 'tarballs', 'pkg-1.0.0.tgz');
      mkdirSync(join(work, 'tarballs'));
      execFileSync('tar', ['-czf', 'tarballs/pkg-1.0.0.tgz', 'package'], { cwd: work });
      const dest = join(work, 'consumer', 'node_modules', 'pkg');
      mkdirSync(dest, { recursive: true });
      execFileSync('tar', tarExtractArgs(work, tarball, dest), { cwd: work });
      assert.ok(existsSync(join(dest, 'src', 'index.js')), 'the stripped layout landed');
      assert.strictEqual(readBack(join(dest, 'src', 'index.js'), 'utf8'),
        'export const ok = 1;\n');
    }
    finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
