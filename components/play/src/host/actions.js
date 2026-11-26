//@ts-check
/**
 * @file The play slice's own reducers as app action documents: loading an
 * example, applying a switched option and loading a session. They write the
 * slice at `/play` and the reader's language at the host's pointer, which
 * only the locale option's choice changes (session.js's reader-language
 * rules answer the payloads these documents apply).
 */

import { parseJSONPointer } from '@jarenjs/json/pointer';
import { jsonPathFromJSONPointer } from '@jarenjs/json/path';

/** A pointer segment a JSONPath may name with a dot: an ASCII identifier. */
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The JSONPath of a state pointer, dotted where every segment allows it
 * (`/lang` is `$.lang`), the normalized path otherwise.
 * @param {string} pointer
 * @returns {string}
 */
function pathOfPointer(pointer) {
  const segments = parseJSONPointer(pointer);
  return segments.every((segment) => DOTTED.test(segment)) ? `$.${segments.join('.')}` : jsonPathFromJSONPointer(pointer);
}

/**
 * The reducers of `play/loaded` (an example loaded: its engine, source,
 * dataset and config, the example's own `exampleLocale`, and the
 * presentation and session state reset), `play/option-set` (the session a
 * switched option answers, and the reader's language when the locale
 * option chose one) and `play/loaded-session` (a saved, shared or blank
 * session: its content, its name, and no `exampleLocale`), as app action
 * documents over the slice at `/play`.
 * @example
 * const actions = { ...playSliceActions({ langPointer: '/lang' }), ...playFormActions({ numberValue: FORM_NUMBER_VALUE }) };
 * @param {{ langPointer: string }} options - `langPointer`: the JSON Pointer
 *   of the reader's language in the host's state (the website's `/lang`)
 * @returns {Record<'play/loaded' | 'play/option-set' | 'play/loaded-session', { patch: any[] }>}
 * @throws {TypeError} When `langPointer` is not a JSON Pointer to a member
 */
export function playSliceActions({ langPointer }) {
  if (typeof langPointer !== 'string' || langPointer === '')
    throw new TypeError(`playSliceActions: langPointer must be a JSON Pointer to a member, got ${JSON.stringify(langPointer) ?? String(langPointer)}`);
  const langPath = pathOfPointer(langPointer);
  return {
    'play/loaded': {
      patch: [
        { op: 'replace', path: '/play/engine', value: '$payload.engine' },
        { op: 'replace', path: '/play/exampleId', value: '$payload.exampleId' },
        { op: 'replace', path: '/play/source', value: '$payload.source' },
        { op: 'replace', path: '/play/datasetIndex', value: '$payload.datasetIndex' },
        { op: 'replace', path: '/play/data', value: '$payload.data' },
        { op: 'replace', path: '/play/config', value: '$payload.config' },
        // an example made to show one language runs in it while it is
        // loaded; the reader's language is the reader's alone
        { op: 'replace', path: '/play/exampleLocale', value: { $default: ['$payload.exampleLocale', null] } },
        { op: 'replace', path: '/play/result', value: null },
        // an example REPLACES the session's content, so it can no longer be
        // the saved record: unbind, or the next Save would overwrite that
        // record with something the user never saved there
        { op: 'replace', path: '/play/savedName', value: null },
        // a new engine's result has different screens; drop any stale tab,
        // and a fresh example opens CALM — the depth toggle resets off
        { op: 'replace', path: '/play/panel', value: null },
        { op: 'replace', path: '/play/deep', value: false },
        { op: 'replace', path: '/play/deepPick', value: null },
        // the structured form buffer belongs to the example it was parsed
        // from — keep it and the first form edit mirrors the OLD buffer
        // over the new example's data pane (loaded-session resets the same)
        { op: 'replace', path: '/play/dataView', value: 'json' },
        { op: 'replace', path: '/play/dataValue', value: null },
        // on a phone, picking an example answers immediately: show its result
        // (desktop shows every pane, so this is invisible there)
        { op: 'replace', path: '/play/mobilePane', value: 'result' },
      ],
    },
    'play/option-set': {
      patch: [
        { op: 'replace', path: '/play/config', value: '$payload.config' },
        { op: 'replace', path: '/play/source', value: '$payload.source' },
        { op: 'replace', path: '/play/data', value: '$payload.data' },
        { op: 'replace', path: '/play/exampleId', value: '$payload.exampleId' },
        { op: 'replace', path: '/play/datasetIndex', value: '$payload.datasetIndex' },
        { op: 'replace', path: '/play/dataView', value: '$payload.dataView' },
        { op: 'replace', path: '/play/dataValue', value: '$payload.dataValue' },
        // the Messages select writes the reader's language (null: not this pane)
        { op: 'replace', path: langPointer, value: { $if: ['$payload.lang', '$payload.lang', langPath] } },
        { op: 'replace', path: '/play/exampleLocale', value: { $default: ['$payload.exampleLocale', null] } },
      ],
    },
    'play/loaded-session': {
      patch: [
        { op: 'replace', path: '/play/engine', value: '$payload.engine' },
        { op: 'replace', path: '/play/exampleId', value: '$payload.exampleId' },
        { op: 'replace', path: '/play/source', value: '$payload.source' },
        { op: 'replace', path: '/play/data', value: '$payload.data' },
        { op: 'replace', path: '/play/config', value: '$payload.config' },
        { op: 'replace', path: '/play/name', value: '$payload.name' },
        // a loaded record binds; a blank or SHARED session does not (a share
        // link is not a local record, so its first Save must ask for a name)
        { op: 'replace', path: '/play/savedName', value: { $default: ['$payload.savedName', null] } },
        // a session renders in its reader's language, whatever it carries
        { op: 'replace', path: '/play/exampleLocale', value: null },
        { op: 'replace', path: '/play/datasetIndex', value: 0 },
        { op: 'replace', path: '/play/result', value: null },
        { op: 'replace', path: '/play/panel', value: null },
        { op: 'replace', path: '/play/deep', value: false },
        { op: 'replace', path: '/play/deepPick', value: null },
        { op: 'replace', path: '/play/shared', value: null },
        { op: 'replace', path: '/play/dataView', value: 'json' },
        { op: 'replace', path: '/play/dataValue', value: null },
      ],
    },
  };
}
