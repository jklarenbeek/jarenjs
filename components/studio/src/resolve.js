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

/** Resolve one file and its transitive sources. Imported members must be
 * absent locally; a typo, cycle or collision is a refusal, never a fallback.
 * @param {any} project @param {string} name
 * @returns {{ doc: any, sourceFiles: string[] }} */
export function resolveProjectFile(project, name) {
  const visiting = new Set();
  const sources = new Set();
  const read = (name) => {
    const file = project.files.find((f) => f.name === name);
    if (!file) throw new StudioError('JS0003', `missing project file '${name}'`);
    if (visiting.has(name)) throw new StudioError('JS0003', `cyclic file import at '${name}'`);
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
 * @param {any} project @param {string} name @param {any} doc */
export function writeProjectArtifact(project, name, doc) {
  resolveProjectFile(project, name); // resolve/cycle/collision check before any write
  const writes = new Map();
  const write = (name, value) => {
    const key = semanticKey(value);
    if (writes.has(name)) {
      if (writes.get(name).key !== key) throw new StudioError('JS0003', `conflicting values for shared source '${name}'`);
      return;
    }
    const file = project.files.find((f) => f.name === name);
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
    if (semanticKey(JSON.parse(file.text)) === semanticKey(value)) return file;
    return { ...file, text: JSON.stringify(value, null, 2) };
  });
}
