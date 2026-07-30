//@ts-check
/**
 * The lock portability gate.
 *
 * npm 10's lock writer prunes the optional platform packages of OTHER
 * platforms when it rewrites `package-lock.json` (npm/cli#7961, fixed in npm
 * 11.3): a lock regenerated on Linux quietly loses
 * `@typescript/typescript-win32-x64`, the Windows Rollup/esbuild natives and
 * friends, and the first machine to notice is a Windows runner whose `tsc`
 * cannot find its own executable. That defect class is structural and
 * provable from the lock alone, so it is checked here — before any install,
 * with nothing but Node built-ins.
 *
 * The rule: **every exact-version `optionalDependencies` entry declared by a
 * package record in the lock must itself have a lock record** for that
 * name/version pair. Exact pins are how the native-binary vendors (esbuild,
 * Rollup, TypeScript, Lefthook, Turbo, ...) declare their per-platform
 * packages, and an exact pin the lock cannot satisfy on some platform is
 * exactly the hole the pruner leaves. Nothing here hard-codes a vendor list
 * or a record count — a hard-coded list would miss the next native tool.
 *
 * Ranged optionals (`fsevents: ~2.3.2`) and optional PEERS (Lightning CSS
 * under Vite) are deliberately out of scope: the former are not per-platform
 * binary fan-outs, and the latter are absent from a correct graph unless the
 * root asks for them.
 *
 * This gate proves lock STRUCTURE. It does not replace installing on real
 * platforms, which is what the CI matrix and the native toolchain probe do.
 *
 * Usage: node scripts/check-lock-portability.js [path/to/package-lock.json]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = process.argv[2] ?? join(ROOT, 'package-lock.json');

/** A version that is one exact release, not a range. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The package name of a lockfile `packages` key: the part after the last
 * `node_modules/`. The root record ('') and workspace paths have no
 * `node_modules/` and answer null. */
function nameOfKey(key) {
  const at = key.lastIndexOf('node_modules/');
  return at === -1 ? null : key.slice(at + 'node_modules/'.length);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const packages = lock.packages ?? {};

/** Every name@version pair the lock can materialize. */
const present = new Set();
for (const [key, record] of Object.entries(packages)) {
  const name = nameOfKey(key);
  if (name !== null && typeof record.version === 'string')
    present.add(`${name}@${record.version}`);
}

let missing = 0;
for (const [key, record] of Object.entries(packages)) {
  const optionals = record.optionalDependencies;
  if (optionals === undefined) continue;
  const parent = nameOfKey(key) ?? key ?? '(root)';
  const parentVersion = typeof record.version === 'string' ? `@${record.version}` : '';
  for (const [name, wanted] of Object.entries(optionals)) {
    if (typeof wanted !== 'string' || !EXACT_VERSION.test(wanted)) continue;
    if (present.has(`${name}@${wanted}`)) continue;
    missing += 1;
    console.error(`  ✗ ${parent}${parentVersion} declares optional ${name}@${wanted}, `
      + 'but the lock has no record for it');
  }
}

if (missing > 0) {
  console.error(`\n${missing} exact optional dependenc${missing === 1 ? 'y is' : 'ies are'} `
    + 'missing from the lock. The lock was probably rewritten by an npm older '
    + 'than 11.3 (npm/cli#7961), which prunes other platforms\' native '
    + 'packages. Repair it with the pinned npm (see package.json '
    + '"packageManager") from the last complete baseline; do not hand-edit.');
  process.exit(1);
}
console.log(`Lock portability gate passed: every exact optional dependency in `
  + `${Object.keys(packages).length} lock records is materializable.`);
