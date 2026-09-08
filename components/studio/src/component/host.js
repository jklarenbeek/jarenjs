//@ts-check
/**
 * @file The two hard-problem POLICIES, pure and tested — the DOM
 * mechanics that consume them live in the widget.
 *
 * `hostPolicy` (reboot vs. hot-update): a `state-only` edit hot-dispatches
 * the new state into the RUNNING nested app (the user keeps scroll and
 * inputs, no reboot); a `structural` edit reboots; an unchanged artifact
 * is skipped.
 *
 * `reconcileBuffer` (editor buffer ↔ document): a CLEAN buffer adopts an
 * incoming write (share / undo / an AI edit lands); a DIRTY buffer whose
 * text differs from the incoming write keeps the human's text and records
 * the write as a recoverable draft — never a silent clobber, never a
 * hidden write.
 */

import { setObjectMember } from '@jarenjs/core/object';
import { classifyChange } from '../assemble.js';

/**
 * Per-artifact action a stage host should take between two project
 * revisions: `reboot` (destroy + boot), `hot` (dispatch new state into
 * the running app), or `skip` (nothing changed).
 * @param {any} prevProject
 * @param {any} nextProject
 * @returns {Record<string, 'reboot' | 'hot' | 'skip'>}
 */
export function hostPolicy(prevProject, nextProject) {
  const { perArtifact } = classifyChange(prevProject, nextProject);
  /** @type {Record<string, 'reboot' | 'hot' | 'skip'>} */
  const out = {};
  for (const [name, change] of Object.entries(perArtifact)) {
    setObjectMember(out, name, change === 'structural' ? 'reboot' : change === 'state-only' ? 'hot' : 'skip');
  }
  return out;
}

/**
 * Reconcile the editor's local typing buffer against an incoming
 * committed text (a share/undo restore, or an AI write onto the same
 * file). A clean buffer adopts; a dirty buffer that already matches the
 * incoming text simply clears (the commit landed); a dirty buffer that
 * differs keeps the human's text and surfaces the incoming version as a
 * recoverable `conflict`.
 * @param {{ text: string, dirty: boolean }} buffer
 * @param {string} incoming - the file's committed text
 * @returns {{ text: string, dirty: boolean, conflict: { incoming: string } | null }}
 */
export function reconcileBuffer(buffer, incoming) {
  if (!buffer.dirty) return { text: incoming, dirty: false, conflict: null };
  if (buffer.text === incoming) return { text: incoming, dirty: false, conflict: null };
  return { text: buffer.text, dirty: true, conflict: { incoming } };
}
