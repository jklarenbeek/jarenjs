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

// run only as a CLI: importing the lists (the drift gate) bumps nothing
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rootPackage = readPackage(rootFile);
  const requested = process.argv[2];
  const nextVersion = resolveVersion(rootPackage.version, requested);
  const packageNames = new Set(packageFiles.map((file) => readPackage(file).name));

  const updateInternalRanges = (dependencies) => {
    if (dependencies == null) return;
    for (const name of Object.keys(dependencies)) {
      if (packageNames.has(name))
        dependencies[name] = `^${nextVersion}`;
    }
  };

  for (const file of [rootFile, ...packageFiles]) {
    const manifest = readPackage(file);
    manifest.version = nextVersion;
    updateInternalRanges(manifest.dependencies);
    updateInternalRanges(manifest.devDependencies);
    updateInternalRanges(manifest.peerDependencies);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  for (const file of rangeOnlyFiles) {
    const manifest = readPackage(file);
    updateInternalRanges(manifest.dependencies);
    updateInternalRanges(manifest.devDependencies);
    updateInternalRanges(manifest.peerDependencies);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  console.log(`Set all publishable Jaren packages to ${nextVersion}.`);
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
      throw new Error('Usage: node scripts/version-packages.js patch|minor|major|<version>');
  }
}
