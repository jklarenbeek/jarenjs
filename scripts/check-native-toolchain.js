//@ts-check
/**
 * The native toolchain probe: after a clean install, THIS platform's native
 * packages for the build tools must actually be on disk.
 *
 * The lock portability gate proves the lock's structure; this proves the
 * materialization the current machine just did. The failure it exists to
 * catch surfaced on a Windows runner: `npm ci` succeeded, and the first
 * evidence of the pruned lock was TypeScript's launcher dying mid-build with
 * "Unable to resolve @typescript/typescript-win32-x64".
 *
 * The expected package is DERIVED, never hard-coded: each probed tool's own
 * manifest declares its per-platform fan-out in `optionalDependencies`, and
 * the entry for this machine is whichever key names `process.platform` and
 * `process.arch`. Rollup ships `-gnu` and `-musl` variants for Linux, so the
 * requirement is "at least one matching candidate resolves", not a specific
 * spelling. A tool that is not installed at all is skipped — this probes the
 * platform completeness of what the lock DID install, not the dependency
 * list. Optional peers (Lightning CSS) are exactly such a skip.
 *
 * Usage: node scripts/check-native-toolchain.js [tool ...]
 *        (default: typescript rollup esbuild)
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const resolveFromRoot = createRequire(join(ROOT, 'package.json'));

const tools = process.argv.length > 2
  ? process.argv.slice(2)
  : ['typescript', 'rollup', 'esbuild'];

const platform = process.platform;
const arch = process.arch;

let failures = 0;
console.log(`Native toolchain probe (${platform}-${arch})`);

for (const tool of tools) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(
      resolveFromRoot.resolve(`${tool}/package.json`), 'utf8'));
  }
  catch (_e) {
    console.log(`  · ${tool} is not installed here; nothing to probe`);
    continue;
  }

  const optionals = Object.keys(manifest.optionalDependencies ?? {});
  const candidates = optionals.filter((name) =>
    name.includes(platform) && name.includes(arch));

  if (candidates.length === 0) {
    if (optionals.length === 0) {
      console.log(`  · ${tool}@${manifest.version} declares no per-platform optionals`);
      continue;
    }
    failures += 1;
    console.error(`  ✗ ${tool}@${manifest.version} declares no candidate for `
      + `${platform}-${arch} — unsupported platform?`);
    continue;
  }

  const found = candidates.find((name) => {
    try {
      resolveFromRoot.resolve(`${name}/package.json`);
      return true;
    }
    catch (_e) {
      return false;
    }
  });
  if (found !== undefined) {
    console.log(`  ✓ ${tool}@${manifest.version} -> ${found}`);
  }
  else {
    failures += 1;
    console.error(`  ✗ ${tool}@${manifest.version}: none of `
      + `[${candidates.join(', ')}] is installed — the lock or the install `
      + 'lost this platform\'s native package');
  }
}

if (failures > 0) {
  console.error(`\n${failures} native package probe(s) failed. Reinstall with `
    + '`npm ci --include=optional` under the pinned npm; if that does not '
    + 'restore them, the lock itself is pruned (run test:lock).');
  process.exit(1);
}
console.log('\nNative toolchain probe passed.');
