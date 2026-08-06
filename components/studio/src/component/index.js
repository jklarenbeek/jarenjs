//@ts-check
/**
 * @file The Studio COMPONENT — part two of the package: the IDE widget
 * (file rail, editor, run stage), its effects and its view model. The
 * chrome is authored in the next order; this factory exists now so the
 * `./component` export resolves and packs, and it already exposes the
 * engine surface a host reads at mount time (list files, validate one,
 * classify a change). The boundary is one-way: the component imports the
 * engine, never the reverse.
 */

import { describe, validateFile, classifyChange, parseProject } from '../index.js';

/**
 * Build the Studio component. The returned shape gains its `widget`,
 * `effects` and `viewModel` in the next order; today it hands back the
 * engine helpers a host binds against.
 * @param {{ operators?: { toOptions: () => any } }} [options] - a host
 *   operator registry threaded to the per-file validators
 * @returns {{ describe: (project: any) => any,
 *   validateFile: (file: any) => any,
 *   classifyChange: (a: any, b: any) => any,
 *   parseProject: (input: string | object) => any }}
 */
export function createStudioComponent(options = {}) {
  const operators = options.operators;
  return {
    describe: (project) => describe(project, { operators }),
    validateFile: (file) => validateFile(file, { operators }),
    classifyChange,
    parseProject,
  };
}
