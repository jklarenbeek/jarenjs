//@ts-check
/**
 * @file The project document model: the closed file-kind vocabulary, the
 * frozen IDE `layout` shape, and `parseProject` — validate a candidate
 * against the `jaren-project` envelope schema, reject duplicate file
 * names, and return a NORMALIZED, frozen project (layout defaulted,
 * `active` resolved to a real file). Only the ENVELOPE is gated here; a
 * file's `text` is a string until its kind validator runs (`validate.js`).
 */

import { JarenValidator } from '@jarenjs/validate';
import projectSchema from '../schemas/jaren-project.schema.json' with { type: 'json' };
import { StudioError } from './errors.js';

/** The closed set of file kinds (matches the schema `kind` enum). */
export const KINDS = Object.freeze([
  'app', 'jslt', 'query', 'state', 'data', 'schema', 'fsm', 'dag', 'model',
  'contract',
]);

/** The default IDE layout — the frozen `{ mode, ratio, autorun }` shape
 * that rides the share link and the eject, so it must not drift. */
export const LAYOUT_DEFAULT = Object.freeze({ mode: 'classic', ratio: 0.5, autorun: true });

const validateEnvelope = new JarenValidator({ skipErrors: false, collectErrors: true })
  .compile(projectSchema);

/**
 * Parse and normalize a project: JSON text or an object in; a frozen,
 * normalized project out. A malformed envelope is `JS0001`; a duplicate
 * file name is `JS0002`.
 * @param {string | object} input
 * @returns {any}
 */
export function parseProject(input) {
  let doc;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); }
    catch (cause) {
      throw new StudioError('JS0001',
        `the project is not valid JSON: ${String(/** @type {any} */ (cause)?.message ?? cause)}`,
        '', { cause });
    }
  }
  else doc = input;

  const outcome = validateEnvelope(doc);
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid : outcome === true;
  if (!valid) {
    const errors = (typeof outcome === 'object' && outcome !== null ? outcome.errors : null) ?? [];
    throw new StudioError('JS0001',
      `the project does not validate against jaren-project (${errors.length} error${errors.length === 1 ? '' : 's'})`,
      errors[0]?.instancePath ?? '');
  }

  const names = new Set();
  for (const file of doc.files) {
    if (names.has(file.name))
      throw new StudioError('JS0002', `two files are named '${file.name}'`, '/files');
    names.add(file.name);
  }

  const active = typeof doc.active === 'string' && names.has(doc.active)
    ? doc.active
    : (doc.files[0]?.name ?? null);
  return Object.freeze({
    project: doc.project,
    files: Object.freeze(doc.files.map((f) => Object.freeze({ ...f, ...(f.imports ? { imports: Object.freeze({ ...f.imports }) } : {}) }))),
    active,
    layout: Object.freeze({ ...LAYOUT_DEFAULT, ...doc.layout }),
  });
}

/**
 * The file with this name, or `null`.
 * @param {any} project
 * @param {string} name
 */
export function fileOf(project, name) {
  return project.files.find((f) => f.name === name) ?? null;
}
