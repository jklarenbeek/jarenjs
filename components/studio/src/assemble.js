//@ts-check
/**
 * @file Files → runnable artifacts, and the change-classification the IDE
 * needs to decide reboot-vs-hot-update.
 *
 * `assembleArtifacts` composes the project's files into the runnable set.
 * A runnable file can import named members from other project files;
 * `sourceFiles` records the complete dependency chain. `state`/`data`
 * files are inputs, not standalone artifacts.
 *
 * `classifyChange` is the load-bearing UX datum: a `state`-only edit must
 * HOT-DISPATCH into a running app (no reboot, the user keeps scroll and
 * inputs), while a `view`/`actions` change must reboot. It compares a
 * STRUCTURAL key (all app members except `state`) via the suite's own
 * `semanticKey` — the collision-free identity, not the memo-grade
 * `contentKey` fingerprint: a classification decides whether a running
 * app reboots, so a fingerprint collision would read a changed document
 * as unchanged. The artifacts are parsed JSON, so the identity is total.
 */

import { semanticKey, setObjectMember } from '@jarenjs/core/object';
import { validateFile } from './validate.js';
import { resolveProjectFile, projectFileContext } from './resolve.js';

/** Kinds that are runnable artifacts on their own (vs. `state`/`data`
 * inputs). */
const RUNNABLE = new Set(['app', 'jslt', 'query', 'schema', 'fsm', 'dag', 'model', 'contract']);

/** A human role per kind, for the file rail's legibility. */
const ROLE = Object.freeze({
  app: 'application', jslt: 'transform', query: 'query', state: 'state',
  data: 'data', schema: 'schema', fsm: 'state machine', dag: 'dataflow', model: 'data store',
  contract: 'contract',
});

// Keep assembled validation inputs stable across chrome/buffer renders.
// A new immutable file list invalidates its dependencies as one snapshot.
const assembledFiles = new WeakMap();

/**
 * Compose the project's files into runnable artifacts, resolving imports.
 * @param {any} project - a normalized project (from `parseProject`)
 * @returns {{ artifacts: Array<{ name: string, kind: string, role: string,
 *   doc: any, sourceFiles: string[] }>, errors: Array<{ file: string, message: string }> }}
 */
export function assembleArtifacts(project) {
  const artifacts = [];
  const errors = [];
  for (const file of project.files) {
    if (!RUNNABLE.has(file.kind)) continue;
    let resolved;
    try { resolved = resolveProjectFile(project, file.name); }
    catch (err) {
      errors.push({ file: file.name, message: String(/** @type {any} */ (err)?.message ?? err) });
      continue;
    }
    artifacts.push({
      name: file.name, kind: file.kind, role: ROLE[file.kind], ...resolved,
    });
  }
  return { artifacts, errors };
}

/** The structural identity of an artifact — an `app`'s view/actions/subs
 * (its `state` excluded); everything else in full. */
function structuralKey(artifact) {
  return artifact.kind === 'app'
    ? semanticKey({ ...artifact.doc, state: null })
    : semanticKey(artifact.doc);
}

const RANK = { none: 0, 'state-only': 1, structural: 2 };

/**
 * Classify what changed between two projects, PER artifact — the datum
 * the widget's reboot-vs-hot-update policy consumes. `state-only` means
 * an app's state moved but its structure did not (hot-dispatch it);
 * `structural` means reboot; `none` means nothing changed.
 * @param {any} prevProject
 * @param {any} nextProject
 * @returns {{ overall: 'none' | 'state-only' | 'structural',
 *   perArtifact: Record<string, 'none' | 'state-only' | 'structural'> }}
 */
export function classifyChange(prevProject, nextProject) {
  const prev = new Map(assembleArtifacts(prevProject).artifacts.map((a) => [a.name, a]));
  const next = new Map(assembleArtifacts(nextProject).artifacts.map((a) => [a.name, a]));
  /** @type {Record<string, 'none' | 'state-only' | 'structural'>} */
  const perArtifact = {};
  let overall = /** @type {'none' | 'state-only' | 'structural'} */ ('none');
  const bump = (c) => { if (RANK[c] > RANK[overall]) overall = c; };

  for (const [name, a] of next) {
    const b = prev.get(name);
    let c;
    if (b === undefined || b.kind !== a.kind) c = 'structural';
    else if (structuralKey(b) !== structuralKey(a)) c = 'structural';
    else if (semanticKey(b.doc) !== semanticKey(a.doc)) c = 'state-only';
    else c = 'none';
    setObjectMember(perArtifact, name, c);
    bump(c);
  }
  for (const name of prev.keys()) {
    if (!next.has(name)) { setObjectMember(perArtifact, name, 'structural'); bump('structural'); }
  }
  return { overall, perArtifact };
}

/**
 * Per-file metadata for the IDE file rail and the AI `list_files` tool:
 * kind, validity, size, its role, and which runnable artifact it is (a
 * `state`/`data` input is not itself an artifact).
 * @param {any} project - a normalized project
 * @param {{ operators?: { toOptions: () => any } }} [options]
 */
export function describe(project, options = {}) {
  return {
    active: project.active,
    layout: project.layout,
    files: project.files.map((file) => {
      let v;
      try {
        projectFileContext(project, file);
        let effective = file;
        if (file.imports) {
          let byFile = assembledFiles.get(project.files);
          if (!byFile) { byFile = new Map(); assembledFiles.set(project.files, byFile); }
          effective = byFile.get(file);
          if (!effective) {
            effective = { ...file, text: JSON.stringify(resolveProjectFile(project, file.name).doc) };
            byFile.set(file, effective);
          }
        }
        v = validateFile(effective, options);
      }
      catch (error) {
        v = { valid: false, total: 1, errors: [{ code: error.code ?? null,
          message: error.message, docPath: error.docPath ?? '' }] };
      }
      return {
        name: file.name,
        kind: file.kind,
        role: ROLE[file.kind] ?? file.kind,
        size: file.text.length,
        valid: v.valid,
        total: v.total,
        errors: v.errors,
        artifact: RUNNABLE.has(file.kind) ? file.name : null,
      };
    }),
  };
}
