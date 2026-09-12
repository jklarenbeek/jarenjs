//@ts-check
/** One independent project editor state over a host-supplied document. */
import { parseProject } from '../project.js';

export function createProjectState(project) {
 const { name = 'Untitled project', ...envelope } = JSON.parse(JSON.stringify(project));
 project = { ...parseProject(envelope), name };
 return {
      ...project,
      mount: null,       // last-good { name, doc, revision } for the active app
      revision: 0,       // reboot key — bumps only on a structural change
      dirty: false,      // the editor has uncommitted text
      // the editor's typing buffer ({ file, text, dirty } or null): every
      // keystroke lands here, the commit lands on blur. It is what the
      // controlled textarea is reasserted with, so a render mid-edit cannot
      // overwrite the user; a write arriving on the same file while it is
      // dirty raises a conflict instead of clobbering either side.
      buffer: null,
      // the file-name field's own buffer ({ file, text } or null). Separate
      // from `buffer` because its commit is a RENAME: publishing every
      // keystroke straight through would rename the file once per letter.
      renameDraft: null,
      results: {},       // file name -> a run result (query/jslt: later order)
      stageError: null,  // the nested app's own boot/runtime failure, if any
      // the phone layout: which single pane shows (files | editor | stage).
      // Pure chrome — the panes stay mounted, CSS picks one, and the
      // project/* re-run feed ignores this path by construction.
      mobilePane: 'editor',
    };
}
