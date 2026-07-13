import { glob } from 'glob';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DEFAULT_GLOB_CDW = './benchmark/';

/**
 * 
 * @param {string} basePath 
 * @param {string | undefined} baseUri 
 * @returns 
 */
function resolveJson(basePath, baseUri = undefined) {
  return (store, filePath) => {
    const fileBase = filePath.replace(basePath, '');
    const id = baseUri
      ? new URL(fileBase, baseUri).href
      : fileBase;
    store[id] = require(`./${filePath}`);
    return store;
  };
};

export async function loadRemoteJson(draft) {
  // Load ALL remotes, including every draft-specific directory, so that
  // cross-draft references (e.g. a draft2019-09 schema referencing
  // http://localhost:1234/draft2020-12/prefixItems.json) can resolve.
  // Draft directories map to distinct URL prefixes, so there are no
  // id collisions with the base remotes. draft-next is excluded because
  // no validator ships meta-schemas for the unreleased spec draft.
  const getRemoteFiles = async () => await glob(
    'suite/remotes/**/*.json',
    { cwd: DEFAULT_GLOB_CDW, ignore: '**/draft-next/**/*.json' }
  );
  return (await getRemoteFiles())
    .reduce(resolveJson('suite/remotes/', 'http://localhost:1234'), {});
}

export async function loadTestSuiteJson(draft) {
  const getTestSuiteFiles = async (version) => await glob(
    `suite/tests/${version}/**/*.json`,
    { cwd: DEFAULT_GLOB_CDW }
  );

  const testFiles = (await getTestSuiteFiles(draft))
    .reduce(resolveJson(`suite/tests/${draft}`), {});
  return testFiles;
}
