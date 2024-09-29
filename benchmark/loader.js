import { glob } from 'glob';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

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
      ? new URL(fileBase, 'http://localhost:1234').href
      : fileBase;
    store[id] = require(`./${filePath}`);
    return store;
  };
};

export async function loadRemoteJson(draft) {

  const getBaseRemoteFiles = async () => await glob(
    'suite/remotes/**/*.json',
    { cwd: './benchmark/', ignore: '**/draft*/**/*.json' }
  );
  const baseRemotes = (await getBaseRemoteFiles())
    .reduce(resolveJson('suite\\remotes\\', 'http://localhost:1234'), {});

  const getDraftRemoteFiles = async (version) => await glob(
    `suite/remotes/${version}/**/*.json`,
    { cwd: './benchmark/' }
  );
  const draftRemotes = (await getDraftRemoteFiles(draft))
    .reduce(resolveJson(`suite\\remotes\\${draft}`, 'http://localhost:1234'), {});

  return { ...baseRemotes, ...draftRemotes };
}

export async function loadTestSuiteJson(draft) {
  const getTestSuiteFiles = async (version) => await glob(
    `suite/tests/${version}/**/*.json`,
    { cwd: './benchmark/' }
  );

  const testFiles = (await getTestSuiteFiles(draft))
    .reduce(resolveJson(`suite/tests/${draft}`), {});
  return testFiles;
}
