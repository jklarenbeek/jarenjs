//@ts-check
/**
 * @file `@jarenjs/studio` — the ENGINE (part one of the two-layer
 * package). Headless: it parses a `jaren-project` document, validates
 * each file against its own kind grammar, assembles the runnable
 * artifacts, and classifies a change as structural vs. state-only. It
 * knows the suite's grammars (validate/json/app/flow/db) but nothing of
 * the DOM, `@jarenjs/view` or `@jarenjs/app`'s runtime — the component
 * layer (`./component`) imports the engine, never the reverse.
 *
 * The project is a THIN envelope over typed files; there is deliberately
 * no single composed meta-schema, so a data file may use host-registered
 * operators the closed grammars forbid — the per-file validators are the
 * honest boundary.
 */

export { KINDS, LAYOUT_DEFAULT, parseProject, fileOf } from './project.js';
export { validateFile } from './validate.js';
export { assembleArtifacts, classifyChange, describe } from './assemble.js';
export { STUDIO_CODES, StudioError } from './errors.js';
export { resolveProjectFile, projectFileContext, renameProjectFile, writeProjectArtifact } from './resolve.js';
export { ADDABLE_KINDS, fileSkeleton } from './skeletons.js';
