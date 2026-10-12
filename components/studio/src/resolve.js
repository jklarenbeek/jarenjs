//@ts-check
/** Project-local references. No fetching, evaluation or implicit merging. */
import { setObjectMember, semanticKey } from '@jarenjs/core/object';
import { StudioError } from './errors.js';

const MEMBERS = {
  app: ['view', 'actions', 'state', 'subs'],
  fsm: ['states', 'transitions', 'initial'],
  dag: ['nodes', 'edges', 'output'],
  model: ['collections', 'entities'],
};

/**
 * The identity two versions of a project document are compared by: a
 * reboot decision, an editor's echo, a write-back's no-op test. Member
 * order is part of it, because a query's `$for` bindings nest and `$let`
 * binds in key order and a constructed object keeps its members in order,
 * so a reorder is an edit. The one exception is the top level of a kind
 * with importable members (`app`, `fsm`, `dag`, `model`): those members are
 * named slots the project assembles in its own order (local members, then
 * imports), so their order is not the document's.
 * @param {string | null | undefined} kind - the file kind
 * @param {any} value - the document or one file's own part of it
 * @returns {string}
 */
export function documentKey(kind, value) {
  if (kind != null && Object.hasOwn(MEMBERS, kind)
    && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const slots = {};
    for (const member of Object.keys(value).sort()) setObjectMember(slots, member, value[member]);
    value = slots;
  }
  return semanticKey(value, { ordered: true });
}

/** The fewest file reads one resolution may use, and the reads each file of the project adds. */
const MIN_READS = 256;
const READS_PER_FILE = 64;

/** Resolve one file and its transitive sources. Imported members must be
 * absent locally; a typo, cycle or collision is a refusal, never a fallback.
 * @param {any} project @param {string} name
 * @returns {{ doc: any, sourceFiles: string[] }} */
export function resolveProjectFile(project, name) {
  const visiting = new Set();
  const sources = new Set();
  // A file imported from two members is read twice, so a chain of files that
  // each import the next one twice reads 2^n times: the reads are bounded by
  // what a project of this many files can reasonably hold.
  let budget = Math.max(MIN_READS, project.files.length * READS_PER_FILE);
  const read = (name) => {
    const file = project.files.find((f) => f.name === name);
    if (!file) throw new StudioError('JS0003', `missing project file '${name}'`);
    if (visiting.has(name)) throw new StudioError('JS0003', `cyclic file import at '${name}'`);
    if (--budget < 0) throw new StudioError('JS0003', `the imports from '${name}' expand to too many file reads`);
    visiting.add(name);
    sources.add(name);
    let doc;
    try { doc = JSON.parse(file.text); }
    catch (cause) { throw new StudioError('JS0003', `${name}: not valid JSON`, '', { cause }); }
    for (const [member, source] of Object.entries(file.imports ?? {})) {
      if (!MEMBERS[file.kind]?.includes(member))
        throw new StudioError('JS0003', `${name}: '${member}' is not an importable ${file.kind} member`);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new StudioError('JS0003', `${name}: a fragment destination must be an object`);
      if (Object.hasOwn(doc, member))
        throw new StudioError('JS0003', `${name}: imported member '${member}' is also defined locally`);
      setObjectMember(doc, member, read(source));
    }
    visiting.delete(name);
    return doc;
  };
  return { doc: read(name), sourceFiles: [...sources] };
}

/** Resolve a query/transform/validation input or a worker store route.
 * Explicit references never fall back when broken. Multiple models require
 * a choice; adding an unrelated model cannot silently reroute a query.
 * @param {any} project @param {any} file
 * @returns {{ input: any, model: any, collection: string | null }} */
export function projectFileContext(project, file) {
  const named = (name, kinds) => {
    const found = project.files.find((f) => f.name === name);
    if (!found || !kinds.includes(found.kind))
      throw new StudioError('JS0003', `${file.name}: '${name}' must name a ${kinds.join('/')} file`);
    return found;
  };
  const input = file.input !== undefined ? named(file.input, ['data', 'state'])
    : project.files.find((f) => f.kind === 'data') ?? project.files.find((f) => f.kind === 'state') ?? null;
  const model = file.model !== undefined ? named(file.model, ['model']) : null;
  if (file.collection !== undefined && model === null && file.kind !== 'model')
    throw new StudioError('JS0003', `${file.name}: collection requires a model reference`);
  return { input, model, collection: file.collection ?? null };
}

/** Rename references together with their target, preserving every other
 * file member. A delete deliberately leaves references visibly broken.
 * @param {any[]} files @param {string} before @param {string} after */
export function renameProjectFile(files, before, after) {
  if (!after || files.some((f) => f.name === after && f.name !== before))
    throw new StudioError('JS0002', `a file is already named '${after}'`);
  return files.map((file) => ({ ...file,
    name: file.name === before ? after : file.name,
    ...(file.input === before ? { input: after } : {}),
    ...(file.model === before ? { model: after } : {}),
    ...(file.imports ? { imports: Object.fromEntries(Object.entries(file.imports)
      .map(([key, name]) => [key, name === before ? after : name])) } : {}),
  }));
}

/** Write an assembled artifact back into its source files. Imported
 * members stay in their own files; conflicting writes to a shared source
 * are refused atomically. Unchanged files keep their identity and text.
 * Values are compared by {@link documentKey}: a reorder below a slot
 * kind's top level (a query's `$for` bindings, a `$let`) is an edit that
 * is written, two import sites differing only there conflict, and a file
 * whose slots an editor merely rebuilt in another order is unchanged.
 * @param {any} project @param {string} name @param {any} doc */
export function writeProjectArtifact(project, name, doc) {
  resolveProjectFile(project, name); // resolve/cycle/collision check before any write
  const writes = new Map();
  const write = (name, value) => {
    const file = project.files.find((f) => f.name === name);
    const key = documentKey(file.kind, value);
    if (writes.has(name)) {
      if (writes.get(name).key !== key) throw new StudioError('JS0003', `conflicting values for shared source '${name}'`);
      return;
    }
    let local = value;
    if (file.imports) {
      local = { ...value };
      for (const [member, source] of Object.entries(file.imports)) {
        if (!Object.hasOwn(value, member)) throw new StudioError('JS0003', `the edit removed imported member '${member}'`);
        write(source, value[member]);
        delete local[member];
      }
    }
    writes.set(name, { key, local });
  };
  write(name, doc);
  return project.files.map((file) => {
    if (!writes.has(file.name)) return file;
    const value = writes.get(file.name).local;
    if (documentKey(file.kind, JSON.parse(file.text)) === documentKey(file.kind, value)) return file;
    return { ...file, text: JSON.stringify(value, null, 2) };
  });
}
