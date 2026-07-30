//@ts-check
/**
 * The portable launcher and containment helpers used by the release scripts.
 *
 * These exist because a consumer ran the release gate on native Windows and
 * two "obviously fine" idioms turned out to be platform fictions: launching
 * `npm`/`npx` by bare name (they are `.cmd` batch shims there, and the launch
 * failure read as "offline, skip"), and string-prefix path containment
 * (native realpaths carry drive letters and backslashes). The Windows rules
 * are pinned from every platform via the injectable path implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { win32, posix } from 'node:path';

import { isWithin, runNpm } from '../../scripts/lib/portable.js';

describe('isWithin — containment is path arithmetic, not a string prefix', () => {
  it('accepts POSIX paths inside the root, including the root itself', () => {
    assert.ok(isWithin('/repo', '/repo', posix));
    assert.ok(isWithin('/repo', '/repo/packages/core/package.json', posix));
    assert.ok(isWithin('/repo/', '/repo/packages', posix));
  });

  it('rejects POSIX paths outside the root', () => {
    // The classic prefix trap: '/repo-other' shares the prefix '/repo'.
    assert.ok(!isWithin('/repo', '/repo-other/package.json', posix));
    assert.ok(!isWithin('/repo', '/elsewhere/repo/package.json', posix));
    // Traversal that normalizes to an escape is an escape.
    assert.ok(!isWithin('/repo', '/repo/../escape', posix));
    assert.ok(!isWithin('/repo/packages', '/repo', posix));
    assert.ok(!isWithin('/repo', '/', posix));
  });

  it('accepts Windows drive-letter paths inside the root', () => {
    assert.ok(isWithin('D:\\a\\repo', 'D:\\a\\repo\\packages\\core\\package.json', win32));
    // Mixed separators are one path on Windows.
    assert.ok(isWithin('D:\\a\\repo', 'D:/a/repo/packages/core', win32));
    // Drive letters and path segments compare case-insensitively there.
    assert.ok(isWithin('C:\\Repo', 'c:\\repo\\x', win32));
    assert.ok(isWithin('D:\\a\\repo', 'D:\\a\\repo', win32));
  });

  it('rejects Windows paths outside the root', () => {
    assert.ok(!isWithin('D:\\a\\repo', 'D:\\a\\repo-other\\x', win32));
    // A different drive can never be inside: relative() yields an absolute
    // path there, which is the signal the helper reads.
    assert.ok(!isWithin('D:\\a\\repo', 'C:\\a\\repo\\x', win32));
    assert.ok(!isWithin('D:\\a\\repo', 'D:\\a', win32));
    assert.ok(!isWithin('D:\\a\\repo', 'D:\\a\\repo\\..\\escape', win32));
  });

  it('answers with the host rules when no implementation is given', () => {
    // The default must be the platform the release script actually runs on.
    assert.ok(isWithin(process.cwd(), process.cwd()));
  });
});

describe('runNpm — npm through its own JavaScript entry point', () => {
  it('runs npm and returns its stdout', () => {
    // Under `npm test`, npm_execpath is set and the primary route runs; the
    // assertion holds either way, which is exactly the portability claim.
    const out = runNpm(['--version']).trim();
    assert.match(out, /^\d+\.\d+\.\d+/,
      `expected an npm version, got: ${out}`);
  });

  it('throws loudly on a launch that cannot happen', () => {
    // A launch failure must never read as empty output: the dependency gate
    // treats missing output as a failure, and this is the other half of that
    // contract — the error is a throw, not a silent empty string. The route
    // is chosen from the ambient npm_execpath, so the test swaps it in place
    // and restores it.
    const saved = process.env.npm_execpath;
    process.env.npm_execpath = '/nowhere/does-not-exist-cli.js';
    try {
      assert.throws(() => runNpm(['--version'], { stdio: 'pipe' }));
    }
    finally {
      if (saved === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = saved;
    }
  });
});
