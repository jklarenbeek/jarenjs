//@ts-check
/** Typed files and project envelopes; Studio owns parsing and normalization. */
import { DocumentBuilder, optionsOf, snapshot } from '../authored.js';
import { LinqBuildError } from '../errors.js';

/** The public project file vocabulary, held equal to Studio's schema by tests. */
export const FILE_KINDS = Object.freeze(['app', 'jslt', 'query', 'state', 'data', 'schema', 'fsm', 'dag', 'model', 'contract']);
const LAYOUT_KEYS = ['mode', 'ratio', 'autorun'];

/** One file, preserving the caller's text byte-for-byte. */
export function file(name, kind, text) {
  if (typeof name !== 'string' || name.length === 0 || !FILE_KINDS.includes(kind) || typeof text !== 'string')
    throw new LinqBuildError('JL0101', 'file() requires a nonempty name, a declared kind and text');
  return snapshot({ name, kind, text });
}

/** One file holding a public JSON value; pass another pen's `.schema` explicitly. */
export function jsonFile(name, kind, document) { return file(name, kind, JSON.stringify(snapshot(document))); }

/** Validate the authoring shape, preserving duplicate names for Studio to judge. */
function filesOf(files) {
  if (!Array.isArray(files)) throw new LinqBuildError('JL0101', 'files() takes an array of project files');
  return files.map((value) => {
    const f = optionsOf(value, ['name', 'kind', 'text'], 'file');
    return file(f.name, f.kind, f.text);
  });
}

/** Immutable public project document. */
export class ProjectBuilder extends DocumentBuilder {
  /** Replace the whole file list. @param {readonly object[]} values */
  files(values) { return this.with({ files: filesOf(values) }); }
  /** Append one file, without inventing a duplicate-name policy. @param {object} value */
  file(value) { return this.files([...this.schema.files, value]); }
  /** The requested active file; Studio falls back if it cannot resolve it. @param {string} name */
  active(name) {
    if (typeof name !== 'string') throw new LinqBuildError('JL0101', 'active() takes a file name');
    return this.with({ active: name });
  }
  /** Replace layout metadata; Studio supplies defaults. @param {object} value */
  layout(value) { return this.with({ layout: optionsOf(value, LAYOUT_KEYS, 'layout()') }); }
}

/** Start a project with files and optional active/layout metadata. */
export function defineProject(files = [], options = {}) {
  const opts = optionsOf(options, ['active', 'layout'], 'defineProject()');
  let built = new ProjectBuilder({ project: '0.1', files: filesOf(files) });
  if (Object.hasOwn(opts, 'active')) built = built.active(opts.active);
  if (Object.hasOwn(opts, 'layout')) built = built.layout(opts.layout);
  return built;
}

/** A public envelope supplied verbatim; the Studio parser remains authoritative. @param {any} document */
export function from(document) { return new ProjectBuilder(document); }
