import { readFileSync, writeFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.js';

/**
 * The publishable manifests this script bumps — a hand-maintained list.
 * Exported so `test/scripts/version-packages.test.js` holds it equal to
 * the non-private workspaces of the root `package.json` (a new workspace
 * registered in `clean`/`pack:check`/`publish` but not here was silently
 * left behind once).
 */
export const packageFiles = [
  'packages/core/package.json',
  'packages/json/package.json',
  'packages/validate/package.json',
  'packages/formats/package.json',
  'packages/refs/package.json',
  'packages/emit/package.json',
  'packages/contract/package.json',
  'packages/forms/package.json',
  'packages/locales/package.json',
  'packages/view/package.json',
  'packages/app/package.json',
  'components/md/package.json',
  'components/mermaid/package.json',
  'components/calc/package.json',
  'components/charts/package.json',
  'components/collection/package.json',
  'components/rules/package.json',
  'components/studio/package.json',
  'components/play/package.json',
  'packages/josl/package.json',
  'packages/flow/package.json',
  'packages/linq/package.json',
  'packages/db/package.json',
];

// private workspaces that are never versioned but whose semver ranges on
// the publishable packages must keep tracking the release (website and
// benchmark use file:/absent ranges and need no updating)
export const rangeOnlyFiles = [];

/** The root manifest is bumped too (its version is the suite version). */
export const rootFile = 'package.json';

/** The dependency maps an internal `@jarenjs/*` edge can live in. */
export const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'];

/**
 * The semver.org grammar of a release or pre-release version (build metadata
 * is not taken): numeric parts and numeric pre-release identifiers carry no
 * leading zero, and no identifier is empty.
 */
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/**
 * Rewrite every internal edge of one dependency map to the suite version,
 * exactly — never a range. The suite is released in lockstep (every
 * package at one version, every release), so a caret bought nothing and
 * let a consumer's resolution mix two releases' packages in one closure;
 * an exact edge makes a consumer's direct pins decide the whole closure
 * (docs/CONSUMING.md). `peerDependenciesMeta` is not a dependency map and
 * is never touched, so an optional peer stays optional.
 * @param {Record<string, string> | undefined} dependencies - one of a manifest's `dependencyFields`
 * @param {ReadonlySet<string>} names - the publishable package names
 * @param {string} version - the suite version
 * @returns {number} how many edges changed
 */
export function updateInternalRanges(dependencies, names, version) {
  if (dependencies == null) return 0;
  let changed = 0;
  for (const name of Object.keys(dependencies)) {
    if (!names.has(name) || dependencies[name] === version) continue;
    dependencies[name] = version;
    changed += 1;
  }
  return changed;
}

// run only as a CLI: importing the lists (the drift gate) bumps nothing.
//   node scripts/version-packages.js patch|minor|major|<version>
//     sets every manifest's version and every internal edge to it;
//   node scripts/version-packages.js pin
//     rewrites every internal edge to the root's current version and changes
//     no version — for a tree whose edges drifted from the version it carries.
//   A refused target (a downgrade, the current version, a non-version) exits 2
//   before anything is written.
if (isMainModule(import.meta.url)) {
  const rootPackage = readPackage(rootFile);
  const requested = process.argv[2];
  const pinOnly = requested === 'pin';
  let nextVersion;
  try {
    nextVersion = pinOnly ? rootPackage.version : resolveVersion(rootPackage.version, requested);
  }
  catch (error) {
    console.error(`version-packages: ${/** @type {Error} */ (error).message}`);
    process.exit(2);
  }
  const packageNames = new Set(packageFiles.map((file) => readPackage(file).name));
  let changed = 0;

  for (const file of [rootFile, ...packageFiles]) {
    const manifest = readPackage(file);
    if (!pinOnly) manifest.version = nextVersion;
    for (const field of dependencyFields) changed += updateInternalRanges(manifest[field], packageNames, nextVersion);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const file of rangeOnlyFiles) {
    const manifest = readPackage(file);
    for (const field of dependencyFields) changed += updateInternalRanges(manifest[field], packageNames, nextVersion);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(pinOnly
    ? `Pinned ${changed} internal edge${changed === 1 ? '' : 's'} to ${nextVersion}; no version changed.`
    : `Set all publishable Jaren packages to ${nextVersion} (${changed} internal edge${changed === 1 ? '' : 's'} rewritten).`);
}

function readPackage(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveVersion(current, value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (match == null)
    throw new Error(`Cannot increment non-standard version '${current}'.`);

  const [, majorText, minorText, patchText] = match;
  let major = Number(majorText);
  let minor = Number(minorText);
  let patch = Number(patchText);

  switch (value) {
    case 'patch':
      patch += 1;
      return `${major}.${minor}.${patch}`;
    case 'minor':
      minor += 1;
      return `${major}.${minor}.0`;
    case 'major':
      major += 1;
      return `${major}.0.0`;
    default:
      if (value === undefined)
        throw new Error('Usage: node scripts/version-packages.js patch|minor|major|<version>|pin');
      if (!SEMANTIC_VERSION.test(value)) {
        throw new Error(`'${value}' is not a semantic version x.y.z[-pre] (no leading zeros, no empty identifiers). `
          + 'Usage: node scripts/version-packages.js patch|minor|major|<version>|pin');
      }
      // a release only moves forward: an equal version would publish over
      // the current one, and a pre-release of it sorts before it
      if (compareVersions(value, current) <= 0)
        throw new Error(`refusing ${value}: a release must be greater than the current ${current}`);
      return value;
  }
}

/**
 * Semantic-version precedence (semver.org §11) of two `x.y.z[-pre]`
 * versions: negative when `a` sorts first, positive when `b` does, zero when
 * they are equal. A pre-release sorts before its release; pre-release
 * identifiers compare numerically when both are numeric, numbers before
 * words, and a shorter list before a longer one it prefixes.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const split = (/** @type {string} */ version) => {
    const at = version.indexOf('-');
    return { core: (at < 0 ? version : version.slice(0, at)).split('.').map(Number), pre: at < 0 ? null : version.slice(at + 1).split('.') };
  };
  const left = split(a), right = split(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  if (left.pre === null || right.pre === null) return left.pre === right.pre ? 0 : left.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) { if (Number(x) !== Number(y)) return Number(x) - Number(y); }
    else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
