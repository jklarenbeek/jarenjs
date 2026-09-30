import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rootPackage = readPackage(rootFile);
  const requested = process.argv[2];
  const pinOnly = requested === 'pin';
  const nextVersion = pinOnly ? rootPackage.version : resolveVersion(rootPackage.version, requested);
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
      if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value ?? ''))
        return value;
      throw new Error('Usage: node scripts/version-packages.js patch|minor|major|<version>|pin');
  }
}
