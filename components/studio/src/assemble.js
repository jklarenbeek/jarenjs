//@ts-check
/**
 * @file Files → runnable artifacts, and the change-classification the IDE
 * needs to decide reboot-vs-hot-update.
 *
 * `assembleArtifacts` composes the project's files into the runnable set.
 * This order ships the WHOLE-DOCUMENT contract: a runnable file (`app`,
 * `fsm`, `dag`, `model`, `jslt`, `query`, `schema`) is its own artifact;
 * `state`/`data` files are inputs, not artifacts. Fragment assembly —
 * composing separate `state` + `view` + `actions` files into ONE
 * `jaren-app` document (the true HTML/CSS/JS split) — is the model's
 * headline enhancement and layers on top without changing this contract.
 *
 * `classifyChange` is the load-bearing UX datum: a `state`-only edit must
 * HOT-DISPATCH into a running app (no reboot, the user keeps scroll and
 * inputs), while a `view`/`actions` change must reboot. It compares a
 * STRUCTURAL key (an app's `view`, `actions` and `subs`) via the suite's own
 * `semanticKey` — the collision-free identity, not the memo-grade
 * `contentKey` fingerprint: a classification decides whether a running
 * app reboots, so a fingerprint collision would read a changed document
 * as unchanged. The artifacts are parsed JSON, so the identity is total.
 */

import { semanticKey, setObjectMember } from '@jarenjs/core/object';
import { validateFile } from './validate.js';

/** Kinds that are runnable artifacts on their own (vs. `state`/`data`
 * inputs). */
const RUNNABLE = new Set(['app', 'jslt', 'query', 'schema', 'fsm', 'dag', 'model', 'contract']);

/** A human role per kind, for the file rail's legibility. */
const ROLE = Object.freeze({
  app: 'application', jslt: 'transform', query: 'query', state: 'state',
  data: 'data', schema: 'schema', fsm: 'state machine', dag: 'dataflow', model: 'data store',
  contract: 'contract',
});

/**
 * Compose the project's files into runnable artifacts (whole-document).
 * @param {any} project - a normalized project (from `parseProject`)
 * @returns {{ artifacts: Array<{ name: string, kind: string, role: string,
 *   doc: any, sourceFiles: string[] }>, errors: Array<{ file: string, message: string }> }}
 */
export function assembleArtifacts(project) {
  const artifacts = [];
  const errors = [];
  for (const file of project.files) {
    if (!RUNNABLE.has(file.kind)) continue;
    let doc;
    try { doc = JSON.parse(file.text); }
    catch (err) {
      errors.push({ file: file.name, message: `not valid JSON: ${String(/** @type {any} */ (err)?.message ?? err)}` });
      continue;
    }
    artifacts.push({
      name: file.name, kind: file.kind, role: ROLE[file.kind], doc, sourceFiles: [file.name],
    });
  }
  return { artifacts, errors };
}

/** The structural identity of an artifact — an `app`'s view/actions/subs
 * (its `state` excluded); everything else in full. */
function structuralKey(artifact) {
  return artifact.kind === 'app'
    ? semanticKey({ view: artifact.doc.view, actions: artifact.doc.actions, subs: artifact.doc.subs })
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
      const v = validateFile(file, options);
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
