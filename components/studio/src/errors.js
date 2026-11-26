//@ts-check
/**
 * @file Coded errors for `@jarenjs/studio`, on `@jarenjs/core`'s coded
 * contract: a stable `code` (JS0xxx compile/parse time), a bare
 * `reason`, and — where a position in the project exists — a `docPath`.
 *
 * Only the ENVELOPE raises these: a malformed project document, or a
 * duplicate file name. A single FILE's grammar problem is never thrown —
 * it is REPORTED by {@link module:validate.validateFile} as the file
 * kind's own coded errors (`JQ`/`JA`/`JD`…) with their docPaths, so the
 * IDE can show them without stopping the world. Four codes are reported,
 * never thrown: the app render audit's `JS0004` (an error) and `JS0005`,
 * `JS0006`, `JS0007` (warnings).
 */

import { CodedError } from '@jarenjs/core/errors';

/** The code table (kept in sync with docs/PROJECT-FORMAT.md). */
export const STUDIO_CODES = Object.freeze({
  JS0001: 'the project document is invalid',
  JS0002: 'a file name is duplicated in the project',
  JS0003: 'a project file reference cannot be resolved',
  JS0004: 'an app view renders an element written as an object, which renders as nothing',
  JS0005: "an app view's text holds another template language's expression (a warning)",
  JS0006: 'an app view places an object of no element shape where a vnode renders, which renders as nothing (a warning)',
  JS0007: "an app view writes an element as an object in an element's props position, which is read as attributes (a warning)",
});

/** A studio-envelope error. */
export class StudioError extends CodedError {
  /**
   * @param {keyof typeof STUDIO_CODES} code
   * @param {string} reason
   * @param {string | { docPath?: string }} [location]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, reason, location = undefined, options = undefined) {
    super('StudioError', code, reason, location, options);
  }
}
